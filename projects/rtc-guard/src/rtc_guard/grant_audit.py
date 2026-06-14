"""LLM-assisted least-privilege grant auditor.

Minting is least-privilege *by template* (``token.py``) — but real systems don't
always mint from a clean template. A service stitches together a grant by hand, a
role drifts, a TTL gets bumped "just for debugging," a room scope is dropped so a
token works everywhere. This is the demo's LLM surface: it reads a **proposed**
grant and returns (a) a plain-English explanation of exactly what the grant lets
the holder do, and (b) a list of over-permissioning / least-privilege findings
(a viewer that can publish, a missing room scope = wildcard, an over-long TTL,
data-publish enabled for a pure consumer). The LLM does the explanation and the
judgment; the deterministic offline path is a rule-based auditor with the SAME
output shape, so the audit (and the eval) reproduce with zero keys.

Routing is the portfolio-standard chain (``llm.py``): Anthropic/OpenAI → Ollama →
OpenRouter → the deterministic rule-based auditor. The security CORE (mint/verify,
the adversarial suite) stays deterministic and untouched — this layer only
*reviews* a proposed grant, it never weakens a real one.
"""

from __future__ import annotations

import json

from rtc_guard import llm, token

CAPS = ("roomJoin", "canSubscribe", "canPublish", "canPublishData")
SEVERITIES = ("high", "medium", "low")

# A grant should never live longer than it must; past this it's an over-long TTL.
TTL_WARN = 3600     # 1h — flag as medium
TTL_HIGH = 86_400   # 24h — flag as high (a day-long real-time credential)

# The intended (least-privilege) capability set per declared role. A requested
# capability NOT in the role's template is an over-permission; this is the same
# template table the minting path is built on, used here as the audit baseline.
ROLE_INTENT: dict[str, dict] = {
    "viewer": token.GRANT_TEMPLATES["viewer"],
    "publisher": token.GRANT_TEMPLATES["publisher"],
    "agent": token.GRANT_TEMPLATES["agent"],
    "data_only": token.GRANT_TEMPLATES["data_only"],
}

# Human-readable phrasing for each capability (used by the offline explainer).
_CAP_WORDS = {
    "roomJoin": "join the room",
    "canSubscribe": "subscribe to (receive) other participants' media",
    "canPublish": "publish its own audio/video",
    "canPublishData": "send data-channel messages",
}

SYSTEM = (
    "You are a least-privilege auditor for WebRTC real-time access-token grants. "
    "A grant names an identity, a target room, capability flags "
    f"({', '.join(CAPS)}), a declared role, and a TTL in seconds. Return STRICT "
    'JSON {"explanation": <one plain-English sentence of exactly what this grant '
    'lets the holder do>, "findings": [{"severity": <high|medium|low>, "issue": '
    "<the over-permission or risk>, \"recommendation\": <the least-privilege fix>}]}. "
    "Flag any capability beyond what the declared role needs, a missing/empty room "
    "(an unscoped grant valid in EVERY room), an over-long TTL (a real-time join "
    "token should be minutes, not hours), and data-channel publish enabled for a "
    "pure consumer (a prompt-injection vector into the agent). If the grant is "
    "already least-privilege, return an empty findings list. Output JSON only."
)


def _norm(grant: dict) -> dict:
    """Coerce a proposed grant into a known shape (caps default false)."""
    return {
        "identity": str(grant.get("identity", "")).strip(),
        "room": str(grant.get("room", "")).strip(),
        "role": str(grant.get("role", "")).strip().lower(),
        "ttl": int(grant.get("ttl", 0) or 0),
        "caps": {c: bool(grant.get(c, False)) for c in CAPS},
    }


