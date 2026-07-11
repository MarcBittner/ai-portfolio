import { z } from "zod";
import { withOperator, ok, bad, safeRead } from "@/lib/api";
import {
  listDashboardUsers,
  getDashboardUserByEmail,
  inviteDashboardUser,
  setDashboardUserRole,
  setDashboardUserDisabled,
  removeDashboardUser,
  countEffectiveSuperAdmins,
  recordAudit,
  ImmutableSuperadminError,
} from "@/lib/models";
import {
  canManageRole,
  canTransitionRole,
  isImmutableSuperadmin,
  isRole,
  normalizeEmail,
  immutableSuperadmins,
  type Role,
} from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/access — the RBAC (dashboard-access role) management surface
// (docs/spec/DESIGN-rbac.md §Role-management API). SECURITY-CRITICAL: this route
// is how operators are granted/revoked access to a tool holding prod credentials.
//
//   GET     (admin+)     → { users, self, role, immutable } for the Access pane.
//   POST    (admin+)     → { action:"invite"  , email, role? }    create + email (grant boundary).
//                          { action:"set-role", email, role }    grant boundary applies.
//                          { action:"disable"/"enable", email }  grant boundary applies.
//   DELETE  (admin+)     → ?email=…                             grant boundary applies.
//
// Grant boundary (operator-confirmed 2026-07-05, lib/rbac canManageRole): admins
// MANAGE non-admin users — grant/revoke read-only & write AND disable/remove them;
// super-admins MANAGE admins; only a super-admin may grant/revoke super-admin.
// Immutable super-admins can never be modified/removed (rejected in the model AND
// re-checked here). A demote/disable/remove can never drop the fleet below one
// super-admin (the two immutable ones always remain — lockout guard).

// GET — the user list + the caller's own role so the UI can gate its controls.
export async function GET() {
  return withOperator(
    (principal) =>
      safeRead("access unavailable", { users: [], immutable: immutableSuperadmins() }, async () =>
        ok({
          users: await listDashboardUsers(),
          self: principal.id,
          role: principal.role,
          immutable: immutableSuperadmins(),
        }),
      ),
    "admin",
  );
}

const InviteBody = z.object({
  action: z.literal("invite"),
  email: z.string().email(),
  role: z.custom<Role>((v) => isRole(v), { message: "invalid role" }).optional(),
});

// Best-effort Clerk invitation email. The DB row created by inviteDashboardUser is
// the SOURCE OF TRUTH for access; Clerk only supplies the sign-in path. It NEVER
// fails the request: Clerk not configured, a network error, or "already invited"
// all degrade to { emailSent:false, emailNote } which the UI surfaces. Only
// attempted when Clerk is configured (CLERK_SECRET_KEY present — same guard
// lib/auth.ts uses).
//
// Clerk best-practice (operator-confirmed 2026-07-05): Clerk is the AAA system, so
// the invite is conditional on whether a Clerk user already exists for this email:
//   • EXISTS  → do NOT createInvitation (Clerk rejects inviting an existing user,
//               and they can already sign in). The dashboard access row is the only
//               thing they were missing → { emailSent:false, alreadyExists:true }.
//   • NEW     → invitations.createInvitation({ ignoreExisting:true }) → Clerk emails
//               a sign-up link; accepting it provisions their Clerk user.
// Existence is probed with users.getUserList({ emailAddress:[…] }) → { data,
// totalCount }. Every Clerk call is wrapped so a probe/send failure degrades to
// emailSent:false rather than failing the grant.
type InviteEmailResult = { emailSent: boolean; emailNote?: string; alreadyExists?: boolean };
async function sendInvitationEmail(email: string): Promise<InviteEmailResult> {
  if (!process.env.CLERK_SECRET_KEY) {
    return { emailSent: false, emailNote: "Clerk not configured" };
  }
  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const clerk = await clerkClient();
    // Does a Clerk user already exist for this email? If so, they can already sign
    // in — skip the invite entirely (createInvitation would reject an existing user).
    const found = await clerk.users.getUserList({ emailAddress: [email] });
    const existingCount = found?.totalCount ?? found?.data?.length ?? 0;
    if (existingCount > 0) {
      return {
        emailSent: false,
        alreadyExists: true,
        emailNote: "user already has a Clerk account — granted access, no invite needed",
      };
    }
    const redirectUrl =
      process.env.NEXT_PUBLIC_APP_URL || process.env.DASHBOARD_URL || "http://localhost:3000";
    // ignoreExisting: a re-invite of an already-invited email is a no-op, not an error.
    await clerk.invitations.createInvitation({ emailAddress: email, redirectUrl, ignoreExisting: true });
    return { emailSent: true };
  } catch (err) {
    return { emailSent: false, emailNote: err instanceof Error ? err.message : "invite email failed" };
  }
}
const SetRoleBody = z.object({
  action: z.literal("set-role"),
  email: z.string().email(),
  role: z.custom<Role>((v) => isRole(v), { message: "invalid role" }),
});
const DisableBody = z.object({
  action: z.union([z.literal("disable"), z.literal("enable")]),
  email: z.string().email(),
});

