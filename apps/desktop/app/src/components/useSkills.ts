import { useEffect, useState } from "react";
import type { SkillCatalog } from "../model";
import type { MilagreBridge } from "../electron";
import { bridgeForKey, isRemoteKey, useBridge } from "../lib/computer-bridge";

const EMPTY_CATALOG: SkillCatalog = { skills: [], warnings: [] };

// `revision` reads the disk again when it changes (Settings > Skills > Reload). A Chat's Worktree path carries no
// computer, so it uses the Project on screen. Settings explicitly owns its Project key, including bare local paths.
export function useSkills(projectPath: string, open: boolean, revision = 0, scope: "worktree" | "project" = "worktree") {
  const shown = useBridge();
  const bridge = scope === "project" || isRemoteKey(projectPath) ? bridgeForKey(projectPath) : shown;
  const [result, setResult] = useState<{ bridge: MilagreBridge; path: string; catalog: SkillCatalog } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (typeof bridge.listSkills !== "function") {
      setResult({ bridge, path: projectPath, catalog: { skills: [], warnings: ["Restart Milagre to enable skill discovery."] } });
      setLoading(false);
      return;
    }
    setLoading(true);
    bridge
      .listSkills(projectPath)
      .then((catalog) => {
        if (!cancelled) setResult({ bridge, path: projectPath, catalog });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not load skills. Reopen the menu to retry.";
        const warning = message.includes("No handler registered") ? "Restart Milagre to enable skill discovery." : message;
        if (!cancelled) setResult({ bridge, path: projectPath, catalog: { skills: [], warnings: [warning] } });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, projectPath, open, revision]);

  const catalog = result?.bridge === bridge && result.path === projectPath ? result.catalog : EMPTY_CATALOG;
  return { skills: catalog.skills, shadowed: catalog.shadowed ?? [], warnings: catalog.warnings, loading };
}
