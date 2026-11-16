import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { OrchestratorComputer, OrchestratorProject } from "@milagre/shared/orchestrator";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

function useHostList<T>(client: Caller | null, method: string, revision: unknown): T[] | null {
  const [list, setList] = useState<{ client: Caller; items: T[] } | null>(null);
  const read = useCallback(() => {
    if (!client) return () => {};
    let live = true;
    void (async () => {
      const items = await client.call<T[]>(method, []).catch(() => null);
      if (live && Array.isArray(items)) setList({ client, items });
    })();
    return () => {
      live = false;
    };
  }, [client, method]);
  useFocusEffect(read);
  useEffect(read, [read, revision]);
  return list && list.client === client ? list.items : null;
}

/** The Projects the host can route to, with its own hints; null until read or from a host without the list. */
export function useOrchestratorProjects(client: Caller | null, revision?: unknown) {
  return useHostList<OrchestratorProject>(client, "orchestrator:projects", revision);
}

/** The host's paired computers with their load, keyed like `computerPreferences`. */
export function useOrchestratorComputers(client: Caller | null) {
  return useHostList<OrchestratorComputer>(client, "orchestrator:computers", null);
}

/** The host's routable Projects as name and path, else the phone's own list of them. */
export function routableProjects(listed: readonly OrchestratorProject[] | null, fallback: readonly { path: string; name?: string }[]) {
  return listed ? listed.filter((project) => project.included) : fallback;
}
