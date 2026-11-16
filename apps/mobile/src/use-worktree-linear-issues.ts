import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import type { LinearIssue } from "@milagre/shared/linear";
import type { Client } from "./client";

type Loaded = Record<string, Record<string, LinearIssue>>;

export function useWorktreeLinearIssues(client: Client | null, projectPaths: string[], refreshKey = 0): Record<string, LinearIssue> {
  const [loaded, setLoaded] = useState<Loaded>({});
  const pathsKey = JSON.stringify(projectPaths);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      const paths: string[] = JSON.parse(pathsKey);
      if (!paths.length) return;
      let focused = true;
      const active = () => focused && AppState.currentState === "active";
      const refresh = () => {
        if (!active()) return;
        for (const projectPath of paths) {
          client
            .call<Record<string, LinearIssue>>("linear:worktree-issues", [projectPath])
            .then((issues) => active() && setLoaded((previous) => ({ ...previous, [projectPath]: issues || {} })))
            .catch(() => {});
        }
      };
      refresh();
      const timer = setInterval(refresh, 30000);
      const subscription = AppState.addEventListener("change", refresh);
      return () => {
        focused = false;
        clearInterval(timer);
        subscription.remove();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [client, pathsKey, refreshKey]),
  );
  return useMemo(() => {
    const merged: Record<string, LinearIssue> = {};
    for (const projectPath of JSON.parse(pathsKey) as string[]) Object.assign(merged, loaded[projectPath]);
    return merged;
  }, [loaded, pathsKey]);
}
