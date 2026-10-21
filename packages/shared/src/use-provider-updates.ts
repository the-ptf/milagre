import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUpdate } from "./model";

export interface ProviderUpdateTransport {
  read: () => Promise<ProviderUpdate[]>;
  install: (update: ProviderUpdate) => Promise<{ ok: boolean; error?: string }>;
}
const keyOf = (update: ProviderUpdate) => `${update.provider}:${update.version}`;

/** One queue per connected computer. Dismissing a release lasts until this app session ends. */
export function useProviderUpdates(transport: ProviderUpdateTransport | null) {
  const [updates, setUpdates] = useState<ProviderUpdate[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const installing = useRef(false);
  const revision = useRef(0);
  const [source, setSource] = useState(transport);
  const refresh = useCallback(async () => {
    if (!transport) return;
    const current = generation.current;
    const request = ++revision.current;
    try {
      const next = await transport.read();
      if (generation.current === current && request === revision.current) setUpdates(next);
    } catch {
      /* An older or offline computer simply has no update notice. */
    }
  }, [transport]);
  useEffect(() => {
    generation.current++;
    setSource(transport);
    setUpdates([]);
    setDismissed(new Set());
    setWorking(false);
    setError("");
    installing.current = false;
    void refresh();
    const timer = setInterval(() => {
      if (!installing.current) void refresh();
    }, 30 * 60_000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [transport, refresh]);
  const current = source === transport ? updates.find((update) => !dismissed.has(keyOf(update))) : undefined;
  const dismiss = () => {
    if (current && !working) setDismissed((previous) => new Set([...previous, keyOf(current)]));
    setError("");
  };
  const install = async () => {
    if (!current || !transport || installing.current) return;
    const active = generation.current;
    revision.current++;
    installing.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await transport.install(current);
      if (active !== generation.current) return;
      if (result.ok) {
        setUpdates((previous) => previous.filter((update) => keyOf(update) !== keyOf(current)));
        await refresh();
      } else setError(result.error ?? "The update failed. Try again.");
    } catch (reason) {
      if (active === generation.current) setError(reason instanceof Error ? reason.message : "The update failed. Try again.");
    } finally {
      if (active === generation.current) {
        installing.current = false;
        setWorking(false);
      }
    }
  };
  return { current, working, error, dismiss, install, refresh };
}
