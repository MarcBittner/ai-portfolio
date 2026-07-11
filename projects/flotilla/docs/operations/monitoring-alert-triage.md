# Runbook: Monitoring alert triage

**TL;DR** — A monitor fired. A monitor watches a *selector* (an instance, a type, a
service, a URL, or the whole fleet) that fans out to concrete **targets**, and it holds
one committed health state per target: `ok` · `warn` · `crit` · `unknown`
(`lib/models/monitoring/types.ts:L17`). A page means a target *committed* a hard
transition that cleared the notify floor + silence/timeperiod/master gates. Triage is
three moves: (1) read the monitor and its last per-target result, (2) decide **real
breach vs `unknown`** (couldn't-check ≠ down), (3) either fix the target, silence the
noise, or **ack** the incident to stop escalation. Nothing pages until an operator turns
two flags on — the whole subsystem is **off by default**
(`lib/models/config.ts:L182`, `monitoring: false`), and delivery additionally needs the
`notifications` master flag + a webhook (`lib/notify.ts:L4`).

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned · ⚠️ caveat

![Monitoring view](../screenshots/ui/app-monitoring.png)

*The monitoring view — check state to triage a WARN/CRIT alert.*

---

## Symptom

You land here from one of three surfaces, all driven by the same per-target state store:

- **A monitor shows WARN/CRIT/UNKNOWN** on the Monitoring tab (rollup:
  `GET /api/monitoring/overview`, `app/api/monitoring/overview/route.ts:L8`).
- **A digest** in Slack or email — one rolled-up message *per monitor per run*, e.g.
  `:rotating_light: *disk pressure* — web-1, web-2 CRIT (2/10)`
  (`lib/monitoring/alert.ts:L1`, formatter at `L49`). Never one page per target.
- **An escalation page** — `ESCALATION (tier N)` / `STILL CRIT (tier N)` from the
  escalation sweep for an unacked, still-hard-CRIT incident
  (`lib/monitoring/escalate.ts:L316`).

The four states are Nagios-style, and **`unknown` is deliberately distinct from `crit`** —
the check could not run or had no data (honest, not a false alarm)
(`lib/models/monitoring/types.ts:L15`). Note `unknown` ranks *with* `warn` in the severity
order (`SEVERITY_RANK`, `types.ts:L23`), so a default `warn` floor pages on lost data too.

---

## Preconditions & blast radius

- **Feature-flagged OFF by default.** With `monitoring` off, the cron scheduler no-ops and
  every `/api/monitoring/**` route 403s (`lib/models/config.ts:L148`; env override
  `FLOTILLA_FEATURE_MONITORING`, `config.ts:L201`). If you see *no* data at all, confirm the
  flag before chasing a "silent monitor."
- **Delivery is double-gated on top of that.** A page also needs the `notifications`
  master flag ON *and* a configured `notifyWebhookUrl` for Slack
  (`lib/notify.ts:L4`, `L134`); email additionally needs Gmail creds + at least one enabled
  recipient (`lib/monitoring/alert.ts:L181`). A missing target degrades to a **logged
  no-op**, never a throw — check `GET /api/monitoring/history` to see *why* a page didn't land.
- **State is per target; alerts roll up per monitor.** A CRIT on a `fleet`/`instanceType`
  selector means *at least one* resolved target is hard-CRIT — the `(2/10)` ratio in the
  digest is `crit-count / target-count` (`alert.ts:L71`). Read the per-target rows before
  assuming the whole fleet is down.
- **A CRIT implies a *committed* (hard) state**, not one bad sample. A differing result must
  repeat `retries` consecutive times to commit — default **3** at the monitor's interval,
  default **300 s** (`types.ts:L124`, `L127`; state machine `stateMachine.ts:L37`). So a
  born-CRIT monitor pages only after `retries` consecutive CRITs (the transient/flap filter).
- **Two crons, both every 5 min**, both `CRON_SECRET`-gated and fail-closed
  (`vercel.json:L9`): `/api/monitoring/run` (evaluate due monitors + fold in escalation)
  and `/api/monitoring/escalate` (finer-cadence escalation only). Running both is safe —
  incidents carry a per-tier cursor so a double tick can't double-page (`escalate.ts:L1`).

---

## Diagnosis

Operator routes are `write`/`read` session-gated (`withOperator`); run these from an
operator session (browser dev-tools `fetch`, or curl with your session cookie). The two
**cron** routes take `Authorization: Bearer $CRON_SECRET` instead.

1. **Read the fleet rollup — find which monitor + how many targets.**
   ```bash
   curl -s https://<dashboard-host>/api/monitoring/overview | jq '.totals, .monitors[] | select(.counts.crit > 0 or .counts.warn > 0 or .counts.unknown > 0)'
   ```
   Each row carries `counts`, `lastRunAt`, `nextRunAt`, and the monitor's `notify` config
   (`app/api/monitoring/overview/route.ts:L23`). A stale `lastRunAt` (≫ `intervalSec` ago)
   points at the scheduler, not the target — jump to step 6.

2. **Read the monitor's last per-target result** — the `lastOutput` string is the one-line
   verdict, e.g. `p95=812ms > 500ms → crit` or `no samples for … in last 300s`. It lives in
   the per-target state doc (`MonitorTargetStateDoc.lastOutput`, `types.ts:L165`; written by
   `evaluate.ts:L96`). The alert **history** log shows the same summary per delivery attempt:
   ```bash
   curl -s "https://<dashboard-host>/api/monitoring/history?monitorId=<mon_id>&limit=20" | jq '.alerts[] | {at, kind, channel, state, ok, reason, summary}'
   ```
   (`app/api/monitoring/history/route.ts:L7`). `ok:false` + a `reason` tells you a *delivery*
   problem (webhook/recipients/timeperiod/master-flag), not a target problem.

3. **Distinguish a REAL breach from `unknown` (couldn't-check).** This is the key fork.
   An `unknown` is *never* a false CRIT — the handler returns it when it could not determine
   the answer, and the raw `error` field says why:
   - **metric_threshold** → `unknown` when the metric store isn't configured
     (`metricThreshold.ts:L82`), the query fails (`L131`), or there are **no samples** in the
     window (`L121`). A breach is only ever reported against real data; non-breach is `ok`,
     no-data is `unknown` (`L22` comment). ⚠️ *No data ≠ healthy* — an `unknown` here often
     means the metric pipeline (observability poll) stopped, not that the target is fine.
   - **http_reachability** → a network error/timeout is `unknown` (`httpReachability.ts:L136`);
     a *reachable-but-wrong* status is `crit`/`warn` (`L129`). A custom-URL target that
     resolves to a private/loopback/metadata address is **blocked → `unknown`** by the SSRF
     guard (`L114`, `isBlockedHost` at `L82`) — that's a misconfigured monitor, not an outage.
   - **instance_status** → maps the instance's own lifecycle: `failed`/health `down` → CRIT,
     health `degraded` or `pending`/`provisioning` → WARN, `ready`/`archived` → OK, and **no
     instance resolved → `unknown`** (`instanceStatus.ts:L28`). An `unknown` here usually
     means the target selector points at an instance that no longer exists.

4. **Confirm the CRIT is committed, not a soft candidate mid-flight.** Only a soft→hard
   *commit* produces a transition/page (`stateMachine.ts:L58`). In the state doc, `softCount`
   > 0 with an unchanged `status` means a candidate is still counting up toward `retries` — it
   has *not* paged yet. `since` is when the current hard status began (`types.ts:L164`).

5. **Check the target directly** to corroborate `lastOutput`. For an `instance_status` CRIT,
   open the instance in the dashboard (status/health). For `http_reachability`, hit the URL
   yourself (`curl -sSI <url>`) — remember instance targets hit their own managed URL; a
   custom-`url` target uses the literal (`httpReachability.ts:L31`). For `metric_threshold`,
   pull the same metric/window on the observability tab and eyeball the aggregation
   (`agg`/`windowSec`/`comparator`/`value` from the monitor's params).

6. **Rule out the scheduler / gates when the *symptom* is silence or staleness.**
   - `monitoring` flag off ⇒ nothing runs (step in Preconditions).
   - A due monitor didn't run this tick: the sweep is **time-boxed** and defers leftovers to
     the next tick (`lib/monitoring/scheduler.ts:L58`) — a large fleet catches up, it doesn't
     drop. It also advances the cursor even on a per-monitor error so one flaky monitor can't
     wedge the sweep (`scheduler.ts:L77`).
   - A transition happened but no page: check the gate order in `dispatchAlerts` — monitor
     `notify.enabled` opt-out (`alert.ts:L123`), severity floor + active silence (`L127`),
     outside notification timeperiod (`L142`), master `notifications` flag off (`L169`), or
     Slack has no webhook / email has no recipients (`L178`). Every one of these is **logged**
     to history with a `reason` — step 2 shows it.

---

## Remediation

1. **Acknowledge the incident** (stops escalation + re-notify, keeps the check running).
   Ack is the ownership signal — the escalation sweep skips acked incidents until they
   close on recovery (`app/api/monitoring/alerts/[id]/ack/route.ts:L14`; halt at
   `escalate.ts:L262`). It's `write`-gated and audited.
   ```bash
   curl -s -X POST "https://<dashboard-host>/api/monitoring/alerts/<incident_id>/ack" \
     -H 'content-type: application/json' -d '{"note":"investigating — MB"}'
   ```

2. **Silence the noise** when the alert is known/expected (maintenance, a flapping target,
   a monitor you're about to fix). A silence suppresses *dispatch* only — **checks still run
   and state still advances** (honest state, quiet pager) (`lib/models/monitoring/silences.ts:L4`).
   Scope it as narrowly as possible: `all`, per-monitor, or per-`(monitor,target)`
   (precedence in `isSilenced`, `silences.ts:L48`). `durationMinutes:0` = open-ended until
   cancelled.
   ```bash
   # Silence one target on one monitor for 2 hours
   curl -s -X POST https://<dashboard-host>/api/monitoring/silences \
     -H 'content-type: application/json' \
     -d '{"monitorId":"<mon_id>","targetId":"<target_id>","durationMinutes":120,"reason":"maint window"}'
   ```
   (`app/api/monitoring/silences/route.ts:L22`.) Delete the silence to re-arm:
   `DELETE /api/monitoring/silences/<sil_id>`.

3. **Fix the target**, then confirm recovery. Recovery is automatic: when the target's check
   returns `ok` and commits, the state machine emits a `warn|crit → ok` transition that the
   alerter reports as *recovered* (`stateMachine.ts:L79` — only a prior **alerted** state
   recovers; an `unknown→ok` init does **not** page), and the escalation sweep **closes** the
   incident on the next tick, clearing its cursor + ack (`escalate.ts:L256`).

4. **Re-run the check now** instead of waiting for the next 5-min tick — evaluates the light
   check inline, advances state, and dispatches any resulting digest:
   ```bash
   curl -s -X POST "https://<dashboard-host>/api/monitoring/monitors/<mon_id>/run" | jq '.counts, .outcomes'
   ```
   (`app/api/monitoring/monitors/[id]/run/route.ts:L14`.) Or trigger the whole sweep via the
   cron route (needs the secret):
   ```bash
   curl -s "https://<dashboard-host>/api/monitoring/run" -H "Authorization: Bearer $CRON_SECRET" | jq '.evaluated, .escalation'
   ```

5. **Understand the escalation tiers** you're racing against. For a CRIT with an escalation
   policy attached, each tier fires `afterMinutes` after the incident opened *while still
   unacked* and pages that tier's contact-group; an optional `repeatEveryMinutes` re-pages the
   current tier (`lib/models/monitoring/policies.ts:L14`; decision at
   `escalate.ts:L50`). With **no** policy, the sweep does a bounded direct re-notify over the
   monitor's own channels every `FLOTILLA_MONITOR_RENOTIFY_MINUTES` (default **60**,
   `escalate.ts:L36`). Either way a hard cap of **50 pages per incident** guards against a
   runaway loop (`escalate.ts:L43`). **Ack (step 1) stops the clock** on all of this.

---

## Escalation

The escalation model is a per-incident state machine layered over the per-target state:

- An **incident** is one open, hard-CRIT alert on a single `(monitorId, targetId)`, keyed
  deterministically so a re-open converges on one row (`lib/models/monitoring/incidents.ts:L15`).
  The sweep opens one for every target currently in hard-CRIT (`escalate.ts:L230`).
- A page fires only if **all** of: incident still hard-CRIT · **not** acked · **not** silenced ·
  master `notifications` flag ON · (if set) inside the notification timeperiod · under the
  50-page cap (`escalate.ts:L11`, gates at `L256`–`L278`).
- **Policies** = an ordered ladder of tiers, each pointing at a **contact-group** (Slack
  webhooks + emails) resolved at page time; tiers are stored ascending by `afterMinutes`
  (`policies.ts:L1`). Tier 0 with `afterMinutes:0` is *covered by the initial digest* and is
  not double-paged (`escalate.ts:L298`). The sweep advances **one tier per sweep** so a
  missed-sweep catch-up still pages each intermediate on-call (`escalate.ts:L61`).
- **Recovery closes** the incident and clears ack + cursor; a later re-CRIT mints a fresh
  incident (`escalate.ts:L256`, `incidents.ts:L108`).

For *who owns which tier / contact-group* and the trust boundaries around operator-write vs
cron auth, see **[../SECURITY.md](../SECURITY.md)** (trust boundaries, RBAC map,
secrets/retention). Both cron entrypoints fail **closed** on a missing/mismatched
`CRON_SECRET` (constant-time compare, `app/api/monitoring/run/route.ts:L31`).

---

## Prevention

- **Tune thresholds, not the pager.** If a `metric_threshold` monitor flaps, widen its
  `windowSec` or pick a smoothing aggregation (`avg`/`p95`) instead of `last` — the check
  queries the series at 1-minute resolution so `max` catches transient spikes and `avg` hides
  them (`metricThreshold.ts:L88`). Raise `retries` to demand more consecutive breaches before
  a hard commit (`types.ts:L127`; effect at `stateMachine.ts:L58`).
- **⚠️ `metric_threshold` UNKNOWN footgun.** No-data / store-down returns `unknown`, and
  because `unknown` ranks with `warn` it *will* page at the default floor
  (`types.ts:L23`). That's intentional (a dead metric pipeline is worth knowing), but it means
  a broken observability poll shows up as monitor `unknown`, **not** as a target outage — fix
  the pipeline, don't retune the monitor. Raise `severityFloor` to `crit` only if you truly
  want to ignore lost data for that monitor (`notify.severityFloor`, `types.ts:L108`).
- **⚠️ Custom-URL SSRF blocks read as UNKNOWN.** A `url`-selector monitor pointed at a
  private/loopback/metadata host is blocked before the fetch and reported `unknown`
  (`httpReachability.ts:L114`) — that's a monitor misconfiguration masquerading as a target
  problem. Point HTTP monitors at instance targets (which hit their own managed URL, exempt
  from the guard) or at genuinely public URLs.
- **⚠️ `unknown` on `instance_status` = stale selector.** It means the selector resolved no
  instance (`instanceStatus.ts:L28`) — usually a monitor still watching a torn-down instance.
  Prefer `instanceType`/`all` selectors that self-heal as the fleet changes, or delete the
  orphaned monitor.
- **Prune stale silences.** Expired silences are left for manual cleanup, not auto-reaped
  (`silences.ts:L27`) — `GET /api/monitoring/silences` lists active + expired; delete the ones
  you no longer need so they don't hide a real future alert.
- **After any change, watch one full cycle** (≤ 5 min) via `GET /api/monitoring/history` to
  confirm the expected `alert`/`resolved`/`escalation`/`ack` rows land with `ok:true`.

---

**Related:** [operations README](./README.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [CAPABILITY-MAP](../CAPABILITY-MAP.md)
