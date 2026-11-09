import { chatKey } from "@milagre/shared/agent-runs";

/** The window's Chat before a Run Chat took the Chat pane beside its Routine's page. */
export type RunPaneReturn = { projectPath: string; linkId: string | null; sessionId: number | null; worktreeId: number | null };

/** What closing the Run Chat pane brings back: a Chat in the Project on screen, a Link's Chat, or another Project's. */
export type RunPaneRestore =
  | { kind: "same"; sessionId: number | null; worktreeId: number | null }
  | { kind: "link"; linkId: string; sessionId: number | null }
  | { kind: "project"; projectPath: string; sessionId: number | null };

/**
 * Whether opening `sessionId` in `projectPath` keeps the Routines view: the Run Chat being opened beside its Routine's page
 * (`hold`, by chat key). Keyed by the whole chat key, so a Chat with the same id in another Project opens in the Chat view.
 */
export function keepsRoutinesView(hold: string | null, projectPath: string | undefined, sessionId: number): boolean {
  return hold !== null && projectPath !== undefined && hold === chatKey(projectPath, sessionId);
}

/**
 * What to bring back when the Run Chat pane closes: the Chat `saved` before it opened, while the window still shows the Run
 * Chat (`paneKey`). Null when nothing was saved, or the window has moved on to a Chat picked since (the sidebar, a
 * notification), which stays.
 */
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

/**
 * The Chat on screen, by chat key, as the main process reads it (it reads that Chat, and a turn that ends there leaves it
 * read): the Chat view's, or a Run Chat open in the pane beside its Routine's page, which is the window's Chat pane too.
 * Null on any other view.
 */
export function chatOnScreen({
  view,
  runPane,
  projectPath,
  sessionId,
}: {
  view: string;
  /** The Run Chat the pane shows, when it is open. */
  runPane: string | null;
  projectPath: string | null;
  sessionId: number | null;
}): string | null {
  if (!projectPath || sessionId === null) return null;
  const key = chatKey(projectPath, sessionId);
  if (view === "chat") return key;
  return view === "routines" && runPane === key ? key : null;
}

/**
 * Whether picking a Chat's row marks it read here. Picking another Chat puts it on screen and the main process reads it
 * then; the Chat already on screen changes nothing there, so one that went unread while no window had focus (a turn that
 * ended with the window in the background) is read by the pick itself. A Chat with a Project or without one alike.
 */
export function readsOnPick({ onScreen, picked, unread }: { onScreen: string | null; picked: string; unread: boolean }): boolean {
  return unread && onScreen === picked;
}
