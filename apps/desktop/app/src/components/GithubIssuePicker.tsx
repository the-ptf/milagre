import { useEffect, useState, type CSSProperties } from "react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import {
  GITHUB_ISSUE_PLACEHOLDER,
  GITHUB_ISSUE_TITLE,
  githubIssueKey,
  githubIssueState,
  githubIssuesFailure,
  type GithubIssue,
} from "@milagre/shared/github-issue";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { GithubLogo } from "./ProviderLogo";
import { IssueSkeleton } from "./LinearIssuePicker";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { IconButton } from "./primitives/Button";
import { SpinnerRing } from "./primitives/SpinnerRing";

type IssueList = { issues: GithubIssue[]; repo?: string; error?: string };

export function GithubIssuePicker({
  projectKey,
  onPick,
  onClose,
  className,
  style,
}: {
  projectKey: string;
  onPick: (issue: GithubIssue) => void;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<IssueList | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    const text = query.trim();
    const fresh = refreshes > 0;
    const timer = window.setTimeout(
      () => {
        const show = (next: IssueList) => {
          if (!live) return;
          setList(next);
          setRefreshing(false);
        };
        Promise.resolve()
          .then(() => bridgeForKey(projectKey).listGithubIssues(projectKey, text || undefined, { fresh }))
          .then(
            (result) => show(!result ? { issues: [], error: githubIssuesFailure("") } : "error" in result ? { issues: [], error: result.error } : result),
            (error: unknown) => show({ issues: [], error: githubIssuesFailure(ipcErrorMessage(error)) }),
          );
      },
      text ? 250 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [projectKey, query, refreshes]);

  const rows = list?.issues ?? [];
  return (
    <PickerPanel
      title={GITHUB_ISSUE_TITLE}
      titleAction={
        <IconButton
          label="Refresh issues"
          icon={RefreshIcon}
          size={24}
          side="bottom"
          data-github-issues-refresh
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            setRefreshes((count) => count + 1);
          }}
          className="-my-1"
        >
          {refreshing ? <SpinnerRing size={12} /> : undefined}
        </IconButton>
      }
      header={
        list?.repo && (
          <p data-github-repo className="shrink-0 truncate px-2 pb-1 text-12 text-ink-3">
            {list.repo}
          </p>
        )
      }
      query={query}
      onQueryChange={setQuery}
      placeholder={GITHUB_ISSUE_PLACEHOLDER}
      searchPlacement="bottom"
      emptyLabel={list?.error ?? "No open issues found."}
      isEmpty={list !== null && rows.length === 0}
      className={className}
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {list === null && <IssueSkeleton />}
      {rows.map((issue) => (
        <div key={githubIssueKey(issue)} data-github-issue-row>
          <PickerRow
            icon={<GithubLogo size={14} />}
            label={`${issue.repo === list?.repo ? `#${issue.number}` : githubIssueKey(issue)} ${issue.title}`}
            description={[githubIssueState(issue).name, ...(issue.labels ?? [])].join(" · ")}
            selected={false}
            wrapLabel
            onClick={() => onPick(issue)}
          />
        </div>
      ))}
    </PickerPanel>
  );
}
