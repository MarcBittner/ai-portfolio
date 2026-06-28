"""Paved-road scaffolder — emit a standalone, runnable agent from an ``AgentSpec``.

This is agent-factory's "paved road" (the same pattern baseplate uses for
services): **a model proposes the spec; deterministic templating produces the
artifacts.** :func:`customize_spec` turns a plain-English description into a
validated :class:`AgentSpec` (LLM when a provider is configured, a deterministic
keyword fallback otherwise — so it works with zero keys). :func:`scaffold` then
renders that spec into a complete project — industry-standard layout, a README
with setup/configuration, a Dockerfile, tests, a CLI, and an HTTP server — in
**Python** or **TypeScript**. :func:`scaffold_zip` packs the tree into a zip.

The Python target *clones agent-factory's own runtime* (renaming the package),
so a generated agent behaves exactly like the one you tuned here and stays in
parity automatically. The TypeScript target is a hand-written port of the same
guard → plan → act → answer loop with zero runtime dependencies.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

from agent_factory import __version__, llm
from agent_factory.spec import AgentSpec
from agent_factory.tools import TOOL_NAMES

LANGUAGES = ("python", "typescript")

# the agent-factory package source — the Python target clones these modules
_SRC = Path(__file__).parent
_CLONE_MODULES = (
    "tools.py", "planner.py", "guardrails.py",
    "llm.py", "llm_planner.py", "spec.py", "agent.py", "orchestrate.py",
)


# --------------------------------------------------------------------------- #
# naming helpers
# --------------------------------------------------------------------------- #

def slug(name: str) -> str:
    """kebab-case project/dir name."""
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "agent"


def pkg_name(name: str) -> str:
    """snake_case importable Python package name."""
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "agent"
    return f"a_{s}" if s[0].isdigit() else s


def _render(template: str, mapping: dict[str, str]) -> str:
    out = template
    for key, value in mapping.items():
        out = out.replace(f"@@{key}@@", value)
    return out


# --------------------------------------------------------------------------- #
# AI-assisted customization — the model proposes the spec
# --------------------------------------------------------------------------- #

_CUSTOMIZE_SYS = (
    "You configure a tool-using agent. Given a description of what the agent "
    "should do, return a single JSON object with these fields: "
    '"name" (short kebab-case id), "description" (<=200 chars), '
    '"system_prompt" (a clear role + instructions for the agent), '
    '"tools" (an array, a subset of the ALLOWED tools), and '
    '"answer_style" ("concise" or "detailed"). Use ONLY tools from the allowed '
    "list. Output ONLY the JSON object, no prose."
)

# keyword → tools, for the deterministic offline fallback
_TOOL_HINTS: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (("math", "calculate", "calculator", "arithmetic", "compute", "sum"),
     ("calculator",)),
    (("convert", "unit", "units", "miles", "kilogram", "celsius", "temperature"),
     ("convert",)),
    (("date", "days", "duration", "calendar"), ("date_diff",)),
    (("json", "field", "payload", "api response"), ("json_get",)),
    (("regex", "extract", "pattern", "match"), ("regex_extract",)),
    (("word", "sentence", "character", "count", "length of text"), ("text_stats",)),
    (("research", "search", "knowledge", "lookup", "find out", "docs", "document"),
     ("kb_search", "doc_fetch")),
)


def _heuristic_spec(prompt: str) -> dict:
    """Deterministic spec proposal from a description (no model needed)."""
    low = prompt.lower()
    chosen: list[str] = []
    for keywords, tools in _TOOL_HINTS:
        if any(k in low for k in keywords):
            for t in tools:
                if t not in chosen:
                    chosen.append(t)
    tools = chosen or list(TOOL_NAMES)
    words = re.findall(r"[a-z0-9]+", low)
    name = "-".join(words[:3]) or "custom-agent"
    desc = prompt.strip()[:200] or "A custom agent."
    return {
        "name": name,
        "description": desc,
        "system_prompt": (
            f"You are an agent whose job is: {prompt.strip()}. Break the task into "
            "small steps and use tools when they make the answer more accurate. "
            "Ground every claim in a tool result; never guess at a value a tool "
            "can compute."
        ),
        "tools": tools,
        "answer_style": "concise",
    }


def customize_spec(prompt: str, base: AgentSpec | None = None) -> tuple[AgentSpec, dict]:
    """Turn a plain-English ``prompt`` into a validated :class:`AgentSpec`.

    Asks the model for a spec proposal; on the mock provider or any parse
    failure, falls back to a deterministic keyword heuristic so it always
    produces a valid spec — even with no keys. Returns ``(spec, meta)`` where
    ``meta`` records which path was used.
    """
    base = base or AgentSpec()
    allowed = ", ".join(TOOL_NAMES)
    parsed, result = llm.complete_json(
        f"Agent description:\n{prompt}\n\nAllowed tools: {allowed}\n\n"
        "Agent config (JSON object):",
        _CUSTOMIZE_SYS,
    )
    source = "llm"
    if not isinstance(parsed, dict):
        parsed, source = _heuristic_spec(prompt), "offline"

    merged = base.model_dump()
    for field in ("name", "description", "system_prompt"):
        value = parsed.get(field)
        if isinstance(value, str) and value.strip():
            merged[field] = value.strip()
    if parsed.get("answer_style") in ("concise", "detailed"):
        merged["answer_style"] = parsed["answer_style"]
    raw_tools = parsed.get("tools")
    if isinstance(raw_tools, list):
        tools = [t for t in raw_tools if t in TOOL_NAMES]
        if tools:
            merged["tools"] = tools

    spec = AgentSpec.model_validate(merged)
    return spec, {"source": source, "provider": result.provider, "model": result.model}


# --------------------------------------------------------------------------- #
# project generation
# --------------------------------------------------------------------------- #

def scaffold(spec: AgentSpec, language: str = "python") -> dict[str, str]:
    """Render ``spec`` into a complete project: ``{relative_path: content}``."""
    if language not in LANGUAGES:
        raise ValueError(f"unknown language {language!r}; valid: {list(LANGUAGES)}")
    return _python_project(spec) if language == "python" else _typescript_project(spec)


def main(argv: list[str] | None = None) -> int:
    """CLI: ``python -m agent_factory.scaffold --template calculator --out ./bot``."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="agent-factory scaffold",
        description="Generate a standalone, runnable agent project from a spec.")
    parser.add_argument("--template", help="built-in template name")
    parser.add_argument("--spec", help="path to an AgentSpec JSON file")
    parser.add_argument("--language", default="python", choices=list(LANGUAGES))
    parser.add_argument("--out", required=True, help="output directory (or .zip path)")
    parser.add_argument("--zip", action="store_true",
                        help="write a single .zip instead of a file tree")
    args = parser.parse_args(argv)

    from agent_factory.spec import template as get_template

    if args.spec:
        spec = AgentSpec.model_validate(json.loads(Path(args.spec).read_text()))
    elif args.template:
        spec = get_template(args.template)
    else:
        spec = get_template("assistant")

    out = Path(args.out)
    if args.zip:
        target = out if out.suffix == ".zip" else out.with_suffix(".zip")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(scaffold_zip(spec, args.language))
        print(f"wrote {target}")
    else:
        files = scaffold(spec, args.language)
        for rel, content in files.items():
            path = out / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        print(f"generated {len(files)} files in {out}/  (language={args.language})")
    return 0


