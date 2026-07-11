import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Access pane (perf-plan §Area 3 · P1).
// Shown while the RSC first-fetch resolves, instead of a blank first paint.
export default function Loading() {
  return <ListPageSkeleton title="Access" />;
}
