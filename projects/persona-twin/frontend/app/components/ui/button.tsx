import { cn } from "~/lib/utils";

const variants = {
  default:
    "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
  outline:
    "border border-border bg-card shadow-xs hover:bg-muted",
  ghost: "hover:bg-muted",
} as const;

export function Button({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"button"> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium",
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
