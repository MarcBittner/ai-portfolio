// lib/aiRouter.ts — the Ask-AI multi-provider router with ordered fallback.
//
// SHAPE (mirrors persona-twin's LLMRouter, src/persona_twin/llm/router.py): an
// ordered list of candidate providers is walked in turn; the first that is
// configured AND succeeds answers; any error / missing-key records a failover
// reason and falls through to the next; a guaranteed-terminal fallback
// (`deterministic`, a non-AI keyword map — persona-twin's "mock" provider) means
// a request can degrade but never die with an empty hand. Every failover is
// recorded (fellBackFrom) exactly like persona-twin's `fallbacks_taken`.
//
// The chain: auto -> anthropic -> openai -> ollama -> free -> deterministic.
//   - `auto` walks the whole chain from the top.
//   - An explicit provider STARTS at that provider, then falls through the
//     remainder of the chain on failure (honoring the chosen start point).
//   - `deterministic` alone answers from the local help map (always works).
//
// SECURITY: API keys are read from env INSIDE each provider and sent only as the
// documented auth header. They are never returned to a caller, never logged, and
// never interpolated into an error/answer. This module is READ-ONLY advice — it
// explains the dashboard, it never acts.

import {
  callAnthropicTool,
  anthropicConfigured,
  type AnthropicTool,
} from "./clients/anthropic.ts";
import { getConfigValues } from "./models/config.ts";
import { resolveOllamaBaseUrl, resolveOllamaModel } from "./ollamaSetup.ts";

export type AiProvider =
  | "auto"
  | "anthropic"
  | "openai"
  | "ollama"
  | "free"
  | "deterministic";

// The ordered fallback chain (excludes the `auto` alias, which means "start at the
// top"). deterministic is last + always succeeds — the terminal fallback.
export const CHAIN: Exclude<AiProvider, "auto">[] = [
  "anthropic",
  "openai",
  "ollama",
  "free",
  "deterministic",
];

export type AskResult = {
  answer: string;
  provider: Exclude<AiProvider, "auto">;
  // The providers that were tried and fell through before one answered, each with
  // a short reason (e.g. "anthropic: not configured"). Omitted when the first
  // provider answered.
  fellBackFrom?: string[];
};

// Resolved runtime config the providers need (which model / where Ollama lives).
export type ResolvedAiConfig = { model: string; ollamaUrl: string };

// A provider attempt: returns prose, or THROWS (missing key / network / API error)
// to trigger failover — persona-twin's "exception -> failover" contract.
export type ProviderFn = (
  question: string,
  context: string,
  cfg: ResolvedAiConfig,
) => Promise<string>;

export type AskArgs = {
  question: string;
  // Optional grounding context (e.g. the current page/route) appended to the
  // system prompt so the model knows where the operator is.
  context?: string;
  // Explicit start point. When omitted, the config-selected provider is used
  // (which itself defaults to "auto").
  provider?: AiProvider;
};

// Injectable seams for tests: override the config resolution and/or any provider
// (mirrors lib/aiTriage.ts's TriageDeps). Real implementations are the defaults.
export type AiRouterDeps = {
  resolveConfig?: () => Promise<{ provider: AiProvider } & ResolvedAiConfig>;
  providers?: Partial<Record<Exclude<AiProvider, "auto">, ProviderFn>>;
  env?: NodeJS.ProcessEnv;
};

