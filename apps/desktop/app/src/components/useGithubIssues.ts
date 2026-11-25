import { useEffect, useState } from "react";
import { bridgeForKey } from "../lib/computer-bridge";

const KNOWN_MS = 5 * 60_000;
const HIDDEN = new Set(["no-github", "issues-off"]);
const known = new Map<string, { at: number; available: boolean }>();

/**
 * The Project the new Chat header offers "GitHub issue" for, or null: not one without a GitHub remote or with issues
 * off, or on a computer whose Milagre predates it. Asking lists the issues, so the picker opens on the host's cache.
 */
export function useGithubIssueProject(projectKey: string | undefined, enabled: boolean): string | null {
  const cached = (key: string | undefined) => {
    const hit = key ? known.get(key) : undefined;
    return hit && Date.now() - hit.at < KNOWN_MS ? hit.available : undefined;
  };
  const [state, setState] = useState(() => ({ key: projectKey, available: cached(projectKey) ?? false }));
  useEffect(() => {
    if (!projectKey || !enabled || cached(projectKey) !== undefined) return;
    let live = true;
    Promise.resolve()
      .then(() => bridgeForKey(projectKey).listGithubIssues(projectKey))
      .then(
        (result) => !!result && !("error" in result && HIDDEN.has(result.code)),
        () => false,
      )
      .then((available) => {
        known.set(projectKey, { at: Date.now(), available });
        if (live) setState({ key: projectKey, available });
      });
    return () => {
      live = false;
    };
  }, [projectKey, enabled]);
  if (!projectKey || !enabled) return null;
  return (cached(projectKey) ?? (state.key === projectKey && state.available)) ? projectKey : null;
}
