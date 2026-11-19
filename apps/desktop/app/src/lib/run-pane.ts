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

/**
 * Whether a task's Chat is open in the pane beside the Orchestrator or its Routine, and whether a Chat is on screen at
 * all: the Chat view or that pane, which both get the Changes and PR panel.
 */
export function runPaneState({
  view,
  routineId,
  runPane,
  focusedChatKey,
}: {
  view: string;
  routineId: string | null;
  runPane: string | null;
  focusedChatKey: string | null;
}): { runPaneOpen: boolean; chatShown: boolean } {
  const runPaneOpen = (view === "orchestrator" || (view === "routines" && routineId !== null)) && runPane !== null && runPane === focusedChatKey;
  return { runPaneOpen, chatShown: view === "chat" || runPaneOpen };
}

export function readsOnPick({ onScreen, picked, unread }: { onScreen: string | null; picked: string; unread: boolean }): boolean {
  return unread && onScreen === picked;
}
