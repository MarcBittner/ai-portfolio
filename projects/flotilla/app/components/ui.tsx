import type { ComponentProps } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---- buttons ----
// One source of truth for button look + feel, so every clickable control gets the
// same hover (lift/brighten) and on-click (press-in) feedback. `buttonCls` is for
// the cases that can't be a <button> (e.g. the file-input <label>).
type ButtonVariant = "primary" | "secondary" | "ghost" | "ok" | "danger";

// Every button shares ONE shape: a visible outline (border), a surface fill at rest,
// a lift + shadow on hover, and a press (scale down) on click. Variants differ only
// by border/text color and the hover-fill tint — so the styling is consistent and
// every button reads as a button, outline included.
const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium " +
  "cursor-pointer select-none bg-[--color-surface] transition-all duration-150 " +
  "hover:-translate-y-px hover:shadow-sm active:translate-y-0 active:scale-95 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/50 " +
  "disabled:pointer-events-none disabled:opacity-50 disabled:hover:translate-y-0";

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-[--color-accent] text-[--color-accent] hover:bg-[--color-accent]/15 active:bg-[--color-accent]/25",
  secondary:
    "border-[--color-line] text-[--color-ink] hover:border-[--color-accent] hover:bg-[--color-accent]/10 active:bg-[--color-accent]/20",
  ghost:
    "border-[--color-line] text-[--color-muted] hover:border-[--color-accent] hover:text-[--color-ink] hover:bg-[--color-accent]/10 active:bg-[--color-accent]/20",
  ok:
    "border-[--color-ok] text-[--color-ok] hover:bg-[--color-ok]/15 active:bg-[--color-ok]/25",
  danger:
    "border-[--color-bad] text-[--color-bad] hover:bg-[--color-bad]/15 active:bg-[--color-bad]/25",
};

export function buttonCls(variant: ButtonVariant = "secondary", extra?: string) {
  return cn(BTN_BASE, BTN_VARIANT[variant], extra);
}

export function Button({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button className={buttonCls(variant, className)} {...props} />;
}

export function usd(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const FLAG_TONE: Record<string, string> = {
  red: "bg-[--color-bad]/15 text-[--color-bad]",
  yellow: "bg-[--color-warn]/15 text-[--color-warn]",
  green: "bg-[--color-ok]/15 text-[--color-ok]",
};
const FLAG_DOT: Record<string, string> = {
  red: "bg-[--color-bad]",
  yellow: "bg-[--color-warn]",
  green: "bg-[--color-ok]",
};

export function FlagBadge({ flag }: { flag: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        FLAG_TONE[flag] ??
          "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)] text-[--color-muted]",
      )}
    >
      <span className={cn("flagdot", FLAG_DOT[flag])} />
      {flag}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    extracting: "bg-[--color-accent]/15 text-[--color-accent]",
    needs_review: "bg-[--color-warn]/15 text-[--color-warn]",
    approved: "bg-[--color-ok]/15 text-[--color-ok]",
    rejected: "bg-[--color-bad]/15 text-[--color-bad]",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        tone[status] ??
          "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)] text-[--color-muted]",
        status === "extracting" && "animate-pulse",
      )}
    >
      {status === "extracting" ? "extracting…" : status.replace("_", " ")}
    </span>
  );
}
