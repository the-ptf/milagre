import { useCallback, useEffect, useState } from "react";

type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };

/** Settings > Experimental's "Device notes": this Mac's own switch, kept by its daemon, off until turned on. */
export function useDeviceNotesEnabled() {
  // A test bridge may not offer it: the row stays hidden.
  const available = typeof window.milagre.readDeviceNotesEnabled === "function";
  const [state, setState] = useState<State>({ enabled: false, ready: false, saving: false, error: "" });
  useEffect(() => {
    if (!available) return;
    let live = true;
    const read = async () => {
      try {
        const value = await window.milagre.readDeviceNotesEnabled();
        if (live) setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true }));
      } catch {
        if (live) setState((current) => ({ ...current, ready: true, error: "Could not read this setting." }));
      }
    };
    void read();
    const off = window.milagre.onDeviceNotesEnabledChanged((value) =>
      setState((current) => ({ ...current, enabled: value?.enabled === true, ready: true, error: "" })),
    );
    return () => {
      live = false;
      off();
    };
  }, [available]);
  const save = useCallback(async (enabled: boolean) => {
    setState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const result = await window.milagre.saveDeviceNotesEnabled(enabled);
      setState((current) => ({ ...current, enabled: result.enabled === true }));
    } catch (cause) {
      setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : "Could not change this setting." }));
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, []);
  return { ...state, available, save };
}
