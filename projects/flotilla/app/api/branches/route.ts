import { withOperator, ok, safeRead } from "@/lib/api";
import { listBranches, githubConfigured } from "@/lib/clients/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/branches — the managed repo's git branches (GitHub API), for the UI's
// "which branch to deploy" picker. Degrades to an empty list + a reason when no
// GITHUB_TOKEN is configured or GitHub is unreachable, so the page never crashes.
export async function GET(req: Request) {
  const repo = new URL(req.url).searchParams.get("repo") ?? undefined;
  return withOperator(() =>
    safeRead("branches unavailable", { branches: [], githubConfigured: githubConfigured() }, async () =>
      ok({ branches: await listBranches(repo), githubConfigured: githubConfigured() }),
    ),
  );
}