const OLLAMA_TIMEOUT_MS = 30_000;
const OPENAI_TIMEOUT_MS = 30_000;
const FREE_TIMEOUT_MS = 30_000;
const FREE_DISCOVERY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Dashboard-context system prompt (the "prompt guard")
// ---------------------------------------------------------------------------
// Describes THIS app so any model answers grounded to it. Read-only posture: if
// asked to DO something destructive it explains HOW an operator would, and never
// claims to have acted.
const SYSTEM_PROMPT = [
  "You are the built-in assistant for flotilla, an operator tool that",
  "manages preview/staging INSTANCES. An instance is the product of three things:",
  "(1) git branch code, (2) a prod-data-clone dataset that is PII-masked, and",
  "(3) a Clerk auth config — provisioned across Convex + Vercel + Clerk.",
  "",
  "Concepts you understand and can explain:",
  "- Provisioning / launch: creating an instance from a branch + a snapshot.",
  "- Backups: a GitHub-Releases snapshot store of Convex data (ZIP assets).",
  "- Feature flags: Config -> Features toggles (behaviour only, never security).",
  "- Queue / DLQ: the async job worker and its dead-letter queue.",
  "- Drift / Refresh-vs-Sync: Argo-style detection that an instance is OutOfSync",
  "  (stale data or a missing branch) vs Synced with its launched spec.",
  "- Share links: per-person revocable reviewer access to an instance.",
  "- AI triage / smoke-gate / fix-loop: read-only AI helpers on failed runs.",
  "- Cost estimates: a ROUGH flat-rate-per-instance/day figure, never real billing.",
  "- Logs aggregation and PII masking of cloned data.",
  "- Monitoring / alerts: Nagios-style monitors in the Monitoring tab. A monitor is a",
  "  CLOSED check-type (metric_threshold = a bounded comparison on one metric series;",
  "  http_reachability = GET a URL/instance and assert it's up/returns a status;",
  "  instance_status = read an instance's lifecycle/health) bound to a target selector",
  "  (instance / instanceType / serviceType / all / url), with an interval, retries, and",
  "  notify settings (channels + a severity floor + an optional escalation policy).",
  "",
  "Rules:",
  "- Keep every answer grounded in this dashboard and its concepts above. If a",
  "  question is outside this scope, say so briefly.",
  "- You are READ-ONLY. If asked to perform a destructive action (teardown, delete",
  "  a backup, refresh prod), EXPLAIN how an operator would do it in the UI — never",
  "  claim to have done it and never invent that you took an action.",
  "- For monitor setup you may DRAFT a monitor config (a check-type + target +",
  "  thresholds/notify) and describe it, but you never create or change a monitor",
  "  yourself — tell the operator to confirm it in the Monitoring tab (the",
  "  'Draft with AI' flow pre-fills the New-monitor form for them to review + create).",
  "- Be concise and practical. Prefer pointing at the exact tab/panel/button.",
].join("\n");

function buildSystem(context?: string): string {
  const ctx = context?.trim();
  return ctx ? `${SYSTEM_PROMPT}\n\nThe operator is currently on: ${ctx}` : SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// providerAvailable — is a provider configured enough to be worth attempting?
// ---------------------------------------------------------------------------
// A best-effort check the route/UI can use. `ollama` + `deterministic` are always
// "available" (reachability is only known once we actually call Ollama; the
// deterministic map is local). The key-bearing providers report on their env key.
export function providerAvailable(
  name: Exclude<AiProvider, "auto">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (name) {
    case "anthropic":
      return Boolean(env.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(env.OPENAI_API_KEY);
    case "free":
      // "free" is OpenRouter's $0/$0 tier (persona-twin's free lineup). OpenRouter
      // still needs a key even for free models, so treat the key as the gate.
      return Boolean(env.OPENROUTER_API_KEY);
    case "ollama":
    case "deterministic":
      return true;
  }
}

// ---------------------------------------------------------------------------
// Real provider implementations
// ---------------------------------------------------------------------------

// anthropic — reuse the existing direct-fetch client. We force a single-tool call
// (submit_answer) so we get structured prose back rather than parsing free text,
// exactly matching the aiTriage reuse pattern. Throws if ANTHROPIC_API_KEY unset.
const ANSWER_TOOL: AnthropicTool = {
  name: "submit_answer",
  description:
    "Return your answer to the operator's question about the flotilla. " +
    "Read-only: explain, never claim to have taken an action.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "A concise, grounded answer to the operator's question.",
      },
    },
    required: ["answer"],
    additionalProperties: false,
  },
};

const anthropicProvider: ProviderFn = async (question, context, cfg) => {
  if (!anthropicConfigured()) throw new Error("not configured");
  const out = await callAnthropicTool<{ answer: string }>({
    system: buildSystem(context),
    messages: [{ role: "user", content: question }],
    tool: ANSWER_TOOL,
    // model "" -> the anthropic client resolves its own default (claude-sonnet-4-6)
    model: cfg.model || undefined,
    maxTokens: 1024,
  });
  const answer = (out.answer ?? "").trim();
  if (!answer) throw new Error("empty answer");
  return answer;
};

