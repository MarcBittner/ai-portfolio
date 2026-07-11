import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { sweepExpiredDocs } from "@/lib/reaper";

// Guest-doc reaper — deletes expired (8h) guest docs and their dependent rows from
// the in-memory / local store. Idempotent and safe to call unauthenticated from a
// cron (Render Cron / GitHub Action / Vercel Cron): it only ever removes rows that
// are already past their own stamped expiry — it exposes nothing and can't be used
// to reach any doc. On Mongo, Atlas also reaps `docs` via a TTL index; this route
// keeps the numeric-mirror sweep (dependent rows + immediacy) honest there too.
export const dynamic = "force-dynamic";

async function sweep() {
  const db = await getDatabase();
  const { swept, paths } = await sweepExpiredDocs(db);
  return NextResponse.json({ status: "ok", swept, paths });
}

// POST is the canonical trigger (mutating). GET mirrors it so a plain cron URL
// hit also works; both are idempotent.
export async function POST() {
  return sweep();
}

export async function GET() {
  return sweep();
}