def dockerfile(spec: AgentSpec, language: str = "python") -> str:
    """Just the Dockerfile for the generated agent (the 'or a Dockerfile' option)."""
    files = scaffold(spec, language)
    return files["Dockerfile"]


def scaffold_zip(spec: AgentSpec, language: str = "python") -> bytes:
    """Pack the generated project into a zip (rooted at the project slug)."""
    files = scaffold(spec, language)
    root = slug(spec.name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in files.items():
            zf.writestr(f"{root}/{path}", content)
    return buf.getvalue()


# ---- Python target: clone the running runtime ----------------------------- #

def _python_project(spec: AgentSpec) -> dict[str, str]:
    pkg = pkg_name(spec.name)
    project = slug(spec.name)
    spec_json = json.dumps(spec.model_dump(), indent=2)
    m = {
        "NAME": spec.name, "DESC": spec.description, "PKG": pkg, "SLUG": project,
        "SPEC_JSON": spec_json, "VERSION": __version__,
        "TOOLS": ", ".join(spec.tools) or "(none)",
    }
    files: dict[str, str] = {}

    # clone the deterministic runtime, renaming the package in imports
    for module in _CLONE_MODULES:
        files[f"src/{pkg}/{module}"] = (
            (_SRC / module).read_text().replace("agent_factory", pkg)
        )

    files[f"src/{pkg}/__init__.py"] = _render(_PY_INIT, m)
    files[f"src/{pkg}/cli.py"] = _render(_PY_CLI, m)
    files[f"src/{pkg}/__main__.py"] = _render(_PY_MAIN, m)
    files[f"src/{pkg}/api.py"] = _render(_PY_API, m)
    files["tests/test_agent.py"] = _render(_PY_TEST, m)
    files["agent_spec.json"] = spec_json + "\n"
    files["pyproject.toml"] = _render(_PY_PYPROJECT, m)
    files["Dockerfile"] = _render(_PY_DOCKERFILE, m)
    files[".env.example"] = _ENV_EXAMPLE
    files[".gitignore"] = _PY_GITIGNORE
    files["README.md"] = _render(_PY_README, m)
    return files


# ---- TypeScript target: hand-written port --------------------------------- #

def _typescript_project(spec: AgentSpec) -> dict[str, str]:
    project = slug(spec.name)
    spec_json = json.dumps(spec.model_dump(), indent=2)
    m = {
        "NAME": spec.name, "DESC": spec.description, "SLUG": project,
        "SPEC_JSON": spec_json, "VERSION": __version__,
        "TOOLS": ", ".join(spec.tools) or "(none)",
    }
    files: dict[str, str] = {
        "src/spec.ts": _TS_SPEC,
        "src/tools.ts": _TS_TOOLS,
        "src/planner.ts": _TS_PLANNER,
        "src/guardrails.ts": _TS_GUARDRAILS,
        "src/llm.ts": _TS_LLM,
        "src/agent.ts": _TS_AGENT,
        "src/orchestrate.ts": _TS_ORCHESTRATE,
        "src/cli.ts": _render(_TS_CLI, m),
        "src/server.ts": _render(_TS_SERVER, m),
        "test/agent.test.ts": _TS_TEST,
        "agent-spec.json": spec_json + "\n",
        "package.json": _render(_TS_PACKAGE, m),
        "tsconfig.json": _TS_TSCONFIG,
        "Dockerfile": _render(_TS_DOCKERFILE, m),
        ".env.example": _ENV_EXAMPLE,
        ".gitignore": _TS_GITIGNORE,
        "README.md": _render(_TS_README, m),
    }
    return files


# --------------------------------------------------------------------------- #
# shared assets
# --------------------------------------------------------------------------- #

_ENV_EXAMPLE = """\
# This agent runs FULLY OFFLINE with no keys (deterministic rule planner +
# sandboxed tools + a deterministic mock). Add a model only to sharpen planning
# and the final answer. Copy to `.env` and fill in what you need.
#
# LLM_MODE=auto|free|paid|offline       # default: auto
# OPENROUTER_API_KEY=sk-or-...          # free models (free by default)
# ANTHROPIC_API_KEY=sk-ant-...          # paid, best quality
# OPENAI_API_KEY=sk-...                 # paid alternative
# OLLAMA_BASE_URL=http://localhost:11434  # local models, no network
# LLM_TIMEOUT=45
"""

_PY_GITIGNORE = "__pycache__/\n*.pyc\n.venv/\n.env\ndist/\nbuild/\n*.egg-info/\n"
_TS_GITIGNORE = "node_modules/\ndist/\n.env\n*.log\n"


# --------------------------------------------------------------------------- #
# Python templates
# --------------------------------------------------------------------------- #

_PY_INIT = '''\
"""@@NAME@@ — @@DESC@@

A standalone tool-using agent generated by agent-factory's paved-road
scaffolder. The deterministic core runs fully offline; a model only sharpens
planning and the final answer.
"""

__version__ = "0.1.0"
'''

_PY_CLI = '''\
"""Command-line entrypoint.

    python -m @@PKG@@ "your task"                 # run (durable when enabled)
    python -m @@PKG@@ --thread T "your task"      # pin a thread id (resumable)
    python -m @@PKG@@ --approve --thread T        # approve a paused HITL plan
"""

import json
import sys
from pathlib import Path

from @@PKG@@ import orchestrate
from @@PKG@@.spec import AgentSpec

SPEC_PATH = Path(__file__).resolve().parents[2] / "agent_spec.json"


def load_spec() -> AgentSpec:
    """Load this agent's pinned spec from ``agent_spec.json``."""
    return AgentSpec.model_validate(json.loads(SPEC_PATH.read_text()))


def _print(result) -> None:
    for i, step in enumerate(result.steps, 1):
        status = "ok" if step.ok else "ERR"
        print(f"step {i} [{status}]: {step.tool}({step.args}) -> {step.observation}")
    print("\\nstatus:", result.status, "| thread:", result.thread_id)
    print("answer:", result.answer)
    print(f"[planner={result.planner} elapsed={result.elapsed_ms}ms]")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    thread_id, approve = None, False
    rest: list[str] = []
    while argv:
        arg = argv.pop(0)
        if arg == "--thread":
            thread_id = argv.pop(0) if argv else None
        elif arg == "--approve":
            approve = True
        else:
            rest.append(arg)
    task = " ".join(rest).strip()
    if not task and not approve:
        print('usage: python -m @@PKG@@ [--thread ID] [--approve] "your task"',
              file=sys.stderr)
        return 2
    result = orchestrate.run(task, load_spec(), thread_id=thread_id, approve=approve)
    _print(result)
    if result.status == "awaiting_approval":
        print(f"\\n→ review the plan, then approve: "
              f"python -m @@PKG@@ --approve --thread {result.thread_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''

_PY_MAIN = '''\
from @@PKG@@.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
'''

_PY_API = '''\
"""HTTP server for @@NAME@@.

    GET  /health                         liveness
    POST /run     {"task": "...",        run the agent (durable when enabled);
                   "thread_id": "..."?}  with hitl set, returns awaiting_approval
    POST /approve {"thread_id": "..."}   approve a paused plan and act on it

Run it:  ``uvicorn @@PKG@@.api:app --reload --port 8000``
"""

import json
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from @@PKG@@ import __version__, orchestrate
from @@PKG@@.spec import AgentSpec

_SPEC = AgentSpec.model_validate(
    json.loads((Path(__file__).resolve().parents[2] / "agent_spec.json").read_text())
)

app = FastAPI(title="@@NAME@@", version=__version__)


class RunRequest(BaseModel):
    task: str = Field(min_length=1, max_length=4000)
    thread_id: str | None = None


class ApproveRequest(BaseModel):
    thread_id: str


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "agent": _SPEC.name, "version": __version__}


