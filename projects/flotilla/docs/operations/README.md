# Operations & runbooks

Operational playbooks for running flotilla in production — one runbook per failure mode
or recurring task. Each follows a consistent shape so it is fast to use.

> This is an **operator** dashboard: most of these runbooks are about the *managed instances* it
> provisions, not just the dashboard app itself.

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned · ⚠️ caveat

## Runbooks

| Runbook | Use when | Status |
|---|---|---|
| [provisioning-failure.md](./provisioning-failure.md) | A provision/refresh job fails or stalls | ✅ |
| [snapshot-restore.md](./snapshot-restore.md) | You need to restore an instance from a snapshot | 🔭 |
| [monitoring-alert-triage.md](./monitoring-alert-triage.md) | A monitor fires WARN/CRIT or escalates | ✅ |
| [break-glass-login.md](./break-glass-login.md) | The Clerk auth gate is unavailable | ✅ |
| [deploy.md](./deploy.md) | Deploying the dashboard + worker + crons | ✅ |

## Runbook shape

Each failure-mode runbook uses the same sections:

1. **Symptom** — the alert, dashboard state, or log line that brings you here.
2. **Preconditions & blast radius** — what is affected and who else is impacted.
3. **Diagnosis** — numbered, copy-paste commands to confirm the cause.
4. **Remediation** — the primary fix, plus rollback if it goes wrong.
5. **Escalation** — who to page (see [SECURITY](../SECURITY.md)).
6. **Prevention** — how to stop it recurring.

See also: [ARCHITECTURE](../ARCHITECTURE.md) · [CAPABILITY-MAP](../CAPABILITY-MAP.md) · [SECURITY](../SECURITY.md).
