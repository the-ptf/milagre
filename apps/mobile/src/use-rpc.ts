import { useEffect, useState } from "react";
import { startRefreshLoop } from "@milagre/shared/refresh-loop";
import type { Client } from "./client";

export function useRpc<T>(client: Client | null, method: string, args: unknown[], autoRefresh?: boolean, retainKey?: string) {
  const encoded = JSON.stringify(args);
  // Opt in to retaining results across parameter changes within this method and repository.
  const retention = JSON.stringify([method, retainKey ?? encoded]);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ client: Client; call: string; retention: string; identity: string; data: T | null; error: string } | null>(null);
  const call = JSON.stringify([method, encoded]);
  const identity = JSON.stringify([call, revision]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const stop = startRefreshLoop({
      repeat: autoRefresh === true,
      isActive: () => autoRefresh !== false,
      refresh: async () => {
        try {
          const data = await client.call<T>(method, JSON.parse(encoded));
          if (!cancelled) setLoaded({ client, call, retention, identity, data, error: "" });
        } catch (error) {
          if (!cancelled)
            setLoaded((previous) => ({
              client,
              call,
              retention,
              identity,
              data: retainKey !== undefined && previous?.client === client && previous.retention === retention ? previous.data : null,
              error: error instanceof Error ? error.message : String(error),
            }));
        }
      },
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, method, encoded, call, identity, autoRefresh, retention, retainKey]);
  const current = loaded?.client === client && loaded?.identity === identity ? loaded : null;
  // A refresh keeps the last answer on screen until the new one comes.
  const kept = loaded?.client === client && loaded.retention === retention ? loaded.data : null;
  return { data: current ? current.data : kept, error: current?.error || "", loading: !!client && !current, refresh: () => setRevision((value) => value + 1) };
}
