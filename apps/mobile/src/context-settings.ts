import { useState } from "react";
import { CONTEXT_DEFAULTS, type ContextSettings } from "@milagre/shared/context-settings";
import { useRpc } from "./use-rpc";
import { useSession } from "./session";
export function useContextSettings() {
  const { client } = useSession();
  const query = useRpc<ContextSettings>(client, "context:settings:read", [], true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return {
    settings: query.data ?? CONTEXT_DEFAULTS,
    ready: Boolean(query.data),
    saving,
    error: error || query.error,
    save: async (patch: Partial<ContextSettings>) => {
      if (!client) return;
      setSaving(true);
      setError("");
      try {
        await client.call("context:settings:save", [patch]);
        query.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save context settings.");
      } finally {
        setSaving(false);
      }
    },
  };
}
