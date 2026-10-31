import { ChatSwipeRow, hideRevealed } from "./chat-swipe-row";
import { retentionOf, useDoneRetention } from "./done-retention";
import { doneCountdown } from "@milagre/shared/done";
import { chatSummary } from "@milagre/shared/chat-summary";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import { appVersionLine } from "./app-version";
import * as Clipboard from "expo-clipboard";
import type { Href } from "expo-router";
import {
  Add01Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  HourglassIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CloudOffIcon,
  ComputerIcon,
  GitBranchIcon,
  LaptopIcon,
  Link04Icon,
  MoreHorizontalIcon,
  PinIcon,
  PencilEdit02Icon,
  RepeatIcon,
  SearchRemoveIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";
import { chatMarkTone, chatPullRequests, chatTitle, comparePins, pendingChatSessionId, pullRequestRefs, withPendingChat } from "@milagre/shared/chats";
import { searchMessages } from "@milagre/shared/message-search";
import { unreadRunRoutines } from "@milagre/shared/routines";
import type { AgentSession, PullRequest } from "@milagre/shared/model";
import type { LinearIssue } from "@milagre/shared/linear";
import type { ChatSearchMatch, Client, RecentProject, RegisteredProject, Snapshot } from "./client";
import { ALL_CHATS_LABEL, CHATS_GROUP_LABEL, NO_PROJECT_LABEL } from "@milagre/shared/chats-home";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { undoDelete } from "@milagre/shared/archive";
import { useComposer, useListSnapshot, usePendingChats, useSession, type MobilePendingChat, type Session } from "./session";
import { savedChatDefaults, savedFoldedProjects } from "./hosts-native";
import { newChatProjects, noProjectChoice, pickNewChatProject } from "./new-chat-project";
import { chatsGroupChats, chatsGroupList, chatsGroupNeedsAttention, chatsRowDetail } from "./chats-group";
import { UpdateSettingsBadge } from "./update-sheet";
import { useLinks } from "./use-links";
import { useRoutinesAvailable } from "./use-routines";
import { endNamer, linkMenuSection, linkWorktree, linkedAccessibilityLabel, linkedLabels, type LinkChat } from "./chat-links";
import { linkWithChat, removeLinkFromChat } from "./link-actions";
import { afterSend, selectedModel, sendOptions, turnTarget } from "./turn-options";
import { chatMark, type ChatMark } from "./indicators";
import { shownChat } from "./chat-list-filter";
import { backgroundLabel, chatActivity } from "@milagre/shared/chat-activity";
import { ChatMarkIcon } from "./status-indicators";
import { Icon, SpinnerRing, type IconData } from "./icons";
import { tap } from "./primitives/tap";
import { LoadingLogo } from "./loading-logo";
import { ErrorNotice, IconButton, PullDown, useStyles } from "./ui";
import { HoverView } from "./primitives/hover";
import { subscribeNavigation, takeNavigation, type NavigationCommand } from "./navigation-commands";
import { ChatsHomeIcon, ProjectIcon, ProjectIcons } from "./project-icon";
import { ProjectSearch } from "./project-search";
import { chatMenu, runChatAction } from "./chat-actions";
import { useSplitLayout } from "./split-context";
import { canOpenBeside, openBeside, useBesideChat } from "./split-chats";
import { confirm } from "./confirm-store";
import { showChoiceSheet } from "./choice-store";
import { ArchivingOverlay, useArchiveActivity } from "./archive-progress";
import { clearArchiveNotice, deletionKey, showArchiveNotice } from "./archive";
import { ToastPill } from "./primitives/toast";
import { AttentionDot, useAttention } from "./attention";
import { lastUserModel, projectOfKey } from "@milagre/shared/agent-runs";
import { useComputerChatPullRequests, type ComputerPullRequestTargets } from "./use-chat-pull-requests";
import { ChatPullRequestChips, InlinePullRequestLinks } from "./chat-pull-request-chips";
import { requestPullRequest } from "./pr-chat";
import { useLinear } from "./use-linear";
import { useWorktreeLinearIssues } from "./use-worktree-linear-issues";
import { createStylesHook, useTheme, type Palette } from "./theme";
import { activityAgo, CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { saveChatRowShow, useActivityClock, useChatRowShow } from "./chat-row-store";
import { useChatList } from "./chat-display-setting";
import { allComputers, chatsHomePath, useAllComputers, useFoldedProjects } from "./all-computers";
import type { HostView, ProjectCopy, Reach } from "./all-computers-store";
import { mergeChatLists } from "./chat-list-order";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { ChatListControls, useControlsBottomInset, useControlsVisibility } from "./chat-list-controls";
import { isDesktopComputer } from "./computer-actions";
import { WaitingLabel } from "./offline-tray";
import { SENT_FROM } from "./sent-from";
import { nestChatRows, type SubchatMarks } from "./subchat-rows";

/** Secondary screens push over the current one; a sheet also leaves the sidebar open under it, as confirmations do. */
type Destination = (href: Href, secondary?: boolean | "sheet") => void;
/** The computer a row belongs to: every row and every action carries it, since two computers can share a path and a Chat id. */
type HostTag = { hostId: string; hostName: string; reach: Reach };
type Row = { key: string; path: string } & (
  | ({ kind: "project"; name: string; expanded: boolean; members?: RegisteredProject[]; link: boolean; chip: boolean; count: number } & HostTag)
  /** A Project whose name matches the search: a tap starts a new Chat in it. */
  | ({ kind: "projectHit"; name: string; members?: RegisteredProject[]; many: boolean } & HostTag)
  /** Nothing matched the search: start a new Chat with it. */
  | { kind: "start" }
  | { kind: "section"; name: string }
  /** The Chats group's header: every computer's Chats without a Project, above the Projects. */
  | { kind: "chatsGroup"; expanded: boolean; count: number; offline: boolean; homes: { hostId: string; path: string }[] }
  /** The line between the Chats group and the flat list of the Projects' Chats. */
  | { kind: "divider" }
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
    } & SubchatMarks &
      HostTag)
  | ({ kind: "message"; chat: AgentSession; title: string; project: string; many: boolean; snippet: string; highlight: [number, number] } & HostTag)
  | ({ kind: "notice"; message: string; failed?: boolean; retry?: "project" } & HostTag)
  /** The one quiet line for every computer that isn't answering; Retry reads those computers again. */
  | { kind: "offline"; hostIds: string[] }
  /** The Done section's header at the bottom of the list: a tap folds it. */
  | { kind: "doneHeader"; count: number; expanded: boolean }
  /** A Done Chat: a tap opens it, a swipe right reopens it, and it counts down to its Mac's archive. `many`: name its computer. */
  | ({ kind: "done"; chat: AgentSession; title: string; many: boolean; home?: boolean } & HostTag)
);
type ChatRow = Extract<Row, { kind: "chat" }>;
/** One Project's Chats as the search reads them: its messages, or null when its computer searches them. */
type SearchScope = HostTag & {
  path: string;
  project: string;
  messages: NonNullable<ProjectBuild["copy"]>["project"]["state"]["messages"] | null;
  chats: Map<number, { chat: AgentSession; title: string }>;
};
type ChatEntry = {
  chat: AgentSession;
  title: string;
  sortId: number;
  mark: ChatMark;
  background: number;
  pending?: MobilePendingChat;
  worktree: string;
  prPath?: string;
  prRefs: string[];
};
type ProjectBuild = {
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
  failure?: string;
};
/** `home`: the computer's Chats without a Project, once its Chats home exists. */
type HostBuild = HostTag & { projects: ProjectBuild[]; home?: ProjectBuild; loaded: boolean };
type BuildContext = {
  needle: string;
  currentHostId?: string;
  snapshot: Snapshot | null;
  pendingChats: Record<string, MobilePendingChat>;
  archiving: (projectPath: string, chatId: number) => boolean;
  /** Deleted from the phone and not back (an Undo or a failure brings it back): out of the list. */
  hidden: (projectPath: string, chatId: number) => boolean;
  /** Marked Done (a time) or reopened (null) from here, before its computer has answered: the row moves at once. */
  doneMark: (projectPath: string, chatId: number) => DoneMark | undefined;
  fallback: (path: string) => ProjectCopy | undefined;
  show: Show;
};

/** A Done or Reopen asked from this list, shown until its computer answers (`doneAt` null: reopened). */
type DoneMark = { doneAt: number | null };

/** A Chat as a pending Done or Reopen shows it. */
function withDoneMark(chat: AgentSession, mark: DoneMark | undefined): AgentSession {
  if (!mark || Boolean(mark.doneAt) === Boolean(chat.done_at)) return chat;
  return mark.doneAt ? { ...chat, done_at: mark.doneAt, unread: false } : { ...chat, done_at: undefined };
}

/** The Filters menu's Show choices: which Chats the list keeps. */
type Show = "all" | "needs" | "running" | "archived";
const SHOW: [Show, string, string][] = [
  ["all", "All Chats", "bubble.left.and.bubble.right"],
  ["needs", "Needs me", "exclamationmark.bubble"],
  ["running", "Running", "play.circle"],
  ["archived", "Archived", "archivebox"],
];
const NEEDS = new Set<ChatMark>(["question", "waiting", "interrupted", "failed", "unread"]);
// What a Chat row can show under its title (the Filters menu's "On chats"); the computer is a desktop choice.
const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");
const FIELD_SYMBOLS: Record<string, string> = {
  pullRequests: "arrow.triangle.pull",
  linearIssue: "ticket",
  branch: "arrow.triangle.branch",
  diff: "plusminus",
  lastActivity: "clock",
};
const labels: Record<ChatMark, string> = {
  idle: "",
  running: "Running",
  background: "In the background",
  question: "Needs reply",
  waiting: "Needs approval",
  interrupted: "Interrupted",
  failed: "Failed",
  unread: "Unread",
};

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** One computer's Projects with their Chats under the search: the part of the list that only changes with that computer. */
function buildHost(view: HostView, ctx: BuildContext): HostBuild {
  const projects: ProjectBuild[] = [];
  for (const project of view.projects) if (!project.hidden && project.path !== view.home?.path) projects.push(buildProject(view, project, ctx));
  // The Chats home is listed in the drawer's Chats group only, never as a Project; it has no branch or PR to read.
  const home = view.home?.exists ? buildProject(view, { path: view.home.path, name: NO_PROJECT_LABEL }, ctx, true) : undefined;
  return { hostId: view.hostId, hostName: view.name, reach: view.state, projects, home, loaded: view.loaded };
}

