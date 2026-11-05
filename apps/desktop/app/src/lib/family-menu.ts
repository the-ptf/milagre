// What the family menu lists for the open Chat (bookmark, split tiles): the Chats above it, then the Chats of its family,
// each with its live state in words. A Chat's family is its topmost listed ancestor and everything under that (subchats.ts).
import { chatActivity } from "@milagre/shared/chat-activity";
import { chatBookmark, chatFamily } from "@milagre/shared/subchats";
import type { SubchatState } from "@milagre/shared/subchat-states";
import type { AgentSession } from "../model";
import { chatMark, type ChatMark } from "./chat-list.ts";
import { chatState, KIND_INK, type SubchatSource } from "./subchat-track.ts";

export interface FamilyEntry {
  key: string;
  title: string;
  /** Its state in a word ("Working", "Needs you"), and the ink token that colours it. */
  word: string;
  ink: string;
  mark: ChatMark;
  background: number;
  /** "Top Chat" for the family's root, "Parent" for the open Chat's parent. */
  role?: "Top Chat" | "Parent";
}

export interface FamilyMenuModel {
  /** The Chats above the open one, the top Chat first, the direct parent last. */
  ancestors: FamilyEntry[];
  /** The family's Chats that aren't above the open one, oldest first; the open Chat is one of them. */
  subchats: FamilyEntry[];
  /** Every Chat in the family, the top Chat included: "Show all N side by side". */
  size: number;
  family: { root: string; children: string[] };
}

export type FamilyReads = Omit<SubchatSource, "parentKey"> & { routines: Parameters<typeof chatState>[1]["routines"]; now: number };

const NO_REPORTS: ReadonlyMap<string, string> = new Map();

/** A Chat above the open one has no "Done" of its own to report: a finished turn there is just idle. */
function wordOf(state: SubchatState, session: AgentSession, subchat: boolean): { word: string; ink: string } {
  if (!subchat && state.kind === "done" && !session.done_at) return { word: "Idle", ink: "text-ink-3" };
  return { word: state.label, ink: KIND_INK[state.kind] };
}

/** One Chat's row in the menu, or null when its session isn't listed. `subchat` is false for a Chat above the open one. */
export function familyEntry(key: string, reads: FamilyReads, subchat: boolean): FamilyEntry | null {
  const state = chatState(key, { ...reads, reports: NO_REPORTS });
  const session = reads.sessions?.[Number(key.slice(key.lastIndexOf("#") + 1))];
  if (!state || !session) return null;
  const run = reads.runs[key];
  const activity = chatActivity(session, run);
  const mark = chatMark({
    asking: Boolean(run && !run.approvals.length && run.questions.length),
    waiting: Boolean(run && (run.approvals.length || run.questions.length)),
    running: Boolean(run),
    background: activity.activity === "background",
    unread: Boolean(session.unread),
  });
  return { key, title: state.title, ...wordOf(state, session, subchat), mark, background: activity.background };
}

/** The family menu of the open Chat `key`, or null for a Chat with no family. */
export function familyMenuModel(key: string, reads: FamilyReads): FamilyMenuModel | null {
  const family = chatFamily(reads.sessions, key);
  if (!family) return null;
  const bookmark = chatBookmark(reads.sessions, key);
  const above = bookmark ? [...bookmark.above, bookmark.parent] : [];
  const ancestors = above.flatMap((at) => {
    const entry = familyEntry(at, reads, false);
    const role: FamilyEntry["role"] = at === bookmark?.parent ? "Parent" : at === family.root ? "Top Chat" : undefined;
    return entry ? [role ? { ...entry, role } : entry] : [];
  });
  const subchats = family.children.filter((at) => !above.includes(at)).flatMap((at) => familyEntry(at, reads, true) ?? []);
  return { ancestors, subchats, size: family.children.length + 1, family };
}
