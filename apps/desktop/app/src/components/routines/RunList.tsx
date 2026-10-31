import { useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Loading03Icon,
  Moon02Icon,
  NextIcon,
  UnavailableIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { clock, daySummary, foldText, foldTimes, runDays, runTitle, type RunEntry } from "@milagre/shared/routines";
import { ThisComputer } from "../../lib/shortcut-hints";

type HugeIconData = typeof CheckmarkCircle02Icon;

/** Day groups shown at first, and how many more each Show earlier days adds. */
const FIRST_DAYS = 4;
const MORE_DAYS = 7;

/** Without a way to tell whether a Run's Chat is still there, no row opens one. */
const noChat = () => false;

/** The first line of a failed Run's error, as its row shows it. */
const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

/** A Run that did something: its icon and color, and the words its row shows (a failed one says why, in red). */
function runLook(run: RoutineRun, routineName: string): { icon: HugeIconData; spin?: boolean; tone: string; text: string; failed?: boolean } {
  if (run.status === "running") return { icon: Loading03Icon, spin: true, tone: "text-ink-3", text: runTitle(run, routineName) };
  if (run.status === "failed") {
    const error = firstLine(run.error);
    return { icon: Alert02Icon, tone: "text-red-ink", text: error ? `Failed: ${error}` : "Failed", failed: true };
  }
  return { icon: CheckmarkCircle02Icon, tone: "text-ink-3", text: runTitle(run, routineName) };
}

/** A folded Run as its line says it: a quiet one its summary, a skipped one that its Chat was busy, and so on. */
function foldedLine(run: RoutineRun): { icon: HugeIconData; text: string } {
  if (run.rejected) return { icon: UnavailableIcon, text: firstLine(run.error) ?? "Refused" };
  if (run.status === "quiet") return { icon: Moon02Icon, text: run.summary?.trim() || "Quiet" };
  if (run.status === "skipped-busy") return { icon: NextIcon, text: "Its Chat was busy" };
  return { icon: Clock01Icon, text: `${ThisComputer} missed its time` };
}

const Icon = ({ icon, spin = false, className }: { icon: HugeIconData; spin?: boolean; className: string }) => (
  <span className={`flex size-5 shrink-0 items-center justify-center ${className}`}>
    <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} color="currentColor" className={spin ? "animate-spin motion-reduce:animate-none" : undefined} />
  </span>
);

/**
 * One line of the log, 36 px: the time column, an icon, the words, then an unread dot and a chevron when it opens a Chat.
 * It is a button when it opens something (a Chat, or a fold), plain text otherwise.
 */
function Row({
  time,
  icon,
  text,
  muted = false,
  red = false,
  title,
  unread = false,
  selected = false,
  trailing,
  onClick,
  expanded,
  ...data
}: {
  time: string;
  icon: ReactNode;
  text: string;
  muted?: boolean;
  red?: boolean;
  title?: string;
  unread?: boolean;
  selected?: boolean;
  trailing?: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const body = (
    <>
      <span className="w-[84px] shrink-0 text-[12.5px] text-ink-3 tabular-nums">{time}</span>
      {icon}
      <span className={`min-w-0 flex-1 truncate text-[13px] ${red ? "text-red-ink" : muted ? "text-ink-2" : "font-medium text-ink"}`} title={title ?? text}>
        {text}
      </span>
      {unread && <span role="img" aria-label="Unread" data-run-unread className="size-2 shrink-0 rounded-full bg-accent" />}
      {trailing}
    </>
  );
  const shape = `flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left ${selected ? "bg-field" : ""}`;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-current={selected || undefined}
      className={`${shape} transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none`}
      {...data}
    >
      {body}
    </button>
  ) : (
    <div className={shape} {...data}>
      {body}
    </div>
  );
}

