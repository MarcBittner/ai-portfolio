// Personal spaces — one private per-user space, keyed off the owner's email.
//
// PRIVACY MODEL (the whole point): a personal space is created with
// `defaultRole: "none"` (nobody reads it by default) plus a single owner grant
// (`user:<email>` admin allow on the space). The deny-wins resolver in
// lib/permissions then gives the owner full read/edit/admin and denies everyone
// else (no matching grant + closed default) — except Super, who short-circuits
// to allow (existing model). On top of that, the sidebar/listing filter
// (lib/server/data + app/app/layout) drops other users' personal spaces so they
// never render in anyone else's tree, not even a Super Admin's.

import type { Database } from "./db/types";
import { normalizeEmail } from "./authPolicy";
import { repos } from "./repos";
import { invalidatePolicyCache } from "./server/policyCache";

/** Prefix that marks a space key as personal. Deliberately not a legal
 *  top-level repo folder character run, so a personal key can never collide
 *  with a real content folder's space key. */
export const PERSONAL_SPACE_PREFIX = "~";

const clock = () => Date.now();

/**
 * Deterministic, unique-per-email space key for a user's personal space:
 * `"~" + slug`, where slug is the normalized (trimmed, lowercased) email with
 * every run of non-`[a-z0-9]` characters collapsed to a single `-`, and any
 * leading/trailing `-` trimmed. e.g. `Marc.Bittner@example.com` →
 * `~marc-bittner-example-com`.
 */
export function personalSpaceKey(email: string): string {
  const slug = normalizeEmail(email)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return PERSONAL_SPACE_PREFIX + slug;
}

/** Whether a space key is a personal-space key (belongs to *some* user). */
export function isPersonalSpaceKey(key: string): boolean {
  return key.startsWith(PERSONAL_SPACE_PREFIX);
}

/**
 * Sidebar/listing visibility for personal spaces, as a PURE predicate so it is
 * unit-testable in isolation and reused by `listReadableDocs`. A space with the
 * given key is hidden from `viewerEmail`'s tree iff it is a personal space that
 * is NOT the viewer's own — regardless of role. This is defense-in-depth ON TOP
 * OF `canAccess`: it ensures no other user's personal-space doc renders in the
 * tree, not even for a Super Admin (who could still open it via direct access).
 */
export function isPersonalSpaceVisibleTo(spaceKey: string, viewerEmail: string): boolean {
  if (!isPersonalSpaceKey(spaceKey)) return true; // shared space — normal rules apply
  return spaceKey === personalSpaceKey(viewerEmail);
}

/**
 * Ensure the personal space for `email` exists. Idempotent: creates the space
 * row and the owner admin grant only when missing, so repeated logins (or
 * concurrent-ish calls) never produce duplicates. Invalidates the policy cache
 * whenever it inserts anything, so the new grant/space take effect immediately.
 */
export async function ensurePersonalSpace(db: Database, email: string): Promise<void> {
  const owner = normalizeEmail(email);
  const key = personalSpaceKey(owner);
  const r = repos(db);
  let changed = false;

  const existingSpace = await r.spaces.findOne({ key });
  if (!existingSpace) {
    await r.spaces.insert({
      key,
      name: "Personal",
      contentRoot: key,
      defaultRole: "none",
      prWorkflow: false,
      owner,
    });
    changed = true;
  }

  const existingGrant = await r.grants.findOne({
    subjectType: "user",
    subjectId: owner,
    resourceType: "space",
    resourcePath: key,
    capability: "admin",
    effect: "allow",
  });
  if (!existingGrant) {
    await r.grants.insert({
      subjectType: "user",
      subjectId: owner,
      resourceType: "space",
      resourcePath: key,
      capability: "admin",
      effect: "allow",
      createdBy: "system",
      createdAt: clock(),
    });
    changed = true;
  }

  if (changed) invalidatePolicyCache(db);
}
