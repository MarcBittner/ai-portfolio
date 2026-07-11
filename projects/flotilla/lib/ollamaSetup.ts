// lib/ollamaSetup.ts — the single source of truth for the local-Ollama provider's
// runtime config (base URL + model) AND the guarded, fixed-command "set up Ollama
// on the server host" runner.
//
// WHY THIS FILE EXISTS:
//   - The Ollama base URL + model default were duplicated across lib/aiRouter.ts
//     (the router that CALLS Ollama), lib/aiProviders.ts, and the Config UI. This
//     module centralizes them so the router, the setup endpoint, and the setup
//     commands the UI shows all agree on the SAME model — otherwise the UI tells
//     the operator to `ollama pull X` while the router calls model Y.
//   - PART 2 of the Ollama task: a browser CANNOT run a shell command on the
//     operator's machine, and a Vercel/serverless host can't run Ollama either. The
//     only place a "set up Ollama" click can actually DO anything is a server that
//     itself has the `ollama` binary (local dev / a self-hosted box / the worker).
//     So we expose a server-side runner here, driven by a FIXED command allowlist
//     (no user-supplied args → no shell injection), that the endpoint calls.
//
// SECURITY:
//   - execFile (NOT exec/spawn-through-a-shell): the command + argv are passed as a
//     vector, so nothing is ever interpreted by a shell. There is NO user input in
//     any argv — the only variable is `model`, which is validated against a strict
//     tag charset before it can reach `ollama pull`.
//   - The set of runnable steps is a CLOSED allowlist (`serve`, `pull`). An install
//     step is intentionally NOT runnable (piping a remote script to a shell as the
//     server user is exactly what we must never do on a click) — it is shown to the
//     operator to run themselves.

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Config resolution — the ONE place the Ollama base URL + model are decided.
// ---------------------------------------------------------------------------

// Default local daemon URL + the default chat model the app pulls/uses. The model
// is what the setup commands (`ollama pull <model>`) and the router MUST share.
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "llama3.1:8b";

// Resolve the model the Ollama provider runs. Precedence:
//   explicit config model (aiModel)  ??  OLLAMA_MODEL env  ??  the shipped default.
// The config `aiModel` is shared across providers, so a blank aiModel (the common
// case) falls through to OLLAMA_MODEL / the default rather than sending "" to the
// daemon. `env` is injectable for tests.
export function resolveOllamaModel(
  configModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = (configModel ?? "").trim();
  if (fromConfig) return fromConfig;
  const fromEnv = (env.OLLAMA_MODEL ?? "").trim();
  if (fromEnv) return fromEnv;
  return OLLAMA_DEFAULT_MODEL;
}

// Resolve the base URL the Ollama provider + client probe target, trimming any
// trailing slash. Precedence: the resolved config value (already stored ?? env ??
// default from getConfig) ?? the shipped default. Kept here so the router and the
// endpoint normalize identically.
export function resolveOllamaBaseUrl(configUrl?: string): string {
  const base = (configUrl ?? "").trim() || OLLAMA_DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

// A valid Ollama model tag: name[:tag], optional registry/namespace path. Strict
// charset so a resolved model can NEVER smuggle a shell metacharacter or an extra
// argv into `ollama pull`. (execFile already prevents shell interpretation; this is
// defense-in-depth + it rejects a garbage config value early with a clear error.)
const MODEL_TAG_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*(?::[a-zA-Z0-9._-]+)?$/;

export function isValidModelTag(model: string): boolean {
  return model.length > 0 && model.length <= 200 && MODEL_TAG_RE.test(model);
}

// ---------------------------------------------------------------------------
// The FIXED setup-command allowlist + the copy-able commands the UI shows.
// ---------------------------------------------------------------------------

// The steps a click can run on the server host. This is a CLOSED set — an incoming
// request names a step by key and nothing else; there is no path for arbitrary
// commands. `install` is deliberately absent (see below).
export type OllamaSetupStep = "serve" | "pull";
export const OLLAMA_SETUP_STEPS: readonly OllamaSetupStep[] = ["serve", "pull"] as const;

export function isOllamaSetupStep(v: unknown): v is OllamaSetupStep {
  return typeof v === "string" && (OLLAMA_SETUP_STEPS as readonly string[]).includes(v);
}

// The exact commands shown in the UI as the copy-able fallback (and as the labels
// on the run buttons). Install is COPY-ONLY — piping a remote installer to a shell
// as the server process user must never be a one-click server action.
export function ollamaSetupCommands(model: string): {
  install: string;
  serve: string;
  pull: string;
} {
  return {
    install: "curl -fsSL https://ollama.com/install.sh | sh",
    serve: "ollama serve",
    pull: `ollama pull ${model}`,
  };
}

// ---------------------------------------------------------------------------
// The server-side runner (execFile, fixed argv, no shell).
// ---------------------------------------------------------------------------

export type OllamaRunResult = {
  ok: boolean;
  // A stable machine code the UI/endpoint branches on.
  code: "ran" | "not_available" | "failed";
  step?: OllamaSetupStep;
  model?: string;
  message: string;
  // Combined, size-bounded stdout+stderr tail (never contains secrets — Ollama
  // setup takes no credentials).
  output?: string;
};

// A minimal execFile seam so tests can inject a fake without spawning processes.
export type ExecFileLike = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
  cb: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
) => void;

