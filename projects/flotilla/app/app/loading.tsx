import { ListPageSkeleton } from "../components/skeleton";

// Route-segment loading skeleton for the Instances list (perf-plan §Area 3 · P1).
export default function Loading() {
  return <ListPageSkeleton title="Instances" />;
}
