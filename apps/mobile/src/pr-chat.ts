import type { pullRequestPresentation } from "@milagre/shared/pr-blockers";

export type PrChoice = {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  cwd?: string;
  project?: string;
  projectPath?: string;
  look?: Pick<ReturnType<typeof pullRequestPresentation>, "tone" | "icon">;
};

export const prChoiceKey = (choice: Pick<PrChoice, "number" | "cwd">) => `${choice.cwd ?? ""}#${choice.number}`;

type ChatHandle = {
  send: (body: string) => Promise<boolean | "busy">;
  prefill: (text: string) => void;
  pullRequests?: () => PrChoice[];
  changes?: () => void;
};

const handles = new Map<string, ChatHandle>();

export function registerPrChat(chatKey: string, handle: ChatHandle) {
  handles.set(chatKey, handle);
  return () => {
    if (handles.get(chatKey) === handle) handles.delete(chatKey);
  };
}

export async function sendToChat(chatKey: string | undefined, body: string): Promise<"sent" | "drafted" | "unavailable"> {
  const handle = chatKey ? handles.get(chatKey) : undefined;
  if (!handle) return "unavailable";
  try {
    if ((await handle.send(body)) === true) return "sent";
  } catch {}
  handle.prefill(body);
  return "drafted";
}

export function chatPullRequestChoices(chatKey: string | undefined): PrChoice[] {
  return (chatKey ? handles.get(chatKey)?.pullRequests?.() : undefined) ?? [];
}

export function showChatChanges(chatKey: string | undefined) {
  const handle = chatKey ? handles.get(chatKey) : undefined;
  if (!handle?.changes) return false;
  handle.changes();
  return true;
}

export function prefillChat(chatKey: string | undefined, text: string) {
  const handle = chatKey ? handles.get(chatKey) : undefined;
  if (!handle) return false;
  handle.prefill(text);
  return true;
}

const requests = new Map<string, number>();
const openers = new Map<string, (number: number) => void>();

export function requestPullRequest(chatKey: string, number: number) {
  const open = openers.get(chatKey);
  if (open) setTimeout(() => open(number), 250);
  else requests.set(chatKey, number);
}

export function onPullRequestRequest(chatKey: string, open: (number: number) => void) {
  openers.set(chatKey, open);
  const waiting = requests.get(chatKey);
  if (waiting !== undefined) {
    requests.delete(chatKey);
    setTimeout(() => open(waiting), 400);
  }
  return () => {
    if (openers.get(chatKey) === open) openers.delete(chatKey);
  };
}
