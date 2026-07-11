# flotilla — Documentation

A control plane for ephemeral preview environments: flotilla provisions, monitors,
refreshes, and tears down isolated app instances across **Vercel + Convex + Clerk**.
This is the documentation index — start here.

> **New here?** Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the mental model, then
> [SECURITY.md](./SECURITY.md) for the trust boundaries and the public-safe guest tier.
> **Looking for the code behind a feature?** Jump to [CAPABILITY-MAP.md](./CAPABILITY-MAP.md).

**Status legend (used across all docs):** ✅ shipped · ◐ partial · 🔭 flag-gated / planned (default off) · ⚠️ caveat

## The docs set

| Doc | What it documents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) ✅ | System shape, layers, the enqueue → worker → compensating-saga lifecycle, cross-cutting concerns, key decisions, gotchas |
| [DATA-MODEL.md](./DATA-MODEL.md) ✅ | MongoDB collections, relationships, the instance lifecycle state machine, retention/TTL, what deliberately does *not* live in the DB |
| [SECURITY.md](./SECURITY.md) ✅ | Trust boundaries, authentication, the four-role RBAC map + the read-only guest tier, provisioning safety guards, PII masking, secrets/retention |
| [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) ✅ | Capability → code index; every route + worker CLI; feature-flag table; shipped vs flag-gated |
| [DECISIONS.md](./DECISIONS.md) ✅ | Architecture decision records — why the request path only enqueues, why blobs live outside the DB, why guards are never flags, and the public-safe guest tier |

## Suggested reading order

1. [Architecture](./ARCHITECTURE.md) — the mental model: enqueue → worker → saga.
2. [Security](./SECURITY.md) — trust boundaries, the RBAC floor, and how a guest is fenced.
3. [Data model](./DATA-MODEL.md) — the collections and the instance lifecycle.
4. [Capability map](./CAPABILITY-MAP.md) — find the code behind any feature.
5. [Decisions](./DECISIONS.md) — the load-bearing "why"s.

## Conventions

Every doc opens with a one-paragraph TL;DR, carries a table of contents when longer than
a screen, prefers inline **ASCII diagrams** over images, uses tables for structured
information, and grounds load-bearing claims in `path:Lnnn` citations so the docs stay
auditable against the code. **When prose and code disagree, the code wins** — treat the
doc as stale. Shipped behavior and flag-gated/planned behavior are always kept apart;
nothing planned is described in the present tense.

Screenshots under [`screenshots/`](./screenshots/) show the product actually running.
