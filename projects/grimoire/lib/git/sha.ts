// Git blob SHA — the same content hash Git uses, so our optimistic-concurrency
// token matches what the real repo reports for a blob: sha1("blob <bytes>\0" + content).

import { createHash } from "node:crypto";

export function gitBlobSha(content: string): string {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${data.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, data])).digest("hex");
}
