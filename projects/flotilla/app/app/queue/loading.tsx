import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Queue/worker-health list (perf-plan §Area 3 · P1).
export default function Loading() {
  return <ListPageSkeleton title="Queue & worker health" />;
}
