import { useEffect, useState } from "react";
import type { SkillCatalog } from "../model";
import { bridgeForKey, isRemoteKey, useBridge } from "../lib/computer-bridge";

const EMPTY_CATALOG: SkillCatalog = { skills: [], warnings: [] };

// `revision` reads the disk again when it changes (Settings > Skills > Reload). A Chat's Worktree path carries no
// computer, so a bare path goes to the computer of the Project on screen; Settings passes the Project's key, which names it.
export function useSkills(projectPath: string, open: boolean, revision = 0) {
  const shown = useBridge();
  const bridge = isRemoteKey(projectPath) ? bridgeForKey(projectPath) : shown;
  const [result, setResult] = useState<{ path: string; catalog: SkillCatalog } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (typeof bridge.listSkills !== "function") {
      setResult({ path: projectPath, catalog: { skills: [], warnings: ["Restart Milagre to enable skill discovery."] } });
      setLoading(false);
      return;
    }
    setLoading(true);
    bridge
      .listSkills(projectPath)
      .then((catalog) => {
        if (!cancelled) setResult({ path: projectPath, catalog });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not load skills. Reopen the menu to retry.";
        const warning = message.includes("No handler registered") ? "Restart Milagre to enable skill discovery." : message;
        if (!cancelled) setResult({ path: projectPath, catalog: { skills: [], warnings: [warning] } });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, projectPath, open, revision]);

  const catalog = result?.path === projectPath ? result.catalog : EMPTY_CATALOG;
  return { skills: catalog.skills, shadowed: catalog.shadowed ?? [], warnings: catalog.warnings, loading };
}
