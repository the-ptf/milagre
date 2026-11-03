import { ipcErrorMessage } from "./result.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
export type EditScopeRule = { root: string; path: string };
export type EditScopePolicy = { allowed: EditScopeRule[]; protected: EditScopeRule[] };
export type EditScopeView = {
  revision: number;
  policy: EditScopePolicy | null;
  roots: string[];
  busy: boolean;
  limits: string;
  capability: string;
  pending?: { id: string; policy: EditScopePolicy; reason: string; revision: number };
  queuedPolicy?: EditScopePolicy;
  warnings: { kind: "outside" | "incomplete"; message: string; root?: string; path?: string; at: number }[];
  lastChecked?: number;
  monitoring?: boolean;
};
export type EditScopeApi = {
  read(request: { chatId: string }): Promise<EditScopeView>;
  save(request: { chatId: string; revision: number; policy: EditScopePolicy | null }): Promise<EditScopeView>;
  resolve(request: { chatId: string; id: string; approved: boolean }): Promise<EditScopeView>;
};
export const scopePaths = (policy: EditScopePolicy | null, root: string, kind: "allowed" | "protected") =>
  policy?.[kind]
    .filter((rule) => rule.root === root)
    .map((rule) => rule.path)
    .join("\n") ?? "";
export function scopePolicy(roots: string[], fields: Record<string, { allowed: string; protected: string }>): EditScopePolicy {
  const rules = (kind: "allowed" | "protected") =>
    roots.flatMap((root) =>
      (fields[root]?.[kind] ?? "")
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ root, path: name })),
    );
  return { allowed: rules("allowed"), protected: rules("protected") };
}
export const scopeSummary = (view: EditScopeView | null) =>
  view?.pending ? "Scope request" : view?.warnings.length ? "Scope warning" : view?.policy ? "Edit scope active" : "Edit scope";
/** One refresh loop per visible Chat; stale responses from a replaced connection cannot change its controls. */
export function useEditScope(api: EditScopeApi, chatId: string, visible = true) {
  const [view, setView] = useState<EditScopeView | null>(null),
    [readError, setReadError] = useState(""),
    [actionError, setActionError] = useState(""),
    [pending, setPending] = useState(false);
  const generation = useRef(0),
    reading = useRef(0),
    acting = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    // oxlint-disable-next-line react/set-state-in-effect -- policy belongs to this connection; never retain another host's policy.
    setView(null);
    setReadError("");
    setActionError("");
    setPending(false);
    acting.current = false;
    if (!visible) return;
    let flight = false;
    const read = async () => {
      if (flight || acting.current) return;
      flight = true;
      const readId = ++reading.current;
      try {
        const result = await api.read({ chatId });
        if (current === generation.current && readId === reading.current) {
          setView(result);
          setReadError("");
        }
      } catch (failure) {
        if (current === generation.current && readId === reading.current) setReadError(ipcErrorMessage(failure));
      } finally {
        flight = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      generation.current = current + 1;
      clearInterval(timer);
    };
  }, [api, chatId, visible]);
  const run = useCallback(async (operation: () => Promise<EditScopeView>) => {
    if (acting.current) return;
    const current = generation.current;
    ++reading.current;
    acting.current = true;
    setPending(true);
    setActionError("");
    try {
      const next = await operation();
      if (current === generation.current) setView(next);
    } catch (failure) {
      if (current === generation.current) setActionError(ipcErrorMessage(failure));
    } finally {
      if (current === generation.current) {
        acting.current = false;
        setPending(false);
      }
    }
  }, []);
  return {
    view,
    error: actionError || readError,
    pending,
    save: (policy: EditScopePolicy | null) => view && run(() => api.save({ chatId, revision: view.revision, policy })),
    resolve: (approved: boolean) => view?.pending && run(() => api.resolve({ chatId, id: view.pending!.id, approved })),
  };
}
