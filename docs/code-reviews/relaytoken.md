# Code Review: relaytoken

**Health: good** — Well-structured Go service with a clear security core (HS256-signed JWTs via livekit/protocol auth), thorough adversary test suite (8/8 attacks blocked, 100% block rate asserted in CI), and solid offline-fallback design. A handful of low/medium issues around frontend XSS hygiene, HTTP server hardening, and a misleading run.sh option.

---

## Findings

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | medium | security | `cmd/relaytoken/static/index.html:505` | `toast()` inserts `msg` via `innerHTML` without HTML escaping. Callers on lines 535 and 622 pass `r.error` directly — the Go server can return error strings that embed user-supplied input (e.g. `fmt.Errorf("%w: %q", ErrUnknownRole, role)` in `token.go:91`). A role value of `<img src=x onerror=alert(1)>` produces an error message that executes when rendered. In practice this is self-XSS (the user controls the input field), but the pattern is one server-driven string injection away from a real reflected-XSS path. | Escape the `msg` argument in `toast()`: `t.textContent = msg` (or replace the template literal's interpolation with a text node). All other server-sourced strings in the UI already go through `esc()`. | false | true |
| 2 | medium | bug | `run.sh:16,78` | The `--host` / `$HOST` option is parsed and exported but never plumbed to the binary. The Go server always binds `":" + port` (all interfaces). Running `./run.sh run --host 127.0.0.1` has no effect on the bind address. | Either remove the `--host` option (the binary doesn't support it) or add a `HOST` env-var read in `main.go` and form `addr := host + ":" + port`. | false | true |
| 3 | low | security | `cmd/relaytoken/main.go:157,180,206` | No HTTP request body size limit on the three POST handlers (`/token/mint`, `/token/verify`, `/grant/lint`). `json.NewDecoder(r.Body).Decode()` will read an arbitrarily large body before erroring. | Wrap each handler's body: `r.Body = http.MaxBytesReader(w, r.Body, 1<<16)` (64 KB is more than sufficient for any valid request). | false | true |
| 4 | low | bug | `cmd/relaytoken/main.go:124` | `writeJSON` silently discards the JSON encoder error: `_ = enc.Encode(v)`. If the connection drops mid-write or an unencodable value is passed, the failure is swallowed with no log. | At minimum `log.Printf("writeJSON: %v", enc.Encode(v))` or check and return early. All current callers pass encodable types, so this is a latent hygiene gap. | false | true |
| 5 | low | quality | `cmd/relaytoken/main.go:87-92` | The `http.Server` sets `ReadHeaderTimeout: 5s` but no `WriteTimeout`. The `/grant/lint` handler runs a 90-second LLM chain context. Without a `WriteTimeout`, a hung LLM backend leaves the TCP connection open indefinitely on the server side even after the client disconnects. | Add `WriteTimeout: 120 * time.Second` (or a value slightly above the longest legitimate handler, currently 90s for LLM). | false | true |
| 6 | low | quality | `internal/llm/llm.go:112-135` | `ollamaReachable()` releases the mutex before the network probe and re-acquires it afterwards. Under concurrent requests with a stale cache, multiple goroutines may probe Ollama simultaneously. The result is benign (duplicate probes, not a data race — the write is mutex-protected), but it wastes resources and makes the 30s cache ineffective under burst load. | Use `sync.Once` keyed on the cache window, or hold a single in-flight flag (e.g. `singleflight.Group`) so only one probe fires per 30s window. | false | false |
| 7 | low | quality | `cmd/relaytoken/main.go:198,202` | The `/adversary` and `/threat-model` endpoints accept any HTTP method (no method guard). They are read-only but will process a `POST` body without complaint. `/llm` (line 145) has the same issue. Minor API inconsistency; `GET` semantics are expected. | Add `if r.Method != http.MethodGet { writeJSON(w, http.StatusMethodNotAllowed, ...) }` for these three handlers to match the guard pattern used on the mutation endpoints. | false | true |

---

## Notes

**Security core is solid.** The token minting, verification, and adversary harness are well-designed. The role-template approach (never hand-assembling a grant from raw request fields) is the right pattern. `Verify` re-asserts room scope and capability after the upstream signature check — defense in depth against a library bug. The adversary suite covers all eight canonical JWT attacks and asserts a 1.0 block rate in tests.

**Grant linter trust boundary is correct.** The `client_explanation` shortcut in `grantLint` (lines 223-228) accepts arbitrary text from the browser but is only used for the prose field; deterministic `Lint()` findings, risk score, and `least_priv` flag are always recomputed server-side. The explanation field is also escaped with `esc()` in the frontend.

**Dependency surface is moderate.** `go.mod` pulls in the full `livekit/protocol` dependency graph (pion WebRTC stack, gRPC, Redis, NATS, Prometheus). Only the `auth` sub-package is used directly. Consider replacing with the lighter `github.com/livekit/protocol/auth`-only dependency if the full graph grows problematic.

**Dockerfile is clean.** Multi-stage build, distroless non-root runtime, correct `HEALTHCHECK` using the binary's own `healthcheck` sub-command.

**Test coverage is strong.** Token core, adversary suite, grant linter, and LLM router all have dedicated unit and security test files. The security tests plant canary secrets and verify no leakage — a good pattern.
