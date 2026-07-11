// lib/clients/clerk.ts — thin typed wrapper over Clerk.
//
// Two surfaces (project plan §5): the Backend API (users, sign-in tokens,
// config READ) authenticated with a secret key, and the Frontend API (FAPI) for
// a dev instance's environment read — which requires a dev-browser token first:
//   POST https://<fapi>/v1/dev_browser  → { token }
//   GET  https://<fapi>/v1/environment?__clerk_db_jwt=<token>
// Auth-strategy toggles + instance CREATION stay Dashboard-only (Playwright,
// Workstream B); this wrapper is the safe read/mint base the refresh needs.

import type { ScopedLogger } from "../logtap.ts";

const BACKEND_API = "https://api.clerk.com";

/** Resolve the Backend-API secret for a specific Clerk instance. Prefers a
 *  per-instance env `CLERK_SECRET_KEY_<SANITIZED_INSTANCE>`, else the shared
 *  `CLERK_SECRET_KEY` (the dev Clerk that current instances use). */
export function resolveClerkSecret(clerkInstance?: string): string | undefined {
  if (clerkInstance) {
    const key = `CLERK_SECRET_KEY_${clerkInstance.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const perInstance = process.env[key];
    if (perInstance) return perInstance;
  }
  return process.env.CLERK_SECRET_KEY;
}

export type ClerkConfig = {
  log: ScopedLogger;
  dryRun?: boolean;
  secretKey?: string; // Backend API (sk_…)
  fapiUrl?: string; // e.g. clerk.<domain> — required for dev-instance env read
  backendApi?: string; // override for tests
};

export type ClerkUser = { id: string; primaryEmail?: string };

export type ClerkClient = {
  listUsers(args?: { limit?: number }): Promise<ClerkUser[]>;
  findUserByEmail(email: string): Promise<ClerkUser | undefined>;
  /** Mint a static sign-in token — A-4 verify uses this for a sample login. */
  createSignInToken(args: { userId: string; expiresInSeconds?: number }): Promise<{ id?: string; token: string; url?: string }>;
  /** Revoke an unused sign-in token (scoped share-link revoke). */
  revokeSignInToken(tokenId: string): Promise<void>;
  /** Find a user by email, creating one if absent (share-link reviewer). */
  findOrCreateUser(email: string): Promise<ClerkUser>;
  /** Create a managed test user (no password required) — used by the test runner
   *  when an instance's Clerk has no user to sign in as. */
  createUser(args: { email: string; username?: string }): Promise<ClerkUser>;
  /** Backend-API instance config read (drift-detect base). */
  readInstanceConfig(): Promise<Record<string, unknown>>;
  /** Dev-instance environment read via FAPI (needs a dev-browser token). */
  readDevEnvironment(): Promise<Record<string, unknown>>;
};

export function makeClerkClient(cfg: ClerkConfig): ClerkClient {
  const log = cfg.log;
  const secretKey = cfg.secretKey ?? process.env.CLERK_SECRET_KEY;
  const backendApi = cfg.backendApi ?? BACKEND_API;

  async function backend<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");
    const res = await fetch(`${backendApi}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Clerk ${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async listUsers({ limit = 100 } = {}) {
      log("info", `list users (limit=${limit})`);
      if (cfg.dryRun) return [];
      const data = await backend<Array<{ id: string; email_addresses?: Array<{ email_address: string }> }>>(
        "GET",
        `/v1/users?limit=${limit}`,
      );
      return data.map((u) => ({ id: u.id, primaryEmail: u.email_addresses?.[0]?.email_address }));
    },

    async findUserByEmail(email) {
      log("info", `find user by email=${email}`);
      if (cfg.dryRun) return { id: "user_dry", primaryEmail: email };
      const data = await backend<Array<{ id: string; email_addresses?: Array<{ email_address: string }> }>>(
        "GET",
        `/v1/users?email_address=${encodeURIComponent(email)}`,
      );
      const u = data[0];
      return u ? { id: u.id, primaryEmail: u.email_addresses?.[0]?.email_address } : undefined;
    },

    async createSignInToken({ userId, expiresInSeconds = 3600 }) {
      log("info", `mint sign-in token for ${userId}`);
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST /v1/sign_in_tokens`);
        return { token: "sit_dry", url: undefined };
      }
      const data = await backend<{ id?: string; token: string; url?: string }>("POST", `/v1/sign_in_tokens`, {
        user_id: userId,
        expires_in_seconds: expiresInSeconds,
      });
      return { id: data.id, token: data.token, url: data.url };
    },

    async revokeSignInToken(tokenId) {
      log("info", `revoke sign-in token ${tokenId}`);
      if (cfg.dryRun) return;
      await backend("POST", `/v1/sign_in_tokens/${encodeURIComponent(tokenId)}/revoke`);
    },

    async findOrCreateUser(email) {
      const existing = await this.findUserByEmail(email);
      if (existing) return existing;
      return this.createUser({ email });
    },

    async createUser({ email, username }) {
      log("info", `create user ${email}`);
      if (cfg.dryRun) return { id: "user_dry", primaryEmail: email };
      // skip_password_* so a token-only test user needs no credential.
      const data = await backend<{ id: string; email_addresses?: Array<{ email_address: string }> }>(
        "POST",
        `/v1/users`,
        {
          email_address: [email],
          username,
          skip_password_requirement: true,
          skip_password_checks: true,
        },
      );
      return { id: data.id, primaryEmail: data.email_addresses?.[0]?.email_address ?? email };
    },

    async readInstanceConfig() {
      log("info", `read instance config (Backend API)`);
      if (cfg.dryRun) return {};
      return backend<Record<string, unknown>>("GET", `/v1/instance`);
    },

    async readDevEnvironment() {
      log("info", `read dev environment (FAPI)`);
      if (!cfg.fapiUrl) throw new Error("fapiUrl (clerk.<domain>) required for dev-instance environment read");
      if (cfg.dryRun) {
        log("info", `[dry-run] would POST https://${cfg.fapiUrl}/v1/dev_browser then GET /v1/environment`);
        return {};
      }
      const dbRes = await fetch(`https://${cfg.fapiUrl}/v1/dev_browser`, { method: "POST" });
      if (!dbRes.ok) throw new Error(`Clerk dev_browser failed ${dbRes.status}`);
      const { token } = (await dbRes.json()) as { token: string };
      const envRes = await fetch(`https://${cfg.fapiUrl}/v1/environment?__clerk_db_jwt=${encodeURIComponent(token)}`);
      if (!envRes.ok) throw new Error(`Clerk environment read failed ${envRes.status}`);
      return (await envRes.json()) as Record<string, unknown>;
    },
  };
}
