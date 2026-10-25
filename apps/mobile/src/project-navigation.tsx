import { chatSummary } from "@milagre/shared/chat-summary";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Href } from "expo-router";
import {
  Add01Icon,
  ArrowDown01Icon,
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
} from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { chatMarkTone, chatPullRequests, chatTitle, comparePins, pendingChatSessionId, pullRequestRefs, withPendingChat } from "@milagre/shared/chats";
import { searchMessages } from "@milagre/shared/message-search";
import { unreadRunRoutines } from "@milagre/shared/routines";
import type { AgentSession, PullRequest } from "@milagre/shared/model";
import type { LinearIssue } from "@milagre/shared/linear";
import type { ChatSearchMatch, Client, RegisteredProject, Snapshot } from "./client";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { useComposer, usePendingChats, useSession, type MobilePendingChat } from "./session";
import { savedFoldedProjects } from "./hosts-native";
import { useLinks } from "./use-links";
import { useRoutinesAvailable } from "./use-routines";
import { endNamer, linkMenuSection, linkWorktree, linkedAccessibilityLabel, linkedLabels, type LinkChat } from "./chat-links";
import { linkWithChat, removeLinkFromChat } from "./link-actions";
import { afterSend, selectedModel, sendOptions, turnTarget } from "./turn-options";
import { chatMark, type ChatMark } from "./indicators";
import { shownChat } from "./chat-list-filter";
import { backgroundLabel, chatActivity } from "@milagre/shared/chat-activity";
import { ChatMarkIcon } from "./status-indicators";
import { Icon } from "./icons";
import { LoadingLogo } from "./loading-logo";
import { ErrorNotice, IconButton, PullDown, useStyles } from "./ui";
import { HoverView } from "./primitives/hover";
import { subscribeNavigation, takeNavigation, type NavigationCommand } from "./navigation-commands";
import { ProjectIcon, ProjectIcons } from "./project-icon";
import { ProjectSearch } from "./project-search";
import { chatMenu, runChatAction } from "./chat-actions";
import { confirm } from "./confirm-store";
import { showChoiceSheet } from "./choice-store";
import { ArchivingOverlay, useArchiveActivity } from "./archive-progress";
import { clearArchiveNotice, showArchiveNotice } from "./archive";
import { AttentionDot, useAttention } from "./attention";
import { lastUserModel, projectOfKey } from "@milagre/shared/agent-runs";
import { useChatPullRequests } from "./use-chat-pull-requests";
import { ChatPullRequestChips } from "./chat-pull-request-chips";
import { useLinear } from "./use-linear";
import { useWorktreeLinearIssues } from "./use-worktree-linear-issues";
import { createStylesHook, fonts, useTheme, type Palette } from "./theme";
import { activityAgo } from "@milagre/shared/chat-row";
import { useActivityClock, useChatRowShow } from "./chat-row-store";
import { useChatList } from "./chat-display-setting";
import { allComputers, useAllComputers, useFoldedProjects } from "./all-computers";
import type { HostView, ProjectCopy, Reach } from "./all-computers-store";
import { mergeChatLists } from "./chat-list-order";
import { ChatListControls, useControlsBottomInset, useControlsVisibility } from "./chat-list-controls";
import { isDesktopComputer } from "./computer-actions";

