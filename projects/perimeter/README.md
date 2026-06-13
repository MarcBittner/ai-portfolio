# perimeter

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**[▶ Live demo](https://perimeter.onrender.com)**

`perimeter` ingests the kind of records an **internet-wide scan platform** emits —
hosts, open services (port + protocol), software and versions, parsed **TLS
certificates**, and ASN / geo — and turns that raw internet-exposure data into a
**governed, board-ready GRC program**. It is the *Director of Security / GRC* lens
on internet intelligence: not "here are the open ports," but "here is our
severity-weighted posture, the compliance controls each exposure breaks across
**five frameworks**, what the next remediation wave buys in posture and audit terms,
and the per-control evidence I can hand an auditor."

Where this earns its keep beyond a scanner dump:

- **One finding, five frameworks.** Every exposure is mapped to a control that
  crosswalks **SOC 2 (CC6.x/CC7.x) → ISO 27001:2022 → NIST SP 800-53 → NIST SP
  800-171 → CMMC L2** at once. A GRC director defends the same evidence to a SOC 2
  auditor, an ISO assessor, and a CMMC C3PAO without re-mapping it. The roll-up
  reports status **per control and per framework**.
- **A board doesn't read a findings table.** An **LLM reads the *already-computed*
  posture — score, top risks, failing controls, framework roll-up — and writes a
  board report**: posture in plain prose, the top risks and their business/compliance
  impact, what fixing them buys, and the **residual risk** that remains. The model
  only writes; it never invents a finding, a score, or a control status, so the
  governed evidence stays deterministic. It routes **Anthropic/OpenAI → Ollama →
  OpenRouter → a deterministic template**, so the report renders with zero keys.
- **Posture is only useful if it moves.** A **before/after remediation diff** runs
  the estate as-is and after the first remediation wave and shows the lift — the
  "if we do X, our grade goes **F → D** and we clear five controls" view that turns
  exposure data into a prioritized, board-defensible plan.
- **Evidence you can hand an auditor.** A per-control **evidence export** (JSON or
  CSV) bundles each control with its five-framework crosswalk, status, and the
  exposure findings that drive it.

> A sibling demo (`attack-surface`) does CT-subdomain enumeration → control-mapped
> findings. `perimeter` is distinct: it ingests **internet-intelligence host
> records** (services, software/versions, TLS certs, ASNs) and leans into the **GRC
> program** — multi-framework crosswalk, posture over time, board reporting, and
> auditor evidence export.

## Architecture

Small, single-purpose modules; the data flows one direction through them.

| Module | Responsibility |
|---|---|
| `data.py` | Synthetic internet-intelligence inventory: 18 hosts on **reserved IPs** (RFC 5737) with open services (port/protocol/software/version), parsed TLS certs, ASN/geo. Planted exposures + a remediated 'after' state. |
| `fingerprint.py` | Structural detectors over the host records → exposure findings (severity, `rule_id`, `host:port`, machine-readable `evidence`), each pre-mapped to controls with a remediation. |
| `controls.py` | The **five-framework** control catalog + crosswalk, the per-control roll-up to pass/fail, and the per-framework aggregation. |
| `risk.py` | Severity-weighted, **saturating** posture score + letter grade; the posture-over-time `diff`. |
| `scan.py` | Orchestrates inventory → fingerprint → controls → framework roll-up → posture; `remediation_diff()`; a CI `gate()`. |
| `narrative.py` | LLM **board / exec risk report** over the computed posture; deterministic offline template; structural eval. |
| `evidence.py` | Auditor **evidence export** — per-control finding bundle + crosswalk as JSON/CSV. |
| `llm.py` | Multi-provider routing (paid → local → free → deterministic offline), stdlib HTTP. |
| `evaluate.py` | Reproducible eval → `eval-report.md` (`./run.sh eval`). |
| `api.py` | FastAPI surface + the GRC console UI; `models.py` request models. |
| `demo.py` | Offline CLI: inventory → exposures → posture/grade → crosswalk → diff → board report → evidence. |

```
  internet-intelligence records (data.py)
   host: ip · asn · geo · open services (port/proto/software/version) · TLS cert
                      │
                      ▼
        fingerprint.py  structural detectors ──▶ exposure findings
                                              (severity + evidence + control ids)
                      │
        map each finding → control, crosswalked across 5 frameworks (controls.py)
                      │
                      ▼
  per-control roll-up (pass/fail) ─┬─▶ per-framework roll-up (SOC2/ISO/NIST/CMMC)
                                   └─▶ severity-weighted posture (risk.py) → score + grade
                      │
                      ├─▶ remediation diff (posture over time)
                      ├─▶ LLM board report (narrative.py)
                      └─▶ auditor evidence export (evidence.py)
```

### The `GET /scan` lifecycle (here: `GET /posture`)

The governed posture runs entirely offline on the synthetic estate.
`scan.scan()` reads the internet-intelligence inventory from `data.py`, runs every
host's services through `fingerprint.derive_host()` (datastore exposed to
`0.0.0.0/0`, admin panel on the public edge, expired / weak-key / SHA-1 /
self-signed / deprecated-TLS certs, end-of-life software), sorts findings by
severity, rolls them up per control with `controls.evaluate()`, aggregates that into
the per-framework view with `controls.framework_rollup()`, and computes a
severity-weighted posture. The response is one object —
`{inventory, posture, severity_counts, framework_rollup, controls[], findings[]}` —
where each finding already carries the control ids it breaks.

