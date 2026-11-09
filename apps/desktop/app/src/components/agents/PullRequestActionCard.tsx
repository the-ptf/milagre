import { GitPullRequestIcon } from "@hugeicons/core-free-icons";
import type { PullRequestActionContext } from "../../model";
import { BLOCKERS } from "../../lib/pr-blockers";
import { Icon } from "../primitives/Icon";

/** A PR-blocker pill the user clicked, shown as what it asked for instead of the skill prompt the agent read. */
export function PullRequestActionCard({ action }: { action: PullRequestActionContext }) {
  const blocker = BLOCKERS[action.action];
  return (
    <div
      data-slot="pr-action"
      data-action={action.action}
      className="flex w-full max-w-md items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 text-13"
    >
      <Icon icon={GitPullRequestIcon} size={16} className={`shrink-0 ${blocker.tone === "orange" ? "text-orange-ink" : "text-red-ink"}`} />
      <span className="min-w-0 flex-1 truncate font-medium">{blocker.action}</span>
      <a href={action.url} target="_blank" rel="noreferrer" className="shrink-0 text-12 text-ink-3 transition-colors hover:text-ink">
        Pull request #{action.pr}
      </a>
    </div>
  );
}
