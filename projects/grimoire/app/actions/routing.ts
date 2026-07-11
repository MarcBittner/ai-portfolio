"use server";

import { canGlobal } from "@/lib/permissions";
import { repos } from "@/lib/repos";
import { resolveMode, type Mode } from "@/lib/llm";
import { currentPrincipal, db } from "@/lib/server/data";

// Persisted LLM routing configuration (admin-editable). `mode` selects which
// server-side provider chain a request walks (see lib/llm CHAIN). `preferLocal`
// asks AI surfaces that CAN reach the user's browser Ollama to try it first
// (privacy / no cost) before the server providers — used by the editor assists.
export interface RoutingConfig {
  mode: Mode;
  preferLocal: boolean;
}

const DEFAULT: RoutingConfig = { mode: "auto", preferLocal: false };
const MODES: Mode[] = ["auto", "paid", "local", "free", "offline"];

/** Read the routing config (any signed-in principal). Falls back to defaults. */
export async function getRoutingConfig(): Promise<RoutingConfig> {
  const principal = await currentPrincipal();
  if (!principal) return DEFAULT;
  const row = await repos(await db()).settings.findOne({ key: "routing" });
  const v = (row?.value ?? {}) as Partial<RoutingConfig>;
  return {
    mode: MODES.includes(v.mode as Mode) ? (v.mode as Mode) : DEFAULT.mode,
    preferLocal: !!v.preferLocal,
  };
}

/** Update the routing config. Admin/Super only (managePermissions capability). */
export async function setRoutingConfig(
  cfg: RoutingConfig,
): Promise<{ ok: boolean; error?: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!canGlobal(principal, "managePermissions")) return { ok: false, error: "Admins only." };

  const mode = resolveMode(MODES.includes(cfg.mode) ? cfg.mode : "auto");
  const value = { mode, preferLocal: !!cfg.preferLocal };
  await repos(await db()).settings.upsert(
    { key: "routing" },
    { key: "routing", value, updatedAt: Date.now() },
  );
  return { ok: true };
}
