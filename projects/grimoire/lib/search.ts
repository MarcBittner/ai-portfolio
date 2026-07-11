// Search — keyword (full-text-ish) + semantic (embedding cosine over chunks), fused with
// Reciprocal Rank Fusion (RRF). Both signals are PERMISSION-FILTERED so a result never
// references a doc the user can't read. A doc strong in EITHER signal surfaces; a doc
// strong in BOTH ranks highest. Keyword is the always-available floor (it still dominates
// when embeddings are the crude local-hash fallback, since a lexical hit is a lexical
// embedding hit too).

import { canAccess, type Principal } from "./permissions";
import { embed } from "./rag/embeddings";
import { cosineSimilarity } from "./rag/retrieval";
import { repos, type Repos } from "./repos";
import type { Database } from "./db/types";
import { cachedGrants, cachedSpacePolicy } from "./server/policyCache";

export interface SearchResult {
  path: string;
  title: string;
  spaceKey: string;
  snippet: string;
  score: number;
  kind: "keyword" | "semantic" | "hybrid";
}

/** RRF constant — dampens the influence of any single list's absolute ranks so the two
 *  signals fuse on rank rather than incomparable score scales (Cormack et al., k≈60). */
const RRF_K = 60;

function snippet(body: string, q: string): string {
  const i = body.toLowerCase().indexOf(q);
  const start = i < 0 ? 0 : Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + body.slice(start, start + 180).replace(/\s+/g, " ").trim() + "…";
}

function chunkSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180) + "…";
}

/** Lexical relevance of a doc to `q` (already lowercased). 0 = no match. Title matches
 *  weigh more than body mentions, and repeated body mentions add up, so the keyword list
 *  has a meaningful internal ranking to feed RRF (not just a flat 1/0). */
function keywordScore(title: string, body: string, q: string): number {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  if (t.includes(q)) score += 2;
  let idx = b.indexOf(q);
  let hits = 0;
  while (idx !== -1 && hits < 50) {
    hits += 1;
    idx = b.indexOf(q, idx + Math.max(1, q.length));
  }
  score += hits;
  return score;
}

/**
 * Build the request's permission predicate: `read` on a doc for the acting principal.
 * This IS the security boundary — an unreadable doc/chunk is dropped BEFORE it can be
 * ranked or returned. Shared by keyword + semantic + Ask.
 *
 * Space policies come from the shared short-TTL policy cache (lib/server/
 * policyCache), which memoizes per-space and is reused across requests — so the
 * per-item `spaces.findOne` inside the per-chunk / per-doc loop is gone with no
 * per-request `spaces.find()` prefetch either. Grants are already cached and
 * passed in. Behavior is identical: an unknown spaceKey resolves to
 * `defaultRole: "none"`.
 */
function readableFilter(db: Database, principal: Principal, grants: Awaited<ReturnType<Repos["grants"]["find"]>>) {
  return async (path: string, spaceKey: string): Promise<boolean> => {
    const policy = await cachedSpacePolicy(db, spaceKey);
    return canAccess(principal, { type: "doc", path, spaceKey }, "read", grants, policy).allowed;
  };
}

export interface RetrievedChunk {
  path: string;
  title: string;
  spaceKey: string;
  headingPath: string;
  text: string;
  score: number;
}

/** Top-k chunks for a query, PERMISSION-FILTERED (the asker's readable scope is
 *  applied before ranking). Shared by semantic search and Ask-the-docs. */
export async function retrieveReadableChunks(
  db: Database,
  principal: Principal,
  query: string,
  k = 6,
): Promise<RetrievedChunk[]> {
  const r = repos(db);
  const [docs, grants, chunks] = await Promise.all([r.docs.find(), cachedGrants(db), r.chunks.find()]);
  if (chunks.length === 0 || !query.trim()) return [];
  const canRead = readableFilter(db, principal, grants);
  const titleOf = (p: string) => docs.find((d) => d.path === p)?.title ?? p;
  const [qv] = await embed([query]);

  const scored: RetrievedChunk[] = [];
  for (const c of chunks) {
    if (!(await canRead(c.path, c.spaceKey))) continue;
    scored.push({
      path: c.path,
      title: titleOf(c.path),
      spaceKey: c.spaceKey,
      headingPath: c.headingPath,
      text: c.text,
      score: cosineSimilarity(qv, c.vector),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

interface KeywordHit {
  path: string;
  title: string;
  spaceKey: string;
  snippet: string;
  score: number;
}

interface SemanticHit {
  path: string;
  spaceKey: string;
  text: string;
  score: number;
}

export async function searchReadable(
  db: Database,
  principal: Principal,
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const r = repos(db);
  const [docs, grants] = await Promise.all([r.docs.find(), cachedGrants(db)]);
  const canRead = readableFilter(db, principal, grants);
  const titleOf = (p: string) => docs.find((d) => d.path === p)?.title ?? p;

  // ---- Keyword signal: readable docs whose title/body matches, ranked by lexical score.
  const keywordHits: KeywordHit[] = [];
  for (const d of docs) {
    const score = keywordScore(d.title, d.body, q);
    if (score <= 0) continue;
    if (!(await canRead(d.path, d.spaceKey))) continue;
    keywordHits.push({
      path: d.path,
      title: d.title,
      spaceKey: d.spaceKey,
      snippet: snippet(d.body, q),
      score,
    });
  }
  keywordHits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  // ---- Semantic signal: best readable chunk cosine per doc, ranked by similarity.
  const chunks = await r.chunks.find();
  const bestChunk = new Map<string, SemanticHit>();
  if (chunks.length > 0) {
    const [qv] = await embed([query]);
    for (const c of chunks) {
      const score = cosineSimilarity(qv, c.vector);
      // A non-positive cosine carries no signal — and with the local-hash fallback it means
      // zero lexical overlap, so it must not manufacture a spurious "semantic" contribution.
      if (score <= 0) continue;
      if (!(await canRead(c.path, c.spaceKey))) continue;
      const prev = bestChunk.get(c.path);
      if (!prev || score > prev.score) {
        bestChunk.set(c.path, { path: c.path, spaceKey: c.spaceKey, text: c.text, score });
      }
    }
  }
  const semanticHits = [...bestChunk.values()].sort(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : 1),
  );

  // ---- Reciprocal Rank Fusion: score = Σ 1/(k + rank_i) over the lists a doc appears in.
  const keywordByPath = new Map(keywordHits.map((h) => [h.path, h]));
  const semanticByPath = new Map(semanticHits.map((h) => [h.path, h]));
  const keywordRank = new Map(keywordHits.map((h, i) => [h.path, i + 1]));
  const semanticRank = new Map(semanticHits.map((h, i) => [h.path, i + 1]));

  const fused: SearchResult[] = [];
  for (const path of new Set([...keywordByPath.keys(), ...semanticByPath.keys()])) {
    const kr = keywordRank.get(path);
    const sr = semanticRank.get(path);
    let score = 0;
    if (kr !== undefined) score += 1 / (RRF_K + kr);
    if (sr !== undefined) score += 1 / (RRF_K + sr);

    const kw = keywordByPath.get(path);
    const sem = semanticByPath.get(path);
    const kind: SearchResult["kind"] = kw && sem ? "hybrid" : kw ? "keyword" : "semantic";
    fused.push({
      path,
      title: kw?.title ?? titleOf(path),
      spaceKey: (kw ?? sem)!.spaceKey,
      // Prefer the keyword snippet (anchored on the query term) when there is one.
      snippet: kw ? kw.snippet : chunkSnippet(sem!.text),
      score,
      kind,
    });
  }
  fused.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return fused.slice(0, limit);
}
