import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Activity/audit list (perf-plan §Area 3 · P1).
export default function Loading() {
  return <ListPageSkeleton title="Activity" rows={8} />;
}