@app.post("/run")
def run_task(request: RunRequest) -> dict:
    result = orchestrate.run(request.task, _SPEC, thread_id=request.thread_id)
    out = asdict(result)
    out["spec"] = _SPEC.model_dump()
    return out


@app.post("/approve")
def approve(request: ApproveRequest) -> dict:
    """Approve a paused human-in-the-loop plan and run it to completion."""
    return asdict(orchestrate.run("", _SPEC, thread_id=request.thread_id, approve=True))
'''

_PY_TEST = '''\
import json
from pathlib import Path

from @@PKG@@.agent import run
from @@PKG@@.spec import AgentSpec

SPEC = AgentSpec.model_validate(
    json.loads((Path(__file__).resolve().parents[1] / "agent_spec.json").read_text())
)


def test_runs_offline_without_keys():
    result = run("Say hello.", SPEC)
    assert result.agent == SPEC.name
    assert isinstance(result.answer, str) and result.answer


def test_respects_the_tool_allowlist():
    # every executed step must use a tool the spec permits
    result = run("Compute 2 + 2 and convert 1 km to m.", SPEC)
    for step in result.steps:
        assert step.tool in SPEC.tools
'''

_PY_PYPROJECT = '''\
[build-system]
requires = ["hatchling>=1.24"]
build-backend = "hatchling.build"

[project]
name = "@@SLUG@@"
version = "0.1.0"
description = "@@DESC@@"
readme = "README.md"
requires-python = ">=3.11"
dependencies = ["pydantic>=2.7"]

[project.optional-dependencies]
serve = ["fastapi>=0.115", "uvicorn>=0.30"]
dev = ["pytest>=8", "httpx>=0.27"]

[project.scripts]
@@SLUG@@ = "@@PKG@@.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["src/@@PKG@@"]

[tool.pytest.ini_options]
testpaths = ["tests"]
'''

_PY_DOCKERFILE = '''\
# Single-stage, non-root. Generated by agent-factory's paved-road scaffolder.
FROM python:3.11-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app

# pydantic powers the spec; fastapi/uvicorn serve it. The LLM router is stdlib.
RUN pip install --no-cache-dir "pydantic>=2.7" "fastapi>=0.115" "uvicorn>=0.30"

COPY src/ /app/src/
COPY agent_spec.json /app/agent_spec.json
ENV PYTHONPATH=/app/src \\
    PORT=8080
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn @@PKG@@.api:app --host 0.0.0.0 --port ${PORT}"]
'''

_PY_README = '''\
# @@NAME@@

> @@DESC@@

A standalone, tool-using agent generated by **agent-factory**'s paved-road
scaffolder. The deterministic core runs **fully offline** — a rule planner over
sandboxed, offline tools, answering from tool results. Add a model key only to
sharpen planning and the final prose; it is a sharpener, not a dependency.

## Project layout

```
@@SLUG@@/
├── agent_spec.json        # the agent — edit this, no code changes needed
├── pyproject.toml
├── Dockerfile
├── .env.example
├── src/@@PKG@@/
│   ├── agent.py           # guard → plan → act → answer loop
│   ├── spec.py            # the validated AgentSpec
│   ├── planner.py         # deterministic rule planner (offline fallback)
│   ├── llm_planner.py     # LLM planner + answer synthesis
│   ├── llm.py             # multi-provider router (stdlib, mock-terminal)
│   ├── tools.py           # sandboxed, offline tools
│   ├── guardrails.py      # input injection scan + output PII/secret redaction
│   ├── cli.py             # `python -m @@PKG@@ "task"`
│   └── api.py             # FastAPI: GET /health, POST /run
└── tests/test_agent.py
```

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[serve,dev]"
```

## Run it

```bash
# from the command line
python -m @@PKG@@ "Convert 26.2 miles to km, then how many days from 2026-01-01 to 2026-03-01?"

# or as an HTTP service
uvicorn @@PKG@@.api:app --reload --port 8000
curl -s localhost:8000/run -H content-type:application/json \\
  -d '{"task":"What is 3 * (4 + 5)?"}'
