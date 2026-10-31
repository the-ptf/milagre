import { useEffect, useState } from "react";
import { CONTEXT_DEFAULTS, type ContextSettings } from "@milagre/shared/context-settings";
import { useBridge } from "./computer-bridge";
export function useContextSettings() {
  const bridge = useBridge();
  const [state, setState] = useState<{ bridge: typeof bridge; value: ContextSettings | null } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    let changed = false;
    const off = bridge.onContextSettings?.((value) => {
      changed = true;
      if (live) setState({ bridge, value });
    });
    bridge
      .readContextSettings?.()
      .then((value) => {
        if (live && !changed) setState({ bridge, value });
      })
      .catch(() => {
        if (live) setError("Could not read context settings.");
      });
    return () => {
      live = false;
      off?.();
    };
  }, [bridge]);
  // Older hosts and optional bridge implementations can return no settings.
  // Keep defaults visible and host controls disabled, as on mobile.
  const ready = state?.bridge === bridge && state.value != null;
  return {
    settings: (ready ? state.value : null) ?? CONTEXT_DEFAULTS,
    ready,
    saving,
    error,
    save: async (patch: Partial<ContextSettings>) => {
      setSaving(true);
      setError("");
      try {
        const value = await bridge.saveContextSettings(patch);
        setState({ bridge, value });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save context settings.");
      } finally {
        setSaving(false);
      }
    },
  };
}
