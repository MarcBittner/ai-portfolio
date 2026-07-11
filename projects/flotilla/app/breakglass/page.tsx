"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../components/ui";

// Break-glass login (plan §16): the no-Clerk path. Posts to /api/breakglass which
// verifies the password against the env scrypt hash and sets a signed httpOnly
// cookie; the route guards then accept it exactly like a Clerk session.
export default function BreakglassLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/breakglass", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "login failed");
      }
      const next = new URLSearchParams(window.location.search).get("next") || "/app";
      router.push(next.startsWith("/app") ? next : "/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">
        break<span className="text-[--color-accent]">·</span>glass
      </h1>
      <p className="mt-2 text-sm text-[--color-muted]">
        Local operator login. Verified against a scrypt hash in env — no Clerk required.
      </p>
      <form onSubmit={submit} className="glass mt-6 p-5">
        <label className="block text-xs text-[--color-muted]">
          Email
          <input
            className={field}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="mt-3 block text-xs text-[--color-muted]">
          Password
          <input
            className={field}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="mt-3 text-xs text-[--color-bad]">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" type="submit" disabled={busy || !email || !password}>
            {busy ? "Verifying…" : "Sign in →"}
          </Button>
        </div>
      </form>
    </main>
  );
}
