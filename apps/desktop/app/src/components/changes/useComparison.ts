import { useCallback, useEffect, useRef, useState } from "react";
import { isGitHistoryUnavailable, comparisonBaseMissing, withHistoryBranches, type GitHistory, type GitBranchCatalog } from "@milagre/shared/git-diff";
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
  const [limit, setLimit] = useState(0);
  const selected = choice?.value ?? choices.get(bridge)?.[cwd] ?? "";
  const comparisonBase = selected || base;
  const repository = JSON.stringify([cwd, comparisonBase, base]);
  const scope = JSON.stringify([repository, limit]);
  const [loaded, setLoaded] = useState<{
    repository: string;
    scope: string;
    bridge: MilagreBridge;
    data?: GitHistory;
    error?: string;
    unavailable?: boolean;
  }>();
  const catalog = useRef<{ cwd: string; bridge: MilagreBridge; value: GitBranchCatalog } | undefined>(undefined);
  const current = useRef({ cwd, base: comparisonBase, recordedBase: base, limit, repository, scope, bridge, active });
  current.current = { cwd, base: comparisonBase, recordedBase: base, limit, repository, scope, bridge, active };
  const refresh = useCallback(async () => {
    const request = current.current;
    if (!request.active || !request.cwd) return;
    try {
      if (typeof bridge.git.history !== "function") {
        setLoaded({ repository: request.repository, scope: request.scope, bridge, unavailable: true });
        return;
      }
      const saved = catalog.current?.cwd === request.cwd && catalog.current.bridge === bridge ? catalog.current.value : undefined;
      const response = await bridge.git.history({
        cwd: request.cwd,
        base: request.base,
        recordedBase: request.recordedBase,
        branchesVersion: saved?.version,
        limit: request.limit,
      });
      if (request.scope === current.current.scope && request.bridge === current.current.bridge) {
        if (response.isRepo && response.branches && response.branchesVersion)
          catalog.current = { cwd: request.cwd, bridge, value: { version: response.branchesVersion, branches: response.branches } };
        const data = withHistoryBranches(response, saved);
        setLoaded({ repository: request.repository, scope: request.scope, bridge: request.bridge, data });
      }
    } catch (error) {
      if (request.scope === current.current.scope && request.bridge === current.current.bridge)
        setLoaded((previous) => ({
          repository: request.repository,
          scope: request.scope,
          bridge: request.bridge,
          data: previous?.repository === request.repository && previous.bridge === request.bridge ? previous.data : undefined,
          error: error instanceof Error ? error.message : String(error),
          unavailable: isGitHistoryUnavailable(error),
        }));
    }
  }, [bridge]);
  useGitRefresh(active && !!cwd, scope, refresh);
  const retained = loaded?.repository === repository && loaded.bridge === bridge ? loaded : undefined;
  const [missing, setMissing] = useState<{ cwd: string; bridge: MilagreBridge; name: string }>();
  const select = useCallback(
    (value: string) => {
      if (choice) choice.onChange(value);
      else setChoices((previous) => new Map(previous).set(bridge, { ...previous.get(bridge), [cwd]: value }));
      setLimit(view === "commits" ? 30 : 0);
    },
    [choice, bridge, cwd, view],
  );
  const data = retained?.data?.isRepo ? retained.data : undefined;
  useEffect(() => {
    if (!active || !selected || !data || !comparisonBaseMissing(data, selected)) return;
    select("");
    setMissing({ cwd, bridge, name: selected.replace(/^refs\/(heads|remotes)\//, "") });
  }, [active, selected, data, select, cwd, bridge]);
  return {
    cwd,
    bridge,
    base: comparisonBase,
    selected,
    select: (value: string) => {
      setMissing(undefined);
      select(value);
    },
    missing: missing?.cwd === cwd && missing.bridge === bridge ? missing.name : undefined,
    dismissMissing: () => setMissing(undefined),
    view: retained?.unavailable ? ("files" as const) : view,
    setView: (next: "files" | "commits") => {
      setView(next);
      if (next === "commits") setLimit((value) => Math.max(value, 30));
    },
    data: retained?.data,
    unavailable: retained?.unavailable ?? false,
    loading: active && retained?.scope !== scope,
    error: retained?.error,
    refresh,
    more: () => setLimit((value) => Math.min(value + 30, 300)),
    limit,
  };
}
export type Comparison = ReturnType<typeof useComparison>;
