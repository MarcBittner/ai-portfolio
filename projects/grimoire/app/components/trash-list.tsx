"use client";

import { useState, useTransition } from "react";
import { RotateCcw, Trash2 } from "lucide-react";

import { Button, Card } from "./ui";
import { restoreDocAction, purgeDocAction, type TrashItem } from "@/app/actions/trash";

export function TrashList({ items }: { items: TrashItem[] }) {
  const [rows, setRows] = useState(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  function restore(it: TrashItem) {
    setBusy(it.trashPath);
    start(async () => {
      const res = await restoreDocAction(it.trashPath);
      if (res.ok) setRows((r) => r.filter((x) => x.trashPath !== it.trashPath));
      setBusy(null);
    });
  }
  function purge(it: TrashItem) {
    if (!confirm(`Permanently delete "${it.title}"? This can't be undone from the app.`)) return;
    setBusy(it.trashPath);
    start(async () => {
      const res = await purgeDocAction(it.trashPath);
      if (res.ok) setRows((r) => r.filter((x) => x.trashPath !== it.trashPath));
      setBusy(null);
    });
  }

  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[--color-muted]">Trash is empty.</p>
      </Card>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((it) => (
        <li
          key={it.trashPath}
          className="glass flex items-center gap-3 p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-[--color-ink]">{it.title}</div>
            <div className="truncate text-xs text-[--color-muted]">{it.path}</div>
          </div>
          <Button variant="ghost" disabled={busy === it.trashPath} onClick={() => restore(it)}>
            <RotateCcw size={14} /> Restore
          </Button>
          <Button variant="danger" disabled={busy === it.trashPath} onClick={() => purge(it)}>
            <Trash2 size={14} /> Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}
