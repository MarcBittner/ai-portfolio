# ai-portfolio — Portfolio Specification

## Overview

**ai-portfolio** is a monorepo of independent, production-grade AI
engineering projects. Each project is self-contained — its own spec,
dependencies, Makefile, tests, and docs — and runnable by a reviewer with
**zero paid accounts** via documented offline fallbacks.

## Repository Structure

```
ai-portfolio/
  LICENSE                      # MIT, covers the whole repo
  README.md                    # portfolio index
  docs/spec/                   # portfolio-level spec + plan (this file)
  projects/
    <project>/                 # one directory per project, self-contained
      README.md
      docs/spec/spec.md        # project specification
      docs/spec/development-plan.md
      Makefile                 # setup / demo / test / eval ...
      pyproject.toml (or equivalent)
      src/  tests/  data/
```

## Projects

| Project | Status | Summary |
|---|---|---|
| [persona-twin](../../projects/persona-twin/) | In development | Query AI digital twins of synthetic HEXACO personas, grounded in retrieved data with citations — RAG pipeline (chunking/embedding/vector search/reranking), multi-provider LLM routing (OpenAI + Anthropic), layered evaluation harness, PII redaction. |

## Shared Conventions (all projects)

### CONV-1: Zero-cost reviewability
Every project runs end to end (`make setup && make demo && make test`) on a
fresh clone with no `.env` and no paid accounts. External services
(databases, LLM providers, caches) activate only when their environment
variables are present.

### CONV-2: No secrets, ever
- Keys/URIs via environment variables from a gitignored `.env`; each
  project commits a placeholder `.env.example` only
- Staged diffs are scanned for secret-shaped strings before every commit;
  a hit blocks the commit

### CONV-3: Synthetic data only
All fixture/persona/document data is fictional and authored for this
repository. No scraped content, no real-person data, no PII in fixtures.

### CONV-4: Engineering hygiene
- Python 3.11+, type hints, `ruff` clean, pinned lean dependencies
- Commit style: `(task) description`, one coherent unit per commit
- Project plans tracked as checkboxes in each project's
  `docs/spec/development-plan.md`