def _offline_audit(_system: str, user: str) -> str:
    """Deterministic rule-based auditor — the last-resort fallback. Returns the
    same JSON shape the LLM is asked for so downstream parsing is uniform.

    The proposed grant is passed as a JSON object on the final line of ``user``.
    """
    try:
        grant = json.loads(user.rsplit("\n", 1)[-1])
    except Exception:
        grant = {}
    g = _norm(grant)
    caps, role, room, ttl = g["caps"], g["role"], g["room"], g["ttl"]
    findings: list[dict] = []

    # 1. capability over-permission vs the declared role's intent.
    intent = ROLE_INTENT.get(role)
    if intent is not None:
        for cap in ("canPublish", "canPublishData", "canSubscribe"):
            if caps[cap] and not intent.get(cap, False):
                sev = "high" if cap == "canPublish" else "medium"
                if cap == "canPublishData":
                    sev = "high"  # a data-channel into the agent — injection vector
                findings.append({
                    "severity": sev,
                    "issue": f"role '{role}' is granted {cap} but its "
                             f"least-privilege template does not include it",
                    "recommendation": f"drop {cap} (mint from the '{role}' template)",
                })
    elif role:
        findings.append({
            "severity": "low",
            "issue": f"unknown role '{role}' — no least-privilege baseline to "
                     "audit against",
            "recommendation": "declare a known role (viewer/publisher/agent/"
                              "data_only) so caps can be checked",
        })

    # 2. data-channel publish for a pure consumer (no role, but a subscriber).
    if intent is None and caps["canPublishData"] and not caps["canPublish"]:
        findings.append({
            "severity": "high",
            "issue": "canPublishData enabled for a consumer — an inbound "
                     "data-channel is a prompt-injection vector into the agent",
            "recommendation": "disable canPublishData unless the holder must "
                              "send data",
        })

    # 3. missing room scope = a wildcard grant valid in every room.
    if not room:
        findings.append({
            "severity": "high",
            "issue": "no room scope — the grant is not bound to a room and is "
                     "valid in EVERY room",
            "recommendation": "scope the grant to a single room so it can't be "
                              "replayed elsewhere",
        })

    # 4. over-long TTL — a real-time join credential should be short-lived.
    if ttl >= TTL_HIGH:
        findings.append({
            "severity": "high",
            "issue": f"TTL is {ttl}s (≥{TTL_HIGH}s) — a day-long real-time "
                     "credential; a leak stays usable far too long",
            "recommendation": f"cut the TTL to minutes (default {token.DEFAULT_TTL}s)",
        })
    elif ttl > TTL_WARN:
        findings.append({
            "severity": "medium",
            "issue": f"TTL is {ttl}s (>{TTL_WARN}s) — longer than a real-time "
                     "join needs",
            "recommendation": f"shorten the TTL (default {token.DEFAULT_TTL}s)",
        })

    # 5. no roomJoin at all — a grant that can't actually join is misconfigured.
    if not caps["roomJoin"]:
        findings.append({
            "severity": "low",
            "issue": "roomJoin is not set — the grant cannot join the room",
            "recommendation": "set roomJoin if the holder is meant to join",
        })

    explanation = _explain(g)
    return json.dumps({"explanation": explanation, "findings": findings})


def _explain(g: dict) -> str:
    """One plain-English sentence describing what the grant allows."""
    granted = [w for c, w in _CAP_WORDS.items() if g["caps"][c]]
    who = g["identity"] or "the holder"
    where = f"room '{g['room']}'" if g["room"] else "ANY room (no room scope)"
    if not granted:
        does = "do nothing (no capabilities set)"
    elif len(granted) == 1:
        does = granted[0]
    else:
        does = ", ".join(granted[:-1]) + f", and {granted[-1]}"
    ttl = g["ttl"]
    window = (f"for {ttl}s" if ttl else "with no TTL set")
    role_note = f" (declared role: {g['role']})" if g["role"] else ""
    return f"This grant lets {who} {does} in {where}, {window}{role_note}."


def _parse(text: str) -> dict:
    """Best-effort JSON parse → validated {explanation, findings}."""
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    try:
        obj = json.loads(s[start:end + 1]) if start >= 0 else {}
    except Exception:
        obj = {}
    findings = []
    for f in obj.get("findings", []) if isinstance(obj, dict) else []:
        sev = str(f.get("severity", "")).lower()
        issue = str(f.get("issue", "")).strip()
        if issue and sev in SEVERITIES:
            findings.append({
                "severity": sev, "issue": issue,
                "recommendation": str(f.get("recommendation", "")).strip(),
            })
    return {
        "explanation": str(obj.get("explanation", "")).strip(),
        "findings": findings,
    }


