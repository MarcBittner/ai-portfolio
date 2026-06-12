# llm-gateway

A **provider-agnostic LLM gateway** that puts governance *on the request path*,
not in a wrapper a caller can forget. Every completion runs through the same
pipeline:

```
input firewall ─▶ redact input ─▶ route to provider ─▶ output firewall ─▶ redact output ─▶ tamper-evident audit log
(injection /      (PII + secrets    (Anthropic / Ollama /   (secret/PII        (before return       (hash-chained;
 jailbreak /       stripped before    OpenAI → mock;          leakage)            and logging)         verify detects
 exfiltration)     the model)         breaker + latency)                                               any mutation)
```

It's the substrate for shipping LLM features in **regulated environments**:
vendor-neutral, governed by default, and auditable — the same pattern reused
across products instead of re-implemented each time.

> Offline by default (deterministic firewall + redaction, mock provider — no
> keys, no cost). Real providers switch on via env (`ANTHROPIC_API_KEY`,
> `OPENAI_API_KEY`, Ollama). All eval/sample data is synthetic and fictional;
> the audit log stores **only redacted** text, and findings never echo a detected
> secret.

## Why it's built this way

- **Governance is the path, not a bolt-on.** Firewall → redaction → routing →
  output firewall → audit happen on every call; a blocked request is still
  audited.
- **No-leak guarantee.** PII/secrets are redacted *before* the provider sees the
  prompt and *before* anything is logged. Detection findings carry only type +
  count.
- **Tamper-evident by construction.** The audit log is hash-chained; `verify`
  reports the first broken entry. The UI has a "tamper" button so you can watch
  verification fail.
- **Guardrails are tested.** A governance eval scores the firewall on a labeled
  set (detection rate + false-positive rate) — a weakened rule shows up as a
  regression.
- **Resilient routing.** A per-provider circuit breaker skips a flapping upstream;
  the mock provider is the terminal fallback so a call never fails.

## Quickstart

```sh
cd projects/llm-gateway
./run.sh setup
./run.sh demo            # offline: governed completions + audit verify + eval
./run.sh serve           # API + governance console at http://127.0.0.1:8010
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, version, providers, audit size, policy layers |
| GET | `/providers` | routing config (offline-first; breaker state) |
| GET | `/policy` | the active governance policy (layers on/off) |
| GET | `/rules` | firewall rules (input) + output leakage rule |
| POST | `/v1/complete` | governed completion → output + per-stage governance metadata |
| POST | `/v1/extract` | governed structured (JSON) extraction |
| GET | `/v1/audit` | the audit log (redacted entries) |
| GET | `/v1/audit/verify` | hash-chain integrity check |
| GET | `/eval` | firewall detection / false-positive rates on a labeled set |

`POST /v1/complete` body: `{ "prompt": "...", "provider": "auto" }` → returns the
output plus `input_scan`, `output_scan`, `redactions`, `provider/model/latency_ms`,
`blocked`, and the `audit_seq`.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
