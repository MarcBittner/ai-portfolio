// Bridge to Workstream A. Prefer A's real engine when its modules exist
// (lib/provision.ts, lib/clients/convex.ts, lib/clients/clerk.ts); fall back to
// the typed stubs in _contract.ts otherwise. We must NOT touch A's files — only
// consume them — so these loaders use computed dynamic-import specifiers: a
// template-literal specifier is not statically resolved by tsc, so the build
// stays green whether or not A has landed its files yet.
import {
  provision as stubProvision,
  stubConvexClient,
  stubClerkUserClient,
  stubClerkConfigClient,
  type ProvisionOpts,
  type ProvisionResult,
  type ConvexBackupClient,
  type ClerkUserClient,
  type ClerkConfigClient,
} from "./_contract";

type Loaded<T> = { impl: T; source: "real" | "stub" };

async function tryImport(name: string): Promise<Record<string, unknown> | null> {
  try {
    // Computed specifier — deliberately not a string literal (see header).
    return (await import(`./${name}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function loadProvision(): Promise<
  Loaded<(opts: ProvisionOpts) => Promise<ProvisionResult>>
> {
  const mod = await tryImport("provision");
  const real = mod?.provision as ((opts: ProvisionOpts) => Promise<ProvisionResult>) | undefined;
  if (typeof real === "function") return { impl: real, source: "real" };
  return { impl: stubProvision, source: "stub" };
}

export async function loadConvexClient(): Promise<Loaded<ConvexBackupClient>> {
  const mod = await tryImport("clients/convex");
  const real = (mod?.convexClient ?? mod?.default) as ConvexBackupClient | undefined;
  if (real && typeof real.listBackups === "function") return { impl: real, source: "real" };
  return { impl: stubConvexClient, source: "stub" };
}

export async function loadClerkUserClient(): Promise<Loaded<ClerkUserClient>> {
  const mod = await tryImport("clients/clerk");
  const real = (mod?.clerkUserClient ?? mod?.userClient) as ClerkUserClient | undefined;
  if (real && typeof real.listUsers === "function") return { impl: real, source: "real" };
  return { impl: stubClerkUserClient, source: "stub" };
}

export async function loadClerkConfigClient(): Promise<Loaded<ClerkConfigClient>> {
  const mod = await tryImport("clients/clerk");
  const real = (mod?.clerkConfigClient ?? mod?.configClient) as ClerkConfigClient | undefined;
  if (real && typeof real.readConfig === "function") return { impl: real, source: "real" };
  return { impl: stubClerkConfigClient, source: "stub" };
}
