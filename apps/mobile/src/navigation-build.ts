import { isSnoozed } from "@milagre/shared/snooze";
import { withSnoozeMark, type SnoozeMark } from "./snooze-actions";
import { chatSummary } from "@milagre/shared/chat-summary";
import type { Href } from "expo-router";
import { chatTitle, comparePins, pendingChatSessionId, pullRequestRefs, withPendingChat } from "@milagre/shared/chats";
import { type SettingsRoute } from "./settings-index";
import type { AgentSession, PullRequest } from "@milagre/shared/model";
import type { LinearIssue } from "@milagre/shared/linear";
import type { RecentProject, RegisteredProject, Snapshot } from "./client";
import { NO_PROJECT_LABEL } from "@milagre/shared/chats-home";
import { type MobilePendingChat } from "./session";
import { sessionsWithPins, type DevicePins } from "@milagre/shared/chat-pins";
import { chatMark, type ChatMark } from "./indicators";
import { shownChat } from "./chat-list-filter";
import { chatActivity } from "@milagre/shared/chat-activity";
import type { HostView, ProjectCopy, Reach } from "./all-computers-store";
import { type SubchatMarks } from "./subchat-rows";

/** Secondary screens push over the current one; a sheet also leaves the sidebar open under it, as confirmations do. */
export type Destination = (href: Href, secondary?: boolean | "sheet") => void;
/** The computer a row belongs to: every row and every action carries it, since two computers can share a path and a Chat id. */
export type HostTag = { hostId: string; hostName: string; reach: Reach };
export type Row = { key: string; path: string } & (
  | ({
      kind: "project";
      name: string;
      expanded: boolean;
      members?: RegisteredProject[];
      link: boolean;
      chip: boolean;
      count: number;
      /** In the Tree layout, a Named Link's member Project, drawn under the Link. */
      member?: boolean;
    } & HostTag)
  /** In the Tree layout, the heading of a Worktree several Chats share: they follow it. */
  | ({
      kind: "worktree";
      name: string;
      running: boolean;
    } & HostTag)
  /** A Project whose name matches the search: a tap starts a new Chat in it. */
  | ({
      kind: "projectHit";
      name: string;
      members?: RegisteredProject[];
      many: boolean;
    } & HostTag)
  /** Nothing matched the search: start a new Chat with it. */
  | { kind: "start" }
  /** A Settings page or a row on one whose words match the search: a tap opens it, the row lit up. */
  | { kind: "settingHit"; title: string; trail: string; page: SettingsRoute; find?: string }
  | { kind: "section"; name: string }
  /** The Chats group's header: every computer's Chats without a Project, above the Projects. */
  | {
      kind: "chatsGroup";
      expanded: boolean;
      count: number;
      offline: boolean;
      homes: { hostId: string; path: string }[];
    }
  | ({
      kind: "chat";
      chat: AgentSession;
      title: string;
      /** The Project's name, on the list's first line. */
      project: string;
      members?: RegisteredProject[];
      worktree: string;
      mark: ChatMark;
      /** With a background mark: how many background agents still work. */
      background?: number;
      pending?: MobilePendingChat;
      prPath?: string;
      prRefs?: string[];
      pullRequests?: PullRequest[];
      linearIssue?: LinearIssue;
      /** How the list names each other end of the Links that reach the Chat's Worktree. */
      linked?: string[];
      /** Whether more than one computer is listed, so the row names its own. */
      many: boolean;
      /** A Chat without a Project: its row names its computer and age, never a branch. */
      home?: boolean;
      /** Grouped under a Project that several computers share: the row names its computer on its second line. */
      shared?: boolean;
      /** In the Tree layout: drawn further in, under a Link's member Project or a Worktree heading. */
      indent?: number;
    } & SubchatMarks &
      HostTag)
  | ({
      kind: "message";
      chat: AgentSession;
      title: string;
      project: string;
      many: boolean;
      snippet: string;
      highlight: [number, number];
    } & HostTag)
  | ({
      kind: "notice";
      message: string;
      failed?: boolean;
      retry?: "project";
    } & HostTag)
  /** The one quiet line for every computer that isn't answering; Retry reads those computers again. */
  | { kind: "offline"; hostIds: string[] }
  /** The Snoozed section's header, above Done: a tap folds it. */
  | { kind: "snoozedHeader"; count: number; expanded: boolean }
  /** A snoozed Chat: a tap opens it, a swipe right wakes it, and it counts down to when its computer wakes it. */
  | ({
      kind: "snoozed";
      chat: AgentSession;
      title: string;
      many: boolean;
      home?: boolean;
    } & HostTag)
  /** The Done section's header at the bottom of the list: a tap folds it. */
  | { kind: "doneHeader"; count: number; expanded: boolean }
  /** A Done Chat: a tap opens it, a swipe right reopens it, and it counts down to its Mac's archive. `many`: name its computer. */
  | ({
      kind: "done";
      chat: AgentSession;
      title: string;
      many: boolean;
      home?: boolean;
    } & HostTag)
);
export type ChatRow = Extract<Row, { kind: "chat" }>;
/** One Project's Chats as the search reads them: its messages, or null when its computer searches them. */
export type SearchScope = HostTag & {
  path: string;
  project: string;
  messages: NonNullable<ProjectBuild["copy"]>["project"]["state"]["messages"] | null;
  chats: Map<number, { chat: AgentSession; title: string }>;
};
export type ChatEntry = {
  chat: AgentSession;
  title: string;
  sortId: number;
  mark: ChatMark;
  background: number;
  pending?: MobilePendingChat;
  worktree: string;
  /** The Worktree's folder, which groups a Project's Chats in the Tree layout (worktreeGroups). */
  worktreePath?: string;
  prPath?: string;
  prRefs: string[];
};
export type ProjectBuild = {
  path: string;
  name: string;
  /** The Git remote ("host/owner/repo") that puts this Project's copies on several computers under one row. */
  origin?: string;
  link: boolean;
  members?: RegisteredProject[];
  copy?: ProjectCopy;
  /** The Project's Chats before the search filter, newest first. */
  all: ChatEntry[];
  chats: ChatEntry[];
  /** Its Done Chats, for the Done section at the bottom of the list. */
  done: ChatEntry[];
  /** Its snoozed Chats, for the Snoozed section above Done. */
  snoozed: ChatEntry[];
  failure?: string;
};
/** `home`: the computer's Chats without a Project, once its Chats home exists. */
export type HostBuild = HostTag & {
  projects: ProjectBuild[];
  home?: ProjectBuild;
  loaded: boolean;
};
export type BuildContext = {
  needle: string;
  currentHostId?: string;
  snapshot: Snapshot | null;
  pendingChats: Record<string, MobilePendingChat>;
  archiving: (projectPath: string, chatId: number) => boolean;
  /** Deleted from the phone and not back (an Undo or a failure brings it back): out of the list. */
  hidden: (projectPath: string, chatId: number) => boolean;
  /** Marked Done (a time) or reopened (null) from here, before its computer has answered: the row moves at once. */
  doneMark: (projectPath: string, chatId: number) => DoneMark | undefined;
  /** Snoozed (a wake time) or woken (null) from here, before its computer has answered. */
  snoozeMark: (projectPath: string, chatId: number) => SnoozeMark | undefined;
  fallback: (path: string) => ProjectCopy | undefined;
  show: Show;
  /** This phone's pins on the computer: the Mac's own never show here (chat-pins-store.ts). */
  pins: DevicePins;
};

