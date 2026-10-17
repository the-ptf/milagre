import type { LinearIssueContext } from "../../model";
import { LinearLogo } from "../ProviderLogo";

/** A Chat started from a Linear issue, shown as the issue instead of the prompt the agent read. Clicking opens it in Linear. */
export function LinearIssueCard({ issue }: { issue: LinearIssueContext }) {
  return (
    <div data-slot="linear-issue" data-key={issue.key} className="flex w-full max-w-md flex-col gap-2">
      <a
        // A Routine Run's card has no link when the issue's URL wasn't Linear's own.
        href={issue.url || undefined}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open Linear issue ${issue.key}: ${issue.title}`}
        className="flex w-full flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] hover:border-line-strong"
      >
        <span className="flex items-center gap-1.5 text-[12px] tabular-nums text-ink-3">
          <LinearLogo size={12} />
          <span className="shrink-0 font-medium">{issue.key}</span>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: issue.state.color }} />
          <span className="min-w-0 truncate">{issue.state.name}</span>
        </span>
        <span className="line-clamp-2 font-medium text-ink">{issue.title}</span>
      </a>
      {issue.note && <p className="self-end whitespace-pre-wrap rounded-xl bg-field px-3 py-1.5 text-ink">{issue.note}</p>}
    </div>
  );
}