/** One Project's Chats, newest first, with what the search and the Show filter keep of them. */
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
  // Keep message lookup linear even in large Projects.
  const byChat = new Map<number, NonNullable<typeof copy>["project"]["state"]["messages"]>();
  for (const message of copy?.project.state.messages || []) {
    const list = byChat.get(message.session_id) || [];
    list.push(message);
    byChat.set(message.session_id, list);
  }
  const entries = Object.values(copy?.project.state.sessions || {}).map((saved) => {
    const chat = withDoneMark(saved, ctx.doneMark(project.path, saved.id));
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
    worktree: pending?.newWorktree ? "New worktree" : copy?.project.state.worktrees[chat.worktree_id]?.name || "Worktree",
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
  const all: ChatEntry[] = entries
    // Like desktop's sidebar, a worktree's empty starter Chat stays out until it has a message or a turn is starting.
    // A Chat stays in its place while its archive runs, under the progress, until the archive ends.
    .filter(({ chat, run, count, mark }) => {
      if (ctx.hidden(copy?.project.path ?? project.path, chat.id)) return false;
      if (ctx.show === "archived") return !!chat.archived && shownChat(chat, run, count, { archived: true });
      if (chat.archived && !ctx.archiving(copy?.project.path ?? project.path, chat.id)) return false;
      if (!shownChat(chat, run, count, { archived: false })) return false;
      if (chat.done_at && !chat.archived) return false;
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
    failure: view.errors.get(project.path),
  };
}

/** The same project tree is the first-run destination and the drawer over a Chat: every computer's Chats, their ⋯ actions and search. */
type NavigationProps = {
  onNavigate: Destination;
  onClose?: () => void;
  activeChatId?: number;
  /** False while the sidebar is mounted but off screen: nothing is read from the computers then. */
  visible?: boolean;
  /** Pinned beside the Chat on a wide iPad: it never closes, and its `onNavigate` skips the Chat already open. */
  docked?: boolean;
  /** Drawn on a card's surface color (the pinned sidebar and the one sliding over) instead of the page's. */
  surface?: boolean;
};
/** What the list reads from the session, held as it was while the list is off screen. */
type Watched = { session: Session; snapshot: Snapshot | null; pendingChats: Record<string, MobilePendingChat> };
/** The last value it was given while `live`: a sidebar off screen keeps what it showed, so nothing under it re-renders. */
class Held<T> {
  private value: { current: T } | null = null;
  pick(live: boolean, value: T): T {
    if (live || !this.value) this.value = { current: value };
    return this.value.current;
  }
}
/**
 * The sidebar stays mounted under the Chat once it has opened. Off screen (`visible` false) it renders what it last
 * showed: the session's changes (a Project read, a turn's runs, a keystroke in the composer) reach it once it shows again,
 * which is when it wakes after sliding in (side-panels.tsx), so no render lands on the slide's frames.
 */
/** A Done row's menu: it only leaves Done. */
const DONE_MENU = [{ items: [{ id: "reopen", title: "Reopen", systemImage: "arrow.uturn.backward" }] }];

export function ProjectNavigation(props: NavigationProps) {
  const session = useSession();
  // Only what the rows show of the turns: a streaming turn doesn't re-render the list, its start, question or end does.
  const snapshot = useListSnapshot();
  const { pendingChats } = usePendingChats();
  // The composer changes on every keystroke; the list reads it only when "Link and ask" sends.
  const composer = useComposer();
  const latestComposer = useRef(composer);
  useLayoutEffect(() => {
    latestComposer.current = composer;
  }, [composer]);
  const readComposer = useCallback(() => latestComposer.current, []);
  const [held] = useState(() => new Held<Watched>());
  const watched = held.pick(props.visible ?? true, { session, snapshot, pendingChats });
  return <NavigationBody {...props} session={watched.session} snapshot={watched.snapshot} pendingChats={watched.pendingChats} readComposer={readComposer} />;
}

type BodyProps = NavigationProps & Watched & { readComposer: () => ReturnType<typeof useComposer> };
const NavigationBody = memo(function NavigationBody({
  onNavigate,
  onClose,
  activeChatId,
  visible = true,
  docked = false,
  surface = docked,
  session,
  snapshot,
  pendingChats,
  readComposer,
}: BodyProps) {
  const s = useS();
  const { colors } = useTheme();
  const styles = useStyles();
  const links = useLinks(session.client);
  // An older Mac or a confined phone has no Routines to show, so the dock leaves the button out.
  const routinesAvailable = useRoutinesAvailable(session.client);
  const insets = useSafeAreaInsets();
  const attention = useAttention();
  const { reloadProjects, cachedProject } = session;
  const currentPath = snapshot?.project.path;
  const currentHostId = session.client?.url;
  // A wide iPad can open another Chat, of any Project on any computer that answers, beside the open one.
  const wide = useSplitLayout().widthClass === "wide";
  const beside = useBesideChat();
  const [savedChatList] = useChatList();
  // The chooser must list Projects and Links even when they have no Chats yet.
  const chatList = currentPath ? savedChatList : "grouped";
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const searching = !!needle;
  const [show, setShow] = useState<Show>("all");
  // Searching or a Show filter reads every Project, folded or not.
  const views = useAllComputers({ visible, expandAll: chatList === "list" || searching || show !== "all" });
  const folds = useFoldedProjects(views.map((view) => view.hostId));
  const rowShow = useChatRowShow();
  // Last activity reads "5m"; the clock ticks only while the rows show it, which a Chats group row always does.
  // The Done section starts folded and stays as the user left it while the app runs.
  const [doneOpen, setDoneOpen] = useState(false);
  // An open Done section counts down to each Chat's archive, so the clock ticks then too.
  const now = useActivityClock(rowShow.lastActivity || doneOpen || views.some((view) => view.home?.exists));
  // The Chats group folds for as long as the app runs; it isn't one computer's, so the per-computer folds don't hold it.
  const [chatsFolded, setChatsFolded] = useState(false);
  // Folded subchat families, by the parent row's key, for as long as the app runs (subchat-rows.ts).
  const [subchatFolds, setSubchatFolds] = useState<ReadonlySet<string>>(() => new Set());
  // Done and Reopen asked from this list, by `<computer>|<project>#<chat>`: the row moves before its computer answers.
  const [doneMarks, setDoneMarks] = useState<ReadonlyMap<string, DoneMark>>(() => new Map());
  // The last Chat marked Done from this list, for the toast's Undo.
  const [doneToast, setDoneToast] = useState<{ row: { hostId: string; path: string; chat: AgentSession }; at: number } | null>(null);
  const [page, setPage] = useState<"add" | null>(null);
  const [addHostId, setAddHostId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const archives = useArchiveActivity();
  // The Chats this sidebar is archiving, by computer: another computer's Chat with the same path and id is not archiving.
  const [archiveRequests] = useState(() => new Set<string>());
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const controls = useControlsVisibility();
  const bottomInset = useControlsBottomInset();
  const searchInput = useRef<TextInputInstance>(null);
  const background = surface ? colors.surface : colors.page;
  // On a card the open Chat's row takes the stronger tint, so a row under the pointer still reads apart from it.
  const selectedFill = surface ? colors.hover2 : colors.hover;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (visible) void reloadProjects().catch((e) => setError(e.message));
  }, [reloadProjects, visible]);

  const currentClient = session.client;
  const clientOf = useCallback(
    (hostId: string): Client | null => (hostId === currentClient?.url ? currentClient : allComputers.clientFor(hostId)),
    [currentClient],
  );
  // The copy of a Project this list reads: the open one's snapshot (its runs as the rows read them: whether each Chat
  // runs, asks or waits), otherwise the last answer of its computer.
  const copyOf = useCallback(
    (hostId: string, projectPath: string): ProjectCopy | undefined =>
      hostId === currentHostId && projectPath === currentPath && snapshot
        ? snapshot
        : (allComputers.viewOf(hostId)?.copies.get(projectPath) ?? (hostId === currentHostId ? cachedProject(projectPath) : undefined)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- views changes exactly when a computer's copies do.
    [currentHostId, currentPath, snapshot, cachedProject, views],
  );
  const load = (hostId: string, projectPath: string): Promise<unknown> =>
    hostId === currentHostId && projectPath === currentPath ? session.refresh() : allComputers.refreshProject(hostId, projectPath).catch(() => {});

  // Each computer's rows are rebuilt only when that computer's data, the search or what it overlays changes.
  const [cache] = useState(() => new Map<string, { deps: unknown[]; build: HostBuild }>());
  const builds = useMemo(() => {
    const archiving = (hostId: string) => (projectPath: string, chatId: number) =>
      archives.chats.has(`${projectPath}#${chatId}`) && (hostId === currentHostId || archiveRequests.has(`${hostId}|${projectPath}#${chatId}`));
    const next = views.map((view) => {
      const current = view.hostId === currentHostId;
      const deps = [
        view,
        needle,
        show,
        pendingChats,
        archives.chats,
        archives.hidden,
        doneMarks,
        current ? snapshot : null,
        current ? cachedProject : null,
        current,
      ];
      const held = cache.get(view.hostId);
      if (held && sameDeps(held.deps, deps)) return held.build;
      const build = buildHost(view, {
        needle,
        currentHostId,
        snapshot,
        pendingChats,
        archiving: archiving(view.hostId),
        hidden: (projectPath, chatId) => archives.hidden.has(deletionKey(view.hostId, `${projectPath}#${chatId}`)),
        doneMark: (projectPath, chatId) => (doneMarks.size ? doneMarks.get(`${view.hostId}|${projectPath}#${chatId}`) : undefined),
        fallback: cachedProject,
        show,
      });
      cache.set(view.hostId, { deps, build });
      return build;
    });
    for (const id of cache.keys()) if (!views.some((view) => view.hostId === id)) cache.delete(id);
    return next;
  }, [views, needle, show, pendingChats, archives.chats, archives.hidden, doneMarks, snapshot, cachedProject, currentHostId, cache, archiveRequests]);

  const manyHosts = builds.length > 1;
  const { rows, searchable, projectHits } = useMemo(() => {
    const result: Row[] = [];
    // Each Project's Chats under the search, for the Messages section: every computer's, like desktop's ⌘K.
    const found: SearchScope[] = [];
    const chatRow = (build: HostBuild, project: ProjectBuild, entry: ChatEntry): ChatRow => ({
      key: `${build.hostId}|${project.path}#${entry.chat.id}`,
      path: project.path,
      kind: "chat",
      hostId: build.hostId,
      hostName: build.hostName,
      reach: build.reach,
      project: project.name,
      members: project.members,
      many: manyHosts,
      ...entry,
    });
    // An offline computer has no row of its own: its Chats stay listed dimmed, and `offlineLine` counts it.
    const hostNotice = (build: HostBuild): Row | null => {
      const noData = !build.projects.some((project) => project.copy);
      if (build.reach !== "offline" && noData && (!build.loaded || build.projects.length))
        return {
          key: `notice:${build.hostId}`,
          path: "",
          kind: "notice",
          hostId: build.hostId,
          hostName: build.hostName,
          reach: build.reach,
          message: `Loading chats from ${build.hostName}...`,
        };
      return null;
    };
    // A Project several computers share: one row, on the first computer that answers (its + and menu go there), then
    // every copy's Chats in one list, then each copy's own notice.
    const sharedProject = (copies: { build: HostBuild; project: ProjectBuild }[]): Row[] => {
      if (show !== "all" && copies.every(({ project }) => project.copy && !project.chats.length && !project.failure)) return [];
      const head = copies.find(({ build }) => build.reach !== "offline") ?? copies[0]!;
      const open = !folds.get(head.build.hostId)?.has(head.project.path);
      const listed: Row[] = [
        {
          key: `${head.build.hostId}|${head.project.path}`,
          path: head.project.path,
          kind: "project",
          hostId: head.build.hostId,
          hostName: head.build.hostName,
          reach: copies.every(({ build }) => build.reach === "offline") ? "offline" : head.build.reach,
          name: head.project.name,
          expanded: open,
          members: head.project.members,
          link: head.project.link,
          chip: false,
          count: copies.reduce((sum, { project }) => sum + project.chats.length, 0),
        },
      ];
      if (!open) return listed;
      listed.push(
        ...mergeChatLists(
          copies.map(({ build, project }, rank) =>
            project.chats.map((entry) => ({ rank, chat: entry.chat, row: { ...chatRow(build, project, entry), shared: true } })),
          ),
        ).map(({ row }) => row),
      );
      for (const { build, project } of copies) {
        if (build.reach === "offline" && (project.failure || !project.copy)) continue;
        const base = {
          path: project.path,
          kind: "notice" as const,
          hostId: build.hostId,
          hostName: build.hostName,
          reach: build.reach,
          retry: "project" as const,
        };
        if (project.failure)
          listed.push({
            ...base,
            key: `${build.hostId}|${project.path}:error`,
            message: `Could not ${project.copy ? "refresh" : "load"} chats on ${build.hostName}. Tap to retry.`,
            failed: true,
          });
        else if (!project.copy) listed.push({ ...base, key: `${build.hostId}|${project.path}:notice`, message: `Loading chats from ${build.hostName}...` });
      }
      if (listed.length === 1)
        listed.push({
          key: `${head.build.hostId}|${head.project.path}:notice`,
          path: head.project.path,
          kind: "notice",
          hostId: head.build.hostId,
          hostName: head.build.hostName,
          reach: head.build.reach,
          message: show !== "all" ? "No matching chats" : "No chats yet. Start one with +.",
        });
      return listed;
    };
    const offlineIds = builds.filter((build) => build.reach === "offline").map((build) => build.hostId);
    const offlineLine: Row[] = offlineIds.length ? [{ key: "offline", path: "", kind: "offline", hostIds: offlineIds }] : [];
    // Every computer's Chats without a Project in one list, newest first, above the Projects. With none, no group.
    const homeRows = chatsGroupChats(
      builds.flatMap((build) => {
        const home = build.home;
        return home ? [{ hostId: build.hostId, chats: home.chats.map((entry): ChatRow => Object.assign(chatRow(build, home, entry), { home: true })) }] : [];
      }),
    ).map(({ entry }) => entry);
    const chatsList = chatsGroupList({
      computers: builds.length,
      rows: homeRows,
      folded: chatsFolded,
      // Each computer's home, so a Chat waiting in a folded group still marks it.
      homes: builds.flatMap((build) => (build.home ? [{ hostId: build.hostId, path: build.home.path }] : [])),
    });
    const chatsGroup: Row[] = chatsList ? [{ key: "chats-group", path: "", ...chatsList.header }, ...chatsList.rows] : [];
    // A search lists like ⌘K whichever way the list is set: matching Chats, then Messages and Projects below.
    if (needle || chatList === "list") {
      let rank = 0;
      // A search finds Chats without a Project too; the list without one shows them in the Chats group instead.
      const lists = builds.flatMap((build) =>
        build.projects.concat(needle && build.home ? [build.home] : []).map((project) => {
          const mine = rank++;
          if (needle && project.copy)
            found.push({
              hostId: build.hostId,
              hostName: build.hostName,
              reach: build.reach,
              path: project.path,
              project: project.name,
              messages: project.copy.previewOnly || project.copy.project.state.messagesInChats ? null : project.copy.project.state.messages,
              chats: new Map(project.all.filter(({ pending }) => !pending).map(({ chat, title }) => [chat.id, { chat, title }])),
            });
          const home = project === build.home;
          return project.chats.map((entry) => ({
            rank: mine,
            chat: entry.chat,
            row: home ? { ...chatRow(build, project, entry), home } : chatRow(build, project, entry),
          }));
        }),
      );
      const chats = mergeChatLists(lists).map(({ row }) => row);
      if (needle && chats.length) result.push({ key: "section:Chats", path: "", kind: "section", name: "Chats" });
      if (!needle) {
        result.push(...chatsGroup);
        if (chatsGroup.length && chats.length) result.push({ key: "chats-divider", path: "", kind: "divider" });
      }
      result.push(...chats);
      for (const build of builds) {
        const notice = hostNotice(build);
        if (notice) result.push(notice);
      }
      if (!needle) result.push(...offlineLine);
    } else {
      result.push(...chatsGroup);
      // One repository on several computers (one Git origin) is one Project, in its first copy's place; its Chats merge
      // by time, each naming its computer.
      const shared = new Map<ProjectBuild, { build: HostBuild; project: ProjectBuild }[]>();
      for (const group of groupByOrigin(
        builds.flatMap((build) => build.projects.map((project) => ({ build, project, origin: project.origin, computerId: build.hostId }))),
      ))
        if (group.copies.length > 1) for (const copy of group.copies) shared.set(copy.project, group.copies);
      for (const build of builds) {
        // A computer that hasn't answered with its Projects has no group to carry its state.
        const notice = build.projects.length ? null : hostNotice(build);
        if (notice) result.push(notice);
        for (const project of build.projects) {
          const copies = shared.get(project);
          if (copies) {
            if (copies[0]!.project === project) result.push(...sharedProject(copies));
            continue;
          }
          const open = !folds.get(build.hostId)?.has(project.path);
          // A Show filter leaves out the Projects with nothing to show.
          if (show !== "all" && project.copy && !project.chats.length && !project.failure) continue;
          result.push({
            key: `${build.hostId}|${project.path}`,
            path: project.path,
            kind: "project",
            hostId: build.hostId,
            hostName: build.hostName,
            reach: build.reach,
            name: project.name,
            expanded: open,
            members: project.members,
            link: project.link,
            chip: manyHosts,
            count: project.chats.length,
          });
          if (!open) continue;
          for (const entry of project.chats) result.push(chatRow(build, project, entry));
          const base = {
            path: project.path,
            kind: "notice" as const,
            hostId: build.hostId,
            hostName: build.hostName,
            reach: build.reach,
            retry: "project" as const,
          };
          // An offline computer's failed and unread Projects are the offline line's business, not a notice each.
          if (build.reach === "offline" && (project.failure || !project.copy)) continue;
          if (project.failure)
            result.push({
              ...base,
              key: `${build.hostId}|${project.path}:error`,
              message: project.copy ? "Could not refresh chats. Tap to retry." : "Could not load chats. Tap to retry.",
              failed: true,
            });
          else if (!project.copy || !project.chats.length)
            result.push({
              ...base,
              key: `${build.hostId}|${project.path}:notice`,
              message: !project.copy ? "Loading chats..." : show !== "all" ? "No matching chats" : "No chats yet. Start one with +.",
            });
        }
      }
      result.push(...offlineLine);
    }
    // Projects whose name matches the search, opened as a new Chat in that Project.
    const hits: Row[] = needle
      ? builds.flatMap((build) =>
          build.projects
            .filter((project) => project.name.toLowerCase().includes(needle))
            .map((project) => ({
              key: `${build.hostId}|${project.path}:hit`,
              path: project.path,
              kind: "projectHit" as const,
              hostId: build.hostId,
              hostName: build.hostName,
              reach: build.reach,
              name: project.name,
              members: project.members,
              many: manyHosts,
            })),
        )
      : [];
    // Every computer's Done Chats in one section under the list, most recently marked first.
    if (!needle && show === "all") {
      const done = builds
        .flatMap((build) =>
          build.projects.concat(build.home ? [build.home] : []).flatMap((project) =>
            project.done.map((entry): Row => ({
              key: `done:${build.hostId}|${project.path}#${entry.chat.id}`,
              path: project.path,
              kind: "done",
              hostId: build.hostId,
              hostName: build.hostName,
              reach: build.reach,
              chat: entry.chat,
              title: entry.title,
              many: manyHosts,
              ...(project === build.home ? { home: true } : {}),
            })),
          ),
        )
        .sort((a, b) => ((b as { chat: AgentSession }).chat.done_at ?? 0) - ((a as { chat: AgentSession }).chat.done_at ?? 0));
      if (done.length) {
        result.push({ key: "done-header", path: "", kind: "doneHeader", count: done.length, expanded: doneOpen });
        if (doneOpen) result.push(...done);
      }
    }
    // A Show filter that leaves nothing says so, above the offline line.
    if (!needle && show !== "all" && !result.some((row) => row.kind === "chat"))
      result.unshift({ key: "filter-empty", path: "", kind: "section", name: "No chats match this filter." });
    return { rows: nestChatRows(result, subchatFolds), searchable: found, projectHits: hits };
  }, [builds, chatList, needle, show, manyHosts, folds, chatsFolded, doneOpen, subchatFolds]);
  // Projects held without their messages (a preview, or a host that keeps them by Chat) are searched on their own
  // computer's host.
  const [hostMatches, setHostMatches] = useState<{ query: string; matches: Record<string, ChatSearchMatch[]> }>({ query: "", matches: {} });
  const hostSearchKey = useMemo(
    () =>
      needle
        ? searchable
            .filter((item) => item.messages === null)
            .map((item) => `${item.hostId}\t${item.path}`)
            .join("\n")
        : "",
    [needle, searchable],
  );
  useEffect(() => {
    if (!needle || !hostSearchKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        hostSearchKey.split("\n").map(async (key) => {
          const [hostId = "", path = ""] = key.split("\t");
          const client = hostId === session.client?.url ? session.client : allComputers.clientFor(hostId);
          return [key, client ? await client.searchChats(path, needle).catch(() => []) : []] as const;
        }),
      ).then((found) => !cancelled && setHostMatches({ query: needle, matches: Object.fromEntries(found) }));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle, hostSearchKey, session.client]);
  // What was said in the Chats, at most three hits per Chat, then the matching Projects; with nothing at all, the row
  // that starts a new Chat with the search.
  const listRows = useMemo(() => {
    if (!needle) return rows;
    const found: Row[] = [];
    for (const { hostId, hostName, reach, path, project, messages, chats } of searchable) {
      const perChat = new Map<number, number>();
      const matches = messages ? searchMessages(messages, needle, 200) : hostMatches.query === needle ? (hostMatches.matches[`${hostId}\t${path}`] ?? []) : [];
      for (const match of matches) {
        const entry = chats.get(match.message.session_id);
        const count = perChat.get(match.message.session_id) ?? 0;
        if (!entry || count >= 3) continue;
        const { chat, title } = entry;
        perChat.set(chat.id, count + 1);
        found.push({
          key: `${hostId}|${path}#${chat.id}:message:${match.message.id}`,
          path,
          kind: "message",
          hostId,
          hostName,
          reach,
          chat,
          title,
          project,
          many: manyHosts,
          snippet: match.snippet,
          highlight: match.highlight,
        });
      }
    }
    const next = [...rows];
    if (found.length) next.push({ key: "section:Messages", path: "", kind: "section", name: "Messages" }, ...found.slice(0, 30));
    if (projectHits.length) next.push({ key: "section:Projects", path: "", kind: "section", name: "Projects" }, ...projectHits);
    if (!next.some((row) => row.kind === "chat" || row.kind === "message" || row.kind === "projectHit"))
      return [...next.filter((row) => row.kind === "notice"), { key: "start", path: "", kind: "start" as const }];
    return next;
  }, [rows, needle, searchable, hostMatches, projectHits, manyHosts]);

  // A hidden Run Chat nobody opened lights the dock's Routines button, read from the open computer's Projects.
  const unreadRuns = useMemo(() => {
    const states: Record<string, { sessions: Record<string, AgentSession> }> = {};
    for (const project of builds.find((build) => build.hostId === currentHostId)?.projects ?? [])
      if (project.copy) states[project.path] = project.copy.project.state;
    return unreadRunRoutines(states).size > 0;
  }, [builds, currentHostId]);

  // Every computer keeps its PR chips when the open Chat moves to another one.
  const prTargets = useMemo(() => {
    const byHost = new Map<string, Map<string, Set<string>>>();
    for (const row of listRows) {
      if (row.kind !== "chat" || !row.prPath || !visible) continue;
      let byPath = byHost.get(row.hostId);
      if (!byPath) byHost.set(row.hostId, (byPath = new Map()));
      const refs = byPath.get(row.prPath) || new Set<string>();
      for (const ref of row.prRefs || []) refs.add(ref);
      byPath.set(row.prPath, refs);
    }
    return [...byHost].map(([hostId, paths]): ComputerPullRequestTargets => ({
      hostId,
      client: hostId === currentHostId ? session.client : allComputers.clientFor(hostId),
      targets: [...paths].map(([path, refs]) => ({ path, refs: [...refs] })),
    }));
  }, [listRows, currentHostId, session.client, visible]);
  const prStatus = useComputerChatPullRequests(prTargets);
  // A Worktree's Linear issue shows its chip on the Chat row, with or without pull requests, while Linear is on.
  const { active: linearActive } = useLinear(session.client);
  const linearPaths = useMemo(
    () => [...new Set(listRows.flatMap((row) => (row.kind === "chat" && row.hostId === currentHostId && row.prPath ? [row.path] : [])))],
    [listRows, currentHostId],
  );
  const linearIssues = useWorktreeLinearIssues(session.client, linearActive ? linearPaths : []);
  // A Link's other end is named by its Project and, when this phone holds that Project, the Worktree's branch.
  const endNames = useMemo(
    () =>
      endNamer(
        links.projects,
        (projectPath, worktreePath) =>
          Object.values(copyOf(currentHostId ?? "", projectPath)?.project.state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath)?.name,
      ),
    [links.projects, copyOf, currentHostId],
  );
  // Only a local Project's Chat with its own Worktree joins Links; a shared Link Chat (prPath unset) never does.
  const worktreeForLinks = useCallback(
    (projectPath: string, worktreePath?: string) => {
      const projectId = links.available && worktreePath ? links.projectIdOf(projectPath) : undefined;
      return projectId && worktreePath ? { project_id: projectId, worktree_path: worktreePath } : undefined;
    },
    [links],
  );
  const displayedRows = useMemo(
    () =>
      listRows.map((row) => {
        if (row.kind !== "chat") return row;
        const status = row.prPath ? prStatus[row.hostId]?.[row.prPath] : undefined;
        const current = row.hostId === currentHostId;
        return {
          ...row,
          pullRequests: chatPullRequests(row.prRefs || [], status?.found || {}, status?.branch),
          linearIssue: current && row.prPath ? linearIssues[row.prPath] : undefined,
          linked: current ? linkedLabels(links.links, worktreeForLinks(row.path, row.prPath), endNames).map((end) => end.label) : row.linked,
        };
      }),
    [listRows, currentHostId, prStatus, linearIssues, links.links, worktreeForLinks, endNames],
  );

  /** Where a Chat or a new Chat goes on the computer `hostId`, which is the connected one by now. */
  // A subchat on a wide iPad opens beside its family's top Chat, which the route shows (chat.tsx opens `beside`).
  function enterSubchat(hostId: string, projectPath: string, chatId: number, root: number) {
    if (hostId === currentHostId && projectPath === currentPath && activeChatId === root) {
      openBeside({ hostId, projectPath, chatId });
      onClose?.();
      return;
    }
    void enter(hostId, projectPath, root, undefined, undefined, chatId);
  }
  function navigateTo(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string, beside?: number) {
    const params = { projectPath, hostId };
    if (chatId === undefined) onNavigate({ pathname: "/chat", params: prefill ? { ...params, prefill } : params });
    else if (hostId === currentHostId && projectPath === currentPath && chatId === activeChatId && onClose) onClose();
    else if (pending?.accepted && pending.preview.targetSessionId !== null)
      onNavigate({ pathname: "/chat", params: { ...params, id: String(pending.preview.targetSessionId) } });
    else if (pending)
      onNavigate({
        pathname: "/chat",
        params: {
          ...params,
          ...(pending.originSessionId !== null
            ? { id: String(pending.originSessionId) }
            : { worktreeId: String(pending.worktreeId), ...(pending.draft ? { draft: pending.draft } : {}) }),
        },
      });
    else onNavigate({ pathname: "/chat", params: { ...params, id: String(chatId), ...(beside !== undefined ? { beside: String(beside) } : {}) } });
  }
  // Revisited Chats adopt their full cached Project before routing, including on another computer. Only a cold
  // destination needs to wait for its computer; messages start reading during the route handoff.
  async function enter(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string, beside?: number) {
    if (busy) return;
    const host = hostId === currentHostId ? undefined : allComputers.hostFor(hostId);
    if (chatId !== undefined && !pending && (hostId === currentHostId || host)) {
      const cached = session.openCachedChat(projectPath, chatId, host);
      if (cached) {
        navigateTo(hostId, projectPath, chatId, undefined, undefined, beside);
        return;
      }
    }
    if (hostId === currentHostId && session.client) {
      navigateTo(hostId, projectPath, chatId, pending, prefill, beside);
      return;
    }
    if (!host) {
      setError("This computer is no longer in your list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (chatId !== undefined && !pending) {
        if (!(await session.openNotificationTarget(host, projectPath, chatId)) || !alive.current) return;
      } else if (!(await session.connect(host, false)) || !alive.current) return;
      navigateTo(hostId, projectPath, chatId, pending, prefill, beside);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // A Chat's ⋯ choice runs against its own computer's client and its own Project's copy, which is reread afterwards.
  // Archive stays in this sidebar, including when its Chat is open behind it, so the row's progress and the list's
  // scroll position stay in place.
  async function act(row: { hostId: string; path: string; chat: AgentSession; home?: boolean }, action: string) {
    const { hostId, path: projectPath, chat } = row;
    if (action === "open-beside") {
      openBeside({ hostId, projectPath, chatId: chat.id });
      return;
    }
    const client = clientOf(hostId);
    const copy = copyOf(hostId, projectPath);
    if (!copy || !client) return;
    const isCurrent = hostId === currentHostId;
    if (action === "link-with" || action === "link-remove") {
      if (isCurrent) linkAction(projectPath, chat, action);
      return;
    }
    const archiveKey = `${hostId}|${projectPath}#${chat.id}`;
    if (archiveRequests.has(archiveKey)) return;
    // Done and Reopen move the row now; the computer saves it meanwhile, and its copy takes over once read again.
    const doneMark: DoneMark | undefined = action === "done" ? { doneAt: Date.now() } : action === "reopen" ? { doneAt: null } : undefined;
    const settleDone = () =>
      doneMark &&
      alive.current &&
      setDoneMarks((marks) => {
        if (marks.get(archiveKey) !== doneMark) return marks;
        const next = new Map(marks);
        next.delete(archiveKey);
        return next;
      });
    if (doneMark) {
      setDoneMarks((marks) => new Map(marks).set(archiveKey, doneMark));
      if (action === "done") setDoneToast({ row, at: Date.now() });
      else setDoneToast((toast) => (toast?.row.chat.id === chat.id && toast.row.path === projectPath ? null : toast));
    }
    if (action === "archive") archiveRequests.add(archiveKey);
    let confirmed = false;
    setError("");
    clearArchiveNotice();
    try {
      await runChatAction({
        action,
        chat,
        running: !!copy.runs.runs[`${copy.project.path}#${chat.id}`],
        client,
        projectPath: copy.project.path,
        state: copy.project.state,
        link: copy.project.link,
        chatsHome: row.home,
        hostId,
        onConfirm: () => {
          confirmed = true;
        },
        // The phone may show another Project by the time the archive ends, so the list's copy is read again too.
        refresh: () =>
          !isCurrent || projectPath !== currentPath
            ? allComputers.refreshProject(hostId, projectPath)
            : Promise.all([session.refresh(), action === "archive" ? allComputers.refreshProject(hostId, projectPath) : undefined]),
        expectActivity: session.expectActivity,
        notify: showArchiveNotice,
      });
      // Done on the open Chat leaves it for a new Chat in its Project beside the pinned sidebar, as on the desktop.
      // A phone stays on the sidebar.
      if (action === "done" && docked && isCurrent && projectPath === currentPath && chat.id === activeChatId && alive.current)
        onNavigate({ pathname: "/chat", params: { projectPath, hostId } });
    } catch (e) {
      if (action === "done" && alive.current) setDoneToast((toast) => (toast?.row.chat.id === chat.id && toast.row.path === projectPath ? null : toast));
      if (confirmed) showArchiveNotice(`Could not delete Chat: ${(e as Error).message}`);
      else if (alive.current) setError((e as Error).message);
    } finally {
      archiveRequests.delete(archiveKey);
      settleDone();
    }
  }
  /** A Chat as the Link picker names it, or undefined when it can't join a Link (no Worktree, not a local Project). */
  function linkChatOf(projectPath: string, chat: AgentSession, messages?: Parameters<typeof chatTitle>[1]): LinkChat | undefined {
    const copy = copyOf(currentHostId ?? "", projectPath);
    const worktree = copy && !copy.project.link ? copy.project.state.worktrees[chat.worktree_id] : undefined;
    const target = worktreeForLinks(projectPath, worktree?.path);
    if (!copy || !worktree || !target) return undefined;
    return {
      projectPath: copy.project.path,
      projectName: links.projectNameOf(target.project_id) || copy.project.name || projectPath.split("/").at(-1) || "Project",
      projectId: target.project_id,
      chatId: chat.id,
      title: chatTitle(chat, messages ?? (copy.project.state.messages || []).filter((message) => message.session_id === chat.id)),
      branch: worktree.name,
      worktreePath: worktree.path,
    };
  }
  // The Chats "Link with…" offers: those listed in every local Project of the open computer, newest first.
  function linkChats() {
    const build = builds.find((item) => item.hostId === currentHostId);
    const paths = [
      ...new Set([currentPath, ...(build?.projects.map((item) => item.path) ?? [])].filter((path): path is string => !!path && !isLinkScopeKey(path))),
    ];
    return paths.flatMap((projectPath) => {
      const copy = copyOf(currentHostId ?? "", projectPath);
      if (!copy || copy.project.link) return [];
      const byChat = new Map<number, typeof copy.project.state.messages>();
      for (const message of copy.project.state.messages || []) {
        const list = byChat.get(message.session_id) || [];
        list.push(message);
        byChat.set(message.session_id, list);
      }
      return Object.values(copy.project.state.sessions)
        .filter((chat) => !chat.archived && shownChat(chat, copy.runs.runs[`${copy.project.path}#${chat.id}`], chatSummary(chat, byChat.get(chat.id)).count))
        .sort((a, b) => b.id - a.id)
        .flatMap((chat) => linkChatOf(projectPath, chat, byChat.get(chat.id) ?? []) ?? []);
    });
  }
  // "Link and ask" sends to the source Chat as its composer would: its own provider and model, its permission mode.
  async function askChat(projectPath: string, chat: AgentSession, message: { body: string; prompt: string }) {
    const copy = copyOf(currentHostId ?? "", projectPath);
    const client = session.client;
    const composer = readComposer();
    if (!copy || !client) throw new Error("Connection lost. Reconnect to your computer.");
    const key = `${copy.project.path}#${chat.id}`;
    const preferences = composer.preferences[key] || composer.defaults;
    const turn = turnTarget(composer.preferences[key], chat.provider, composer.defaults);
    const model = selectedModel(turn.provider, turn.model || (!turn.picked ? lastUserModel(copy.project.state, chat.id) : ""), session.models);
    await client.call("chat:send", [
      { projectPath: copy.project.path, sessionId: chat.id, worktreeId: chat.worktree_id, ...message, ...sendOptions(model, preferences), sentFrom: SENT_FROM },
    ]);
    composer.setPreferences((current) => ({
      ...current,
      [key]: afterSend(current[key] || preferences, turn, chat.provider, model.id, !!copy.runs.runs[key]),
    }));
    session.expectActivity();
    await load(client.url, projectPath).catch(() => {});
  }
  function linkAction(projectPath: string, chat: AgentSession, action: "link-with" | "link-remove") {
    const client = session.client;
    const source = linkChatOf(projectPath, chat);
    if (!client || !source) return;
    setError("");
    clearArchiveNotice();
    if (action === "link-with")
      linkWithChat({
        client,
        links: links.links,
        source,
        chats: linkChats(),
        send: (message) => askChat(projectPath, chat, message),
        notify: showArchiveNotice,
        onAsked: () => navigateTo(client.url, projectPath, chat.id),
      });
    else void removeLinkFromChat({ client, ends: linkedLabels(links.links, linkWorktree(source), endNames), notify: showArchiveNotice });
  }
  // Removing a Project takes it off the recent list, as desktop does; its folder and Chats stay on the Mac.
  async function projectAction(hostId: string, projectPath: string, name: string, action: string) {
    if (action === "new") {
      void enter(hostId, projectPath);
      return;
    }
    const isCurrent = hostId === currentHostId;
    if (isLinkScopeKey(projectPath)) {
      if (action === "copy") await Clipboard.setStringAsync(name);
      if (action === "edit" && isCurrent) onNavigate({ pathname: "/link-projects", params: { linkId: projectPath.slice("milagre-link:".length) } }, true);
      return;
    }
    if (action === "copy") {
      await Clipboard.setStringAsync(projectPath);
      return;
    }
    const client = clientOf(hostId);
    if (action !== "remove" || !client) return;
    const confirmed = await confirm(
      `Remove ${name}?`,
      "It leaves this list on your phone and your Mac. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back. Running Chats keep running.",
      "Remove",
    );
    if (!confirmed) return;
    setError("");
    try {
      if (isCurrent) {
        const sameNavigation = await session.forgetProject(projectPath);
        if (sameNavigation && projectPath === currentPath) onNavigate("/projects");
      } else await client.call("project:forget", [projectPath]);
      await allComputers.refreshAll();
    } catch (e) {
      const message = (e as Error).message;
      if (alive.current) setError(/not available from mobile/i.test(message) ? "Update Milagre on your Mac to remove Projects from your phone." : message);
    }
  }
  // A typed path opens like any Project: the Chat loads it behind the splash mark and shows a wrong path with Retry.
  function addProject(projectPath: string) {
    const hostId = addHostId ?? session.client?.url;
    if (busy || !hostId) return;
    setPage(null);
    onNavigate({ pathname: "/chat", params: { projectPath, hostId } });
  }
  /** Which computer a Project or New Chat goes to when several are listed; null when the pick was dismissed. */
  function chooseComputer(title: string): Promise<string | null> {
    const reachable = builds.filter((build) => build.reach !== "offline");
    if (reachable.length <= 1) return Promise.resolve(reachable[0]?.hostId ?? currentHostId ?? null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (id: string | null) => {
        if (done) return;
        done = true;
        resolve(id);
      };
      showChoiceSheet({
        title,
        placeholder: "Search computers",
        emptyLabel: "No computers",
        icon: LaptopIcon,
        items: reachable.map((build) => ({ id: build.hostId, title: build.hostName, checked: build.hostId === currentHostId })),
        onSelect: finish,
      });
    });
  }
  async function startAddProject() {
    const hostId = await chooseComputer("Add project to");
    if (!hostId || busy) return;
    if (hostId !== currentHostId) {
      const host = allComputers.hostFor(hostId);
      if (!host) return;
      setBusy(true);
      setError("");
      try {
        if (!(await session.connect(host, false)) || !alive.current) return;
      } catch (e) {
        if (alive.current) setError((e as Error).message);
        return;
      } finally {
        if (alive.current) setBusy(false);
      }
    }
    setAddHostId(hostId);
    setPage("add");
  }
  // New Chat opens in the Project the last new Chat started in (else the open one); the Chat screen switches Projects.
  // A search that found nothing comes along as the new Chat's draft.
  function startNewChat(prefill?: string) {
    const target = pickNewChatProject(
      newChatProjects(views),
      savedChatDefaults.readLastProject(),
      currentPath ? { hostId: currentHostId ?? "", projectPath: currentPath } : null,
    );
    if (!target) {
      // With no Project anywhere, a Chat without one is still there to start.
      if (noProjectChoice(views, null, currentHostId)) void startWithoutProject();
      else setError("Add a project from your computer to start a Chat.");
      return;
    }
    void enter(target.hostId, target.path, undefined, undefined, prefill);
  }
  // The Chats group's +: a Chat without a Project, on the computer the last new Chat started on (else the open one).
  async function startWithoutProject() {
    const choice = noProjectChoice(views, savedChatDefaults.readLastComputer(), currentHostId);
    const copy = choice?.copies.find((item) => item.hostId === choice.computerId);
    const client = copy && !copy.offline ? clientOf(copy.hostId) : null;
    if (busy) return;
    if (!copy || !client) {
      setError("Connect to your computer to start a Chat.");
      return;
    }
    setError("");
    try {
      const path = await chatsHomePath(client, copy.hostId, copy.home);
      if (alive.current) await enter(copy.hostId, path);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }
  // As desktop's palette row: a new Chat whose draft points its agent at a triage playbook, on the computer New Chat would
  // pick. The user writes what went wrong after it.
  async function startTriage() {
    const target = pickNewChatProject(
      newChatProjects(views),
      savedChatDefaults.readLastProject(),
      currentPath ? { hostId: currentHostId ?? "", projectPath: currentPath } : null,
    );
    const client = target && clientOf(target.hostId);
    if (!target || !client) {
      setError("Add a project from your computer to triage an issue.");
      return;
    }
    try {
      const { prompt } = await client.call<{ prompt: string }>("triage:prepare", [
        `Milagre for ${Platform.OS === "ios" ? "iPhone" : "Android"} ${appVersionLine()}`,
      ]);
      await enter(target.hostId, target.path, undefined, undefined, prompt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start triage.");
    }
  }
  function menuChoice(id: string) {
    if (id === "triage") void startTriage();
    else if (id === "add") void startAddProject();
    else if (id === "link") onNavigate("/link-projects", true);
    else if (id === "canvas") onNavigate("/canvas", true);
  }
  // Filters: which Projects, which Chats, and what each row shows, as desktop's Filters menu.
  const filterSections = [
    { items: [{ id: "choose-projects", title: "Choose projects…", systemImage: "checklist" }] },
    { title: "Show", items: SHOW.map(([id, title, systemImage]) => ({ id, title, systemImage, checked: show === id })) },
    {
      title: "On chats",
      items: ROW_FIELDS.map((field) => ({ id: `field:${field.id}`, title: field.label, systemImage: FIELD_SYMBOLS[field.id], checked: rowShow[field.id] })),
    },
  ];
  function filterChoice(id: string) {
    const field = ROW_FIELDS.find((item) => id === `field:${item.id}`);
    if (field) saveChatRowShow({ ...rowShow, [field.id]: !rowShow[field.id] });
    else if (id === "choose-projects") onNavigate("/choose-projects", "sheet");
    else setShow(id as Show);
  }

  // The rows render apart (NavigationRow), from what they show and actions that always run the latest closures: a render of
  // the list that changes nothing a row shows (a search keystroke elsewhere, a poll that found nothing new) skips them.
  const latestActions = useRef<RowActions | null>(null);
  useLayoutEffect(() => {
    latestActions.current = {
      enter,
      act,
      projectAction,
      startNewChat,
      startWithoutProject,
      foldChats: () => setChatsFolded((folded) => !folded),
      foldDone: () => setDoneOpen((open) => !open),
      foldSubchats: (key) =>
        setSubchatFolds((folded) => {
          const next = new Set(folded);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
      enterSubchat,
      load,
    };
  });
  useEffect(() => {
    if (!doneToast) return;
    // Long enough to read it and reach Undo with a thumb.
    const timer = setTimeout(() => setDoneToast((toast) => (toast?.at === doneToast.at ? null : toast)), 10000);
    return () => clearTimeout(timer);
  }, [doneToast]);
  const doneHours = useDoneRetention(
    views.map((view) => view.hostId),
    clientOf,
    visible,
  );
  const actions = useMemo<RowActions>(
    () => ({
      enter: (...args) => latestActions.current!.enter(...args),
      act: (...args) => latestActions.current!.act(...args),
      projectAction: (...args) => latestActions.current!.projectAction(...args),
      startNewChat: (...args) => latestActions.current!.startNewChat(...args),
      startWithoutProject: () => latestActions.current!.startWithoutProject(),
      foldChats: () => latestActions.current!.foldChats(),
      foldDone: () => latestActions.current!.foldDone(),
      foldSubchats: (key) => latestActions.current!.foldSubchats(key),
      enterSubchat: (...args) => latestActions.current!.enterSubchat(...args),
      load: (...args) => latestActions.current!.load(...args),
    }),
    [],
  );
  const rowView = useMemo<RowView>(
    () => ({
      currentHostId,
      currentPath,
      activeChatId,
      busy,
      wide,
      beside,
      query,
      now,
      rowShow,
      chatList,
      selectedFill,
      attention,
      links,
      archivingChats: archives.chats,
      archiveRequests,
      copyOf,
      clientOf,
      worktreeForLinks,
      doneHours,
      background,
      actions,
    }),
    [
      doneHours,
      background,
      currentHostId,
      currentPath,
      activeChatId,
      busy,
      wide,
      beside,
      query,
      now,
      rowShow,
      chatList,
      selectedFill,
      attention,
      links,
      archives.chats,
      archiveRequests,
      copyOf,
      clientOf,
      worktreeForLinks,
      actions,
    ],
  );
  const renderItem = useCallback(({ item }: { item: Row }) => <NavigationRow item={item} view={rowView} />, [rowView]);

  // ⌘N, ⌘K and ⌘1 to ⌘9 act on the list on screen; one that opens for a shortcut picks it up as it shows.
  const runCommand = useRef<(command: NavigationCommand) => void>(() => {});
  useEffect(() => {
    runCommand.current = (command) => {
      if (command.kind === "new") startNewChat();
      else if (command.kind === "search") {
        setPage(null);
        controls.reveal();
        searchInput.current?.focus();
      } else {
        const row = displayedRows.filter((item) => item.kind === "chat")[command.index];
        if (row?.kind === "chat") void enter(row.hostId, row.path, row.chat.id, row.pending);
      }
    };
  });
  useEffect(() => {
    if (!visible) return;
    const run = () => {
      const command = takeNavigation();
      if (command) runCommand.current(command);
    };
    run();
    return subscribeNavigation(run);
  }, [visible]);
  if (page)
    return (
      <View style={[styles.screen, { backgroundColor: background }]}>
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 4, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <IconButton label={`Back to ${ALL_CHATS_LABEL}`} icon={ArrowLeft01Icon} size={44} onPress={() => setPage(null)} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            Add project
          </Text>
          {onClose && <IconButton label="Close navigation" icon={Cancel01Icon} size={44} onPress={onClose} />}
        </View>
        <ProjectSearch onOpen={addProject} />
      </View>
    );
  const emptyText = needle
    ? "No chats match your search."
    : builds.length
      ? "Add a project from your computer to start a Chat."
      : session.hosts.length
        ? "Every computer is hidden. Show one in Settings."
        : "Pair your computer. Open Settings → Devices in Milagre on your Mac, then scan its pairing code.";
  return (
    <View style={[styles.screen, { backgroundColor: background }]}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: 22, fontWeight: "700" }}>
            {ALL_CHATS_LABEL}
          </Text>
          {/* One glass capsule holds all three, as iOS groups toolbar buttons. Settings opens over the sidebar, which stays where it was under it. Routines is a page, so the sidebar closes first. */}
          <View style={s.headerGroup}>
            <HeaderGlass />
            <View>
              <HeaderButton label="Settings" icon={Settings01Icon} onPress={() => onNavigate("/settings", "sheet")} />
              <UpdateSettingsBadge />
            </View>
            {routinesAvailable && (
              <View>
                <HeaderButton label={unreadRuns ? "Routines, unread Runs" : "Routines"} icon={RepeatIcon} onPress={() => onNavigate("/routines", true)} />
                {unreadRuns && <View pointerEvents="none" style={[s.headerDot, { backgroundColor: colors[chatMarkTone("unread")] }]} />}
              </View>
            )}
            <PullDown
              label="More"
              sections={[
                {
                  items: [
                    { id: "add", title: "Add project", systemImage: "folder.badge.plus" },
                    { id: "link", title: "Link projects", systemImage: "link" },
                    { id: "canvas", title: "Canvas", systemImage: "square.grid.2x2" },
                  ],
                },
                { items: [{ id: "triage", title: "Triage an issue", systemImage: "ladybug" }] },
              ]}
              onSelect={menuChoice}
            >
              <View style={s.headerButton}>
                <Icon icon={MoreHorizontalIcon} tone="ink" size={20} />
              </View>
            </PullDown>
          </View>
        </View>
        {error || archives.notice ? <ErrorNotice message={error || archives.notice} /> : null}
      </View>
      <FlatList
        data={displayedRows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={hideRevealed}
        onScroll={controls.onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void links.refresh();
              void allComputers
                .refreshAll()
                .catch((e) => setError(e.message))
                .finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Text style={[styles.muted, { padding: 20 }]}>{emptyText}</Text>}
        extraData={rowView}
        renderItem={renderItem}
      />
      <ChatListControls
        hidden={controls.hidden}
        query={query}
        onQuery={setQuery}
        inputRef={searchInput}
        onFocus={controls.reveal}
        filters={{ sections: filterSections, onSelect: filterChoice, active: show !== "all" }}
        onNewChat={() => startNewChat()}
        visible={visible}
      />
      {/* "Chat deleted" (its Undo calls the deletion off) or "Moved to Done" (its Undo reopens the Chat), floating over the
          list without moving it. A deletion started on the Chat screen shows here, since that screen has gone. */}
      {archives.deleted || doneToast ? (
        <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: bottomInset + 8, alignItems: "center" }}>
          <ToastPill
            text={archives.deleted ? "Chat deleted" : "Moved to Done"}
            icon={archives.deleted ? Delete02Icon : CheckmarkCircle02Icon}
            onUndo={() => {
              if (archives.deleted) {
                undoDelete(archives.deleted);
                return;
              }
              if (!doneToast) return;
              const { row } = doneToast;
              setDoneToast(null);
              // Done also marked it read; Undo puts back the unread it had.
              void act(row, "reopen").then(() => (row.chat.unread ? act(row, "unread") : undefined));
            }}
          />
        </View>
      ) : null}
      {busy && (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Opening..."
          accessibilityLiveRegion="polite"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", backgroundColor: `${colors.page}e6` }]}
        >
          <LoadingLogo size={64} />
        </View>
      )}
    </View>
  );
});

type RowActions = {
  enter: (hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string) => Promise<void>;
  act: (row: { hostId: string; path: string; chat: AgentSession }, action: string) => Promise<void>;
  projectAction: (hostId: string, projectPath: string, name: string, action: string) => Promise<void>;
  startNewChat: (prefill?: string) => void;
  startWithoutProject: () => Promise<void>;
  foldChats: () => void;
  foldDone: () => void;
  /** Folds or unfolds the subchats under the parent row `key`. */
  foldSubchats: (key: string) => void;
  /** A subchat's row on a wide iPad: its family's top Chat routed, the subchat open beside it. */
  enterSubchat: (hostId: string, projectPath: string, chatId: number, root: number) => void;
  load: (hostId: string, projectPath: string) => Promise<unknown>;
};
/** What every row reads besides its own item; a change re-renders the rows on screen. */
type RowView = {
  currentHostId?: string;
  currentPath?: string;
  activeChatId?: number;
  busy: boolean;
  wide: boolean;
  beside: ReturnType<typeof useBesideChat>;
  query: string;
  now: number;
  rowShow: ReturnType<typeof useChatRowShow>;
  chatList: ReturnType<typeof useChatList>[0];
  selectedFill: string;
  attention: string[];
  links: ReturnType<typeof useLinks>;
  archivingChats: ReturnType<typeof useArchiveActivity>["chats"];
  archiveRequests: Set<string>;
  copyOf: (hostId: string, projectPath: string) => ProjectCopy | undefined;
  clientOf: (hostId: string) => Client | null;
  worktreeForLinks: (projectPath: string, worktreePath?: string) => { project_id: string; worktree_path: string } | undefined;
  /** Each computer's Done retention in hours (done-retention.ts); a computer missing from it can't keep Done. */
  doneHours: Record<string, number>;
  /** The list's own color, under every row. */
  background: string;
  actions: RowActions;
};
/** One row of the list; memoized, so only a row whose item or view changed renders again. */
const NavigationRow = memo(function NavigationRow({ item, view }: { item: Row; view: RowView }) {
  const s = useS();
  const { colors } = useTheme();
  const {
    currentHostId,
    currentPath,
    activeChatId,
    busy,
    wide,
    beside,
    query,
    now,
    rowShow,
    chatList,
    selectedFill,
    attention,
    links,
    archivingChats,
    archiveRequests,
    copyOf,
    clientOf,
    worktreeForLinks,
    doneHours,
    background,
    actions: { enter, act, projectAction, startNewChat, startWithoutProject, foldChats, foldDone, foldSubchats, enterSubchat, load },
  } = view;
  if (item.kind === "section")
    return <Text style={[s.detail, { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, fontWeight: "500" }]}>{item.name}</Text>;
  if (item.kind === "offline") return <OfflineLine hostIds={item.hostIds} />;
  if (item.kind === "divider") return <View style={[s.divider, { backgroundColor: colors.line }]} />;
  if (item.kind === "chatsGroup")
    // Styled like a Project group: a tap folds it, a long press opens its menu, + starts a Chat without a Project.
    return (
      <View style={[s.project, { opacity: item.offline ? 0.55 : 1 }]}>
        <PullDown
          label={`${item.expanded ? "Collapse" : "Expand"} ${CHATS_GROUP_LABEL}`}
          title={CHATS_GROUP_LABEL}
          sections={[{ items: [{ id: "new", title: "New Chat", systemImage: "square.and.pencil" }] }]}
          onSelect={() => void startWithoutProject()}
          onPress={foldChats}
          style={{ flex: 1 }}
        >
          <View style={s.projectTitle}>
            <ChatsHomeIcon />
            <Text numberOfLines={1} style={[s.secondary, { flexShrink: 1, fontWeight: "500", color: colors.ink }]}>
              {CHATS_GROUP_LABEL}
            </Text>
            {!item.expanded && (
              <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                {`${item.count} ${item.count === 1 ? "chat" : "chats"}`}
              </Text>
            )}
            <View style={{ flex: 1 }} />
            {chatsGroupNeedsAttention(item.homes, currentHostId, attention.map(projectOfKey)) && <AttentionDot />}
            <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={13} />
          </View>
        </PullDown>
        <IconButton label="New Chat without a Project" icon={Add01Icon} size={44} disabled={busy} onPress={() => void startWithoutProject()} />
      </View>
    );
  if (item.kind === "doneHeader")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Done, ${item.count} ${item.count === 1 ? "chat" : "chats"}`}
        accessibilityState={{ expanded: item.expanded }}
        onPress={foldDone}
        style={[s.project, { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }]}
      >
        <View style={s.projectTitle}>
          <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={13} />
          <Text style={[s.secondary, { fontWeight: "600", color: colors.ink2 }]}>Done</Text>
          <Text style={[s.secondary, { color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{item.count}</Text>
        </View>
      </Pressable>
    );
  if (item.kind === "done") {
    const offline = item.reach === "offline";
    const countdown = doneCountdown(item.chat, retentionOf(doneHours, item.hostId), now);
    return (
      <ChatSwipeRow done unread={false} disabled={offline || !copyOf(item.hostId, item.path)} background={background} onAction={(action) => act(item, action)}>
        <View style={{ flexDirection: "row", alignItems: "center", opacity: offline ? 0.55 : 1 }}>
          {/* A long press or the ⋯ button offers Reopen, so leaving Done needn't be found by swiping. */}
          <PullDown
            label={`${item.title}, Done${item.many ? `, on ${item.hostName}` : ""}${countdown ? `, archived in ${countdown}` : ""}`}
            title={item.title}
            sections={offline ? [] : DONE_MENU}
            onSelect={(action) => void act(item, action)}
            onPress={() => void enter(item.hostId, item.path, item.chat.id)}
            style={{ flex: 1 }}
          >
            <View style={[s.doneRow, { paddingRight: 0 }]}>
              <Icon icon={CheckmarkCircle02Icon} tone="ink4" size={18} />
              {/* With two or more computers, the one the Chat lives on goes under its title, so both stay readable. */}
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text numberOfLines={1} style={{ fontSize: 16, color: colors.ink3 }}>
                  {item.title}
                </Text>
                {item.many && <ComputerTag name={item.hostName} offline={offline} />}
              </View>
              {countdown && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Icon icon={HourglassIcon} tone="ink3" size={13} />
                  <Text style={[s.detail, { fontWeight: "500", fontVariant: ["tabular-nums"] }]}>{countdown}</Text>
                </View>
              )}
            </View>
          </PullDown>
          {!offline && (
            <PullDown label={`Actions for ${item.title}`} title={item.title} sections={DONE_MENU} onSelect={(action) => void act(item, action)}>
              <View style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}>
                <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
              </View>
            </PullDown>
          )}
        </View>
      </ChatSwipeRow>
    );
  }
  if (item.kind === "start")
    return (
      <View style={s.startEmpty}>
        <Icon icon={SearchRemoveIcon} tone="ink3" size={30} />
        <Text style={s.startTitle}>No chat matches “{query.trim()}”</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a new chat with your search"
          disabled={busy}
          onPress={() => {
            tap();
            startNewChat(query.trim());
          }}
          style={({ pressed }) => [s.startCard, pressed && { backgroundColor: colors.hover }]}
        >
          {/* Liquid Glass like the controls under it; only its position may animate, never its alpha. */}
          <LiquidGlassView
            pointerEvents="none"
            glassType="regular"
            isInteractive={false}
            reducedTransparencyFallbackColor={colors.surface}
            style={[StyleSheet.absoluteFill, { borderRadius: 18, borderCurve: "continuous" }]}
          />
          <Icon icon={PencilEdit02Icon} tone="ink" size={20} />
          <Text style={[s.secondary, { flex: 1, color: colors.ink, fontWeight: "600" }]}>Start a new chat with your search</Text>
        </Pressable>
      </View>
    );
  const offline = item.reach === "offline";
  if (item.kind === "projectHit")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New Chat in ${item.name}${item.many ? `, ${item.hostName}` : ""}`}
        disabled={busy || offline}
        onPress={() => void enter(item.hostId, item.path)}
        style={({ pressed }) => [s.projectHit, { opacity: offline ? 0.55 : 1, backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        {item.members ? (
          <ProjectIcons client={clientOf(item.hostId)} projects={item.members} />
        ) : (
          <ProjectIcon client={clientOf(item.hostId)} path={item.path} />
        )}
        <Text numberOfLines={1} style={[s.secondary, { flex: 1, color: colors.ink }]}>
          {item.name}
        </Text>
        {item.many && <Text style={s.detail}>{item.hostName}</Text>}
      </Pressable>
    );
  if (item.kind === "project") {
    const linked = item.link;
    const client = clientOf(item.hostId);
    const unsaved = copyOf(item.hostId, item.path)?.project.state.persistence;
    const menu = [
      {
        items: [
          { id: "new", title: "New Chat", systemImage: "square.and.pencil" },
          { id: "copy", title: linked ? "Copy Link name" : "Copy path", systemImage: "doc.on.doc" },
          ...(linked && item.hostId === currentHostId ? [{ id: "edit", title: "Edit Link", systemImage: "pencil" }] : []),
        ],
      },
      ...(!linked ? [{ items: [{ id: "remove", title: "Remove Project", systemImage: "minus.circle", destructive: true }] }] : []),
    ];
    const choose = (action: string) => void projectAction(item.hostId, item.path, item.name, action);
    // A tap folds the group; a long press opens the Project's menu.
    return (
      <View style={[s.project, { opacity: offline ? 0.55 : 1 }]}>
        <PullDown
          label={`${item.expanded ? "Collapse" : "Expand"} ${item.name}${item.chip ? `, ${item.hostName}${offline ? ", offline" : ""}` : ""}`}
          title={item.name}
          sections={menu}
          onSelect={choose}
          onPress={() => void savedFoldedProjects.toggle(item.hostId, item.path)}
          style={{ flex: 1 }}
        >
          <View style={s.projectTitle}>
            {item.members ? <ProjectIcons client={client} projects={item.members} /> : <ProjectIcon client={client} path={item.path} />}
            <Text numberOfLines={1} style={[s.secondary, { flexShrink: 1, fontWeight: "500", color: colors.ink }]}>
              {item.name}
            </Text>
            {(item.chip || !item.expanded) && (
              <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                {[item.chip ? item.hostName + (offline ? ", offline" : "") : "", item.expanded ? "" : `${item.count} ${item.count === 1 ? "chat" : "chats"}`]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            )}
            <View style={{ flex: 1 }} />
            {unsaved && (
              <Text accessibilityLabel="Changes not saved" style={[s.detail, { color: colors.redInk }]}>
                Unsaved
              </Text>
            )}
            {item.hostId === currentHostId && attention.some((key) => projectOfKey(key) === item.path) && <AttentionDot />}
            <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={13} />
          </View>
        </PullDown>
        <IconButton
          label={`New Chat in ${item.name}`}
          icon={Add01Icon}
          size={44}
          disabled={busy || offline}
          onPress={() => void enter(item.hostId, item.path)}
        />
      </View>
    );
  }
  if (item.kind === "message") {
    const [start, end] = item.highlight;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.snippet}, in ${item.title}, ${item.project}`}
        onPress={() => void enter(item.hostId, item.path, item.chat.id)}
        style={({ pressed }) => [s.chat, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <View style={[s.chatBody, { flex: 1 }]}>
          <View style={{ flex: 1, gap: 5 }}>
            <Text numberOfLines={2} style={s.chatTitle}>
              {item.snippet.slice(0, start)}
              <Text style={{ fontWeight: "600" }}>{item.snippet.slice(start, end)}</Text>
              {item.snippet.slice(end)}
            </Text>
            <Text numberOfLines={1} style={s.detail}>
              {[item.title, item.project, item.many ? item.hostName : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }
  if (item.kind === "notice")
    return (
      <Pressable
        accessibilityRole={item.failed ? "button" : "text"}
        disabled={!item.failed}
        onPress={() => void (item.retry === "project" ? load(item.hostId, item.path) : allComputers.refreshAll())}
        style={s.notice}
      >
        <Text style={s.detail}>{item.message}</Text>
      </Pressable>
    );
  const title = item.title;
  const besideRow = { hostId: item.hostId, projectPath: item.path, chatId: item.chat.id, archived: item.chat.archived, offline };
  const offerBeside = canOpenBeside(besideRow, { wide, hostId: currentHostId, projectPath: currentPath, chatId: activeChatId }, beside);
  // The Chat open beside the open one is selected too.
  const isBeside = wide && activeChatId !== undefined && beside?.hostId === item.hostId && beside.projectPath === item.path && beside.chatId === item.chat.id;
  const selected = (currentHostId === item.hostId && currentPath === item.path && activeChatId === item.chat.id) || isBeside;
  const tone = chatMarkTone(item.mark);
  const pullRequests = rowShow.pullRequests ? item.pullRequests || [] : [];
  const linearIssue = rowShow.linearIssue ? item.linearIssue : undefined;
  const hasChips = pullRequests.length > 0 || !!linearIssue;
  const copy = copyOf(item.hostId, item.path);
  const worktreeDiff = rowShow.diff && !copy?.project.link ? copy?.project.state.worktrees[item.chat.worktree_id]?.diff : undefined;
  const diff = worktreeDiff && (worktreeDiff.added > 0 || worktreeDiff.removed > 0) ? worktreeDiff : undefined;
  const lastAt = rowShow.lastActivity ? item.chat.summary?.lastAt : undefined;
  // The diff and the last activity sit after the branch, or after the chips.
  const facts = (
    <>
      {diff && (
        <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>
          <Text style={{ color: colors.add }}>+{diff.added}</Text> <Text style={{ color: colors.remove }}>−{diff.removed}</Text>
        </Text>
      )}
      {lastAt !== undefined && chatList === "grouped" && <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>{activityAgo(lastAt, now)}</Text>}
    </>
  );
  const branchLine = copy?.project.link ? `Shared Chat · ${copy.project.link.projects.length} Projects` : rowShow.branch ? item.worktree : "";
  const linked = item.linked ?? [];
  // A linked Chat shows the Link glyph beside its pin, as desktop's sidebar does.
  const linkedIcon = linked.length ? (
    <View accessible accessibilityLabel={linkedAccessibilityLabel(linked)}>
      <Icon icon={Link04Icon} tone="ink3" size={12} />
    </View>
  ) : null;
  const markLabel = item.mark === "background" && item.background ? backgroundLabel(item.background) : labels[item.mark];
  // A working Chat says so with its spinner alone, as on desktop; its words stay for VoiceOver.
  const markWord = item.mark === "running" || item.mark === "background" ? "" : markLabel;
  const markColor = tone === "accent" ? colors.accentInk : colors[tone];
  // A PR link opens the Chat and then its PR there, for a Chat of this computer with a Worktree of its own.
  const openPullRequest =
    item.hostId === currentHostId && !copy?.project.link && !item.pending
      ? (pr: PullRequest) => {
          requestPullRequest(`${item.path}#${item.chat.id}`, pr.number);
          void enter(item.hostId, item.path, item.chat.id);
        }
      : undefined;
  // A Mac that keeps Done answers its retention (done-retention.ts); an older one ignores Done, so its rows archive instead.
  const doneable = doneHours[item.hostId] !== undefined;
  // A subchat opens beside its family's top Chat where a wide iPad shows two (subchat-rows.ts).
  const openRow = () => {
    if (archiving) return;
    if (item.subchat && item.root !== undefined && wide && !item.pending) enterSubchat(item.hostId, item.path, item.chat.id, item.root);
    else void enter(item.hostId, item.path, item.chat.id, item.pending);
  };
  const family = item.family;
  const familyLabel = family ? `${family.folded ? "Show" : "Hide"} ${family.count} subchat${family.count === 1 ? "" : "s"}` : "";
  const familyToggle = family ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={familyLabel}
      accessibilityState={{ expanded: !family.folded }}
      hitSlop={8}
      onPress={() => {
        tap();
        foldSubchats(item.key);
      }}
      style={s.subchatToggle}
    >
      <View style={family.folded ? { transform: [{ rotate: "-90deg" }] } : undefined}>
        <Icon icon={ArrowDown01Icon} tone="ink3" size={13} />
      </View>
      <Text style={s.detail}>{`${family.count} subchat${family.count === 1 ? "" : "s"}`}</Text>
    </Pressable>
  ) : null;
  // A subchat sits indented under its parent, with a line down to it.
  const subchatGuide = item.subchat ? <View pointerEvents="none" style={[s.subchatGuide, { backgroundColor: colors.line }]} /> : null;
  const menu = chatMenu(
    item.chat,
    copy?.project.link ? { path: copy.project.state.worktrees[item.chat.worktree_id]?.path } : copy?.project.state.worktrees[item.chat.worktree_id],
    item.hostId === currentHostId && !item.home
      ? linkMenuSection({ available: links.available, worktreePath: worktreeForLinks(item.path, item.prPath)?.worktree_path, linked: linked.length })
      : null,
    offerBeside,
    !item.home,
    doneable,
  );
  // While it archives, the row stays put under the progress and takes no taps.
  const archiving =
    archivingChats.has(`${copy?.project.path ?? item.path}#${item.chat.id}`) &&
    (item.hostId === currentHostId || archiveRequests.has(`${item.hostId}|${item.path}#${item.chat.id}`));
  // A Chat without a Project, in the Chats group or a search: its title, then its computer and age, never a branch or PR.
  if (item.home) {
    const detail = chatsRowDetail(item.hostName + (offline ? ", offline" : ""), item.chat.summary?.lastAt, now);
    return (
      <ChatSwipeRow
        unread={!!item.chat.unread}
        disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
        doneable={doneable}
        background={background}
        onAction={(action) => act(item, action)}
      >
        <View pointerEvents={archiving ? "none" : "auto"} style={{ opacity: offline ? 0.55 : 1 }}>
          <HoverView
            style={[s.chat, s.grouped, { backgroundColor: selected && !archiving ? selectedFill : "transparent" }]}
            hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
          >
            <View
              style={{ flex: 1, opacity: archiving ? 0.3 : 1 }}
              accessibilityElementsHidden={archiving}
              importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
            >
              <PullDown
                label={`${title}${item.chat.pinned ? ", pinned" : ""}, ${NO_PROJECT_LABEL}, ${detail}${markLabel ? `, ${markLabel}` : ""}`}
                title={title}
                sections={item.pending || archiving ? [] : menu}
                onSelect={(action) => {
                  if (!item.pending && !archiving) void act(item, action);
                }}
                onPress={() => {
                  if (!archiving) void enter(item.hostId, item.path, item.chat.id, item.pending);
                }}
                style={{ flex: 1 }}
              >
                <View style={s.chatBody}>
                  <ChatMarkIcon mark={item.mark} background={item.background} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text
                      numberOfLines={2}
                      style={[s.chatTitle, { color: item.chat.unread || selected ? colors.ink : colors.ink2, fontWeight: item.chat.unread ? "600" : "500" }]}
                    >
                      {title}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
                      {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                      <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, fontVariant: ["tabular-nums"] }]}>
                        {detail}
                      </Text>
                      {!!markWord && <Text style={[s.detail, { color: markColor }]}>{markWord}</Text>}
                      <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                    </View>
                  </View>
                </View>
              </PullDown>
            </View>
            {!item.pending && !archiving && (
              <PullDown label={`Actions for ${title}`} title={title} sections={menu} onSelect={(action) => void act(item, action)}>
                <View style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}>
                  <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
                </View>
              </PullDown>
            )}
            {archiving && <ArchivingOverlay title={title} />}
          </HoverView>
        </View>
      </ChatSwipeRow>
    );
  }
  const grouped = chatList === "grouped";
  const label = `${title}${item.chat.pinned ? ", pinned" : ""}, ${grouped ? item.worktree : `${item.project}, ${item.worktree}`}${markLabel ? `, ${markLabel}` : ""}${item.many ? `, ${item.hostName}${offline ? ", offline" : ""}` : ""}${linked.length ? `, ${linkedAccessibilityLabel(linked)}` : ""}`;
  // Under a Project several computers share, each row names its own computer first.
  const computerTag = grouped && item.shared ? <ComputerTag name={item.hostName} offline={offline} /> : null;
  const secondLine = !!computerTag || !!branchLine || !!diff || lastAt !== undefined || !!item.chat.pinned || !!linkedIcon || !!markWord;
  // One list: inbox rows. The Project's icon, then the title with its time (a spinner while it runs, a dot when unread),
  // then one line naming the Project, its pull requests and Linear issue, what the Chat waits on, the diff, and the
  // computer when it isn't the open one. A tap opens the Chat and a long press opens its menu: the menu covers the row,
  // under the pull request links, which keep their own taps.
  if (!grouped) {
    const running = item.mark === "running" || item.mark === "background";
    const word = item.mark === "unread" ? "" : markLabel;
    const unreadColor = colors[chatMarkTone("unread")];
    const otherComputer = item.many;
    const separator = <Text style={s.inboxSeparator}>·</Text>;
    // What VoiceOver reads for the row: what it shows, without the branch.
    const inboxLabel = [
      title,
      item.chat.pinned ? "pinned" : "",
      item.chat.unread ? "unread" : "",
      copy?.project.link ? `${copy.project.link.projects.length} Projects` : item.project,
      word,
      otherComputer ? `${item.hostName}${offline ? ", offline" : ""}` : "",
      linked.length ? linkedAccessibilityLabel(linked) : "",
    ]
      .filter(Boolean)
      .join(", ");
    // The second line's parts, " · " between them; the pull request links keep their own taps.
    const parts: { key: string; node: ReactNode; links?: boolean }[] = [
      {
        key: "project",
        node: copy?.project.link ? (
          <>
            <Icon icon={Link04Icon} tone="ink3" size={13} />
            <Text numberOfLines={1} style={s.inboxText}>
              {copy.project.link.projects.length} Projects
            </Text>
          </>
        ) : (
          <Text numberOfLines={1} style={[s.inboxText, { flexShrink: 1 }]}>
            {item.project}
          </Text>
        ),
      },
      ...(hasChips
        ? [
            {
              key: "links",
              links: true,
              node: <InlinePullRequestLinks pullRequests={pullRequests} linearIssue={linearIssue} separator={separator} onOpenPullRequest={openPullRequest} />,
            },
          ]
        : []),
      ...(word && markWord
        ? [
            {
              key: "mark",
              node: (
                <Text numberOfLines={1} style={[s.inboxText, { color: markColor, flexShrink: 1 }]}>
                  {word}
                </Text>
              ),
            },
          ]
        : []),
      ...(diff
        ? [
            {
              key: "diff",
              node: (
                <Text style={[s.inboxText, { fontVariant: ["tabular-nums"] }]}>
                  <Text style={{ color: colors.add }}>+{diff.added}</Text> <Text style={{ color: colors.remove }}>−{diff.removed}</Text>
                </Text>
              ),
            },
          ]
        : []),
      ...(otherComputer ? [{ key: "computer", node: <ComputerTag name={item.hostName} offline={offline} large /> }] : []),
    ];
    if (familyToggle) parts.splice(1, 0, { key: "subchats", links: true, node: familyToggle });
    return (
      <ChatSwipeRow
        unread={!!item.chat.unread}
        disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
        doneable={doneable}
        background={background}
        onAction={(action) => act(item, action)}
      >
        <View pointerEvents={archiving ? "none" : "auto"} style={{ opacity: offline ? 0.55 : 1, ...(item.subchat ? s.subchat : null) }}>
          {subchatGuide}
          <HoverView
            style={[s.inbox, { backgroundColor: selected && !archiving ? selectedFill : "transparent" }]}
            hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
          >
            <PullDown
              label={inboxLabel}
              title={title}
              sections={item.pending || archiving ? [] : menu}
              onSelect={(action) => {
                if (!item.pending && !archiving) void act(item, action);
              }}
              onPress={openRow}
              style={StyleSheet.absoluteFill}
              fill
            >
              <View style={{ flex: 1 }} />
            </PullDown>
            <View
              pointerEvents="box-none"
              style={[s.inboxContent, { opacity: archiving ? 0.3 : 1 }]}
              accessibilityElementsHidden={archiving}
              importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
            >
              <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {item.members?.[0] ? (
                  <ProjectIcon client={clientOf(item.hostId)} path={item.members[0].path} size={32} />
                ) : (
                  <ProjectIcon client={clientOf(item.hostId)} path={item.path} size={32} />
                )}
              </View>
              <View pointerEvents="box-none" style={{ flex: 1, gap: 3 }}>
                <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.inboxLine}>
                  {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={13} />}
                  {linkedIcon}
                  <Text numberOfLines={1} style={[s.inboxTitle, { color: colors.ink, fontWeight: item.chat.unread ? "600" : "500" }]}>
                    {title}
                  </Text>
                  {running ? (
                    <SpinnerRing size={14} tone="accent" />
                  ) : (
                    <>
                      {lastAt !== undefined && (
                        <Text style={[s.inboxTime, item.chat.unread && { color: unreadColor, fontWeight: "600" }]}>{activityAgo(lastAt, now)}</Text>
                      )}
                      {item.chat.unread && <View style={[s.unread, { backgroundColor: unreadColor }]} />}
                    </>
                  )}
                </View>
                <View pointerEvents="box-none" style={s.inboxLine}>
                  {parts.map((part, at) => (
                    <View
                      key={part.key}
                      pointerEvents={part.links ? "box-none" : "none"}
                      accessibilityElementsHidden={!part.links}
                      importantForAccessibility={part.links ? "auto" : "no-hide-descendants"}
                      style={[s.inboxPart, !part.links && { flexShrink: 1 }]}
                    >
                      {at > 0 && <View pointerEvents="none">{separator}</View>}
                      {part.node}
                    </View>
                  ))}
                </View>
              </View>
            </View>
            {archiving && <ArchivingOverlay title={title} />}
          </HoverView>
        </View>
      </ChatSwipeRow>
    );
  }
  // A tap opens the Chat and a long press opens its ⋯ menu, as on desktop's sidebar.
  return (
    <ChatSwipeRow
      unread={!!item.chat.unread}
      disabled={offline || !!item.pending || archiving || !!item.chat.archived || !copy}
      doneable={doneable}
      background={background}
      onAction={(action) => act(item, action)}
    >
      <View pointerEvents={archiving ? "none" : "auto"} style={{ opacity: offline ? 0.55 : 1, ...(item.subchat ? s.subchat : null) }}>
        {subchatGuide}
        <HoverView
          style={[s.chat, s.grouped, { backgroundColor: selected && !archiving ? selectedFill : "transparent" }]}
          hoverStyle={!selected && !archiving ? { backgroundColor: colors.hover } : undefined}
        >
          <View
            style={{ flex: 1, opacity: archiving ? 0.3 : 1 }}
            accessibilityElementsHidden={archiving}
            importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
          >
            <PullDown
              label={label}
              title={title}
              sections={item.pending || archiving ? [] : menu}
              onSelect={(action) => {
                if (!item.pending && !archiving) void act(item, action);
              }}
              onPress={openRow}
              style={{ flex: 1 }}
            >
              <View style={[s.chatBody, hasChips && { minHeight: 28, paddingTop: 6, paddingBottom: 0 }]}>
                <ChatMarkIcon mark={item.mark} background={item.background} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text
                    numberOfLines={hasChips ? 1 : 2}
                    style={[s.chatTitle, { color: item.chat.unread || selected ? colors.ink : colors.ink2, fontWeight: item.chat.unread ? "600" : "500" }]}
                  >
                    {title}
                  </Text>
                  {!hasChips && secondLine && (
                    <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
                      {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                      {linkedIcon}
                      {computerTag}
                      {!copy?.project.link && !!branchLine && <Icon icon={GitBranchIcon} tone="ink3" size={12} />}
                      {!!branchLine && (
                        <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                          {branchLine}
                        </Text>
                      )}
                      {facts}
                      {!!markWord && <Text style={[s.detail, { color: markColor }]}>{markWord}</Text>}
                      <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                    </View>
                  )}
                </View>
              </View>
            </PullDown>
            {hasChips && (
              <View>
                <ChatPullRequestChips pullRequests={pullRequests} linearIssue={linearIssue} onOpenPullRequest={openPullRequest}>
                  {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                  {linkedIcon}
                  {computerTag}
                  {facts}
                  {!!markWord && (
                    <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, color: markColor }]}>
                      {markWord}
                    </Text>
                  )}
                  <WaitingLabel computerId={item.hostId} owner={item.path} sessionId={item.chat.id} style={s.detail} />
                </ChatPullRequestChips>
              </View>
            )}
          </View>
          {!archiving && familyToggle}
          {!item.pending && !archiving && (
            <PullDown label={`Actions for ${title}`} title={title} sections={menu} onSelect={(action) => void act(item, action)}>
              <View style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}>
                <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
              </View>
            </PullDown>
          )}
          {archiving && <ArchivingOverlay title={title} />}
        </HoverView>
      </View>
    </ChatSwipeRow>
  );
});

