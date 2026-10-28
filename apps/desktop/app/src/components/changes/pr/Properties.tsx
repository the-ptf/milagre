import { useState, type CSSProperties, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { PlusSignIcon, Tag01Icon, UserAdd01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import type { PullRequestDetail, PullRequestReviewer, RepoLabel } from "@milagre/shared/pull-request-review";
import type { MilagreBridge } from "../../../electron";
import { PickerPanel, PickerRow } from "../../primitives/Picker";
import Tooltip from "../../primitives/Tooltip";
import type { PullRequestReview } from "../usePullRequest";
import { PopoverButton } from "./Popover";

// The Summary tab's Reviewers and Labels rows. Each picker loads its options when it first opens and applies every
// toggle at once, showing it before GitHub answers.

/** Where the pickers read their options: the PR's bridge and the Worktree it was read from. */
export type PrSource = { bridge: MilagreBridge["pr"]; cwd: string };

const icon = (glyph: IconSvgElement, size = 14) => <HugeiconsIcon icon={glyph} size={size} strokeWidth={1.8} color="currentColor" />;

const addButton = "flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink";

export function Avatar({ login, size = 18, className = "", team = false }: { login: string; size?: number; className?: string; team?: boolean }) {
  // A team has no picture; it shows as a group.
  if (team)
    return (
      <span style={{ width: size, height: size }} className={`flex shrink-0 items-center justify-center rounded-full bg-hover text-ink-2 ${className}`}>
        {icon(UserGroupIcon, Math.round(size * 0.65))}
      </span>
    );
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.style.visibility = "hidden";
      }}
      className={`shrink-0 rounded-full bg-hover ${className}`}
    />
  );
}

/** A list read once, when its picker first opens; a failure is read again on the next open. */
function useLazyList<T>(load: (() => Promise<T[]>) | undefined) {
  const [state, setState] = useState<{ items: T[] | null; error: string | null; loading: boolean }>({ items: null, error: null, loading: false });
  const fetch = () => {
    if (!load || state.items || state.loading) return;
    setState({ items: null, error: null, loading: true });
    load().then(
      (items) => setState({ items, error: null, loading: false }),
      (error: unknown) => setState({ items: null, error: error instanceof Error ? error.message : "Couldn't read the list.", loading: false }),
    );
  };
  return { ...state, fetch };
}

const matches = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase().trim());

/** A property row: its values wrap, its add button stays at the end of the first line. */
function Property({
  glyph,
  label,
  action,
  children,
  ...rest
}: { glyph: IconSvgElement; label: string; action?: ReactNode; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div {...rest} className="flex min-h-[30px] items-start gap-2">
      <span className="flex h-[30px] shrink-0 items-center text-ink-3">{icon(glyph, 13)}</span>
      <span className="w-[76px] shrink-0 text-[12.5px] leading-[30px] text-ink-2">{label}</span>
      <div className="flex min-h-[30px] min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1">{children}</div>
      {action && <span className="flex h-[30px] shrink-0 items-center">{action}</span>}
    </div>
  );
}

const REVIEW_STATE: Record<PullRequestReviewer["state"], { label: string; ring: string }> = {
  APPROVED: { label: "Approved", ring: "ring-green" },
  CHANGES_REQUESTED: { label: "Changes requested", ring: "ring-red" },
  COMMENTED: { label: "Commented", ring: "ring-ink-3" },
  REQUESTED: { label: "Requested", ring: "ring-surface" },
  DISMISSED: { label: "Dismissed", ring: "ring-surface" },
};

