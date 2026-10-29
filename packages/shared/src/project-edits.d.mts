import type { AgentSession, CoordinatorState, DiffStat, Subagent } from "./model.ts";

export type SessionPatch = Partial<Pick<AgentSession, "title" | "unread" | "archived" | "pinned" | "pin_order">>;

/** A new worktree's branch, renamed from its prompt's first words to the name picked for its chat. */
export type WorktreeRename = { projectPath: string; path: string; from: string; name: string };

export function patchSession(state: CoordinatorState, sessionId: number, patch: SessionPatch): CoordinatorState;
export function deleteSession(state: CoordinatorState, sessionId: number): CoordinatorState;
export function withDiffStats(state: CoordinatorState, stats: Record<number, DiffStat | null>): CoordinatorState;
export function renameWorktree(state: CoordinatorState, rename: Pick<WorktreeRename, "path" | "from" | "name">): CoordinatorState;
export function subagentFinished(agent: Subagent): boolean;
export function archiveSubagent(state: CoordinatorState, sessionId: number, id: string, archived: boolean): CoordinatorState;
export function archiveFinishedSubagents(state: CoordinatorState, sessionId: number, options?: { keepAdvisors?: boolean }): CoordinatorState;
