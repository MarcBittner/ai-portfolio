import { Badge, Card } from "@/app/components/ui";
import { AdminPanel } from "@/app/components/admin-panel";
import { RoutingPanel } from "@/app/components/routing-panel";
import { getAdminData } from "@/app/actions/admin";
import { routingStatus } from "@/app/actions/ai";
import { getRoutingConfig } from "@/app/actions/routing";

export const dynamic = "force-dynamic";

// Configuration / admin. Gated to Admin/Super (the action returns an error
// otherwise). Users & roles + permission grants are live; the remaining panes
// (Auth, Repository & sync, Spaces, Appearance) are Phase 7 follow-ups.
const PLANNED = [
  "Auth (domain allowlist, default role, break-glass)",
  "Repository & sync (docs + assets repos — engineering only)",
  "Spaces · Appearance · Search/indexing",
];

export default async function SettingsPage() {
  const [data, routing, routingCfg] = await Promise.all([
    getAdminData(),
    routingStatus(),
    getRoutingConfig(),
  ]);
  const isAdmin = !("error" in data);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <Badge tone="accent">Admin</Badge>
      </div>

      {"error" in data ? (
        <Card>
          <p className="text-sm text-[--color-muted]">{data.error}</p>
        </Card>
      ) : (
        <AdminPanel data={data} />
      )}

      {!("error" in routing) && (
        <RoutingPanel
          cloud={routing.cloud}
          embeddings={routing.embeddings}
          config={routingCfg}
          editable={isAdmin}
        />
      )}

      <div className="mt-8">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[--color-muted]">
          Planned panes (Phase 7)
        </h2>
        <ul className="space-y-1 text-sm text-[--color-muted]">
          {PLANNED.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
