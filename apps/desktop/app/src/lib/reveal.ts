import { fileManager } from "./shortcut-hints.ts";

export type ProjectMenuKey = "reveal" | "copy-path" | "copy-name" | "settings";

/** The project's menu group, in order. The icon is picked where the menu is drawn. */
export function projectMenuActions(isMac: boolean): Array<{ key: ProjectMenuKey; label: string }> {
  return [
    { key: "reveal", label: isMac ? "Reveal in Finder" : `Show in ${fileManager}` },
    { key: "copy-path", label: "Copy project path" },
    { key: "copy-name", label: "Copy project name" },
    { key: "settings", label: "Project settings" },
  ];
}

type RevealState = {
  worktrees: Record<string, { path: string }>;
  sessions: Record<string, { worktree_id: number }>;
};

/** The folder "Open in Finder" shows for a chat: its worktree, else (a local chat) the project folder. */
export function chatRevealPath(state: RevealState | null | undefined, sessionId: number, projectPath: string): string {
  const session = state?.sessions[sessionId];
  return (session && state?.worktrees[session.worktree_id]?.path) || projectPath;
}
