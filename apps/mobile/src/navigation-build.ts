import { isSnoozed } from "@milagre/shared/snooze";
import { withSnoozeMark, type SnoozeMark } from "./snooze-actions";
import { chatSummary } from "@milagre/shared/chat-summary";
import type { Href } from "expo-router";
import { chatTitle, comparePins, ownsWorktree, pendingChatSessionId, pullRequestRefs, withPendingChat } from "@milagre/shared/chats";
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
import { foldTabRows, type FoldedTabs } from "./workspace-tabs-kinds";

export type Destination = (href: Href, secondary?: boolean | "sheet") => void;
type HostTag = { hostId: string; hostName: string; reach: Reach };
export type Row = { key: string; path: string } & (
  | ({
      kind: "project";
      name: string;
      expanded: boolean;
      members?: RegisteredProject[];
      link: boolean;
      chip: boolean;
      count: number;
      member?: boolean;
    } & HostTag)
  | ({
      kind: "worktree";
      name: string;
      running: boolean;
    } & HostTag)
  | ({
      kind: "projectHit";
      name: string;
      members?: RegisteredProject[];
      many: boolean;
    } & HostTag)
  | { kind: "start"; query: string }
  | { kind: "settingHit"; title: string; trail: string; page: SettingsRoute; find?: string }
  | { kind: "section"; name: string }
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
      project: string;
      members?: RegisteredProject[];
      worktree: string;
      mark: ChatMark;
      background?: number;
      pending?: MobilePendingChat;
      prPath?: string;
      prRefs?: string[];
      /** The Chat has its Worktree to itself, so the Worktree branch's PR is its own (ownsWorktree). */
      ownsWorktree?: boolean;
      pullRequests?: PullRequest[];
      linearIssue?: LinearIssue;
      linked?: string[];
      many: boolean;
      home?: boolean;
      shared?: boolean;
      indent?: number;
      folded?: FoldedTabs;
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
  | { kind: "offline"; hostIds: string[] }
  | { kind: "snoozedHeader"; count: number; expanded: boolean }
  | ({
      kind: "snoozed";
      chat: AgentSession;
      title: string;
      many: boolean;
      home?: boolean;
    } & HostTag)
  | { kind: "doneHeader"; count: number; expanded: boolean }
  | ({
      kind: "done";
      chat: AgentSession;
      title: string;
      many: boolean;
      home?: boolean;
    } & HostTag)
);
export type ChatRow = Extract<Row, { kind: "chat" }>;
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
  worktreePath?: string;
  prPath?: string;
  prRefs: string[];
  ownsWorktree?: boolean;
  /** With Workspace tabs on, the Chats this row stands for besides its own, which live only as tabs. */
  folded?: FoldedTabs;
};
export type ProjectBuild = {
  path: string;
  name: string;
  origin?: string;
  link: boolean;
  members?: RegisteredProject[];
  copy?: ProjectCopy;
  /** Every listed Chat, tab Chats included, which search reaches. */
  all: ChatEntry[];
  chats: ChatEntry[];
  done: ChatEntry[];
  snoozed: ChatEntry[];
  failure?: string;
};
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
  hidden: (projectPath: string, chatId: number) => boolean;
  doneMark: (projectPath: string, chatId: number) => DoneMark | undefined;
  snoozeMark: (projectPath: string, chatId: number) => SnoozeMark | undefined;
  fallback: (path: string) => ProjectCopy | undefined;
  show: Show;
  pins: DevicePins;
  tabs: boolean;
};

export type DoneMark = { doneAt: number | null };

function withDoneMark(chat: AgentSession, mark: DoneMark | undefined): AgentSession {
  if (!mark || Boolean(mark.doneAt) === Boolean(chat.done_at)) return chat;
  return mark.doneAt ? { ...chat, done_at: mark.doneAt, unread: false } : { ...chat, done_at: undefined };
}

export type Show = "all" | "needs" | "running" | "archived";
const NEEDS = new Set<ChatMark>(["question", "waiting", "interrupted", "failed", "unread"]);

export const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function buildHost(view: HostView, ctx: BuildContext): HostBuild {
  const projects: ProjectBuild[] = [];
  for (const project of view.projects) if (!project.hidden && project.path !== view.home?.path) projects.push(buildProject(view, project, ctx));
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

function buildProject(view: HostView, project: RecentProject, ctx: BuildContext, home = false): ProjectBuild {
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
      background: chatActivity(chat, run).background,
      count: chatSummary(chat, messages).count,
    };
  });
  type Listed = (typeof entries)[number] & { folded?: FoldedTabs };
  const toEntry = ({ chat, title, sortId, pending, mark, background, folded }: Listed): ChatEntry => ({
    ...(folded ? { folded } : {}),
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
    ownsWorktree: copy ? ownsWorktree(copy.project.state, chat.id, copy.project.path) : false,
  });
  const done =
    ctx.show === "all"
      ? entries
          .filter(({ chat }) => chat.done_at && !chat.archived && !ctx.archiving(copy?.project.path ?? project.path, chat.id))
          .filter(({ chat }) => !ctx.hidden(copy?.project.path ?? project.path, chat.id))
          .map(toEntry)
      : [];
  const now = Date.now();
  const snoozed =
    ctx.show === "all"
      ? entries
          .filter(({ chat }) => isSnoozed(chat, now) && !ctx.archiving(copy?.project.path ?? project.path, chat.id))
          .filter(({ chat }) => !ctx.hidden(copy?.project.path ?? project.path, chat.id))
          .map(toEntry)
      : [];
  const listed = entries.filter(({ chat, run, count }) => {
    if (ctx.hidden(copy?.project.path ?? project.path, chat.id)) return false;
    if (ctx.show === "archived") return !!chat.archived && shownChat(chat, run, count, { archived: true });
    if (chat.archived && !ctx.archiving(copy?.project.path ?? project.path, chat.id)) return false;
    if (!shownChat(chat, run, count, { archived: false })) return false;
    return !(chat.done_at && !chat.archived) && !isSnoozed(chat, now);
  });
  const rowsOf = (items: Listed[]) =>
    items
      .filter(({ mark }) => (ctx.show === "needs" ? NEEDS.has(mark) : ctx.show === "running" ? mark === "running" || mark === "background" : true))
      .sort((a, b) => comparePins(a.chat, b.chat) || b.sortId - a.sortId)
      .map(toEntry);
  const all = rowsOf(listed);
  const folds = ctx.tabs && ctx.show !== "archived" && copy;
  const rows = folds ? rowsOf(foldTabRows(listed, { path: copy.project.path, link: !!copy.project.link, worktrees: copy.project.state.worktrees })) : all;
  const titles = folds ? new Map(entries.map(({ chat, title }) => [chat.id, title])) : undefined;
  const chats = ctx.needle
    ? rows.filter(({ title, worktree, folded }) =>
        [name, title, worktree, view.name, ...(folded?.chats.map((id) => titles?.get(id)) ?? [])].some((text) => text?.toLowerCase().includes(ctx.needle)),
      )
    : rows;
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