// openai — direct fetch to the chat/completions endpoint. Skips (throws) when
// OPENAI_API_KEY is unset. Key is sent only as the Authorization bearer header.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const openaiProvider: ProviderFn = async (question, context, cfg) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("not configured");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model || "gpt-4o-mini",
      max_tokens: 1024,
      messages: [
        { role: "system", content: buildSystem(context) },
        { role: "user", content: question },
      ],
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Never interpolate the key; the body doesn't contain it anyway.
    throw new Error(`openai ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const answer = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("empty answer");
  return answer;
};

// ollama — POST to a local daemon's /api/chat (mirrors persona-twin ollama.ts:
// stream:false, system+user messages, bounded timeout). Skips (throws) when the
// daemon is unreachable. No key involved.
const ollamaProvider: ProviderFn = async (question, context, cfg) => {
  // Base URL + model come from the shared resolver so the router, the setup
  // endpoint, and the setup commands the UI shows all agree on the SAME model
  // (config aiModel ?? OLLAMA_MODEL env ?? the shipped default).
  const base = resolveOllamaBaseUrl(cfg.ollamaUrl);
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: resolveOllamaModel(cfg.model),
      stream: false,
      messages: [
        { role: "system", content: buildSystem(context) },
        { role: "user", content: question },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const answer = (data.message?.content ?? "").trim();
  if (!answer) throw new Error("empty answer");
  return answer;
};

// free — OpenRouter's $0/$0 tier (persona-twin's "free" lineup, openrouter_llm.py).
// OpenRouter still requires OPENROUTER_API_KEY even for free models, so it skips
// (throws) without one. We discover a free model keyless (best-effort), falling
// back to a known free id, then complete via the OpenAI-compatible endpoint.
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_FALLBACK_FREE_MODEL = "meta-llama/llama-3.1-8b-instruct:free";
// OpenRouter's recommended (optional) attribution headers — they identify this app
// on OpenRouter's dashboard/leaderboards and are documented as good practice. Not a
// secret; safe to send. See https://openrouter.ai/docs/api-reference/overview.
const OPENROUTER_REFERER = "https://flotilla.example.com";
const OPENROUTER_TITLE = "flotilla";

async function discoverFreeModel(): Promise<string> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/models`, {
      signal: AbortSignal.timeout(FREE_DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return OPENROUTER_FALLBACK_FREE_MODEL;
    const data = (await res.json()) as {
      data?: { id: string; pricing?: { prompt?: string; completion?: string } }[];
    };
    const free = (data.data ?? []).find(
      (m) =>
        Number(m.pricing?.prompt ?? 1) === 0 &&
        Number(m.pricing?.completion ?? 1) === 0,
    );
    return free?.id ?? OPENROUTER_FALLBACK_FREE_MODEL;
  } catch {
    return OPENROUTER_FALLBACK_FREE_MODEL;
  }
}

const freeProvider: ProviderFn = async (question, context, cfg) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("not configured");
  const model = cfg.model || (await discoverFreeModel());
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      // OpenRouter attribution headers (optional but recommended).
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_TITLE,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: buildSystem(context) },
        { role: "user", content: question },
      ],
    }),
    signal: AbortSignal.timeout(FREE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const answer = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!answer) throw new Error("empty answer");
  return answer;
};

