import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Backups list (perf-plan §Area 3 · P1).
export default function Loading() {
  return <ListPageSkeleton title="Backups" rows={8} />;
}
