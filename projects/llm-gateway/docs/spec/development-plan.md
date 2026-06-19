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

---

## Code review backlog (from `/docs/code-review/llm-gateway.md`, 2026-06-18) — NOT YET DONE

Grade **B+**. Prioritized fixes; full detail + `file:line` in the review.

- [ ] **HIGH — audit truncation gap.** The "tamper-evident" hash chain detects edits and reordering but **not tail truncation** (dropping trailing entries still verifies `ok:true`). Add a signed head/length commitment (or a verified expected-count / running HMAC over the length).
- [ ] **HIGH — firewall bypass + misleading eval.** The regex firewall is defeated by trivial obfuscation (leetspeak / zero-width / rewording), yet the eval reports **100% detection** because the labeled set matches the regexes. Report honest recall on an adversarial set and/or strengthen detection; stop advertising 100%.
- [ ] **MED — `/v1/extract` ungoverned `instruction`.** The extract path's `instruction`/system text reaches the provider unscanned and unredacted — governance only covers the user `prompt`. Run it through the same firewall+redaction.
- [ ] **MED — unauth tamper endpoint.** `/v1/audit/_demo_tamper` can corrupt the shared audit log on a public deploy; gate it (or remove from prod).
- [ ] **LOW — `IP_ADDRESS` regex false positives** on version strings (e.g. `1.2.3.4`-shaped semver).