```

## Configuration

The whole agent is one file — `agent_spec.json`. Edit it and re-run; nothing
else changes.

| field | what it controls |
|---|---|
| `system_prompt` | the agent's role |
| `tools` | the allowlist of tools it may call |
| `planner` | `auto` (LLM, rule fallback) · `llm` · `rule` |
| `model_mode` | `auto` · `free` · `paid` · `offline` |
| `model` | optional model override |
| `max_steps` | step budget (1–12); one tool call per step |
| `temperature`, `answer_style` | sampling + concise/detailed answers |
| `guardrails` | input injection scan · output secret/PII redaction |

**Tools enabled in this agent:** @@TOOLS@@

## Models (optional)

Runs with **zero keys** (deterministic planner + mock). To add a model, set the
environment variables in `.env.example`:

```bash
OPENROUTER_API_KEY=sk-or-...  uvicorn @@PKG@@.api:app   # free models
ANTHROPIC_API_KEY=sk-ant-...  LLM_MODE=paid  uvicorn @@PKG@@.api:app
LLM_MODE=offline              uvicorn @@PKG@@.api:app   # force the offline path
```

## Docker

```bash
docker build -t @@SLUG@@ .
docker run --rm -p 8080:8080 @@SLUG@@
# → http://localhost:8080/health
```

## Tests

```bash
pytest -q
```

---
Generated by [agent-factory](https://github.com/MarcBittner/ai-portfolio). The
sample knowledge base and document store are synthetic; it runs on your real
data too. No secrets in the repo.
'''


# --------------------------------------------------------------------------- #
# TypeScript templates
# --------------------------------------------------------------------------- #

_TS_SPEC = '''\
// The declarative agent specification — the single source of truth.

export type Planner = "auto" | "rule" | "llm";
export type ModelMode = "auto" | "free" | "paid" | "offline";
export type AnswerStyle = "concise" | "detailed";

export interface Guardrails {
  input: boolean;
  output: boolean;
}

export interface AgentSpec {
  name: string;
  description: string;
  system_prompt: string;
  tools: string[];
  planner: Planner;
  model_mode: ModelMode;
  model: string | null;
  max_steps: number;
  temperature: number;
  answer_style: AnswerStyle;
  guardrails: Guardrails;
  // orchestration layer (durable execution)
  hitl: boolean;        // human-in-the-loop: plan, then pause for approval
  checkpoint: boolean;  // persist durable per-thread state
  audit: boolean;       // append each run's trace to an audit log
}

import { TOOL_NAMES } from "./tools.js";

const PLANNERS: Planner[] = ["auto", "rule", "llm"];
const MODES: ModelMode[] = ["auto", "free", "paid", "offline"];
const STYLES: AnswerStyle[] = ["concise", "detailed"];

/** Validate + normalise an untrusted object into an AgentSpec. */
export function loadSpec(raw: unknown): AgentSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(TOOL_NAMES);
  const tools = Array.isArray(o.tools)
    ? [...new Set((o.tools as unknown[]).map(String).filter((t) => known.has(t)))]
    : [...TOOL_NAMES];
  const planner = PLANNERS.includes(o.planner as Planner)
    ? (o.planner as Planner) : "auto";
  const mode = MODES.includes(o.model_mode as ModelMode)
    ? (o.model_mode as ModelMode) : "auto";
  const style = STYLES.includes(o.answer_style as AnswerStyle)
    ? (o.answer_style as AnswerStyle) : "concise";
  const steps = Math.min(12, Math.max(1, Number(o.max_steps ?? 6) || 6));
  const temp = Math.min(1, Math.max(0, Number(o.temperature ?? 0.2)));
  const g = (o.guardrails ?? {}) as Record<string, unknown>;
  return {
    name: String(o.name ?? "custom-agent"),
    description: String(o.description ?? "A custom agent."),
    system_prompt: String(o.system_prompt ?? "You are a helpful, precise assistant."),
    tools,
    planner,
    model_mode: mode,
    model: o.model == null ? null : String(o.model),
    max_steps: steps,
    temperature: temp,
    answer_style: style,
    guardrails: { input: g.input !== false, output: g.output !== false },
    hitl: o.hitl === true,
    checkpoint: o.checkpoint === true,
    audit: o.audit !== false,
  };
}
'''

_TS_TOOLS = r'''// Safe, deterministic, offline tools. Each returns a string so one tool's
// result can feed another's args. The calculator uses a recursive-descent
// parser (never eval).

export class ToolError extends Error {}

export interface Param {
  name: string;
  type: "string" | "number";
  description: string;
  required?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  params: Param[];
  fn: (args: Record<string, unknown>) => string;
}

// ---- arithmetic (safe recursive-descent parser, no eval) ----
function calculator(args: Record<string, unknown>): string {
  const src = String(args.expression ?? "").replace(/\^/g, "**");
  let pos = 0;
  const skip = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  function expr(): number {
    let v = term();
    for (;;) {
      skip();
      const op = src[pos];
      if (op === "+" || op === "-") { pos++; v = op === "+" ? v + term() : v - term(); }
      else break;
    }
    return v;
  }
  function term(): number {
    let v = power();
    for (;;) {
      skip();
      if (src.startsWith("**", pos)) break;
      const op = src[pos];
      if (op === "*" || op === "/" || op === "%") {
        pos++;
        const r = power();
        if (op === "*") v *= r;
        else if (op === "/") v /= r;
        else v %= r;
      } else break;
    }
    return v;
  }
  function power(): number {
    const base = unary();
    skip();
    if (src.startsWith("**", pos)) { pos += 2; return base ** power(); }
    return base;
  }
  function unary(): number {
    skip();
    if (src[pos] === "-") { pos++; return -unary(); }
    if (src[pos] === "+") { pos++; return unary(); }
    return primary();
  }
  function primary(): number {
    skip();
    if (src[pos] === "(") {
      pos++;
      const v = expr();
      skip();
      if (src[pos] !== ")") throw new ToolError(`unbalanced parentheses in ${src}`);
      pos++;
      return v;
    }
    const m = /^\d*\.?\d+/.exec(src.slice(pos));
    if (!m) throw new ToolError(`cannot evaluate ${args.expression}`);
    pos += m[0].length;
    return parseFloat(m[0]);
  }
  let out: number;
  try {
    out = expr();
    skip();
    if (pos !== src.length) throw new ToolError(`unexpected token in ${src}`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`cannot evaluate ${args.expression}`);
  }
  if (!Number.isFinite(out)) throw new ToolError(`cannot evaluate ${args.expression}`);
  return Number.isInteger(out) ? String(out) : String(Number(out.toFixed(6)));
}

// ---- unit conversion ----
const UNIT_ALIASES: Record<string, string> = {
  meter: "m", meters: "m", metre: "m", kilometer: "km", kilometers: "km",
  mile: "mi", miles: "mi", foot: "ft", feet: "ft", inch: "in", inches: "in",
  yard: "yd", yards: "yd", centimeter: "cm", centimeters: "cm",
  millimeter: "mm", millimeters: "mm", kilogram: "kg", kilograms: "kg",
  gram: "g", grams: "g", pound: "lb", pounds: "lb", ounce: "oz", ounces: "oz",
  celsius: "c", fahrenheit: "f", kelvin: "k",
};
const UNIT_TABLES: Record<string, number>[] = [
  { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 },
  { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 },
];
const canon = (u: string) => {
  const k = String(u).toLowerCase().trim();
  return UNIT_ALIASES[k] ?? k;
};
function toCelsius(v: number, u: string): number {
  return u === "c" ? v : u === "f" ? ((v - 32) * 5) / 9 : v - 273.15;
}
function fromCelsius(c: number, u: string): number {
  return u === "c" ? c : u === "f" ? (c * 9) / 5 + 32 : c + 273.15;
}
function convert(args: Record<string, unknown>): string {
  const value = Number(args.value);
  if (!Number.isFinite(value)) throw new ToolError(`value must be a number: ${args.value}`);
  const src = canon(String(args.from_unit));
  const dst = canon(String(args.to_unit));
  if (["c", "f", "k"].includes(src) && ["c", "f", "k"].includes(dst)) {
    return `${Number(fromCelsius(toCelsius(value, src), dst).toFixed(4))} ${dst}`;
  }
  for (const table of UNIT_TABLES) {
    if (src in table && dst in table) {
      return `${Number(((value * table[src]) / table[dst]).toFixed(6))} ${dst}`;
    }
  }
  throw new ToolError(`cannot convert ${args.from_unit} to ${args.to_unit}`);
}

// ---- dates ----
function dateDiff(args: Record<string, unknown>): string {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const a = String(args.start).trim();
  const b = String(args.end).trim();
  if (!re.test(a) || !re.test(b)) throw new ToolError("dates must be YYYY-MM-DD");
  const d1 = Date.parse(a + "T00:00:00Z");
  const d2 = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(d1) || Number.isNaN(d2)) throw new ToolError("invalid date");
  return String(Math.abs(Math.round((d2 - d1) / 86400000)));
}

// ---- text + data ----
function textStats(args: Record<string, unknown>): string {
  const s = String(args.text ?? "");
  const words = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).length;
  const sentences = s.split(/[.!?]+/).filter((x) => x.trim()).length;
  return `words=${words} sentences=${sentences} chars=${s.length}`;
}
function regexExtract(args: Record<string, unknown>): string {
  let re: RegExp;
  try {
    re = new RegExp(String(args.pattern), "g");
  } catch (e) {
    throw new ToolError(`invalid regex ${args.pattern}: ${(e as Error).message}`);
  }
  const out: string[] = [];
  for (const m of String(args.text).matchAll(re)) {
    out.push(m.length > 1 ? m.slice(1).join("/") : m[0]);
  }
  return out.length ? out.join(", ") : "(no matches)";
}
function jsonGet(args: Record<string, unknown>): string {
  let cur: unknown;
  try {
    cur = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
  } catch (e) {
    throw new ToolError(`not valid JSON: ${(e as Error).message}`);
  }
  for (const part of String(args.path).split(".")) {
    if (!part) continue;
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      throw new ToolError(`path ${args.path} not found at ${part}`);
    }
    if (cur === undefined) throw new ToolError(`path ${args.path} not found at ${part}`);
  }
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

// ---- synthetic knowledge base + docs ----
const KB: [string, string[]][] = [
  ["A tool-using agent interleaves reasoning with tool calls and observations until it can answer.",
    ["agent", "react", "reasoning", "tools", "loop"]],
  ["Retrieval-augmented generation grounds an answer in retrieved documents to reduce hallucination.",
    ["rag", "retrieval", "grounding", "hallucination"]],
  ["Guardrails scan input for injection and output for secret or PII leakage before returning.",
    ["guardrail", "guardrails", "safety", "injection", "pii"]],
  ["Model routing sends a request to a free, paid, or local provider by policy, with fallback.",
    ["routing", "router", "provider", "free", "fallback", "model"]],
];
const DOCS: Record<string, string> = {
  onboarding: "Agents start from a spec: system prompt, enabled tools, planner, model mode, step budget.",
  pricing: "Free models are rate-limited; paid models need your own key; offline uses a deterministic mock.",
  limits: "A run is capped by max_steps; each step is one tool call. Tools outside the allowlist are refused.",
};
function kbSearch(args: Record<string, unknown>): string {
  const terms = new Set(String(args.query).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best = "", score = 0;
  for (const [fact, keys] of KB) {
    const s = keys.filter((k) => terms.has(k)).length;
    if (s > score) { best = fact; score = s; }
  }
  return best || "No matching entry in the knowledge base.";
}
function docFetch(args: Record<string, unknown>): string {
  const key = String(args.doc_id).trim().toLowerCase();
  if (key in DOCS) return DOCS[key];
  throw new ToolError(`unknown document ${args.doc_id}; have: ${Object.keys(DOCS).join(", ")}`);
}

export const TOOLS: Record<string, Tool> = {
  calculator: { name: "calculator", description: "Evaluate an arithmetic expression (safe parse).",
    params: [{ name: "expression", type: "string", description: "e.g. '3 * (4 + 5)'" }], fn: calculator },
  convert: { name: "convert", description: "Convert between units of length, mass, or temperature.",
    params: [
      { name: "value", type: "number", description: "the quantity" },
      { name: "from_unit", type: "string", description: "source unit" },
      { name: "to_unit", type: "string", description: "target unit" },
    ], fn: convert },
  date_diff: { name: "date_diff", description: "Whole days between two YYYY-MM-DD dates.",
    params: [
      { name: "start", type: "string", description: "start YYYY-MM-DD" },
      { name: "end", type: "string", description: "end YYYY-MM-DD" },
    ], fn: dateDiff },
  text_stats: { name: "text_stats", description: "Count words, sentences, characters.",
    params: [{ name: "text", type: "string", description: "the text" }], fn: textStats },
  regex_extract: { name: "regex_extract", description: "Extract all regex matches from text.",
    params: [
      { name: "pattern", type: "string", description: "a regular expression" },
      { name: "text", type: "string", description: "the text to search" },
    ], fn: regexExtract },
  json_get: { name: "json_get", description: "Read a dotted path out of a JSON document.",
    params: [
      { name: "data", type: "string", description: "a JSON document" },
      { name: "path", type: "string", description: "dotted path, e.g. 'items.0.name'" },
    ], fn: jsonGet },
  kb_search: { name: "kb_search", description: "Keyword search over a small knowledge base.",
    params: [{ name: "query", type: "string", description: "what to look up" }], fn: kbSearch },
  doc_fetch: { name: "doc_fetch", description: "Fetch a document by id (onboarding, pricing, limits).",
    params: [{ name: "doc_id", type: "string", description: "document id" }], fn: docFetch },
};

export const TOOL_NAMES = Object.keys(TOOLS);

export function toolCatalog(names?: string[]): object[] {
  return (names ?? TOOL_NAMES)
    .map((n) => TOOLS[n])
    .filter(Boolean)
    .map((t) => ({
      name: t.name,
      description: t.description,
      signature: `${t.name}(${t.params.map((p) => p.name).join(", ")})`,
      params: t.params,
    }));
}
'''

_TS_PLANNER = r'''// Deterministic rule planner — the offline fallback. Maps a task to an ordered
// list of tool calls using cheap heuristics, only emitting allowlisted tools.

export interface Step {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
}

const CONV = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s*(?:to|in|into)\s+([a-zA-Z°]+)/i;
const DATE = /\d{4}-\d{2}-\d{2}/g;
const MATH = /\d[\d.\s]*(?:[-+*/^]\s*\(?\s*\d[\d.\s)]*)+/;
const WORDS_IN = /(?:how many words|word count|count the words)[\s\S]*?[:\-]\s*([\s\S]+)$/i;
const DOC_IDS = ["onboarding", "pricing", "limits"];

export function rulePlan(task: string, allowed: string[]): Step[] {
  const allow = new Set(allowed);
  const steps: Step[] = [];
  const low = task.toLowerCase();

  if (allow.has("convert")) {
    const m = CONV.exec(task);
    if (m) {
      steps.push({
        thought: `Convert ${m[1]} ${m[2]} to ${m[3]}.`,
        tool: "convert",
        args: { value: m[1], from_unit: m[2], to_unit: m[3] },
      });
    }
  }
  if (allow.has("date_diff")) {
    const dates = task.match(DATE) ?? [];
    if (dates.length >= 2) {
      steps.push({
        thought: `Count the days between ${dates[0]} and ${dates[1]}.`,
        tool: "date_diff",
        args: { start: dates[0], end: dates[1] },
      });
    }
  }
  if (allow.has("calculator") && steps.length === 0) {
    const m = MATH.exec(task);
    if (m) {
      steps.push({
        thought: `Evaluate the expression ${m[0].trim()}.`,
        tool: "calculator",
        args: { expression: m[0].trim() },
      });
    }
  }
  if (allow.has("text_stats")) {
    const m = WORDS_IN.exec(task);
    if (m) {
      steps.push({ thought: "Measure the supplied text.", tool: "text_stats", args: { text: m[1].trim() } });
    }
  }
  if (allow.has("doc_fetch")) {
    for (const doc of DOC_IDS) {
      if (low.includes(doc)) {
        steps.push({ thought: `Fetch the ${doc} document.`, tool: "doc_fetch", args: { doc_id: doc } });
        break;
      }
    }
  }
  if (steps.length === 0 && allow.has("kb_search")) {
    steps.push({ thought: "Search the knowledge base.", tool: "kb_search", args: { query: task } });
  }
  return steps;
}
'''

_TS_GUARDRAILS = r'''// Lightweight, deterministic guardrails: scan input for injection and redact
// secrets/PII from output before returning.

export interface Finding {
  kind: string;
  category: string;
  snippet: string;
}

const INJECTION: [RegExp, string][] = [
  [/ignore (all|any|the)? ?(previous|prior|above) instructions/i, "instruction-override"],
  [/disregard (the|all|your) (system|previous) prompt/i, "instruction-override"],
  [/\b(reveal|print|show|leak)\b.{0,30}\b(system prompt|instructions)\b/i, "prompt-exfiltration"],
  [/you are now (dan|developer mode|do anything)/i, "jailbreak"],
  [/\bpretend you have no (rules|restrictions|guidelines)\b/i, "jailbreak"],
];

const SECRETS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9]{16,}/g, "api-key"],
  [/AKIA[0-9A-Z]{16}/g, "aws-key"],
  [/ghp_[A-Za-z0-9]{20,}/g, "github-token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private-key"],
];
const PII: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "ssn"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "email"],
  [/\b(?:\d[ -]?){13,16}\b/g, "card-like"],
];

export const HARD_BLOCK = new Set(["jailbreak", "prompt-exfiltration"]);

export function scanInput(text: string): Finding[] {
  const out: Finding[] = [];
  for (const [re, category] of INJECTION) {
    const m = re.exec(text);
    if (m) out.push({ kind: "injection", category, snippet: m[0].slice(0, 80) });
  }
  return out;
}

export function scanAndRedactOutput(text: string): { cleaned: string; findings: Finding[] } {
  const findings: Finding[] = [];
  let cleaned = text;
  for (const [table, kind] of [[SECRETS, "secret"], [PII, "pii"]] as [[RegExp, string][], string][]) {
    for (const [re, category] of table) {
      cleaned = cleaned.replace(re, () => {
        findings.push({ kind, category, snippet: "[redacted]" });
        return `[redacted:${category}]`;
      });
    }
  }
  return { cleaned, findings };
}
'''

_TS_LLM = r'''// Minimal multi-provider LLM router (zero deps; uses built-in fetch). Modes:
// auto | free | paid | offline. A call never throws — the chain ends at a
// deterministic mock, so the agent stays usable with no provider at all.

export interface LLMResult {
  text: string;
  provider: string;
  model: string;
  fallbacks: string[];
}

const env = (k: string, d = "") => process.env[k] ?? d;
const MODE = env("LLM_MODE", "auto").toLowerCase();
const TIMEOUT = Number(env("LLM_TIMEOUT", "45")) * 1000;

function order(provider?: string): string[] {
  if (provider && !["auto", "free", "paid", "offline"].includes(provider)) return [provider];
  const mode = ["free", "paid", "offline"].includes(provider ?? "") ? provider! : MODE;
  if (mode === "offline") return ["ollama", "mock"];
  if (mode === "free") return ["openrouter", "mock"];
  if (mode === "paid") {
    const o: string[] = [];
    if (env("ANTHROPIC_API_KEY")) o.push("anthropic");
    if (env("OPENAI_API_KEY")) o.push("openai");
    return [...o, "mock"];
  }
  const o: string[] = [];
  if (env("OPENROUTER_API_KEY")) o.push("openrouter");
  if (env("ANTHROPIC_API_KEY")) o.push("anthropic");
  if (env("OPENAI_API_KEY")) o.push("openai");
  return [...o, "ollama", "mock"];
}

function modelFor(provider: string, override?: string | null): string {
  if (override) return override;
  return ({
    ollama: env("OLLAMA_MODEL", "llama3.1:8b"),
    anthropic: env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
    openai: env("OPENAI_MODEL", "gpt-4o-mini"),
    openrouter: env("OPENROUTER_MODEL", "google/gemma-4-31b-it:free"),
  } as Record<string, string>)[provider] ?? "mock";
}

async function post(url: string, body: object, headers: Record<string, string>): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const mock = (prompt: string) => `[mock] ${prompt.trim().slice(0, 200)}`;

export async function complete(
  prompt: string,
  system = "You are a precise assistant.",
  provider: string | undefined = "auto",
  model?: string | null,
): Promise<LLMResult> {
  const fallbacks: string[] = [];
  for (const p of order(provider)) {
    const m = modelFor(p, model);
    try {
      let text: string;
      if (p === "ollama") {
        const d = await post(`${env("OLLAMA_BASE_URL", "http://localhost:11434")}/api/chat`,
          { model: m, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }, {});
        text = d.message.content;
      } else if (p === "anthropic" && env("ANTHROPIC_API_KEY")) {
        const d = await post("https://api.anthropic.com/v1/messages",
          { model: m, max_tokens: 2048, system, messages: [{ role: "user", content: prompt }] },
          { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" });
        text = d.content[0].text;
      } else if (p === "openai" && env("OPENAI_API_KEY")) {
        const d = await post("https://api.openai.com/v1/chat/completions",
          { model: m, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] },
          { authorization: `Bearer ${env("OPENAI_API_KEY")}` });
        text = d.choices[0].message.content;
      } else if (p === "openrouter" && env("OPENROUTER_API_KEY")) {
        const d = await post("https://openrouter.ai/api/v1/chat/completions",
          { model: m, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] },
          { authorization: `Bearer ${env("OPENROUTER_API_KEY")}` });
        text = d.choices[0].message.content;
      } else if (p === "mock") {
        text = mock(prompt);
      } else {
        continue;
      }
      return { text, provider: p, model: m, fallbacks };
    } catch (e) {
      fallbacks.push(`${p}: ${(e as Error).name}`);
    }
  }
  return { text: mock(prompt), provider: "mock", model: "mock", fallbacks };
}

export async function completeJson(
  prompt: string,
  system: string,
  provider?: string,
  model?: string | null,
): Promise<{ parsed: unknown; result: LLMResult }> {
  const result = await complete(prompt, system, provider, model);
  if (result.provider === "mock") return { parsed: null, result };
  let raw = result.text.trim();
  if ((raw.match(/```/g) ?? []).length >= 2) raw = raw.split("```")[1].replace(/^json/, "").trim();
  const starts = [raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return { parsed: null, result };
  const start = Math.min(...starts);
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  try {
    return { parsed: JSON.parse(raw.slice(start, end + 1)), result };
  } catch {
    return { parsed: null, result };
  }
}