def build_prompt(grant: dict) -> tuple[str, str]:
    """The (system, user) prompt pair sent to the LLM. Exposed so the browser→host
    Ollama bridge mirrors EXACTLY the prompt the server-side path uses."""
    g = _norm(grant)
    user = ("Audit this proposed real-time token grant against least privilege.\n"
            + json.dumps({**{c: g["caps"][c] for c in CAPS}, "identity": g["identity"],
                          "room": g["room"], "role": g["role"], "ttl": g["ttl"]}))
    return SYSTEM, user


def audit(grant: dict, *, mode: str | None = None,
          client_audit: dict | None = None) -> dict:
    """Audit a proposed grant via the routing chain. The LLM explains + judges;
    the offline rule auditor is the deterministic fallback (same shape).

    When ``client_audit`` is supplied, the BROWSER already ran the LLM call on the
    user's host Ollama (browser→host) and submitted the narration; the server skips
    its own LLM call and uses that explanation. The deterministic rule findings are
    still computed server-side — the LLM only narrates — so the audit's judgment is
    never weakened by an untrusted client.
    """
    g = _norm(grant)
    _system, user = build_prompt(grant)
    if client_audit is not None:
        # Browser→host Ollama narrated the grant; keep the deterministic findings.
        rule = json.loads(_offline_audit(_system, user))
        explanation = str(client_audit.get("explanation", "")).strip() or _explain(g)
        parsed = {"explanation": explanation, "findings": rule["findings"]}
        res = llm.LLMResult(text="", provider="ollama (browser→host)",
                            model="host", mode=mode or "local",
                            latency_ms=0, cost_usd=0.0, fallbacks=[])
    else:
        res = llm.complete(SYSTEM, user, offline=_offline_audit, mode=mode,
                           json_mode=True, max_tokens=700)
        parsed = _parse(res.text)
    if not parsed["explanation"]:
        parsed["explanation"] = _explain(g)
    sev_counts = {s: 0 for s in SEVERITIES}
    for f in parsed["findings"]:
        sev_counts[f["severity"]] += 1
    return {
        "grant": {**{c: g["caps"][c] for c in CAPS}, "identity": g["identity"],
                  "room": g["room"], "role": g["role"], "ttl": g["ttl"]},
        "explanation": parsed["explanation"],
        "findings": parsed["findings"],
        "finding_count": len(parsed["findings"]),
        "by_severity": sev_counts,
        "least_privilege": len(parsed["findings"]) == 0,
        "provider": res.provider, "model": res.model, "mode": res.mode,
        "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
        "fallbacks": res.fallbacks,
    }


# --------------------------------------------------------------------------- #
# Labeled eval set: each grant with the issue categories it should surface.    #
# Gold is the SET of issue tags a correct audit must flag (severity-agnostic). #
# --------------------------------------------------------------------------- #

