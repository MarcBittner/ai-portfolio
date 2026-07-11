import { col, ensureIndexesFor, newId, now, NO_ID } from "./base.ts";

// flotilla_audit — the accounting trail. Every MUTATING route records who (actor)
// did what (action) to which resource (target), with optional structured detail.
// This is attribution the security review flagged as missing (flat-privilege +
// break-glass): the async job log says what the ENGINE did; this says which
// OPERATOR asked for it. Append-only; read back by GET /api/audit for the UI's
// activity feed.
export type AuditDoc = {
  id: string;
  // Monotonic per-process sequence so entries sharing a ts still order correctly.
  seq: number;
  ts: number;
  actor: string; // principal.id (break-glass email or allowlisted Clerk email)
  action: string; // e.g. "instance.launch", "backup.delete", "instance.teardown"
  target: string; // the resource acted on (instance id/name, backup id, …)
  detail?: string; // short human-readable context
};

let seqCounter = 0;

// Record one audit entry. Best-effort by contract at the call sites (a failed
// audit write must never break the mutation it describes) — callers `.catch()`.
export async function recordAudit(
  actor: string,
  action: string,
  target: string,
  detail?: string,
): Promise<AuditDoc> {
  const c = await col<AuditDoc>("audit");
  const doc: AuditDoc = { id: newId("aud"), seq: ++seqCounter, ts: now(), actor, action, target, detail };
  await c.insertOne(doc);
  return doc;
}

// Most-recent-first audit entries for the activity feed.
export async function listAudit(limit = 200): Promise<AuditDoc[]> {
  await ensureIndexesFor("audit");
  const c = await col<AuditDoc>("audit");
  return c.find({}, NO_ID).sort({ ts: -1, seq: -1 }).limit(limit).toArray();
}
