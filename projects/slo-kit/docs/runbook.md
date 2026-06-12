# Runbook — outreach-API error-budget burn

One page. A stranger on-call should be able to execute this at 3am. `$URL` is the
service base URL.

## Alert
`slo-kit-error-budget-fast-burn` — availability error budget burning **>14.4×**
over 1h (see `deploy/terraform/main.tf`). Page fires; budget would be exhausted in
~2 days at this rate.

## 1. Confirm (≈30s)
```sh
curl -s $URL/slo | jq '.availability, .latency, .overall_status'
```
- `availability.status` = `burning`/`exhausted`, `burn_rate` ≫ 1 → real.
- `overall_status` = `healthy` and burn_rate ≈ 0 → likely a flapping alert; snooze
  and file a ticket against the alert threshold.

## 2. Triage (≈2m)
```sh
curl -s $URL/metrics/snapshot | jq '{error_rate, by_status, p95_ms}'   # what's failing
curl -s "$URL/traces?limit=25" | jq '.spans[] | select(.status=="error")'  # which calls
```
Decide the dominant failure: 5xx spike (availability) vs slow responses
(`latency.status=violated`, high `p95_ms`).

## 3. Mitigate (fastest safe lever first)
- **Bad deploy?** roll back to the previous revision (deploy is gated on the
  post-deploy smoke check; a failed gate already signals this).
- **Upstream dependency failing?** shed load / disable the failing path. In this
  demo the injected fault is the stand-in for that upstream:
  ```sh
  curl -s -XPOST $URL/admin/fault -H 'content-type: application/json' -d '{"error_rate":0,"latency_ms":0}'
  ```

## 4. Verify recovery
```sh
curl -s -XPOST $URL/admin/loadtest -H 'content-type: application/json' -d '{"n":300}' | jq '.overall_status'
curl -s $URL/slo | jq '.availability.budget_remaining'   # should climb back
cd projects/slo-kit && ./run.sh smoke --url $URL          # contract green
```
Resolve the page only when `overall_status` is `healthy` and the smoke suite passes.

## 5. Comms & follow-up
- Post status in the incident channel at confirm, mitigate, and resolve.
- File the postmortem: timeline, budget spent, root cause, and the alert/threshold
  or guardrail change that prevents a repeat. Budget spent informs whether the next
  release freezes (budget exhausted) or proceeds.
