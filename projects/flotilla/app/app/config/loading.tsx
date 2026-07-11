import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Configuration surface (perf-plan §Area 3 · P1).
// Shows a content-shaped placeholder while the RSC first-fetch of GET /api/config
// resolves, instead of the blank-then-everything flash.
export default function Loading() {
  return <ListPageSkeleton title="Configuration" />;
}