/** A button in the list's header capsule; the capsule draws the glass behind them all. */
function HeaderButton({ label, icon, onPress }: { label: string; icon: IconData; onPress: () => void }) {
  const s = useS();
  const { colors } = useTheme();
  // A press tints the glass instead of fading it: UIKit drops Liquid Glass for good when an ancestor's alpha changes.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={s.headerButton}
    >
      {({ pressed }) => (
        <>
          {pressed && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 20, backgroundColor: colors.hover }]} />}
          <Icon icon={icon} tone="ink" size={20} />
        </>
      )}
    </Pressable>
  );
}

/** The Liquid Glass behind the header capsule, as the list's floating controls have. */
function HeaderGlass() {
  const { colors } = useTheme();
  return (
    <LiquidGlassView
      pointerEvents="none"
      glassType="regular"
      isInteractive={false}
      reducedTransparencyFallbackColor={colors.surface}
      style={[StyleSheet.absoluteFill, { borderRadius: 20, borderCurve: "continuous" }]}
    />
  );
}

/** "2 computers offline" in ink3 at the end of the list, with Retry reading just those computers again. */
function OfflineLine({ hostIds }: { hostIds: string[] }) {
  const s = useS();
  const { colors } = useTheme();
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    void allComputers.refreshHosts(hostIds).finally(() => alive.current && setRetrying(false));
  };
  return (
    <View style={s.offlineLine}>
      <Text style={{ color: colors.ink3, fontSize: 13 }}>{hostIds.length === 1 ? "1 computer offline" : `${hostIds.length} computers offline`}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry offline computers" disabled={retrying} hitSlop={8} onPress={retry}>
        <Text style={{ color: colors.ink3, fontSize: 13, fontWeight: "600", opacity: retrying ? 0.5 : 1 }}>{retrying ? "Retrying..." : "Retry"}</Text>
      </Pressable>
    </View>
  );
}

