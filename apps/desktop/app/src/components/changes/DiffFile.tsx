import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import type { ThemedToken } from "shiki/core";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { DiffFileEntry } from "../../electron";
import { resolveCodeLanguage } from "../../lib/code-languages";
import { splitRows, wordChanges, type Range } from "../../lib/diff-layout";
import { extensionOf, locateComment, onSide, selectionFromRows, type DiffSide } from "../../lib/diff-comments";
import type { DiffHunk, DiffLine } from "../../lib/diff-parse";
import type { PullRequestThread } from "@milagre/shared/pull-request-review";
import { threadsOnLine, unplacedThreads } from "../../lib/pull-request-view";
import { highlight, isLanguageReady, loadLanguage } from "../markdown/highlighter";
import { Counts, StatusBox } from "./DiffIndicators";
import { CommentCard, CommentEditor, CommentSlot } from "./DiffComments";
import type { CommentActions, CommentView, Draft } from "./useDiffComments";
import { hunksOf, isLarge, type PatchState } from "./useDiffFiles";

export type DiffLayout = "unified" | "split";

type Decorated = { tokens?: ThemedToken[]; words?: Range[] };

/** Syntax tokens and changed-word ranges for every line of a file's hunks. */
function decorate(hunks: DiffHunk[], path: string, languageReady: boolean): Map<DiffLine, Decorated> {
  const result = new Map<DiffLine, Decorated>();
  const language = resolveCodeLanguage(extensionOf(path));
  for (const hunk of hunks) {
    if (language && languageReady) {
      // Each side is highlighted as the text it would be in its own file, so strings and comments tokenize across lines.
      for (const side of ["remove", "add"] as const) {
        const lines = hunk.lines.filter((line) => line.kind === "context" || line.kind === side);
        const tokens = highlight(lines.map((line) => line.text).join("\n"), language);
        if (tokens) lines.forEach((line, index) => result.set(line, { ...result.get(line), tokens: tokens[index] }));
      }
    }
    for (const { left, right } of splitRows(hunk)) {
      if (left?.kind !== "remove" || right?.kind !== "add") continue;
      const words = wordChanges(left.text, right.text);
      result.set(left, { ...result.get(left), words: words.old });
      result.set(right, { ...result.get(right), words: words.new });
    }
  }
  return result;
}

function Content({ line, decoration }: { line: DiffLine; decoration?: Decorated }) {
  const words = decoration?.words ?? [];
  const wordClass = line.kind === "add" ? "bg-[var(--diff-add-word)]" : "bg-[var(--diff-remove-word)]";
  const pieces: ReactNode[] = [];
  let offset = 0;
  const segments = decoration?.tokens?.length ? decoration.tokens : [{ content: line.text, htmlStyle: undefined } as ThemedToken];
  for (const token of segments) {
    const start = offset;
    const end = offset + token.content.length;
    offset = end;
    // Split the token at word-range edges so the highlight sits behind the syntax colour.
    const cuts = [start, ...words.flatMap(([from, to]) => [from, to]).filter((at) => at > start && at < end), end];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (from === undefined || to === undefined || from === to) continue;
      const changed = words.some(([a, b]) => from >= a && to <= b);
      pieces.push(
        <span
          key={`${start}-${from}`}
          className={`${decoration?.tokens ? "code-token" : ""} ${changed ? wordClass : ""}`}
          style={token.htmlStyle as CSSProperties | undefined}
        >
          {token.content.slice(from - start, to - start)}
        </span>,
      );
    }
  }
  return <>{pieces.length ? pieces : "​"}</>;
}

const TINT = { add: "bg-[var(--diff-add)]", remove: "bg-[var(--diff-remove)]", context: "" } as const;
const MARKER = { add: "+", remove: "−", context: "" } as const;
const MARKER_COLOR = { add: "text-diff-add", remove: "text-diff-remove", context: "" } as const;

