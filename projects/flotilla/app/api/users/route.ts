import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { loadClerkUserClient } from "@/lib/loaders";
import {
  listManagedUsers,
  upsertManagedUser,
  recordUserAction,
  getInstance,
  recordAudit,
} from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Production / staging-prod Clerk instances are NEVER valid targets for user
// mutations (create / reset-password / set-username / sign-in-link) — otherwise
// this route becomes a production account-takeover primitive (mint a sign-in
// link or reset the password for any real user). Only per-instance dev/test
// Clerk instances may be managed here. Env-driven (comma-separated), no org
// hardcoded — set SENSITIVE_CLERK_INSTANCES to your prod/staging Clerk hostnames.
// Read at CALL TIME so the env override actually takes effect at runtime.
function sensitiveClerkInstances(): string[] {
  return (process.env.SENSITIVE_CLERK_INSTANCES || "").split(",").map((s) => s.trim()).filter(Boolean);
}
function clerkTargetBlocked(clerkInstance?: string): boolean {
  if (!clerkInstance) return false;
  const c = clerkInstance.toLowerCase();
  return sensitiveClerkInstances().some((s) => c === s.toLowerCase() || c.includes(s.toLowerCase()));
}

// GET /api/users?instanceId=... — per-instance managed users (B-6).
export async function GET(req: Request) {
  const instanceId = new URL(req.url).searchParams.get("instanceId") ?? undefined;
  return withOperator(() =>
    safeRead("users unavailable", { users: [] }, async () =>
      ok({ users: await listManagedUsers(instanceId) }),
    ),
  );
}

// POST /api/users — user actions against an instance's Clerk instance, mirrored
// into Mongo (B-6):
//   { action: "create", instanceId, email, username?, password? }
//   { action: "reset-password", id, clerkInstance, clerkUserId, password? }
//   { action: "set-username", id, clerkInstance, clerkUserId, username }
//   { action: "sign-in-link", id, clerkInstance, clerkUserId }
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const body = (await req.json()) as Record<string, string>;
    const { impl } = await loadClerkUserClient();

    // Hard block: never mutate users on a production/staging-prod Clerk instance.
    if (clerkTargetBlocked(body.clerkInstance)) {
      return bad(`refusing to manage users on a production Clerk instance (${body.clerkInstance})`, 403);
    }
    // Accounting: attribute every user mutation to the operator (best-effort).
    const audit = (target: string, detail?: string) =>
      recordAudit(principal.id, `user.${body.action}`, target, detail).catch(() => {});

    switch (body.action) {
      case "create": {
        if (!body.instanceId || !body.email) return bad("instanceId + email required");
        const instance = await getInstance(body.instanceId);
        const clerkInstance = instance?.clerkInstance ?? body.clerkInstance;
        if (clerkTargetBlocked(clerkInstance)) {
          return bad(`refusing to create users on a production Clerk instance (${clerkInstance})`, 403);
        }
        let clerkUserId: string | undefined;
        if (clerkInstance) {
          const remote = await impl.createUser(clerkInstance, {
            email: body.email,
            username: body.username,
            password: body.password,
          });
          clerkUserId = remote.clerkUserId;
        }
        const user = await upsertManagedUser({
          instanceId: body.instanceId,
          email: body.email,
          username: body.username,
          clerkUserId,
        });
        await recordUserAction(user.id, "created", { status: "active" });
        await audit(user.id, `${body.email} on ${clerkInstance ?? "(no clerk)"}`);
        return ok({ user });
      }
      case "reset-password": {
        if (!body.id || !body.clerkInstance || !body.clerkUserId) return bad("id + clerkInstance + clerkUserId required");
        const res = await impl.resetPassword(body.clerkInstance, body.clerkUserId, body.password);
        await recordUserAction(body.id, "password-reset");
        await audit(body.id, `clerkUser ${body.clerkUserId} on ${body.clerkInstance}`);
        return ok(res as Record<string, unknown>);
      }
      case "set-username": {
        if (!body.id || !body.clerkInstance || !body.clerkUserId || !body.username) return bad("id + clerkInstance + clerkUserId + username required");
        await impl.setUsername(body.clerkInstance, body.clerkUserId, body.username);
        await recordUserAction(body.id, "username-set", { username: body.username });
        await audit(body.id, `username=${body.username} on ${body.clerkInstance}`);
        return ok({ ok: true });
      }
      case "sign-in-link": {
        if (!body.id || !body.clerkInstance || !body.clerkUserId) return bad("id + clerkInstance + clerkUserId required");
        const link = await impl.createSignInLink(body.clerkInstance, body.clerkUserId);
        await recordUserAction(body.id, "sign-in-link", { signInUrl: link.url });
        await audit(body.id, `clerkUser ${body.clerkUserId} on ${body.clerkInstance}`);
        return ok(link as unknown as Record<string, unknown>);
      }
      default:
        return bad("unknown action");
    }
    // User mutations (create / reset-password / set-username / sign-in-link) are
    // credential-class operations, so the floor is "admin" — NOT the read-only
    // default. Omitting minRole here was a real authz gap (any authenticated
    // operator, incl. read-only, could mint sign-in links / reset passwords on
    // non-prod instances). See docs/audit/api-handler-review-2026-07-07.md (API-1).
  }, "admin");
}
