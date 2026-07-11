import { SignedOut, SignInButton } from "@/app/clerk-shim";
import { Button } from "@/app/components/ui";
import { AppShell, type ShellSpace } from "@/app/components/app-shell";
import { currentPrincipal, getPersonalSpace, listReadableDocs } from "@/lib/server/data";
import { listFavorites } from "@/app/actions/favorites";

export const dynamic = "force-dynamic";

// Shell for the gated Grimoire workspace. middleware.ts protects /app when Clerk is
// configured. The sidebar tree is loaded server-side through the
// permission-filtered listReadableDocs — a signed-out principal gets an empty list,
// so no document names ever leak. Curated public spaces (defaultRole: "read") render
// for everyone signed in, including guests; a guest's personal section is labeled to
// flag that its docs expire in 8 hours.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [docs, favorites, personal, principal] = await Promise.all([
    listReadableDocs(),
    listFavorites(),
    getPersonalSpace(),
    currentPrincipal(),
  ]);
  const isGuest = principal?.role === "guest";

  // listReadableDocs already drops OTHER users' personal-space docs, so the only
  // personal-space docs here belong to the current principal — group them as
  // usual, then tag/surface the personal space below.
  const bySpace = new Map<string, ShellSpace>();
  for (const d of docs) {
    let space = bySpace.get(d.spaceKey);
    if (!space) {
      space = { key: d.spaceKey, docs: [] };
      bySpace.set(d.spaceKey, space);
    }
    space.docs.push({ path: d.path, title: d.title });
  }

  // Surface the caller's personal space even with zero docs (a doc-less space is
  // otherwise invisible, since the tree is built from the doc list). Tag it so
  // the shell renders it at the top with the "Personal" label + lock icon.
  if (personal) {
    // Guests' personal docs are ephemeral (8h TTL) — label the section so that's
    // obvious. Everyone else gets the plain "Personal" label.
    const label = isGuest ? "My notes (expire in 8h)" : "Personal";
    const existing = bySpace.get(personal.key);
    if (existing) {
      existing.personal = true;
      existing.label = label;
    } else {
      bySpace.set(personal.key, { key: personal.key, docs: [], personal: true, label });
    }
  }

  const spaces = [...bySpace.values()].sort((a, b) => {
    // Personal space(s) first, then shared spaces alphabetically.
    if (a.personal && !b.personal) return -1;
    if (!a.personal && b.personal) return 1;
    return a.key.localeCompare(b.key);
  });

  return (
    <AppShell spaces={spaces} favorites={favorites.map((f) => ({ path: f.path, title: f.title }))}>
      <SignedOut>
        <div className="glass mb-6 flex flex-wrap items-center gap-3 p-4 text-sm">
          <span className="text-[--color-muted]">
            You&rsquo;re signed out. Sign in to browse Grimoire&rsquo;s docs.
          </span>
          <span className="ml-auto">
            <SignInButton>
              <Button variant="primary">Sign in</Button>
            </SignInButton>
          </span>
        </div>
      </SignedOut>
      {children}
    </AppShell>
  );
}
