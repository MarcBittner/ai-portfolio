"use server";

import { randomUUID } from "node:crypto";

import { repos, type NotificationRow } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

// In-app notifications — a per-user inbox. Reads/writes are always scoped to the
// signed-in principal: you only ever see or mutate your OWN rows. Rows are created
// by other server actions (comments/@mentions, suggestion accept/reject) via the
// `notify` helper below, and — critically — the CALLER is responsible for confirming
// the recipient may READ the referenced doc BEFORE calling `notify`, so a doc path or
// name can never leak to someone without read access.

const CAP = 50;

/** The client-facing shape (never exposes internal fields like _id). */
export interface NotificationView {
  id: string;
  kind: NotificationRow["kind"];
  message: string;
  path: string;
  actorEmail?: string;
  read: boolean;
  createdAt: number;
}

function toView(n: NotificationRow): NotificationView {
  return {
    id: n.id,
    kind: n.kind,
    message: n.message,
    path: n.path,
    actorEmail: n.actorEmail,
    read: n.read,
    createdAt: n.createdAt,
  };
}

/**
 * Insert a notification row. INTERNAL helper — exported so sibling server actions
 * (comments, suggestions) can emit. SECURITY: this does NOT authorize; the caller
 * MUST confirm the recipient can READ `path` before calling, because `message`/`path`
 * reference a doc. Best-effort: callers wrap invocations in try/catch so a failed
 * emit never fails the originating action.
 */
export async function notify(input: {
  email: string;
  kind: NotificationRow["kind"];
  message: string;
  path: string;
  actorEmail?: string;
}): Promise<void> {
  const database = await db();
  const row: NotificationRow = {
    id: randomUUID(),
    email: input.email,
    kind: input.kind,
    message: input.message,
    path: input.path,
    actorEmail: input.actorEmail,
    read: false,
    createdAt: Date.now(),
  };
  await repos(database).notifications.insert(row);
}

/** The current user's notifications, newest first, capped at 50. Re-authorized at
 *  READ time: a notification referencing a doc the user can no longer read is
 *  hidden, so a doc path/name never lingers after access is revoked. */
export async function listNotifications(limit = CAP): Promise<NotificationView[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const database = await db();
  const readable = new Set((await listReadableDocs()).map((d) => d.path));
  const rows = await repos(database).notifications.find({ email: principal.email });
  const cap = Math.min(Math.max(1, limit), CAP);
  return rows
    .filter((n) => readable.has(n.path))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap)
    .map(toView);
}

/** Number of unread notifications for the current user (0 if signed out). Counts
 *  only those still referencing a readable doc (consistent with listNotifications). */
export async function unreadCount(): Promise<number> {
  const principal = await currentPrincipal();
  if (!principal) return 0;
  const database = await db();
  const readable = new Set((await listReadableDocs()).map((d) => d.path));
  const rows = await repos(database).notifications.find({ email: principal.email, read: false });
  return rows.filter((n) => readable.has(n.path)).length;
}

/** Mark one of the current user's own notifications read. Never touches others' rows. */
export async function markRead(id: string): Promise<boolean> {
  const principal = await currentPrincipal();
  if (!principal) return false;
  const database = await db();
  // Filter by recipient email so a user can only mutate their OWN notifications.
  const modified = await repos(database).notifications.update(
    { id, email: principal.email },
    { read: true },
  );
  return modified > 0;
}

/** Mark all of the current user's own notifications read. */
export async function markAllRead(): Promise<boolean> {
  const principal = await currentPrincipal();
  if (!principal) return false;
  const database = await db();
  await repos(database).notifications.update(
    { email: principal.email, read: false },
    { read: true },
  );
  return true;
}
