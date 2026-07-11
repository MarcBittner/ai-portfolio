# flotilla (portfolio) — hard constraints

This project is an **independent backport** of an instance-dashboard app into the
personal ai-portfolio monorepo, as a public showcase. The following are
**non-negotiable constraints**, not implementation details:

## 1. The upstream production deployment stays UNTOUCHED
The upstream instance-dashboard is a **live production system**. This portfolio
version is a one-way copy. **Never** write back to the upstream repo, branch,
deployment target, or database from this project. There is no code path here that
should read or mutate upstream production state.

## 2. This project is ENTIRELY INDEPENDENT
It stands on its own — **its own database, credentials, environment, managed
fleet, and deployment**. It shares **zero** state, secrets, or infrastructure with
the upstream system:

- **Database:** its own (default DB name `flotilla`) — never the upstream cluster.
- **Credentials / env:** its own `.env` — the app is fully env-driven; no upstream
  credentials or project identifiers are hardcoded anywhere.
- **Fleet:** its own configurable target fleet (the portfolio demos), independent
  of any upstream fleet.
- **Deployment:** its own Render service (own `Dockerfile`), independent of any
  upstream Vercel project.

## 3. Public-safe by construction
As a public deployment, an unauthenticated visitor is a **read-only guest**, and
with `FLOTILLA_PUBLIC_READONLY=1` **every** destructive or non-reversible action is
hard-blocked server-side **regardless of role** (a global kill-switch) — so no
public visitor can ever alter or damage the managed fleet.

**Enforcement:** before any commit, verify the tree carries no upstream DB names,
project IDs, domains, or credential references (must be zero).
