// lib/clients/snapshotStore.ts — blob store for Convex snapshot ZIPs backed by
// GitHub Releases (release assets), replacing the old GridFS bucket.
//
// Why: snapshots are 60–180 MB each and were filling the shared 512 MB Atlas
// cluster (GridFS bucket `flotilla_backup_files`), which caused an outage. GitHub
// Releases give us free, out-of-Mongo blob storage (2 GB/asset) reachable over
// plain HTTP from the deployed app + the worker.
//
// Storage model: ONE shared release (tag `blobs`, created lazily) in a private
// repo named by SNAPSHOT_REPO (`owner/name`; required — no default). Each snapshot
// is an asset whose `name` is a unique key like `{deployment}_{snapshotId}.zip`.
// The asset id (a number) is the durable handle we persist as `blobRef` on the
// backup doc.
//
// Auth: GITHUB_TOKEN (classic token with `repo` scope) — same token the branch
// picker uses. Missing token OR SNAPSHOT_REPO → snapshotStoreConfigured() is false
// and callers degrade.
//
// REST surface (all verified end-to-end create→upload→download→delete):
//   GET    {API}/repos/{repo}/releases/tags/{tag}                 -> release {id, assets[]}
//   POST   {API}/repos/{repo}/releases  {tag_name, name}          -> {id}
//   POST   {UPLOADS}/repos/{repo}/releases/{id}/assets?name={key} -> {id, size, browser_download_url}
//   GET    {API}/repos/{repo}/releases/assets/{assetId}  (Accept: octet-stream, follows CDN redirect) -> bytes
//   DELETE {API}/repos/{repo}/releases/assets/{assetId}           -> 204

import { Readable } from "node:stream";

const API = process.env.GITHUB_API || "https://api.github.com";
const UPLOADS = process.env.GITHUB_UPLOADS_API || "https://uploads.github.com";
const REPO = process.env.SNAPSHOT_REPO || "";
// Single shared release that holds every snapshot asset.
const RELEASE_TAG = process.env.SNAPSHOT_RELEASE_TAG || "blobs";

export type PutSnapshotResult = { assetId: number; sizeBytes: number; downloadUrl: string };

export function snapshotStoreConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN) && /^[\w.-]+\/[\w.-]+$/.test(REPO);
}

function requireToken(): string {
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) throw new Error("GITHUB_TOKEN not configured — snapshot store unavailable");
  return tok;
}

// Validate `owner/name` — an unvalidated repo could traverse to a different
// authenticated api.github.com endpoint (same guard as clients/github.ts).
function repoPath(): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
    throw new Error(`invalid SNAPSHOT_REPO "${REPO}" — expected owner/name`);
  }
  return REPO;
}

function jsonHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "flotilla",
  };
}

type ReleaseAsset = { id: number; name: string; size: number; browser_download_url: string };
type Release = { id: number; assets?: ReleaseAsset[] };

/** Fetch the shared release by tag (with its asset list), creating it if absent. */
async function ensureRelease(): Promise<Release> {
  const repo = repoPath();
  const getRes = await fetch(`${API}/repos/${repo}/releases/tags/${RELEASE_TAG}`, {
    headers: jsonHeaders(),
  });
  if (getRes.ok) {
    return (await getRes.json()) as Release;
  }
  if (getRes.status !== 404) {
    throw new Error(`get release ${RELEASE_TAG} -> ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`);
  }
  // Not there yet — create it. A concurrent creator can win the race (422
  // already_exists); re-read by tag in that case.
  const createRes = await fetch(`${API}/repos/${repo}/releases`, {
    method: "POST",
    headers: { ...jsonHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: RELEASE_TAG, name: "flotilla snapshot blobs" }),
  });
  if (createRes.ok) {
    return (await createRes.json()) as Release;
  }
  if (createRes.status === 422) {
    const reRes = await fetch(`${API}/repos/${repo}/releases/tags/${RELEASE_TAG}`, { headers: jsonHeaders() });
    if (reRes.ok) return (await reRes.json()) as Release;
  }
  throw new Error(`create release ${RELEASE_TAG} -> ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
}

// Ceiling on a single buffered blob — guards against a zip-bomb / runaway upload
// exhausting process memory. GitHub caps a release asset at 2 GB; snapshots run
// 60–180 MB, so 2 GiB is a generous safety net. Override via MAX_SNAPSHOT_BYTES.
const MAX_SNAPSHOT_BYTES = Number(process.env.MAX_SNAPSHOT_BYTES || 2 * 1024 * 1024 * 1024);

/** Buffer a source so we can send an exact Content-Length. Blobs are ≤~180 MB,
 *  well within memory budget, and this sidesteps Node 20 fetch duplex/stream
 *  Content-Length quirks (see file-level note). Aborts past MAX_SNAPSHOT_BYTES. */
async function toBuffer(source: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    if (source.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error(`snapshot exceeds max size (${MAX_SNAPSHOT_BYTES} bytes)`);
    }
    return source;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.byteLength;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      source.destroy();
      throw new Error(`snapshot exceeds max size (${MAX_SNAPSHOT_BYTES} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Upload a snapshot blob to the shared release under `key`. If an asset with
 *  that name already exists it's deleted first (idempotent re-grab). */
export async function putSnapshot(
  key: string,
  source: Readable | Buffer,
  sizeBytes: number,
): Promise<PutSnapshotResult> {
  const repo = repoPath();
  const release = await ensureRelease();

  // Delete-then-reupload if the key already exists so a re-grab replaces cleanly.
  const existing = release.assets?.find((a) => a.name === key);
  if (existing) await deleteSnapshot(existing.id);

  const body = await toBuffer(source);
  // Trust the actual buffered length over the caller's `sizeBytes` estimate — the
  // header must match the body exactly or GitHub rejects the upload. sizeBytes is
  // only a fallback for the reported size when GitHub omits it on a 0-byte body.
  const length = body.byteLength;

  const uploadUrl = `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(key)}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "flotilla",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(length),
    },
    // Node's fetch accepts a Buffer body at runtime, but the ambient BodyInit
    // type doesn't list it — cast through unknown. Content-Length is set above.
    body: body as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`upload asset ${key} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const asset = (await res.json()) as ReleaseAsset;
  return { assetId: asset.id, sizeBytes: asset.size || length || sizeBytes, downloadUrl: asset.browser_download_url };
}

/** Open the asset body as a read stream (e.g. to spool to /tmp for import). */
export async function getSnapshot(assetId: number | string): Promise<Readable> {
  const repo = repoPath();
  const res = await fetch(`${API}/repos/${repo}/releases/assets/${assetId}`, {
    // octet-stream Accept makes the API 302 to the CDN; fetch follows it.
    headers: { ...jsonHeaders(), Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`download asset ${assetId} -> ${res.status}`);
  }
  return Readable.fromWeb(res.body as never);
}

export async function deleteSnapshot(assetId: number | string): Promise<void> {
  const repo = repoPath();
  const res = await fetch(`${API}/repos/${repo}/releases/assets/${assetId}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  });
  // 204 = deleted, 404 = already gone — both fine.
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete asset ${assetId} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
