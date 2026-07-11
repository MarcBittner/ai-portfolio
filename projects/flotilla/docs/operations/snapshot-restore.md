# Runbook: Restore an instance from a snapshot

**TL;DR** — A "snapshot" is a Convex cloud-backup ZIP. Snapshots live in **GitHub Releases** (the `blobs` release of the private `SNAPSHOT_REPO`), **never in Mongo** — Mongo holds only metadata (`lib/clients/snapshotStore.ts:1`, `lib/clients/snapshotStore.ts:9`). To restore, you pick a snapshot (a live Convex cloud backup, or one already grabbed into the store) and either **create a FRESH instance** from it or **refresh an EXISTING instance** to it. Loading data into a *fresh, tool-provisioned* deployment is safe. Loading into a *pre-existing* deployment **overwrites its data** and requires `dangerAck=true`; **production is a hard block no ack can override** (`lib/executor.ts:164`, `lib/provision.ts:166`).

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned · ⚠️ caveat

🔭 The flow below is implemented in code but not yet exercised as a runbook. ⚠️ Confirm the exact `curl`/UI details against the target deployment before relying on it.

![Backups view](../screenshots/ui/app-backups.png)

*The backups view — choose the snapshot to restore from.*

---

## Symptom

Use this runbook to reset or restore an instance's data from a known-good snapshot:

