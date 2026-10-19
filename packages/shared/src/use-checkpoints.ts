import { useCallback, useEffect, useRef, useState } from "react";
import {
  undoableTasks,
  type Checkpoint,
  type CheckpointApi,
  type CheckpointDecision,
  type CheckpointPreview,
  type CheckpointRestoreResult,
} from "./checkpoints";

export type CheckpointView = "closed" | "list" | "preview";

/**
 * Undo changes, shared by desktop and phone: the list of tasks, then a task's preview, then the restore.
 * Files edited after the task need a choice; every other file is undone unless the preview is cancelled.
 * A preview gone stale is fetched again before anything is written. Mount with a key for the Chat.
 */
export function useCheckpoints(api: CheckpointApi, chatId: string) {
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [view, setView] = useState<CheckpointView>("closed");
  const [preview, setPreview] = useState<CheckpointPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, CheckpointDecision>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      acting.current = false;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- invalidate in-flight work when the connection or Chat changes.
    [api, chatId],
  );
  // Another Chat starts from nothing: its checkpoints, closed.
  useEffect(
    () => {
      // oxlint-disable-next-line react/set-state-in-effect -- the state belongs to the connection and Chat that just changed.
      setItems([]);
      setView("closed");
      setPreview(null);
      setDecisions({});
      setError("");
      setNotice("");
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reset when the connection or Chat changes.
    [api, chatId],
  );
  async function run<T>(work: () => Promise<T>, apply: (result: T) => void) {
    if (acting.current) return;
    acting.current = true;
    const current = generation.current;
    setPending(true);
    setError("");
    try {
      const result = await work();
      if (generation.current === current) apply(result);
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation.current === current) {
        acting.current = false;
        setPending(false);
      }
    }
  }
  /** The Chat's checkpoints, quietly: the transcript's undo buttons follow them. */
  const reload = useCallback(async () => {
    const current = generation.current;
    try {
      const result = await api.list({ chatId });
      if (generation.current === current) setItems(result);
    } catch {
      // The panel shows list errors when it opens; the quiet refresh keeps the last list.
    }
  }, [api, chatId]);
  function show(next: CheckpointPreview) {
    setPreview(next);
    setDecisions(Object.fromEntries(next.files.filter((file) => !file.conflict).map((file) => [file.key, "restore" as const])));
    setView("preview");
  }
  function open() {
    setView("list");
    setPreview(null);
    setNotice("");
    return run(() => api.list({ chatId }), setItems);
  }
  function inspect(id: string) {
    setNotice("");
    if (preview?.id !== id) setPreview(null);
    setView("preview");
    return run(() => api.preview({ chatId, id }), show);
  }
  function close() {
    if (acting.current) return;
    setView("closed");
    setPreview(null);
    setDecisions({});
    setError("");
    setNotice("");
  }
  function back() {
    if (acting.current) return;
    setPreview(null);
    setError("");
    setNotice("");
    setView("list");
  }
  /** Writes the files; resolves with what was restored, or null when it didn't (the error says why). */
  async function restore(): Promise<CheckpointRestoreResult | null> {
    if (!preview) return null;
    const id = preview.id;
    const outcome: { result: CheckpointRestoreResult | null; stale: boolean } = { result: null, stale: false };
    await run(
      async () => {
        try {
          return await api.restore({ chatId, token: preview.token, decisions, approved: true });
        } catch (failure) {
          // Files changed since the preview: show the new state instead of writing over it.
          if (failure instanceof Error && /preview again/i.test(failure.message)) {
            outcome.stale = true;
            return null;
          }
          throw failure;
        }
      },
      (result) => {
        if (!result) return;
        outcome.result = result;
        setView("closed");
        setPreview(null);
        setDecisions({});
      },
    );
    if (outcome.stale) {
      await inspect(id);
      setNotice("Files changed. Review again.");
    } else if (outcome.result) void reload();
    return outcome.result;
  }
  const conflicts = preview?.files.filter((file) => file.conflict && !decisions[file.key]).length ?? 0;
  const restoreCount = preview?.files.filter((file) => decisions[file.key] === "restore").length ?? 0;
  return {
    items,
    tasks: undoableTasks(items),
    view,
    preview,
    decisions,
    pending,
    error,
    notice,
    reload,
    open,
    inspect,
    back,
    close,
    restore,
    /** Conflicts still waiting for Keep current or Undo. */
    conflicts,
    restoreCount,
    resolved: !!preview && conflicts === 0,
    choose: (key: string, decision: CheckpointDecision) => setDecisions((current) => ({ ...current, [key]: decision })),
  };
}
