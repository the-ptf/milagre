import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isOutdated, type DiffComment, type DiffSelection, type DiffSide } from "../../lib/diff-comments";
import type { ChangesMode } from "../../lib/pull-request-view";
import type { CommentCounts } from "./ChangesPanel";
import type { Changes } from "./useChanges";
import { hunksOf } from "./useDiffFiles";

export type CommentView = DiffComment & { outdated: boolean };

const keyFor = (chatKey: string) => `milagre:diff-comments:${chatKey}`;

function read(chatKey: string | null): DiffComment[] {
  if (!chatKey) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(chatKey)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && Array.isArray(item.snippet)) : [];
  } catch {
    return [];
  }
}

function write(chatKey: string | null, comments: DiffComment[]) {
  if (!chatKey) return;
  if (comments.length) localStorage.setItem(keyFor(chatKey), JSON.stringify(comments));
  else localStorage.removeItem(keyFor(chatKey));
}

// One view object per comment and outdated flag, so a file whose comments didn't change keeps its props.
const views = new WeakMap<DiffComment, [CommentView?, CommentView?]>();
function viewOf(comment: DiffComment, outdated: boolean): CommentView {
  const pair = views.get(comment) ?? [];
  const slot = outdated ? 1 : 0;
  pair[slot] ??= { ...comment, outdated };
  views.set(comment, pair);
  return pair[slot]!;
}

export type CommentStore = ReturnType<typeof useDiffComments>;

const modeOf = (comment: DiffComment): ChangesMode => comment.mode ?? "uncommitted";

/**
 * The chat's diff comments, kept in localStorage per chat. Each belongs to the diff it was written on; the shown
 * diff's comments are judged outdated against it: their file is gone from the list, or their rows read differently now.
 */
export function useDiffComments(chatKey: string | null, changes: Changes) {
  const [store, setStore] = useState(() => ({ key: chatKey, comments: read(chatKey) }));
  if (store.key !== chatKey) setStore({ key: chatKey, comments: read(chatKey) });
  const comments = store.key === chatKey ? store.comments : [];

  const change = useCallback((next: (comments: DiffComment[]) => DiffComment[]) => {
    setStore((previous) => {
      const comments = next(previous.comments);
      write(previous.key, comments);
      return { key: previous.key, comments };
    });
  }, []);
  const { list, patchFor, load, diffOpen, mode } = changes;
  const add = useCallback(
    (comment: Omit<DiffComment, "id" | "createdAt" | "mode">) =>
      change((all) => [...all, { ...comment, mode, id: crypto.randomUUID(), createdAt: Date.now() }]),
    [change, mode],
  );
  const update = useCallback(
    (id: string, body: string) => change((all) => all.map((comment) => (comment.id === id ? { ...comment, body } : comment))),
    [change],
  );
  const remove = useCallback((id: string) => change((all) => all.filter((comment) => comment.id !== id)), [change]);
  const removeMany = useCallback((ids: string[]) => change((all) => all.filter((comment) => !ids.includes(comment.id))), [change]);

  const files = list.state === "ready" && list.isRepo ? list.files : undefined;
  const shown = comments.filter((comment) => modeOf(comment) === mode);

  // Commented files need their patch to be judged, even when they're far from the viewport.
  useEffect(() => {
    if (!diffOpen || !files) return;
    for (const path of new Set(shown.map((comment) => comment.path))) {
      const file = files.find((entry) => entry.path === path);
      if (file && !patchFor(file)) load(file);
    }
  });

  const current = shown.map((comment): CommentView => {
    let outdated = false;
    if (files) {
      const file = files.find((entry) => entry.path === comment.path);
      const patch = file && patchFor(file);
      if (!file) outdated = true;
      else if (patch?.status === "ready") outdated = isOutdated(comment, hunksOf(patch));
    }
    return viewOf(comment, outdated);
  });
  // Stable until a comment or an outdated flag changes.
  const stable = useRef<CommentView[]>([]);
  if (stable.current.length !== current.length || stable.current.some((view, index) => view !== current[index])) stable.current = current;
  const all = stable.current;

  // Every section's, for the Changes tab.
  const counts = useMemo(() => {
    const result: CommentCounts = {};
    for (const comment of comments) {
      const paths = (result[modeOf(comment)] ??= {});
      paths[comment.path] = (paths[comment.path] ?? 0) + 1;
    }
    return result;
  }, [comments]);
  const sendable = useMemo(() => all.filter((comment) => !comment.outdated), [all]);

  return { comments: all, sendable, counts, add, update, remove, removeMany };
}

/** The rows being selected for a new comment, or the ones of a comment being edited; `side` is only set in split. */
export type Draft = { path: string; hunk: number; side?: DiffSide; anchor: number; head: number; dragging: boolean; editing?: string };

type Target = { path: string; hunk: number; line: number; side?: DiffSide };

/** Selection and editor state for the diff view. It lives apart from the store so dragging doesn't re-render the app. */
export function useCommentDraft() {
  const [draft, setDraft] = useState<Draft | null>(null);
  // The editor's text outlives its mount, so extending the range (which moves the editor) keeps what was typed.
  const text = useRef("");
  const dragging = draft?.dragging ?? false;

  useEffect(() => {
    if (!dragging) return;
    const finish = () => setDraft((current) => (current ? { ...current, dragging: false } : current));
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [dragging]);

  const start = useCallback(({ path, hunk, line, side }: Target, extend: boolean, drag: boolean) => {
    setDraft((current) => {
      if (extend && current && !current.editing && current.path === path && current.hunk === hunk && current.side === side)
        return { ...current, head: line, dragging: false };
      text.current = "";
      return { path, hunk, side, anchor: line, head: line, dragging: drag };
    });
  }, []);
  const over = useCallback(({ path, hunk, line, side }: Target) => {
    setDraft((current) =>
      current?.dragging && current.path === path && current.hunk === hunk && current.side === side && current.head !== line
        ? { ...current, head: line }
        : current,
    );
  }, []);
  const edit = useCallback((comment: DiffComment, hunk: number, lines: number[], side: DiffSide | undefined) => {
    const anchor = lines[0];
    const head = lines.at(-1);
    if (anchor === undefined || head === undefined) return;
    text.current = comment.body;
    setDraft({ path: comment.path, hunk, side, anchor, head, dragging: false, editing: comment.id });
  }, []);
  const cancel = useCallback(() => {
    text.current = "";
    setDraft(null);
  }, []);

  return { draft, text, start, over, edit, cancel };
}

export type CommentActions = {
  start: (target: Target, extend: boolean, drag: boolean) => void;
  over: (target: Target) => void;
  edit: (comment: DiffComment, hunk: number, lines: number[], side: DiffSide | undefined) => void;
  cancel: () => void;
  save: (selection: DiffSelection | undefined, path: string, body: string, editing: string | undefined) => void;
  remove: (id: string) => void;
  /** On a PR's diff: the comment goes to the viewer's pending review on GitHub instead of the Chat. */
  addToReview?: (selection: DiffSelection, path: string, body: string) => void;
};
