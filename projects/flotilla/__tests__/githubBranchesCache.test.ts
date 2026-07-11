import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Perf-plan Tier-A: lib/clients/github.listBranches makes a LIVE api.github.com
// round-trip on every call. It's now wrapped in a short per-repo TTL cache. These
// tests prove hit/miss/expiry against a mocked global fetch — no network — and that
// a failing fetch is NOT cached (degrades to a live call next time).

import { listBranches, __resetBranchesCache } from "@/lib/clients/github";

const REPO = "acme/widget";

// A single-page GitHub /branches response (< 100 rows → the paginator stops).
function branchesResponse(names: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => names.map((name) => ({ name, commit: { sha: `sha_${name}` }, protected: false })),
    text: async () => "",
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetBranchesCache();
  delete process.env.GITHUB_TOKEN;
  process.env.FLOTILLA_BRANCHES_TTL_MS = "60000";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.FLOTILLA_BRANCHES_TTL_MS;
});

describe("listBranches TTL cache", () => {
  it("MISS then HIT: second call within the TTL serves from cache (one fetch)", async () => {
    fetchMock.mockResolvedValue(branchesResponse(["main", "dev"]));

    const first = await listBranches(REPO);
    expect(first.map((b) => b.name)).toEqual(["main", "dev"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await listBranches(REPO);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second network hit
  });

  it("EXPIRY: after the TTL elapses the next call re-fetches", async () => {
    fetchMock.mockResolvedValue(branchesResponse(["main"]));
    await listBranches(REPO);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await listBranches(REPO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keyed by repo: a different repo is a separate cache entry", async () => {
    fetchMock.mockResolvedValue(branchesResponse(["main"]));
    await listBranches("acme/one");
    await listBranches("acme/two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Repeat both — both now warm, no further fetches.
    await listBranches("acme/one");
    await listBranches("acme/two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a failed read: a non-ok response throws and the next call retries", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => [],
      text: async () => "bad gateway",
    } as unknown as Response);
    await expect(listBranches(REPO)).rejects.toThrow(/502/);

    // The failure was not cached — a subsequent success populates fresh.
    fetchMock.mockResolvedValue(branchesResponse(["main"]));
    const ok = await listBranches(REPO);
    expect(ok.map((b) => b.name)).toEqual(["main"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