## Risk posture & frameworks

A finding is the unit of governed evidence: a stable `rule_id`, a `severity`, the
affected `asset` (`host:port`), machine-readable `evidence` (e.g. the parsed cert
fields or the open port), a `remediation`, and the **control ids** it maps to —
assembled at the moment the detector fires, so the mapping is never an afterthought.

`controls.evaluate()` inverts the relationship: it walks every control, collects the
findings mapped to it, and assigns **fail** (any finding) / **pass** (none).
`controls.framework_rollup()` then aggregates per-control status into the
**per-framework** picture, because every control carries its crosswalk:

| SOC 2 | ISO 27001 | NIST 800-53 | NIST 800-171 | CMMC L2 | what it covers |
|---|---|---|---|---|---|
| CC6.1 | A.8.3  | AC-3 | 3.1.1   | AC.L2-3.1.1     | access boundaries (admin panel) |
| CC6.6 | A.8.20 | SC-7 | 3.13.1  | SC.L2-3.13.1    | boundary protection (exposed datastores) |
| CC6.7 | A.8.24 | SC-8 | 3.13.11 | SC.L2-3.13.11   | data-in-transit crypto (TLS certs) |
| CC6.8 | A.8.8  | SI-2 | 3.14.1  | SI.L2-3.14.1    | supported, patched software |
| CC7.1 | A.8.8  | RA-5 | 3.11.2  | RA.L2-3.11.2    | vulnerability / exposure detection |
| CC7.2 | A.8.16 | SI-4 | 3.14.6  | SI.L2-3.14.6    | monitoring anomalous external exposure |

So a single exposure — say MongoDB answering on `27017` from `0.0.0.0/0` — maps to
`CC6.6`, which is **simultaneously** `ISO A.8.20`, `NIST SC-7`, `800-171 §3.13.1`,
and `CMMC SC.L2-3.13.1`. One piece of evidence, defensible to every auditor at once.

The posture score is **severity-weighted** (critical 10, high 6, medium 3, low 1)
and mapped to 0–100 through a **saturating** curve, `score = 100 / (1 + Σpenalty /
30)`, rather than a raw subtraction. The curve is deliberate: a real internet-facing
estate has enough open exposure to drive a linear `100 − Σpenalty` straight to zero,
which loses all signal. The saturating form stays monotonic and sensitive across the
whole range, so fixing the top risks always moves the grade measurably.

On the fixture this produces a **posture of 25/100, grade F, with 6 of 6 controls
and all 5 frameworks failing** — 5 critical (4 internet-open datastores + an exposed
admin panel), 5 high (expired cert, weak 1024-bit key, SHA-1 signature, two
end-of-life software versions), and 3 medium (deprecated TLS 1.0, self-signed cert,
a cert expiring inside 30 days).

### Posture over time — remediation diff

`GET /diff` runs the estate as-is and after the **first remediation wave** (every
internet-open datastore and the admin panel pulled behind an allowlist, the
end-of-life software upgraded, the expired cert renewed — the TLS-hardening items
intentionally deferred to a later wave) and reports the lift:

| state | score | grade | controls failing | frameworks failing |
|---|---|---|---|---|
| before | 25/100 | F | 6/6 | 5/5 |
| after  | 59/100 | D | 1/6 | 5/5 |

That wave moves posture **F → D (+34 points)** and **remediates 5 of 6 controls**
(`CC6.1`, `CC6.6`, `CC6.8`, `CC7.1`, `CC7.2` flip fail → pass); every framework's
failing-control count drops from **6 to 1**. The one remaining failure is `CC6.7`
(data-in-transit cryptography) — the residual the board report calls out as the next
wave. It is deterministic, so the demo and the eval report the same numbers.

## Board reporting

A findings table is evidence; a board needs a *story*. `POST /report` (or
`GET /report`) feeds the **already-computed** posture to the routing chain and gets
back a board report framed as a governance program:

