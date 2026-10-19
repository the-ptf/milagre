import { useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowRight01Icon, Clock01Icon, Loading03Icon, Moon02Icon, NextIcon, Tick02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import type { RoutineRun } from "@milagre/shared/model";
import { foldRuns, foldText, runTitle, runWhen } from "@milagre/shared/routines";

type HugeIconData = typeof Tick02Icon;
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";

/** Without a way to tell whether a Run's Chat is still there, no row opens one. */
const noChat = () => false;

/** The first line of a failed Run's error, as its row shows it. */
const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

/** A Run that did something: its icon, a second line when it has one, and its color. */
function runLook(run: RoutineRun): { icon: HugeIconData; spin?: boolean; tone: string; detail?: string; failed?: boolean } {
  if (run.status === "running") return { icon: Loading03Icon, spin: true, tone: "text-ink-3", detail: "Running" };
  if (run.status === "failed") {
    const error = firstLine(run.error);
    return { icon: Alert02Icon, tone: "text-red", detail: error ? `Failed · ${error}` : "Failed", failed: true };
  }
  return { icon: Tick02Icon, tone: "text-ink-2" };
}

/** A folded Run as its line says it: a quiet one its summary, a skipped one that its Chat was busy, and so on. */
function foldedLine(run: RoutineRun): { icon: HugeIconData; text: string } {
  if (run.rejected) return { icon: UnavailableIcon, text: firstLine(run.error) ?? "Refused" };
  if (run.status === "quiet") return { icon: Moon02Icon, text: run.summary?.trim() || "Quiet" };
  if (run.status === "skipped-busy") return { icon: NextIcon, text: "Its Chat was busy" };
  return { icon: Clock01Icon, text: "This Mac missed its time" };
}

/** A row that opens its Chat when it has one to open, and is plain text otherwise. */
function RowShell({
  open,
  className,
  children,
  ...data
}: { open?: () => void; className: string; children: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  return open ? (
    <button
      type="button"
      onClick={open}
      className={`${className} w-full text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none`}
      {...data}
    >
      {children}
    </button>
  ) : (
    <div className={className} {...data}>
      {children}
    </div>
  );
}

const Icon = ({ icon, spin = false, className }: { icon: HugeIconData; spin?: boolean; className: string }) => (
  <span className={`flex size-5 shrink-0 items-center justify-center ${className}`}>
    <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} color="currentColor" className={spin ? "animate-spin motion-reduce:animate-none" : undefined} />
  </span>
);

/**
 * A Routine's Runs, newest first, in the Routines page's card: a row for each Run that did something (running, acted,
 * failed) and one line for each stretch of Runs that didn't, which expands in place. A row, or a quiet Run's line, opens the
 * Run's Chat while that Chat is still there (`hasChat`, archived or not): a quiet Run's Worktree removed with its Chat
 * leaves nothing to open.
 */
export function RunList({
  runs,
  routineName,
  now,
  unreadChats,
  hasChat = noChat,
  onOpenChat,
}: {
  runs: RoutineRun[];
  routineName: string;
  now: number;
  /** The keys of hidden Run Chats nobody opened: their rows show a dot. */
  unreadChats: ReadonlySet<string>;
  /** Whether a Chat is still there to open, archived or not (chatLeft). */
  hasChat?: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
}) {
  const entries = useMemo(() => foldRuns(runs), [runs]);
  // Open folds, by their oldest Run: new Runs join a stretch at its newest end, so the key holds while it grows.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className={card}>
      {entries.map((entry) => {
        if (entry.kind === "run") {
          const { run } = entry;
          const look = runLook(run);
          // A Run whose Chat is gone opens nothing, rather than a Chat the Project no longer has.
          const chat = run.chatId && hasChat(run.chatId) ? run.chatId : undefined;
          const unread = chat !== undefined && unreadChats.has(chat);
          return (
            <RowShell
              key={run.id}
              open={chat ? () => onOpenChat(chat) : undefined}
              className="flex min-h-12 items-center gap-3 px-4 py-2.5"
              data-routine-run={run.id}
              data-status={run.status}
            >
              <Icon icon={look.icon} spin={look.spin} className={look.tone} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-[13px] font-medium text-ink">{runTitle(run, routineName)}</span>
                {look.detail && (
                  <span className={`truncate text-[12px] ${look.failed ? "text-red" : "text-ink-3"}`} title={look.failed ? run.error : undefined}>
                    {look.detail}
                  </span>
                )}
              </span>
              {unread && <span role="img" aria-label="Unread" data-run-unread className="size-2 shrink-0 rounded-full bg-accent" />}
              <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{runWhen(run.startedAt, now)}</span>
            </RowShell>
          );
        }
        const key = entry.runs[entry.runs.length - 1]!.id;
        const open = expanded.has(key);
        return (
          <div key={`fold-${key}`} data-routine-fold={key} data-expanded={open || undefined}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(key)}
              className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-ink-3">
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={15}
                  strokeWidth={1.8}
                  color="currentColor"
                  className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{foldText(entry.counts, entry.last)}</span>
            </button>
            {open && (
              <div className="pb-1.5">
                {entry.runs.map((run) => {
                  const line = foldedLine(run);
                  const chat = run.status === "quiet" && !run.rejected && run.chatId && hasChat(run.chatId) ? run.chatId : undefined;
                  return (
                    <RowShell
                      key={run.id}
                      open={chat ? () => onOpenChat(chat) : undefined}
                      className="flex min-h-8 items-center gap-3 py-1 pr-4 pl-12"
                      data-routine-run={run.id}
                      data-status={run.rejected ? "refused" : run.status}
                    >
                      <Icon icon={line.icon} className="text-ink-3" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2" title={line.text}>
                        {line.text}
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{runWhen(run.startedAt, now)}</span>
                    </RowShell>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
