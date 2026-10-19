import { UpdateSettingsBadge } from "./update-sheet";
import { chatSummary } from "@milagre/shared/chat-summary";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Href } from "expo-router";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FilterHorizontalIcon,
  FolderAddIcon,
  GitBranchIcon,
  GitMergeIcon,
  LaptopIcon,
  Link04Icon,
  MoreHorizontalIcon,
  PinIcon,
  RepeatIcon,
  Search01Icon,
  Settings01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  chatMarkTone,
  chatPullRequests,
  chatTitle,
  comparePins,
  isListedChat,
  pendingChatSessionId,
  pullRequestRefs,
  withPendingChat,
} from "@milagre/shared/chats";
import { searchMessages } from "@milagre/shared/message-search";
import type { AgentSession, PullRequest } from "@milagre/shared/model";
import type { LinearIssue } from "@milagre/shared/linear";
import type { ChatSearchMatch, RegisteredProject } from "./client";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { useComposer, usePendingChats, useSession, type MobilePendingChat } from "./session";
import { savedFoldedProjects } from "./hosts-native";
import { useLinks } from "./use-links";
import { useRoutinesAvailable } from "./use-routines";
import { endNamer, linkMenuSection, linkWorktree, linkedAccessibilityLabel, linkedLabels, type LinkChat } from "./chat-links";
import { linkWithChat, removeLinkFromChat } from "./link-actions";
import { afterSend, selectedModel, sendOptions, turnTarget } from "./turn-options";
import { chatMark, type ChatMark } from "./indicators";
import { backgroundLabel, chatActivity } from "@milagre/shared/chat-activity";
import { ChatMarkIcon } from "./status-indicators";
import { Icon } from "./icons";
import { LoadingLogo } from "./loading-logo";
import { ErrorNotice, Field, IconButton, PullDown, useStyles } from "./ui";
import { ProjectIcon, ProjectIcons } from "./project-icon";
import { ProjectSearch } from "./project-search";
import { chatMenu, runChatAction } from "./chat-actions";
import { confirm } from "./confirm-store";
import { ArchivingOverlay, useArchiveActivity } from "./archive-progress";
import { clearArchiveNotice, showArchiveNotice } from "./archive";
import { AttentionDot, useAttention } from "./attention";
import { lastUserModel, projectOfKey } from "@milagre/shared/agent-runs";
import { useChatPullRequests } from "./use-chat-pull-requests";
import { ChatPullRequestChips } from "./chat-pull-request-chips";
import { useLinear } from "./use-linear";
import { useWorktreeLinearIssues } from "./use-worktree-linear-issues";
import { createStylesHook, useTheme, type Palette } from "./theme";
import { activityAgo, CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { saveChatRowShow, useActivityClock, useChatRowShow } from "./chat-row-store";

/** Secondary screens push over the current one; a sheet also leaves the sidebar open under it, as confirmations do. */
type Destination = (href: Href, secondary?: boolean | "sheet") => void;
type Row = { key: string; path: string } & (
  | { kind: "project"; name: string; expanded: boolean; members?: RegisteredProject[] }
  | { kind: "section"; name: string }
  | {
      kind: "chat";
      chat: AgentSession;
      title: string;
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
    }
  | { kind: "message"; chat: AgentSession; title: string; snippet: string; highlight: [number, number] }
  | { kind: "notice"; message: string; failed?: boolean }
);
type Show = "all" | "needs" | "running" | "archived";
const SHOW: [Show, string, string][] = [
  ["all", "All Chats", "bubble.left.and.bubble.right"],
  ["needs", "Needs me", "exclamationmark.bubble"],
  ["running", "Running", "play.circle"],
  ["archived", "Archived", "archivebox"],
];
// What a Chat row can show under its title (the Filters menu's "On chats"); the computer is a desktop choice.
const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");
const FIELD_SYMBOLS: Record<string, string> = {
  pullRequests: "arrow.triangle.pull",
  linearIssue: "ticket",
  branch: "arrow.triangle.branch",
  diff: "plusminus",
  lastActivity: "clock",
};
const NEEDS: ChatMark[] = ["question", "waiting", "interrupted", "failed", "unread"];
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

/** The same project tree is the first-run destination and the drawer over a Chat: every Project's Chats, their ⋯ actions and filters. */
type NavigationProps = { onNavigate: Destination; onClose?: () => void; activeChatId?: number };
export function ProjectNavigation(props: NavigationProps) {
  const { client } = useSession();
  // A computer's paths, errors and in-flight UI work never belong to another computer.
  return <ProjectNavigationContent key={client?.url || ""} {...props} />;
}

function ProjectNavigationContent({ onNavigate, onClose, activeChatId }: NavigationProps) {
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
  const { reloadProjects, previewProject, cachedProject } = session;
  const currentPath = session.snapshot?.project.path;
  // Every group is open unless it was folded by hand, here or in an earlier visit: going back to the sidebar
  // doesn't fold the others.
  const hostId = session.client?.url ?? "";
  const folded = useSyncExternalStore(savedFoldedProjects.subscribe, () => savedFoldedProjects.folded(hostId));
  const foldsRead = useSyncExternalStore(savedFoldedProjects.subscribe, () => savedFoldedProjects.loaded(hostId));
  useEffect(() => {
    void savedFoldedProjects.load(hostId);
  }, [hostId]);
  // Snapshots live in the session, so closing the drawer or switching Projects keeps them.
  const [revision, setRevision] = useState(0);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const rowShow = useChatRowShow();
  // Last activity reads "5m"; the clock ticks only while the rows show it.
  const now = useActivityClock(rowShow.lastActivity);
  const [page, setPage] = useState<"add" | null>(null);
  const [busy, setBusy] = useState(false);
  const archives = useArchiveActivity();
  const archiveRequests = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  const pending = useRef(new Map<string, Promise<void>>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void reloadProjects().catch((e) => setError(e.message));
  }, [reloadProjects]);
  const load = useCallback(
    (projectPath: string) => {
      const existing = pending.current.get(projectPath);
      if (existing) return existing;
      const work = previewProject(projectPath)
        .then(() => {
          if (!alive.current) return;
          setRevision((value) => value + 1);
          setFailures((previous) => {
            const next = { ...previous };
            delete next[projectPath];
            return next;
          });
        })
        .catch((e) => {
          if (alive.current) setFailures((previous) => ({ ...previous, [projectPath]: e.message }));
        })
        .finally(() => {
          pending.current.delete(projectPath);
        });
      pending.current.set(projectPath, work);
      return work;
    },
    [previewProject],
  );
  // Hidden Projects and Links stay out of the list, searches included.
  const listed = useMemo(() => session.recent.filter((item) => !item.hidden), [session.recent]);
  // Searching or filtering reads every Project; ordinary browsing only reads open groups.
  const searching = !!query.trim() || show !== "all";
  // The selected Project has its own subscription in session.tsx. Refresh the other visible groups, including
  // before the phone opens a Chat. Polling avoids using one of the host's limited live sockets per Project.
  const previewPaths =
    foldsRead || searching
      ? listed
          .filter((item) => item.path !== currentPath && (searching || !folded.has(item.path)))
          .map((item) => item.path)
          .join("\n")
      : "";
  useEffect(() => {
    if (!session.client || !previewPaths) return;
    const paths = previewPaths.split("\n");
    let generation = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const current = ++generation;
      clearTimeout(timer);
      if (stopped || AppState.currentState !== "active") return;
      await Promise.all(paths.map(load));
      if (!stopped && current === generation && AppState.currentState === "active") timer = setTimeout(refresh, 4000);
    };
    const subscription = AppState.addEventListener("change", () => void refresh());
    void refresh();
    return () => {
      stopped = true;
      generation++;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [session.client, previewPaths, load]);
  // Projects held without their messages (a drawer preview, or a host that keeps them by Chat) are searched on the host.
  const [hostMatches, setHostMatches] = useState<{ query: string; matches: Record<string, ChatSearchMatch[]> }>({ query: "", matches: {} });
  const hostSearchPaths = useMemo(
    () =>
      query.trim()
        ? listed
            .filter((item) => {
              const copy = cachedProject(item.path);
              return copy && (copy.previewOnly || copy.project.state.messagesInChats);
            })
            .map((item) => item.path)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision changes when a cached Project does.
    [query, listed, cachedProject, revision],
  );
  const hostSearchKey = hostSearchPaths.join("\n");
  useEffect(() => {
    const needle = query.trim();
    if (!needle || !hostSearchKey || !session.client) return;
    let cancelled = false;
    const client = session.client;
    const timer = setTimeout(() => {
      void Promise.all(hostSearchKey.split("\n").map(async (path) => [path, await client.searchChats(path, needle).catch(() => [])] as const)).then(
        (found) => !cancelled && setHostMatches({ query: needle.toLowerCase(), matches: Object.fromEntries(found) }),
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, hostSearchKey, session.client]);
  const rows = useMemo(() => {
    const result: Row[] = [];
    const needle = query.trim().toLowerCase();
    // Each Project's Chats under the current filter, for the message search below when no Chat title matches.
    const searchable: {
      path: string;
      // Null for a Project searched on the host (hostMatches).
      messages: NonNullable<ReturnType<typeof cachedProject>>["project"]["state"]["messages"] | null;
      chats: Map<number, { chat: AgentSession; title: string }>;
    }[] = [];
    for (const project of listed) {
      const saved = project.path === currentPath && session.snapshot ? session.snapshot : cachedProject(project.path);
      const previews = Object.values(pendingChats).filter((item) => item.hostId === session.client?.url && item.projectPath === project.path);
      const projected = saved && previews.reduce((state, item) => withPendingChat(state, item.preview), saved.project.state);
      const copy = saved && projected ? { ...saved, project: { ...saved.project, state: projected } } : saved;
      const pendingById = new Map(
        previews.map((item) => [saved ? (pendingChatSessionId(saved.project.state, item.preview) ?? item.preview.session.id) : item.preview.session.id, item]),
      );
      const name = project.name || project.path.split("/").at(-1) || "Project";
      const open = searching || !folded.has(project.path);
      // Keep message lookup linear even in large Projects.
      const byChat = new Map<number, NonNullable<typeof copy>["project"]["state"]["messages"]>();
      for (const message of copy?.project.state.messages || []) {
        const list = byChat.get(message.session_id) || [];
        list.push(message);
        byChat.set(message.session_id, list);
      }
      const marked = Object.values(copy?.project.state.sessions || {}).map((chat) => {
        const run = copy?.runs.runs[`${copy.project.path}#${chat.id}`];
        const pending = pendingById.get(chat.id);
        const sortId = chatSummary(chat, byChat.get(chat.id)).firstId ?? chat.id;
        return {
          chat,
          title: chatTitle(chat, byChat.get(chat.id)),
          run,
          pending,
          sortId,
          mark: pending && !pending.accepted ? ("running" as const) : chatMark(chat, run, byChat.get(chat.id) || []),
          // How many background agents still work, for a background mark (chat-activity.mjs).
          background: chatActivity(chat, run).background,
        };
      });
      // Like desktop's sidebar, a worktree's empty starter Chat stays out until it has a message or a turn is starting.
      const shown = marked
        .filter(
          ({ chat, run }) =>
            // A Chat stays in its place while its archive runs, under the progress, until the archive ends.
            (show === "archived") === (!!chat.archived && !archives.chats.has(`${copy?.project.path}#${chat.id}`)) &&
            (run || isListedChat(chat, chatSummary(chat, byChat.get(chat.id)).count)),
        )
        .filter(({ mark }) => show !== "needs" || NEEDS.includes(mark))
        .filter(({ mark }) => show !== "running" || mark === "running" || mark === "background");
      if (needle && copy)
        searchable.push({
          path: project.path,
          messages: copy.previewOnly || copy.project.state.messagesInChats ? null : copy.project.state.messages,
          chats: new Map(shown.filter(({ pending }) => !pending).map(({ chat, title }) => [chat.id, { chat, title }])),
        });
      const chats = shown
        .filter(
          ({ chat, title }) =>
            !needle || [name, title, copy?.project.state.worktrees[chat.worktree_id]?.name].some((text) => text?.toLowerCase().includes(needle)),
        )
        // Pinned Chats first in their order, then the newest Chat first, by when it was created, so rows don't jump around as agents reply.
        .sort((a, b) => comparePins(a.chat, b.chat) || b.sortId - a.sortId);
      if (searching && copy && !chats.length && !(needle && name.toLowerCase().includes(needle)) && !failures[project.path]) continue;
      const section = project.link ? "Links" : "Projects";
      if (listed.some((item) => item.link) && !result.some((row) => row.kind === "section" && row.name === section))
        result.push({ key: `section:${section}`, path: "", kind: "section", name: section });
      result.push({ key: project.path, path: project.path, kind: "project", name, expanded: open, members: project.projects });
      if (!open) continue;
      for (const { chat, title, mark, background, pending } of chats)
        result.push({
          key: `${project.path}#${chat.id}`,
          path: project.path,
          kind: "chat",
          chat,
          title,
          pending,
          worktree: pending?.newWorktree ? "New worktree" : copy?.project.state.worktrees[chat.worktree_id]?.name || "Worktree",
          prPath: !pending && !copy?.project.link ? copy?.project.state.worktrees[chat.worktree_id]?.path : undefined,
          prRefs: chat.summary?.pullRequests ?? copy?.project.pullRequestRefs?.[chat.id] ?? pullRequestRefs(byChat.get(chat.id) || []),
          mark,
          background,
        });
      if (failures[project.path])
        result.push({
          key: `${project.path}:error`,
          path: project.path,
          kind: "notice",
          message: copy ? "Could not refresh chats. Tap to retry." : "Could not load chats. Tap to retry.",
          failed: true,
        });
      else if (!copy || !chats.length)
        result.push({
          key: `${project.path}:notice`,
          path: project.path,
          kind: "notice",
          message: !copy ? "Loading chats..." : searching ? "No matching chats" : "No chats yet. Start one with +.",
        });
    }
    // Nothing in a Chat title matched: search what was said in the Chats instead, at most three hits per Chat.
    if (needle && !result.some((row) => row.kind === "chat")) {
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
            key: `${path}#${chat.id}:message:${match.message.id}`,
            path,
            kind: "message",
            chat,
            title,
            snippet: match.snippet,
            highlight: match.highlight,
          });
        }
      }
      if (found.length) {
        result.push({ key: "section:Messages", path: "", kind: "section", name: "Messages" });
        result.push(...found.slice(0, 30));
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision invalidates rows after the session's preview cache changes.
  }, [
    revision,
    cachedProject,
    currentPath,
    folded,
    failures,
    query,
    searching,
    show,
    listed,
    session.snapshot,
    session.client?.url,
    pendingChats,
    archives.chats,
    hostMatches,
  ]);

  const prTargets = useMemo(() => {
    const byPath = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.kind !== "chat" || !row.prPath) continue;
      const refs = byPath.get(row.prPath) || new Set<string>();
      for (const ref of row.prRefs || []) refs.add(ref);
      byPath.set(row.prPath, refs);
    }
    return [...byPath].map(([path, refs]) => ({ path, refs: [...refs] }));
  }, [rows]);
  const prStatus = useChatPullRequests(session.client, prTargets);
  // A Worktree's Linear issue shows its chip on the Chat row, with or without pull requests, while Linear is on.
  const { active: linearActive } = useLinear(session.client);
  const linearPaths = useMemo(() => [...new Set(rows.flatMap((row) => (row.kind === "chat" && row.prPath ? [row.path] : [])))], [rows]);
  const linearIssues = useWorktreeLinearIssues(session.client, linearActive ? linearPaths : []);
  // The copy of a Project this list reads: the open one's live snapshot, otherwise the session's last copy.
  const copyOf = (projectPath: string) => (projectPath === currentPath && session.snapshot ? session.snapshot : cachedProject(projectPath));
  // A Link's other end is named by its Project and, when this phone holds that Project, the Worktree's branch.
  const endNames = endNamer(
    links.projects,
    (projectPath, worktreePath) => Object.values(copyOf(projectPath)?.project.state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath)?.name,
  );
  // Only a local Project's Chat with its own Worktree joins Links; a shared Link Chat (prPath unset) never does.
  const worktreeForLinks = (projectPath: string, worktreePath?: string) => {
    const projectId = links.available && worktreePath ? links.projectIdOf(projectPath) : undefined;
    return projectId && worktreePath ? { project_id: projectId, worktree_path: worktreePath } : undefined;
  };
  const displayedRows = rows.map((row) => {
    if (row.kind !== "chat") return row;
    const status = row.prPath ? prStatus[row.prPath] : undefined;
    return {
      ...row,
      pullRequests: chatPullRequests(row.prRefs || [], status?.found || {}, status?.branch),
      linearIssue: row.prPath ? linearIssues[row.prPath] : undefined,
      linked: linkedLabels(links.links, worktreeForLinks(row.path, row.prPath), endNames).map((end) => end.label),
    };
  });

  // Choosing a Chat or a new Chat goes there at once; the Chat loads the Project behind the splash mark, so nothing
  // waits here.
  function select(projectPath: string, chatId?: number, pending?: MobilePendingChat) {
    if (busy || !session.client) return;
    const params = { projectPath, hostId: session.client.url };
    if (chatId === undefined) onNavigate({ pathname: "/chat", params });
    else if (projectPath === currentPath && chatId === activeChatId && onClose) onClose();
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
  // A Chat's ⋯ choice runs against its own Project's copy, which is reread afterwards. Archive stays in this sidebar,
  // including when its Chat is open behind it, so the row's progress and the list's scroll position stay in place.
  async function act(projectPath: string, chat: AgentSession, action: string) {
    const copy = copyOf(projectPath);
    if (!copy || !session.client) return;
    if (action === "link-with" || action === "link-remove") {
      linkAction(projectPath, chat, action);
      return;
    }
    const archiveKey = `${projectPath}#${chat.id}`;
    if (archiveRequests.current.has(archiveKey)) return;
    if (action === "archive" && !chat.archived) archiveRequests.current.add(archiveKey);
    let confirmed = false;
    setError("");
    clearArchiveNotice();
    try {
      await runChatAction({
        action,
        chat,
        running: !!copy.runs.runs[`${copy.project.path}#${chat.id}`],
        client: session.client,
        projectPath: copy.project.path,
        state: copy.project.state,
        link: copy.project.link,
        onConfirm: () => {
          confirmed = true;
        },
        // The phone may show another Project by the time the archive ends, so the list's copy is read again too.
        refresh: () =>
          projectPath !== currentPath ? load(projectPath) : Promise.all([session.refresh(), action === "archive" ? load(projectPath) : undefined]),
        expectActivity: session.expectActivity,
        notify: showArchiveNotice,
      });
    } catch (e) {
      if (confirmed) showArchiveNotice(`Could not archive Chat: ${(e as Error).message}`);
      else if (alive.current) setError((e as Error).message);
    } finally {
      archiveRequests.current.delete(archiveKey);
    }
  }
  /** A Chat as the Link picker names it, or undefined when it can't join a Link (no Worktree, not a local Project). */
  function linkChatOf(projectPath: string, chat: AgentSession, messages?: Parameters<typeof chatTitle>[1]): LinkChat | undefined {
    const copy = copyOf(projectPath);
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
  // The Chats "Link with…" offers: those listed in every local Project this phone already holds, newest first, the
  // open Project's first.
  function linkChats() {
    const paths = [...new Set([currentPath, ...listed.map((item) => item.path)].filter((path): path is string => !!path && !isLinkScopeKey(path)))];
    return paths.flatMap((projectPath) => {
      const copy = copyOf(projectPath);
      if (!copy || copy.project.link) return [];
      const byChat = new Map<number, typeof copy.project.state.messages>();
      for (const message of copy.project.state.messages || []) {
        const list = byChat.get(message.session_id) || [];
        list.push(message);
        byChat.set(message.session_id, list);
      }
      return Object.values(copy.project.state.sessions)
        .filter(
          (chat) => !chat.archived && (copy.runs.runs[`${copy.project.path}#${chat.id}`] || isListedChat(chat, chatSummary(chat, byChat.get(chat.id)).count)),
        )
        .sort((a, b) => b.id - a.id)
        .flatMap((chat) => linkChatOf(projectPath, chat, byChat.get(chat.id) ?? []) ?? []);
    });
  }
  // "Link and ask" sends to the source Chat as its composer would: its own provider and model, its permission mode.
  async function askChat(projectPath: string, chat: AgentSession, message: { body: string; prompt: string }) {
    const copy = copyOf(projectPath);
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
    await (projectPath === currentPath ? session.refresh() : load(projectPath)).catch(() => {});
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
        onAsked: () => select(projectPath, chat.id),
      });
    else void removeLinkFromChat({ client, ends: linkedLabels(links.links, linkWorktree(source), endNames), notify: showArchiveNotice });
  }
  // Removing a Project takes it off the recent list, as desktop does; its folder and Chats stay on the Mac.
  async function projectAction(projectPath: string, name: string, action: string) {
    if (action === "new") {
      select(projectPath);
      return;
    }
    if (isLinkScopeKey(projectPath)) {
      if (action === "copy") await Clipboard.setStringAsync(name);
      if (action === "edit") onNavigate({ pathname: "/link-projects", params: { linkId: projectPath.slice("milagre-link:".length) } }, true);
      return;
    }
    if (action === "copy") {
      await Clipboard.setStringAsync(projectPath);
      return;
    }
    if (action !== "remove" || !session.client) return;
    const client = session.client;
    const confirmed = await confirm(
      `Remove ${name}?`,
      "It leaves this list on your phone and your Mac. The folder and its Chats stay on your computer; add it again to bring it back.",
      "Remove",
    );
    if (!confirmed) return;
    setError("");
    try {
      await client.call("project:forget", [projectPath]);
      await reloadProjects();
    } catch (e) {
      const message = (e as Error).message;
      if (alive.current) setError(/not available from mobile/i.test(message) ? "Update Milagre on your Mac to remove Projects from your phone." : message);
    }
  }
  // A typed path opens like any Project: the Chat loads it behind the splash mark and shows a wrong path with Retry.
  function addProject(projectPath: string) {
    if (busy || !session.client) return;
    setPage(null);
    onNavigate({ pathname: "/chat", params: { projectPath, hostId: session.client.url } });
  }
  async function switchComputer(id: string) {
    if (busy) return;
    if (id === "add") {
      onNavigate("/add-computer", true);
      return;
    }
    if (id === "manage") {
      session.cancelNavigation();
      onNavigate("/");
      return;
    }
    const host = session.hosts.find((item) => item.id === id);
    if (!host || host.address === session.client?.url) return;
    setBusy(true);
    setError("");
    try {
      if ((await session.connect(host)) && alive.current) onNavigate("/projects");
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const footer = (
    <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add project"
        disabled={busy}
        onPress={() => setPage("add")}
        style={({ pressed }) => [s.footerAction, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Icon icon={FolderAddIcon} tone="ink2" size={18} />
        <Text style={s.secondary}>Add project</Text>
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <IconButton label="Canvas" icon={GitMergeIcon} size={44} disabled={busy} onPress={() => onNavigate("/canvas", true)} />
        <IconButton label="Link projects" icon={Link04Icon} size={44} disabled={busy} onPress={() => onNavigate("/link-projects", true)} />
        {routinesAvailable && <IconButton label="Routines" icon={RepeatIcon} size={44} disabled={busy} onPress={() => onNavigate("/routines", true)} />}
        <View>
          <IconButton label="Settings" icon={Settings01Icon} size={44} onPress={() => onNavigate("/settings", true)} />
          <UpdateSettingsBadge />
        </View>
      </View>
    </View>
  );
  if (page)
    return (
      <View style={styles.screen}>
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 4, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <IconButton label="Back to Projects" icon={ArrowLeft01Icon} size={44} onPress={() => setPage(null)} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17, fontWeight: "600" }}>
            Add project
          </Text>
          {onClose && <IconButton label="Close navigation" icon={Cancel01Icon} size={44} onPress={onClose} />}
        </View>
        <ProjectSearch onOpen={addProject} />
      </View>
    );
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 16, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PullDown
            label="Switch computer"
            title="Computers"
            style={{ flex: 1 }}
            sections={[
              {
                items: session.hosts.map((host) => ({
                  id: host.id,
                  title: host.name,
                  checked: host.address === session.client?.url,
                  systemImage: "laptopcomputer",
                  disabled: busy,
                })),
              },
              {
                items: [
                  { id: "add", title: "Add computer", systemImage: "plus", disabled: busy },
                  { id: "manage", title: "Manage computers", systemImage: "desktopcomputer", disabled: busy },
                ],
              },
            ]}
            onSelect={(id) => void switchComputer(id)}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}>
              <View style={s.computerIcon}>
                <Icon icon={LaptopIcon} tone="ink" size={21} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text numberOfLines={1} style={s.host}>
                  {session.hostName || "Computer"}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: session.error ? colors.orange : colors.green }} />
                  <Text style={s.detail}>{session.error ? "Connection interrupted" : "Connected"}</Text>
                </View>
              </View>
              <Icon icon={UnfoldMoreIcon} tone="ink3" size={15} />
            </View>
          </PullDown>
          {onClose && <IconButton label="Close navigation" icon={Cancel01Icon} size={44} onPress={onClose} />}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={[s.search, { flex: 1 }]}>
            <Icon icon={Search01Icon} tone="ink3" size={18} />
            <View style={{ flex: 1 }}>
              <Field
                label="Search chats"
                hideLabel
                placeholder="Search chats"
                value={query}
                onChangeText={setQuery}
                clearButtonMode="while-editing"
                style={{ backgroundColor: "transparent", paddingHorizontal: 0, paddingVertical: 8 }}
              />
            </View>
          </View>
          <PullDown
            label="Filter Chats"
            nativeTrigger={{ systemImage: show === "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill" }}
            sections={[
              // Which Projects the list shows, as desktop's Filters › Projects.
              { items: [{ id: "choose-projects", title: "Choose projects…", systemImage: "checklist" }] },
              { title: "Show", items: SHOW.map(([id, title, systemImage]) => ({ id, title, systemImage, checked: show === id })) },
              {
                title: "On chats",
                items: ROW_FIELDS.map((field) => ({
                  id: `field:${field.id}`,
                  title: field.label,
                  systemImage: FIELD_SYMBOLS[field.id],
                  checked: rowShow[field.id],
                })),
              },
            ]}
            onSelect={(id) => {
              const field = ROW_FIELDS.find((item) => id === `field:${item.id}`);
              if (field) saveChatRowShow({ ...rowShow, [field.id]: !rowShow[field.id] });
              else if (id === "choose-projects") onNavigate("/choose-projects", "sheet");
              else setShow(id as Show);
            }}
          >
            <View style={[s.filter, show !== "all" && { backgroundColor: colors.field }]}>
              <Icon icon={FilterHorizontalIcon} tone={show === "all" ? "ink2" : "ink"} size={19} />
            </View>
          </PullDown>
        </View>
        {busy && (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Opening..."
            accessibilityLiveRegion="polite"
            style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
          >
            <LoadingLogo size={22} />
            <Text style={s.secondary}>Opening...</Text>
          </View>
        )}
        {error || archives.notice ? <ErrorNotice message={error || archives.notice} /> : null}
      </View>
      <FlatList
        data={displayedRows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void links.refresh();
              void reloadProjects()
                .then(() => Promise.all(listed.filter((item) => !folded.has(item.path)).map((item) => load(item.path))))
                .catch((e) => setError(e.message))
                .finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={
          <Text style={[styles.muted, { padding: 20 }]}>
            {query.trim()
              ? "No chats match your search."
              : show !== "all"
                ? "No chats match this filter."
                : "Add a project from your computer to start a Chat."}
          </Text>
        }
        renderItem={({ item }) => {
          if (item.kind === "section")
            return <Text style={[s.detail, { paddingHorizontal: 12, paddingTop: 16, paddingBottom: 6, fontWeight: "500" }]}>{item.name}</Text>;
          if (item.kind === "project") {
            const linked = isLinkScopeKey(item.path);
            const menu = [
              {
                items: [
                  { id: "new", title: "New Chat", systemImage: "square.and.pencil" },
                  { id: "copy", title: linked ? "Copy Link name" : "Copy path", systemImage: "doc.on.doc" },
                  ...(linked ? [{ id: "edit", title: "Edit Link", systemImage: "pencil" }] : []),
                ],
              },
              ...(!linked ? [{ items: [{ id: "remove", title: "Remove from list", systemImage: "minus.circle", destructive: true }] }] : []),
            ];
            const choose = (action: string) => void projectAction(item.path, item.name, action);
            // A tap folds the group; a long press opens the Project's menu.
            return (
              <View style={s.project}>
                <PullDown
                  label={`${item.expanded ? "Collapse" : "Expand"} ${item.name}`}
                  title={item.name}
                  sections={menu}
                  onSelect={choose}
                  onPress={() => void savedFoldedProjects.toggle(hostId, item.path)}
                  style={{ flex: 1 }}
                >
                  <View style={s.projectTitle}>
                    {item.members ? <ProjectIcons client={session.client} projects={item.members} /> : <ProjectIcon client={session.client} path={item.path} />}
                    <Text numberOfLines={1} style={[s.secondary, { flex: 1, fontWeight: "500", color: colors.ink }]}>
                      {item.name}
                    </Text>
                    {attention.some((key) => projectOfKey(key) === item.path) && <AttentionDot />}
                    <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={13} />
                  </View>
                </PullDown>
                <IconButton label={`New Chat in ${item.name}`} icon={Add01Icon} size={44} disabled={busy} onPress={() => select(item.path)} />
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
                onPress={() => select(item.path, item.chat.id)}
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
              <Pressable accessibilityRole={item.failed ? "button" : "text"} disabled={!item.failed} onPress={() => void load(item.path)} style={s.notice}>
                <Text style={[s.detail, item.failed && { color: colors.red }]}>{item.message}</Text>
              </Pressable>
            );
          const title = item.title;
          const selected = currentPath === item.path && activeChatId === item.chat.id;
          const tone = chatMarkTone(item.mark);
          const pullRequests = rowShow.pullRequests ? item.pullRequests || [] : [];
          const linearIssue = rowShow.linearIssue ? item.linearIssue : undefined;
          const hasChips = pullRequests.length > 0 || !!linearIssue;
          const copy = item.path === currentPath && session.snapshot ? session.snapshot : cachedProject(item.path);
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
              {lastAt !== undefined && <Text style={[s.detail, { fontVariant: ["tabular-nums"] }]}>{activityAgo(lastAt, now)}</Text>}
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
          const secondLine = !!branchLine || !!diff || lastAt !== undefined || !!item.chat.pinned || !!linkedIcon || !!markLabel;
          const menu = chatMenu(
            item.chat,
            copy?.project.link ? { path: copy.project.state.worktrees[item.chat.worktree_id]?.path } : copy?.project.state.worktrees[item.chat.worktree_id],
            linkMenuSection({ available: links.available, worktreePath: worktreeForLinks(item.path, item.prPath)?.worktree_path, linked: linked.length }),
          );
          // While it archives, the row stays put under the progress and takes no taps.
          const archiving = archives.chats.has(`${copy?.project.path ?? item.path}#${item.chat.id}`);
          // A tap opens the Chat and a long press opens its ⋯ menu, as on desktop's sidebar.
          return (
            <View pointerEvents={archiving ? "none" : "auto"} style={[s.chat, { backgroundColor: selected && !archiving ? colors.hover : "transparent" }]}>
              <View
                style={{ flex: 1, opacity: archiving ? 0.3 : 1 }}
                accessibilityElementsHidden={archiving}
                importantForAccessibility={archiving ? "no-hide-descendants" : "auto"}
              >
                <PullDown
                  label={`${title}${item.chat.pinned ? ", pinned" : ""}, ${item.worktree}${markLabel ? `, ${markLabel}` : ""}${linked.length ? `, ${linkedAccessibilityLabel(linked)}` : ""}`}
                  title={title}
                  sections={item.pending || archiving ? [] : menu}
                  onSelect={(action) => {
                    if (!item.pending && !archiving) void act(item.path, item.chat, action);
                  }}
                  onPress={() => {
                    if (!archiving) select(item.path, item.chat.id, item.pending);
                  }}
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
                          {!copy?.project.link && !!branchLine && <Icon icon={GitBranchIcon} tone="ink3" size={12} />}
                          {!!branchLine && (
                            <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
                              {branchLine}
                            </Text>
                          )}
                          {facts}
                          {!!markLabel && <Text style={[s.detail, { color: tone === "accent" ? colors.accentInk : colors[tone] }]}>{markLabel}</Text>}
                        </View>
                      )}
                    </View>
                  </View>
                </PullDown>
                {hasChips && (
                  <ChatPullRequestChips pullRequests={pullRequests} linearIssue={linearIssue}>
                    {item.chat.pinned && <Icon icon={PinIcon} tone="ink3" size={12} />}
                    {linkedIcon}
                    {facts}
                    {!!markLabel && (
                      <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, color: tone === "accent" ? colors.accentInk : colors[tone] }]}>
                        {markLabel}
                      </Text>
                    )}
                  </ChatPullRequestChips>
                )}
              </View>
              {!item.pending && !archiving && (
                <PullDown label={`Actions for ${title}`} title={title} sections={menu} onSelect={(action) => void act(item.path, item.chat, action)}>
                  <View style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}>
                    <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
                  </View>
                </PullDown>
              )}
              {archiving && <ArchivingOverlay title={title} />}
            </View>
          );
        }}
      />
      {footer}
    </KeyboardAvoidingView>
  );
}

const makeS = (colors: Palette) =>
  StyleSheet.create({
    host: { color: colors.ink, fontSize: 17, fontWeight: "600" },
    secondary: { color: colors.ink2, fontSize: 15 },
    detail: { color: colors.ink2, fontSize: 12 },
    computerIcon: {
      width: 38,
      height: 38,
      borderRadius: 10,
      borderCurve: "continuous",
      backgroundColor: colors.field,
      alignItems: "center",
      justifyContent: "center",
    },
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderCurve: "continuous",
      backgroundColor: colors.field,
    },
    project: { flexDirection: "row", alignItems: "center", marginTop: 12 },
    projectTitle: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8 },
    chat: { flexDirection: "row", alignItems: "center", marginVertical: 2, borderRadius: 8, borderCurve: "continuous" },
    chatBody: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingLeft: 12, paddingVertical: 8 },
    filter: { width: 44, height: 44, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
    chatTitle: { color: colors.ink, fontSize: 15, lineHeight: 20 },
    notice: { minHeight: 44, justifyContent: "center", paddingLeft: 42, paddingRight: 12 },
    footer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    footerAction: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  });
const useS = createStylesHook(makeS);
