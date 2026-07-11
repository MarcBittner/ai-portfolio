"use server";

import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

export interface FavoriteDoc {
  path: string;
  title: string;
  spaceKey: string;
}

/** Toggle a doc as a favorite for the current user. Returns the new state. */
export async function toggleFavorite(path: string): Promise<{ favorite: boolean }> {
  const principal = await currentPrincipal();
  if (!principal) return { favorite: false };
  const r = repos(await db());
  const existing = await r.favorites.findOne({ email: principal.email, path });
  if (existing) {
    await r.favorites.delete({ email: principal.email, path });
    return { favorite: false };
  }
  await r.favorites.insert({ email: principal.email, path, createdAt: Date.now() });
  return { favorite: true };
}

/** Is this doc favorited by the current user? */
export async function isFavorite(path: string): Promise<boolean> {
  const principal = await currentPrincipal();
  if (!principal) return false;
  const row = await repos(await db()).favorites.findOne({ email: principal.email, path });
  return !!row;
}

/** The current user's favorites, intersected with docs they can still read (so a
 *  favorite never surfaces a doc that's been trashed or access-revoked). */
export async function listFavorites(): Promise<FavoriteDoc[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const favs = await repos(await db()).favorites.find({ email: principal.email });
  if (favs.length === 0) return [];
  const wanted = new Set(favs.map((f) => f.path));
  return (await listReadableDocs())
    .filter((d) => wanted.has(d.path))
    .map((d) => ({ path: d.path, title: d.title, spaceKey: d.spaceKey }));
}