function Gutter({ value }: { value?: number }) {
  return <span className="w-11 shrink-0 select-none pr-2 text-right text-ink-3 tabular-nums">{value}</span>;
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div data-diff-hunk className="h-6 select-none truncate bg-inset px-3 text-[11px] leading-6 text-ink-3">
      {hunk.header}
    </div>
  );
}

function Text({ line, decoration, wrap }: { line: DiffLine; decoration?: Decorated; wrap: boolean }) {
  return (
    <span className={`min-w-0 flex-1 pr-3 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
      <Content line={line} decoration={decoration} />
    </span>
  );
}

/** What the rows need to take part in commenting: which are selected, what goes under them, and the handlers. */
type Commenting = {
  path: string;
  selected: (hunk: number, line: number, side?: DiffSide) => boolean;
  slot: (hunk: number, line: number) => ReactNode;
  actions: CommentActions;
  /** A PR's review threads on a line, under it. */
  threads: (line: DiffLine) => ReactNode;
};

function AddButton({ commenting, hunk, line, side }: { commenting: Commenting; hunk: number; line: number; side?: DiffSide }) {
  const target = { path: commenting.path, hunk, line, side };
  return (
    // Mouse-down starts the range so the drag can follow; a keyboard activation (detail 0) is a plain one-line pick.
    <button
      type="button"
      aria-label="Comment on this line"
      data-diff-add
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        commenting.actions.start(target, event.shiftKey, true);
      }}
      onClick={(event) => {
        if (event.detail === 0) commenting.actions.start(target, event.shiftKey, false);
      }}
      className="absolute top-0.5 left-1 flex size-4 items-center justify-center rounded-chip bg-ink text-surface opacity-0 before:absolute before:-inset-x-1 before:-inset-y-0.5 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
    >
      <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2.4} color="currentColor" />
    </button>
  );
}

// A neutral wash under the text (rows are isolated, so -z-10 sits above the row's tint but below its text) and a
// black bar on the left edge, as GitHub marks selected lines.
const Selected = () => (
  <>
    <span aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-ink/[0.07]" />
    <span aria-hidden data-diff-selected-bar className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-ink" />
  </>
);

function Unified({
  hunks,
  decorations,
  wrap,
  commenting,
}: {
  hunks: DiffHunk[];
  decorations: Map<DiffLine, Decorated>;
  wrap: boolean;
  commenting?: Commenting;
}) {
  return (
    <div className="w-max min-w-full">
      {hunks.map((hunk, index) => (
        <Fragment key={index}>
          <HunkHeader hunk={hunk} />
          {hunk.lines.map((line, lineIndex) => {
            const selected = commenting?.selected(index, lineIndex);
            return (
              <Fragment key={lineIndex}>
                <div
                  data-diff-row={line.kind}
                  data-selected={selected ? "" : undefined}
                  onMouseOver={() => commenting?.actions.over({ path: commenting.path, hunk: index, line: lineIndex })}
                  className={`group/row relative isolate flex min-h-5 ${TINT[line.kind]}`}
                >
                  <Gutter value={line.oldNumber} />
                  <Gutter value={line.newNumber} />
                  <span className={`w-4 shrink-0 select-none text-center ${MARKER_COLOR[line.kind]}`}>{MARKER[line.kind]}</span>
                  <Text line={line} decoration={decorations.get(line)} wrap={wrap} />
                  {commenting && <AddButton commenting={commenting} hunk={index} line={lineIndex} />}
                  {selected && <Selected />}
                </div>
                {commenting?.threads(line)}
                {commenting?.slot(index, lineIndex)}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function Half({
  line,
  side,
  decoration,
  commenting,
  hunk,
  index,
}: {
  line?: DiffLine;
  side: "left" | "right";
  decoration?: Decorated;
  commenting?: Commenting;
  hunk: number;
  index: number;
}) {
  const border = side === "left" ? "border-r border-line" : "";
  if (!line) return <div data-diff-filler className={`min-h-5 bg-inset ${border}`} />;
  const column = side === "left" ? "old" : "new";
  const selected = commenting?.selected(hunk, index, column);
  return (
    <div
      data-diff-cell={side}
      data-selected={selected ? "" : undefined}
      onMouseOver={() => commenting?.actions.over({ path: commenting.path, hunk, line: index, side: column })}
      className={`group/row relative isolate flex min-h-5 min-w-0 ${TINT[line.kind]} ${border}`}
    >
      <Gutter value={side === "left" ? line.oldNumber : line.newNumber} />
      <span className={`w-4 shrink-0 select-none text-center ${MARKER_COLOR[line.kind]}`}>{MARKER[line.kind]}</span>
      <Text line={line} decoration={decoration} wrap />
      {commenting && <AddButton commenting={commenting} hunk={hunk} line={index} side={column} />}
      {selected && <Selected />}
    </div>
  );
}

function Split({ hunks, decorations, commenting }: { hunks: DiffHunk[]; decorations: Map<DiffLine, Decorated>; commenting?: Commenting }) {
  return (
    // Two equal columns that always wrap: sized to the longest line, a narrow window pushed the new side off screen.
    <div className="grid w-full grid-cols-2">
      {hunks.map((hunk, index) => {
        const indexes = new Map(hunk.lines.map((line, lineIndex) => [line, lineIndex]));
        return (
          <Fragment key={index}>
            <div className="col-span-2">
              <HunkHeader hunk={hunk} />
            </div>
            {splitRows(hunk).map((row, rowIndex) => {
              const left = row.left && indexes.get(row.left);
              const right = row.right && indexes.get(row.right);
              const slots = [left, right !== left ? right : undefined].map((line) => (line === undefined ? null : commenting?.slot(index, line)));
              // A context row is the same line in both halves: its threads come once.
              const threads = [row.left, row.right !== row.left ? row.right : undefined].map((line) => (line ? commenting?.threads(line) : null));
              return (
                <Fragment key={rowIndex}>
                  <Half line={row.left} side="left" decoration={row.left && decorations.get(row.left)} commenting={commenting} hunk={index} index={left ?? 0} />
                  <Half
                    line={row.right}
                    side="right"
                    decoration={row.right && decorations.get(row.right)}
                    commenting={commenting}
                    hunk={index}
                    index={right ?? 0}
                  />
                  {threads.map(
                    (thread, at) =>
                      thread && (
                        <div key={`thread-${at}`} className="col-span-2">
                          {thread}
                        </div>
                      ),
                  )}
                  {/* A context row is one line in both halves; its slot comes once. */}
                  {slots.map(
                    (slot, at) =>
                      slot && (
                        <div key={at} className="col-span-2">
                          {slot}
                        </div>
                      ),
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

function Message({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-3 px-4 py-6 font-sans text-[12px] text-ink-3">
      {children}
      {action}
    </div>
  );
}

const NO_COMMENTS: CommentView[] = [];
type CommentProps =
  | { readOnly: true; comments?: never; draft?: never; draftText?: never; actions?: never }
  | { readOnly?: false; comments: CommentView[]; draft: Draft | null; draftText: MutableRefObject<string>; actions: CommentActions };

export const DiffFile = memo(function DiffFile({
  file,
  patch,
  layout,
  wrap,
  comments = NO_COMMENTS,
  draft = null,
  draftText,
  actions,
  collapsed,
  onToggle,
  onVisible,
  onShowLarge,
  threads,
  renderThreads,
}: {
  file: DiffFileEntry;
  patch: PatchState | undefined;
  layout: DiffLayout;
  wrap: boolean;
  collapsed: boolean;
  onToggle: (path: string) => void;
  onVisible: (file: DiffFileEntry) => void;
  onShowLarge: (file: DiffFileEntry) => void;
  /** A PR's review threads on this file, drawn by `renderThreads` (stable) under their lines. */
  threads?: PullRequestThread[];
  renderThreads?: (threads: PullRequestThread[]) => ReactNode;
} & CommentProps) {
  const ref = useRef<HTMLElement>(null);
  const [, setLoadedCount] = useState(0);
  const language = resolveCodeLanguage(extensionOf(file.path));
  const languageReady = language !== undefined && isLanguageReady(language);
  const ready = patch?.status === "ready" ? patch : undefined;
  const hunks = useMemo(() => hunksOf(ready), [ready]);

  // Files load when they come near the viewport, not all at once on open. Staying near while the
  // patch goes missing (the mode changed under a mounted file) loads it again.
  const [near, setNear] = useState(false);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (near && !patch) onVisibleRef.current(file);
  }, [near, patch, file]);

  useEffect(() => {
    if (!language || languageReady || hunks.length === 0) return;
    let live = true;
    loadLanguage(language).then(
      () => {
        if (live) setLoadedCount((count) => count + 1);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [language, languageReady, hunks.length]);

  const decorations = useMemo(() => decorate(hunks, file.path, languageReady), [hunks, file.path, languageReady]);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash >= 0 ? file.path.slice(0, slash) : "";

  // Each comment sits under its last row; the ones whose rows are gone collect below the hunks.
  const { placed, stale } = useMemo(() => {
    const placed = new Map<string, CommentView[]>();
    const stale: CommentView[] = [];
    for (const comment of comments) {
      const found = comment.outdated ? undefined : locateComment(comment, hunks);
      if (!found) {
        stale.push(comment);
        continue;
      }
      const key = `${found.hunk}:${found.lines[found.lines.length - 1]}`;
      placed.set(key, [...(placed.get(key) ?? []), comment]);
    }
    return { placed, stale };
  }, [comments, hunks]);

  const hunk = draft ? hunks[draft.hunk] : undefined;
  const lo = draft ? Math.min(draft.anchor, draft.head) : 0;
  const hi = draft ? Math.max(draft.anchor, draft.head) : 0;
  // The editor goes under the last row of the range that is shown on the selected side.
  let editorAt: string | undefined;
  if (draft && hunk && !draft.dragging) {
    for (let index = hi; index >= lo; index--) {
      const line = hunk.lines[index];
      if (line && (!draft.side || onSide(line, draft.side))) {
        editorAt = `${draft.hunk}:${index}`;
        break;
      }
    }
  }
  const lines = useMemo(() => hunks.flatMap((hunk) => hunk.lines), [hunks]);
  const looseThreads = useMemo(() => (threads?.length && hunks.length ? unplacedThreads(threads, lines) : []), [threads, lines, hunks.length]);
  const commenting: Commenting | undefined =
    actions && draftText
      ? {
          path: file.path,
          actions,
          // oxlint-disable-next-line react/no-unstable-nested-components -- render callback for the rows, not a component
          threads: (line) => {
            if (!threads?.length || !renderThreads) return null;
            const found = threadsOnLine(threads, line);
            return found.length ? <CommentSlot>{renderThreads(found)}</CommentSlot> : null;
          },
          selected: (h, line, side) => draft !== null && draft.hunk === h && line >= lo && line <= hi && draft.side === side,
          // oxlint-disable-next-line react/no-unstable-nested-components -- slot is a render callback invoked by the diff library, not a component
          slot: (h, line) => {
            const key = `${h}:${line}`;
            const cards = (placed.get(key) ?? []).filter((comment) => comment.id !== draft?.editing);
            const editing = editorAt === key && draft;
            if (!cards.length && !editing) return null;
            return (
              <CommentSlot>
                {cards.map((comment) => (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    onDelete={() => actions.remove(comment.id)}
                    onEdit={() => {
                      const found = locateComment(comment, hunks);
                      if (found) actions.edit(comment, found.hunk, found.lines, layout === "split" ? comment.side : undefined);
                    }}
                  />
                ))}
                {editing && (
                  <CommentEditor
                    text={draftText}
                    onCancel={actions.cancel}
                    onSave={(text) => {
                      const target = hunks[editing.hunk];
                      if (target) actions.save(selectionFromRows(target, editing.anchor, editing.head, editing.side), file.path, text, editing.editing);
                    }}
                    onAddToReview={
                      actions.addToReview && !editing.editing
                        ? (text) => {
                            const target = hunks[editing.hunk];
                            const selection = target && selectionFromRows(target, editing.anchor, editing.head, editing.side);
                            if (selection) actions.addToReview?.(selection, file.path, text);
                          }
                        : undefined
                    }
                  />
                )}
              </CommentSlot>
            );
          },
        }
      : undefined;

  let body: ReactNode;
  if (file.binary) body = <Message>Binary file</Message>;
  else if (!patch && isLarge(file))
    body = (
      <Message
        action={
          <button
            type="button"
            data-diff-show
            onClick={() => onShowLarge(file)}
            className="rounded-control border border-line px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-hover"
          >
            Show diff
          </button>
        }
      >
        This diff is large
      </Message>
    );
  else if (!patch || patch.status === "loading") body = <Message>Loading…</Message>;
  else if (patch.status === "error") body = <Message>{patch.message}</Message>;
  else if (patch.binary) body = <Message>Binary file</Message>;
  else if (patch.tooLarge) body = <Message>This file's diff is too large to show</Message>;
  else if (hunks.length === 0) body = <Message>{file.status === "renamed" ? `Renamed from ${file.oldPath}` : "No content changes"}</Message>;
  else
    body = (
      <>
        {layout === "split" ? (
          <Split hunks={hunks} decorations={decorations} commenting={commenting} />
        ) : (
          <Unified hunks={hunks} decorations={decorations} wrap={wrap} commenting={commenting} />
        )}
        {stale.length > 0 && (
          <CommentSlot>
            {stale.map((comment) => (
              <CommentCard key={comment.id} comment={comment} onDelete={() => actions?.remove(comment.id)} />
            ))}
          </CommentSlot>
        )}
        {looseThreads.length > 0 && renderThreads && <CommentSlot>{renderThreads(looseThreads)}</CommentSlot>}
      </>
    );

  return (
    <section ref={ref} data-diff-file={file.path} className="rounded-card border border-line bg-surface">
      {/* Pinned, the header is the card's top: it draws its own border over the card's (-1px), and the page colour
          fills behind its rounded corners so rows scrolling underneath don't show through them. The fill sits in a
          wrapper, under the header; inside the header it would paint over the header's own background and border. */}
      <div className={`sticky top-0 z-10 -mx-px -mt-px ${collapsed ? "-mb-px" : ""}`}>
        <span aria-hidden className="absolute inset-x-0 top-0 h-[var(--radius-card)] bg-page" />
        <header
          className={`relative flex h-9 items-center gap-2 border border-line bg-surface px-3 text-[12.5px] ${collapsed ? "rounded-card" : "rounded-t-card"}`}
        >
          <button
            type="button"
            aria-label={collapsed ? "Expand file" : "Collapse file"}
            aria-expanded={!collapsed}
            data-diff-collapse
            onClick={() => onToggle(file.path)}
            className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 hover:bg-hover hover:text-ink"
          >
            <HugeiconsIcon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={14} strokeWidth={1.8} color="currentColor" />
          </button>
          <span className="shrink-0 font-medium text-ink">{name}</span>
          {folder && (
            <span className="min-w-0 flex-1 truncate text-ink-3" dir="rtl">
              <bdi>{folder}</bdi>
            </span>
          )}
          {!folder && <span className="flex-1" />}
          {!file.binary && <Counts added={file.added} removed={file.removed} />}
          <StatusBox status={file.status} />
        </header>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto rounded-b-card font-mono text-[length:var(--code-size)] leading-5 [container-type:inline-size]" data-diff-body>
          {body}
        </div>
      )}
    </section>
  );
});
