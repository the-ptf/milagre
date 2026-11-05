import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLEANUP_INTRO,
  CLEANUP_TITLE,
  IDLE_DAYS,
  SAVED_GROUP,
  UNSAVED_GROUP,
  cleanupGroups,
  cleanupToast,
  groupLine,
  idleFor,
  progressLine,
  removeIdleWorktrees,
  removeLabel,
  rowDate,
  rowDetail,
  rowLabel,
  rowSize,
  selectionLine,
  type IdleDays,
  type IdleWorktree,
} from "@milagre/shared/storage";
import { ipcErrorMessage } from "@milagre/shared/result";
import { showToast } from "../../lib/toast";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { InlineError } from "../primitives/InlineError";
import { ScrollArea } from "../primitives/ScrollArea";
import { Segmented } from "../primitives/Segmented";
import type { MilagreBridge } from "../../electron";

export type CleanupBridge = Pick<MilagreBridge, "readIdleWorktrees" | "removeIdleWorktree" | "readComputerResources">;

const DAY_OPTIONS = IDLE_DAYS.map((days) => ({ value: String(days) as `${IdleDays}`, label: `${days} days` }));
// An older Milagre answers with an unknown command.
const older = (message: string) => /unknown|not (available|allowed|supported)|no handler/i.test(message);

/** A group's card: its checkbox selects or clears every worktree in it. */
function GroupCard({
  title,
  list,
  selected,
  onToggle,
  dot,
  disabled,
}: {
  title: string;
  list: IdleWorktree[];
  selected: Set<string>;
  onToggle: (on: boolean) => void;
  dot?: boolean;
  disabled: boolean;
}) {
  const picked = list.filter((item) => selected.has(item.path)).length;
  const state = picked === 0 ? false : picked === list.length ? true : "indeterminate";
  return (
    <label
      data-cleanup-group={dot ? "unsaved" : "saved"}
      className={`flex min-w-0 flex-1 items-center gap-3 rounded-control border px-3 py-2.5 ${list.length ? "cursor-pointer" : "opacity-60"} ${state ? "border-line-strong bg-hover/50" : "border-line"}`}
    >
      <Checkbox checked={state} disabled={disabled || !list.length} onCheckedChange={onToggle} aria-label={title} />
      <span className="grid min-w-0">
        <span className="flex items-center gap-1.5 text-13 font-medium text-ink">
          {title}
          {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />}
        </span>
        <span className="truncate text-12 tabular-nums text-ink-3">{groupLine(list)}</span>
      </span>
    </label>
  );
}

/**
 * Clean up worktrees for one computer: its worktrees no Chat has used for 30, 60 or 90 days, those with nothing unsaved
 * checked at first. Removing goes one at a time with progress and Stop; the folders are measured again after.
 */
