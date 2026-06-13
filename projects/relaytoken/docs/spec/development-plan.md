# relaytoken — development plan

## Milestones

1. **Token core** (`internal/token`) — role templates → `VideoGrant`, mint via
   `auth.NewAccessToken`, verify via the upstream verifier + room/capability
   re-assertion, TTL clamping. Unit tests for mint, verify, cross-room,
   capability, wrong-secret, malformed.
2. **Breaker suite** (`internal/adversary`) — deterministic JWT surgery for the
   eight attacks, all routed through the public verify path; assert each blocked
   and `block_rate == 1.0`.
3. **Grant linter** (`internal/grant`) — deterministic over-permissioning rule
   checker (missing room scope, subscriber-can-publish, data-channel injection
   surface, unexpected admin, TTL hygiene) + LLM narration with deterministic
   offline fallback.
4. **Threat model** (`internal/threatmodel`) — static threat → mitigation →
   control table covering data-channel prompt injection, egress exposure, SFU
   trust, cross-room replay, capability escalation, long-lived tokens,
   join-flood DoS, mint abuse.
5. **LLM router** (`internal/llm`) — port of the portfolio `llm.py` chain to
   idiomatic Go (net/http + encoding/json), offline always terminal.
6. **Service + CLI** (`cmd/relaytoken`) — net/http mux for all endpoints plus a
   `demo` subcommand for the offline end-to-end walkthrough and a `healthcheck`
   subcommand for the container.
7. **Packaging** — `run.sh` (setup/build/test/lint/run/demo), multi-stage
   distroless `Dockerfile` (non-root, `PORT`, `HEALTHCHECK`), README to the
   portfolio bar, `.env.example`, LICENSE.

## Done criteria

- `go build ./...`, `go test ./...`, `go vet ./...` clean; `gofmt -l` empty.
- `./run.sh demo` prints `block_rate = 1.00` (8/8) and a grant-lint example,
  fully offline with zero keys.
- README is company-neutral; no company named in prose.

## Future work

- Single-use / jti replay cache backed by Redis for true one-time tokens.
- Mint-endpoint rate limiting and per-identity join quotas.
- Token revocation list + short-TTL rotation guidance.
- Live smoke/regression suite against a deployed instance.
