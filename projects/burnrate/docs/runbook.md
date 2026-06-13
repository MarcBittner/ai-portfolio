# Runbook — outreach service error-budget burn

One page. A stranger on-call should be able to execute this at 3am. `$URL` is the
service base URL.

## Alert
`BurnrateErrorBudgetFastBurn` — availability error budget burning **>14.4×** over
**1h AND 5m** (multiwindow; see `deploy/k8s/prometheusrule.yaml`). Page fires;
budget would be exhausted in ~2 days at this rate. The slow-burn twin
(`...SlowBurn`, 3× over 6h+30m) files a **ticket**, not a page.

## 1. Confirm (≈30s)
```sh
curl -s $URL/slo | jq '.availability, .burn_policy, .overall_status'
```
- `burn_policy.action` = `page` (fast + slow windows both firing) and
  `availability.status` = `burning`/`exhausted` → real.
- `burn_policy.action` = `none` and `overall_status` = `healthy` → likely a flapping
  alert; snooze and file a ticket against the rule, do not stay paged.

## 2. Triage (≈2m)
```sh
curl -s $URL/metrics | grep -E '^burnrate_(requests|error_budget|burn_rate)'  # RED + budget
curl -s $URL/slo | jq '{error_rate: (1 - .availability.sli), p95: .latency.p95_ms}'
curl -s $URL/tasks | jq '{backend, queue_depth}'   # is the TaskTiger queue backed up?
```
Decide the dominant failure: 5xx spike (availability) vs slow responses
(`latency.status=violated`, high `p95_ms`).

## 3. Mitigate (fastest safe lever first)
- **Bad deploy?** roll back — the CD gate normally does this automatically, but to
  do it by hand:
  ```sh
  argocd app rollback burnrate        # previous healthy revision (≈ minutes)
  # or: kubectl -n burnrate rollout undo deployment/burnrate
  ```
- **Upstream dependency failing?** shed load / disable the failing path. In this
  demo the injected fault is the stand-in for that upstream:
  ```sh
  curl -s -XPOST $URL/admin/inject -H 'content-type: application/json' -d '{"error_rate":0,"latency_ms":0}'
  ```

## 4. Verify recovery
```sh
curl -s -XPOST $URL/admin/loadtest -H 'content-type: application/json' -d '{"n":300}' | jq '.overall_status, .burn_policy.action'
curl -s $URL/slo | jq '.availability.budget_remaining'   # should climb back
cd projects/burnrate && ./run.sh smoke --url $URL         # contract green
```
Resolve the page only when `overall_status` is `healthy`, `burn_policy.action` is
`none`, and the smoke suite passes.

## 5. Comms & follow-up
- Post status in the incident channel at confirm, mitigate, and resolve.
- File the postmortem: timeline, budget spent, root cause, and the alert/threshold
  or guardrail change that prevents a repeat. Budget spent informs whether the next
  release freezes (budget exhausted) or proceeds.
- Optional: `POST $URL/incident/summary` drafts the summary + severity + these steps
  from the live snapshot (LLM, with a deterministic offline fallback).
