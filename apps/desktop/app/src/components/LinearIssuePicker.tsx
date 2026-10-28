import { preferenceStorage as localStorage } from "../lib/preference-storage.ts";
import { useEffect, useState, type CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import type { LinearIssue, LinearIssuesResult } from "@milagre/shared/linear";
import { LinearLogo } from "./ProviderLogo";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import Tooltip from "./primitives/Tooltip";

type IssueList = { issues: LinearIssue[]; error?: string };
type WorkspaceTab = { id: string; name: string };

// The tabs and the chosen one outlive the picker, so it opens on the same workspace at its full height.
const TABS_KEY = "milagre.linear.workspaces";
const CHOSEN_KEY = "milagre.linear.workspace";
function readTabs(): WorkspaceTab[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is WorkspaceTab => typeof item?.id === "string" && typeof item?.name === "string") : [];
  } catch {
    return [];
  }
}

/** Placeholder rows the size of issue rows, filling the list's max height, so the panel opens at its full size instead of growing into it. */
function IssueSkeleton() {
  return (
    <div role="status" data-linear-issue-skeleton className="h-64 overflow-hidden">
      <span className="sr-only">Loading issues</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-2 px-2 py-1.5 motion-safe:animate-pulse">
          <span className="size-[13px] shrink-0 rounded-full bg-ink/10" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="my-1 h-3 w-11/12 rounded bg-ink/10" />
            <span className="my-1 h-3 w-1/2 rounded bg-ink/10" />
            <span className="h-2.5 w-20 rounded bg-ink/5" />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The "Start from a Linear issue" list: a search over the workspace's issues. Shared by the new-chat header and the
 * sidebar row's "Link issue…" menu item. A typed query waits 250 ms, and a stale answer is dropped. The Mac keeps the
 * assigned list for a minute, so reopening is instant; the refresh button reads it from Linear again. With several
 * workspaces connected, a tab per workspace picks which one is listed and searched.
 */
export function LinearIssuePicker({
  onPick,
  onClose,
  className = "absolute top-[calc(100%+0.375rem)] w-[420px] max-w-[calc(100vw-2rem)]",
  style,
  title = "Start from a Linear issue",
}: {
  onPick: (issue: LinearIssue) => void;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<IssueList | null>(null);
  // Bumped by the refresh button; 0 reads whatever the Mac has kept.
  const [refreshes, setRefreshes] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [tabs, setTabs] = useState(readTabs);
  // The workspace asked for, and the one the last answer listed (the first one when the asked one is gone).
  const [workspace, setWorkspace] = useState(() => localStorage.getItem(CHOSEN_KEY) ?? undefined);
  const [listed, setListed] = useState(workspace);

  useEffect(() => {
    let live = true;
    const text = query.trim();
    const fresh = refreshes > 0;
    const learn = (result: LinearIssuesResult) => {
      if ("error" in result || !result.workspaces) return;
      const next = result.workspaces;
      localStorage.setItem(TABS_KEY, JSON.stringify(next));
      setTabs((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      if (result.workspace) setListed(result.workspace);
    };
    const timer = window.setTimeout(
      () => {
        const show = (list: IssueList) => {
          if (!live) return;
          setIssues(list);
          setRefreshing(false);
        };
        Promise.resolve()
          .then(() => window.milagre.listLinearIssues(text || undefined, { fresh, ...(workspace ? { workspace } : {}) }))
          .then(
            (result) => {
              if (live) learn(result);
              show("error" in result ? { issues: [], error: result.error } : { issues: result.issues });
            },
            (error: unknown) => show({ issues: [], error: error instanceof Error ? error.message : String(error) }),
          );
      },
      text ? 250 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, refreshes, workspace]);

  function choose(id: string) {
    if (id === listed) return;
    localStorage.setItem(CHOSEN_KEY, id);
    setWorkspace(id);
    setListed(id);
    setIssues(null);
  }

  const issueRows = issues?.issues ?? [];

  return (
    <PickerPanel
      title={title}
      titleAction={
        <Tooltip label="Refresh issues" side="bottom" align="end">
          <button
            type="button"
            aria-label="Refresh issues"
            data-linear-issues-refresh
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              setRefreshes((count) => count + 1);
            }}
            className="-my-1 flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:cursor-default"
          >
            <span className={refreshing ? "animate-spin" : ""}>
              <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.8} color="currentColor" />
            </span>
          </button>
        </Tooltip>
      }
      header={
        tabs.length > 1 && (
          <div role="tablist" aria-label="Linear workspaces" data-linear-workspace-tabs className="flex shrink-0 flex-wrap gap-1 px-1.5 pb-1.5">
            {tabs.map((tab) => {
              const selected = tab.id === (listed ?? tabs[0]?.id);
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-linear-workspace-tab={tab.id}
                  onClick={() => choose(tab.id)}
                  className={`rounded-chip border px-2 py-1 text-xs font-medium transition-colors ${selected ? "border-line-strong text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}
                >
                  {tab.name}
                </button>
              );
            })}
          </div>
        )
      }
      query={query}
      onQueryChange={setQuery}
      placeholder="Search issues"
      searchPlacement="bottom"
      emptyLabel={issues?.error ?? "No issues found."}
      isEmpty={issues !== null && issueRows.length === 0}
      className={className}
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {issues === null && <IssueSkeleton />}
      {issueRows.map((issue) => (
        <div key={issue.key} data-linear-issue-row>
          <PickerRow
            icon={<LinearLogo size={13} />}
            label={`${issue.key} ${issue.title}`}
            description={issue.state.name}
            selected={false}
            wrapLabel
            onClick={() => onPick(issue)}
          />
        </div>
      ))}
    </PickerPanel>
  );
}
