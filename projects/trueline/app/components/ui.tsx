import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
        FLAG_TONE[flag] ?? "bg-white/10 text-[--color-muted]",
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
        tone[status] ?? "bg-white/10 text-[--color-muted]",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
