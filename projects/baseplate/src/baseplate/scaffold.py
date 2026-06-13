"""The self-service scaffolder — the platform team's internal tooling.

A developer describes a new service in plain English ("a Python API that reads
rates from Postgres and serves them over HTTP"). The scaffolder turns that into
a structured ``ServiceSpec`` and then **deterministically** generates the
paved-road files for it: a Dockerfile, a k8s manifest derived from the base, a
Terraform ``service`` module invocation, a golden CI workflow, and an SLO stub.
This is the "add a manifest, get a production-ready service" experience a paved
road exists to provide.

The free-text → ServiceSpec step routes through the standard LLM chain
(Anthropic/OpenAI → Ollama → OpenRouter → a deterministic offline parser). The
model only *extracts the spec*; every generated file is produced by
deterministic templating, so the output is reviewable and reproducible. The
offline parser keeps the whole flow working with zero keys.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

from baseplate import llm, templates

# Languages the paved road ships a base image + CI matrix for.
SUPPORTED_LANGUAGES = ("python", "node", "go")
_LANG_ALIASES = {
    "py": "python", "python3": "python", "fastapi": "python", "flask": "python",
    "django": "python", "js": "node", "javascript": "node", "typescript": "node",
    "ts": "node", "nodejs": "node", "express": "node", "golang": "go",
}


@dataclass
class ServiceSpec:
    """The structured contract every generated file is derived from."""

    name: str
    language: str = "python"
    needs_db: bool = False
    exposes_http: bool = True

    def normalized(self) -> ServiceSpec:
        name = _slug(self.name) or "new-service"
        lang = _LANG_ALIASES.get(self.language.lower(), self.language.lower())
        if lang not in SUPPORTED_LANGUAGES:
            lang = "python"
        return ServiceSpec(name=name, language=lang, needs_db=bool(self.needs_db),
                           exposes_http=bool(self.exposes_http))


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", (text or "").strip().lower())
    return re.sub(r"-+", "-", s).strip("-")[:40]


# --------------------------------------------------------------------------- #
# Free-text → ServiceSpec (LLM with a deterministic offline parser)           #
# --------------------------------------------------------------------------- #

_SYSTEM = (
    "You are a platform-engineering scaffolder. Read a developer's description of "
    "a new service and return ONLY a JSON object with keys: name (kebab-case "
    "string), language (one of python|node|go), needs_db (boolean — true if it "
    "persists/queries a database), exposes_http (boolean — true if it serves an "
    "HTTP API). No prose."
)

# Keyword signals for the deterministic fallback parser.
_DB_WORDS = ("postgres", "database", "db", "rds", "sql", "persist", "store",
             "stateful", "table", "query")
_NO_HTTP_WORDS = ("worker", "cron", "batch", "consumer", "job", "queue",
                  "background", "scheduled", "daemon")
_LANG_WORDS = {
    "python": ("python", "fastapi", "flask", "django", "py"),
    "node": ("node", "nodejs", "javascript", "typescript", "express", "js", "ts"),
    "go": ("go", "golang"),
}


def offline_parse(_system: str, user: str) -> str:
    """Deterministic ServiceSpec extraction — the last-resort fallback.

    Returns a JSON string (same contract as the model) so the caller parses one
    shape either way.
    """
    text = user.lower()

    # name: prefer an explicit "called/named X", else the first quoted token,
    # else a slug of the leading words. Stop the name at a relative clause or
    # connective ("that reads…", "which…", "and…") so we capture just the name.
    name = None
    m = re.search(r"(?:called|named)\s+[\"']?([a-z0-9][a-z0-9_-]*"
                  r"(?:[ -][a-z0-9_-]+)*?)\b(?:\s+(?:that|which|to|for|and|with|"
                  r"reads?|consumes?|writes?|serves?|exposes?|service|api|"
                  r"microservice|worker|job)\b|[\"',.]|$)", text)
    if m:
        name = _slug(m.group(1))
    if not name:
        m = re.search(r"[\"']([a-z0-9][a-z0-9 _-]{1,40})[\"']", text)
        if m:
            name = _slug(m.group(1))
    if not name:
        # words before "service"/"api", else first few tokens.
        m = re.search(r"([a-z0-9][a-z0-9 _-]{1,40})\s+(?:service|api|microservice)",
                      text)
        name = _slug(m.group(1)) if m else _slug(" ".join(text.split()[:3]))

    language = "python"
    for lang, words in _LANG_WORDS.items():
        if any(re.search(rf"\b{re.escape(w)}\b", text) for w in words):
            language = lang
            break

    needs_db = any(re.search(rf"\b{re.escape(w)}\b", text) for w in _DB_WORDS)
    # explicit negation wins: "no database", "without a db", "no postgres".
    if re.search(r"\b(?:no|without|not?)\s+(?:a\s+)?"
                 r"(?:db|database|postgres|persistence|datastore)\b", text):
        needs_db = False

    exposes_http = not any(
        re.search(rf"\b{re.escape(w)}\b", text) for w in _NO_HTTP_WORDS)
    # explicit "http"/"api"/"endpoint" forces http on…
    if any(re.search(rf"\b{w}\b", text) for w in ("http", "api", "endpoint", "rest")):
        exposes_http = True
    # …but explicit negation ("no http", "without an api") wins over that.
    if re.search(r"\b(?:no|without|not?)\s+(?:an?\s+)?"
                 r"(?:http|api|endpoint|rest|server)\b", text):
        exposes_http = False

    return json.dumps({"name": name or "new-service", "language": language,
                       "needs_db": needs_db, "exposes_http": exposes_http})


def extract_spec(description: str, *,
                 mode: str | None = None) -> tuple[ServiceSpec, dict]:
    """Turn free text into a normalized ServiceSpec via the LLM chain.

    Returns ``(spec, routing)`` where ``routing`` is the llm telemetry an
    interviewer will ask about (provider, model, latency, fallbacks).
    """
    res = llm.complete(_SYSTEM, description, offline=offline_parse, mode=mode,
                       json_mode=True, max_tokens=200)
    raw = _coerce_json(res.text) or {}
    spec = ServiceSpec(
        name=str(raw.get("name") or _slug(description) or "new-service"),
        language=str(raw.get("language") or "python"),
        needs_db=bool(raw.get("needs_db", False)),
        exposes_http=bool(raw.get("exposes_http", True)),
    ).normalized()
    routing = {
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }
    return spec, routing


def _coerce_json(text: str) -> dict | None:
    """Best-effort JSON parse — a live model may wrap the object in prose."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


# --------------------------------------------------------------------------- #
# ServiceSpec → paved-road files (deterministic templating)                   #
# --------------------------------------------------------------------------- #

def generate(spec: ServiceSpec) -> dict:
    """Generate the full set of paved-road files for a normalized spec.

    Returns ``{"spec": {...}, "files": {path: contents}}``. Pure and
    deterministic — identical spec in, identical bytes out.
    """
    spec = spec.normalized()
    files = {
        "Dockerfile": templates.dockerfile(spec),
        f"deploy/k8s/{spec.name}.yaml": templates.k8s_manifest(spec),
        f"deploy/argocd/{spec.name}.yaml": templates.argocd_application(spec),
        f"deploy/terraform/{spec.name}.tf": templates.terraform_service(spec),
        ".github/workflows/ci.yml": templates.ci_workflow(spec),
        "slo.yaml": templates.slo_stub(spec),
    }
    return {"spec": asdict(spec), "files": files}
