import { z } from "zod";
import { col, newId, now, NO_ID } from "./base.ts";

// Per-instance test users/logins (plan B-6). Mirrors the minimum we track for a
// managed Clerk user so the Users tab can list/act without a live Clerk round
// trip on every render.
export const NewManagedUser = z.object({
  instanceId: z.string().min(1),
  email: z.string().email(),
  username: z.string().max(120).optional(),
  clerkUserId: z.string().optional(),
});
export type NewManagedUser = z.infer<typeof NewManagedUser>;

export type ManagedUserDoc = {
  id: string;
  instanceId: string;
  email: string;
  username?: string;
  clerkUserId?: string;
  status: "active" | "invited" | "disabled";
  lastAction?: string;
  lastActionAt?: number;
  signInUrl?: string;
  createdAt: number;
  updatedAt: number;
};

export async function listManagedUsers(instanceId?: string): Promise<ManagedUserDoc[]> {
  const c = await col<ManagedUserDoc>("managedUsers");
  const filter = instanceId ? { instanceId } : {};
  return c.find(filter, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function upsertManagedUser(input: NewManagedUser): Promise<ManagedUserDoc> {
  const parsed = NewManagedUser.parse(input);
  const c = await col<ManagedUserDoc>("managedUsers");
  const existing = await c.findOne(
    { instanceId: parsed.instanceId, email: parsed.email },
    NO_ID,
  );
  const ts = now();
  const doc: ManagedUserDoc = {
    id: existing?.id ?? newId("usr"),
    instanceId: parsed.instanceId,
    email: parsed.email,
    username: parsed.username ?? existing?.username,
    clerkUserId: parsed.clerkUserId ?? existing?.clerkUserId,
    status: existing?.status ?? "invited",
    lastAction: existing?.lastAction,
    lastActionAt: existing?.lastActionAt,
    signInUrl: existing?.signInUrl,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  await c.updateOne(
    { instanceId: parsed.instanceId, email: parsed.email },
    { $set: doc },
    { upsert: true },
  );
  return doc;
}

export async function recordUserAction(
  id: string,
  action: string,
  patch: Partial<Pick<ManagedUserDoc, "username" | "clerkUserId" | "status" | "signInUrl">> = {},
): Promise<void> {
  const c = await col<ManagedUserDoc>("managedUsers");
  await c.updateOne(
    { id },
    { $set: { ...patch, lastAction: action, lastActionAt: now(), updatedAt: now() } },
  );
}