// ---------------------------------------------------------------------------
// deterministic — the guaranteed-terminal, NON-AI fallback
// ---------------------------------------------------------------------------
// A small keyword map over the dashboard's own help content, so Ask-AI always
// returns SOMETHING useful even with no provider configured and no network. Each
// entry is grounded in a real dashboard concept; the first matching rule wins.
type DetRule = { keywords: string[]; answer: string };
const DET_RULES: DetRule[] = [
  {
    keywords: ["provision", "launch", "create instance", "new instance", "spin up"],
    answer:
      "Provisioning launches a new instance = branch code x a PII-masked prod-data " +
      "clone x a Clerk config, across Convex + Vercel + Clerk. Start it from the " +
      "Instances tab; omitted fields fall back to the defaults in Config -> " +
      "Provisioning defaults.",
  },
  {
    keywords: ["backup", "snapshot", "restore", "ingest"],
    answer:
      "Backups are Convex data snapshots stored as ZIP assets in a private " +
      "GitHub-Releases snapshot store (Config -> Snapshot repo). The Backups tab " +
      "lists them; the worker can auto-ingest new cloud backups when that flag is on.",
  },
  {
    keywords: ["mask", "pii", "scrub", "raw data", "anonymiz"],
    answer:
      "Cloned prod data is PII-masked by default (scrubPII). Prod / staging-prod " +
      "sources are always masked regardless of the toggle. A clone's badge shows " +
      "'masked' (safe) or 'raw'. The default lives in Config -> Provisioning defaults.",
  },
  {
    keywords: ["queue", "dlq", "dead letter", "dead-letter", "worker", "job"],
    answer:
      "Async work (provisions, tests) runs in a job worker. Jobs that exhaust " +
      "their retries move to the dead-letter queue (DLQ) instead of looping; you " +
      "can inspect and revive them from the Queue health panel.",
  },
  {
    keywords: ["drift", "sync", "outofsync", "refresh", "out of sync"],
    answer:
      "Drift uses an Argo-style Refresh-vs-Sync model: an instance is OutOfSync " +
      "when a live signal drifted (a newer data clone exists, or its branch is " +
      "gone) and Synced when it matches its launched spec. Enable Drift badges in " +
      "Config -> Features.",
  },
  {
    keywords: ["share", "reviewer", "link", "access"],
    answer:
      "Scoped share links give a named person revocable, one-click reviewer access " +
      "to a single instance without break-glass. Manage them from the Share-access " +
      "card on the instance detail page (enable Scoped share links in Config).",
  },
  {
    keywords: ["triage", "diagnose", "why failed", "root cause", "failure"],
    answer:
      "AI failure-triage reads a failed instance's config + error logs and returns " +
      "a grounded root-cause + suggested fix. It is READ-ONLY (it explains, it " +
      "never acts), needs ANTHROPIC_API_KEY, and is gated by the aiFailureTriage flag.",
  },
  {
    keywords: ["smoke", "gate", "promotion", "verdict"],
    answer:
      "The AI smoke-gate turns a completed test run's checks into an advisory " +
      "promote/hold/caution verdict with blockers. It is read-only and appears on " +
      "completed runs in Testing when the aiSmokeGate flag is on.",
  },
  {
    keywords: ["fix loop", "fix-loop", "auto-fix", "autofix"],
    answer:
      "The AI-validated fix loop proposes a CLOSED set of parameter fixes for a " +
      "FAILED instance, applies each to its disposable clone, and re-provisions — " +
      "the verdict is the real provision result, never the model's claim. Bounded " +
      "and surface-only; it never touches prod or other instances.",
  },
  {
    keywords: ["cost", "estimate", "billing", "price", "spend"],
    answer:
      "Cost estimates are a ROUGH figure: a flat USD/day rate (Config -> Cost " +
      "visibility) x how long each instance has run. It is NOT real billing — every " +
      "figure is labelled 'est.' — and only renders when the Cost estimates flag is on.",
  },
  {
    keywords: ["log", "logs", "aggregat"],
    answer:
      "The Logs tab aggregates logs across an instance's Convex + Vercel + worker " +
      "sources so you can read a failure's context in one place.",
  },
  {
    keywords: ["clerk", "auth", "user", "managed user"],
    answer:
      "Each instance gets its own Clerk auth config; per-instance Clerk secret keys " +
      "live in Mongo, never in env. Manage configs from the Clerk tab and managed " +
      "test users from the Users tab.",
  },
  {
    keywords: ["ttl", "expire", "expiry", "auto-expire"],
    answer:
      "A TTL auto-expires an instance after N hours. Set a default in Config -> " +
      "Provisioning defaults (empty = no TTL); the detail page shows a live countdown.",
  },
  {
    keywords: ["monitor", "alert", "nagios", "escalation", "threshold", "downtime"],
    answer:
      "The Monitoring tab runs Nagios-style monitors on a cron sweep. A monitor is a " +
      "CLOSED check-type — metric_threshold (a bounded comparison on one metric series), " +
      "http_reachability (GET a URL/instance, assert it's up), or instance_status (read an " +
      "instance's lifecycle/health) — bound to a target selector (instance / instanceType / " +
      "serviceType / all / url) with an interval, retries, and notify settings (channels + a " +
      "severity floor + optional escalation policy). Create one with 'New monitor', or use " +
      "'Draft with AI' to turn a plain-English request into a pre-filled draft you confirm.",
  },
  {
    keywords: ["feature", "flag", "config", "setting", "toggle"],
    answer:
      "Config -> Features holds behaviour toggles (reliability nets default ON; new " +
      "opt-ins default OFF). They never control security remediations — the prod/" +
      "shared-deployment guards stay read-only and enforced in their own modules.",
  },
];

