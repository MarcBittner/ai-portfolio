import { NextResponse } from "next/server";

// Standard health check honored by both Render and Vercel (portability decision).
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "grimoire",
    phase: 1,
  });
}
