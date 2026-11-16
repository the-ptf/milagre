import { chatActivity } from "@milagre/shared/chat-activity";
import { chatBookmark, chatFamily } from "@milagre/shared/subchats";
import type { SubchatState } from "@milagre/shared/subchat-states";
import type { AgentSession } from "../model";
import { chatMark, type ChatMark } from "./chat-list.ts";
import { chatState, KIND_INK, type SubchatSource } from "./subchat-track.ts";

export interface FamilyEntry {
  key: string;
  title: string;
  word: string;
  ink: string;
  mark: ChatMark;
  background: number;
  role?: "Top Chat" | "Parent";
}

export interface FamilyMenuModel {
  ancestors: FamilyEntry[];
  subchats: FamilyEntry[];
  size: number;
  family: { root: string; children: string[] };
}

export type FamilyReads = Omit<SubchatSource, "parentKey"> & { routines: Parameters<typeof chatState>[1]["routines"]; now: number };

const NO_REPORTS: ReadonlyMap<string, string> = new Map();

function wordOf(state: SubchatState, session: AgentSession, subchat: boolean): { word: string; ink: string } {
  if (!subchat && state.kind === "done" && !session.done_at) return { word: "Idle", ink: "text-ink-3" };
  return { word: state.label, ink: KIND_INK[state.kind] };
}

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
