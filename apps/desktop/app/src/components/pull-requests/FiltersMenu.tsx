import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  BubbleChatIcon,
  CheckmarkCircle02Icon,
  FilterHorizontalIcon,
  Folder01Icon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Tag01Icon,
  UserGroupIcon,
  UserIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import {
  PULL_REQUEST_FILTER_CHOICES,
  PULL_REQUEST_FILTER_DEFAULTS,
  activePullRequestFilters,
  type PullRequestFilters,
} from "@milagre/shared/pull-request-list";
import { useDismiss } from "../../lib/use-dismiss";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuRow, MenuSeparator } from "../primitives/Popover";
import { ScrollArea } from "../primitives/ScrollArea";

type Key = keyof PullRequestFilters;
type Choice = { value: string | null; label: string };
type Entry = { key: Key; icon: IconSvgElement; label: string; choices: Choice[] };

const MAIN_WIDTH = 256;
const SUB_WIDTH = 224;
const PANEL = "fixed z-50 flex flex-col overflow-hidden rounded-card bg-surface shadow-raised";
const rowsOf = (panel: HTMLElement | null) => [...(panel?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
const fixed = (key: Exclude<Key, "author" | "label" | "project">): Choice[] => PULL_REQUEST_FILTER_CHOICES[key].map(({ id, label }) => ({ value: id, label }));

export type FilterValues = { authors: string[]; labels: string[]; projects: { path: string; name: string }[] };

type Separator = `separator-${number}`;

function entriesFor(values: FilterValues): (Entry | Separator)[] {
  return [
    { key: "state", icon: GitPullRequestIcon, label: "State", choices: fixed("state") },
    { key: "involvement", icon: UserGroupIcon, label: "Involvement", choices: fixed("involvement") },
    "separator-1",
    {
      key: "author",
      icon: UserIcon,
      label: "Author",
      choices: [{ value: null, label: "Anyone" }, ...values.authors.map((login) => ({ value: login, label: login }))],
    },
    {
      key: "label",
      icon: Tag01Icon,
      label: "Labels",
      choices: [{ value: null, label: "Any" }, ...values.labels.map((name) => ({ value: name, label: name }))],
    },
    { key: "draft", icon: GitPullRequestDraftIcon, label: "Draft", choices: fixed("draft") },
    { key: "review", icon: ViewIcon, label: "Review", choices: fixed("review") },
    { key: "checks", icon: CheckmarkCircle02Icon, label: "Checks", choices: fixed("checks") },
    { key: "chat", icon: BubbleChatIcon, label: "Chat", choices: fixed("chat") },
    "separator-2",
    {
      key: "project",
      icon: Folder01Icon,
      label: "Project",
      choices: [{ value: null, label: "All Projects" }, ...values.projects.map((project) => ({ value: project.path, label: project.name }))],
    },
  ];
}

const shownValue = (entry: Entry, value: string | null) => entry.choices.find((choice) => choice.value === value)?.label ?? value ?? "";

/** The Filters button: one menu of filters, each opening its choices to the side, ticked where it stands. */
export function FiltersMenu({
  filters,
  values,
  onChange,
}: {
  filters: PullRequestFilters;
  values: FilterValues;
  onChange: (next: PullRequestFilters) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const subPanel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; subLeft: number } | null>(null);
  const [sub, setSub] = useState<{ key: Key; top: number; focus: boolean } | null>(null);
  const count = activePullRequestFilters(filters);
  const entries = entriesFor(values);
  const open = position !== null;

  const place = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return false;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MAIN_WIDTH - 8));
    const right = left + MAIN_WIDTH + 6;
    setPosition({ top: rect.bottom + 6, left, subLeft: right + SUB_WIDTH + 8 <= window.innerWidth ? right : left - SUB_WIDTH - 6 });
    return true;
  };
  const close = (refocus = false) => {
    setPosition(null);
    setSub(null);
    if (refocus) button.current?.focus();
  };
  useDismiss(
    open,
    () => close(),
    (target) => Boolean(target.closest("[data-pr-filters], [data-pr-filters-panel]")),
    place,
  );
  useLayoutEffect(() => {
    if (open) rowsOf(main.current)[0]?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!sub?.focus) return;
    const rows = rowsOf(subPanel.current);
    (rows.find((row) => row.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
  }, [sub]);

  const openSub = (key: Key, row: HTMLElement, focus: boolean) => {
    const top = row.getBoundingClientRect().top - 6;
    setSub((current) => (current?.key === key && !focus ? current : { key, top, focus }));
  };
  const step = (event: ReactKeyboardEvent, rows: HTMLElement[]) => {
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  const mainKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") step(event, rowsOf(main.current));
    else if (event.key === "ArrowRight" && active?.dataset.filter) {
      event.preventDefault();
      openSub(active.dataset.filter as Key, active, true);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
    }
  };
  const subKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") step(event, rowsOf(subPanel.current));
    else if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const key = sub?.key;
      setSub(null);
      main.current?.querySelector<HTMLElement>(`[data-filter="${key}"]`)?.focus();
    } else if (event.key === "Tab") event.preventDefault();
  };
  const subEntry = sub ? entries.find((entry): entry is Entry => typeof entry !== "string" && entry.key === sub.key) : undefined;

  return (
    <>
      <Button
        ref={button}
        variant="secondary"
        shape="pill"
        aria-haspopup="menu"
        aria-expanded={open}
        data-pr-filters
        onClick={() => (open ? close() : place())}
        className="aria-expanded:bg-hover-2"
      >
        <Icon icon={FilterHorizontalIcon} size={16} className="text-ink-3" />
        Filters
        {count > 0 && (
          <span
            data-pr-filters-count
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-10 font-semibold text-on-ink tabular-nums"
          >
            {count}
          </span>
        )}
      </Button>
      {position &&
        createPortal(
          <>
            <div
              ref={main}
              role="menu"
              aria-label="Filters"
              onKeyDown={mainKeys}
              data-pr-filters-panel
              className={`${PANEL} p-1.5`}
              style={{
                width: MAIN_WIDTH,
                top: position.top,
                left: position.left,
                animation: "pop-in var(--duration-base) var(--ease-enter) backwards",
                transformOrigin: "top left",
              }}
            >
              <div className="flex flex-col gap-px">
                {entries.map((entry) =>
                  typeof entry === "string" ? (
                    <MenuSeparator key={entry} />
                  ) : (
                    <MenuRow
                      key={entry.key}
                      data-filter={entry.key}
                      aria-haspopup="menu"
                      aria-expanded={sub?.key === entry.key}
                      onPointerEnter={(event) => openSub(entry.key, event.currentTarget, false)}
                      onClick={(event) => openSub(entry.key, event.currentTarget, true)}
                      className={sub?.key === entry.key ? "bg-hover-2" : ""}
                      icon={entry.icon}
                      title={entry.label}
                      trailing={
                        <>
                          <span
                            className={`max-w-24 truncate text-11 font-normal ${filters[entry.key] === PULL_REQUEST_FILTER_DEFAULTS[entry.key] ? "text-ink-3" : "text-ink"}`}
                          >
                            {shownValue(entry, filters[entry.key])}
                          </span>
                          <Icon icon={ArrowRight01Icon} size={14} className="shrink-0 text-ink-3" />
                        </>
                      }
                    />
                  ),
                )}
              </div>
            </div>
            {sub && subEntry && (
              <div
                ref={subPanel}
                role="menu"
                aria-label={subEntry.label}
                onKeyDown={subKeys}
                data-pr-filters-panel
                data-pr-filters-sub={sub.key}
                className={PANEL}
                style={{
                  width: SUB_WIDTH,
                  top: Math.max(8, sub.top),
                  maxHeight: Math.min(420, window.innerHeight - Math.max(8, sub.top) - 8),
                  left: position.subLeft,
                  animation: "pop-in var(--duration-fast) var(--ease-enter) backwards",
                  transformOrigin: "top left",
                }}
              >
                <ScrollArea className="p-1.5">
                  <div className="flex flex-col gap-px">
                    {subEntry.choices.map((choice) => (
                      <MenuRow
                        key={choice.value ?? ""}
                        role="menuitemradio"
                        checked={filters[sub.key] === choice.value}
                        data-filter-choice={choice.value ?? ""}
                        onClick={() => onChange({ ...filters, [sub.key]: choice.value } as PullRequestFilters)}
                        title={choice.label}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}
