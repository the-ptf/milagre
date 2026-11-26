import { fileManager } from "./shortcut-hints.ts";

export type ProjectMenuKey = "reveal" | "copy-path" | "copy-name" | "design-library" | "settings";

export function projectMenuActions(isMac: boolean): Array<{ key: ProjectMenuKey; label: string }> {
  return [
    { key: "reveal", label: isMac ? "Reveal in Finder" : `Show in ${fileManager}` },
    { key: "copy-path", label: "Copy path" },
    { key: "copy-name", label: "Copy name" },
    { key: "design-library", label: "Designs" },
    { key: "settings", label: "Project settings" },
  ];
}

type RevealState = {
  worktrees: Record<string, { path: string }>;
  sessions: Record<string, { worktree_id: number }>;
};

export function chatRevealPath(state: RevealState | null | undefined, sessionId: number, projectPath: string): string {
  const session = state?.sessions[sessionId];
  return (session && state?.worktrees[session.worktree_id]?.path) || projectPath;
}