const chevron = <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />;
const unfold = (open: boolean) => (
  <HugeiconsIcon icon={open ? UnfoldLessIcon : UnfoldMoreIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
);

/**
 * A Routine's Runs, newest first, grouped by day under small headings (Today, Yesterday, Thu, Oct 16). A Run that did
 * something has a row; a stretch of Runs that didn't (quiet, skipped, missed, refused) folds into one line that expands in
 * place. Days before yesterday show one summary line until opened. Show earlier days adds day groups. A row opens the Run's
 * Chat when `canOpen` says it can (canOpenRunChat); `selectedChat` is the one open beside the list.
 */
export function RunList({
  runs,
  routineName,
  unreadChats,
  canOpen = noChat,
  selectedChat = null,
  onOpenChat,
  now,
}: {
  runs: RoutineRun[];
  routineName: string;
  now: number;
  /** The keys of hidden Run Chats nobody opened: their rows show a dot. */
  unreadChats: ReadonlySet<string>;
  /** Whether a Run's row opens its Chat (canOpenRunChat). */
  canOpen?: (chatKey: string) => boolean;
  /** The Run Chat open beside the list: its row is highlighted. */
  selectedChat?: string | null;
  onOpenChat: (chatKey: string) => void;
}) {
  const days = useMemo(() => runDays(runs, now), [runs, now]);
  const [shownDays, setShownDays] = useState(FIRST_DAYS);
  // Open folds by their oldest Run (new Runs join a stretch at its newest end, so the key holds while it grows), and open
  // older days by their key.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const openable = (run: RoutineRun) => (run.chatId && canOpen(run.chatId) ? run.chatId : undefined);

  const entry = (item: RunEntry) => {
    if (item.kind === "run") {
      const { run } = item;
      const look = runLook(run, routineName);
      // A Run whose Chat is gone opens nothing, rather than a Chat the Project no longer has.
      const chat = openable(run);
      return (
        <Row
          key={run.id}
          data-routine-run={run.id}
          data-status={run.status}
          time={clock(run.startedAt)}
          icon={<Icon icon={look.icon} spin={look.spin} className={look.tone} />}
          text={look.text}
          red={look.failed}
          title={look.failed ? run.error : undefined}
          unread={chat !== undefined && unreadChats.has(chat)}
          selected={chat !== undefined && chat === selectedChat}
          trailing={chat ? chevron : undefined}
          onClick={chat ? () => onOpenChat(chat) : undefined}
        />
      );
    }
    const key = `fold:${item.runs[item.runs.length - 1]!.id}`;
    const open = expanded.has(key);
    return (
      <div key={key} data-routine-fold={key.slice(5)} data-expanded={open || undefined}>
        <Row
          time={foldTimes(item)}
          icon={<Icon icon={item.counts.quiet ? Moon02Icon : item.counts.skipped ? NextIcon : Clock01Icon} className="text-ink-3" />}
          text={foldText(item)}
          muted
          trailing={unfold(open)}
          expanded={open}
          onClick={() => toggle(key)}
        />
        {open &&
          item.runs.map((run) => {
            const line = foldedLine(run);
            const chat = run.status === "quiet" && !run.rejected ? openable(run) : undefined;
            return (
              <Row
                key={run.id}
                data-routine-run={run.id}
                data-status={run.rejected ? "refused" : run.status}
                time={clock(run.startedAt)}
                icon={<Icon icon={line.icon} className="text-ink-3" />}
                text={line.text}
                muted
                unread={chat !== undefined && unreadChats.has(chat)}
                selected={chat !== undefined && chat === selectedChat}
                trailing={chat ? chevron : undefined}
                onClick={chat ? () => onOpenChat(chat) : undefined}
              />
            );
          })}
      </div>
    );
  };

  return (
    // Rows pad their hover fill by 8 px; the list reaches out as far, so their text lines up with the page's header.
    <div data-run-list className="-mx-2">
      {days.slice(0, shownDays).map((day) => {
        const open = day.recent || expanded.has(`day:${day.key}`);
        return (
          <section key={day.key} data-run-day={day.label} className="pt-3 first:pt-0">
            <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{day.label}</h3>
            {!day.recent && (
              <Row
                data-run-day-summary={day.label}
                time="All day"
                icon={<Icon icon={Calendar03Icon} className="text-ink-3" />}
                text={daySummary(day.runs)}
                muted
                trailing={unfold(open)}
                expanded={open}
                onClick={() => toggle(`day:${day.key}`)}
              />
            )}
            {open && day.entries.map(entry)}
          </section>
        );
      })}
      <div className="mt-4 flex items-center gap-3 px-2">
        {days.length > shownDays && (
          <button
            type="button"
            data-run-earlier
            onClick={() => setShownDays((count) => count + MORE_DAYS)}
            className="inline-flex h-7 shrink-0 items-center rounded-lg border border-line-strong bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover"
          >
            Show earlier days
          </button>
        )}
        <span className="ml-auto text-[12px] text-ink-3">Keeps the newest 50 Runs that acted</span>
      </div>
    </div>
  );
}
