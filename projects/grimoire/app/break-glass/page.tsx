"use client";

// Break-glass recovery login. Reachable when SSO is down (it does not depend on
// Clerk). Posts to /api/breakglass, which sets a signed httpOnly session cookie;
// resolveIdentity() then treats the request as the seeded Super Admin. Disabled
// server-side unless BREAKGLASS_EMAIL + BREAKGLASS_PASSWORD_HASH are set.

import { useState } from "react";

export default function BreakGlassPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/breakglass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        setStatus({ ok: true, msg: "Signed in. Redirecting…" });
        window.location.href = "/app";
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({ ok: false, msg: body.error ?? "Sign-in failed." });
      }
    } catch {
      setStatus({ ok: false, msg: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 380, margin: "12vh auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: ".25rem" }}>Break-glass sign-in</h1>
      <p style={{ opacity: 0.7, fontSize: ".9rem", marginBottom: "1.25rem" }}>
        Emergency Super Admin recovery for when single sign-on is unavailable. All use is audit-logged.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: ".75rem" }}>
        <input
          type="email"
          autoComplete="username"
          placeholder="admin email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: ".6rem", borderRadius: 8, border: "1px solid var(--color-line, #333)" }}
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="recovery password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: ".6rem", borderRadius: 8, border: "1px solid var(--color-line, #333)" }}
        />
        <button type="submit" disabled={busy} style={{ padding: ".6rem", borderRadius: 8, fontWeight: 600 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {status && (
        <p style={{ marginTop: "1rem", color: status.ok ? "var(--color-ok, #3fb950)" : "var(--color-bad, #f85149)" }}>
          {status.msg}
        </p>
      )}
    </main>
  );
}
