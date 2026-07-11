"use client";

import Link from "next/link";
import { AlertTriangle, Clock, FileText, Unlink } from "lucide-react";

import { Badge, Card, cn } from "./ui";
import type { HealthReport } from "@/app/actions/health";

const FLAG_META: Record<string, { label: string; tone: "warn" | "muted" | "bad" }> = {
  stale: { label: "stale", tone: "warn" },
  orphaned: { label: "orphaned", tone: "bad" },
  stub: { label: "stub", tone: "muted" },
};

export function HealthDashboard({ report }: { report: HealthReport }) {
  const { total, stale, orphaned, stub, items } = report;

  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="text-center">
          <div className="text-2xl font-semibold">{total}</div>
          <div className="text-xs text-[--color-muted]">docs</div>
        </Card>
        <Card className="text-center">
          <div className="flex items-center justify-center gap-1 text-2xl font-semibold text-[--color-warn]">
            <Clock size={18} /> {stale}
          </div>
          <div className="text-xs text-[--color-muted]">stale (&gt;120d)</div>
        </Card>
        <Card className="text-center">
          <div className="flex items-center justify-center gap-1 text-2xl font-semibold text-[--color-bad]">
            <Unlink size={18} /> {orphaned}
          </div>
          <div className="text-xs text-[--color-muted]">orphaned</div>
        </Card>
        <Card className="text-center">
          <div className="flex items-center justify-center gap-1 text-2xl font-semibold text-[--color-muted]">
            <FileText size={18} /> {stub}
          </div>
          <div className="text-xs text-[--color-muted]">stubs</div>
        </Card>
      </div>

      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-[--color-muted]">
            Everything looks healthy — no stale, orphaned, or stub docs.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.path} className="glass flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              <Link
                href={`/app/doc/${it.path}`}
                className="min-w-0 flex-1 truncate text-sm text-[--color-ink] hover:text-[--color-accent]"
              >
                {it.title}
                <span className="ml-2 text-xs text-[--color-muted]">{it.path}</span>
              </Link>
              {it.flags.map((f) => (
                <Badge key={f} tone={FLAG_META[f]?.tone ?? "muted"}>
                  {FLAG_META[f]?.label ?? f}
                </Badge>
              ))}
              <span
                className={cn(
                  "text-xs text-[--color-muted]",
                  it.ageDays > 120 && "text-[--color-warn]",
                )}
              >
                {it.ageDays}d old · {it.backlinks} in
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-xs text-[--color-muted]">
        <AlertTriangle size={13} /> Stale = not updated in 120+ days · Orphaned = nothing links to it ·
        Stub = under 400 characters.
      </p>
    </div>
  );
}