/** Secondary screens push over the current one; a sheet also leaves the sidebar open under it, as confirmations do. */
type Destination = (href: Href, secondary?: boolean | "sheet") => void;
/** The computer a row belongs to: every row and every action carries it, since two computers can share a path and a Chat id. */
type HostTag = { hostId: string; hostName: string; reach: Reach };
type Row = { key: string; path: string } & (
  | ({ kind: "project"; name: string; expanded: boolean; members?: RegisteredProject[]; link: boolean; chip: boolean } & HostTag)
  | { kind: "section"; name: string }
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
    } & HostTag)
  | ({ kind: "message"; chat: AgentSession; title: string; snippet: string; highlight: [number, number] } & HostTag)
  | ({ kind: "notice"; message: string; failed?: boolean; retry?: "project" } & HostTag)
  /** The one quiet line for every computer that isn't answering; Retry reads those computers again. */
  | { kind: "offline"; hostIds: string[] }
);
type ChatRow = Extract<Row, { kind: "chat" }>;
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
  link: boolean;
  members?: RegisteredProject[];
  copy?: ProjectCopy;
  /** The Project's Chats before the search filter, newest first. */
  all: ChatEntry[];
  chats: ChatEntry[];
  failure?: string;
};
type HostBuild = HostTag & { projects: ProjectBuild[]; loaded: boolean };
type BuildContext = {
  needle: string;
  currentHostId?: string;
  snapshot: Snapshot | null;
  pendingChats: Record<string, MobilePendingChat>;
  archiving: (projectPath: string, chatId: number) => boolean;
  fallback: (path: string) => ProjectCopy | undefined;
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
  const current = view.hostId === ctx.currentHostId;
  const projects: ProjectBuild[] = [];
  for (const project of view.projects) {
    if (project.hidden) continue;
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
    const all: ChatEntry[] = Object.values(copy?.project.state.sessions || {})
      .map((chat) => {
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
      })
      // Like desktop's sidebar, a worktree's empty starter Chat stays out until it has a message or a turn is starting.
      // A Chat stays in its place while its archive runs, under the progress, until the archive ends.
      .filter(
        ({ chat, run, count }) =>
          (!chat.archived || ctx.archiving(copy?.project.path ?? project.path, chat.id)) && shownChat(chat, run, count, { archived: false }),
      )
      // Pinned Chats first in their order, then the newest Chat first, by when it was created, so rows don't jump around as agents reply.
      .sort((a, b) => comparePins(a.chat, b.chat) || b.sortId - a.sortId)
      .map(({ chat, title, sortId, pending, mark, background }) => ({
        chat,
        title,
        sortId,
        mark,
        background,
        pending,
        worktree: pending?.newWorktree ? "New worktree" : copy?.project.state.worktrees[chat.worktree_id]?.name || "Worktree",
        prPath: !pending && !copy?.project.link ? copy?.project.state.worktrees[chat.worktree_id]?.path : undefined,
        prRefs: chat.summary?.pullRequests ?? copy?.project.pullRequestRefs?.[chat.id] ?? pullRequestRefs(byChat.get(chat.id) || []),
      }));
    const chats = ctx.needle
      ? all.filter(({ title, worktree }) => [name, title, worktree, view.name].some((text) => text?.toLowerCase().includes(ctx.needle)))
      : all;
    projects.push({
      path: project.path,
      name,
      link: !!project.link,
      members: project.projects,
      copy,
      all,
      chats,
      failure: view.errors.get(project.path),
    });
  }
  return { hostId: view.hostId, hostName: view.name, reach: view.state, projects, loaded: view.loaded };
}

