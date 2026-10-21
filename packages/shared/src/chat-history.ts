import type { ChatMessage, ChatStep } from "./model.ts";
import { designActivity } from "./artifact.ts";

type History = {
  steps: ChatStep[];
  userMessages: { id: number; body: string }[];
  userBodies: string[];
  promptHistory: string[];
  designActivity: number;
};
// The immutable completed history is shared by transcript/composer consumers. A live delta doesn't change it.
// Weak ownership releases the projection with its source, including after cache eviction or a saved-message edit.
const histories = new WeakMap<ChatMessage[], History>();

export function chatHistory(messages: ChatMessage[]): History {
  const known = histories.get(messages);
  if (known) return known;
  const steps: ChatStep[] = [];
  const userMessages: History["userMessages"] = [];
  const promptHistory: string[] = [];
  for (const message of messages) {
    for (const step of message.steps ?? []) steps.push(step);
    if (message.role !== "user") continue;
    userMessages.push({ id: message.id, body: message.body });
    if (!message.context && message.body.trim() && promptHistory.at(-1) !== message.body) promptHistory.push(message.body);
  }
  const userBodies = userMessages.map((message) => message.body);
  const result = { steps, userMessages, userBodies, promptHistory, designActivity: designActivity(steps, userBodies) };
  histories.set(messages, result);
  return result;
}
