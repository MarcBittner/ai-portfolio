// Guest tier — self-signup users get role `guest` (lib/permissions). A guest can
// read the curated public knowledge base and fully manage ONLY their own personal
// `~` space, but every doc they create is EPHEMERAL: it expires 8 hours after
// creation and is reaped from both stores (lib/reaper). This module holds the pure
// TTL math + the doc-field helpers, so the policy is unit-testable in isolation and
// reused by the create path, the lazy sweep, and the Mongo TTL index.

import type { Role } from "./permissions";
import type { DocRow } from "./repos";

/** A guest doc lives this long from creation. */
export const GUEST_DOC_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Whether a role's docs are ephemeral (expire on the guest TTL). Only `guest`. */
export function isGuestRole(role: Role): boolean {
  return role === "guest";
}

/** Expiry instant (ms epoch) for a doc created by a guest at `createdAt`. */
export function guestExpiryAt(createdAt: number): number {
  return createdAt + GUEST_DOC_TTL_MS;
}

/**
 * The expiry fields to stamp on a doc at creation, given the author's role.
 *   - guest → `{ expiresAt: <ms>, expiresAtDate: <Date> }`. The numeric mirror
 *     drives the in-memory lazy sweep (the source of truth for the local store);
 *     the BSON `Date` backs the Mongo TTL index (which needs a real Date field).
 *   - non-guest → `{}` (never expires).
 * Pure — the caller merges the result into the doc before insert/upsert.
 */
export function guestExpiryFields(
  role: Role,
  createdAt: number,
): { expiresAt?: number; expiresAtDate?: Date } {
  if (!isGuestRole(role)) return {};
  const at = guestExpiryAt(createdAt);
  return { expiresAt: at, expiresAtDate: new Date(at) };
}

/** Whether a doc is a guest doc that has expired by `now`. Non-guest docs (no
 *  `expiresAt`) never expire. */
export function isExpiredGuestDoc(doc: Pick<DocRow, "expiresAt">, now: number): boolean {
  return typeof doc.expiresAt === "number" && doc.expiresAt <= now;
}
