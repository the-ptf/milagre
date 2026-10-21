import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FileAddIcon,
  FileEditIcon,
  FileRemoveIcon,
  Redo02Icon,
  Undo02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { checkpointEffect, checkpointMeta, checkpointTask, checkpointTime, splitCheckpointPath, type CheckpointFile } from "@milagre/shared/checkpoints";
import type { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { ScrollArea } from "../primitives/ScrollArea";
import { ShortcutKeys } from "../primitives/ShortcutKeys";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];
export type CheckpointReview = ReturnType<typeof useCheckpoints>;
/** Undo previews a task's checkpoint; Redo previews the recovery checkpoint an undo saved. */
export type UndoIntent = "Undo" | "Redo";

function Icon({ icon, size = 15 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

const FILE_ICONS: Record<CheckpointFile["action"], IconData> = { replace: FileEditIcon, delete: FileAddIcon, create: FileRemoveIcon };

/**
 * Undo changes in the composer's place: the Chat's tasks (Esc Esc), then one task's files with what undoing does to each.
 * Only a file edited after the task asks Keep current or Undo; the button stays off until it has an answer.
 */
export function UndoPanel({
  review,
  intent,
  onHighlight,
  onOpenFile,
  onClosed,
}: {
  review: CheckpointReview;
  intent: UndoIntent;
  /** The user message of the task in view, outlined in the transcript; null when none is. */
  onHighlight: (messageId: number | null) => void;
  /** Opens a file's diff in the Changes panel. */
  onOpenFile?: (path: string, worktree: string) => void;
  /** The panel closed: the prompt takes the focus back. */
  onClosed: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const tasks = review.tasks;
  const preview = review.view === "preview" ? review.preview : null;
  // The list can shrink under the highlighted row (a restore just reloaded it).
  const current = Math.max(0, Math.min(active, tasks.length - 1));
  const shown = review.view === "list" ? tasks[current] : preview;
  const highlight = shown?.messageId ?? null;
  useEffect(() => onHighlight(highlight), [highlight, onHighlight]);
  useEffect(() => () => onHighlight(null), [onHighlight]);
  // The keys go to the panel each time it changes face, so Up, Down, Enter and Escape work at once.
  useEffect(
    () => panel.current?.focus({ preventScroll: true }),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refocus on the switch between list and preview.
    [review.view],
  );

  function close() {
    review.close();
    onClosed();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (review.view === "preview" && tasks.length && intent === "Undo") review.back();
      else close();
      return;
    }
    if (review.view !== "list" || !tasks.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : tasks.length - 1)) % tasks.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const task = tasks[current];
      if (task) void review.inspect(task.id);
    }
  }

  return (
    <div
      ref={panel}
      tabIndex={-1}
      data-undo-panel={review.view}
      role="group"
      aria-label={review.view === "list" ? "Undo a task's changes" : `${intent} changes`}
      onKeyDown={onKeyDown}
      className="promptbar-surface mb-1.5 flex max-h-[min(420px,55vh)] flex-col overflow-hidden rounded-[14px] border border-line-strong text-[13px] text-ink"
      style={{ animation: "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {review.view === "list" ? (
        <>
          <header className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5 text-[12px] text-ink-2">
            <Icon icon={Undo02Icon} size={14} />
            <span className="flex-1 font-medium">Undo a task's changes</span>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
              <ShortcutKeys shortcut="Enter" compact /> preview
              <ShortcutKeys shortcut="Esc" compact className="ml-1.5" /> close
            </span>
          </header>
          <ScrollArea as="ul" role="listbox" aria-label="Tasks" className="min-h-0 flex-1 px-1.5 pb-1.5">
            {review.pending && !tasks.length && <li className="px-2.5 py-2 text-ink-3">Loading…</li>}
            {!review.pending && !tasks.length && <li className="px-2.5 py-2 text-ink-3">No task has changed files yet.</li>}
            {tasks.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === current}>
                <button
                  type="button"
                  data-checkpoint-id={item.id}
                  disabled={review.pending}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => void review.inspect(item.id)}
                  className={`flex w-full items-center gap-4 rounded-[8px] px-2.5 py-2 text-left transition-colors ${index === current ? "bg-hover" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{checkpointTask(item)}</span>
                  <span className="shrink-0 text-[12px] text-ink-3">{checkpointMeta(item)}</span>
                </button>
              </li>
            ))}
          </ScrollArea>
        </>
      ) : (
        <>
          <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span className="text-ink-2">
              <Icon icon={intent === "Redo" ? Redo02Icon : Undo02Icon} size={15} />
            </span>
            <span className="shrink-0 font-medium text-ink-2">{intent} changes from</span>
            {preview && (
              <>
                {tasks.length > 0 && intent === "Undo" ? (
                  <button
                    type="button"
                    onClick={() => review.back()}
                    title="Choose another task"
                    className="flex min-w-0 items-center gap-1.5 rounded-[7px] bg-field px-2 py-1 font-medium hover:bg-hover"
                  >
                    <span className="truncate">{checkpointTask(preview)}</span>
                    <span className="shrink-0 text-ink-3">
                      <Icon icon={UnfoldMoreIcon} size={13} />
                    </span>
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-medium">{checkpointTask(preview)}</span>
                )}
                <span className="shrink-0 text-ink-3">{checkpointTime(preview.createdAt)}</span>
              </>
            )}
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              disabled={review.pending}
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-hover"
            >
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          </header>
          {review.notice && (
            <p role="status" className="border-b border-line px-3.5 py-2 text-[12px] text-orange">
              {review.notice}
            </p>
          )}
          {!preview ? (
            <p role="status" className="px-3.5 py-3 text-ink-3">
              {review.error ? "" : "Checking files…"}
            </p>
          ) : !preview.files.length ? (
            <p className="px-3.5 py-3 text-ink-3">These files are already as they were before the task.</p>
          ) : (
            <ScrollArea as="ul" aria-label="Files" className="min-h-0 flex-1 py-1">
              {preview.files.map((file) => (
                <FileRow
                  key={file.key}
                  file={file}
                  intent={intent}
                  decision={review.decisions[file.key]}
                  disabled={review.pending}
                  onChoose={(decision) => review.choose(file.key, decision)}
                  onOpen={onOpenFile ? () => onOpenFile(file.path, file.worktree) : undefined}
                />
              ))}
            </ScrollArea>
          )}
          <footer className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
            {review.error ? (
              <p role="alert" className="min-w-0 flex-1 text-[12px] text-red">
                {review.error}
              </p>
            ) : review.conflicts > 0 ? (
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-orange">
                <Icon icon={Alert02Icon} size={14} />
                {review.conflicts === 1 ? "1 file needs a choice" : `${review.conflicts} files need a choice`}
              </p>
            ) : (
              <p className="min-w-0 flex-1 text-[12px] text-ink-3">{preview?.files.length ? `You can ${intent === "Undo" ? "redo" : "undo"} this.` : ""}</p>
            )}
            <button type="button" onClick={close} disabled={review.pending} className="rounded-[8px] px-3 py-1.5 text-ink-2 hover:bg-hover disabled:opacity-40">
              Cancel
            </button>
            <button
              type="button"
              data-checkpoint-restore
              disabled={review.pending || !review.resolved || review.restoreCount === 0}
              onClick={() => void review.restore().then((result) => result && onClosed())}
              className="rounded-[8px] bg-ink px-3 py-1.5 font-medium text-surface transition-opacity hover:opacity-85 disabled:bg-field disabled:text-ink-3 disabled:opacity-100"
            >
              {restoreLabel(review, intent)}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

/** "Undo 3 files": every file until the conflicts are answered, then the ones that will change. */
function restoreLabel(review: CheckpointReview, intent: UndoIntent) {
  if (review.pending && review.preview) return "Working…";
  const count = review.resolved ? review.restoreCount : (review.preview?.files.length ?? 0);
  if (review.resolved && count === 0) return `Nothing to ${intent.toLowerCase()}`;
  return `${intent} ${count} ${count === 1 ? "file" : "files"}`;
}

function FileRow({
  file,
  intent,
  decision,
  disabled,
  onChoose,
  onOpen,
}: {
  file: CheckpointFile;
  intent: UndoIntent;
  decision: "keep" | "restore" | undefined;
  disabled: boolean;
  onChoose: (decision: "keep" | "restore") => void;
  onOpen?: () => void;
}) {
  const { name, dir } = splitCheckpointPath(file.path);
  const effect = intent === "Redo" && file.action === "replace" ? "Reapply" : checkpointEffect(file);
  return (
    <li
      data-checkpoint-file
      data-conflict={file.conflict || undefined}
      className={`flex min-h-10 items-center gap-2.5 px-3.5 py-1 ${file.conflict ? "bg-orange-tint" : ""}`}
    >
      <span className="shrink-0 text-ink-3">
        <Icon icon={FILE_ICONS[file.action]} size={15} />
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? "Show the diff" : file.path}
        className="flex min-w-0 items-baseline gap-2 text-left enabled:hover:underline"
      >
        <span className="truncate font-medium">{name}</span>
        {dir && <span className="truncate text-ink-3">{dir}</span>}
      </button>
      {file.conflict && (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-orange">
          <span className="size-1.5 rounded-full bg-orange" />
          Edited after this task
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {file.conflict ? (
          <span role="radiogroup" aria-label={`${name}: keep it or ${intent.toLowerCase()} it`} className="flex gap-0.5 rounded-[9px] bg-field p-0.5">
            {(["keep", "restore"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={decision === choice}
                data-checkpoint-choice={choice}
                disabled={disabled}
                onClick={() => onChoose(choice)}
                className={`rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors ${decision === choice ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink"}`}
              >
                {choice === "keep" ? "Keep current" : intent}
              </button>
            ))}
          </span>
        ) : (
          <span className="text-[12px] text-ink-2">{effect}</span>
        )}
        {onOpen && (
          <button
            type="button"
            aria-label={`Show the diff of ${file.path}`}
            onClick={onOpen}
            className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
          >
            <Icon icon={ArrowRight01Icon} size={14} />
          </button>
        )}
      </span>
    </li>
  );
}
