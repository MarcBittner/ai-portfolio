import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory Mongo so the config singleton upsert runs without Atlas. Includes the
// `config` collection the model reads/writes.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { config: "config", configHistory: "configHistory" },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import { getConfig, getConfigValues, updateConfig, ConfigPatch, __resetConfigCache } from "@/lib/models";

beforeEach(() => {
  resetStore();
  __resetConfigCache(); // the config read is TTL-cached; drop it so each test resolves fresh
});

// Snapshot + restore the env vars the config layer reads, so a test that sets one
// doesn't leak into the next.
const ENV_VARS = [
  "FLOTILLA_MASK_BY_DEFAULT",
  "FLOTILLA_MIGRATIONS_BY_DEFAULT",
  "FLOTILLA_DEFAULT_TTL_HOURS",
  "AUTO_INGEST_BACKUPS",
  "AUTO_INGEST_INTERVAL_MS",
  "SNAPSHOT_REPO",
  "FLOTILLA_DEFAULT_TEST_KIND",
  "OLLAMA_BASE_URL",
  "OLLAMA_URL",
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getConfig — provenance resolution", () => {
  it("returns hardcoded defaults with provenance 'default' when nothing is set", async () => {
    const view = await getConfig();
    expect(view.values.maskByDefault).toBe(true);
    expect(view.values.migrationsByDefault).toBe(true);
    expect(view.values.defaultTtlHours).toBe(null);
    expect(view.values.autoIngestEnabled).toBe(false);
    expect(view.fields.maskByDefault.overriddenBy).toBe("default");
    expect(view.fields.defaultTtlHours.overriddenBy).toBe("default");
  });

  it("reads env defaults with provenance 'env'", async () => {
    process.env.FLOTILLA_MASK_BY_DEFAULT = "false";
    process.env.AUTO_INGEST_BACKUPS = "1";
    process.env.AUTO_INGEST_INTERVAL_MS = "120000"; // → 2 minutes
    process.env.SNAPSHOT_REPO = "acme/snaps";
    const view = await getConfig();
    expect(view.values.maskByDefault).toBe(false);
    expect(view.fields.maskByDefault.overriddenBy).toBe("env");
    expect(view.values.autoIngestEnabled).toBe(true);
    expect(view.values.autoIngestIntervalMinutes).toBe(2);
    expect(view.fields.autoIngestIntervalMinutes.overriddenBy).toBe("env");
    expect(view.values.snapshotRepo).toBe("acme/snaps");
  });

  it("ollamaUrl reads OLLAMA_BASE_URL (preferred) then OLLAMA_URL (legacy alias)", async () => {
    // Default when neither is set.
    expect((await getConfig()).values.ollamaUrl).toBe("http://localhost:11434");

    // Legacy alias only.
    process.env.OLLAMA_URL = "http://legacy:11434";
    __resetConfigCache();
    let view = await getConfig();
    expect(view.values.ollamaUrl).toBe("http://legacy:11434");
    expect(view.fields.ollamaUrl.overriddenBy).toBe("env");

    // OLLAMA_BASE_URL wins over the legacy alias when both are present.
    process.env.OLLAMA_BASE_URL = "http://preferred:11434";
    __resetConfigCache();
    view = await getConfig();
    expect(view.values.ollamaUrl).toBe("http://preferred:11434");
  });
});

describe("updateConfig — persist + override env", () => {
  it("stored values win over env and are marked 'stored'", async () => {
    process.env.FLOTILLA_MASK_BY_DEFAULT = "true";
    await updateConfig({ maskByDefault: false, defaultTtlHours: 48 }, "op@x.com");
    const view = await getConfig();
    expect(view.values.maskByDefault).toBe(false); // stored beats env
    expect(view.fields.maskByDefault.overriddenBy).toBe("stored");
    expect(view.values.defaultTtlHours).toBe(48);
    expect(view.fields.defaultTtlHours.overriddenBy).toBe("stored");
    expect(view.updatedBy).toBe("op@x.com");
  });

  it("a null TTL is a real stored override (no TTL), not 'unset'", async () => {
    process.env.FLOTILLA_DEFAULT_TTL_HOURS = "12";
    await updateConfig({ defaultTtlHours: null });
    const view = await getConfig();
    expect(view.values.defaultTtlHours).toBe(null);
    expect(view.fields.defaultTtlHours.overriddenBy).toBe("stored");
  });

  it("getConfigValues returns just the resolved values", async () => {
    await updateConfig({ migrationsByDefault: false });
    const values = await getConfigValues();
    expect(values.migrationsByDefault).toBe(false);
    expect(values.maskByDefault).toBe(true);
  });
});

describe("ConfigPatch — rejects read-only / secret keys", () => {
  it("throws on an unrecognized (non-editable) key", () => {
    expect(() => ConfigPatch.parse({ allowedEmails: ["x@y.com"] })).toThrow();
    expect(() => ConfigPatch.parse({ prodConvexDeployment: "hacked" })).toThrow();
  });

  it("rejects an invalid snapshotRepo shape", () => {
    expect(() => ConfigPatch.parse({ snapshotRepo: "not-a-repo" })).toThrow();
  });

  it("accepts a valid subset patch", () => {
    const p = ConfigPatch.parse({ maskByDefault: false, defaultTestKind: "regression" });
    expect(p).toEqual({ maskByDefault: false, defaultTestKind: "regression" });
  });
});
