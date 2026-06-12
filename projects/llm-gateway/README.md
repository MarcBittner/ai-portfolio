# llm-gateway

![llm-gateway console](docs/screenshot.png)

**[▶ Live demo](https://llm-gateway-jwsq.onrender.com)**

A **provider-agnostic LLM gateway** that puts governance *on the request path* —
not in a wrapper a caller can forget. Every completion runs the same pipeline:
input firewall → redaction → routing → output firewall → redaction →
tamper-evident audit log. The guardrails are deterministic (no model, no
network), routing is offline-first (mock fallback) and switches to real
providers via environment variables. It is the reusable substrate for shipping
LLM features in regulated settings: vendor-neutral, governed by default,
auditable.

> Offline by default — deterministic firewall + redaction and a mock provider,
> so reviewers need no keys and incur no cost. Real providers switch on via env.
> All eval/sample data is synthetic and fictional; the audit log stores **only
> redacted** text, and findings never echo a detected secret.

## Architecture

The gateway is a small set of single-responsibility modules. `gateway.complete`
is the only orchestrator; everything else is a pure, independently testable
stage it calls in sequence.

| Module | Responsibility |
|---|---|
| `gateway.py` | Orchestration. Runs the pipeline; finalizes + audits every call. |
| `firewall.py` | Direction-aware scan → verdict `allow`/`flag`/`block` + risk score. |
| `redact.py` | PII + secret detection/redaction; returns type + count, never values. |
| `llm.py` | Multi-provider router with per-provider circuit breaker + latency. |
| `audit.py` | Append-only, hash-chained, tamper-evident log of redacted entries. |
| `policy.py` | Which governance layers enforce; default-ON, env-overridable. |
| `evaluate.py` | Scores the firewall on a labeled set (detection / false-positive). |
| `data.py` | Labeled, synthetic adversarial + benign prompts for the eval. |
| `api.py` | FastAPI surface + the governance console (`static/`). |
| `models.py` | Pydantic request/response shapes. |

### The pipeline

```
                                  gateway.complete(prompt, provider, policy)
                                                  │
  prompt ─▶ ① firewall.scan(input) ──block?──▶ [blocked: input] ──┐
                  │ allow/flag                                     │
                  ▼                                                │
            ② redact.redact(input)   PII/secrets → [TYPE]          │
                  │  (redacted prompt is what the provider sees)   │
                  ▼                                                │
            ③ llm.complete  ── ollama▸anthropic▸openrouter▸openai▸mock
                  │            (skip open breakers; mock is terminal; latency)
                  ▼                                                │
            ④ firewall.scan(output) ──secret leak?──▶ [blocked: output] ──┤
                  │ allow/flag                                     │
                  ▼                                                │
            ⑤ redact.redact(output)  PII/secrets → [TYPE]          │
                  │                                                │
                  ▼                                                ▼
            ⑥ audit.log.append  ◀────────────────────  ALL branches audited
              (hash-chained; redacted text only)
                  │
                  ▼
            GovernedResult { output, provider, model, latency_ms,
                             input_scan, output_scan, redactions,
                             blocked, audit_seq, routing_fallbacks }
```

### A `POST /v1/complete` request, stage by stage

1. **Input firewall** (`firewall.scan(prompt, "input")`). Regex rules match
   injection (`ignore previous instructions`, `disregard the system`, reveal-the-
   system-prompt), jailbreak (`DAN`, `developer mode`, role-override), and
   exfiltration (`print/leak … api_key/secret/password`), plus delimiter
   injection (`</system>`, ```` ```system ````). The verdict is the max severity
   weight across findings: `block` at ≥ 0.85, else `flag`, else `allow`. Inputs
   are *always* scanned for visibility; enforcement is gated on
   `policy.firewall_input`.

2. **Blocked-input branch.** If the policy enforces input firewall and the
   verdict is `block`, the gateway short-circuits: the provider is never called,
   output becomes `[blocked: input violated policy]`, and `blocked="input"`. The
   request still flows to stage ⑥ — **a blocked request is audited like any
   other.**

3. **Input redaction** (`redact.redact`). On an allowed/flagged request, PII
   (email, SSN, Luhn-validated card, phone, IP) and secrets (AWS / GitHub /
   Slack tokens, `sk-…` API keys, bearer) are replaced with `[TYPE]` labels
   *before the provider ever sees the prompt*. Gated on `policy.redact_input`.

4. **Routing** (`llm.complete`). The redacted prompt is sent through the
   provider chain `ollama → anthropic → openrouter → openai → mock` (cloud
   providers appear only when their API key is set). Providers with an **open
   circuit breaker are skipped**; each attempt records latency and updates the
   breaker. `mock` is the terminal fallback, so routing never raises. The result
   carries `provider`, `model`, `latency_ms`, and any `fallbacks`.

5. **Output firewall** (`firewall.scan(text, "output")`). The response is scanned
   for leakage by running the redaction detectors: a secret hit is `critical`,
   PII is `medium`. A `critical` finding (weight 1.0) clears the block threshold.

6. **Output-leak branch.** If the policy enforces output firewall and the verdict
   is `block`, the shown output is replaced with `[blocked: output violated
   policy]` and `blocked="output"` — the model's leaking text is never returned.

7. **Output redaction** (`redact.redact`). Independently of the block decision,
   any residual PII/secrets in the output are redacted to `[TYPE]` before the
   text is returned *and* before it is logged. Gated on `policy.redact_output`.

8. **Audit** (`audit.log.append`, in `_finalize`). Every branch — allowed,
   input-blocked, output-blocked — appends one entry recording verdicts,
   redaction counts, provider/model/latency, the `blocked` reason, and **only the
   redacted** request/response (capped at 500 chars/side). The entry's `seq` is
   returned as `audit_seq`.

The same orchestration backs `POST /v1/extract`, which adds a JSON-only system
prompt and parses the (already governed, already redacted) output.

## Design decisions

- **Governance is the path, not a wrapper.** `gateway.complete` is the single
  entry point; there is no way to reach a provider while skipping the firewall,
  redaction, or audit. A caller cannot "forget" to govern a request because the
  govern *is* the request path.

- **No-leak guarantee, enforced twice.** PII and secrets are redacted **before
  the provider** sees the prompt and again **before anything is logged**.
  Detection findings carry only `type` + `count` + `category` — a matched value
  is *never* echoed back, not in an API response, not in a finding, not in the
  audit log. The firewall reuses the same detectors, so output leakage and log
  safety share one source of truth.

- **Tamper-evident by construction.** The audit log is a hash chain: each entry
  stores `prev_hash` plus a SHA-256 over its own hash-excluded body. Any later
  mutation, insertion, or deletion breaks the chain, and `verify()` reports the
  first broken `seq`. `demo_tamper` flips a stored decision *without* re-hashing
  so the console's "tamper" button makes verification visibly fail.

- **Circuit breaker for resilience.** A per-provider breaker opens after N
  consecutive failures (default 3) and stays open for a cooldown (default 30s),
  then allows a half-open trial. One flapping upstream can't stall every request;
  the chain simply skips it and moves on.

- **Mock terminal fallback (CONV-1).** `mock` is always last in the chain and
  always available, so a completion never fails and the whole system is
  reviewable offline with zero keys and zero cost.

- **Guardrails are tested, not asserted.** `evaluate.run_eval` scores the
  firewall against the labeled set in `data.py` — detection rate (recall on
  malicious/leaking) and false-positive rate (benign tripped). A weakened rule
  shows up as a measurable regression rather than a silent gap.

**What changes for production.** The audit log is in-memory per instance here; a
real deployment persists to an append-only / WORM store (the chain design
transfers unchanged). Policy is a single default; production would resolve it
**per tenant**. Routing is request/response; streaming responses would scan and
redact incrementally on the token stream.

## Data model & invariants

Each `audit.log` entry:

```
{ seq, ts, event, provider, model, latency_ms,
  input_verdict, output_verdict, blocked,
  redactions_in:[{type,category,count}], redactions_out:[…],
  request:"<redacted ≤500c>", response:"<redacted ≤500c>",
  prev_hash, hash }
```

Cardinal invariants:

- **Never logs a secret or PII value.** `request`/`response` are always the
  redacted text; `redactions_*` carry counts, never values. This holds on every
  branch, including blocked requests.
- **Chain integrity.** `entry.prev_hash == previous.hash` and
  `entry.hash == SHA256(body − hash)` for every entry; `verify()` walks from
  `GENESIS` and reports the first `seq` where either equality fails.
- **Routing never raises.** `mock` is terminal; `complete` always returns a
  `GovernedResult`.
- **Every governed request is audited** when `policy.audit` is on — allowed,
  flagged, or blocked alike.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, version, provider count, audit size, policy layers |
| GET | `/providers` | routing config (offline-first order; breaker state) |
| GET | `/policy` | the active governance policy (layers on/off) |
| GET | `/rules` | firewall input rules + the output leakage rule |
| POST | `/v1/complete` | governed completion → output + per-stage governance |
| POST | `/v1/extract` | governed structured (JSON) extraction |
| GET | `/v1/audit` | the audit log (redacted entries) |
| GET | `/v1/audit/verify` | hash-chain integrity check |
| POST | `/v1/audit/_demo_tamper` | mutate an entry to show `verify` then fails |
| GET | `/eval` | firewall detection / false-positive rates on a labeled set |

`POST /v1/complete` body: `{ "prompt": "…", "provider": "auto" }` → returns the
output plus `input_scan`, `output_scan`, `redactions`, `provider`/`model`/
`latency_ms`, `blocked`, `routing_fallbacks`, and the `audit_seq`.

## Quickstart

```sh
cd projects/llm-gateway
./run.sh setup
./run.sh demo            # offline: governed completions + audit verify + eval
./run.sh serve           # API + governance console at http://127.0.0.1:8010
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local, or --url <deploy>)
```

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5: zero-cost reviewability, no secrets, synthetic data, engineering
hygiene, local + remote smoke suite).
