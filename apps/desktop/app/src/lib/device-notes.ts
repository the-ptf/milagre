import { useCallback, useEffect, useRef, useState } from "react";

type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };

/** Settings > Experimental's "Device notes": this Mac's own switch, kept by its daemon, off until turned on. */
export function useDeviceNotesEnabled() {
  // A test bridge may not offer it: the row stays hidden.
  const available = typeof window.milagre.readDeviceNotesEnabled === "function";
  const [state, setState] = useState<State>({ enabled: false, ready: false, saving: false, error: "" });
  const scopeRef = useRef<{ saving: boolean; revision: number } | null>(null);
  useEffect(() => {
    if (!available) return;
    const scope = { saving: false, revision: 0 };
    scopeRef.current = scope;
    const revision = scope.revision;
    const currentRead = () => scopeRef.current === scope && scope.revision === revision;
    const read = async () => {
      try {
        const value = await window.milagre.readDeviceNotesEnabled();
        if (currentRead()) setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true }));
      } catch {
        if (currentRead()) setState((current) => ({ ...current, ready: true, error: "Could not read this setting." }));
      }
    };
    void read();
    const off = window.milagre.onDeviceNotesEnabledChanged((value) => {
      if (scopeRef.current !== scope) return;
      ++scope.revision;
      setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true, error: "" }));
    });
    return () => {
      scopeRef.current = null;
      off();
    };
  }, [available]);
  const save = useCallback(async (enabled: boolean) => {
    const scope = scopeRef.current;
    if (!scope || scope.saving) return;
    scope.saving = true;
    ++scope.revision;
    setState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const result = await window.milagre.saveDeviceNotesEnabled(enabled);
      if (scopeRef.current === scope) setState((current) => ({ ...current, enabled: result.enabled === true }));
    } catch (cause) {
      if (scopeRef.current === scope) setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Could not change this setting." }));
    } finally {
      if (scopeRef.current === scope) {
        scope.saving = false;
        setState((current) => ({ ...current, saving: false }));
      }
    }
  }, []);
  return { ...state, available, save };
}
