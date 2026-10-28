import type { CoordinatorState, Worktree } from "./model.ts";

/** What archiving a chat would lose from its worktree, as `worktree:status` reports it. */
export type WorktreeStatus = { uncommitted: number; unpushed: number; branch: string | null; head: string; removable: boolean };

/** How an archive goes: only hide the chat, or also remove its worktree (`delete` discards what it holds). */
export type ArchiveMode = "hide" | "remove" | "delete";

/** Everything the menu needs to offer the right choices for one chat. `terminals` names what its busy Terminals run. */
export type ArchivePlan = { milagreOwned: boolean; shared: boolean; status: WorktreeStatus | null; terminals?: string[] };

export type ArchiveChoice = { mode: ArchiveMode; label: string; tone: "plain" | "danger" };

/** What `worktree:remove` is sent besides the path: the daemon closes the chat's agent and checks again against `seen`. */
export type RemoveOptions = { force: boolean; base: string; projectPath: string; chatId: string; seen: WorktreeStatus };

/** What archiving a chat touches, passed in so the order of the steps can be tested. */
export type ArchiveDeps = {
  /** The project the chat is in; the archive stops short of changing state if the app has moved on. */
  projectPath: string;
  chatId: string;
  getState: () => CoordinatorState | null;
  currentProjectPath: () => string | undefined;
  /** Interrupts the chat's running turn, if it has one. */
  stop: () => Promise<unknown> | undefined;
  /** Hides the chat (and leaves it if it is open). */
  hide: () => void | Promise<unknown>;
  /** Brings the chat back after `hide`, because its worktree is staying. */
  restore: () => void | Promise<unknown>;
  /** Removes the worktree; the daemon closes the chat's agent and checks again against `seen`. */
  remove: (worktree: Worktree, options: RemoveOptions) => Promise<unknown>;
  /** The worktree is gone, with these chats; the daemon has dropped them from the project's state. */
  applyRemoval: (removed: { worktreeId: number; sessionIds: number[] }) => void;
  refreshBranches: () => void;
  notify: (message: string) => void;
};

export function isInsideRoots(path: string, roots: string[]): boolean;
export function isMilagreWorktree(worktree: Worktree | undefined, roots: string[]): worktree is Worktree;
export function worktreeShared(state: CoordinatorState, sessionId: number): boolean;
export function lossReason(status: WorktreeStatus): string;
export function deleteNote(status: WorktreeStatus): string;
export function homeLossReason(status: WorktreeStatus): string;
/** `chatsHome`: a Chat without a Project, in plain words. `immediate`: the one choice needs no confirm step. */
export function archiveChoices(options: { plan: ArchivePlan; running: boolean; chatsHome?: boolean }): {
  choices: ArchiveChoice[];
  reason: string | null;
  immediate: boolean;
};
export function terminalNote(busy: string[]): string | null;
export function removeFailureNotice(error: unknown): string;
export function archiveLinkChat(deps: { running: boolean; stop: () => Promise<unknown>; hide: () => Promise<unknown> }): Promise<void>;
export function archiveChat(deps: ArchiveDeps, sessionId: number, mode: ArchiveMode, plan: ArchivePlan | null): Promise<"hidden" | "removed" | "kept">;