export function activeMode(): string {
  if (["free", "paid", "offline"].includes(MODE)) return MODE;
  if (env("OPENROUTER_API_KEY")) return "free";
  if (env("ANTHROPIC_API_KEY") || env("OPENAI_API_KEY")) return "paid";
  return "offline";
}
'''

_TS_AGENT = r'''// The agent runtime: guard → plan → act → answer → guard.

import { AgentSpec } from "./spec.js";
import { TOOLS, ToolError } from "./tools.js";
import { rulePlan, Step } from "./planner.js";
import { scanInput, scanAndRedactOutput, HARD_BLOCK, Finding } from "./guardrails.js";
import { complete, completeJson } from "./llm.js";

export interface TraceStep {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
  ok: boolean;
}

export interface AgentRun {
  agent: string;
  task: string;
  answer: string;
  planner: "rule" | "llm";
  blocked: boolean;
  status: "complete" | "awaiting_approval" | "blocked";
  steps: TraceStep[];
  routing: { provider: string; model: string; fallbacks: string[] } | null;
  input_findings: Finding[];
  output_findings: Finding[];
  elapsed_ms: number;
  thread_id: string | null;
}

const PLAN_SYS =
  "You are the planner for a tool-using agent. Given a task and available tools, " +
  'output a minimal JSON array of steps, each {"thought": str, "tool": str, "args": object}. ' +
  "Use ONLY the listed tools and their named arguments. To feed one step's result into a " +
  "later step, put the placeholder {0}, {1}, ... in a string arg. Output ONLY the JSON array.";

