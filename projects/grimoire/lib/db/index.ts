// Database factory — picks the impl from the environment, so swapping stores is
// a config change, never a code change. MONGODB_URI set → Atlas; otherwise the
// in-memory store (zero-credential dev/test). Convex would slot in here later as
// a third adapter.

import { MemoryDatabase } from "./memory";
import { MongoDatabase } from "./mongo";
import type { Database } from "./types";

export type { Collection, Database, Entity, Filter } from "./types";
export { MemoryDatabase } from "./memory";
export { MongoDatabase } from "./mongo";

let singleton: Database | null = null;

/** Process-wide database handle. Memory unless MONGODB_URI is configured. */
export async function getDatabase(env: NodeJS.ProcessEnv = process.env): Promise<Database> {
  if (singleton) return singleton;
  const uri = env.MONGODB_URI;
  if (uri) {
    singleton = await MongoDatabase.connect(uri, env.MONGODB_DB ?? "coverdocs");
  } else {
    singleton = new MemoryDatabase();
  }
  return singleton;
}

/** Test helper — reset the cached handle. */
export async function _resetDatabase(): Promise<void> {
  if (singleton) await singleton.close();
  singleton = null;
}
