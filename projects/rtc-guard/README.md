# rtc-guard

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

![rtc-guard token console](docs/screenshot.png)

**[▶ Live demo](https://rtc-guard.onrender.com)**

Scoped real-time (WebRTC) access tokens, an adversarial test suite that tries to
break them, and an AV-pipeline threat model — the security layer under a voice
agent. **Builder and breaker:** the builder mints least-privilege signed grants;
the breaker forges, replays, escalates, and downgrades them and proves each
attack fails. The security core is offline, deterministic, and needs no secrets,
so it runs as the live demo; the voice agent is a documented self-host sample.

One thing the deterministic core can't do, and where the LLM earns its keep:

- **Grants aren't always minted from a clean template.** A service stitches a
  grant together by hand, a role drifts, a TTL gets bumped "for debugging," a room
  scope is dropped. A **least-privilege grant auditor** reads a *proposed* grant,
  **explains in plain English exactly what it allows**, and **flags the
  over-permissioning** (a viewer that can publish, a missing room scope = wildcard,
  an over-long TTL, a data-channel into the agent). The model does the explanation
  and the judgment; it routes **Anthropic/OpenAI → local Ollama → free (OpenRouter)
  → a deterministic rule-based auditor**, so it runs (and the eval reproduces) with
  zero keys, and the security core (mint/verify, the adversarial suite) is never
  touched by this review layer.

> Synthetic, offline-first, no secrets. The auditor *reviews* proposed grants; it
> never weakens a minted one. The live demo runs the deterministic path (no
> provider keys on the public host).

## Architecture

| Module | Responsibility |
|---|---|
| `token.py` | Hand-rolled HS256 JWT `encode`/`decode`; `mint` (least-privilege grant), `verify` (signature, window, room, optional single-use), `can` (capability check). Stdlib only. |
| `adversary.py` | Constructs 8 concrete attacks against `token.py`, asserts each is blocked, returns a `block_rate`. |
| `threat_model.py` | 8 AV-path threats, each mapped to a mitigation and the control that demonstrates it. |
| `grant_audit.py` | LLM-assisted least-privilege auditor: explains a proposed grant + flags over-permissioning; precision/recall eval. Deterministic rule-based fallback. |
| `llm.py` | Multi-provider routing (paid → local → free → deterministic offline), stdlib HTTP. |
| `evaluate.py` | Reproducible eval → `eval-report.md` (`./run.sh eval`). |
| `api.py` | FastAPI service: mint, verify, run the suite, audit grants, serve the threat model + token console. |
| `samples/voice_agent.py` | Self-host voice-agent reference (mic→STT→LLM→TTS) that mints a scoped agent token and firewalls data-channel input. |

### Token structure

A token is the classic three-part JWT, `header.payload.signature`, each part
base64url-encoded (no padding):

```
header     {"alg":"HS256","typ":"JWT"}
payload    {"iss","sub","iat","nbf","exp","jti","video":{ …grant… }}
signature  HMAC-SHA256( base64url(header) + "." + base64url(payload), key )
```

The `video` claim is the signed grant — the room plus the capability flags:

```
"video": { "room": "room-a", "roomJoin": true,
           "canSubscribe": true, "canPublish": false, "canPublishData": false }
```

Because the signature covers `header.payload`, the room and every capability
flag are inside the signed bytes. Flip any of them and the signature no longer
matches.

```
  identity, room, template, ttl
            │
            ▼
        ┌────────┐   header.payload.signature   ┌──────────┐
  mint  │ encode │ ───────────────────────────► │  verify  │
        └────────┘   (HS256 over header+payload) └──────────┘
            │                                          │
   grant from template                       sig ✓ · nbf ≤ now < exp ·
   + iat/nbf/exp + jti                        roomJoin · room scope ·
                                              optional jti single-use
                                                       │
                                                       ▼
                                               { valid, reason, claims }
```

### Grant templates

`mint` never takes raw capability flags from the caller — it takes a **template
name**, and the template fixes the least-privilege capability set:

| Template | roomJoin | canSubscribe | canPublish | canPublishData |
|---|---|---|---|---|
| `viewer` | ✓ | ✓ | — | — |
| `publisher` | ✓ | ✓ | ✓ | ✓ |
| `agent` | ✓ | ✓ | ✓ | ✓ |
| `data_only` | ✓ | ✓ | — | ✓ |

A `viewer` can watch and listen but never publish media or data; `data_only`
adds the data channel without media publish; `publisher` and `agent` are the
full-participant set. An unknown template name is rejected with `ValueError`.

### mint

`mint(identity, room, template, ttl, key, now)` looks up the template, builds the
grant as `{"room": room, **template_caps}`, and wraps it in a claim set:
`iss="rtc-guard"`, `sub=identity`, `iat=nbf=now`, `exp=now+ttl`
(default TTL **300 s**), and a `jti` of `f"{int(now)}-{seq:06d}"` from a
process-local counter, giving every token a distinct nonce. The whole thing is
`encode`d under the HS256 signing key. `now` is injectable so the suite and tests
run against a fixed clock.

### verify

`verify(token, key, expected_room, now, jti_store)` returns
`{valid, reason, claims}` and short-circuits on the first failure:

1. `decode` — split into 3 parts, recompute the HMAC, **constant-time compare**
   (`hmac.compare_digest`) against the presented signature; bad signature or a
   malformed token raises and is reported.
2. **Validity window** — reject if `now < nbf` (not yet valid) or `now ≥ exp`
   (expired).
3. **roomJoin** — reject if the grant lacks `roomJoin`.
4. **Room scope** — if `expected_room` is given, the grant's `room` must equal it.
5. **Single-use** — if a `jti_store` set is supplied, a `jti` already present is a
   replay and is rejected; otherwise the `jti` is recorded.

`can(claims, capability)` is the per-action check at use time, e.g.
`can(claims, "canPublish")` — it reads the flag straight out of the signed grant.

## The adversarial suite

`adversary.run()` constructs eight concrete attacks against `token.py` on a fixed
clock and asserts each is blocked, returning the `block_rate` (`/adversary` in the
API). This is the breaker half: not "we issue tokens" but "here is everything I
tried to forge, replay, or escalate, and exactly why it failed."

| # | Attack | Why it fails |
|---|---|---|
| 1 | Expired token reused | `now ≥ exp` — outside the validity window. |
| 2 | Token used before `nbf` | `now < nbf` — not yet valid. |
| 3 | Payload tampered to escalate (`canPublish→true`, original signature kept) | Signature is over `header.payload`; the edited payload no longer matches. |
| 4 | Forged signature (re-signed with an attacker key) | HMAC under the real key doesn't match the attacker's signature. |
| 5 | `alg=none` strip (header swapped to `none`, signature dropped) | `decode` always recomputes HS256; an empty signature fails the compare — `alg=none` is never honored. |
| 6 | Cross-room replay (room-a token presented to room-b) | Room is in the signed grant; `expected_room` mismatch. |
| 7 | Single-use replay (same token verified twice with a `jti_store`) | The `jti` is already in the store on the second use. |
| 8 | Capability confinement (a `viewer` tries to publish) | The `viewer` grant carries `canPublish=false`; `can()` returns false. |

The common thread: the **signature covers the entire grant**, the **TTL/`nbf`
window** bounds when a token is usable, the **room and capabilities live inside
the signed bytes**, the optional **`jti`** makes a token single-use, `alg=none`
is **never** trusted, and least-privilege templates **confine** what any grant
can do.

## Design decisions

- **Least-privilege grant templates.** Callers pick a role, not a flag set, so a
  token can only ever carry the capabilities that role needs. The blast radius of
  a leaked token is bounded by its template.
- **Short TTL + `nbf` + `jti`.** Default 300 s caps how long a leaked credential
  is useful; `nbf` rejects tokens presented before their window; the `jti` nonce
  enables optional single-use verification against a replay store.
- **Hand-rolled HS256, stdlib only (no PyJWT).** The signing/verifying path is
  ~10 lines of `hmac`/`hashlib`/`base64` you can read end to end — and it makes
  the security-critical choices explicit: verification **always recomputes** the
  HMAC and compares it **constant-time** with `hmac.compare_digest` (no timing
  oracle), and it **never** branches on the header's `alg`, so an `alg=none`
  downgrade can't strip the check. The cost: HS256 is a symmetric, demo-grade
  primitive — see "what changes for prod."
- **Security core is the shippable demo; the voice agent is a sample.** Mint /
  verify / adversarial suite / threat model are offline, deterministic, and
  secret-free, so they run as the hosted demo. `samples/voice_agent.py` needs a
  real-time server plus STT/LLM/TTS keys, so it is an opt-in self-host reference,
  not part of the hosted demo.
- **Responsible scope.** The demo signs with a clearly-labeled demo key
  (`RTC_GUARD_SIGNING_KEY` overrides it) and mints only throwaway tokens against
  rooms that don't exist — nothing real to leak.

**What changes for production.** Move to an asymmetric signature (**RS256 /
EdDSA**) with **JWKS key rotation** so verifiers never hold the signing secret;
add **revocation** (a deny-list or short-lived refresh) for credentials that must
die before `exp`; and **rate-limit minting** with per-identity caps so token
issuance itself can't be abused into a join flood.

## Threat model

The threat model lives in code (`threat_model.py`, served at `/threat-model`), so
it can be rendered and diffed instead of rotting in a doc. Eight threats on the
human↔AI audio/video path — access-token replay, grant escalation/forgery, room
hijack / cross-room replay, media eavesdropping, recording/egress exposure,
**data-channel prompt injection into the agent**, SFU/signaling trust, and
join-flood DoS — each mapped to a mitigation and the control that demonstrates
it. The prompt-injection entry is the AV-specific one: data-channel input is
treated as untrusted and firewalled before it reaches the LLM, and the data
capability is itself grant-gated (`canPublishData`).

## LLM grant auditor

Minting is least-privilege *by template* — but real systems don't always mint
from a clean template. `POST /grant/audit` takes a **proposed** grant (identity,
room, role, capability flags, TTL) and runs it through the routing chain:

```
proposed grant {identity, room, role, ttl, roomJoin, canSubscribe,
                canPublish, canPublishData}
   │
   ▼ llm.complete(SYSTEM, grant_json, json_mode)
       Anthropic / OpenAI → Ollama → OpenRouter → deterministic rule auditor
   │
   ▼ { explanation: "<plain-English: exactly what this grant allows>",
       findings: [ { severity: high|medium|low, issue, recommendation } ] }
   │
   ▼ deterministic post-processing: per-severity counts, least_privilege flag
```

The deterministic offline auditor compares the requested capabilities against the
least-privilege template for the declared role and flags any extra, plus a missing
room scope (a wildcard grant valid in every room), an over-long TTL (a real-time
join credential should be minutes, not hours — `>1h` medium, `≥24h` high), and a
consumer with an inbound data-channel (`canPublishData` without `canPublish` — a
prompt-injection vector into the agent). It returns the **same JSON shape** the
model is asked for, so the demo and the eval reproduce with zero keys; the LLM
path is what generalizes to free-form grants and writes the explanation. **The
auditor only reviews a proposed grant — it never mints or weakens a real one**, so
the security core (`token.py`, `adversary.py`) stays deterministic and untouched.

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain, identical in shape to
the other demos: a provider is *available* only when its key is set (or, for
Ollama, when a probe to `/api/tags` succeeds), so the chain self-selects from the
environment and `complete()` returns the first success, recording which providers
it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic rule-based auditor only |

`GET /llm` reports which providers are reachable and the active mode. The offline
auditor is always terminal, so the service never fails for lack of a key — it
degrades to deterministic, not to an error.

## Evals

`./run.sh eval` (or `GET /evals`) scores the grant auditor over a labeled set of
synthetic grants and writes `eval-report.md`. Each grant is labeled with the issue
categories a correct audit must surface (over-permissioned capability, missing room
scope, over-long TTL, consumer data-channel, unknown role); scoring is on those
categories. **Recall is the security metric** — a missed over-permission is the
safety miss.

| metric | offline auditor |
|---|---|
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| false negatives (missed findings) | 0 |

The report also re-runs the adversarial suite, so the enforcement posture
(**8/8 blocked**) is a reproducible number alongside the auditor's. Set provider
keys or `LLM_MODE` to score a live model on the same labeled set.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, template + threat counts |
| GET | `/templates` | the least-privilege grant templates |
| POST | `/v1/token` | mint a scoped token → token + decoded grant |
| POST | `/v1/verify` | verify signature / TTL / room scope → valid + reason |
| GET | `/adversary` | run the adversarial suite (every attack blocked) |
| GET | `/threat-model` | the AV-pipeline threat model |
| POST | `/grant/audit` | LLM-assisted least-privilege audit of a proposed grant |
| GET | `/evals` | grant-auditor precision/recall over the labeled set |
| GET | `/llm` | configured/reachable providers + active routing mode |
| GET | `/sample/voice-agent` | the self-host voice-agent reference |

`POST /v1/token` body:
`{ "identity": "alice", "room": "room-a", "template": "publisher", "ttl": 300 }`.
`POST /grant/audit` body: `{ "identity": "eve", "room": "", "role": "viewer",
"ttl": 86400, "roomJoin": true, "canSubscribe": true, "canPublish": true,
"canPublishData": true }`; optional `"mode"` pins the routing tier.

## Code map

```
src/rtc_guard/
  token.py        hand-rolled HS256 JWT: encode/decode, mint (least-privilege), verify, can
  adversary.py    8 concrete attacks against token.py → block_rate
  threat_model.py 8 AV-path threats → mitigation + the control that demonstrates it
  grant_audit.py  LLM least-privilege auditor (explain + flag) + deterministic rule fallback + eval
  llm.py          multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py     ./run.sh eval → eval-report.md
  api.py          FastAPI service; models.py request models; static/ token console UI
samples/
  voice_agent.py  self-host voice-agent reference that mints a scoped agent token
tests/            unit (token, adversary, threat, grant_audit, llm, api) + live smoke
```

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
rule-based auditor; the token core needs no keys regardless). Set any of these to
route the grant auditor to a real model; never commit real keys, and leave them
unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |
| `RTC_GUARD_SIGNING_KEY` | HS256 demo signing key for mint/verify (not a real secret) |

## Quickstart

```sh
cd projects/rtc-guard
./run.sh setup
./run.sh demo            # offline: mint + verify + adversarial suite + grant audit
./run.sh eval            # grant-auditor precision/recall + block rate → eval-report.md
./run.sh serve           # token console at http://127.0.0.1:8013
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed
on Render's free tier — the same image runs anywhere. **No provider keys are set
on the public host**, so the live demo runs the deterministic offline auditor; the
LLM chain activates wherever keys/Ollama are present. Free instances cold-start in
~30–50s.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
