import { useState } from "react";
import type { Route } from "./+types/routing";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  getRouting,
  putRouting,
  type RoutingPolicy,
  type RoutingView,
} from "~/lib/api";
import { Nav } from "~/components/nav";

export async function clientLoader() {
  return { routing: await getRouting() };
}

const OBJECTIVES = ["cost", "latency", "quality"] as const;

const TASK_LABELS: Record<string, string> = {
  twin_answer: "Twin answers — grounded persona generation",
  rerank: "Reranking — candidate ordering (LLM reranker)",
  eval_judge: "Eval judge — claim-support grading",
};

export default function Routing({ loaderData }: Route.ComponentProps) {
  const [view, setView] = useState<RoutingView>(loaderData.routing);
  const [policy, setPolicy] = useState<RoutingPolicy>(loaderData.routing.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function setTask(task: string, field: "objective" | "pin", value: string | null) {
    setSaved(false);
    setPolicy((p) => ({
      ...p,
      tasks: {
        ...p.tasks,
        [task]: {
          objective: p.tasks[task]?.objective ?? null,
          pin: p.tasks[task]?.pin ?? null,
          [field]: value,
        },
      },
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await putRouting(policy);
      setView(next);
      setPolicy(next.policy);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 md:p-10">
      <Nav active="routing" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Routing console</h1>
        <p className="text-sm text-muted-foreground">
          Wire each call type to a model strategy. Pins jump the queue; the
          fallback chain always stays behind them. Policy is applied live,
          in-memory.
        </p>
      </header>

      <section className="flex flex-wrap gap-2">
        {Object.entries(view.providers).map(([name, up]) => (
          <Badge key={name} variant={up ? "accent" : "muted"}>
            {name}: {up ? "configured" : "not configured"}
          </Badge>
        ))}
        {Object.entries(view.cooling_down).map(([key, secs]) => (
          <Badge key={key} variant="destructive" title="circuit open after failures">
            ⏸ {key} cooling {Math.round(secs)}s
          </Badge>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Default objective</CardTitle>
          <CardDescription>
            Used by any task without its own objective or pin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ObjectivePicker
            value={policy.default_objective}
            onChange={(v) => {
              if (!v) return; // inherit not offered for the default
              setSaved(false);
              setPolicy((p) => ({ ...p, default_objective: v }));
            }}
          />
        </CardContent>
      </Card>

      {view.tasks.map((task) => {
        const route = policy.tasks[task] ?? { objective: null, pin: null };
        return (
          <Card key={task}>
            <CardHeader>
              <CardTitle className="text-base font-mono">{task}</CardTitle>
              <CardDescription>{TASK_LABELS[task] ?? task}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 text-xs text-muted-foreground">objective</span>
                <ObjectivePicker
                  inherit
                  value={route.objective}
                  onChange={(v) => setTask(task, "objective", v)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 text-xs text-muted-foreground">pin</span>
                <select
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                  value={route.pin ?? ""}
                  onChange={(e) => setTask(task, "pin", e.target.value || null)}
                >
                  <option value="">none — route by objective</option>
                  {view.registry
                    .filter((m) => view.providers[m.provider])
                    .map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                        {m.provider}:{m.id} (${m.input_per_mtok}/${m.output_per_mtok} per
                        Mtok)
                      </option>
                    ))}
                </select>
              </div>
              <div className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
                plan: {view.plans[task]?.join(" → ")}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "applying…" : "Apply policy"}
        </Button>
        {saved && <Badge variant="accent">applied — plans refreshed</Badge>}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model registry</CardTitle>
          <CardDescription>
            Declarative (models.yaml) — pricing per 1M tokens; quality/speed are
            routing ranks, not benchmarks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">model</th>
                <th className="py-1 pr-2">in $/M</th>
                <th className="py-1 pr-2">out $/M</th>
                <th className="py-1 pr-2">quality</th>
                <th className="py-1 pr-2">speed</th>
              </tr>
            </thead>
            <tbody>
              {view.registry.map((m) => (
                <tr key={`${m.provider}:${m.id}`} className="border-t border-border">
                  <td className="py-1 pr-2 font-mono">
                    {m.provider}:{m.id}
                    {!view.providers[m.provider] && (
                      <span className="text-muted-foreground"> (inactive)</span>
                    )}
                  </td>
                  <td className="py-1 pr-2">{m.input_per_mtok.toFixed(2)}</td>
                  <td className="py-1 pr-2">{m.output_per_mtok.toFixed(2)}</td>
                  <td className="py-1 pr-2">{m.quality}</td>
                  <td className="py-1 pr-2">{m.speed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  );
}

function ObjectivePicker({
  value,
  onChange,
  inherit = false,
}: {
  value: string | null;
  onChange: (v: (typeof OBJECTIVES)[number] | null) => void;
  inherit?: boolean;
}) {
  return (
    <div className="flex gap-1">
      {inherit && (
        <Button
          variant={value === null ? "default" : "outline"}
          className="h-7 px-2 text-xs"
          onClick={() => onChange(null)}
        >
          inherit
        </Button>
      )}
      {OBJECTIVES.map((o) => (
        <Button
          key={o}
          variant={value === o ? "default" : "outline"}
          className="h-7 px-2 text-xs"
          onClick={() => onChange(o)}
        >
          {o}
        </Button>
      ))}
    </div>
  );
}
