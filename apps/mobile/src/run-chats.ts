import { projectOfKey } from "@milagre/shared/agent-runs";
import { chatLeft, type ScopeStates } from "@milagre/shared/routines";

/**
 * Whether a Run's row opens its Chat. While the phone holds its Project's state, only a Chat still there does (chatLeft,
 * archived or not): a Worktree removed with its Chat leaves nothing to open. A Project the phone holds no state for can't
 * tell, so the row opens, and the Chat screen loads that Project and says so if the Chat is gone.
 */
export function canOpenRunChat(states: ScopeStates, chatKey: string): boolean {
  return !states[projectOfKey(chatKey)] || chatLeft(states, chatKey);
}
