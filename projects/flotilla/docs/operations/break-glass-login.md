# Runbook: Break-glass login (Clerk gate unavailable)

**TL;DR** — When Clerk is down or a config change has locked every operator out of the
Clerk gate, one pre-configured local identity (`BREAKGLASS_EMAIL`) can still sign in by
`POST`-ing a password to `/api/breakglass`. The password is verified against a **scrypt
hash held in env** (`BREAKGLASS_PASSWORD_HASH`) — never a plaintext secret — and a signed,
httpOnly cookie (`bg_session`) is set that the route guards accept exactly like a Clerk
session (`lib/breakglass.ts:8`, `lib/auth.ts:6`). The session resolves to **super-admin**
(`lib/auth.ts:67`), so treat it as a last resort. Regenerate the hash with `hashPassword`
(`lib/breakglass.ts:19`); never write plaintext to `.env` or shell history.

**Status legend:** ✅ shipped · ◐ partial · 🔭 flag-gated / planned · ⚠️ caveat

![Break-glass login](../screenshots/ui/breakglass.png)

*The break-glass login page.*

---

## Symptom

Use break-glass when the normal Clerk login cannot reach `/app`:

- **Clerk outage** — `clerkClient()` / `auth()` throws or hangs, so `getPrincipal` can't
  resolve a Clerk session and every `/app` route returns `unauthorized` (`lib/auth.ts:69`).
- **`ALLOWED_EMAILS` lockout** — Clerk is up, but `ALLOWED_EMAILS` is empty/misconfigured,
  so verified operators fail closed. An empty/unset value denies **all** Clerk logins by
  design (`.env.example:100`), and `resolveClerkRole` returns `null` for any unknown
  non-`@example.com` email (`lib/auth.ts:60`).
- **Clerk keys pulled** — a deploy shipped without `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, so
  the app is in no-Clerk mode and `/app` bounces to `/breakglass` (`middleware.ts:46`).

If normal Clerk login works, **do not** use this path — fix the operator's role/allowlist
instead (see [Prevention](#prevention)).

---

## Preconditions & blast radius

- **Requires `BREAKGLASS_*` env set.** Login fails closed unless BOTH `BREAKGLASS_EMAIL`
  and a valid `BREAKGLASS_PASSWORD_HASH` are configured (`lib/breakglass.ts:95`,
  `lib/breakglass.ts:98`). A missing/malformed hash rejects every attempt
  (`lib/breakglass.ts:27`). `BREAKGLASS_EMAIL` defaults to `marc.bittner@gmail.com`;
  `BREAKGLASS_PASSWORD_HASH` ships **blank** (`.env.example:9`).
- **The session is super-admin.** A verified break-glass cookie resolves to role
  `super-admin` (`lib/auth.ts:67`) — the top of the RBAC ladder (`lib/rbac.ts:9`) — so it
  clears every `withOperator` rank gate (`lib/api.ts:35`) and can manage other operators.
  Highest-privilege access; use only while the outage lasts.
- **Session lifetime:** 8 hours (`lib/breakglass.ts:16`, cookie `maxAge` at
  `app/api/breakglass/route.ts:50`). Cookie is `httpOnly`, `sameSite=lax`, and `secure` in
  production (`app/api/breakglass/route.ts:45`).
- **Audit.** Denials are recorded centrally under the principal id (the break-glass email)
  via `recordAudit` (`lib/api.ts:38`). ⚠️ Actions taken during the session are attributed to
  `BREAKGLASS_EMAIL`, not a per-person Clerk identity — note who actually held the console.
- **Brute-force guard.** `/api/breakglass` is rate-limited per client IP: 8 failed attempts
  per 15-minute window, then locked out with `429` for the rest of the window
  (`lib/ratelimit.ts:10`, `lib/ratelimit.ts:11`, `app/api/breakglass/route.ts:24`).

---

## Diagnosis

Confirm (a) Clerk really is the problem and (b) break-glass is actually configured before
you rely on it.

```bash
# 1. Is the app in Clerk mode or no-Clerk mode? Presence of the publishable key decides
#    (middleware.ts:18). Empty output => no-Clerk mode => /app already bounces to /breakglass.
printf '%s\n' "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-<unset>}"

# 2. Confirm Clerk is the failure (not a bad password). A hung/500 here or errors in the
#    server logs around auth() / clerkClient() point at a Clerk outage (lib/auth.ts:69).
curl -sS -o /dev/null -w '%{http_code}\n' https://api.clerk.com/v1/jwks

