import type { ComponentProps } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---- buttons ----
// One source of truth for button look + feel, so every clickable control gets the
// same hover (lift/brighten) and on-click (press-in) feedback. `buttonCls` is for
// cases that can't be a <button> (e.g. a file-input <label>).
type ButtonVariant = "primary" | "secondary" | "ghost" | "ok" | "danger";

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
  ok: "border-[--color-ok] text-[--color-ok] hover:bg-[--color-ok]/15 active:bg-[--color-ok]/25",
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

// ---- frosted panel ----
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("glass p-5", className)} {...props} />;
}

// ---- badges ----
type Tone = "accent" | "ok" | "warn" | "bad" | "muted";

const BADGE_TONE: Record<Tone, string> = {
  accent: "bg-[--color-accent]/15 text-[--color-accent]",
  ok: "bg-[--color-ok]/15 text-[--color-ok]",
  warn: "bg-[--color-warn]/15 text-[--color-warn]",
  bad: "bg-[--color-bad]/15 text-[--color-bad]",
  muted: "bg-[color-mix(in_oklch,_var(--color-ink)_10%,_transparent)] text-[--color-muted]",
};

export function Badge({
  tone = "muted",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        BADGE_TONE[tone],
        className,
      )}
      {...props}
    />
  );
}
