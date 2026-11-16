import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { Client } from "./client";
import { linksOf, refreshLinks, subscribeLinks } from "./links-store";

// The store lives in links-store.ts, apart from React Native; these are what the screens and the session use.
export { refreshLinks, setLinks } from "./links-store";

export function useLinks(client: Client | null) {
  const data = useSyncExternalStore(subscribeLinks, () => linksOf(client));
  useEffect(() => {
    if (!client) return;
    void refreshLinks(client);
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshLinks(client);
    });
    return () => watch.remove();
  }, [client]);
  const refresh = useCallback(() => (client ? refreshLinks(client) : Promise.resolve()), [client]);
  return useMemo(() => {
    const projects = data?.projects ?? [];
    return {
      available: !!data?.available,
      links: data?.links ?? [],
      projects,
      projectIdOf: (path: string) => projects.find((project) => project.path === path)?.id,
      projectNameOf: (id: string) => projects.find((project) => project.id === id)?.name,
      refresh,
    };
  }, [data, refresh]);
}
