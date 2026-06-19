# arbiter

**An OpenAI-compatible proxy that learns, from your real traffic, where you're
overpaying for model quality you don't need — then reroutes those requests to
cheaper or local models *only when measured quality stays above a floor you set*.**

arbiter never "wins" by quietly degrading your app: every dollar of savings is
reported next to a **measured** quality-retention number, and that retention is
obtained by *actually running* candidate models and judging their output against
the baseline — not estimated, not faked. When no model is reachable it says
"can't measure," rather than inventing a score.

It also finds two adjacent cost levers and applies them transparently.
**Response caching** serves exact deterministic repeats at $0. **Prompt-prefix
caching** detects long reused prefixes and bills them at ~10% via provider-side
caching. Both are zero-quality-impact by construction.

> Sibling of `llm-gateway`, which puts *governance* on the request path;
> arbiter puts *economics + quality* on it.

---

## Contents

- [The two modes](#the-two-modes)
- [The cost/quality control](#the-costquality-control)
- [How quality is measured — real shadow-judging](#how-quality-is-measured-real-shadow-judging)
- [The three savings strategies](#the-three-savings-strategies)
- [Quickstart](#quickstart)
- [API reference](#api-reference)
- [The honest dollar bridge](#the-honest-dollar-bridge)
- [Limitations](#limitations)
- [Architecture](#architecture)
- [Stack](#stack)

## The two modes

| Mode | Behavior | Production impact |
|---|---|---|
| **observe** | Serves every request on its baseline model unchanged; shadow-judges cheaper candidates on a sample to build quality evidence; emits ranked savings opportunities + candidate rules. | none, read-only |
| **route** | Applies the ruleset to transparently reroute to the cheapest model whose *measured* retained quality clears the floor; keeps shadow-judging a small sample to catch drift; proves realized savings over time. | bounded by the floor |
| **off** | Pure passthrough — kill switch. | none |

## The cost/quality control

- **floor** — a *hard gate*: a candidate is eligible only if its measured retained
  quality is at or above the floor. The default floor is `0.92`.
- **rate**, in $/quality-point — a *tiebreak among models that already clear the
  floor*: `value = savings_per_req − rate · (1 − retained)`. A low rate means
  "cheapest that clears the floor"; a high rate prefers retaining quality.

## How quality is measured — real shadow-judging

For a sampled request the baseline model's real output is compared to each
cheaper candidate's real output by two signals:

1. **An LLM judge** — a strong, available model scores 0–1, with a rationale,
   whether the candidate could replace the baseline for this task.
2. **Deterministic heuristics** — JSON-validity + key agreement, length ratio,
   lexical similarity, refusal agreement, code-fence agreement.

`retained = 0.65·judge + 0.35·heuristics`. With no judge model reachable it falls
back to heuristics-only at lower confidence; with no candidate/baseline pair it
returns nothing. The routing floor gates on this number.

## The three savings strategies

| kind | what it does | quality impact |
|---|---|---|
| **route** | serve a cheaper model when measured retained quality clears the floor | measured, at or above the floor |
| **prompt-cache** | detect long stable prefixes; inject Anthropic `cache_control` so they bill at ~10% | none |
| **response-cache** | serve exact deterministic repeats from cache at $0 | none |

---

## Quickstart

```bash
./run.sh setup            # venv + install; for CI/containers add --no-venv
./run.sh demo             # offline end-to-end: observe → opportunities → route → report
./run.sh serve            # proxy + console at http://127.0.0.1:8030
./run.sh test             # pytest
./run.sh eval             # reproducible eval → eval-report.md
./run.sh smoke            # live HTTP suite against a local server, or --url <deploy>
./run.sh doctor           # python / venv / model-provider status
```

Point any OpenAI client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8030/v1", api_key="unused")
client.chat.completions.create(model="claude-opus-4-8",
    messages=[{"role": "user", "content": "classify this ticket"}])
```

**Running on real models for free:** start host Ollama — the registry seeds
`local-large`, `local-small`, and `local` — and shadow-judging plus the LLM judge
run on your local models at $0. With a provider key set, the chain uses it.

---

## API reference

Base URL: `http://127.0.0.1:8030`; the Render deployment uses its assigned host.

### `POST /v1/chat/completions` — OpenAI-compatible proxy
Request, in OpenAI shape, with extra fields allowed:
```json
{ "model": "claude-opus-4-8",
  "messages": [{"role":"user","content":"..."}],
  "max_tokens": 400, "temperature": 0.0,
  "response_format": {"type":"json_object"} }
```
Response: a standard `chat.completion` object plus a `arbiter` block and
`x-arbiter-*` headers:
```json
{ "object":"chat.completion","model":"claude-haiku-4-5",
  "choices":[{"index":0,"message":{"role":"assistant","content":"..."},
              "finish_reason":"stop"}],
  "usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150},
  "arbiter":{ "mode":"route","requested_model":"claude-opus-4-8",
    "baseline_model":"claude-opus-4-8","served_model":"claude-haiku-4-5",
    "strategy":"route","task_class":"classification","matched_rule":"auto-...",
    "baseline_cost":0.0021,"served_cost":0.00015,"saved":0.00195,
    "cache_hit":false,"real_model":true,"shadow":[] } }
```
Headers: `x-arbiter-strategy`, `x-arbiter-served-model`,
`x-arbiter-baseline-model`, `x-arbiter-saved-usd`.

| Method · Path | Purpose |
|---|---|
| `GET /health` | `{ok, version, mode, providers, strongest_available}` |
| `GET /config` · `PUT /config` | read / update `{mode, floor, rate, response_cache, prompt_cache, …}` |
| `GET /models` | model registry: id, provider, prices, tier, availability |
| `GET /rules` · `PUT /rules` | read / replace the ruleset |
| `POST /rules/generate` | regenerate rules from measured quality stats |
| `GET /opportunities` | ranked savings opportunities across all 3 strategies |
| `GET /quality` | measured retained-quality stats per task and candidate |
| `GET /report?scenario=` | summary + by-task + timeseries + price **projection** + cache stats |
| `POST /simulate` | `{n, seed}` — run synthetic traffic through the proxy |
| `POST /reset` | clear the time-series store |

**Status codes:** `200` success · `422` request-body validation error from
FastAPI · `500` unexpected. The proxy never fails for lack of a provider — with
none reachable it serves a clearly-marked deterministic stub and records no
savings.

---

## The honest dollar bridge

Registry prices are real published list prices; local and free models are priced
at `$0`. So on a zero-budget local demo the *realized* dollar savings are `$0`
while the **measured quality retention is real**. The `/report` **projection**
re-prices those measured routing decisions at a chosen list-price scenario —
`frontier-to-local`, `sonnet-to-haiku`, or `gpt4o-to-mini` — so you can see the
dollar impact at prices you actually pay. It is clearly labeled as a projection on
a *measured* decision, never a fabricated benchmark.

## Limitations

- Quality estimation is **statistical, not a guarantee**; the floor and the
  keep-measuring-while-routing sample bound the downside. Canary and auto-rollback
  are a v0.2 item.
- Shadow scoring **costs tokens** on the sampled subset; the sample rate is
  tunable and local/Ollama shadows for free.
- The LLM judge has its own blind spots, so it is combined with deterministic
  heuristics and reported with confidence and sample count.
- v0.1 is drop-in for OpenAI-compatible callers; an Anthropic-native shape and
  true streaming are v0.2.

## Architecture

```
client → /v1/chat/completions
  classify: task class + features
  → response-cache?  → decide: observe serves baseline, route applies the floor-gated ruleset
  → dispatch: named-model provider client, prompt-cache on stable prefixes
  → shadow-judge candidates vs the real baseline output, sampled
  → log event + quality sample to SQLite, value-free
SQLite time-series → summary / by-task / timeseries / opportunities / projection
```

## Stack

Python 3.11 · FastAPI · SQLite from the stdlib · stdlib-`urllib` multi-provider
client across Anthropic / OpenAI / OpenRouter / Ollama · real LLM-judge plus
deterministic heuristics · browser→host Ollama · zero-build console · Docker /
Render · offline-capable, synthetic data, secret-scan-clean.

*The bundled demo traffic is synthetic; arbiter proxies and analyzes your real traffic.*
