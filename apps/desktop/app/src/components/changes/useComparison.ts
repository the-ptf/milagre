import { useCallback, useRef, useState } from "react";
import type { GitHistory } from "@milagre/shared/git-diff";
import type { MilagreBridge } from "../../electron";
import { useGitRefresh } from "./useGitRefresh";

export function useComparison(
  cwd: string,
  base: string | undefined,
  bridge: MilagreBridge,
  active: boolean,
  choice?: { value: string; onChange: (value: string) => void },
) {
  const [choices, setChoices] = useState(() => new Map<MilagreBridge, Record<string, string>>());
  const [view, setView] = useState<"files" | "commits">("files");
  const [limit, setLimit] = useState(30);
  const selected = choice?.value ?? choices.get(bridge)?.[cwd] ?? "";
  const comparisonBase = selected || base;
  const scope = JSON.stringify([cwd, comparisonBase, view === "commits" ? limit : 0]);
  const [loaded, setLoaded] = useState<{ scope: string; bridge: MilagreBridge; data?: GitHistory; error?: string }>();
  const current = useRef({ cwd, base: comparisonBase, limit: view === "commits" ? limit : 0, scope, bridge });
  current.current = { cwd, base: comparisonBase, limit: view === "commits" ? limit : 0, scope, bridge };
  const refresh = useCallback(async () => {
    const request = current.current;
    try {
      const data = await bridge.git.history({ cwd: request.cwd, base: request.base, limit: request.limit });
      if (request.scope === current.current.scope && request.bridge === current.current.bridge)
        setLoaded({ scope: request.scope, bridge: request.bridge, data });
    } catch (error) {
      if (request.scope === current.current.scope && request.bridge === current.current.bridge)
        setLoaded({ scope: request.scope, bridge: request.bridge, error: error instanceof Error ? error.message : String(error) });
    }
  }, [bridge]);
  useGitRefresh(active && !!cwd, scope, refresh);
  return {
    base: comparisonBase,
    selected,
    select: (value: string) => {
      if (choice) choice.onChange(value);
      else setChoices((previous) => new Map(previous).set(bridge, { ...previous.get(bridge), [cwd]: value }));
      setLimit(30);
    },
    view,
    setView,
    data: loaded?.scope === scope && loaded.bridge === bridge ? loaded.data : undefined,
    error: loaded?.scope === scope && loaded.bridge === bridge ? loaded.error : undefined,
    refresh,
    more: () => setLimit((value) => Math.min(value + 30, 300)),
    limit,
  };
}
export type Comparison = ReturnType<typeof useComparison>;