# 3. Confirm break-glass is configured on the RUNNING deployment (values must be non-empty).
#    Check via your platform's env inspector — do NOT echo the hash into logs/tickets.
#    Expect BREAKGLASS_EMAIL set and BREAKGLASS_PASSWORD_HASH a non-empty `salt:hashHex`
#    (lib/breakglass.ts:22). A blank hash means break-glass is NOT armed — see Remediation §B.
```

If step 3 shows a blank `BREAKGLASS_PASSWORD_HASH`, you cannot log in until you set one
(§B), then redeploy/restart so the process picks up the new env.

---

## Remediation

### A. Log in via `POST /api/breakglass`

1. **Open the login page** (or POST directly). In a browser go to `/breakglass`; the form
   posts to the endpoint below (`app/breakglass/page.tsx:22`). To do it from a shell:

   ```bash
   # Read the break-glass password WITHOUT echoing it or storing it in shell history:
   read -rs BG_PW && echo

   # POST it. On success the response Set-Cookie carries the bg_session cookie; -c saves it
   #   to a jar you can reuse for authenticated /app/api calls (route.ts:37, :45).
   curl -sS -c bg.cookies -X POST https://<your-dashboard-host>/api/breakglass \
     -H 'content-type: application/json' \
     --data "$(BG_PW="$BG_PW" node -e 'process.stdout.write(JSON.stringify({email:process.env.BREAKGLASS_EMAIL,password:process.env.BG_PW}))')"

   # Scrub the password from the shell env once done:
   unset BG_PW
   ```

2. **Confirm the cookie was set.** A `200` with `{"ok":true,"email":...}` means you're in
   (`app/api/breakglass/route.ts:52`). `401 invalid credentials` = wrong email/password;
   `429` = rate-limited, wait out the 15-minute window (`app/api/breakglass/route.ts:39`,
   `:26`). The email match is case-insensitive but must equal `BREAKGLASS_EMAIL`
   (`lib/breakglass.ts:97`).

3. **Use the session.** In a browser you're redirected into `/app`; the route guard
   `getPrincipal` validates the cookie on every request (`lib/auth.ts:63`). For scripted
   calls, pass the saved jar (`-b bg.cookies`).

4. **Sign out when done** — don't leave an 8-hour super-admin cookie lying around:

   ```bash
   curl -sS -b bg.cookies -X DELETE https://<your-dashboard-host>/api/breakglass  # clears bg_session (route.ts:56)
   rm -f bg.cookies
   ```

### B. (Re)generate `BREAKGLASS_PASSWORD_HASH` safely

Do this if the hash is blank/lost, or as post-incident rotation. **Never** put a plaintext
password in `.env`, argv, or the ticket — only the scrypt `salt:hashHex` string is stored
(`lib/breakglass.ts:19`).

1. **Derive the hash with the same code the server verifies against.** The password is read
   from stdin (never argv/history) and hashed by the exported `hashPassword`, so the format
   can never drift from `verifyPassword` (`lib/breakglass.ts:27`):

   ```bash
   # Run from the repo root. tsx is already a devDependency (package.json).
   read -rs BG_PW && echo
   printf '%s' "$BG_PW" | npx tsx -e '
     import { hashPassword } from "./lib/breakglass";
     const parts: Buffer[] = [];
     process.stdin.on("data", (c) => parts.push(c as Buffer));
     process.stdin.on("end", () =>
       process.stdout.write(hashPassword(Buffer.concat(parts).toString("utf8")) + "\n"));
   '
   unset BG_PW
   # Output is a single `salt:hashHex` line — THAT is the value for BREAKGLASS_PASSWORD_HASH.
   ```

2. **Store the hash as a secret** in your platform's env manager (and your team's
   secret manager, per `.env.example:1`). Set `BREAKGLASS_PASSWORD_HASH` to the
   `salt:hashHex` string; confirm `BREAKGLASS_EMAIL` is the operator identity you expect.

3. **Redeploy / restart** so the running process reloads the env, then verify with §A.
   ⚠️ Rotating the hash **invalidates every existing `bg_session` cookie** — the cookie
   signing key is derived from `BREAKGLASS_PASSWORD_HASH` (`lib/breakglass.ts:48`), so all
   current break-glass sessions must log in again.

---

## Escalation

- If break-glass itself won't authenticate (correct password rejected, or hash can't be
  set), escalate to the platform owner who holds env/secret access and the immutable
  super-admins in `lib/rbac.ts:39` (e.g. `founder@example.com`, `ops@example.com`).
- For the underlying Clerk outage, follow the Clerk incident path in `../SECURITY.md`
  (⚠️ planned) and Clerk's status page; break-glass only buys you access, it does not fix Clerk.

---

## Prevention

- **Rotate the hash after every use.** Anyone who saw the break-glass password during the
  incident should be assumed to know it — regenerate per §B and redeploy (this also expires
  outstanding sessions, `lib/breakglass.ts:48`).
- **Restore Clerk.** Once the outage clears, confirm `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
  `CLERK_SECRET_KEY` are set and a normal operator login works, so `getPrincipal` resolves
  Clerk sessions again (`lib/auth.ts:69`). Then stop using break-glass.
- **`ALLOWED_EMAILS` hygiene.** Keep the allowlist accurate but minimal — it's a
  fail-closed continuity bridge that auto-provisions `write` on first login (`lib/auth.ts:55`).
  Remove entries once operators are properly invited/role-assigned (`.env.example:100`), and
  never leave it empty while Clerk is the intended gate (empty = deny all).
- **Keep break-glass armed.** Ensure `BREAKGLASS_PASSWORD_HASH` is set in every real
  environment so this path exists BEFORE the next outage — a blank hash means no fallback.

---

**Related:** [operations README](./README.md) · [SECURITY](../SECURITY.md) · [ARCHITECTURE](../ARCHITECTURE.md)
