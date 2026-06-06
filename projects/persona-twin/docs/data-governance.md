# Data governance posture

## Synthetic data only

Every persona, document, and eval item in this repository is fictional
and was authored for this project. There is no scraped content, no
real-person data, and no real PII anywhere in the corpus. The
PII-looking values in the sample documents (emails on `example.com`,
`(555) 01x-xxxx` phone numbers) are reserved-for-fiction values placed
deliberately to exercise the redaction layer.

## The redaction layer

`persona_twin.governance.Redactor` is **deterministic** — regex plus
checksum validation, no model calls. Determinism matters here: a
governance gate you can unit-test exactly is a gate you can trust in
CI, and it costs microseconds, not tokens.

What it detects:

| Type | Method |
|---|---|
| `EMAIL` | RFC-ish address pattern |
| `SSN` | `ddd-dd-dddd` |
| `CREDIT_CARD` | 13–19 digits (spaces/dashes ok) **+ Luhn checksum** — non-Luhn digit runs are left alone |
| `PHONE` | NANP-style formats, optional +1 |
| `IP_ADDRESS` | dotted quad with octet range validation |
| `STREET_ADDRESS` | number + capitalized words + street-suffix heuristic |

Behavior:

- Replacements are typed, numbered tokens (`[EMAIL_1]`); the same value
  gets the same token within a call, and the result carries a
  `token → original` mapping for reversible lookup inside a request.
- **Where it runs:** mandatorily at ingest (before any text is embedded
  or stored) and optionally on outbound prompts.
- **Logging:** redaction *counts* by type are logged; redacted *values*
  never are.

## What it does not catch (on purpose, documented)

Names, free-text locations, dates of birth, and contextual identifiers
("my sister the mayor") require NER-grade detection. For production
use, an ML NER layer (e.g. spaCy or a fine-tuned token classifier)
slots in behind the same `Redactor` interface as a second pass; the
deterministic layer stays as the fast, testable first gate. That
ordering — cheap deterministic gate first, model gate second — keeps
the failure mode "missed an edge case," never "the regex was down."

## Operational rules

- All provider keys via environment variables; never logged, never in
  `/health` output, never committed (`.env` is gitignored; the staged
  diff is scanned for secret-shaped strings before every commit).
- The vector store contains only redacted text; raw documents are read
  from disk at ingest and not persisted elsewhere.
