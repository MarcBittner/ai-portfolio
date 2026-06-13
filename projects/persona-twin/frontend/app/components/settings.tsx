import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  getHealth,
  listPersonas,
  modelTier,
  type Health,
  type Persona,
} from "~/lib/api";
import { loadPrefs, savePrefs, type Theme } from "~/lib/prefs";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 px-3 py-1.5 text-sm transition-colors",
            o.value === value
              ? "bg-primary text-primary-foreground"
              : "bg-card hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [health, setHealth] = useState<Health | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);

  useEffect(() => {
    if (!open) return;
    setPrefs(loadPrefs());
    getHealth().then(setHealth).catch(() => setHealth(null));
    listPersonas().then(setPersonas).catch(() => setPersonas([]));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function update(patch: Partial<typeof prefs>) {
    setPrefs(savePrefs(patch));
  }

  const tier = health ? modelTier(health) : null;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Settings"
        aria-hidden={!open}
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[400px] max-w-[94vw] flex-col",
          "border-l border-border bg-card text-card-foreground shadow-xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="text-sm font-semibold">Settings</div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            ✕
          </button>
        </header>

        <div className="space-y-6 overflow-y-auto px-5 py-5 text-sm">
          <div className="space-y-2">
            <label className="font-medium">Theme</label>
            <Segment
              value={prefs.theme}
              options={THEMES}
              onChange={(v) => update({ theme: v })}
            />
          </div>

          <div className="space-y-2">
            <label className="font-medium">Default twin on the Ask page</label>
            <select
              value={prefs.defaultPersona ?? ""}
              onChange={(e) => update({ defaultPersona: e.target.value || null })}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <option value="">First in the list</option>
              {personas.map((p) => (
                <option key={p.persona_id} value={p.persona_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center justify-between">
            <span className="font-medium">Show routing &amp; timings by default</span>
            <input
              type="checkbox"
              checked={prefs.debug}
              onChange={(e) => update({ debug: e.target.checked })}
              className="h-4 w-4"
            />
          </label>

          <div className="space-y-2 border-t border-border pt-4">
            <div className="font-medium">Model &amp; backends</div>
            {tier ? (
              <div className="space-y-2 rounded-md bg-muted p-3 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant={tier.tier === "offline" ? "muted" : "accent"}>
                    {tier.tier}
                  </Badge>
                  <span className="text-muted-foreground">{tier.detail}</span>
                </div>
                <Row k="objective" v={health!.route_objective} />
                <Row k="providers" v={health!.llm_backends.join(", ")} />
                <Row k="embedding" v={health!.embedding_backend} />
                <Row k="vector store" v={health!.vector_backend} />
                <Row k="cache" v={health!.cache_backend} />
                <Row
                  k="indexed"
                  v={`${health!.chunks_indexed} chunks · ${health!.personas} twins`}
                />
                <Row k="version" v={health!.version} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">loading status…</div>
            )}
            <p className="text-xs text-muted-foreground">
              Model tier is set server-side (free by default; offline with no key).
              Tune the routing policy in the{" "}
              <Link
                to="/console"
                className="text-primary underline"
                onClick={onClose}
              >
                routing console
              </Link>
              .
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-mono">{v}</span>
    </div>
  );
}
