import Link from "next/link";
import { Activity } from "lucide-react";

import { getActivity, type ActivityItem } from "@/app/actions/activity";
import { Badge, Card } from "@/app/components/ui";

export const dynamic = "force-dynamic";

// Human-readable label for an audit action.
function actionLabel(action: string): string {
  switch (action) {
    case "doc.create":
      return "created";
    case "doc.update":
      return "updated";
    case "doc.delete":
      return "deleted";
    case "role.set":
      return "changed a role";
    case "grant.add":
      return "granted access";
    case "grant.remove":
      return "revoked access";
    default:
      return action;
  }
}

// Relative timestamp, e.g. "3m ago" / "2d ago".
function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const isDoc = item.targetType === "doc";
  const actor = item.actorEmail.split("@")[0];
  return (
    <li className="flex items-baseline gap-2 py-2.5 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-medium text-[--color-ink]">{actor}</span>{" "}
        <span className="text-[--color-muted]">{actionLabel(item.action)}</span>{" "}
        {isDoc ? (
          <Link
            href={`/app/doc/${item.targetId}`}
            className="text-[--color-accent] hover:underline"
          >
            {item.title ?? item.targetId}
          </Link>
        ) : (
          <span className="text-[--color-ink]">{item.targetId}</span>
        )}
      </span>
      {!isDoc && (
        <Badge tone="muted" className="shrink-0">
          {item.targetType}
        </Badge>
      )}
      <span className="shrink-0 whitespace-nowrap text-xs text-[--color-muted]">
        {relativeTime(item.at)}
      </span>
    </li>
  );
}

export default async function ActivityPage() {
  const items = await getActivity();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <Activity size={20} className="text-[--color-accent]" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      </div>

      <Card>
        {items.length === 0 ? (
          <p className="text-sm text-[--color-muted]">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {items.map((item, i) => (
              <ActivityRow key={`${item.at}-${item.targetId}-${i}`} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