const DEFAULT_EXEC: ExecFileLike = execFile as unknown as ExecFileLike;

const SETUP_TIMEOUT_MS = 10 * 60_000; // a model pull can be large; bound it anyway
const MAX_OUTPUT = 16 * 1024; // return only a tail — enough to diagnose, never a flood

function tail(s: string): string {
  return s.length <= MAX_OUTPUT ? s : s.slice(s.length - MAX_OUTPUT);
}

// Is the `ollama` binary present on this host? (`ollama --version` exits 0.) Never
// throws — a missing binary / ENOENT resolves false. Injectable exec for tests.
export function ollamaBinaryAvailable(
  exec: ExecFileLike = DEFAULT_EXEC,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      exec("ollama", ["--version"], { timeout: 5_000, maxBuffer: 1024 * 64 }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}

// Run ONE allowlisted setup step on the server host. Contract:
//   - If the `ollama` binary isn't here → { ok:false, code:"not_available" } with a
//     clear "run it locally" message (NEVER a crash — the prod/serverless case).
//   - `serve` starts the daemon (best-effort; if it's already up the command is a
//     no-op-ish success). `pull <model>` downloads the model the router uses.
//   - `model` is validated against the tag charset before it can reach argv.
// No secrets are involved or logged. `exec` is injectable for tests.
export async function runOllamaSetupStep(
  step: OllamaSetupStep,
  model: string,
  exec: ExecFileLike = DEFAULT_EXEC,
): Promise<OllamaRunResult> {
  if (!isOllamaSetupStep(step)) {
    return { ok: false, code: "failed", message: `unknown setup step` };
  }
  if (step === "pull" && !isValidModelTag(model)) {
    return { ok: false, code: "failed", step, message: "invalid model tag" };
  }

  if (!(await ollamaBinaryAvailable(exec))) {
    return {
      ok: false,
      code: "not_available",
      step,
      model,
      message:
        "Ollama is not installed on the server host — this server can't run the " +
        "setup for you. Run the commands shown on your own machine instead.",
    };
  }

  // FIXED argv per step — no user input reaches the command vector (model is the
  // only variable, and it's charset-validated above).
  const argv: Record<OllamaSetupStep, string[]> = {
    serve: ["serve"],
    pull: ["pull", model],
  };

  return new Promise<OllamaRunResult>((resolve) => {
    try {
      exec(
        "ollama",
        argv[step],
        { timeout: SETUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const output = tail(`${stdout ?? ""}${stderr ?? ""}`.trim());
          if (err) {
            resolve({
              ok: false,
              code: "failed",
              step,
              model,
              message:
                step === "pull"
                  ? `Failed to pull ${model}.`
                  : "Failed to start Ollama.",
              output: output || undefined,
            });
            return;
          }
          resolve({
            ok: true,
            code: "ran",
            step,
            model,
            message:
              step === "pull"
                ? `Pulled ${model}.`
                : "Ollama started (or was already running).",
            output: output || undefined,
          });
        },
      );
    } catch {
      resolve({
        ok: false,
        code: "not_available",
        step,
        model,
        message:
          "Ollama is not available on the server host. Run the commands locally.",
      });
    }
  });
}
