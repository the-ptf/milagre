import type { IssueCardView } from "@milagre/shared/issue-start";
import { GithubLogo, LinearLogo } from "../ProviderLogo";

export function IssueCard({ issue }: { issue: IssueCardView }) {
  return (
    <div data-slot={`${issue.source}-issue`} data-key={issue.key} className="flex w-full max-w-md flex-col gap-2">
      <a
        href={issue.url || undefined}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${issue.label}: ${issue.title}`}
        className="flex w-full flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2 text-13 transition-colors duration-fast hover:border-line-strong"
      >
        <span className="flex items-center gap-1.5 text-12 tabular-nums text-ink-3">
          {issue.source === "github" ? <GithubLogo size={12} /> : <LinearLogo size={12} />}
          <span className="min-w-0 shrink truncate font-medium">{issue.key}</span>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: issue.state.color }} />
          <span className="min-w-0 shrink-0 truncate">{issue.state.name}</span>
        </span>
        <span className="line-clamp-2 font-medium text-ink">{issue.title}</span>
      </a>
      {issue.note && <p className="self-end whitespace-pre-wrap rounded-card bg-field px-3 py-1.5 text-ink">{issue.note}</p>}
    </div>
  );
}