/** A Done or Reopen asked from this list, shown until its computer answers (`doneAt` null: reopened). */
export type DoneMark = { doneAt: number | null };

/** A Chat as a pending Done or Reopen shows it. */
export function withDoneMark(chat: AgentSession, mark: DoneMark | undefined): AgentSession {
  if (!mark || Boolean(mark.doneAt) === Boolean(chat.done_at)) return chat;
  return mark.doneAt ? { ...chat, done_at: mark.doneAt, unread: false } : { ...chat, done_at: undefined };
}

/** The Filters menu's Show choices: which Chats the list keeps. */
export type Show = "all" | "needs" | "running" | "archived";
/** In the Tree layout, a Link's member Project and a shared Worktree's Chats sit this far in. */
export const TREE_INDENT = 16;
export const NEEDS = new Set<ChatMark>(["question", "waiting", "interrupted", "failed", "unread"]);

export const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** One computer's Projects with their Chats under the search: the part of the list that only changes with that computer. */
export function buildHost(view: HostView, ctx: BuildContext): HostBuild {
  const projects: ProjectBuild[] = [];
  for (const project of view.projects) if (!project.hidden && project.path !== view.home?.path) projects.push(buildProject(view, project, ctx));
  // The Chats home is listed in the drawer's Chats group only, never as a Project; it has no branch or PR to read.
  const home = view.home?.exists ? buildProject(view, { path: view.home.path, name: NO_PROJECT_LABEL }, ctx, true) : undefined;
  return {
    hostId: view.hostId,
    hostName: view.name,
    reach: view.state,
    projects,
    home,
    loaded: view.loaded,
  };
}

