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
  fallbacks_taken: string[];
  estimated_cost_usd: number | null;
  latency_ms: number | null;
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

export const HEXACO_LABELS: Record<keyof HexacoProfile, string> = {
  honesty_humility: "Honesty–Humility",
  emotionality: "Emotionality",
  extraversion: "Extraversion",
  agreeableness: "Agreeableness",
  conscientiousness: "Conscientiousness",
  openness: "Openness",
};