```
posture report  ──▶  llm.complete(SYSTEM, report-json, json_mode)
  {posture, findings[],     Anthropic / OpenAI → Ollama → OpenRouter → template gen
   controls[], framework_rollup}
              ──▶  {summary, top_risks:[{rule_id, risk, impact}],   # every crit+high
                    remediation, residual_risk}
              ──▶  rendered board panel
```

The model only ever **writes prose over numbers it was given** — it never derives a
finding, a score, or a control status, so the governed evidence stays deterministic
and the LLM can't inflate (or hide) risk. The offline generator produces the *same*
`{summary, top_risks, remediation, residual_risk}` shape keyed by `rule_id`, so the
report renders and the eval reproduces with zero keys, while the live path adapts
tone and prioritization to an unseen report.

### Auditor evidence export

`GET /evidence` (optionally `?control=CC6.6`, `?format=csv`) assembles the artifact
an auditor actually wants: per control, the five-framework crosswalk, the pass/fail
status, and the exposure findings that drive it — the trace from
*internet-exposure finding* to *the control it affects* across every framework.

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain, identical in shape to the
other demos: a provider is *available* only when its key is set (or, for Ollama, when
a probe to `/api/tags` succeeds), so the chain self-selects from the environment and
`complete()` returns the first success, recording which providers it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic template generator only |

`GET /llm` reports which providers are reachable and the active mode. The offline
generator is always terminal, so the service never fails for lack of a key — it
degrades to deterministic, not to an error.

## Evals

`./run.sh eval` (or `GET /evals`) asserts the structural GRC invariants as
**measured facts** and writes `eval-report.md`. Because the core is deterministic,
the numbers reproduce exactly with zero keys.

| invariant | holds |
|---|---|
| every finding maps to ≥ 1 control | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| every mapped control id exists in the catalog | ✓ |
| per-framework roll-up matches the per-control status | ✓ |
| posture = 100 / (1 + Σ severity penalty / K) | ✓ |
| **board report covers every critical (and high) exposure** | ✓ |

The last row is the narrative's safety metric — **an uncovered critical is a gap in
the board report**. The eval also emits the multi-framework coverage and the
remediation diff, so the posture lift is a reproducible number, not a claim.

## Code map

```
src/perimeter/
  data.py        synthetic internet-intel inventory (hosts/services/TLS/ASN); remediated_hosts()
  fingerprint.py structural detectors over host records → findings pre-mapped to controls
  controls.py    5-framework catalog + crosswalk (SOC2/ISO/NIST 800-53/800-171/CMMC); roll-up
  risk.py        severity-weighted saturating posture + grade; posture-over-time diff()
  scan.py        inventory → fingerprint → controls → framework roll-up → posture; gate()
  narrative.py   LLM board/exec risk report over the posture; structural eval
  evidence.py    auditor evidence export — per-control bundle + crosswalk (JSON/CSV)
  llm.py         multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py    ./run.sh eval → eval-report.md (invariants + crosswalk + diff)
  api.py         FastAPI service; models.py request models; static/ GRC console UI
tests/           unit (fingerprint, risk, controls, llm, api) + opt-in live smoke
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, control + framework + exposure counts, grade |
| GET | `/inventory` | the internet-intelligence host inventory + summary |
| GET | `/exposures` | exposure findings (severity, rule, host:port, evidence, controls) |
| GET | `/posture` | governed posture: inventory, score+grade, framework roll-up |
| GET | `/controls` | the 5-framework control roll-up; `?framework=` filters to one view |
| GET | `/diff` | posture over time — before/after remediation, controls/frameworks flipped |
| GET | `/gate` | CI gate decision (`?min_score=`); fails on open criticals |
| GET·POST | `/report` | LLM board/exec risk report (`{remediated, mode}`) |
| GET | `/evidence` | auditor evidence bundle (`?control=`, `?format=csv`) |
| GET | `/evals` | structural invariants — does the board report cover every critical? |
| GET | `/llm` | configured/reachable providers + active routing mode |

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
template). Set any of these to route the board report to a real model; never commit
real keys, and leave them unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |

```sh
cd projects/perimeter
./run.sh setup
./run.sh demo            # offline: posture + crosswalk + diff + board report + evidence
./run.sh eval            # invariants + multi-framework coverage + posture before/after
./run.sh serve           # GRC console at http://127.0.0.1:8022
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

> All data is synthetic and fully fictional — hosts use **reserved documentation IP
> ranges** (RFC 5737) and the reserved `.test` TLD. Nothing here touches a real
> network; the estate is authorized by construction.

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed on
Render's free tier — the same image runs anywhere. **No provider keys are set on the
public host**, so the live demo runs the deterministic offline path; the LLM chain
activates wherever keys/Ollama are present. Free instances cold-start in ~30–50s.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5).
