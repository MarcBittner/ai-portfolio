"use client";

import Link from "next/link";

import { UserButton } from "@/app/clerk-shim";
import { AppearanceMenu } from "./appearance-menu";

const LINKS: { href: string; label: string }[] = [
  { href: "/app", label: "Docs" },
  { href: "/app/new", label: "New" },
  { href: "/app/search", label: "Search" },
  { href: "/app/import", label: "Import" },
  { href: "/app/settings", label: "Configuration" },
  { href: "/app/about", label: "About" },
];

export function Nav() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-3 border-b border-[--color-line] pb-4">
      <Link href="/app" className="font-semibold tracking-tight">
        <span className="text-[--color-accent]">Grimoire</span>
      </Link>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-md px-2 py-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
        >
          {l.label}
        </Link>
      ))}
      <div className="ml-auto flex items-center gap-3">
        <AppearanceMenu />
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
