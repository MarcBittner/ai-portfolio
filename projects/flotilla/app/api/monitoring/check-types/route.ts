import { withOperator, ok, bad } from "@/lib/api";
import { getFeatureFlags } from "@/lib/models";
import { checkTypeCatalog } from "@/lib/monitoring/checks/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/check-types — the closed check-type registry catalog (ids +
// labels + which selector/target kinds each supports), for the future param-form +
// AI helper. read-only. The strict zod param schemas stay server-side (validated
// on create and before every run).
export async function GET() {
  return withOperator(async () => {
    if (!(await getFeatureFlags()).monitoring) return bad("monitoring feature is disabled", 403);
    return ok({ checkTypes: checkTypeCatalog() });
  });
}
