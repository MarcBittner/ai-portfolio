import { NextResponse, type NextRequest } from "next/server";

import { bundleZip, docToMarkdown, toPlainText } from "@/lib/exporter";
import { getReadableDoc, listReadableDocs } from "@/lib/server/data";

// Export endpoint — streams docs back out as Markdown, plain text, or a zipped
// bundle. Permission-filtered: it only ever serves docs the current principal
// may READ (getReadableDoc / listReadableDocs enforce that). Dynamic so it
// reflects the live store + identity per request.
export const dynamic = "force-dynamic";

type Format = "md" | "txt" | "zip";

function isFormat(v: string | null): v is Format {
  return v === "md" || v === "txt" || v === "zip";
}

/** Build an attachment response with the right Content-Type + filename. */
function attachment(
  body: string | Uint8Array,
  contentType: string,
  filename: string,
): NextResponse {
  // Sanitize the filename before it goes into the header — never interpolate raw
  // query-derived text into Content-Disposition.
  const safe = filename.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "download";
  return new NextResponse(body as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safe}"`,
    },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const path = searchParams.get("path");
  const space = searchParams.get("space");
  const formatParam = searchParams.get("format");
  const format: Format = isFormat(formatParam) ? formatParam : "md";

  // ---- single doc: ?path=<docpath>&format=md|txt ----
  if (path) {
    const doc = await getReadableDoc(path);
    if (!doc) {
      return NextResponse.json({ error: "Not found or not readable." }, { status: 404 });
    }
    const { filename, body } = docToMarkdown({ path: doc.path, body: doc.body });
    if (format === "txt") {
      return attachment(toPlainText(body), "text/plain; charset=utf-8", `${filename}.txt`);
    }
    return attachment(body, "text/markdown; charset=utf-8", filename);
  }

  // ---- space bundle: ?space=<key>&format=md|txt|zip ----
  if (space) {
    const docs = (await listReadableDocs()).filter((d) => d.spaceKey === space);
    if (docs.length === 0) {
      return NextResponse.json({ error: "No readable docs in that space." }, { status: 404 });
    }
    const rows = (await Promise.all(docs.map((d) => getReadableDoc(d.path)))).filter(
      (d): d is NonNullable<typeof d> => d !== null,
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "No readable docs in that space." }, { status: 404 });
    }

    if (format === "zip") {
      const zip = await bundleZip(rows.map((d) => ({ path: d.path, body: d.body })));
      return attachment(zip, "application/zip", `${space}.zip`);
    }

    const sep = "\n\n---\n\n";
    if (format === "txt") {
      const text = rows.map((d) => toPlainText(d.body)).join(sep);
      return attachment(text, "text/plain; charset=utf-8", `${space}.txt`);
    }
    const md = rows.map((d) => d.body).join(sep);
    return attachment(md, "text/markdown; charset=utf-8", `${space}.md`);
  }

  return NextResponse.json({ error: "Provide ?path= or ?space=." }, { status: 404 });
}
