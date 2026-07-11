import { Card } from "@/app/components/ui";
import { HealthDashboard } from "@/app/components/health-dashboard";
import { getContentHealth } from "@/app/actions/health";

export const dynamic = "force-dynamic";

// Content health — governance view over the docs you can read: stale, orphaned,
// and stub docs surfaced for cleanup. Permission-scoped (no leaks).
export default async function HealthPage() {
  const report = await getContentHealth();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">Content health</h1>
      </div>
      <p className="mb-6 text-sm text-[--color-muted]">
        Docs that may need attention — stale, orphaned, or too short.
      </p>
      {"error" in report ? (
        <Card>
          <p className="text-sm text-[--color-muted]">{report.error}</p>
        </Card>
      ) : (
        <HealthDashboard report={report} />
      )}
    </div>
  );
}
