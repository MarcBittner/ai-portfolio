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

// ---- Twin-vs-twin interview ----

export interface InterviewRound {
  question: string;
  answer: string;
  answered: boolean;
  citations: Citation[];
}

export interface InterviewTranscript {
  interviewer_id: string;
  subject_id: string;
  rounds: InterviewRound[];
}

export function runInterview(
  interviewerId: string,
  subjectId: string,
  rounds: number,
): Promise<InterviewTranscript> {
  return request<InterviewTranscript>("/interview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      interviewer_id: interviewerId,
      subject_id: subjectId,
      rounds,
    }),
  });
}

// ---- Persona builder ----

export interface DocumentInput {
  name: string;
  text: string;
}

export interface DocRedaction {
  name: string;
  counts: Record<string, number>;
  redacted: string;
}

export interface RedactionPreview {
  documents: DocRedaction[];
  total_counts: Record<string, number>;
  total: number;
}

export interface PersonaCreate {
  persona_id?: string;
  name: string;
  tagline: string;
  bio: string;
  hexaco: HexacoProfile;
  voice_notes: string[];
  documents: DocumentInput[];
}

export interface PersonaCreated {
  persona: Persona;
  chunks: number;
  redactions: Record<string, number>;
}

export function previewRedaction(
  documents: DocumentInput[],
  signal?: AbortSignal,
): Promise<RedactionPreview> {
  return request<RedactionPreview>("/redaction/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documents }),
    signal,
  });
}

export function createPersona(spec: PersonaCreate): Promise<PersonaCreated> {
  return request<PersonaCreated>("/personas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export function deletePersona(personaId: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/personas/${personaId}`, {
    method: "DELETE",
  });
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

export interface ChatCitations {
  answered: boolean;
  citations: Citation[];
}

export interface ChatHandlers {
  onMeta?: (sessionId: string) => void;
  onToken?: (text: string) => void;
  onCitations?: (c: ChatCitations) => void;
  onDone?: (routing: RoutingDecision) => void;
  onError?: (detail: string) => void;
}

// Streamed conversational twin. Reads the Server-Sent Events body off the
// POST /chat response and dispatches each event to the handlers; resolves
// when the stream closes.
export async function streamChat(
  body: { persona_id: string; message: string; session_id?: string },
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status}: ${await response.text().catch(() => "")}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      dispatchSse(buffer.slice(0, idx), handlers);
      buffer = buffer.slice(idx + 2);
    }
  }
}

function dispatchSse(block: string, h: ChatHandlers): void {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!event || !data) return;
  const parsed = JSON.parse(data);
  if (event === "meta") h.onMeta?.(parsed.session_id);
  else if (event === "token") h.onToken?.(parsed.text);
  else if (event === "citations") h.onCitations?.(parsed as ChatCitations);
  else if (event === "done") h.onDone?.(parsed.routing as RoutingDecision);
  else if (event === "error") h.onError?.(parsed.detail);
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
