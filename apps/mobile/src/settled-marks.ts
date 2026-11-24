import { useMemo, useState, useSyncExternalStore } from "react";
import type { DoneMark } from "./navigation-build";

const HOLD_MS = 15_000;
let marks: ReadonlyMap<string, DoneMark> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const set = (next: ReadonlyMap<string, DoneMark>) => {
  marks = next;
  listeners.forEach((listener) => listener());
};

/** A Chat settled from inside it shows as Done in the list at once, before the host's next state arrives. */
export function markSettled(hostId: string, projectPath: string, chatId: number, doneAt: number | null) {
  const key = `${hostId}|${projectPath}#${chatId}`;
  const mark = { doneAt };
  set(new Map(marks).set(key, mark));
  setTimeout(() => {
    if (marks.get(key) !== mark) return;
    const next = new Map(marks);
    next.delete(key);
    set(next);
  }, HOLD_MS);
}

/** The list's own Done marks, with the ones settled from inside a Chat layered under them. */
export function useDoneMarks() {
  const [own, setOwn] = useState<ReadonlyMap<string, DoneMark>>(() => new Map());
  const settled = useSyncExternalStore(subscribe, () => marks);
  const merged = useMemo(() => (settled.size ? new Map([...settled, ...own]) : own), [settled, own]);
  return [merged, setOwn] as const;
}