/** The same project tree is the first-run destination and the drawer over a Chat: every computer's Chats, their ⋯ actions and search. */
type NavigationProps = {
  onNavigate: Destination;
  onClose?: () => void;
  activeChatId?: number;
  /** False while the sidebar is mounted but off screen: nothing is read from the computers then. */
  visible?: boolean;
  /** Pinned beside the Chat on a wide iPad: it never closes, and picking the open Chat leaves it be. */
  docked?: boolean;
  /** Drawn on a card's surface color (the pinned sidebar and the one sliding over) instead of the page's. */
  surface?: boolean;
};
export function ProjectNavigation({ onNavigate, onClose, activeChatId, visible = true, docked = false, surface = docked }: NavigationProps) {
  const s = useS();
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const composer = useComposer();
  const { pendingChats } = usePendingChats();
  const links = useLinks(session.client);
  // An older Mac or a confined phone has no Routines to show, so the dock leaves the button out.
  const routinesAvailable = useRoutinesAvailable(session.client);
  const insets = useSafeAreaInsets();
  const attention = useAttention();
  const { reloadProjects, cachedProject } = session;
  const currentPath = session.snapshot?.project.path;
  const currentHostId = session.client?.url;
  const [chatList] = useChatList();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const searching = !!needle;
  const views = useAllComputers({ visible, expandAll: chatList === "list" || searching });
  const folds = useFoldedProjects(views.map((view) => view.hostId));
  const rowShow = useChatRowShow();
  // Last activity reads "5m"; the clock ticks only while the rows show it.
  const now = useActivityClock(rowShow.lastActivity);
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

  const clientOf = (hostId: string): Client | null => (hostId === session.client?.url ? session.client : allComputers.clientFor(hostId));
  // The copy of a Project this list reads: the open one's live snapshot, otherwise the last answer of its computer.
  const copyOf = (hostId: string, projectPath: string): ProjectCopy | undefined =>
    hostId === currentHostId && projectPath === currentPath && session.snapshot
      ? session.snapshot
      : (allComputers.viewOf(hostId)?.copies.get(projectPath) ?? (hostId === currentHostId ? cachedProject(projectPath) : undefined));
  const load = (hostId: string, projectPath: string): Promise<unknown> =>
    hostId === currentHostId && projectPath === currentPath ? session.refresh() : allComputers.refreshProject(hostId, projectPath).catch(() => {});

  // Each computer's rows are rebuilt only when that computer's data, the search or what it overlays changes.
  const [cache] = useState(() => new Map<string, { deps: unknown[]; build: HostBuild }>());
  const builds = useMemo(() => {
    const archiving = (hostId: string) => (projectPath: string, chatId: number) =>
      archives.chats.has(`${projectPath}#${chatId}`) && (hostId === currentHostId || archiveRequests.has(`${hostId}|${projectPath}#${chatId}`));
    const next = views.map((view) => {
      const current = view.hostId === currentHostId;
      const deps = [view, needle, pendingChats, archives.chats, current ? session.snapshot : null, current ? cachedProject : null, current];
      const held = cache.get(view.hostId);
      if (held && sameDeps(held.deps, deps)) return held.build;
      const build = buildHost(view, {
        needle,
        currentHostId,
        snapshot: session.snapshot,
        pendingChats,
        archiving: archiving(view.hostId),
        fallback: cachedProject,
      });
      cache.set(view.hostId, { deps, build });
      return build;
    });
    for (const id of cache.keys()) if (!views.some((view) => view.hostId === id)) cache.delete(id);
    return next;
  }, [views, needle, pendingChats, archives.chats, session.snapshot, cachedProject, currentHostId, cache, archiveRequests]);

  const manyHosts = builds.length > 1;
  const { rows, searchable } = useMemo(() => {
    const result: Row[] = [];
    // Each Project's Chats under the current search, for the message search below when no Chat title matches.
    const found: {
      path: string;
      // Null for a Project searched on the host (hostMatches).
      messages: NonNullable<ProjectBuild["copy"]>["project"]["state"]["messages"] | null;
      chats: Map<number, { chat: AgentSession; title: string }>;
    }[] = [];
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
    const offlineIds = builds.filter((build) => build.reach === "offline").map((build) => build.hostId);
    const offlineLine: Row[] = offlineIds.length ? [{ key: "offline", path: "", kind: "offline", hostIds: offlineIds }] : [];
    if (chatList === "list") {
      let rank = 0;
      const lists = builds.flatMap((build) =>
        build.projects.map((project) => {
          const mine = rank++;
          if (needle && build.hostId === currentHostId && project.copy)
            found.push({
              path: project.path,
              messages: project.copy.previewOnly || project.copy.project.state.messagesInChats ? null : project.copy.project.state.messages,
              chats: new Map(project.all.filter(({ pending }) => !pending).map(({ chat, title }) => [chat.id, { chat, title }])),
            });
          return project.chats.map((entry) => ({ rank: mine, chat: entry.chat, row: chatRow(build, project, entry) }));
        }),
      );
      for (const { row } of mergeChatLists(lists)) result.push(row);
      for (const build of builds) {
        const notice = hostNotice(build);
        if (notice) result.push(notice);
      }
      result.push(...offlineLine);
    } else {
      for (const build of builds) {
        // A computer that hasn't answered with its Projects has no group to carry its state.
        const notice = build.projects.length ? null : hostNotice(build);
        if (notice) result.push(notice);
        for (const project of build.projects) {
          const open = searching || !folds.get(build.hostId)?.has(project.path);
          if (needle && build.hostId === currentHostId && project.copy)
            found.push({
              path: project.path,
              messages: project.copy.previewOnly || project.copy.project.state.messagesInChats ? null : project.copy.project.state.messages,
              chats: new Map(project.all.filter(({ pending }) => !pending).map(({ chat, title }) => [chat.id, { chat, title }])),
            });
          if (searching && project.copy && !project.chats.length && !(needle && project.name.toLowerCase().includes(needle)) && !project.failure) continue;
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
              message: !project.copy ? "Loading chats..." : searching ? "No matching chats" : "No chats yet. Start one with +.",
            });
        }
      }
      result.push(...offlineLine);
    }
    return { rows: result, searchable: found };
  }, [builds, chatList, needle, searching, currentHostId, manyHosts, folds]);

  // Projects held without their messages (a preview, or a host that keeps them by Chat) are searched on the host: the
  // open computer's, as before.
  const [hostMatches, setHostMatches] = useState<{ query: string; matches: Record<string, ChatSearchMatch[]> }>({ query: "", matches: {} });
  const hostSearchKey = useMemo(
    () =>
      needle
        ? searchable
            .filter((item) => item.messages === null)
            .map((item) => item.path)
            .join("\n")
        : "",
    [needle, searchable],
  );
  useEffect(() => {
    if (!needle || !hostSearchKey || !session.client) return;
    let cancelled = false;
    const client = session.client;
    const timer = setTimeout(() => {
      void Promise.all(hostSearchKey.split("\n").map(async (path) => [path, await client.searchChats(path, needle).catch(() => [])] as const)).then(
        (found) => !cancelled && setHostMatches({ query: needle, matches: Object.fromEntries(found) }),
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle, hostSearchKey, session.client]);
  // Nothing in a Chat title matched: search what was said in the Chats instead, at most three hits per Chat.
  const listRows = useMemo(() => {
    if (!needle || rows.some((row) => row.kind === "chat") || !currentHostId) return rows;
    const hostName = builds.find((build) => build.hostId === currentHostId)?.hostName ?? "";
    const reach = builds.find((build) => build.hostId === currentHostId)?.reach ?? "online";
    const found: Row[] = [];
    for (const { path, messages, chats } of searchable) {
      const perChat = new Map<number, number>();
      const matches = messages ? searchMessages(messages, needle, 200) : hostMatches.query === needle ? (hostMatches.matches[path] ?? []) : [];
      for (const match of matches) {
        const entry = chats.get(match.message.session_id);
        const count = perChat.get(match.message.session_id) ?? 0;
        if (!entry || count >= 3) continue;
        const { chat, title } = entry;
        perChat.set(chat.id, count + 1);
        found.push({
          key: `${currentHostId}|${path}#${chat.id}:message:${match.message.id}`,
          path,
          kind: "message",
          hostId: currentHostId,
          hostName,
          reach,
          chat,
          title,
          snippet: match.snippet,
          highlight: match.highlight,
        });
      }
    }
    if (!found.length) return rows;
    return [...rows, { key: "section:Messages", path: "", kind: "section" as const, name: "Messages" }, ...found.slice(0, 30)];
  }, [rows, needle, searchable, hostMatches, currentHostId, builds]);

  // A hidden Run Chat nobody opened lights the dock's Routines button, read from the open computer's Projects.
  const unreadRuns = useMemo(() => {
    const states: Record<string, { sessions: Record<string, AgentSession> }> = {};
    for (const project of builds.find((build) => build.hostId === currentHostId)?.projects ?? [])
      if (project.copy) states[project.path] = project.copy.project.state;
    return unreadRunRoutines(states).size > 0;
  }, [builds, currentHostId]);

  // Pull requests and Linear issues are read from the open computer only.
  const prTargets = useMemo(() => {
    const byPath = new Map<string, Set<string>>();
    for (const row of listRows) {
      if (row.kind !== "chat" || row.hostId !== currentHostId || !row.prPath) continue;
      const refs = byPath.get(row.prPath) || new Set<string>();
      for (const ref of row.prRefs || []) refs.add(ref);
      byPath.set(row.prPath, refs);
    }
    return [...byPath].map(([path, refs]) => ({ path, refs: [...refs] }));
  }, [listRows, currentHostId]);
  const prStatus = useChatPullRequests(session.client, prTargets);
  // A Worktree's Linear issue shows its chip on the Chat row, with or without pull requests, while Linear is on.
  const { active: linearActive } = useLinear(session.client);
  const linearPaths = useMemo(
    () => [...new Set(listRows.flatMap((row) => (row.kind === "chat" && row.hostId === currentHostId && row.prPath ? [row.path] : [])))],
    [listRows, currentHostId],
  );
  const linearIssues = useWorktreeLinearIssues(session.client, linearActive ? linearPaths : []);
  // A Link's other end is named by its Project and, when this phone holds that Project, the Worktree's branch.
  const endNames = endNamer(
    links.projects,
    (projectPath, worktreePath) =>
      Object.values(copyOf(currentHostId ?? "", projectPath)?.project.state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath)?.name,
  );
  // Only a local Project's Chat with its own Worktree joins Links; a shared Link Chat (prPath unset) never does.
  const worktreeForLinks = (projectPath: string, worktreePath?: string) => {
    const projectId = links.available && worktreePath ? links.projectIdOf(projectPath) : undefined;
    return projectId && worktreePath ? { project_id: projectId, worktree_path: worktreePath } : undefined;
  };
  const displayedRows = listRows.map((row) => {
    if (row.kind !== "chat" || row.hostId !== currentHostId) return row;
    const status = row.prPath ? prStatus[row.prPath] : undefined;
    return {
      ...row,
      pullRequests: chatPullRequests(row.prRefs || [], status?.found || {}, status?.branch),
      linearIssue: row.prPath ? linearIssues[row.prPath] : undefined,
      linked: linkedLabels(links.links, worktreeForLinks(row.path, row.prPath), endNames).map((end) => end.label),
    };
  });

  /** Where a Chat or a new Chat goes on the computer `hostId`, which is the connected one by now. */
  function navigateTo(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat) {
    const params = { projectPath, hostId };
    if (chatId === undefined) onNavigate({ pathname: "/chat", params });
    else if (hostId === currentHostId && projectPath === currentPath && chatId === activeChatId && (onClose || docked)) onClose?.();
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
    else onNavigate({ pathname: "/chat", params: { ...params, id: String(chatId) } });
  }
  // Choosing a Chat or a new Chat goes there at once on the open computer; the Chat loads the Project behind the splash
  // mark. Another computer is connected first, as a notification opens one, with the splash mark over the list meanwhile.
  async function enter(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat) {
    if (busy) return;
    if (hostId === currentHostId && session.client) {
      navigateTo(hostId, projectPath, chatId, pending);
      return;
    }
    const host = allComputers.hostFor(hostId);
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
      navigateTo(hostId, projectPath, chatId, pending);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // A Chat's ⋯ choice runs against its own computer's client and its own Project's copy, which is reread afterwards.
  // Archive stays in this sidebar, including when its Chat is open behind it, so the row's progress and the list's
  // scroll position stay in place.
  async function act(row: { hostId: string; path: string; chat: AgentSession }, action: string) {
    const { hostId, path: projectPath, chat } = row;
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
    if (action === "archive" && !chat.archived) archiveRequests.add(archiveKey);
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
    } catch (e) {
      if (confirmed) showArchiveNotice(`Could not archive Chat: ${(e as Error).message}`);
      else if (alive.current) setError((e as Error).message);
    } finally {
      archiveRequests.delete(archiveKey);
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
    if (!copy || !client) throw new Error("Connection lost. Reconnect to your computer.");
    const key = `${copy.project.path}#${chat.id}`;
    const preferences = composer.preferences[key] || composer.defaults;
    const turn = turnTarget(composer.preferences[key], chat.provider, composer.defaults);
    const model = selectedModel(turn.provider, turn.model || (!turn.picked ? lastUserModel(copy.project.state, chat.id) : ""), session.models);
    await client.call("chat:send", [
      { projectPath: copy.project.path, sessionId: chat.id, worktreeId: chat.worktree_id, ...message, ...sendOptions(model, preferences) },
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
      "It leaves this list on your phone and your Mac. The folder and its Chats stay on your computer; add it again to bring it back.",
      "Remove",
    );
    if (!confirmed) return;
    setError("");
    try {
      await client.call("project:forget", [projectPath]);
      if (isCurrent) await reloadProjects();
      else await allComputers.refreshAll();
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
  // One Project goes straight to a new Chat; with several, the searchable sheet lists them as "Project — Computer".
  function startNewChat() {
    const choices = builds.flatMap((build) =>
      build.projects.map((project) => ({ hostId: build.hostId, hostName: build.hostName, reach: build.reach, path: project.path, name: project.name })),
    );
    if (choices.length === 1 && choices[0]) {
      void enter(choices[0].hostId, choices[0].path);
      return;
    }
    if (!choices.length) {
      setError("Add a project from your computer to start a Chat.");
      return;
    }
    showChoiceSheet({
      title: "New Chat in",
      placeholder: "Search projects",
      emptyLabel: "No projects",
      items: choices.map((choice) => ({
        id: `${choice.hostId}\n${choice.path}`,
        title: manyHosts ? `${choice.name} — ${choice.hostName}` : choice.name,
        keywords: `${choice.hostName} ${choice.path}`,
        disabled: choice.reach === "offline",
      })),
      onSelect: (id) => {
        const [hostId, ...rest] = id.split("\n");
        if (hostId) void enter(hostId, rest.join("\n"));
      },
    });
  }
  function menuChoice(id: string) {
    if (id === "new") startNewChat();
    else if (id === "add") void startAddProject();
    else if (id === "link") onNavigate("/link-projects", true);
    else if (id === "canvas") onNavigate("/canvas", true);
    else if (id === "choose") onNavigate("/choose-projects", "sheet");
  }

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
          <IconButton label="Back to Chats" icon={ArrowLeft01Icon} size={44} onPress={() => setPage(null)} />
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
            Chats
          </Text>
          <PullDown
            label="Chat actions"
            sections={[
              {
                items: [
                  { id: "new", title: "New Chat", systemImage: "square.and.pencil" },
                  { id: "add", title: "Add project", systemImage: "folder.badge.plus" },
                  { id: "link", title: "Link projects", systemImage: "link" },
                  { id: "canvas", title: "Canvas", systemImage: "square.grid.2x2" },
                ],
              },
              { items: [{ id: "choose", title: "Choose projects", systemImage: "checklist" }] },
            ]}
            onSelect={menuChoice}
          >
            <View style={s.plus}>
              <Icon icon={Add01Icon} tone="ink" size={20} />
            </View>
          </PullDown>
          {onClose && <IconButton label="Close navigation" icon={Cancel01Icon} size={44} onPress={onClose} />}
        </View>
        {error || archives.notice ? <ErrorNotice message={error || archives.notice} /> : null}
      </View>
      <FlatList
        data={displayedRows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
        renderItem={({ item, index }) => {
          if (item.kind === "section")
            return <Text style={[s.detail, { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, fontWeight: "500" }]}>{item.name}</Text>;
          if (item.kind === "offline") return <OfflineLine hostIds={item.hostIds} />;
          const offline = item.reach === "offline";
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
              ...(!linked ? [{ items: [{ id: "remove", title: "Remove from list", systemImage: "minus.circle", destructive: true }] }] : []),
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
                    {item.chip && <ComputerTag name={item.hostName} offline={offline} chip />}
                    <View style={{ flex: 1 }} />
                    {unsaved && (
                      <Text accessibilityLabel="Changes not saved" style={[s.detail, { color: colors.red }]}>
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
                <PullDown label={`Actions for ${item.name}`} title={item.name} sections={menu} onSelect={choose}>
                  <View style={{ width: 36, height: 44, alignItems: "center", justifyContent: "center" }}>
                    <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
                  </View>
                </PullDown>
              </View>
            );
          }
          if (item.kind === "message") {
            const [start, end] = item.highlight;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.snippet}, in ${item.title}`}
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
                      {item.title}
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
          const selected = currentHostId === item.hostId && currentPath === item.path && activeChatId === item.chat.id;
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
          const markColor = tone === "accent" ? colors.accentInk : colors[tone];
          const menu = chatMenu(
            item.chat,
            copy?.project.link ? { path: copy.project.state.worktrees[item.chat.worktree_id]?.path } : copy?.project.state.worktrees[item.chat.worktree_id],
            item.hostId === currentHostId
              ? linkMenuSection({ available: links.available, worktreePath: worktreeForLinks(item.path, item.prPath)?.worktree_path, linked: linked.length })
              : null,
          );
          // While it archives, the row stays put under the progress and takes no taps.
          const archiving =
            archives.chats.has(`${copy?.project.path ?? item.path}#${item.chat.id}`) &&
            (item.hostId === currentHostId || archiveRequests.has(`${item.hostId}|${item.path}#${item.chat.id}`));
          const grouped = chatList === "grouped";
          const label = `${title}${item.chat.pinned ? ", pinned" : ""}, ${grouped ? item.worktree : `${item.project}, ${item.worktree}`}${markLabel ? `, ${markLabel}` : ""}${item.many ? `, ${item.hostName}${offline ? ", offline" : ""}` : ""}${linked.length ? `, ${linkedAccessibilityLabel(linked)}` : ""}`;
          const secondLine = !!branchLine || !!diff || lastAt !== undefined || !!item.chat.pinned || !!linkedIcon || !!markLabel;
          const next = displayedRows[index + 1];
          // A thin divider under every row of the list, except the last.
          const divided = !grouped && next?.kind === "chat";
          // A tap opens the Chat and a long press opens its ⋯ menu, as on desktop's sidebar.
          return (
            <View pointerEvents={archiving ? "none" : "auto"} style={{ opacity: offline ? 0.55 : 1 }}>
              <HoverView
                style={[s.chat, grouped && s.grouped, { backgroundColor: selected && !archiving ? selectedFill : "transparent" }]}
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
                    onPress={() => {
                      if (!archiving) void enter(item.hostId, item.path, item.chat.id, item.pending);
                    }}
                    style={{ flex: 1 }}
                  >
                    {grouped ? (
                      <View style={[s.chatBody, hasChips && { minHeight: 28, paddingTop: 6, paddingBottom: 0 }]}>
                        <ChatMarkIcon mark={item.mark} background={item.background} />
                        <View style={{ flex: 1, gap: 3 }}>
                          <Text
                            numberOfLines={hasChips ? 1 : 2}
                            style={[
                              s.chatTitle,
                              { color: item.chat.unread || selected ? colors.ink : colors.ink2, fontWeight: item.chat.unread ? "600" : "500" },
                            ]}
                          >
                            {title}
                          </Text>
                          {!hasChips && secondLine && (
                            <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
                              {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                              {linkedIcon}
                              {!copy?.project.link && !!branchLine && <Icon icon={GitBranchIcon} tone="ink3" size={12} />}
                              {!!branchLine && (
                                <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                                  {branchLine}
                                </Text>
                              )}
                              {facts}
                              {!!markLabel && <Text style={[s.detail, { color: markColor }]}>{markLabel}</Text>}
                            </View>
                          )}
                        </View>
                      </View>
                    ) : (
                      <View style={s.listBody}>
                        <View style={s.line}>
                          {item.members?.[0] ? (
                            <ProjectIcon client={clientOf(item.hostId)} path={item.members[0].path} size={16} />
                          ) : (
                            <ProjectIcon client={clientOf(item.hostId)} path={item.path} size={16} />
                          )}
                          <Text numberOfLines={1} style={[s.project2, { flex: 1 }]}>
                            {item.project}
                          </Text>
                          {markLabel ? (
                            <Text numberOfLines={1} style={[s.detail, { color: markColor, fontWeight: "500" }]}>
                              {markLabel}
                            </Text>
                          ) : (
                            item.chat.unread && <View accessibilityLabel="Unread" style={[s.unread, { backgroundColor: colors[chatMarkTone("unread")] }]} />
                          )}
                          {lastAt !== undefined && <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>{activityAgo(lastAt, now)}</Text>}
                        </View>
                        <Text numberOfLines={hasChips ? 1 : 2} style={[s.listTitle, { color: colors.ink, fontWeight: item.chat.unread ? "600" : "500" }]}>
                          {title}
                        </Text>
                        <View style={s.line}>
                          {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                          {linkedIcon}
                          {!!branchLine && (
                            <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, fontFamily: fonts.mono }]}>
                              {branchLine}
                            </Text>
                          )}
                          {facts}
                          {item.many && (
                            <>
                              {!!branchLine && <Text style={s.detail}>·</Text>}
                              <ComputerTag name={item.hostName} offline={offline} />
                            </>
                          )}
                        </View>
                      </View>
                    )}
                  </PullDown>
                  {hasChips && (
                    <View style={grouped ? undefined : { marginLeft: -26 }}>
                      <ChatPullRequestChips pullRequests={pullRequests} linearIssue={linearIssue}>
                        {grouped && item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                        {grouped && linkedIcon}
                        {grouped && facts}
                        {grouped && !!markLabel && (
                          <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, color: markColor }]}>
                            {markLabel}
                          </Text>
                        )}
                      </ChatPullRequestChips>
                    </View>
                  )}
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
              {divided && <View style={[s.divider, { backgroundColor: colors.line }]} />}
            </View>
          );
        }}
      />
      <ChatListControls
        hidden={controls.hidden}
        query={query}
        onQuery={setQuery}
        inputRef={searchInput}
        onFocus={controls.reveal}
        routines={routinesAvailable ? { unread: unreadRuns } : undefined}
        onRoutines={() => onNavigate("/routines", true)}
        onSettings={() => onNavigate("/settings", true)}
        visible={visible}
      />
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
function ComputerTag({ name, offline, chip = false }: { name: string; offline: boolean; chip?: boolean }) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }, chip && s.chip]}>
      <Icon icon={offline ? CloudOffIcon : isDesktopComputer(name) ? ComputerIcon : LaptopIcon} tone={offline ? "orange" : "ink3"} size={13} />
      <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }, offline && { color: colors.orange }]}>
        {offline ? `${name}, offline` : name}
      </Text>
    </View>
  );
}