# issue tags: cap_publish, cap_publishdata, cap_subscribe, no_room, ttl_long,
#             ttl_high, no_roomjoin, unknown_role, consumer_data
LABELED: list[dict] = [
    {
        "name": "clean viewer",
        "grant": {"identity": "alice", "room": "room-a", "role": "viewer",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True},
        "gold": set(),
    },
    {
        "name": "clean publisher",
        "grant": {"identity": "bob", "room": "room-a", "role": "publisher",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True,
                  "canPublish": True, "canPublishData": True},
        "gold": set(),
    },
    {
        "name": "viewer can publish (escalated)",
        "grant": {"identity": "eve", "room": "room-a", "role": "viewer",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True,
                  "canPublish": True},
        "gold": {"cap_publish"},
    },
    {
        "name": "viewer with data channel",
        "grant": {"identity": "eve", "room": "room-a", "role": "viewer",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True,
                  "canPublishData": True},
        "gold": {"cap_publishdata"},
    },
    {
        "name": "missing room scope (wildcard)",
        "grant": {"identity": "svc", "room": "", "role": "publisher",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True,
                  "canPublish": True, "canPublishData": True},
        "gold": {"no_room"},
    },
    {
        "name": "day-long TTL",
        "grant": {"identity": "alice", "room": "room-a", "role": "viewer",
                  "ttl": 86_400, "roomJoin": True, "canSubscribe": True},
        "gold": {"ttl_high"},
    },
    {
        "name": "hour-plus TTL",
        "grant": {"identity": "alice", "room": "room-a", "role": "viewer",
                  "ttl": 7200, "roomJoin": True, "canSubscribe": True},
        "gold": {"ttl_long"},
    },
    {
        "name": "kitchen-sink over-grant",
        "grant": {"identity": "eve", "room": "", "role": "viewer",
                  "ttl": 86_400, "roomJoin": True, "canSubscribe": True,
                  "canPublish": True, "canPublishData": True},
        "gold": {"cap_publish", "cap_publishdata", "no_room", "ttl_high"},
    },
    {
        "name": "consumer with inbound data channel (no role)",
        "grant": {"identity": "listener", "room": "room-a", "role": "",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True,
                  "canPublishData": True},
        "gold": {"consumer_data"},
    },
    {
        "name": "unknown role",
        "grant": {"identity": "x", "room": "room-a", "role": "superuser",
                  "ttl": 300, "roomJoin": True, "canSubscribe": True},
        "gold": {"unknown_role"},
    },
]

# Ordered (keyword, tag) rules; the FIRST match classifies a finding to one tag.
# Order matters: more specific phrasings precede the generic ones (e.g. the
# consumer data-channel and canPublishData rules precede the bare canPublish rule).
_TAG_RULES: list[tuple[str, str]] = [
    ("unknown role", "unknown_role"),
    ("consumer", "consumer_data"),
    ("inbound data-channel", "consumer_data"),
    ("no room", "no_room"),
    ("not bound to a room", "no_room"),
    ("every room", "no_room"),
    ("unscoped", "no_room"),
    ("canpublishdata", "cap_publishdata"),
    ("data-channel publish", "cap_publishdata"),
    ("canpublish", "cap_publish"),
    ("publish its own", "cap_publish"),
    ("cansubscribe", "cap_subscribe"),
    ("86400", "ttl_high"),
    ("day-long", "ttl_high"),
    ("ttl", "ttl_long"),
    ("roomjoin", "no_roomjoin"),
]


def _tag_one(finding: dict) -> str | None:
    """Classify a single finding to one issue tag (first matching rule wins).

    ``canpublishdata`` is masked before the ``canpublish`` test so a data-channel
    finding never also reads as a media-publish finding.
    """
    text = f"{finding['issue']} {finding['recommendation']}".lower()
    masked = text.replace("canpublishdata", "‹data›")
    for kw, tag in _TAG_RULES:
        probe = masked if tag == "cap_publish" else text
        if kw in probe:
            return tag
    return None


def _tags(findings: list[dict]) -> set[str]:
    """Map an audit's findings to the gold issue-tag vocabulary (best effort)."""
    tags = {t for t in (_tag_one(f) for f in findings) if t}
    # ttl_high implies the long-TTL family; don't double-count as ttl_long
    if "ttl_high" in tags:
        tags.discard("ttl_long")
    return tags


def evaluate(mode: str | None = None) -> dict:
    """Score the auditor over the labeled grant set: precision / recall on the
    issue categories it flags. A missed over-permission is the safety miss, so
    **recall is the security metric**."""
    tp = fp = fn = 0
    providers: set[str] = set()
    per_tag_fn: dict[str, int] = {}
    for case in LABELED:
        out = audit(case["grant"], mode=mode)
        providers.add(out["provider"])
        detected = _tags(out["findings"])
        gold = case["gold"]
        tp += len(detected & gold)
        fp += len(detected - gold)
        fn += len(gold - detected)
        for miss in gold - detected:
            per_tag_fn[miss] = per_tag_fn.get(miss, 0) + 1
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "grants": len(LABELED), "true_positives": tp, "false_positives": fp,
        "false_negatives": fn, "precision": round(precision, 3),
        "recall": round(recall, 3), "f1": round(f1, 3), "missed_by_tag": per_tag_fn,
        "providers_used": sorted(providers),
    }
