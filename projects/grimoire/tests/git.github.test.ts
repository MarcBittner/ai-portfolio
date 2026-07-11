import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

import { GitHubGitStore } from "../lib/git/github";
import { ConflictError } from "../lib/git/types";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** A plain object shaped like the slice of Octokit the store touches — no network. */
function fakeOctokit(overrides: {
  getTree?: ReturnType<typeof vi.fn>;
  getContent?: ReturnType<typeof vi.fn>;
  createOrUpdateFileContents?: ReturnType<typeof vi.fn>;
  deleteFile?: ReturnType<typeof vi.fn>;
} = {}) {
  const fns = {
    getTree: overrides.getTree ?? vi.fn(),
    getContent: overrides.getContent ?? vi.fn(),
    createOrUpdateFileContents: overrides.createOrUpdateFileContents ?? vi.fn(),
    deleteFile: overrides.deleteFile ?? vi.fn(),
  };
  const octokit = {
    rest: {
      git: { getTree: fns.getTree },
      repos: {
        getContent: fns.getContent,
        createOrUpdateFileContents: fns.createOrUpdateFileContents,
        deleteFile: fns.deleteFile,
      },
    },
  } as unknown as Octokit;
  return { octokit, fns };
}

function makeStore(
  octokit: Octokit,
  opts: Partial<{ owner: string; repo: string; branch: string; contentRoot: string }> = {},
) {
  return new GitHubGitStore({
    octokit,
    owner: opts.owner ?? "acme",
    repo: opts.repo ?? "docs",
    branch: opts.branch ?? "main",
    contentRoot: opts.contentRoot ?? "eng",
  });
}

describe("GitHubGitStore.listMarkdown", () => {
  it("keeps only .md/.mdx blobs under contentRoot, sorted", async () => {
    const getTree = vi.fn().mockResolvedValue({
      data: {
        tree: [
          { path: "eng/runbooks/oncall.md", type: "blob" },
          { path: "eng/adr/0001.mdx", type: "blob" },
          { path: "eng/img/logo.png", type: "blob" }, // not markdown
          { path: "eng/sub", type: "tree" }, // a dir, not a blob
          { path: "marketing/post.md", type: "blob" }, // outside contentRoot
        ],
      },
    });
    const { octokit } = fakeOctokit({ getTree });
    const store = makeStore(octokit);

    expect(await store.listMarkdown()).toEqual(["eng/adr/0001.mdx", "eng/runbooks/oncall.md"]);
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "docs", tree_sha: "main", recursive: "1" }),
    );
  });
});

describe("GitHubGitStore.read", () => {
  it("decodes base64 content and returns the blob sha", async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: { type: "file", encoding: "base64", content: b64("# Hi\n"), sha: "blobsha123" },
    });
    const { octokit } = fakeOctokit({ getContent });
    const store = makeStore(octokit);

    const file = await store.read("eng/adr/0001.md");
    expect(file).toEqual({ path: "eng/adr/0001.md", content: "# Hi\n", sha: "blobsha123" });
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "docs", path: "eng/adr/0001.md", ref: "main" }),
    );
  });

  it("returns null on 404", async () => {
    const getContent = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const { octokit } = fakeOctokit({ getContent });
    const store = makeStore(octokit);

    expect(await store.read("eng/missing.md")).toBeNull();
  });
});

describe("GitHubGitStore.write", () => {
  it("sends base64 content, author, branch, and baseSha; returns the new blob sha", async () => {
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({ data: { content: { sha: "newsha" } } });
    const { octokit } = fakeOctokit({ createOrUpdateFileContents });
    const store = makeStore(octokit);

    const res = await store.write("eng/adr/0002.md", "# ADR 2\n", {
      message: "add adr 2",
      authorName: "Marc",
      authorEmail: "marc@example.com",
      baseSha: "oldsha",
    });

    expect(res).toEqual({ sha: "newsha" });
    expect(createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      path: "eng/adr/0002.md",
      branch: "main",
      message: "add adr 2",
      content: b64("# ADR 2\n"),
      committer: { name: "Marc", email: "marc@example.com" },
      author: { name: "Marc", email: "marc@example.com" },
      sha: "oldsha",
    });
  });

  it("omits sha when creating a new file (no baseSha)", async () => {
    const createOrUpdateFileContents = vi.fn().mockResolvedValue({ data: { content: { sha: "freshsha" } } });
    const { octokit } = fakeOctokit({ createOrUpdateFileContents });
    const store = makeStore(octokit);

    await store.write("eng/new.md", "x", { message: "m", authorName: "A", authorEmail: "a@example.com" });
    expect(createOrUpdateFileContents.mock.calls[0][0]).not.toHaveProperty("sha");
  });

  it("rejects a stale write with ConflictError", async () => {
    const createOrUpdateFileContents = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Conflict"), { status: 409 }));
    // The conflict handler re-reads to learn the actual current sha.
    const getContent = vi.fn().mockResolvedValue({
      data: { type: "file", encoding: "base64", content: b64("current"), sha: "actualsha" },
    });
    const { octokit } = fakeOctokit({ createOrUpdateFileContents, getContent });
    const store = makeStore(octokit);

    const err = await store
      .write("eng/adr/0001.md", "mine", {
        message: "m",
        authorName: "B",
        authorEmail: "b@example.com",
        baseSha: "stale",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ path: "eng/adr/0001.md", expected: "stale", actual: "actualsha" });
  });
});

describe("GitHubGitStore.remove", () => {
  it("fetches the current sha then deletes with author + branch", async () => {
    const getContent = vi.fn().mockResolvedValue({
      data: { type: "file", encoding: "base64", content: b64("bye"), sha: "delsha" },
    });
    const deleteFile = vi.fn().mockResolvedValue({ data: {} });
    const { octokit } = fakeOctokit({ getContent, deleteFile });
    const store = makeStore(octokit);

    await store.remove("eng/old.md", { message: "remove", authorName: "M", authorEmail: "m@example.com" });

    expect(getContent).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      path: "eng/old.md",
      message: "remove",
      sha: "delsha",
      branch: "main",
      committer: { name: "M", email: "m@example.com" },
      author: { name: "M", email: "m@example.com" },
    });
  });
});