const makeS = (colors: Palette) =>
  StyleSheet.create({
    secondary: { color: colors.ink2, fontSize: 15 },
    detail: { color: colors.ink2, fontSize: 12 },
    plus: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.field, alignItems: "center", justifyContent: "center" },
    chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderCurve: "continuous", backgroundColor: colors.field },
    project: { flexDirection: "row", alignItems: "center", marginTop: 12, paddingHorizontal: 8 },
    projectTitle: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8 },
    chat: { flexDirection: "row", alignItems: "center" },
    grouped: { marginVertical: 2, marginHorizontal: 8, borderRadius: 8, borderCurve: "continuous" },
    chatBody: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingLeft: 12, paddingVertical: 8 },
    listBody: { gap: 3, paddingLeft: 16, paddingVertical: 10 },
    line: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 },
    project2: { color: colors.ink2, fontSize: 13, fontWeight: "500" },
    listTitle: { fontSize: 16, lineHeight: 21 },
    unread: { width: 8, height: 8, borderRadius: 4 },
    divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
    chatTitle: { color: colors.ink, fontSize: 15, lineHeight: 20 },
    notice: { minHeight: 44, justifyContent: "center", paddingLeft: 42, paddingRight: 12 },
    offlineLine: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  });
const useS = createStylesHook(makeS);
