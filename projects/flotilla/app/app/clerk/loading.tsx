import { ListPageSkeleton } from "../../components/skeleton";

// Route-segment loading skeleton for the Clerk drift/config surface (perf-plan
// §Area 3 · P1). Shown while the RSC first-fetch resolves, instead of a blank paint.
export default function Loading() {
  return <ListPageSkeleton title="Clerk" />;
}
