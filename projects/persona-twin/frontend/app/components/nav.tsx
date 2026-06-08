import { Link } from "react-router";
import { cn } from "~/lib/utils";

export function Nav({
  active,
}: {
  active: "home" | "chat" | "build" | "routing" | "analytics";
}) {
  const link = "rounded-md px-2 py-1 text-sm hover:bg-muted";
  return (
    <nav className="flex items-center gap-2 border-b border-border pb-3">
      <span className="mr-2 font-mono text-sm font-semibold">persona-twin</span>
      <Link to="/" className={cn(link, active === "home" && "bg-muted font-medium")}>
        ask
      </Link>
      <Link to="/chat" className={cn(link, active === "chat" && "bg-muted font-medium")}>
        chat
      </Link>
      <Link
        to="/builder"
        className={cn(link, active === "build" && "bg-muted font-medium")}
      >
        build
      </Link>
      <Link
        to="/console"
        className={cn(link, active === "routing" && "bg-muted font-medium")}
      >
        routing
      </Link>
      <Link
        to="/analytics"
        className={cn(link, active === "analytics" && "bg-muted font-medium")}
      >
        analytics
      </Link>
    </nav>
  );
}