function fill(args: Record<string, unknown>, obs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      out[k] = obs.reduce((acc, o, i) => acc.replaceAll(`{${i}}`, o), v);
    } else out[k] = v;
  }
  return out;
}

export function inputGuard(task: string, spec: AgentSpec): Finding[] {
  return spec.guardrails.input ? scanInput(task) : [];
}

export function isBlocked(findings: Finding[]): boolean {
  return findings.some((f) => HARD_BLOCK.has(f.category));
}

export function blockedRun(spec: AgentSpec, task: string, findings: Finding[], started: number): AgentRun {
  return {
    agent: spec.name, task, blocked: true, status: "blocked", planner: "rule",
    answer: "Blocked: the request looks like a prompt-injection / jailbreak attempt.",
    steps: [], routing: null, input_findings: findings, output_findings: [],
    elapsed_ms: Date.now() - started, thread_id: null,
  };
}

export async function buildPlan(task: string, spec: AgentSpec):
  Promise<{ steps: Step[]; planner: "rule" | "llm"; routing: AgentRun["routing"] }> {
  if (spec.planner === "rule") {
    return { steps: rulePlan(task, spec.tools), planner: "rule", routing: null };
  }
  const catalog = spec.tools.map((n) => {
    const t = TOOLS[n];
    return `- ${t.name}(${t.params.map((p) => `${p.name}:${p.type}`).join(", ")}) — ${t.description}`;
  }).join("\n");
  const { parsed, result } = await completeJson(
    `Task:\n${task}\n\nAvailable tools:\n${catalog}\n\nPlan (JSON array, <= ${spec.max_steps} steps):`,
    PLAN_SYS, spec.model_mode, spec.model);
  const routing = { provider: result.provider, model: result.model, fallbacks: result.fallbacks };
  if (Array.isArray(parsed)) {
    const allow = new Set(spec.tools);
    const steps: Step[] = [];
    for (const raw of parsed.slice(0, spec.max_steps)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const tool = String(r.tool ?? "").trim();
      if (!allow.has(tool)) continue;
      const args = (r.args && typeof r.args === "object") ? (r.args as Record<string, unknown>) : {};
      steps.push({ thought: String(r.thought ?? "").trim() || `Use ${tool}.`, tool, args });
    }
    if (steps.length) return { steps, planner: "llm", routing };
  }
  return { steps: rulePlan(task, spec.tools), planner: "rule", routing };
}

