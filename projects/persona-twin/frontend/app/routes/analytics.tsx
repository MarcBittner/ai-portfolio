import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/analytics";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Nav } from "~/components/nav";
import {
  getBenchmark,
  getBenchmarkAggregate,
  getBenchmarkHistory,
  getBenchmarkRun,
  getRouting,
  postBenchmark,
  stopBenchmark,
  type AggregateEntry,
  type BenchmarkRun,
  type RunSummary,
  type TaskResult,
} from "~/lib/api";

export async function clientLoader() {
  const [routing, benchmark, history, aggregate] = await Promise.all([
    getRouting(),
    getBenchmark(),
    getBenchmarkHistory(),
    getBenchmarkAggregate(),
  ]);
  return { routing, benchmark, history, aggregate };
}

const HEADLINE: Record<string, { metric: string; label: string }> = {
  twin_answer: { metric: "fact_presence", label: "fact presence" },
  rerank: { metric: "mrr", label: "MRR" },
  eval_judge: { metric: "accuracy", label: "verdict accuracy" },
};

const TASK_TITLES: Record<string, string> = {
  twin_answer: "Twin answers",
  rerank: "Reranking (vs baselines)",
  eval_judge: "Eval judge",
};

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { routing } = loaderData;
  const availableModels = routing.registry
    .filter((m) => routing.providers[m.provider])
    .map((m) => `${m.provider}:${m.id}`);

  const [selectedModels, setSelectedModels] = useState<string[]>(availableModels);
  const [selectedTasks, setSelectedTasks] = useState<string[]>(routing.tasks);
  const [itemsLimit, setItemsLimit] = useState(6);
  const [run, setRun] = useState<BenchmarkRun>(loaderData.benchmark);
  const [history, setHistory] = useState<RunSummary[]>(loaderData.history);
  const [aggregate, setAggregate] = useState<AggregateEntry[]>(loaderData.aggregate);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (run.status === "running" && timer.current === null) {
      timer.current = setInterval(async () => {
        const latest = await getBenchmark();
        setRun(latest);
        if (latest.status !== "running" && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
          setHistory(await getBenchmarkHistory());
          setAggregate(await getBenchmarkAggregate());
        }
      }, 1500);
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [run.status]);

  async function start(force: boolean) {
    setError(null);
    try {
      setRun(
        await postBenchmark({
          models: selectedModels,
          tasks: selectedTasks,
          items_limit: itemsLimit,
          force,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function stop() {
    try {
      await stopBenchmark();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggle(list: string[], setList: (v: string[]) => void, item: string) {
    setList(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  }

  const done = new Set(aggregate.map((e) => `${e.task}|${e.provider}:${e.model}`));
  const missingCount = selectedTasks.reduce(
    (acc, t) =>
      acc + selectedModels.filter((m) => !done.has(`${t}|${m}`)).length,
    0,
  );

  // Scoreboard shows the AGGREGATE (latest result per task×model across
  // all runs), overlaid with anything the live run has produced so far.
  const merged = new Map<string, TaskResult & { run_id?: string }>();
  for (const e of aggregate) merged.set(`${e.task}|${e.provider}:${e.model}`, e);
  for (const r of run.results ?? [])
    merged.set(`${r.task}|${r.provider}:${r.model}`, { ...r, run_id: "live" });
  const byTask = new Map<string, (TaskResult & { run_id?: string })[]>();
  for (const r of merged.values()) {
    byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 md:p-10">
      <Nav active="analytics" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Model analytics</h1>
        <p className="text-sm text-muted-foreground">
          Benchmark every model at every assignable task over the committed eval
          set. Results aggregate across runs — already-benchmarked combos are
          skipped unless you Rerun selected. Models are pinned with no
          fallback: failures count as errors, not as someone else's score.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run a benchmark</CardTitle>
          <CardDescription>
            {itemsLimit} eval items per task (plus unanswerables). Local models
            take seconds per call — start small.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">models</span>
            {availableModels.map((m) => (
              <Button
                key={m}
                variant={selectedModels.includes(m) ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => toggle(selectedModels, setSelectedModels, m)}
              >
                {m}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">tasks</span>
            {routing.tasks.map((t) => (
              <Button
                key={t}
                variant={selectedTasks.includes(t) ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => toggle(selectedTasks, setSelectedTasks, t)}
              >
                {t}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">items</span>
            {[3, 6, 12, 28].map((n) => (
              <Button
                key={n}
                variant={itemsLimit === n ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setItemsLimit(n)}
              >
                {n}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => void start(false)}
              disabled={run.status === "running" || missingCount === 0}
            >
              {run.status === "running"
                ? "running…"
                : `Run missing (${missingCount})`}
            </Button>
            <Button
              variant="outline"
              onClick={() => void start(true)}
              disabled={
                run.status === "running" ||
                selectedModels.length === 0 ||
                selectedTasks.length === 0
              }
            >
              Rerun selected
            </Button>
            {run.status === "running" && (
              <>
                <Button variant="outline" onClick={() => void stop()}>
                  Stop
                </Button>
                <span className="text-xs text-muted-foreground">
                  {run.progress_done}/{run.progress_total} · {run.current}
                </span>
              </>
            )}
            {run.status === "stopped" && (
              <Badge variant="muted">stopped — partial results kept</Badge>
            )}
            {run.status === "failed" && (
              <Badge variant="destructive">failed: {run.error}</Badge>
            )}
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>
          {run.status === "running" && (
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full bg-primary transition-all"
                style={{
                  width: `${(100 * run.progress_done) / Math.max(1, run.progress_total)}%`,
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {[...byTask.entries()].map(([task, results]) => (
        <TaskCard key={task} task={task} results={results} />
      ))}

      {run.status === "completed" && byTask.size === 0 && (
        <p className="text-sm text-muted-foreground">no results.</p>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Previous runs</CardTitle>
            <CardDescription>
              Persisted server-side (PVC in k8s) — survive pod restarts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {history.map((h) => (
              <div key={h.run_id} className="flex items-center gap-2 text-xs">
                <Button
                  variant="ghost"
                  className="h-6 px-2 font-mono text-xs"
                  onClick={async () => setRun(await getBenchmarkRun(h.run_id))}
                >
                  {h.run_id}
                </Button>
                <Badge variant={h.status === "completed" ? "accent" : "muted"}>
                  {h.status}
                </Badge>
                <span className="text-muted-foreground">
                  {h.models.length} models · {h.tasks.join(", ")} · n={h.items_limit}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function TaskCard({
  task,
  results,
}: {
  task: string;
  results: (TaskResult & { run_id?: string })[];
}) {
  const headline = HEADLINE[task];
  const metricKeys = [...new Set(results.flatMap((r) => Object.keys(r.metrics)))];
  const sorted = [...results].sort(
    (a, b) => (b.metrics[headline.metric] ?? 0) - (a.metrics[headline.metric] ?? 0),
  );
  const best = sorted[0]?.metrics[headline.metric] ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{TASK_TITLES[task] ?? task}</CardTitle>
        <CardDescription>headline: {headline.label}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          {sorted.map((r) => {
            const v = r.metrics[headline.metric] ?? 0;
            return (
              <div key={`${r.provider}:${r.model}`} className="flex items-center gap-2">
                <span className="w-56 truncate font-mono text-xs">
                  {r.provider}:{r.model}
                </span>
                <div className="h-3 flex-1 rounded-sm bg-muted">
                  <div
                    className={
                      "h-3 rounded-sm " +
                      (v >= best && v > 0 ? "bg-primary" : "bg-primary/50")
                    }
                    style={{ width: `${Math.max(2, v * 100)}%` }}
                  />
                </div>
                <span className="w-12 text-right font-mono text-xs">{v.toFixed(3)}</span>
              </div>
            );
          })}
        </div>
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">model</th>
              {metricKeys.map((k) => (
                <th key={k} className="py-1 pr-2">{k}</th>
              ))}
              <th className="py-1 pr-2">errors</th>
              <th className="py-1 pr-2">latency</th>
              <th className="py-1 pr-2">cost</th>
              <th className="py-1 pr-2">run</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.provider}:${r.model}`} className="border-t border-border">
                <td className="py-1 pr-2 font-mono">{r.provider}:{r.model}</td>
                {metricKeys.map((k) => (
                  <td key={k} className="py-1 pr-2">
                    {r.metrics[k] !== undefined ? r.metrics[k].toFixed(3) : "—"}
                  </td>
                ))}
                <td className="py-1 pr-2">{r.errors}/{r.n}</td>
                <td className="py-1 pr-2">
                  {r.mean_latency_ms ? `${(r.mean_latency_ms / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="py-1 pr-2">
                  {r.total_cost_usd ? `$${r.total_cost_usd.toFixed(4)}` : "$0"}
                </td>
                <td className="py-1 pr-2 font-mono text-muted-foreground">
                  {r.run_id ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
