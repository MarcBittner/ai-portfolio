import { cn } from "~/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full min-h-20 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-xs",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
