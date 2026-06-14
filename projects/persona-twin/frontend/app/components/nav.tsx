import { useEffect, useState } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";
import { getHealth, modelTier, type Health } from "~/lib/api";
import { loadPrefs, savePrefs, type Theme } from "~/lib/prefs";
import { Help, type HelpSection } from "~/components/help";
import { Settings } from "~/components/settings";
import { AppLauncher } from "~/components/app-launcher";

type Active = "home" | "chat" | "interview" | "build" | "routing" | "analytics";

const LINKS: { to: string; label: string; active: Active }[] = [
  { to: "/", label: "ask", active: "home" },
  { to: "/chat", label: "chat", active: "chat" },
  { to: "/interview", label: "interview", active: "interview" },
  { to: "/builder", label: "build", active: "build" },
  { to: "/console", label: "routing", active: "routing" },
  { to: "/analytics", label: "analytics", active: "analytics" },
];

const HELP_FOR: Record<Active, HelpSection> = {
  home: "ask",
  chat: "chat",
  interview: "interview",
  build: "build",
  routing: "routing",
  analytics: "analytics",
};

const TIER_TONE: Record<string, string> = {
  free: "bg-accent text-accent-foreground",
  paid: "bg-primary/15 text-primary",
  local: "bg-primary/15 text-primary",
  offline: "bg-muted text-muted-foreground",
};

export function Nav({ active }: { active: Active }) {
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [launcher, setLauncher] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    setDark(document.documentElement.classList.contains("dark"));
    // keep prefs initialised (and migrate older storage shape if any)
    loadPrefs();
  }, []);

  // global "?" opens help (ignored while typing); track dark on pref change
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!typing && e.key === "?") {
        e.preventDefault();
        setHelp(true);
      }
    };
    const onPrefs = () =>
      setDark(document.documentElement.classList.contains("dark"));
    window.addEventListener("keydown", onKey);
    window.addEventListener("pt:prefs", onPrefs as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pt:prefs", onPrefs as EventListener);
    };
  }, []);

  function toggleTheme() {
    const next: Theme = dark ? "light" : "dark";
    savePrefs({ theme: next });
    setDark(next === "dark");
  }

  const tier = health ? modelTier(health) : null;
  const link = "rounded-md px-2 py-1 text-sm hover:bg-muted";

  return (
    <>
      <nav className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <span className="mr-1 font-mono text-sm font-semibold">persona-twin</span>
        {LINKS.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className={cn(link, active === l.active && "bg-muted font-medium")}
          >
            {l.label}
          </Link>
        ))}

        <div className="ml-auto flex items-center gap-1.5">
          {tier && (
            <button
              onClick={() => setSettings(true)}
              title={`Model: ${tier.detail}. Click for settings.`}
              className={cn(
                "hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium sm:inline-flex",
                TIER_TONE[tier.tier] ?? "bg-muted text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  tier.tier === "offline" ? "bg-muted-foreground" : "bg-current",
                )}
              />
              {tier.tier}
            </button>
          )}
          <button
            onClick={() => setLauncher(true)}
            aria-label="Browse all demos"
            title="Browse all demos"
            className="rounded-md px-2 py-1 text-sm hover:bg-muted"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              aria-hidden
              className="h-4 w-4"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title="Toggle light / dark"
            className="rounded-md px-2 py-1 text-sm hover:bg-muted"
          >
            {dark ? "☀" : "☾"}
          </button>
          <button
            onClick={() => setHelp(true)}
            aria-label="Help"
            title="Help & guide (?)"
            className="rounded-md px-2 py-1 text-sm hover:bg-muted"
          >
            ?
          </button>
          <button
            onClick={() => setSettings(true)}
            aria-label="Settings"
            title="Settings"
            className="rounded-md px-2 py-1 text-sm hover:bg-muted"
          >
            ⚙
          </button>
        </div>
      </nav>

      <Help open={help} onClose={() => setHelp(false)} section={HELP_FOR[active]} />
      <Settings open={settings} onClose={() => setSettings(false)} />
      <AppLauncher open={launcher} onClose={() => setLauncher(false)} />
    </>
  );
}
