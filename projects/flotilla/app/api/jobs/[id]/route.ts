import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getJob, queryLogs } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/jobs/:id — job status + its consolidated logs (B-4). Polled by the
// live job log; the streaming variant lives at /api/jobs/:id/stream.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0") || undefined;
  return withOperator(() =>
    safeRead("job unavailable", { job: null, logs: [] }, async () => {
      const job = await getJob(id);
      if (!job) return bad("not found", 404);
      const logs = await queryLogs({ jobId: id, since });
      return ok({ job, logs });
    }),
  );
}