export function WorktreeCleanup({
  bridge,
  computerName,
  onClose,
}: {
  bridge: CleanupBridge;
  /** The paired computer it cleans, named in the description; null for this Mac. */
  computerName: string | null;
  onClose: () => void;
}) {
  const [list, setList] = useState<IdleWorktree[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [days, setDays] = useState<IdleDays>(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const stop = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    bridge.readIdleWorktrees().then(
      (answer) => {
        if (!live) return;
        setList(answer.worktrees);
        setSelected(new Set(cleanupGroups(idleFor(answer.worktrees, 30, Date.now())).saved.map((item) => item.path)));
      },
      (error) => live && setLoadError(ipcErrorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  const visible = useMemo(() => (list ? idleFor(list, days, now) : []), [list, days, now]);
  const groups = useMemo(() => cleanupGroups(visible), [visible]);
  const chosen = visible.filter((item) => selected.has(item.path));
  const busy = progress !== null;

  const pickDays = (value: IdleDays) => {
    setDays(value);
    // A new span starts from what it would remove safely.
    setSelected(new Set(cleanupGroups(idleFor(list ?? [], value, now)).saved.map((item) => item.path)));
  };
  const toggle = (paths: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (on) next.add(path);
        else next.delete(path);
      }
      return next;
    });

  async function remove() {
    if (busy || !chosen.length) return;
    stop.current = false;
    setProgress(0);
    const result = await removeIdleWorktrees(chosen, (request) => bridge.removeIdleWorktree(request), {
      onProgress: setProgress,
      stopped: () => stop.current,
    });
    showToast(cleanupToast(result));
    void bridge.readComputerResources({ fresh: true }).catch(() => {});
    onClose();
  }

  const empty = list !== null && !visible.length;
  return (
    <Dialog
      data-worktree-cleanup
      title={CLEANUP_TITLE}
      description={computerName ? `${CLEANUP_INTRO} On ${computerName}.` : CLEANUP_INTRO}
      width={600}
      footer="bar"
      onClose={busy ? undefined : onClose}
      dismissOnScrim={!busy}
      footerStart={
        <span data-cleanup-status className="text-12 tabular-nums text-ink-3">
          {busy ? progressLine(progress, chosen.length) : null}
        </span>
      }
      actions={
        busy ? (
          <>
            <Button
              variant="ghost"
              data-cleanup-stop
              disabled={stopping}
              onClick={() => {
                stop.current = true;
                setStopping(true);
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </Button>
            <Button variant="danger" disabled>
              Removing…
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" autoFocus onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" data-cleanup-remove disabled={!chosen.length} onClick={() => void remove()}>
              {removeLabel(chosen.length)}
            </Button>
          </>
        )
      }
    >
      <div className="mt-4 grid gap-3">
        <Segmented<`${IdleDays}`>
          label="Unused for at least"
          size="large"
          dataKey="cleanup-days"
          className="self-start"
          value={String(days) as `${IdleDays}`}
          options={DAY_OPTIONS.map((option) => ({ ...option, disabled: busy }))}
          onChange={(value) => pickDays(Number(value) as IdleDays)}
        />
        {loadError ? (
          <InlineError size={12}>
            {older(loadError)
              ? `Milagre on ${computerName ?? "this Mac"} can't clean up worktrees yet. Update it first.`
              : `Couldn't list the worktrees: ${loadError}`}
          </InlineError>
        ) : list === null ? (
          <span className="py-6 text-center text-13 text-ink-3">Checking worktrees…</span>
        ) : empty ? (
          <span data-cleanup-empty className="py-6 text-center text-13 text-ink-3">
            No worktree has gone unused for {days} days.
          </span>
        ) : (
          <>
            <div className="flex gap-3">
              <GroupCard
                title={SAVED_GROUP}
                list={groups.saved}
                selected={selected}
                disabled={busy}
                onToggle={(on) =>
                  toggle(
                    groups.saved.map((item) => item.path),
                    on,
                  )
                }
              />
              <GroupCard
                title={UNSAVED_GROUP}
                dot
                list={groups.unsaved}
                selected={selected}
                disabled={busy}
                onToggle={(on) =>
                  toggle(
                    groups.unsaved.map((item) => item.path),
                    on,
                  )
                }
              />
            </div>
            <ScrollArea as="ul" chainScroll className="max-h-[300px] rounded-control border border-line">
              {[...groups.saved, ...groups.unsaved].map((item) => (
                <li key={item.path} data-cleanup-row={item.title}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover/50" aria-label={rowLabel(item, now)}>
                    <Checkbox checked={selected.has(item.path)} disabled={busy} onCheckedChange={(on) => toggle([item.path], on)} />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate text-13 text-ink">{item.title}</span>
                      <span className={`truncate text-12 ${item.status.removable ? "text-ink-3" : "text-orange-ink"}`}>{rowDetail(item)}</span>
                    </span>
                    <span className="shrink-0 text-12 tabular-nums text-ink-3">{rowDate(item.lastAt, now)}</span>
                    <span className="w-16 shrink-0 text-right text-12 tabular-nums text-ink-2">{rowSize(item)}</span>
                  </label>
                </li>
              ))}
            </ScrollArea>
            <p data-cleanup-selection className="text-12 text-ink-2">
              {selectionLine(chosen)}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
