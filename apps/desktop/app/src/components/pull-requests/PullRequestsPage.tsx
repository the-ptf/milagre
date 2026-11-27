import { useEffect, useMemo, useState } from "react";
import { ArrowUpDownIcon, GitPullRequestIcon, LaptopIcon, RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  PULL_REQUEST_SORTS,
  filterPullRequests,
  groupPullRequests,
  pullRequestFilterValues,
  sortPullRequests,
  type PullRequestRow,
} from "@milagre/shared/pull-request-list";
import { isDimmed, useComputers } from "../../lib/computers";
import { flyToOrchestrator, sendOrchestratorTask } from "../../lib/orchestrator-store";
import {
  readPullRequestPrefs,
  refreshPullRequests,
  savePullRequestPrefs,
  setPullRequestListState,
  usePullRequests,
  type PullRequestPrefs,
} from "../../lib/pull-requests";
import { reviewPrompt, reviewingUrls } from "../../lib/review-for-me";
import { undoHistory } from "../../lib/undo-history";
import { useOrchestratorBoard } from "../../lib/use-orchestrator-board";
import { useRefreshSpin } from "../changes/useRefreshSpin";
import { IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { Skeleton } from "../primitives/Skeleton";
import { ChoiceMenu } from "./ChoiceMenu";
import { FiltersMenu } from "./FiltersMenu";
import { PullRequestItem, type ReviewForMe } from "./PullRequestItem";
import { PullRequestPane } from "./PullRequestPane";

const CARD = "divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card";
const NOTE_HEIGHT = 40;

export type OpenPullRequestChat = (computerId: string, projectPath: string, sessionId: number) => void;

function startPrefs(): PullRequestPrefs {
  const prefs = readPullRequestPrefs();
  setPullRequestListState(prefs.filters.state);
  return prefs;
}

function noteFrom(from: HTMLElement): DOMRect {
  const box = (from.closest("[data-pr-row], [data-pr-review-agent]") ?? from).getBoundingClientRect();
  return new DOMRect(box.left, box.top + (box.height - NOTE_HEIGHT) / 2, Math.min(320, box.width), NOTE_HEIGHT);
}

function useReviewForMe(urls: readonly string[]) {
  const { orchestrator, cards } = useOrchestratorBoard();
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const running = useMemo(() => reviewingUrls(cards, urls), [cards, urls]);
  const { enabled, mascotColor, name } = orchestrator.settings;
  const review = (row: PullRequestRow): ReviewForMe => ({
    color: mascotColor,
    busyLabel: `${name} reviewing`,
    reviewing: sending.has(row.url) || running.has(row.url),
    onReview: (from) => {
      const note = noteFrom(from);
      setSending((current) => new Set(current).add(row.url));
      sendOrchestratorTask(reviewPrompt(row))
        .then(
          (task) => flyToOrchestrator({ id: task.id, text: `#${row.number} ${row.title}`, from: note }),
          (failure: unknown) => undoHistory.notify(`Couldn't send the review to ${name}: ${ipcErrorMessage(failure)}`),
        )
        .finally(() =>
          setSending((current) => {
            const next = new Set(current);
            next.delete(row.url);
            return next;
          }),
        );
    },
  });
  return { enabled, review };
}

function LoadingRows() {
  return (
    <div data-pr-loading className={`mt-5 ${CARD}`}>
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex h-12 items-center gap-3 px-4">
          <Skeleton className="size-4 rounded-full" />
          <span className="grid flex-1 gap-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton secondary className="h-2.5 w-1/3" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Every PR in the repositories of the Projects on this computer and the paired ones, grouped by what they need from you. */
export function PullRequestsPage({ onOpenChat }: { onOpenChat: OpenPullRequestChat }) {
  const data = usePullRequests();
  const { thisMac, computers } = useComputers();
  const [prefs, setPrefs] = useState(startPrefs);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const spin = useRefreshSpin(() => refreshPullRequests({ force: true }), data.reading);
  const urls = useMemo(() => data.rows.map((row) => row.url), [data.rows]);
  const orchestrator = useReviewForMe(urls);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setPullRequestListState(prefs.filters.state), [prefs.filters.state]);
  const update = (patch: Partial<PullRequestPrefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePullRequestPrefs(next);
      return next;
    });

  const computerChoices = computers.length > 0 ? [LOCAL_COMPUTER, ...computers.map((computer) => computer.id)] : [];
  const picked = computerChoices.includes(prefs.computer) ? prefs.computer : "all";
  const computerName = (id: string) => (id === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === id)?.name ?? "Computer"));
  const rows = useMemo(() => (picked === "all" ? data.rows : data.rows.filter((row) => row.computerIds.includes(picked))), [data.rows, picked]);
  const values = useMemo(() => pullRequestFilterValues(rows), [rows]);
  const groups = useMemo(() => groupPullRequests(sortPullRequests(filterPullRequests(rows, prefs.filters, query), prefs.sort)), [rows, prefs, query]);
  const open = selected ? data.rows.find((row) => row.url === selected) : undefined;

  const rowComputer = (row: PullRequestRow) => {
    if (row.computerId === LOCAL_COMPUTER && !row.offline) return null;
    return { name: computerName(row.computerId), offline: row.offline };
  };
  const empty = !data.loading && data.rows.length === 0;
  const state = prefs.filters.state;

  return (
    <div data-pull-requests-page className="flex h-full min-h-0 flex-1 gap-3">
      <ScrollArea className="h-full min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1000px] px-6 pt-[var(--window-chrome-height)] pb-10">
          <div data-pr-toolbar className="flex items-center gap-2 pt-2">
            <label className="flex h-8 min-w-36 flex-1 cursor-text items-center gap-2 rounded-full bg-surface px-3 text-ink-3 shadow-btn">
              <Icon icon={Search01Icon} size={16} className="shrink-0" />
              <input
                data-pr-search
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !query) return;
                  event.preventDefault();
                  setQuery("");
                }}
                placeholder="Search pull requests, or label:bug"
                aria-label="Search pull requests"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-13 text-ink outline-none placeholder:text-ink-3"
              />
            </label>
            <ChoiceMenu
              label="Sort"
              data-pr-sort={prefs.sort}
              value={prefs.sort}
              choices={PULL_REQUEST_SORTS.map((sort) => ({ value: sort.id, label: sort.label }))}
              onChange={(sort) => update({ sort })}
            >
              <Icon icon={ArrowUpDownIcon} size={16} className="text-ink-3" />
              Sort
            </ChoiceMenu>
            <FiltersMenu filters={prefs.filters} values={values} onChange={(filters) => update({ filters })} />
            {computerChoices.length > 0 && (
              <ChoiceMenu
                label="Computer"
                data-pr-computer={picked}
                value={picked}
                width={240}
                choices={[
                  { value: "all", label: "All computers" },
                  ...computerChoices.map((id) => {
                    const view = computers.find((computer) => computer.id === id);
                    return {
                      value: id,
                      label: computerName(id),
                      trailing: id === LOCAL_COMPUTER ? "This computer" : view && isDimmed(view) ? "Offline" : undefined,
                    };
                  }),
                ]}
                onChange={(computer) => update({ computer })}
              >
                <Icon icon={LaptopIcon} size={16} className="text-ink-3" />
                <span className="max-w-32 truncate">{picked === "all" ? "All" : computerName(picked)}</span>
              </ChoiceMenu>
            )}
            <IconButton
              size={32}
              variant="secondary"
              shape="pill"
              label="Refresh"
              data-pr-refresh
              onClick={() => !spin.busy && spin.refresh()}
              aria-disabled={spin.busy}
            >
              <span
                className={`flex ${spin.spinning ? "refresh-spin animate-spin" : ""}`}
                onAnimationIteration={spin.onAnimationIteration}
                onAnimationEnd={spin.onAnimationEnd}
              >
                <Icon icon={RefreshIcon} size={16} />
              </span>
            </IconButton>
          </div>
          <InlineError data-pr-error className="mt-4 px-1">
            {data.errors[0]}
          </InlineError>
          {data.loading && <LoadingRows />}
          {empty && (
            <EmptyState
              data-pr-empty
              icon={GitPullRequestIcon}
              size="page"
              title={`No ${state === "all" ? "" : `${state} `}pull requests in your Projects' repositories`}
            />
          )}
          {!empty && !data.loading && groups.length === 0 && (
            <p data-pr-none className="mt-5 px-1 text-13 text-ink-3">
              No pull requests match.
            </p>
          )}
          {groups.map((group) => (
            <section key={group.id} data-pr-group={group.id} className="mt-5 space-y-2">
              <SectionLabel className="flex items-center gap-1.5 px-1">
                {group.label}
                <span className="font-normal tabular-nums">{group.items.length}</span>
              </SectionLabel>
              <div className={CARD}>
                {group.items.map((row) => (
                  <PullRequestItem
                    key={row.url}
                    row={row}
                    selected={row.url === selected}
                    narrow={Boolean(open)}
                    computer={picked === "all" ? rowComputer(row) : null}
                    review={orchestrator.enabled && group.id === "review" && row.state === "OPEN" ? orchestrator.review(row) : null}
                    now={now}
                    onSelect={() => setSelected(row.url)}
                    onOpenChat={(chat) => onOpenChat(chat.computerId, chat.projectPath, chat.chatId)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
      {open && (
        <div className="flex min-h-0 shrink-0 pt-[var(--window-chrome-height)]">
          <PullRequestPane key={open.url} row={open} review={orchestrator.enabled ? orchestrator.review(open) : null} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}
