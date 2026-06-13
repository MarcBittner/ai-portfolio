# relaytoken — spec

## Purpose

A Go HTTP service that issues and verifies **scoped real-time room access tokens**
for WebRTC voice-AI infrastructure, plus an **adversarial breaker suite** that
proves the token model resists abuse, plus an **LLM-backed grant risk explainer**.
It is a "builder + breaker" reference: the builder mints least-privilege,
room-scoped, TTL-bounded tokens; the breaker tries to forge, downgrade, replay,
and escalate them and shows every attempt is rejected.

## Token model

A token is a JWT (HS256) carrying a `VideoGrant` from the open-source
`livekit/protocol` `auth` package — the de-facto standard WebRTC room-token
library. Tokens are minted from vetted **role templates**, never from a raw
capability set supplied by a caller.

| Role | RoomJoin | CanPublish | CanSubscribe | CanPublishData | RoomAdmin |
|---|---|---|---|---|---|
| `subscriber` | yes | no | yes | no | no |
| `publisher` | yes | yes | yes | yes | no |
| `admin` | yes | yes | yes | yes | yes |

Every token is bound to exactly one `room` and a TTL clamped to `[1m, 12h]`
(default `1h`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/token/mint` | mint a token from a role template, room, identity, ttl_seconds |
| POST | `/token/verify` | verify a token against a required room + capability |
| GET | `/adversary` | run the breaker suite; return the case table + `block_rate` |
| GET | `/threat-model` | the WebRTC / realtime-AI threat → mitigation → control table |
| POST | `/grant/lint` | LLM-backed grant risk explainer (deterministic rule core + offline narration) |
| GET | `/healthz` | liveness + service metadata |
| GET | `/llm` | configured/reachable LLM providers + active routing mode |

## Adversary suite (each asserts REJECTED)

1. forged signature (re-signed with attacker secret)
2. `alg=none` downgrade
3. expired (`exp` in the past)
4. not-yet-valid (`nbf` in the future)
5. cross-room replay (room-alpha token used against room-beta)
6. capability escalation (flip `canPublish`/`roomAdmin` in payload, keep sig)
7. least-privilege publish (subscriber token claiming publish)
8. malformed token (non-JWT string)

`block_rate == 1.0` is the pass condition (8/8 blocked).

## LLM routing

`internal/llm` mirrors the portfolio-standard chain:
`Anthropic/OpenAI → Ollama → OpenRouter → deterministic offline`. A provider is
available only if its key is set (Ollama probed via `/api/tags`). The offline
function is always terminal, so the service never fails for lack of a key. Only
the grant explainer uses the LLM; the security core is deterministic.

## Invariants

1. A token verifies only for the room it was scoped to; a scope-less token is
   refused for any room-scoped check.
2. Capabilities live in the signed grant — any payload edit breaks verification.
3. Expiry and not-before are enforced independently of the signature.
4. Minting accepts only a role template, never an arbitrary capability set.
5. The service runs fully offline with zero keys; the LLM degrades to
   deterministic, never to an error.

## Constraints

Company-neutral prose; synthetic/example data only; no secrets; `gofmt`-clean;
`go test ./...` and `go vet ./...` pass.