/** A Chat's computer: its icon and name, with an offline mark when it isn't answering. */
function ComputerTag({ name, offline, chip = false, large = false }: { name: string; offline: boolean; chip?: boolean; large?: boolean }) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }, chip && s.chip]}>
      <Icon icon={offline ? CloudOffIcon : isDesktopComputer(name) ? ComputerIcon : LaptopIcon} tone={offline ? "orange" : "ink3"} size={large ? 14 : 13} />
      <Text numberOfLines={1} style={[large ? s.inboxText : s.detail, { flexShrink: 1 }, offline && { color: colors.orangeInk }]}>
        {offline ? `${name}, offline` : name}
      </Text>
    </View>
  );
}

const makeS = (colors: Palette) =>
  StyleSheet.create({
    secondary: { color: colors.ink2, fontSize: 15 },
    detail: { color: colors.ink2, fontSize: 12 },
    headerGroup: { flexDirection: "row", alignItems: "center", height: 40, paddingHorizontal: 2, borderRadius: 20, borderCurve: "continuous" },
    headerButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    startEmpty: { alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 80 },
    startTitle: { color: colors.ink, fontSize: 17, fontWeight: "600", textAlign: "center", marginBottom: 14 },
    startCard: {
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 16,
      borderRadius: 18,
      borderCurve: "continuous",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    projectHit: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 16 },
    headerDot: { position: "absolute", right: 4, top: 4, width: 8, height: 8, borderRadius: 4 },
    chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderCurve: "continuous", backgroundColor: colors.field },
    project: { flexDirection: "row", alignItems: "center", marginTop: 12, paddingHorizontal: 8 },
    doneRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: 16 },
    divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 16, marginTop: 12 },
    projectTitle: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8 },
    chat: { flexDirection: "row", alignItems: "center" },
    subchat: { paddingLeft: 16 },
    subchatGuide: { position: "absolute", left: 24, top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
    subchatToggle: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 22 },
    grouped: { marginVertical: 2, marginHorizontal: 8, borderRadius: 8, borderCurve: "continuous" },
    chatBody: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingLeft: 12, paddingVertical: 8 },
    line: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 },
    unread: { width: 8, height: 8, borderRadius: 4 },
    inbox: { position: "relative" },
    inboxContent: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    inboxLine: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20, overflow: "hidden" },
    inboxTitle: { flex: 1, fontSize: 16, lineHeight: 21 },
    inboxTime: { color: colors.ink3, fontSize: 13, fontVariant: ["tabular-nums"] },
    inboxText: { color: colors.ink2, fontSize: 14 },
    inboxSeparator: { color: colors.ink3, fontSize: 14 },
    inboxPart: { flexDirection: "row", alignItems: "center", gap: 6 },
    chatTitle: { color: colors.ink, fontSize: 15, lineHeight: 20 },
    notice: { minHeight: 44, justifyContent: "center", paddingLeft: 42, paddingRight: 12 },
    offlineLine: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  });
const useS = createStylesHook(makeS);