- A managed preview/staging instance has corrupt, stale, or mistakenly-mutated data and you want to reload a clean snapshot into it.
- You need a fresh instance seeded from a specific point-in-time backup (e.g. reproducing a bug against last night's prod data, PII-masked).
- Someone asks to "refresh staging" to the latest cloud backup — the original staging-refresh use case (`lib/executor.ts:13`).

This is **not** for restoring the dashboard's own Mongo state — snapshots are *managed-instance* application data, not dashboard metadata (`docs/operations/README.md:6`).

---

## Preconditions & blast radius

**Store must be configured.** The snapshot store degrades OFF unless BOTH `GITHUB_TOKEN` and a valid `SNAPSHOT_REPO` (`owner/name`) are set — `snapshotStoreConfigured()` gates every grab/restore (`lib/clients/snapshotStore.ts:36`). Reading the live cloud backup list additionally needs `CONVEX_ACCESS_TOKEN` (`lib/clients/convexBackups.ts:39`).

**Two shapes, very different blast radius** (`lib/executor.ts:9`):

| Target | `createdByTool` | Blast radius | Guard |
|---|---|---|---|
| **FRESH** — new isolated Convex + Vercel deployment | `true` | Nothing pre-existing is touched | none needed |
| **EXISTING** — a pre-selected deployment | `false` | **OVERWRITES that deployment's data** (`replaceAll: true`, `lib/executor.ts:259`) | requires `dangerAck=true` |

**Hard blocks (defense-in-depth, cannot be acked away):**

- **Production Convex deployment** (`prod-deployment-a1b2c3` by default) is refused on both provision and the executor preflight — read-only source only (`lib/deployments.ts:20`, `lib/executor.ts:164`, `lib/provision.ts:166`).
- **The production Vercel project** is refused; shared `staging`/`workspace` projects are danger-gated (`lib/executor.ts:155`).
- An EXISTING target with `ALLOW_OUTBOUND_EMAIL=true` is refused — that flag marks a real production deployment (`lib/executor.ts:196`).
- **PII masking is FORCED on** whenever the snapshot *source* is prod or staging-prod, regardless of `scrubPII` (`lib/executor.ts:77`, `lib/executor.ts:248`). Restoring FROM prod data always masks.

---

## Diagnosis

Find the snapshot you want to restore. The backups API returns the union of **live Convex cloud backups** and **snapshots already grabbed into the GitHub store**, each flagged `stored`/`grabbed` (`app/api/backups/route.ts:15`).

1. **List available snapshots** across all managed deployments (or one):

   ```bash
   # All known deployments (prod, staging-prod, ci, dev — lib/deployments.ts:29)
   curl -s "$FLOTILLA_URL/api/backups" | jq '.backups[] | {deployment, snapshotId, source, stored, createdAt}'

   # Just one deployment as the data SOURCE
   curl -s "$FLOTILLA_URL/api/backups?deployment=doting-barracuda-47" | jq '.backups'
   ```

   Each row carries `deployment` (the SOURCE), `snapshotId`, `source:"cloud"|"upload"`, and `stored:true` when it is already in the GitHub store (`app/api/backups/route.ts:35`). `cloudConfigured:false` means `CONVEX_ACCESS_TOKEN` is unset and only already-grabbed rows will show.

2. **Confirm the store is configured** (blank/`false` here means restores that need a stored blob will fail):

   ```bash
   curl -s "$FLOTILLA_URL/api/backups" | jq '.cloudConfigured'   # Convex cloud list reachable?
   # snapshotStoreConfigured() is server-side; a "GITHUB_TOKEN not configured" error
   # on grab/upload confirms the GitHub store is OFF (app/api/backups/route.ts:107).
   ```

3. **(Optional) inspect the raw GitHub release assets.** Snapshots are assets named `{deployment}_{snapshotId}.zip` on the single `blobs` release (`lib/clients/snapshotStore.ts:11`, `lib/backupSync.ts:27`):

   ```bash
   # The asset id (a number) is the durable blobRef persisted on the backup doc.
   curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$SNAPSHOT_REPO/releases/tags/blobs" \
     | jq '.assets[] | {id, name, size}'
   ```

4. **Note the pair you'll restore FROM:** `backupDeployment` (the source, e.g. `doting-barracuda-47`) + `backupSnapshotId`. The restore reads these; it never writes to `backupDeployment` (`lib/models/instances.ts:37`).

---

## Remediation

The restore/refresh flow runs **async**: the API enqueues a job and returns `{jobId, instanceId}`; the worker (`scripts/worker.ts`) executes it via `executeProvision` (`app/api/instances/route.ts:18`, `lib/executor.ts:123`).

### A) Grab the snapshot into the store first (optional but recommended)

Live-streaming from Convex cloud works, but grabbing first makes the restore faster and repeatable. This is idempotent — an already-stored snapshot is skipped (`lib/backupSync.ts:1`):

```bash
curl -s -X POST "$FLOTILLA_URL/api/backups" \
  -H "Content-Type: application/json" \
  -d '{"action":"grab","deployment":"doting-barracuda-47","snapshotId":"<SNAPSHOT_ID>","cloudBackupId":<N>}'
# or grab every un-stored cloud backup, newest-first, within the request budget:
#   {"action":"grab-all","deployment":"doting-barracuda-47"}
```

At apply time the executor resolves the source by store kind: GitHub asset (`blobRef`) → legacy GridFS (`gridfsId`) → else streams live from Convex cloud (`lib/executor.ts:98`).

### B1) FRESH restore — new isolated instance from the snapshot (safe path)

No `dangerAck` needed; the tool provisions a brand-new Convex + Vercel deployment and loads the snapshot into it (`lib/executor.ts:187`):

```bash
curl -s -X POST "$FLOTILLA_URL/api/instances" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "preview",
    "branch": "main",
    "backupDeployment": "doting-barracuda-47",
    "backupSnapshotId": "<SNAPSHOT_ID>",
    "scrubPII": true
  }'
# convexDeployment omitted / "fresh"  => provision a NEW deployment (nothing pre-existing touched)
```

### B2) EXISTING restore — refresh a pre-existing deployment (DANGER: overwrites)

This **overwrites the target deployment's data** (`replaceAll: true`). It requires `dangerAck:true`; production is refused regardless (`lib/executor.ts:167`, `app/api/instances/route.ts:25`).

- **Create+target** an existing deployment via `POST /api/instances` with `convexDeployment:"<name>"` + `dangerAck:true`.
- **Refresh only the data dimension** of an instance you already have via `PATCH /api/instances/:id` — it re-provisions ONLY the changed dimension (`app/api/instances/[id]/route.ts:21`):

```bash
curl -s -X PATCH "$FLOTILLA_URL/api/instances/<INSTANCE_ID>" \
  -H "Content-Type: application/json" \
  -d '{
    "backupDeployment": "doting-barracuda-47",
    "backupSnapshotId": "<NEW_SNAPSHOT_ID>",
    "dangerAck": true
  }'
```

Without `dangerAck:true` the executor preflight throws before touching anything (`lib/executor.ts:172`).

### What the import step does

Inside `executeProvision`, the `import-data` step (`lib/executor.ts:229`):

1. **Idempotency skip** — if `target.lastImportedSnapshotId === backupSnapshotId` AND the target is tool-created, the import is skipped (`lib/executor.ts:235`, marker defined `lib/models/instances.ts:94`). Re-running the same restore is a no-op.
2. **Open the source** (grabbed blob or live stream) — `openSnapshotSource` (`lib/executor.ts:98`).
3. **Mask PII** if `scrubPII` OR the source is prod/staging-prod (forced) — unzip → mask → re-zip (`lib/executor.ts:255`, `lib/executor.ts:432`); stamps `masked:true`.
4. **Import** with `replaceAll: true` into the target deployment (`lib/executor.ts:259`), then stamp `lastImportedSnapshotId`.
5. **Reset auth ids** — imported prod `authId`s carry prod's Clerk issuer and can never match; rewritten to `pending:<email>` (`lib/executor.ts:265`).
6. **Forward migrations** (default on) — best-effort per migration (`lib/executor.ts:279`).

### Verify

```bash
# Watch the job / instance land on ready and carry the snapshot marker
curl -s "$FLOTILLA_URL/api/instances/<INSTANCE_ID>" \
  | jq '{status, health, lastImportedSnapshotId, masked, convexDeployment, url}'
```

`lastImportedSnapshotId` should equal the snapshot you restored; `masked:true` confirms PII masking ran (expected for any prod/staging-prod source).

### Rollback

There is no in-place undo of an overwrite — the previous data was replaced. To recover, run the restore again pointing at the **prior** snapshot (repeat *Diagnosis* to find it). A FRESH restore leaves the original untouched, so preferring B1 over B2 is itself the rollback strategy.

---

## Escalation

If a restore fails a safety gate you believe is wrong (prod hard-block, `dangerAck` refusal, `ALLOW_OUTBOUND_EMAIL` refusal), or a snapshot appears to contain unmasked prod PII, do **not** work around it — escalate. See [../SECURITY.md](../SECURITY.md) for trust boundaries, the masking contract, and who owns the prod/shared-deployment guards. Related failure modes: [provisioning-failure.md](./provisioning-failure.md).

---

## Prevention

- **Keep the store configured.** A periodic sweep grabs new cloud backups into GitHub Releases so they can't fill the shared Mongo cluster — `syncNewBackups` / the `scripts/sync-backups.ts` cron (`lib/backupSync.ts:1`). Verify it's running; missing snapshots usually mean the sweep is off or `GITHUB_TOKEN`/`SNAPSHOT_REPO` is unset.
- **Prefer FRESH (B1) over EXISTING (B2)** whenever you can — it removes the overwrite blast radius entirely.
- **Trust the idempotency marker.** Re-running a restore with the same `backupSnapshotId` on a tool-created target is a safe no-op (`lib/executor.ts:235`), so retry freely.
- **Never disable masking on a prod-sourced restore** — it is forced for a reason (`lib/executor.ts:248`); a break-glass-gated test env must never receive raw prod identity PII.

---

**Related:** [./README.md](./README.md) · [../ARCHITECTURE.md](../ARCHITECTURE.md) · [../CAPABILITY-MAP.md](../CAPABILITY-MAP.md)
