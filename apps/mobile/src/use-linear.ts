import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { LinearStatus } from "@milagre/shared/linear";
import type { Client } from "./client";

export function useLinear(client: Client | null): { active: boolean } {
  const [active, setActive] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (!client) {
        setActive(false);
        return;
      }
      let live = true;
      Promise.all([client.call<{ enabled: boolean }>("linear:enabled:read", []), client.call<LinearStatus>("linear:status", [])]).then(
        ([value, status]) => live && setActive(value?.enabled === true && status?.connected === true),
        () => live && setActive(false),
      );
      return () => {
        live = false;
      };
    }, [client]),
  );
  return { active };
}
