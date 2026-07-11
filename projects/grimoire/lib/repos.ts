// Repositories — typed collections over the persistence adapter (lib/db). These
// are the app's data entities; every server action / route handler reads & writes
// through here, against whatever store the adapter is pointed at (Mongo Atlas in
// prod, in-memory in tests).

import type { Database, Entity } from "./db/types";
import type { Grant, Role } from "./permissions";

export interface UserRow extends Entity {
  clerkId?: string;
  email: string;
  name?: string;
  role: Role;
  createdAt: number;
}

export interface GrantRow extends Entity, Grant {
  createdBy?: string;
  createdAt: number;
}

export interface GroupRow extends Entity {
  key: string;
  name: string;
  description?: string;
}

export interface GroupMemberRow extends Entity {
  groupKey: string;
  email: string;
}

export interface SpaceRow extends Entity {
  key: string;
  name: string;
  contentRoot: string;
  defaultRole: "read" | "none";
  prWorkflow: boolean;
  // Owner email for a PERSONAL space (see lib/personalSpace). Undefined for a
  // shared space. A personal space is private: defaultRole "none" + a single
  // owner admin grant, so only the owner (and Super via direct access) can reach
  // it — and it is filtered out of everyone else's sidebar.
  owner?: string;
}

export interface DocRow extends Entity {
  path: string;
  spaceKey: string;
  title: string;
  headings: string[];
  body: string;
  blobSha: string;
  updatedAt: number;
  // Metadata (best-in-class doc fields; from front-matter when present).
  source?: string; // human-readable provenance, e.g. "example repo · example/docs/architecture.md"
  sourceType?: string; // cover-repo | email | clickup | authored
  status?: string; // imported | draft | published | archived
  owner?: string;
  tags?: string[];
  summary?: string; // one-line synopsis (AI-categorized on import, or front-matter)
  // Ephemeral guest docs (lib/guest): a doc created by a `guest` expires 8h after
  // creation. `expiresAt` is the numeric (Date.now()) mirror that drives the
  // in-memory lazy sweep (the source of truth for the local store); `expiresAtDate`
  // is the BSON Date that backs the Mongo TTL index (Atlas reaps it server-side).
  // Both are ABSENT on non-guest docs, which never expire.
  expiresAt?: number;
  expiresAtDate?: Date;
}

export interface ChunkRow extends Entity {
  path: string; // owning doc
  spaceKey: string;
  headingPath: string;
  charStart: number;
  charEnd: number;
  text: string;
  vector: number[]; // embedding (permission-filtered at query time by spaceKey/path)
}

export interface CommentRow extends Entity {
  id: string; // stable app-level id (distinct from the adapter's _id)
  path: string; // owning doc path
  spaceKey: string;
  authorEmail: string;
  body: string;
  mentions: string[]; // @handles parsed from the body
  resolved: boolean;
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface SuggestionRow extends Entity {
  id: string; // stable app-level id (distinct from the adapter's _id)
  path: string; // owning doc path
  spaceKey: string;
  authorEmail: string; // who proposed the edit
  proposedContent: string; // the full proposed markdown source
  baseSha: string; // blob sha the proposal was based on (drift detection)
  note: string; // "what are you proposing?"
  status: "open" | "accepted" | "rejected";
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface AuditRow extends Entity {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  at: number;
}

export interface SettingRow extends Entity {
  key: string; // singleton key, e.g. "routing"
  value: Record<string, unknown>;
  updatedAt: number;
}

export interface FavoriteRow extends Entity {
  email: string; // owner
  path: string; // favorited doc
  createdAt: number;
}

export interface NotificationRow extends Entity {
  id: string; // stable app-level id (distinct from the adapter's _id)
  email: string; // recipient
  kind: "mention" | "suggestion_accepted" | "suggestion_rejected";
  message: string; // human-readable, safe to show the recipient
  path: string; // doc path the notification links to
  actorEmail?: string; // who caused it (mentioner / resolver)
  read: boolean;
  createdAt: number;
}

// Durable file store (MongoGitStore) — doc content lives here on deployments
// without a writable git working tree (e.g. Render's read-only FS); the `docs`
// index projects from it.
export interface FileRow extends Entity {
  path: string;
  content: string;
  sha: string; // git blob sha (optimistic-concurrency token)
  version: number; // increments on every write
  updatedAt: number;
}

// Append-only version history — one snapshot per write/remove, enabling rollback
// and diff-to-current.
export interface VersionRow extends Entity {
  path: string;
  content: string; // full snapshot ("" for a removal)
  sha: string;
  version: number;
  author: string;
  message: string;
  at: number;
  removed?: boolean;
}

/** Bind all repositories to a database handle. */
export function repos(db: Database) {
  return {
    users: db.collection<UserRow>("users"),
    grants: db.collection<GrantRow>("grants"),
    groups: db.collection<GroupRow>("groups"),
    members: db.collection<GroupMemberRow>("groupMembers"),
    spaces: db.collection<SpaceRow>("spaces"),
    docs: db.collection<DocRow>("docs"),
    chunks: db.collection<ChunkRow>("chunks"),
    comments: db.collection<CommentRow>("comments"),
    suggestions: db.collection<SuggestionRow>("suggestions"),
    audit: db.collection<AuditRow>("audit"),
    settings: db.collection<SettingRow>("settings"),
    favorites: db.collection<FavoriteRow>("favorites"),
    notifications: db.collection<NotificationRow>("notifications"),
    files: db.collection<FileRow>("files"),
    versions: db.collection<VersionRow>("versions"),
  };
}

export type Repos = ReturnType<typeof repos>;
