# relaytoken

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Go 1.23+](https://img.shields.io/badge/go-1.23+-00ADD8.svg)](https://go.dev)
[![go vet + gofmt](https://img.shields.io/badge/lint-vet%20%2B%20gofmt-00ADD8.svg)](https://pkg.go.dev/cmd/vet)
[![Token core: livekit/protocol](https://img.shields.io/badge/token%20core-livekit%2Fprotocol-1f6feb.svg)](https://github.com/livekit/protocol)

**[▶ Live demo](https://relaytoken.onrender.com)**

**Scoped, least-privilege access tokens for real-time (WebRTC) rooms, built on the
open-source `livekit/protocol` auth library — with an adversarial "breaker" suite
that proves the token model holds, an LLM-backed grant-risk linter, and a
documented WebRTC / voice-AI threat model.**

relaytoken is two halves in one service:

- a **builder** — mint a JWT room token from a vetted role template, then verify it
  against a required room + capability; and
- a **breaker** — a deterministic attack harness that forges, downgrades, tampers,
  replays, and expires tokens against the real verifier and asserts every attack is
  rejected (headline metric: `block_rate`, which a correct model scores at `1.00`).

It is built on the same library LiveKit itself uses for room tokens
(`github.com/livekit/protocol/auth`), so the token shape and verification are the
real thing, not a toy reimplementation.

> All keys, rooms, identities, and tokens here are **synthetic and clearly
> fictional**. The security core (mint / verify / adversary) never makes a network
> call; the LLM chain degrades to a deterministic explainer, so the service runs
> fully offline with zero keys.

---

## Contents

- [Why this shape](#why-this-shape)
- [Architecture](#architecture)
- [Web console](#web-console)
- [API reference](#api-reference)
- [Quickstart](#quickstart)
- [Security model & honest limits](#security-model-honest-limits)
- [Stack](#stack)

## Why this shape

A real-time platform's authorization story *is* its access token: a short-lived
JWT carrying a `VideoGrant` that says which **room** a participant may join and
what they may do there (publish media, subscribe, send on the data channel,
administer the room). Get that token model wrong — no room scope, a listener that
can publish, a 24-hour TTL, a payload an attacker can edit — and the media plane
is wide open. relaytoken demonstrates the token model *and* attacks it, so the
security property is shown, not asserted.

---

## Architecture

```
cmd/relaytoken/main.go            HTTP server + embedded web console + offline demo CLI
  └── internal/token              mint + verify (the trust-critical core)
  └── internal/adversary          the breaker suite (deterministic JWT surgery)
  └── internal/grant              deterministic grant-risk linter + LLM narration
  └── internal/threatmodel        the static, reviewable threat model
  └── internal/llm                multi-provider LLM router (Go port of the standard chain)
```

A single static Go binary on a distroless image, with no datastore — every request
is self-contained (a token is verified cryptographically, not looked up). The web
console is compiled into the binary via `//go:embed` and served at `/`. `main.go`
wires the HTTP mux, and the same binary run as `relaytoken demo` prints the whole
flow offline for CI/terminals.

### The token model (`internal/token`)

- **Roles are vetted least-privilege templates**, never hand-assembled capability
  sets. `Mint` accepts a *role* (`subscriber` | `publisher` | `admin`) + a room +
  identity; the `VideoGrant` is derived from the role:
  - `subscriber` → join + subscribe only (a listener; no publish, no data).
  - `publisher` → join + subscribe + publish + data.
  - `admin` → the above + `RoomAdmin`.
- **Every token is room-scoped.** `Mint` refuses an empty room — a scope-less token
  ("valid in every room") is the single most dangerous over-grant.
- **TTLs are clamped** to `[1m, 12h]` with a `1h` default; over-long lifetimes are
  the most common real-world over-grant and the widest replay window.
- The token is a **JWT (HS256)**; the signing secret never leaves the server and is
  never embedded in a token.

### Verification (`internal/token` — `Verify`)

`Verify` is defense-in-depth and re-asserts everything at the point of use:

1. **Signature + temporal claims** via the upstream `livekit/protocol` verifier —
   HMAC under the server secret, `exp` (expiry) and `nbf` (not-before). `alg=none`
   is never honored.
2. **Room scope** — a cryptographically valid token is still rejected if its
   `VideoGrant.Room` doesn't match the required room, or if it carries no room
   scope at all.
3. **Required capability** — the verifier requires the specific capability the
   caller needs (`join` | `publish` | `subscribe` | `publishData` | `admin`); a
   valid token that doesn't confer it is rejected.

A valid signature is necessary but not sufficient: scope and capability are
enforced server-side, so a leaked or replayed token only works for exactly what it
was issued for.

### The breaker suite (`internal/adversary`)

`Run()` mints a legitimate publisher token, then attacks it through the **public**
verify path only (so it proves the property an attacker actually faces). Eight
cases, each asserted to be **rejected**:

| # | Case | Attack | Why it's blocked |
|---|---|---|---|
| 1 | `forged_signature` | re-sign with an attacker secret | HMAC fails under the server secret |
| 2 | `alg_none_downgrade` | set header `alg=none`, drop the signature | verifier requires a real HS256 signature |
| 3 | `expired` | a correctly signed token past its `exp` | expiry enforced |
| 4 | `not_yet_valid_nbf` | a signed token with future `nbf` | not-before enforced |
| 5 | `cross_room_replay` | a valid room-alpha token replayed at room-beta | room-scope mismatch |
| 6 | `capability_escalation` | edit the payload to add `canPublish`/`roomAdmin`, keep the sig | payload tamper breaks the signature |
| 7 | `least_privilege_publish` | a subscriber-only token claims `publish` | grant doesn't include publish |
| 8 | `malformed_token` | a truncated, non-JWT string | doesn't parse |

`block_rate = blocked / total` — a correct token model scores `1.00` (8/8). The
attack constructions (`alg=none` rewrite, payload flip, re-sign, expired/nbf
signing) are deterministic JWT surgery, so the suite is reproducible and CI-safe.

### Grant-risk linter (`internal/grant`)

Given a *proposed* grant (before it is signed), `Lint` runs deterministic
least-privilege checks and emits findings + a `risk_score` (0–100):

- **`no_room_scope`** (high) — valid in every room.
- **`subscriber_can_publish`** (high) — a listener template granted publish.
- **`subscriber_data_channel`** (medium) — a listener with data-channel publish is
  a **prompt-injection surface into a voice-AI agent**.
- **`unexpected_room_admin`** (high) — admin on a non-admin role.
- **`no_ttl` / `over_long_ttl`** (medium) — standing-credential / wide-replay risks.

`Lint` is the source of truth. `Explain` then asks the **LLM router** to narrate
the findings in plain English (concise, no invented findings); with no provider
configured it falls back to a deterministic explanation. The model never overrides
the rule checker — only the prose comes from it.

### Threat model (`internal/threatmodel`)

Eight reviewable entries mapping a WebRTC / realtime-AI threat → vector →
mitigation → the concrete control in this service: data-channel prompt injection
(TM-1), egress/recording exposure (TM-2), SFU/signaling trust abuse (TM-3),
cross-room replay (TM-4), capability escalation (TM-5), long-lived/stolen token
replay (TM-6), join-flood DoS (TM-7), and token-mint abuse (TM-8).

### LLM router (`internal/llm`)

A Go port of the portfolio's standard chain — paid (Anthropic / OpenAI) → local
(Ollama) → free (OpenRouter) → deterministic offline — used only to narrate grant
findings. The app runs fully with zero keys (the offline fallback is always
terminal).

---

## Web console

Served at `/` (embedded in the binary). It drives every endpoint live: mint a
scoped token and inspect the decoded grant, verify it (including a cross-room
replay that denies), run the breaker suite and watch the `block_rate`, lint a
proposed grant and read the LLM explanation, and browse the threat model. It
carries the shared portfolio chrome — light/dark, glass surfaces, help, the
project launcher (⌘K / G), and the browser→host Ollama model picker.

---

## API reference

Base URL: `http://127.0.0.1:8080` locally; the Render deployment uses its assigned
host. All bodies are JSON.

### `POST /token/mint`
```json
{ "role": "publisher", "room": "room-alpha", "identity": "alice", "ttl_seconds": 3600 }
```
→ `{ "token": "<jwt>", "grant": { "role", "identity", "room", "room_join",
"room_admin", "can_publish", "can_subscribe", "can_publish_data", "ttl",
"expires_at" } }`

### `POST /token/verify`
```json
{ "token": "<jwt>", "room": "room-alpha", "capability": "publish" }
```
→ `200 { "valid": true, "why": "ok", "grant": {…} }` or `401 { "valid": false,
"why": "room mismatch: token scoped to \"room-alpha\", required \"room-beta\"" }`

### `GET /adversary`
→ `{ "cases": [{ "name", "attack", "expected", "blocked", "detail" }], "total",
"blocked", "block_rate" }`

### `POST /grant/lint`
```json
{ "role": "subscriber", "room": "", "can_publish": true, "can_subscribe": true,
  "can_publish_data": true, "room_admin": false, "ttl_seconds": 86400 }
```
→ `{ "allows": [...], "findings": [{ "severity", "code", "message" }],
"risk_score": 0-100, "least_priv": false, "explanation": "...", "provider": "..." }`

### `GET /threat-model`
→ `{ "threat_model": [{ "id", "threat", "vector", "mitigation", "control" }] }`

### `GET /healthz` · `GET /llm`
`/healthz` → `{ status, service, token_core, roles }`. `/llm` → provider/router
status. **Status codes:** `200` ok · `400` invalid body · `401` token invalid ·
`405` wrong method.

---

## Quickstart

```bash
./run.sh demo      # offline: mint → verify → breaker suite → grant lint → threat model
./run.sh serve     # HTTP server + console at http://127.0.0.1:8080
./run.sh test      # go test ./...
./run.sh check     # vet + test
```

`RELAYTOKEN_API_KEY` / `RELAYTOKEN_API_SECRET` override the demo signing keys; set
a provider key (e.g. `ANTHROPIC_API_KEY`) or run host Ollama to get a live LLM
grant explanation instead of the offline narration.

---

## Security model & honest limits

- **Trust-critical paths are deterministic.** Minting derives grants from vetted
  role templates; verification enforces signature + expiry + room scope +
  capability. The LLM only narrates the linter; it can never change a verdict.
- **The breaker suite uses only the public verify path**, so `block_rate` reflects
  the property an attacker actually faces, not an internal shortcut.
- **Symmetric (HS256) signing**, matching the LiveKit default. Production at scale
  would add key rotation / per-environment secrets and consider asymmetric signing
  for multi-issuer setups.
- **Stateless verification** means no revocation list — revocation is by short TTL
  (and minting per session). A revocation / JTI denylist is a natural extension.
- **Rate limiting on mint/join (TM-7, TM-8) is out of scope for the token service**
  and belongs at the signaling / edge tier; the threat model says so explicitly.
- Signing keys, identities, and rooms in the demo are synthetic.

## Stack

Go (stdlib `net/http`) · `github.com/livekit/protocol/auth` (JWT / HS256
`VideoGrant`) · deterministic adversarial suite · multi-provider LLM router
(Anthropic / OpenAI → Ollama → OpenRouter → offline) · browser→host Ollama ·
embedded zero-build console · distroless Docker / Render.
