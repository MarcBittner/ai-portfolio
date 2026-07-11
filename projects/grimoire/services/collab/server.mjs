// grimoire collab WS server — Yjs real-time sync for live multi-cursor editing,
// persisted to MongoDB (same Atlas cluster, separate `yjs` collection). Runs as a
// DEDICATED service (its own Render service / container) behind COLLAB_WS_URL, so
// the main Next.js app stays stateless and Vercel-portable. One Yjs "room" per doc
// path; the app binds TipTap to the room via y-prosemirror (see README).
//
// Env: MONGODB_URI (required), PORT (default 1234), COLLAB_TOKEN (optional shared
// secret; when set, clients must connect with ?token=... — the app mints it).

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { setupWSConnection, setPersistence } from "y-websocket/bin/utils";
import { MongodbPersistence } from "y-mongodb-provider";

const PORT = Number(process.env.PORT ?? 1234);
const MONGODB_URI = process.env.MONGODB_URI;
const TOKEN = process.env.COLLAB_TOKEN; // optional

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}

// Persist each room's Yjs state to Mongo so edits survive restarts / cold starts.
const mdb = new MongodbPersistence(MONGODB_URI, { collectionName: "yjs", flushSize: 200 });
setPersistence({
  bindState: async (docName, ydoc) => {
    const persisted = await mdb.getYDoc(docName);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted));
    ydoc.on("update", (update) => {
      mdb.storeUpdate(docName, update).catch((e) => console.error("storeUpdate", e));
    });
  },
  writeState: async () => {
    /* updates are streamed in bindState; nothing extra on disconnect */
  },
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => setupWSConnection(ws, req));

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/healthz")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

// Validate a per-room HMAC ticket minted by the app (app/actions/collab.ts). The
// ticket is `${exp}.${hmac(secret, room + "." + exp)}` and is bound to THIS room,
// so a client can only open the socket for a doc the app authorized it to edit.
// Per-user authorization is decided in the app; this is the enforcement point.
function validTicket(room, token, secret) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${room}.${exp}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// FAIL CLOSED: without a shared secret the server can't authenticate room
// tickets, so it must NOT accept connections (that would let anyone who knows the
// URL join any Yjs room and read/write proprietary content). Only an explicit
// dev opt-in disables auth.
const ALLOW_ANON = process.env.COLLAB_ALLOW_ANON === "1";
if (!TOKEN && !ALLOW_ANON) {
  console.error(
    "COLLAB_TOKEN is not set — refusing all connections (fail-closed). Set COLLAB_TOKEN, or COLLAB_ALLOW_ANON=1 for local dev.",
  );
}

server.on("upgrade", (req, socket, head) => {
  // Require a valid per-room ticket. `room` is the first path segment — the same
  // docName y-websocket uses. When no secret is configured, reject everything
  // (unless the explicit dev opt-in is set) rather than silently allowing all.
  const reject = () => {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  };
  if (!TOKEN) {
    if (!ALLOW_ANON) return reject();
  } else {
    const url = new URL(req.url ?? "/", "http://localhost");
    const room = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    if (!validTicket(room, url.searchParams.get("token"), TOKEN)) return reject();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => console.log(`collab WS on :${PORT}`));
