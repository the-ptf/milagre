import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import { lanRoutes } from "./routes-native";
import { pingComputer, type Reachability } from "./computer-actions";
import type { SavedHost } from "./hosts-store";

const last = new Map<string, Reachability>();

export function useComputerStatus(hosts: SavedHost[]): Record<string, Reachability> {
  const [status, setStatus] = useState<Record<string, Reachability>>({});
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const ask = async (host: SavedHost) => {
        const next = await pingComputer(host);
        last.set(host.id, next);
        if (live) setStatus((current) => ({ ...current, [host.id]: next }));
      };
      for (const host of hosts) void ask(host);
      return () => {
        live = false;
      };
    }, [hosts]),
  );
  return Object.fromEntries(hosts.map((host) => [host.id, status[host.id] ?? last.get(host.id) ?? "checking"]));
}

export function useRouteChanges(hosts: SavedHost[]) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const stops = hosts.map((host) => lanRoutes.subscribe(host.id, () => setTick((tick) => tick + 1)));
    return () => stops.forEach((stop) => stop());
  }, [hosts]);
}