const DET_FALLBACK =
  "flotilla manages preview/staging instances = branch code x a " +
  "PII-masked prod-data clone x a Clerk config, across Convex + Vercel + Clerk. " +
  "You can provision instances, manage backups/snapshots, run tests, and inspect " +
  "logs. No AI provider is configured, so this is a built-in answer — ask about a " +
  "specific area (provisioning, backups, drift, queue, share links, cost, masking) " +
  "for more, or configure a provider in Config -> Ask AI.";

// Answer from the keyword map. NEVER throws — this is the terminal fallback.
export function deterministicAnswer(question: string): string {
  const q = question.toLowerCase();
  for (const rule of DET_RULES) {
    if (rule.keywords.some((k) => q.includes(k))) return rule.answer;
  }
  return DET_FALLBACK;
}

const deterministicProvider: ProviderFn = async (question) =>
  deterministicAnswer(question);

const REAL_PROVIDERS: Record<Exclude<AiProvider, "auto">, ProviderFn> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
  free: freeProvider,
  deterministic: deterministicProvider,
};

// ---------------------------------------------------------------------------
// askAi — walk the chain and return the first answer
// ---------------------------------------------------------------------------
async function defaultResolveConfig(): Promise<
  { provider: AiProvider } & ResolvedAiConfig
> {
  // getConfigValues never throws (resilient); if the store is down it returns the
  // env/hardcoded defaults, so the router still works.
  const v = await getConfigValues();
  return { provider: v.aiProvider, model: v.aiModel, ollamaUrl: v.ollamaUrl };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function askAi(
  args: AskArgs,
  deps: AiRouterDeps = {},
): Promise<AskResult> {
  const env = deps.env ?? process.env;
  const resolveConfig = deps.resolveConfig ?? defaultResolveConfig;
  const { provider: configured, ...cfg } = await resolveConfig();

  // Where does the chain start? An explicit arg wins over config; both default to
  // "auto" (walk from the top). An unknown/invalid start falls back to the top.
  const start = args.provider ?? configured ?? "auto";
  const from = start === "auto" ? 0 : Math.max(0, CHAIN.indexOf(start));
  const chain = CHAIN.slice(from);

  const context = args.context;
  const fellBackFrom: string[] = [];

  for (const name of chain) {
    const injected = deps.providers?.[name];
    // Real key-bearing providers we can cheaply pre-check are skipped cleanly when
    // unconfigured (a clean "not configured" reason, no pointless network call).
    // Injected providers (tests) always run so a mocked failure is observed.
    if (!injected && !providerAvailable(name, env)) {
      fellBackFrom.push(`${name}: not configured`);
      continue;
    }
    const run = injected ?? REAL_PROVIDERS[name];
    try {
      const answer = await run(args.question, context ?? "", cfg);
      return {
        answer,
        provider: name,
        fellBackFrom: fellBackFrom.length ? fellBackFrom : undefined,
      };
    } catch (err) {
      fellBackFrom.push(`${name}: ${reason(err)}`);
    }
  }

  // The chain always ends at deterministic, which never throws — but if a caller
  // narrowed the start past it, guarantee an answer anyway.
  return {
    answer: deterministicAnswer(args.question),
    provider: "deterministic",
    fellBackFrom: fellBackFrom.length ? fellBackFrom : undefined,
  };
}
