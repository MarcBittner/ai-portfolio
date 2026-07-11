"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

import { cn } from "./ui";
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  type NotificationView,
} from "@/app/actions/notifications";

/** Tiny dependency-free relative-time formatter (mirrors doc-aside). */
function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Bell + unread badge in the top bar. Opens a dropdown of recent notifications,
 *  each linking to its doc. Polls unreadCount on mount; refreshes the list on open.
 *  All async state is stale-safe (guarded with an `alive` flag). */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationView[]>([]);

  // Poll the unread count on mount.
  useEffect(() => {
    let alive = true;
    unreadCount()
      .then((n) => {
        if (alive) setCount(n);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      alive = false;
    };
  }, []);

  // When opened, load the recent list and refresh the unread count.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listNotifications()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    unreadCount()
      .then((n) => {
        if (alive) setCount(n);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  function onItemClick(id: string) {
    // Optimistically mark read locally, then persist. Fire-and-forget.
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setCount((c) => Math.max(0, c - 1));
    setOpen(false);
    void markRead(id);
  }

  function onMarkAll() {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setCount(0);
    void markAllRead();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative rounded-md p-1.5 text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]"
      >
        <Bell size={16} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[--color-accent] px-1 text-[10px] font-semibold leading-none text-[--color-bg]">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="glass absolute right-0 z-50 mt-2 w-80 rounded-lg border border-[--color-line] bg-[--color-bg] p-1 shadow-lg">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm font-semibold text-[--color-ink]">Notifications</span>
              {items.some((n) => !n.read) && (
                <button
                  type="button"
                  onClick={onMarkAll}
                  className="text-xs text-[--color-accent] hover:underline"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-[--color-muted]">
                  No notifications yet.
                </p>
              ) : (
                <ul className="space-y-px">
                  {items.map((n) => (
                    <li key={n.id}>
                      <Link
                        href={`/app/doc/${n.path}`}
                        onClick={() => onItemClick(n.id)}
                        className={cn(
                          "flex items-start gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-[--color-accent]/8",
                          n.read ? "text-[--color-muted]" : "text-[--color-ink]",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                            n.read ? "bg-transparent" : "bg-[--color-accent]",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{n.message}</span>
                          <span className="block text-xs text-[--color-muted]">
                            {relativeTime(n.createdAt)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
