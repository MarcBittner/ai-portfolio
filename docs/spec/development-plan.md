# ai-portfolio — Portfolio Development Plan

## Overview

Portfolio-level tracking only. Each project carries its own detailed,
checkboxed plan at `projects/<name>/docs/spec/development-plan.md`.

**Legend:** `[x]` completed ✅ · `[>]` in progress 🔄 · `[ ]` pending ⏳

---

## Repository

- [x] Bootstrap: MIT LICENSE, .gitignore, first commit
- [x] Portfolio spec + monorepo layout (`projects/` per-project)
- [ ] Root README portfolio index (grows as projects land)

## Project 1: persona-twin 🔄

Digital twins of synthetic HEXACO personas — RAG, multi-provider routing,
layered evaluation. Detailed plan:
[projects/persona-twin/docs/spec/development-plan.md](../../projects/persona-twin/docs/spec/development-plan.md)

- [x] Phase 0: bootstrap + spec
- [ ] Phase 1: project skeleton
- [ ] Phase 2: chunking module
- [ ] Phase 3: embeddings + vector stores
- [ ] Phase 4: synthetic corpus + PII redaction
- [ ] Phase 5: LLM providers + routing
- [ ] Phase 6: persona twins + FastAPI service
- [ ] Phase 7: evaluation harness
- [ ] Phase 8: polish + v0.1.0
- [ ] Phase 9 (optional): frontend
- [ ] Phase 10 (optional): deployment

## Project 2+ (future)

- [ ] To be specified — candidates: agent orchestration patterns, eval
      tooling extracted as a library, streaming inference service

---

**Last Updated:** 2026-06-06
