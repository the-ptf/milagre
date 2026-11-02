import type { GitHubIssueContext } from "@milagre/shared/github-issue";

export function GitHubIssueCard({ issue }: { issue: GitHubIssueContext }) {
  return (
    <div data-slot="github-issue" className="flex w-full max-w-md flex-col gap-2">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2 text-13 hover:border-line-strong"
      >
        <span className="text-12 text-ink-3">
          {issue.repository}#{issue.number}
        </span>
        <span className="font-medium text-ink">{issue.title}</span>
        <span className="text-12 text-ink-3">Imported {new Date(issue.importedAt).toLocaleString()}</span>
      </a>
      {issue.note && <p className="self-end whitespace-pre-wrap rounded-card bg-field px-3 py-1.5 text-ink">{issue.note}</p>}
    </div>
  );
}
