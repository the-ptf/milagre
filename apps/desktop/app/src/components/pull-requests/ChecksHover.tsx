import { useEffect, useRef, useState } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { CancelCircleIcon, CheckmarkCircle02Icon, CircleIcon, Loading03Icon, MinusSignCircleIcon } from "@hugeicons/core-free-icons";
import {
  pullRequestChecksLabel,
  pullRequestChecksSummary,
  type PullRequestChecks,
  type PullRequestChecksState,
  type PullRequestListCheck,
  type PullRequestRow,
} from "@milagre/shared/pull-request-list";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeFor } from "../../lib/computer-bridge";
import { Icon } from "../primitives/Icon";
import { Popover } from "../primitives/Popover";
import { SpinnerRing } from "../primitives/SpinnerRing";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH = 320;

type Look = { icon: IconSvgElement; className: string };
export const CHECKS_LOOK: Record<PullRequestChecksState, Look> = {
  pass: { icon: CheckmarkCircle02Icon, className: "text-green-ink" },
  fail: { icon: CancelCircleIcon, className: "text-red-ink" },
  running: { icon: Loading03Icon, className: "text-orange-ink" },
  none: { icon: CircleIcon, className: "text-ink-3" },
};
const CHECK_LOOK: Record<PullRequestListCheck["state"], Look> = {
  pass: { icon: CheckmarkCircle02Icon, className: "text-green" },
  fail: { icon: CancelCircleIcon, className: "text-red" },
  running: { icon: Loading03Icon, className: "text-orange motion-safe:animate-spin" },
  skipped: { icon: MinusSignCircleIcon, className: "text-ink-3" },
  neutral: { icon: CircleIcon, className: "text-ink-3" },
};

/** How long a check ran, as `48s` or `2m 30s`; "running" while it runs, empty when GitHub gave no times. */
export function checkDuration(check: Pick<PullRequestListCheck, "state" | "startedAt" | "completedAt">): string {
  if (check.state === "running") return "running";
  const seconds = Math.round((Date.parse(check.completedAt ?? "") - Date.parse(check.startedAt ?? "")) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

type Read = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; checks: PullRequestListCheck[] };

/** The row's checks label; hovering it (or focusing it) opens a card with every check, read when it first opens. */
export function ChecksHover({ row }: { row: Pick<PullRequestRow, "repo" | "number" | "computerId" | "checks"> }) {
  const label = pullRequestChecksLabel(row.checks);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>({ status: "loading" });
  const look = CHECKS_LOOK[row.checks.state];

  const live = useRef(true);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const show = () => {
    clear();
    setOpen(true);
    if (open) return;
    if (read.status !== "ready") setRead({ status: "loading" });
    Promise.resolve()
      .then(() => bridgeFor(row.computerId).readPullRequestChecks({ repo: row.repo, number: row.number }))
      .then(
        (checks) => live.current && setRead({ status: "ready", checks }),
        (failure: unknown) => live.current && setRead({ status: "error", message: ipcErrorMessage(failure) }),
      );
  };
  const later = (next: () => void, delay: number) => {
    clear();
    timer.current = window.setTimeout(next, delay);
  };
  const hide = () => setOpen(false);

  if (!label) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        data-pr-row-checks={row.checks.state}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Checks: ${pullRequestChecksSummary(row.checks)}`}
        onClick={(event) => {
          event.stopPropagation();
          show();
        }}
        onPointerEnter={() => later(show, OPEN_DELAY_MS)}
        onPointerLeave={() => later(hide, CLOSE_DELAY_MS)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show();
        }}
        className={`relative flex h-6 shrink-0 items-center gap-1 rounded-chip px-1 text-12 font-medium tabular-nums transition-colors hover:bg-hover ${look.className}`}
      >
        <Icon icon={look.icon} size={14} className={row.checks.state === "running" ? "motion-safe:animate-spin" : undefined} />
        {label}
      </button>
      {open && (
        <Popover
          anchor={button}
          width={CARD_WIDTH}
          role="dialog"
          label="Checks"
          onClose={hide}
          onPointerEnter={clear}
          onPointerLeave={() => later(hide, CLOSE_DELAY_MS)}
          data-pr-checks-card=""
        >
          <ChecksList checks={row.checks} read={read} />
        </Popover>
      )}
    </>
  );
}

function ChecksList({ checks, read }: { checks: PullRequestChecks; read: Read }) {
  return (
    <div className="flex flex-col" onClick={(event) => event.stopPropagation()}>
      <p className="border-b border-line px-2 pt-1 pb-2 text-12 font-medium text-ink-3">{pullRequestChecksSummary(checks)}</p>
      {read.status === "loading" && (
        <p className="flex items-center gap-2 px-2 py-2 text-12 text-ink-3">
          <SpinnerRing size={12} />
          Reading the checks…
        </p>
      )}
      {read.status === "error" && <p className="px-2 py-2 text-12 break-words text-red-ink">{read.message}</p>}
      {read.status === "ready" && (
        <div className="flex flex-col gap-px pt-1">
          {read.checks.map((check) => (
            <button
              key={`${check.workflow ?? ""}/${check.name}/${check.url ?? check.startedAt ?? ""}`}
              type="button"
              data-pr-check-row={check.state}
              disabled={!check.url}
              onClick={() => check.url && window.open(check.url, "_blank", "noopener,noreferrer")}
              className="flex h-7 w-full items-center gap-2 rounded-inline px-2 text-left text-12 text-ink-2 transition-colors not-disabled:hover:bg-hover-2 not-disabled:hover:text-ink"
            >
              <Icon icon={CHECK_LOOK[check.state].icon} size={14} className={`shrink-0 ${CHECK_LOOK[check.state].className}`} />
              <span className="min-w-0 flex-1 truncate">
                {check.workflow && <span className="text-ink-3">{check.workflow} / </span>}
                {check.name}
              </span>
              <span className="shrink-0 text-11 text-ink-3 tabular-nums">{checkDuration(check)}</span>
            </button>
          ))}
          {read.checks.length === 0 && <p className="px-2 py-2 text-12 text-ink-3">No checks on the head commit.</p>}
        </div>
      )}
    </div>
  );
}
