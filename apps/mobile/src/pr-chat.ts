import type { pullRequestPresentation } from "@milagre/shared/pr-blockers";

// "Ask Chat" and "Send to Chat" from the PR sheet reach the Chat screen under it through this: the open
// Chat registers how it sends and how it fills its composer, keyed like its drafts (`projectPath#id`).

/**
 * One of the Chat's PRs, as its row lists them: what the PR menu offers. A Link Chat's PRs each come from one of its
 * Projects: `cwd` is that Project's Worktree, `project` its name.
 */
export type PrChoice = {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  cwd?: string;
  project?: string;
  projectPath?: string;
  /** Its tone and icon as the row shows them (pullRequestPresentation: blocked, draft, checks running, ready, merged, closed). */
  look?: Pick<ReturnType<typeof pullRequestPresentation>, "tone" | "icon">;
};

/** Tells apart PRs with the same number in two of a Link Chat's repositories. */
export const prChoiceKey = (choice: Pick<PrChoice, "number" | "cwd">) => `${choice.cwd ?? ""}#${choice.number}`;

type ChatHandle = {
  /** Sends as the composer would; "busy" when a send was already going. */
  send: (body: string) => Promise<boolean | "busy">;
  /** Puts text in the composer, for the user to finish. */
  prefill: (text: string) => void;
  /** The Chat's PRs, in its row's order. */
  pullRequests?: () => PrChoice[];
  /** Shows the Worktree's Changes beside the Chat. */
  changes?: () => void;
};

const handles = new Map<string, ChatHandle>();

export function registerPrChat(chatKey: string, handle: ChatHandle) {
  handles.set(chatKey, handle);
  return () => {
    if (handles.get(chatKey) === handle) handles.delete(chatKey);
  };
}

/** Sends to the Chat; when it can't send now, the text waits in its composer instead. Resolves to what happened. */
export async function sendToChat(chatKey: string | undefined, body: string): Promise<"sent" | "drafted" | "unavailable"> {
  const handle = chatKey ? handles.get(chatKey) : undefined;
  if (!handle) return "unavailable";
  try {
    if ((await handle.send(body)) === true) return "sent";
  } catch {}
  handle.prefill(body);
  return "drafted";
}

/** The Chat's PRs, for the PR sheet's menu; none when its screen isn't open. */
export function chatPullRequestChoices(chatKey: string | undefined): PrChoice[] {
  return (chatKey ? handles.get(chatKey)?.pullRequests?.() : undefined) ?? [];
}

/** Shows the Chat's Changes; false when its screen isn't open. */
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

// A Chat row's PR link opens the Chat, then its PR: the request waits here until that Chat's screen takes it.
const requests = new Map<string, number>();
const openers = new Map<string, (number: number) => void>();

export function requestPullRequest(chatKey: string, number: number) {
  const open = openers.get(chatKey);
  // The open Chat takes it once the navigation slid away.
  if (open) setTimeout(() => open(number), 250);
  else requests.set(chatKey, number);
}

export function onPullRequestRequest(chatKey: string, open: (number: number) => void) {
  openers.set(chatKey, open);
  const waiting = requests.get(chatKey);
  if (waiting !== undefined) {
    requests.delete(chatKey);
    // After the Chat's first frame, so the sheet opens over it.
    setTimeout(() => open(waiting), 400);
  }
  return () => {
    if (openers.get(chatKey) === open) openers.delete(chatKey);
  };
}
