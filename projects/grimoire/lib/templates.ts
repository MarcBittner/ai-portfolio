// Document templates for the "new doc" flow.
//
// Pure module — no React, no server imports. Markdown is the source of truth in
// this wiki, so each template body is a genuinely useful scaffold: headings,
// sections, placeholder prompts, and YAML front-matter (with `status: draft`
// where a doc has a lifecycle). The picker seeds the editor with `body`.

export interface DocTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
}

export const TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Start from an empty page.",
    body: "",
  },
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Agenda, discussion, decisions, and action items.",
    body: `---
title: Meeting notes — <topic>
date: <YYYY-MM-DD>
attendees: []
tags: [meeting]
---

# <Topic> — Meeting notes

**Date:** <YYYY-MM-DD>
**Attendees:** <names>
**Facilitator:** <name>
**Note-taker:** <name>

## Agenda

1. <item>
2. <item>

## Discussion

- <key point>
- <key point>

## Decisions

- **Decided:** <what was decided and why>

## Action items

- [ ] <owner> — <task> (due <date>)
- [ ] <owner> — <task> (due <date>)

## Follow-ups / parking lot

- <topic deferred to later>
`,
  },
  {
    id: "prd",
    name: "Product requirements (PRD)",
    description: "Problem, goals, users, requirements, and success metrics.",
    body: `---
title: PRD — <feature>
status: draft
owner: <name>
tags: [product, prd]
---

# <Feature> — Product Requirements

> **Status:** Draft · **Owner:** <name> · **Last updated:** <YYYY-MM-DD>

## Summary

One paragraph: what we're building and why now.

## Problem

What user or business problem does this solve? Who feels the pain today?

## Goals

- <goal>
- <goal>

### Non-goals

- <explicitly out of scope>

## Users & use cases

- **Persona:** <who> — <what they're trying to do>
- **Scenario:** <concrete walkthrough>

## Requirements

| # | Requirement | Priority |
|---|-------------|----------|
| 1 | <must-have> | P0 |
| 2 | <should-have> | P1 |
| 3 | <nice-to-have> | P2 |

## UX / design

Link mocks or describe the flow. Call out edge cases and empty/error states.

## Success metrics

- **Primary:** <metric + target>
- **Guardrail:** <metric we must not regress>

## Risks & open questions

- <risk / question>

## Milestones

- [ ] <milestone> — <date>
`,
  },
  {
    id: "design-doc",
    name: "Engineering design doc / RFC",
    description: "Context, proposed design, alternatives, and rollout.",
    body: `---
title: Design — <system or change>
status: draft
author: <name>
reviewers: []
tags: [engineering, rfc]
---

# <System or change> — Design Doc / RFC

> **Status:** Draft · **Author:** <name> · **Reviewers:** <names>

## Context & problem

What exists today and why it needs to change. Include constraints and any
relevant background links.

## Goals / non-goals

**Goals**
- <goal>

**Non-goals**
- <out of scope>

## Proposed design

Describe the approach. Include a diagram or the key data model / API changes.

\`\`\`
<sketch, schema, or interface>
\`\`\`

### Key decisions

- **Decision:** <what> — **because** <rationale>

## Alternatives considered

1. **<Alternative>** — <why not chosen>
2. **<Alternative>** — <why not chosen>

## Impact

- **Performance:** <notes>
- **Security / privacy:** <notes>
- **Backwards compatibility / migrations:** <notes>

## Rollout & testing

- Test plan: <unit / integration / manual>
- Rollout: <flags, phased, backfill>
- Observability: <metrics, logs, alerts>

## Open questions

- <question>
`,
  },
  {
    id: "runbook",
    name: "Runbook",
    description: "On-call steps to diagnose and resolve an incident.",
    body: `---
title: Runbook — <service or alert>
status: draft
owner: <team>
tags: [runbook, oncall]
---

# <Service / alert> — Runbook

> **Owner:** <team> · **Severity:** <SEV level> · **Last verified:** <YYYY-MM-DD>

## When this fires

What alert or symptom brings you here, and what it means.

## Impact

Who / what is affected when this is broken.

## Dashboards & links

- Dashboard: <link>
- Logs: <link>
- Related services: <link>

## Diagnose

1. Check <first signal>.
2. Look at <dashboard / query>.
3. Confirm <hypothesis>.

## Mitigate

1. <first safe action to reduce impact>
2. <secondary action>

\`\`\`bash
# common commands
<command>
\`\`\`

## Escalate

- Primary on-call: <who / how>
- Secondary / owning team: <who / how>

## After the incident

- [ ] File / update incident notes
- [ ] Capture follow-up action items
- [ ] Update this runbook if steps were wrong
`,
  },
  {
    id: "how-to",
    name: "How-to guide",
    description: "Step-by-step instructions to accomplish a task.",
    body: `---
title: How to <do the thing>
tags: [guide, how-to]
---

# How to <do the thing>

A short sentence on what you'll accomplish by following this guide.

## Prerequisites

- <access / tool / knowledge you need first>
- <prerequisite>

## Steps

1. **<First step>** — <details>
2. **<Next step>** — <details>
3. **<Next step>** — <details>

\`\`\`bash
# example command, if relevant
<command>
\`\`\`

## Verify it worked

<How to confirm success — expected output or state.>

## Troubleshooting

- **<Symptom>** — <cause and fix>

## See also

- <related doc>
`,
  },
  {
    id: "adr",
    name: "Decision record (ADR)",
    description: "Capture one architectural decision and its rationale.",
    body: `---
title: "ADR-<NNN>: <decision>"
status: proposed
date: <YYYY-MM-DD>
deciders: []
tags: [adr, decision]
---

# ADR-<NNN>: <Decision title>

> **Status:** Proposed <!-- Proposed | Accepted | Superseded by ADR-XXX -->
> **Date:** <YYYY-MM-DD> · **Deciders:** <names>

## Context

The forces at play: the problem, constraints, and what we know. Why does a
decision need to be made now?

## Decision

We will <the choice>.

## Consequences

**Positive**
- <benefit>

**Negative / trade-offs**
- <cost or risk we accept>

## Alternatives considered

- **<Option>** — <why not chosen>
`,
  },
  {
    id: "onboarding",
    name: "Onboarding page",
    description: "Get a new teammate productive in their first weeks.",
    body: `---
title: Onboarding — <team or role>
status: draft
owner: <name>
tags: [onboarding, handbook]
---

# Onboarding — <team / role>

Welcome! This page gets you set up and productive. Work through it top to
bottom; ask your onboarding buddy if anything is unclear.

## Your first day

- [ ] Get accounts & access (<systems>)
- [ ] Join channels: <#channels>
- [ ] Meet your onboarding buddy: <name>
- [ ] Set up your dev environment (see below)

## Set up your environment

1. <clone / install step>
2. <run the app locally>
3. <run the tests>

## How we work

- **Team:** <who does what>
- **Rituals:** <standups, planning, reviews — when>
- **Where things live:** <repos, docs, dashboards>

## Key concepts

- **<Concept>** — <one-line explanation + link>

## Your first week

- [ ] Ship a small change end-to-end
- [ ] Read: <must-read docs>
- [ ] 1:1 with your manager: <name>

## Who to ask

- <topic> → <person / channel>
`,
  },
];

const TEMPLATES_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): DocTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}
