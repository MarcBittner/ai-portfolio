# relaytoken

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Go 1.23+](https://img.shields.io/badge/go-1.23+-00ADD8.svg)](https://go.dev)
[![go vet + gofmt](https://img.shields.io/badge/lint-vet%20%2B%20gofmt-00ADD8.svg)](https://pkg.go.dev/cmd/vet)
[![Token core: livekit/protocol](https://img.shields.io/badge/token%20core-livekit%2Fprotocol-1f6feb.svg)](https://github.com/livekit/protocol)

**[▶ Live demo](https://relaytoken.onrender.com)**

A Go HTTP service that **issues and verifies scoped real-time room access tokens**
for WebRTC voice-AI infrastructure — and then **attacks its own token model** to
prove it holds. Tokens are JWTs carrying granular publish/subscribe/admin
capabilities, bound to a single room, with customizable, clamped TTLs, minted on
the open-source **[`livekit/protocol`](https://github.com/livekit/protocol) `auth`**
package — the de-facto standard WebRTC room-token library.

It is a **builder + breaker** reference:

- **Builder.** `/token/mint` derives a least-privilege grant from a vetted role
  template (`publisher` / `subscriber` / `admin`), scopes it to a room, and clamps
  the TTL. `/token/verify` checks the signature and expiry *and* re-asserts the
  room scope and the required capability — a cryptographically valid token that
  does not cover the requested room or capability is still rejected.
- **Breaker.** `/adversary` runs a deterministic suite of eight token abuses —
  forged signature, `alg=none` downgrade, expired, not-yet-valid (nbf),
  cross-room replay, capability escalation, least-privilege violation, malformed —
  through the *public* verify path and asserts every one is blocked
  (`block_rate == 1.0`).
- **Advisory.** `/grant/lint` is an **LLM-backed grant risk explainer**: a
  deterministic rule checker finds over-permissioning (a subscriber that can
  publish, a missing room scope = valid in every room, an over-long TTL, a
  data-channel prompt-injection surface into the AI agent), and the LLM narrates
  it in plain English — with a deterministic offline fallback so it runs with zero
  keys.

> All keys, rooms, identities, and tokens here are **synthetic and clearly
> fictional**. No secrets; the service runs fully offline — the security core
> (mint / verify / adversary) never makes a network call, and the LLM chain
> degrades to a deterministic explainer.

## Architecture

A small, layered Go service. The security core is deterministic and self-
contained; the LLM is an advisory layer with an always-terminal offline path.

| Package | Responsibility |
|---|---|
| `internal/token` | role templates → `VideoGrant`; mint (`auth.NewAccessToken`) + verify (signature/expiry via the upstream verifier, then room + capability re-assertion); TTL clamping |
| `internal/adversary` | the breaker suite: deterministic JWT surgery for eight attacks, all through the public verify path; reports `block_rate` |
| `internal/grant` | deterministic over-permissioning rule checker + LLM narration (offline fallback) |
| `internal/threatmodel` | static WebRTC / realtime-AI threat → mitigation → control table |
| `internal/llm` | multi-provider router (paid → local → free → deterministic offline), net/http only |
| `cmd/relaytoken` | net/http service, the `demo` CLI, and the container `healthcheck` |

## Token model & grant table

A token is an HS256 JWT whose claims carry a `VideoGrant`. Minting accepts only a
**role template** plus a room and TTL — never a raw capability set from the caller
— so a client cannot mint a grant the template does not permit.

| Role | RoomJoin | CanPublish | CanSubscribe | CanPublishData | RoomAdmin |
|---|---|---|---|---|---|
| `subscriber` (listener) | ✓ | — | ✓ | — | — |
| `publisher` | ✓ | ✓ | ✓ | ✓ | — |
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ |

Every token is bound to exactly one `room`. TTL is clamped to **`[1m, 12h]`**
(default `1h`): a token with no TTL is a standing credential, and a long TTL widens
the replay/leak window.

## Mint → verify lifecycle

```
POST /token/mint  {role:"publisher", room:"room-alpha", identity:"alice", ttl_seconds:3600}
   │
   ├─ grantForRole(publisher, room-alpha)   → VideoGrant{RoomJoin, Room, CanPublish, CanSubscribe, CanPublishData}
   ├─ clampTTL(3600s)                        → 1h   (default 1h, min 1m, max 12h)
   ├─ auth.NewAccessToken(key, secret).SetVideoGrant(grant).SetValidFor(ttl).ToJWT()
   └─ → { token: "eyJ…", grant: {role, room, can_publish, …, expires_at} }

POST /token/verify  {token:"eyJ…", room:"room-alpha", capability:"publish"}
   │
   ├─ auth.ParseAPIToken(token)              → structure
   ├─ verifier.Verify(secret)                → HS256 signature + issuer + exp/nbf
   ├─ re-assert room scope                   → token.Room == required room (and not empty)
   ├─ re-assert capability                   → grant grants the required capability
   └─ → { valid: true, why: "ok", grant: {…} }     // else { valid:false, why:"…" }
```

The same publisher token replayed against `room-beta` returns
`valid:false, why:"room mismatch: token scoped to \"room-alpha\", required \"room-beta\""`.

## Adversary suite

`GET /adversary` mints a legitimate token, then runs eight attacks through the
public verify path. Each must be **rejected**; the headline number is `block_rate`.

| # | Attack | What the adversary does | Expected |
|---|---|---|---|
| 1 | `forged_signature` | re-signs a valid token with an attacker HS256 secret | reject: HMAC fails under the server secret |
| 2 | `alg_none_downgrade` | sets header `alg=none`, drops the signature | reject: verifier requires a real HS256 signature |
| 3 | `expired` | signs a token with `exp` in the past | reject: token past expiry |
| 4 | `not_yet_valid_nbf` | signs a token with `nbf` in the future | reject: token not yet valid |
| 5 | `cross_room_replay` | replays a room-alpha token against room-beta | reject: room scope mismatch |
| 6 | `capability_escalation` | flips `canPublish`/`roomAdmin` in the payload, keeps the sig | reject: payload tamper breaks the signature |
| 7 | `least_privilege_publish` | uses a subscriber token to claim publish | reject: grant has no publish |
| 8 | `malformed_token` | presents a truncated, non-JWT string | reject: does not parse |

```
block_rate = 1.00  (8/8 blocked)
```

The same suite is asserted in `internal/adversary/adversary_test.go`: every case
must be blocked and `block_rate == 1.0`, so a regression that weakens the token
model fails the test, not just the demo.

## Threat model

`GET /threat-model` serves a WebRTC / realtime-AI threat → mitigation → control
table.

| ID | Threat | Control in this service |
|---|---|---|
| TM-1 | **Data-channel prompt injection** into the voice-AI agent | subscribers default `canPublishData=false`; the linter flags a listener with data-channel publish |
| TM-2 | Egress / recording exposure | tokens carry only a `VideoGrant`, no storage credentials; upstream refuses sensitive credentials in client tokens |
| TM-3 | SFU / signaling trust abuse | every token's HS256 signature verified server-side; forged / `alg=none` / tampered tokens all rejected |
| TM-4 | Cross-room replay | every token room-scoped; verify rejects mismatch and refuses scope-less tokens |
| TM-5 | Capability escalation | capabilities live in the signed grant; any payload edit breaks verification |
| TM-6 | Long-lived / stolen token replay | TTL clamped to `[1m, 12h]`, default 1h; linter flags missing/over-long TTLs |
| TM-7 | **Join-flood / connection DoS** | per-room, short-TTL, role-scoped tokens; rate limiting at the signaling tier |
| TM-8 | **Token-mint abuse / rate-limiting** | mint accepts only a role template + room, never arbitrary capabilities |

## Grant linter

`POST /grant/lint` takes a proposed grant and returns what it allows, a list of
over-permissioning findings against the least-privilege templates, a risk score,
and a plain-English explanation. The **rule checker is the source of truth** and
the offline fallback; the LLM only narrates it.

```
POST /grant/lint
  { "role":"subscriber", "room":"", "can_publish":true,
    "can_subscribe":true, "can_publish_data":true, "ttl_seconds":86400 }

→ allows:  ["subscribe to media", "publish media (mic/camera)", "publish on the data channel"]
  findings:
    [high]   no room scope set: valid in EVERY room, not one. Bind it to a single room.
    [high]   role is 'subscriber' but the grant allows publishing — drop canPublish.
    [medium] a listener with data-channel publish can inject messages the AI agent
             may treat as instructions (prompt injection). Restrict canPublishData.
    [medium] TTL of 24h0m0s exceeds the 12h ceiling — shorten it.
  risk_score: 100   least_priv: false   provider: offline
```

## Routing

`internal/llm` is the portfolio-standard chain, identical in shape to the other
demos: a provider is *available* only when its key is set (or, for Ollama, when a
probe to `/api/tags` succeeds), so the chain self-selects from the environment and
`Complete()` returns the first success, recording which providers it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic narrator only |

`GET /llm` reports which providers are reachable and the active mode. The offline
function is always terminal, so the grant explainer never fails for lack of a key —
it degrades to a deterministic explanation, not to an error. The security core
(mint / verify / adversary) does not use the LLM at all.

## Code map

```
cmd/relaytoken/
  main.go            net/http service + endpoints; `demo` CLI; `healthcheck` subcommand
internal/
  token/             role templates → VideoGrant; mint + verify; TTL clamp        (+ token_test.go)
  adversary/         8-attack breaker suite via the public verify path; block_rate (+ adversary_test.go)
  grant/             deterministic over-permissioning linter + LLM narration       (+ grant_test.go)
  threatmodel/       static WebRTC / realtime-AI threat → mitigation → control table
  llm/               multi-provider router (paid → local → free → offline), net/http (+ llm_test.go)
docs/spec/           spec.md + development-plan.md
```

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
narrator; the token core needs no network). Set any of these to route the grant
explanation to a real model; never commit real keys, and leave them unset on a
public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |
| `RELAYTOKEN_API_KEY` / `RELAYTOKEN_API_SECRET` | HS256 mint/verify signing key (demo default; set a real secret in prod) |
| `PORT` | HTTP port (default 8080) |

## Quickstart

```sh
cd projects/relaytoken
./run.sh setup           # go mod download
./run.sh demo            # offline: mint → verify → adversary 8/8 → grant lint → threat model
./run.sh test            # go test ./...
./run.sh lint            # go vet + gofmt check
./run.sh run             # serve on http://127.0.0.1:8080
```

```sh
# mint, then verify
curl -s localhost:8080/token/mint -d '{"role":"publisher","room":"room-alpha","identity":"alice","ttl_seconds":3600}'
curl -s localhost:8080/token/verify -d '{"token":"<jwt>","room":"room-alpha","capability":"publish"}'
curl -s localhost:8080/adversary           # block_rate should read 1.0
```

## Deploy

Containerized (`Dockerfile`, multi-stage `golang:1.26` builder → `distroless/static`
runtime, non-root, `PORT` env, `/healthz` via a `healthcheck` subcommand) and
deployed on Render's free tier — the same static binary runs anywhere. **No
provider keys are set on the public host**, so the live grant explainer runs the
deterministic offline path; the security core is identical with or without keys.
Free instances cold-start in ~30–50s.

Proprietary, offline-first, no secrets, synthetic data only. Built on the
open-source `livekit/protocol` token library; **company-neutral** by design. Spec
in `docs/spec/`.
