import { CHATS_PLACEHOLDER } from "@milagre/shared/chats-home";

export function composerPlaceholder(state: { offline: boolean; computerName?: string; running: boolean; queuesFollowUp: boolean; chatsHome: boolean }) {
  if (state.offline) return `Queue a message for ${state.computerName || "this computer"}`;
  if (state.running) return state.queuesFollowUp ? "Queue a message for the next turn" : "Steer the agent";
  return state.chatsHome ? CHATS_PLACEHOLDER : undefined;
}
