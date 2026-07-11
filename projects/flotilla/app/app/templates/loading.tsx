import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Templates list (perf-plan §Area 3 · P1).
export default function Loading() {
  return <ListPageSkeleton title="Templates" rows={6} />;
}