/** The act → answer → guard half of a run, over an already-built plan. */
export async function execute(
  task: string, spec: AgentSpec, steps: Step[],
  planner: "rule" | "llm", routing: AgentRun["routing"],
  inputFindings: Finding[] = [], started: number = Date.now(),
): Promise<AgentRun> {
  const base: AgentRun = {
    agent: spec.name, task, answer: "", planner, blocked: false, status: "complete",
    steps: [], routing, input_findings: inputFindings, output_findings: [],
    elapsed_ms: 0, thread_id: null,
  };

  const observations: string[] = [];
  for (const step of steps.slice(0, spec.max_steps)) {
    if (!spec.tools.includes(step.tool)) {
      base.steps.push({ ...step, observation: `error: tool ${step.tool} not in allowlist`, ok: false });
      observations.push("");
      continue;
    }
    const args = fill(step.args, observations);
    let observation: string, ok: boolean;
    try {
      observation = TOOLS[step.tool].fn(args);
      ok = true;
    } catch (e) {
      observation = `error: ${e instanceof ToolError ? e.message : String(e)}`;
      ok = false;
    }
    observations.push(observation);
    base.steps.push({ thought: step.thought, tool: step.tool, args, observation, ok });
  }

  let answer = "";
  if (planner === "llm") {
    const style = spec.answer_style === "concise"
      ? "Answer in one or two sentences." : "Answer thoroughly, explaining the reasoning.";
    const obs = observations.map((o, i) => `[${i}] ${o}`).join("\n") || "(none)";
    const result = await complete(
      `Task:\n${task}\n\nTool observations:\n${obs}\n\nWrite the final answer grounded in the observations. ${style}`,
      spec.system_prompt, spec.model_mode, spec.model);
    if (result.provider !== "mock") answer = result.text.trim();
  }
  if (!answer) {
    const good = base.steps.filter((s) => s.ok).map((s) => s.observation);
    answer = good.length ? good[good.length - 1]
      : observations.length ? observations[observations.length - 1]
        : "I couldn't find a tool that fits this task.";
  }

  if (spec.guardrails.output) {
    const { cleaned, findings } = scanAndRedactOutput(answer);
    answer = cleaned;
    base.output_findings = findings;
  }

  return { ...base, answer, elapsed_ms: Date.now() - started };
}

/** Run a spec over a task end to end: guard → plan → act → answer. For durable,
 *  resumable, human-in-the-loop runs, use orchestrate.ts instead. */
export async function run(task: string, spec: AgentSpec): Promise<AgentRun> {
  const started = Date.now();
  const findings = inputGuard(task, spec);
  if (isBlocked(findings)) return blockedRun(spec, task, findings, started);
  const { steps, planner, routing } = await buildPlan(task, spec);
  return execute(task, spec, steps, planner, routing, findings, started);
}
'''

_TS_ORCHESTRATE = r'''// Durable orchestration layer — checkpointed state, an approval gate, an audit
// trail. Mirrors LangGraph's checkpointer, hand-rolled: state is snapshotted per
// run keyed by threadId; with hitl set the agent plans then PAUSES for approval;
// every run is appended to an audit log. Swap the store for Postgres/Redis by
// subclassing CheckpointStore.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentSpec } from "./spec.js";
import { Step } from "./planner.js";
import {
  AgentRun, blockedRun, buildPlan, execute, inputGuard, isBlocked,
} from "./agent.js";

function stateDir(): string {
  const d = process.env.AGENT_STATE_DIR ?? ".agent_state";
  mkdirSync(d, { recursive: true });
  return d;
}

export function newThreadId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export class CheckpointStore {
  root: string;
  constructor(root?: string) {
    this.root = root ?? join(stateDir(), "checkpoints");
    mkdirSync(this.root, { recursive: true });
  }
  private path(id: string): string {
    return join(this.root, `${id}.json`);
  }
  save(id: string, data: object): void {
    writeFileSync(this.path(id), JSON.stringify(data, null, 2));
  }
  load(id: string): any | null {
    const p = this.path(id);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }
}

function audit(result: AgentRun): void {
  appendFileSync(join(stateDir(), "audit.jsonl"), JSON.stringify({
    thread_id: result.thread_id, agent: result.agent, task: result.task,
    status: result.status, planner: result.planner, steps: result.steps,
    answer: result.answer, input_findings: result.input_findings,
    output_findings: result.output_findings, elapsed_ms: result.elapsed_ms,
  }) + "\n");
}

export interface RunOpts {
  threadId?: string;
  approve?: boolean;
  store?: CheckpointStore;
}

export async function run(task: string, spec: AgentSpec, opts: RunOpts = {}): Promise<AgentRun> {
  const store = opts.store ?? new CheckpointStore();
  const threadId = opts.threadId ?? newThreadId();
  const started = Date.now();

  // resume path: approve (or re-read) a previously planned run
  const saved = store.load(threadId);
  if (saved && saved.status === "awaiting_approval") {
    if (!opts.approve) return saved as AgentRun;
    const steps = (saved.plan ?? []) as Step[];
    const result = await execute(saved.task, spec, steps, saved.planner, saved.routing, saved.input_findings, started);
    result.thread_id = threadId;
    store.save(threadId, { ...result, plan: steps });
    if (spec.audit) audit(result);
    return result;
  }

  // fresh run
  const findings = inputGuard(task, spec);
  if (isBlocked(findings)) {
    const result = blockedRun(spec, task, findings, started);
    result.thread_id = threadId;
    if (spec.checkpoint || spec.hitl) store.save(threadId, { ...result, plan: [] });
    if (spec.audit) audit(result);
    return result;
  }

  const { steps, planner, routing } = await buildPlan(task, spec);

  if (spec.hitl) {
    const pending: AgentRun = {
      agent: spec.name, task, answer: "Awaiting human approval of the plan before acting.",
      planner, blocked: false, status: "awaiting_approval", steps: [], routing,
      input_findings: findings, output_findings: [], elapsed_ms: Date.now() - started,
      thread_id: threadId,
    };
    store.save(threadId, { ...pending, plan: steps });
    if (spec.audit) audit(pending);
    return pending;
  }

  const result = await execute(task, spec, steps, planner, routing, findings, started);
  result.thread_id = threadId;
  if (spec.checkpoint) store.save(threadId, { ...result, plan: steps });
  if (spec.audit) audit(result);
  return result;
}
'''

_TS_CLI = r'''// Command-line entrypoint:
//   npm run dev -- "your task"                  run (durable when enabled)
//   npm run dev -- --thread T "your task"       pin a thread id (resumable)
//   npm run dev -- --approve --thread T         approve a paused HITL plan

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as orchestrate from "./orchestrate.js";
import { loadSpec } from "./spec.js";