/** One Project's Chats, newest first, with what the search and the Show filter keep of them. */
export function buildProject(view: HostView, project: RecentProject, ctx: BuildContext, home = false): ProjectBuild {
  const current = view.hostId === ctx.currentHostId;
  const saved =
    current && ctx.snapshot && project.path === ctx.snapshot.project.path
      ? ctx.snapshot
      : (view.copies.get(project.path) ?? (current ? ctx.fallback(project.path) : undefined));
  const previews = Object.values(ctx.pendingChats).filter((item) => item.hostId === view.hostId && item.projectPath === project.path);
  const projected = saved && previews.reduce((state, item) => withPendingChat(state, item.preview), saved.project.state);
  const copy = saved && projected ? { ...saved, project: { ...saved.project, state: projected } } : saved;
  const pendingById = new Map(
    previews.map((item) => [saved ? (pendingChatSessionId(saved.project.state, item.preview) ?? item.preview.session.id) : item.preview.session.id, item]),
  );
  const name = project.name || project.path.split("/").at(-1) || "Project";
  // Keep message lookup linear even in large Projects.
  const byChat = new Map<number, NonNullable<typeof copy>["project"]["state"]["messages"]>();
  for (const message of copy?.project.state.messages || []) {
    const list = byChat.get(message.session_id) || [];
    list.push(message);
    byChat.set(message.session_id, list);
  }
  const entries = Object.values(copy ? sessionsWithPins(copy.project.state.sessions, copy.project.path, ctx.pins) : {}).map((saved) => {
    const chat = withSnoozeMark(withDoneMark(saved, ctx.doneMark(project.path, saved.id)), ctx.snoozeMark(project.path, saved.id));
    const run = copy?.runs.runs[`${copy.project.path}#${chat.id}`];
    const pending = pendingById.get(chat.id);
    const messages = byChat.get(chat.id);
    return {
      chat,
      run,
      title: chatTitle(chat, messages),
      sortId: chatSummary(chat, messages).firstId ?? chat.id,
      pending,
      mark: pending && !pending.accepted ? ("running" as const) : chatMark(chat, run, messages || []),
      // How many background agents still work, for a background mark (chat-activity.mjs).
      background: chatActivity(chat, run).background,
      count: chatSummary(chat, messages).count,
    };
  });
  const toEntry = ({ chat, title, sortId, pending, mark, background }: (typeof entries)[number]): ChatEntry => ({
    chat,
    title,
    sortId,
    mark,
    background,
    pending,
    worktree: pending?.newWorktree ? "New Worktree" : copy?.project.state.worktrees[chat.worktree_id]?.name || "Worktree",
    worktreePath: pending?.newWorktree ? undefined : copy?.project.state.worktrees[chat.worktree_id]?.path,
    prPath: !pending && !copy?.project.link && !home ? copy?.project.state.worktrees[chat.worktree_id]?.path : undefined,
    prRefs: chat.summary?.pullRequests ?? copy?.project.pullRequestRefs?.[chat.id] ?? pullRequestRefs(byChat.get(chat.id) || []),
  });
  // Done Chats leave the list for the Done section at its bottom (only the Archived filter lists them, once archived).
  const done =
    ctx.show === "all"
      ? entries
          .filter(({ chat }) => chat.done_at && !chat.archived && !ctx.archiving(copy?.project.path ?? project.path, chat.id))
          .filter(({ chat }) => !ctx.hidden(copy?.project.path ?? project.path, chat.id))
          .map(toEntry)
      : [];
  // Snoozed Chats leave it too, for the Snoozed section above Done, until they wake.
  const now = Date.now();
  const snoozed =
    ctx.show === "all"
      ? entries
          .filter(({ chat }) => isSnoozed(chat, now) && !ctx.archiving(copy?.project.path ?? project.path, chat.id))
          .filter(({ chat }) => !ctx.hidden(copy?.project.path ?? project.path, chat.id))
          .map(toEntry)
      : [];
  const all: ChatEntry[] = entries
    // Like desktop's sidebar, a worktree's empty starter Chat stays out until it has a message or a turn is starting.
    // A Chat stays in its place while its archive runs, under the progress, until the archive ends.
    .filter(({ chat, run, count, mark }) => {
      if (ctx.hidden(copy?.project.path ?? project.path, chat.id)) return false;
      if (ctx.show === "archived") return !!chat.archived && shownChat(chat, run, count, { archived: true });
      if (chat.archived && !ctx.archiving(copy?.project.path ?? project.path, chat.id)) return false;
      if (!shownChat(chat, run, count, { archived: false })) return false;
      if (chat.done_at && !chat.archived) return false;
      if (isSnoozed(chat, now)) return false;
      if (ctx.show === "needs") return NEEDS.has(mark);
      if (ctx.show === "running") return mark === "running" || mark === "background";
      return true;
    })
    // Pinned Chats first in their order, then the newest Chat first, by when it was created, so rows don't jump around as agents reply.
    .sort((a, b) => comparePins(a.chat, b.chat) || b.sortId - a.sortId)
    .map(toEntry);
  const chats = ctx.needle
    ? all.filter(({ title, worktree }) => [name, title, worktree, view.name].some((text) => text?.toLowerCase().includes(ctx.needle)))
    : all;
  return {
    path: project.path,
    name,
    ...(project.origin ? { origin: project.origin } : {}),
    link: !!project.link,
    members: project.projects,
    copy,
    all,
    chats,
    done,
    snoozed,
    failure: view.errors.get(project.path),
  };
}
