"use server";

import { createHmac } from "node:crypto";

import { authorize } from "@/lib/authz";
import { spaceKeyOf } from "@/lib/git/indexer";
import { currentPrincipal, db } from "@/lib/server/data";
import type { CollabTicket } from "@/lib/collab/provider";

// Live-collaboration ticketing. Live co-editing is enabled only when BOTH server
// env vars are set: COLLAB_WS_URL (the y-websocket service, e.g.
// wss://your-collab-host.example.com) and COLLAB_TOKEN (the shared secret the
// WS server validates against). Neither is NEXT_PUBLIC — the secret never reaches
// the client. A ticket is minted ONLY for a principal authorized to `edit` the
// specific doc, is bound to that doc's room by an HMAC, and expires — so a
// signed-out or unauthorized user can never open a socket for proprietary content.

const TTL_SECONDS = 8 * 60 * 60; // editing sessions can be long; re-minted on mount

/** Room id for a doc path: slash-free so it's a single WS path segment and the
 *  HMAC binding is unambiguous. Must match the WS server's docName derivation. */
function roomFor(path: string): string {
  return `doc:${path.replace(/\//g, ":")}`;
}

function sign(room: string, exp: number, secret: string): string {
  const mac = createHmac("sha256", secret).update(`${room}.${exp}`).digest("hex");
  return `${exp}.${mac}`;
}

/**
 * Mint a collaboration ticket for `path`, or return null when collaboration is
 * disabled / the principal may not edit the doc. The client passes the returned
 * ticket to the WYSIWYG, which opens the WS connection; the server re-validates
 * the HMAC on upgrade. Null = fall back to the plain local editor.
 */
export async function collabTicket(path: string): Promise<CollabTicket | null> {
  const wsUrl = process.env.COLLAB_WS_URL;
  const secret = process.env.COLLAB_TOKEN;
  if (!wsUrl || !secret) return null; // collaboration not configured

  const principal = await currentPrincipal();
  if (!principal) return null;

  const database = await db();
  const decision = await authorize(
    database,
    principal.email,
    { type: "doc", path, spaceKey: spaceKeyOf(path) },
    "edit",
  );
  if (!decision.allowed) return null;

  const room = roomFor(path);
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return { wsUrl, room, token: sign(room, exp, secret) };
}
