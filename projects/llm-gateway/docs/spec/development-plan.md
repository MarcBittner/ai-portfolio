# llm-gateway — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Multi-provider router (Anthropic/Ollama/OpenAI/OpenRouter → mock) with
      per-provider **circuit breaker** + latency
- [x] PII + secret **redaction** (Luhn cards, key shapes); never echoes a value
- [x] Direction-aware **firewall** (injection/jailbreak/exfiltration in;
      secret/PII leakage out)
- [x] **Tamper-evident audit log** (hash-chained, verify, demo-tamper)
- [x] **Governed request path** (`gateway.complete`): firewall → redact → route →
      firewall → redact → audit; policy-driven, default-on
- [x] **Governance eval** (firewall detection / false-positive rates)
- [x] FastAPI (`/v1/complete`, `/v1/extract`, `/v1/audit[/verify]`, `/policy`,
      `/rules`, `/eval`) + governance-console UI
- [x] Tests: redact / firewall / audit / gateway / api (28) + local+remote smoke (10)
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Persisted audit store (append-only / WORM) instead of in-memory
- [ ] Per-tenant policies + API keys + rate limits
- [ ] Cost accounting + budget guards per route
- [ ] Streaming completions with incremental output scanning
- [ ] Entropy-based secret detection + allow/deny lists
- [ ] Real-provider eval (answer quality) alongside the governance eval
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
