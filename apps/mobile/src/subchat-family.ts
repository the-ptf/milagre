// What the bookmark over an open Subchat and its family menu say (subchat-bookmark.tsx, chat.tsx). Pure: the Chats come
// from the Project's sessions, the live state from its runs, the same read the Subchats pill makes (subchat-view.ts).
import { chatTitle } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";
import { chatBookmark, type FamilySession } from "@milagre/shared/subchats";
import type { SubchatInput } from "@milagre/shared/subchat-states";
import type { MenuSection } from "./primitives/menu";
import { subchatStates, type HeartbeatRoutine } from "./subchat-view.ts";

type Sessions = Record<number, AgentSession | undefined>;

/** The capsule over an open Subchat: the Chat above it, and whether that Chat is waiting on the user. */
export type Bookmark = { parent: string; title: string; needsYou: boolean; running: boolean };

const sessionOf = (sessions: Sessions, key: string) => sessions[Number(key.slice(key.lastIndexOf("#") + 1))];

/**
 * The bookmark of the Chat `key`: its nearest listed ancestor, or null for a top-level Chat. `attention` is the Chats
 * waiting on the user in every Project; the open Project's runs answer for its own Chats without waiting for the poll.
 */
export function bookmarkOf(input: {
  sessions: Sessions | undefined;
  key: string;
  attention: readonly string[];
  runs: Record<string, SubchatInput["run"]> | undefined;
}): Bookmark | null {
  if (!input.sessions) return null;
  const found = chatBookmark(input.sessions as Record<string, FamilySession>, input.key);
  const parent = found && sessionOf(input.sessions, found.parent);
  if (!found || !parent) return null;
  const run = input.runs?.[found.parent];
  const needsYou = input.attention.includes(found.parent) || !!(run?.approvals?.length || run?.questions?.length);
  return { parent: found.parent, title: chatTitle(parent, []), needsYou, running: !!run };
}

export const BESIDE_PARENT = "beside-parent";

/**
 * The title's family menu: the Chats above (the top one named "Top Chat", the nearest "Parent"), the family's Subchats
 * each with its state in words and a tick on the open one, then, where a wide iPad can, "Open beside parent". The open
 * Chat is always among them: chatFamily keeps it even when Done.
 */
export function familyMenu(input: {
  sessions: Sessions;
  key: string;
  children: readonly string[];
  routines: readonly HeartbeatRoutine[];
  routinesOn: boolean;
  runs: Record<string, SubchatInput["run"]> | undefined;
  now: number;
  canOpenBeside: boolean;
}): MenuSection[] {
  const found = chatBookmark(input.sessions as Record<string, FamilySession>, input.key);
  const item = (key: string, subtitle?: string) => ({
    id: key,
    title: (() => {
      const session = sessionOf(input.sessions, key);
      return session ? chatTitle(session, []) : "Chat";
    })(),
    ...(subtitle ? { subtitle } : {}),
    checked: key === input.key,
  });
  const above = found ? [...found.above, found.parent] : [];
  const states = new Map(
    subchatStates({
      keys: [...above, ...input.children],
      sessions: input.sessions,
      runs: input.runs,
      routines: input.routines,
      routinesOn: input.routinesOn,
      reports: new Map(),
      now: input.now,
    }).map((state) => [state.key, state.label]),
  );
  const role = (index: number) => (index === above.length - 1 ? "Parent" : index === 0 ? "Top Chat" : undefined);
  // An idle ancestor has no state worth a word: "Done" would read as if it finished.
  const live = (key: string) => {
    const label = states.get(key);
    return label === "Done" || label === "Stopped" ? undefined : label;
  };
  const ancestors = above.map((key, index) => item(key, [role(index), live(key)].filter(Boolean).join(" · ")));
  const members = input.children.map((key) => item(key, states.get(key)));
  return [
    ...(ancestors.length ? [{ items: ancestors }] : []),
    ...(members.length ? [{ title: members.length === 1 ? "1 Subchat" : `${members.length} Subchats`, items: members }] : []),
    ...(input.canOpenBeside && found ? [{ items: [{ id: BESIDE_PARENT, title: "Open beside parent", systemImage: "rectangle.split.2x1" }] }] : []),
  ];
}