const SPEC_PATH = fileURLToPath(new URL("../agent-spec.json", import.meta.url));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let threadId: string | undefined;
  let approve = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--thread") threadId = argv[++i];
    else if (argv[i] === "--approve") approve = true;
    else rest.push(argv[i]);
  }
  const task = rest.join(" ").trim();
  if (!task && !approve) {
    console.error('usage: node dist/cli.js [--thread ID] [--approve] "your task"');
    return 2;
  }
  const spec = loadSpec(JSON.parse(readFileSync(SPEC_PATH, "utf8")));
  const result = await orchestrate.run(task, spec, { threadId, approve });
  result.steps.forEach((s, i) =>
    console.log(`step ${i + 1} [${s.ok ? "ok" : "ERR"}]: ${s.tool}(${JSON.stringify(s.args)}) -> ${s.observation}`));
  console.log("\nstatus:", result.status, "| thread:", result.thread_id);
  console.log("answer:", result.answer);
  console.log(`[planner=${result.planner} elapsed=${result.elapsed_ms}ms]`);
  if (result.status === "awaiting_approval") {
    console.log(`\n-> review the plan, then approve: npm run dev -- --approve --thread ${result.thread_id}`);
  }
  return 0;
}

main().then((c) => process.exit(c));
'''

_TS_SERVER = r'''// Minimal zero-dependency HTTP server:
//   GET  /health
//   POST /run     {"task": "...", "thread_id"?: "..."}
//   POST /approve {"thread_id": "..."}   approve a paused HITL plan

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as orchestrate from "./orchestrate.js";
import { loadSpec } from "./spec.js";

const SPEC_PATH = fileURLToPath(new URL("../agent-spec.json", import.meta.url));
const spec = loadSpec(JSON.parse(readFileSync(SPEC_PATH, "utf8")));
const PORT = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  const json = (code: number, body: object) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    return json(200, { status: "ok", agent: spec.name });
  }
  if (req.method === "POST" && (req.url === "/run" || req.url === "/approve")) {
    const approving = req.url === "/approve";
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(data || "{}");
        if (!approving && !body.task) return json(422, { error: "missing 'task'" });
        if (approving && !body.thread_id) return json(422, { error: "missing 'thread_id'" });
        json(200, await orchestrate.run(String(body.task ?? ""), spec, {
          threadId: body.thread_id, approve: approving,
        }));
      } catch (e) {
        json(400, { error: (e as Error).message });
      }
    });
    return;
  }
  json(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`@@NAME@@ listening on :${PORT}`));
'''

_TS_TEST = r'''import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../src/agent.js";
import { loadSpec } from "../src/spec.js";

const SPEC = loadSpec(
  JSON.parse(readFileSync(fileURLToPath(new URL("../agent-spec.json", import.meta.url)), "utf8")),
);

test("runs offline without keys", async () => {
  const r = await run("Say hello.", SPEC);
  assert.equal(r.agent, SPEC.name);
  assert.ok(typeof r.answer === "string" && r.answer.length > 0);
});

test("respects the tool allowlist", async () => {
  const r = await run("Compute 2 + 2.", SPEC);
  for (const s of r.steps) assert.ok(SPEC.tools.includes(s.tool));
});
'''

_TS_PACKAGE = '''\
{
  "name": "@@SLUG@@",
  "version": "0.1.0",
  "description": "@@DESC@@",
  "type": "module",
  "bin": { "@@SLUG@@": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/cli.js",
    "dev": "tsx src/cli.ts",
    "serve": "tsx src/server.ts",
    "test": "tsx --test test/*.test.ts"
  },
  "engines": { "node": ">=18" },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
'''

_TS_TSCONFIG = '''\
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
'''

_TS_DOCKERFILE = '''\
# Multi-stage, non-root. Generated by agent-factory's paved-road scaffolder.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

FROM node:20-slim
RUN useradd --create-home --uid 1001 app
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY agent-spec.json ./agent-spec.json
ENV PORT=8080
USER app
EXPOSE 8080
CMD ["node", "dist/server.js"]
'''

_TS_README = '''\
# @@NAME@@

> @@DESC@@

A standalone, tool-using agent generated by **agent-factory**'s paved-road
scaffolder. **Zero runtime dependencies** — it uses only Node's built-ins. The
deterministic core runs **fully offline**; add a model key to sharpen planning
and the final answer.

## Project layout

```
@@SLUG@@/
├── agent-spec.json        # the agent — edit this, no code changes needed
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example
├── src/
│   ├── agent.ts           # guard → plan → act → answer loop
│   ├── spec.ts            # the AgentSpec + validation
│   ├── planner.ts         # deterministic rule planner (offline fallback)
│   ├── llm.ts             # multi-provider router (built-in fetch, mock-terminal)
│   ├── tools.ts           # sandboxed, offline tools
│   ├── guardrails.ts      # input injection scan + output PII/secret redaction
│   ├── cli.ts             # `npm run dev -- "task"`
│   └── server.ts          # GET /health, POST /run
└── test/agent.test.ts
```

## Setup

```bash
npm install
```

## Run it

```bash
# from the command line (no build needed, via tsx)
npm run dev -- "Convert 26.2 miles to km"

# or build + run the HTTP server
npm run build && npm run serve   # → http://localhost:8080
curl -s localhost:8080/run -H content-type:application/json \\
  -d '{"task":"What is 3 * (4 + 5)?"}'
```

## Configuration

The whole agent is one file — `agent-spec.json`. Edit it and re-run.

| field | what it controls |
|---|---|
| `system_prompt` | the agent's role |
| `tools` | the allowlist of tools it may call |
| `planner` | `auto` (LLM, rule fallback) · `llm` · `rule` |
| `model_mode` | `auto` · `free` · `paid` · `offline` |
| `max_steps` | step budget (1–12); one tool call per step |
| `answer_style` | `concise` · `detailed` |
| `guardrails` | input injection scan · output secret/PII redaction |

**Tools enabled in this agent:** @@TOOLS@@

## Models (optional)

Runs with **zero keys** (deterministic planner + mock). To add a model, set the
environment variables in `.env.example` (e.g. `OPENROUTER_API_KEY` for free
models, `ANTHROPIC_API_KEY` with `LLM_MODE=paid` for best quality).

## Docker

```bash
docker build -t @@SLUG@@ .
docker run --rm -p 8080:8080 @@SLUG@@
```

## Tests

```bash
npm test
```

---
Generated by [agent-factory](https://github.com/MarcBittner/ai-portfolio).
Synthetic sample data only; it runs on your real data too.
'''


if __name__ == "__main__":
    raise SystemExit(main())
