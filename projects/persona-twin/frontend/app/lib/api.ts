// Typed client for the persona-twin FastAPI service.
// In dev, Vite proxies /api/* → http://localhost:8000/* (vite.config.ts).

export interface HexacoProfile {
  honesty_humility: number;
  emotionality: number;
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  openness: number;
}

export interface Persona {
  persona_id: string;
  name: string;
  tagline: string;
  bio: string;
  hexaco: HexacoProfile;
  voice_notes: string[];
  doc_count: number;
}

export interface Citation {
  doc_id: string;
  chunk_id: string;
  score: number;
  excerpt: string;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  objective: string;
  task: string | null;
  fallbacks_taken: string[];
  estimated_cost_usd: number | null;
  latency_ms: number | null;
}

export type RouteObjective = "cost" | "latency" | "quality";

export interface TaskRoute {
  objective: RouteObjective | null;
  pin: string | null; // "provider:model_id"
}

export interface RoutingPolicy {
  default_objective: RouteObjective;
  tasks: Record<string, TaskRoute>;
}

export interface ModelSpec {
  provider: string;
  id: string;
  input_per_mtok: number;
  output_per_mtok: number;
  quality: number;
  speed: number;
  adaptive_thinking: boolean;
}

export interface RoutingView {
  policy: RoutingPolicy;
  tasks: string[];
  providers: Record<string, boolean>;
  registry: ModelSpec[];
  plans: Record<string, string[]>;
  cooling_down: Record<string, number>;
  bench_tasks: string[];
}

export interface DebugInfo {
  routing: RoutingDecision | null;
  stage_timings_ms: Record<string, number>;
}

export interface AskResponse {
  persona_id: string;
  question: string;
  answer: string;
  answered: boolean;
  citations: Citation[];
  debug: DebugInfo | null;
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export function listPersonas(): Promise<Persona[]> {
  return request<Persona[]>("/personas");
}

export function ask(
  personaId: string,
  question: string,
  debug = true,
): Promise<AskResponse> {
  return request<AskResponse>("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona_id: personaId, question, debug }),
  });
}

export interface TaskResult {
  task: string;
  provider: string;
  model: string;
  n: number;
  errors: number;
  metrics: Record<string, number>;
  mean_latency_ms: number;
  total_cost_usd: number;
}

export interface RunSummary {
  run_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  items_limit: number;
  tasks: string[];
  models: string[];
  results_count: number;
}

export interface BenchmarkRun {
  run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  progress_done: number;
  progress_total: number;
  current: string | null;
  items_limit: number;
  results: TaskResult[];
  error: string | null;
}

export interface BenchmarkRequest {
  models: string[];
  tasks: string[];
  items_limit: number;
  force: boolean;
}

export interface AggregateEntry extends TaskResult {
  run_id: string;
  finished_at: string | null;
}

export function getBenchmarkAggregate(): Promise<AggregateEntry[]> {
  return request<AggregateEntry[]>("/benchmark/aggregate");
}

export function getBenchmark(): Promise<BenchmarkRun> {
  return request<BenchmarkRun>("/benchmark");
}

export function postBenchmark(body: BenchmarkRequest): Promise<BenchmarkRun> {
  return request<BenchmarkRun>("/benchmark", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function stopBenchmark(): Promise<BenchmarkRun> {
  return request<BenchmarkRun>("/benchmark/stop", { method: "POST" });
}

export function getBenchmarkHistory(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/benchmark/history");
}

export function getBenchmarkRun(runId: string): Promise<BenchmarkRun> {
  return request<BenchmarkRun>(`/benchmark/history/${runId}`);
}

export function getRouting(): Promise<RoutingView> {
  return request<RoutingView>("/routing");
}

export function putRouting(policy: RoutingPolicy): Promise<RoutingView> {
  return request<RoutingView>("/routing", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
}

export const HEXACO_LABELS: Record<keyof HexacoProfile, string> = {
  honesty_humility: "Honesty–Humility",
  emotionality: "Emotionality",
  extraversion: "Extraversion",
  agreeableness: "Agreeableness",
  conscientiousness: "Conscientiousness",
  openness: "Openness",
};