// POST — gated at admin (the floor for role management). Finer per-action checks
// (grant boundary, super-admin-only disable, immutable, lockout) run inside.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action;

    try {
      if (action === "invite") {
        const { email, role: requestedRole } = InviteBody.parse(body);
        const role: Role = requestedRole ?? "read-only";
        const normalized = normalizeEmail(email);
        if (isImmutableSuperadmin(normalized)) {
          return bad("that email is an immutable super-admin — no invite needed", 400);
        }
        // Grant boundary: the actor may only invite at a role they may administer.
        // An admin may invite read-only/write; a super-admin may invite any role.
        if (!canManageRole(principal.role, role)) {
          await recordAudit(principal.id, "access.denied", normalized, `invite as ${role} exceeds grant boundary`).catch(() => {});
          return bad("insufficient role to invite at that role", 403);
        }
        const user = await inviteDashboardUser({ email: normalized, role, invitedBy: principal.id });
        // Ensure the Clerk sign-in path — best-effort, never fails the request.
        const { emailSent, emailNote, alreadyExists } = await sendInvitationEmail(normalized);
        const auditOutcome = emailSent
          ? " (email sent)"
          : alreadyExists
            ? " (existing Clerk account — no invite sent)"
            : ` (email not sent${emailNote ? `: ${emailNote}` : ""})`;
        await recordAudit(principal.id, "access.invite", normalized, `${role}${auditOutcome}`).catch(() => {});
        return ok({ user, emailSent, emailNote, alreadyExists });
      }

      if (action === "set-role") {
        const { email, role } = SetRoleBody.parse(body);
        const normalized = normalizeEmail(email);
        if (isImmutableSuperadmin(normalized)) {
          return bad("cannot change an immutable super-admin's role", 403);
        }
        const target = await getDashboardUserByEmail(normalized);
        if (!target) return bad("no such dashboard user", 404);
        // Grant boundary: the actor must be able to touch BOTH the current and the
        // new role (revoke current + grant next). This blocks an admin from
        // demoting/promoting an admin or super-admin.
        if (!canTransitionRole(principal.role, target.role, role)) {
          await recordAudit(principal.id, "access.denied", normalized, `set-role ${target.role}→${role} exceeds grant boundary`).catch(() => {});
          return bad("insufficient role to grant/revoke that role", 403);
        }
        if (role === target.role) return ok({ user: target }); // no-op
        // Lockout guard: demoting the last effective super-admin is refused.
        if (target.role === "super-admin" && role !== "super-admin") {
          if ((await countEffectiveSuperAdmins()) <= 1) {
            return bad("cannot demote the last super-admin", 409);
          }
        }
        const user = await setDashboardUserRole(normalized, role);
        if (!user) return bad("no such dashboard user", 404);
        await recordAudit(principal.id, "access.set-role", normalized, `${target.role} → ${role}`).catch(() => {});
        return ok({ user });
      }

      if (action === "disable" || action === "enable") {
        const { email } = DisableBody.parse(body);
        const normalized = normalizeEmail(email);
        if (isImmutableSuperadmin(normalized)) {
          return bad("cannot disable an immutable super-admin", 403);
        }
        const target = await getDashboardUserByEmail(normalized);
        if (!target) return bad("no such dashboard user", 404);
        // Grant boundary (operator policy 2026-07-05): an admin may perform ALL
        // operations on NON-admin users — including disable/enable of a
        // read-only/write user. Disabling an admin or super-admin stays
        // super-admin territory. Same `canManageRole` predicate as set-role and
        // remove, so the three destructive levers share one rule.
        if (!canManageRole(principal.role, target.role)) {
          await recordAudit(principal.id, "access.denied", normalized, `${action} of ${target.role} exceeds grant boundary`).catch(() => {});
          return bad("insufficient role to disable/enable that user", 403);
        }
        const disabled = action === "disable";
        // Lockout guard: disabling the last effective super-admin is refused.
        if (disabled && target.role === "super-admin" && (await countEffectiveSuperAdmins()) <= 1) {
          return bad("cannot disable the last super-admin", 409);
        }
        const user = await setDashboardUserDisabled(normalized, disabled);
        if (!user) return bad("no such dashboard user", 404);
        await recordAudit(principal.id, `access.${action}`, normalized, target.role).catch(() => {});
        return ok({ user });
      }

      return bad("unknown action");
    } catch (err) {
      if (err instanceof ImmutableSuperadminError) return bad(err.message, 403);
      throw err; // ZodError → 400 / else 500 via withOperator's mapping
    }
  }, "admin");
}

// DELETE ?email=… — hard-remove a dashboard user. Floored at admin, then the
// grant boundary (canManageRole) applies: an admin may remove NON-admin users;
// removing an admin/super-admin needs super-admin. Never an immutable super-admin;
// never the last effective super-admin.
export async function DELETE(req: Request) {
  return withOperator(async (principal) => {
    const email = new URL(req.url).searchParams.get("email");
    if (!email) return bad("email required");
    const normalized = normalizeEmail(email);
    if (isImmutableSuperadmin(normalized)) return bad("cannot remove an immutable super-admin", 403);
    const target = await getDashboardUserByEmail(normalized);
    if (!target) return bad("no such dashboard user", 404);
    // Defense in depth (also enforced by canManageRole at set-role): removing an
    // admin/super-admin row is a revoke of that role — super-admin territory.
    if (!canManageRole(principal.role, target.role)) {
      return bad("insufficient role to remove that user", 403);
    }
    if (target.role === "super-admin" && (await countEffectiveSuperAdmins()) <= 1) {
      return bad("cannot remove the last super-admin", 409);
    }
    try {
      const removed = await removeDashboardUser(normalized);
      if (!removed) return bad("no such dashboard user", 404);
    } catch (err) {
      if (err instanceof ImmutableSuperadminError) return bad(err.message, 403);
      throw err;
    }
    await recordAudit(principal.id, "access.remove", normalized, target.role).catch(() => {});
    return ok({ removed: normalized });
  }, "admin");
}
