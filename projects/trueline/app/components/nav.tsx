"use client";

import Link from "next/link";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export function Nav() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-3 border-b border-[--color-line] pb-4">
      <Link href="/app" className="font-semibold tracking-tight">
        <span className="text-[--color-accent]">true</span>line
      </Link>
      <span className="text-xs text-[--color-muted]">invoice line-item verification</span>
      <div className="ml-auto flex items-center gap-3">
        <OrganizationSwitcher
          hidePersonal={false}
          appearance={{ elements: { rootBox: "flex items-center" } }}
        />
        <UserButton afterSignOutUrl="/" />
      </div>
    </nav>
  );
}
