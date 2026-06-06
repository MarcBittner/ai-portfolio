# persona-twin — Claude Code Prompts

## Section 1: Development Task Prompts

### Standing rules (apply to every session)

- This is a monorepo: portfolio-level spec/plan live in `docs/spec/`;
  each project is self-contained under `projects/<name>/` with its own
  `docs/spec/spec.md` + `development-plan.md`.
- Work phase-by-phase against the active project's development plan
  (currently `projects/persona-twin/docs/spec/development-plan.md`);
  update its checkboxes — and the portfolio plan's phase list — as tasks
  complete.
- Commit style: `(task) description` — e.g. `(chunking) fixed-size chunker
  with overlap and provenance`. Commit per coherent unit.
- **Before every commit:** scan the staged diff for secret-shaped strings
  (key prefixes, connection strings with credentials, private-key blocks);
  refuse to commit on a hit.
- Synthetic, fictional data only. No personal data, no scraped content.
- The offline path (mock LLM, hash embedder, in-memory store) is a
  first-class mode — every feature must work without a `.env`.

### Next task prompt

```
Continue persona-twin. Read projects/persona-twin/docs/spec/spec.md and
projects/persona-twin/docs/spec/development-plan.md, find the first
unchecked task, and implement it following the standing rules. Keep
`make test` green.
```

---

## Section 2: State Transfer Prompts

**Last Updated:** 2026-06-06

**Project Status:** Phase 0 complete (bootstrap + spec docs). Next: Phase 1
(project skeleton — pyproject, package layout, Makefile, test scaffold).

### Resume Prompt for Next Session

You are resuming work on **persona-twin** — a public, MIT-licensed
reference implementation of RAG, HEXACO persona twins, multi-provider LLM
routing, and layered LLM evaluation, runnable offline with zero paid
accounts.

1. Read `docs/spec/spec.md` (requirements) and
   `docs/spec/development-plan.md` (task list with checkboxes)
2. Credentials, if any, live in `docs/spec/untracked/credentials.md`
   (gitignored — never commit)
3. Implement the next unchecked task; follow the standing rules in §1