export function ReviewersRow({ pr, review, source }: { pr: PullRequestDetail; review: PullRequestReview; source?: PrSource }) {
  const candidates = useLazyList(
    source &&
      (async () => {
        const result = await source.bridge.reviewerCandidates({ cwd: source.cwd });
        if (!result.ok) throw new Error(result.message);
        return result.logins;
      }),
  );
  const [query, setQuery] = useState("");
  const current = new Map(pr.reviewers.map((reviewer) => [reviewer.login, reviewer]));
  const logins = [...new Set([...current.keys(), ...(candidates.items ?? [])])].filter((login) => login !== pr.author && matches(login, query));
  const toggle = (login: string) => {
    const add = !current.has(login);
    void review.write(
      "reviewers",
      (bridge, cwd, number) => bridge.requestReviewers({ cwd, number, add: add ? [login] : [], remove: add ? [] : [login] }),
      (detail) => ({
        ...detail,
        reviewers: add ? [...detail.reviewers, { login, state: "REQUESTED" }] : detail.reviewers.filter((reviewer) => reviewer.login !== login),
      }),
    );
  };
  return (
    <Property
      data-pr-reviewers=""
      glyph={UserGroupIcon}
      label="Reviewers"
      action={
        pr.state === "OPEN" && (
          <PopoverButton
            data-pr-reviewers-add
            label="Request reviewers"
            className={addButton}
            onOpen={() => {
              setQuery("");
              candidates.fetch();
            }}
            renderPanel={() => (
              <PickerPanel
                className="min-h-0"
                query={query}
                onQueryChange={setQuery}
                placeholder="Search people"
                isEmpty={logins.length === 0}
                emptyLabel={candidates.error ?? (candidates.loading ? "Loading…" : "No one found")}
              >
                {logins.map((login) => {
                  const reviewer = current.get(login);
                  // GitHub can only take back a request; a review once given stays.
                  const reviewed = reviewer !== undefined && reviewer.state !== "REQUESTED";
                  return (
                    <PickerRow
                      key={login}
                      icon={<Avatar login={login} team={reviewer?.team} size={18} />}
                      label={login}
                      description={reviewed ? REVIEW_STATE[reviewer.state].label : undefined}
                      selected={reviewer !== undefined}
                      disabled={reviewed}
                      onClick={() => toggle(login)}
                      option
                    />
                  );
                })}
              </PickerPanel>
            )}
          >
            {icon(UserAdd01Icon, 14)}
          </PopoverButton>
        )
      }
    >
      {pr.reviewers.length > 0 ? (
        <span className="flex items-center pl-0.5">
          {pr.reviewers.map((reviewer, index) => (
            <Tooltip key={reviewer.login} label={`${reviewer.login} · ${REVIEW_STATE[reviewer.state].label}`} side="bottom">
              <span data-pr-reviewer={reviewer.state} className={`flex ${index ? "-ml-1" : ""} ${reviewer.stale ? "opacity-60" : ""}`}>
                <Avatar login={reviewer.login} team={reviewer.team} size={22} className={`ring-[1.5px] ${REVIEW_STATE[reviewer.state].ring}`} />
              </span>
            </Tooltip>
          ))}
        </span>
      ) : (
        <span className="text-[12px] text-ink-3">None yet</span>
      )}
    </Property>
  );
}

/** A label in its GitHub colour; the pr-label class sets its text and chip lightness per theme, so the text stays readable. */
const labelStyle = (color: string) => ({ "--label": `#${color}` }) as CSSProperties;

export function LabelsRow({ pr, review, source }: { pr: PullRequestDetail; review: PullRequestReview; source?: PrSource }) {
  const options = useLazyList(
    source &&
      (async () => {
        const result = await source.bridge.labels({ cwd: source.cwd });
        if (!result.ok) throw new Error(result.message);
        return result.labels;
      }),
  );
  const [query, setQuery] = useState("");
  const current = new Set(pr.labels.map((label) => label.name));
  // Until the repository's labels load, the list shows the PR's own.
  const all: RepoLabel[] = options.items ?? pr.labels.map((label) => ({ ...label, description: "" }));
  const shown = all.filter((label) => matches(label.name, query));
  const toggle = (label: RepoLabel) => {
    const add = !current.has(label.name);
    void review.write(
      "labels",
      (bridge, cwd, number) => bridge.setLabels({ cwd, number, add: add ? [label.name] : [], remove: add ? [] : [label.name] }),
      (detail) => ({
        ...detail,
        labels: add ? [...detail.labels, { name: label.name, color: label.color }] : detail.labels.filter((entry) => entry.name !== label.name),
      }),
    );
  };
  return (
    <Property
      data-pr-labels=""
      glyph={Tag01Icon}
      label="Labels"
      action={
        pr.state === "OPEN" && (
          <PopoverButton
            data-pr-labels-add
            label="Edit labels"
            className={addButton}
            onOpen={() => {
              setQuery("");
              options.fetch();
            }}
            renderPanel={() => (
              <PickerPanel
                className="min-h-0"
                query={query}
                onQueryChange={setQuery}
                placeholder="Search labels"
                isEmpty={shown.length === 0}
                emptyLabel={options.error ?? (options.loading ? "Loading…" : "No labels")}
              >
                {shown.map((label) => (
                  <PickerRow
                    key={label.name}
                    icon={<span className="block size-2 rounded-full" style={{ backgroundColor: `#${label.color}` }} />}
                    label={label.name}
                    description={label.description || undefined}
                    selected={current.has(label.name)}
                    onClick={() => toggle(label)}
                    option
                  />
                ))}
              </PickerPanel>
            )}
          >
            {icon(PlusSignIcon, 13)}
          </PopoverButton>
        )
      }
    >
      {pr.labels.map((label) => (
        <span
          key={label.name}
          data-pr-label={label.name}
          style={labelStyle(label.color)}
          className="pr-label max-w-full truncate rounded-[6px] px-1.5 text-[11.5px] leading-5 font-medium"
        >
          {label.name}
        </span>
      ))}
      {pr.labels.length === 0 && <span className="text-[12px] text-ink-3">None yet</span>}
    </Property>
  );
}
