export type ToastKind = "done" | "deleted" | "undone";

export type UndoAction = {
  text: string;
  kind?: ToastKind;
  /** Takes it back. Returning false means it can't be any more (the deletion went ahead), and the toast says so. */
  undo: () => unknown;
  /** What the toast says once it is undone; "Undone" when not given. */
  undoneText?: string;
  /** The undone toast's icon; the undo arrow when not given. */
  undoneKind?: ToastKind;
  /** Does it again after an undo. Without one, an undo is the end of it and ⇧⌘Z skips it. */
  redo?: () => unknown;
  /** How long the undo keeps working after the action (a deletion's Undo window); forever when not given. */
  undoWindowMs?: number;
  place?: string;
};

export type UndoToast = {
  id: number;
  text: string;
  kind?: ToastKind;
  button: "undo" | "redo" | null;
  place?: string;
};

type Entry = { action: UndoAction; until: number };

const LIMIT = 50;

export function createUndoHistory(now: () => number = Date.now) {
  let past: Entry[] = [];
  let future: UndoAction[] = [];
  let toast: UndoToast | null = null;
  let shown: UndoAction | null = null;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const show = (next: Omit<UndoToast, "id"> | null, action: UndoAction | null = null) => {
    shown = action;
    toast = next && { ...next, id: nextId++ };
    if (toast?.place === undefined) delete toast?.place;
    emit();
  };
  const entry = (action: UndoAction): Entry => ({ action, until: action.undoWindowMs === undefined ? Infinity : now() + action.undoWindowMs });
  const live = () => {
    while (past.length && past[past.length - 1]!.until <= now()) past.pop();
    return past.at(-1);
  };

  return {
    /** Records an action just taken and shows its toast with Undo. A new action ends whatever could be redone. */
    record(action: UndoAction) {
      past = [...past, entry(action)].slice(-LIMIT);
      future = [];
      show({ text: action.text, kind: action.kind, button: "undo", place: action.place }, action);
    },
    drop(action: UndoAction) {
      past = past.filter((item) => item.action !== action);
      future = future.filter((item) => item !== action);
      if (shown === action) show(null);
    },
    notify(text: string, place?: string) {
      show({ text, button: null, place });
    },
    /** Undoes the latest action; false when there is nothing left to undo. */
    undo() {
      const top = live();
      if (!top) return false;
      past = past.slice(0, -1);
      if (top.action.undo() === false) {
        show({ text: "Too late to undo that", button: null, place: top.action.place });
        return true;
      }
      if (top.action.redo) future = [...future, top.action];
      show(
        {
          text: top.action.undoneText ?? "Undone",
          kind: top.action.undoneKind ?? "undone",
          button: top.action.redo ? "redo" : null,
          place: top.action.place,
        },
        top.action,
      );
      return true;
    },
    /** Does the last undone action again; false when nothing was undone. */
    redo() {
      const action = future[future.length - 1];
      if (!action?.redo) return false;
      future = future.slice(0, -1);
      action.redo();
      past = [...past, entry(action)].slice(-LIMIT);
      show({ text: action.text, kind: action.kind, button: "undo", place: action.place }, action);
      return true;
    },
    canUndo: () => !!live(),
    canRedo: () => future.length > 0,
    dismiss(id: number) {
      if (toast?.id === id) show(null);
    },
    toast: () => toast,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type UndoHistory = ReturnType<typeof createUndoHistory>;

export const undoHistory = createUndoHistory();
