import { chatKey } from "@milagre/shared/agent-runs";

export type AppView = "chat" | "canvas" | "routines" | "orchestrator";

export type RunPaneReturn = { projectPath: string; linkId: string | null; sessionId: number | null; worktreeId: number | null };

export type RunPaneRestore =
  | { kind: "same"; sessionId: number | null; worktreeId: number | null }
  | { kind: "link"; linkId: string; sessionId: number | null }
  | { kind: "project"; projectPath: string; sessionId: number | null };

export function keepsRoutinesView(hold: string | null, projectPath: string | undefined, sessionId: number): boolean {
  return hold !== null && projectPath !== undefined && hold === chatKey(projectPath, sessionId);
}

export function runPaneRestore(
  saved: RunPaneReturn | null,
  paneKey: string | null,
  focusedKey: string | null,
  projectPath: string | null,
): RunPaneRestore | null {
  if (!saved || !paneKey || focusedKey !== paneKey) return null;
  if (saved.linkId) return { kind: "link", linkId: saved.linkId, sessionId: saved.sessionId };
  if (saved.projectPath === projectPath) return { kind: "same", sessionId: saved.sessionId, worktreeId: saved.worktreeId };
  return { kind: "project", projectPath: saved.projectPath, sessionId: saved.sessionId };
}

export function chatOnScreen({
  view,
  runPane,
  projectPath,
  sessionId,
}: {
  view: string;
  runPane: string | null;
  projectPath: string | null;
  sessionId: number | null;
}): string | null {
  if (!projectPath || sessionId === null) return null;
  const key = chatKey(projectPath, sessionId);
  if (view === "chat") return key;
  return (view === "routines" || view === "orchestrator") && runPane === key ? key : null;
}

export function readsOnPick({ onScreen, picked, unread }: { onScreen: string | null; picked: string; unread: boolean }): boolean {
  return unread && onScreen === picked;
}
