"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

function ThemeToggle() {
  // `null` until mounted so SSR markup matches the bootstrap-set class
  // (avoids a hydration mismatch on the icon).
  const [light, setLight] = useState<boolean | null>(null);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("light");
    document.documentElement.classList.toggle("light", next);
    try {
      localStorage.setItem("theme", next ? "light" : "dark");
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
    setLight(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light / dark theme"
      title="Toggle light / dark theme"
      className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
    >
      {light ? "☾" : "☀"}
    </button>
  );
}

export function Nav() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-3 border-b border-[--color-line] pb-4">
      <Link href="/app" className="font-semibold tracking-tight">
        <span className="text-[--color-accent]">true</span>line
      </Link>
      <Link href="/app" className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]">
        Dashboard
      </Link>
      <Link
        href="/app/evals"
        className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
      >
        Evals
      </Link>
      <Link
        href="/app/diagnostics"
        className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
      >
        Diagnostics
      </Link>
      <Link
        href="/app/settings"
        className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
      >
        Configuration
      </Link>
      <Link
        href="/app/about"
        className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
      >
        About
      </Link>
      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        <OrganizationSwitcher
          hidePersonal={false}
          appearance={{ elements: { rootBox: "flex items-center" } }}
        />
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
