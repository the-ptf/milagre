import { useEffect, useState } from "react";
import type { GithubIssuesResult } from "@milagre/shared/github-issue";
import type { Client, Snapshot } from "./client";

const KNOWN_MS = 5 * 60_000;
const HIDDEN = new Set(["no-github", "issues-off"]);
const known = new Map<string, { at: number; available: boolean }>();

/**
 * Whether New Chat offers "GitHub issue" for the open Project: only before its Chat exists, not for a Link or No project,
 * nor one without a GitHub remote or with issues off, or on a computer whose Milagre predates it. Asking lists the
 * issues, so the sheet opens on the computer's cache.
 */
export function useGithubIssuesAvailable(
  client: Client | null,
  snapshot: Snapshot | null | undefined,
  { chatOpen, chatsHome }: { chatOpen: string | undefined; chatsHome: boolean },
): boolean {
  const projectPath = snapshot?.project.path;
  const enabled = !chatOpen && !snapshot?.project.link && !chatsHome;
  const key = client && projectPath ? `${client.url}\n${projectPath}` : "";
  const cached = () => {
    const hit = key ? known.get(key) : undefined;
    return hit && Date.now() - hit.at < KNOWN_MS ? hit.available : undefined;
  };
  const [state, setState] = useState(() => ({ key, available: cached() ?? false }));
  useEffect(() => {
    if (!client || !projectPath || !enabled || !key) return;
    const hit = known.get(key);
    if (hit && Date.now() - hit.at < KNOWN_MS) return;
    let live = true;
    client
      .call<GithubIssuesResult>("github:issues", [{ projectPath }])
      .then(
        (result) => !("error" in result && HIDDEN.has(result.code)),
        () => false,
      )
      .then((available) => {
        known.set(key, { at: Date.now(), available });
        if (live) setState({ key, available });
      });
    return () => {
      live = false;
    };
  }, [client, projectPath, enabled, key]);
  if (!enabled || !key) return false;
  return cached() ?? (state.key === key && state.available);
}
