import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// Live multi-cursor collaboration seam (architecture.md §3b). The app stays
// stateless: a Yjs doc is the live shared working copy, synced to the dedicated
// y-websocket service (services/collab). One room per doc.
//
// SECURITY: the WS endpoint + token are NOT read from a NEXT_PUBLIC env var
// (which would ship the secret to every client, including signed-out visitors).
// Instead the app mints a short-lived, per-doc signed ticket server-side — only
// for principals authorized to `edit` that doc (see app/actions/collab.ts). This
// module just consumes that ticket. Collaboration is OFF unless a ticket is
// supplied, so callers branch cleanly.

export type CollabUser = { name: string; color: string };

export type CollabTicket = {
  wsUrl: string; // e.g. wss://your-collab-host.example.com
  room: string; // one room per doc (slash-free, e.g. "doc:eng:architecture")
  token: string; // HMAC ticket bound to this room, validated by the WS server
};

export type Collab = {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
};

const PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

// Stable per-name presence colour (deterministic so a user keeps one caret hue).
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// Create the Yjs doc + websocket provider for a room, wiring awareness (the local
// user's name + colour) for presence. The room's signed token rides as a query
// param the WS server validates. Returns null on the server (SSR) so this only
// ever runs client-side.
export function createCollab(ticket: CollabTicket, user: CollabUser): Collab | null {
  if (typeof window === "undefined") return null;
  if (!ticket.wsUrl || !ticket.room) return null;

  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(ticket.wsUrl, ticket.room, ydoc, {
    params: { token: ticket.token },
  });
  provider.awareness.setLocalStateField("user", {
    name: user.name,
    color: user.color,
  });

  return { ydoc, provider };
}
