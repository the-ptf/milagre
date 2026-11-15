import { lineHeight } from "./design-tokens";
import { type } from "./design-tokens";
import { hideRevealed } from "./chat-swipe-row";
import { useDoneRetention } from "./done-retention";
import { type SnoozeMark } from "./snooze-actions";
import { useSnoozeMinutes } from "./snooze-setting";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, Platform, RefreshControl, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import { ArrowLeft01Icon, Cancel01Icon, MoreHorizontalIcon, RepeatIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { chatMarkTone, chatPullRequests } from "@milagre/shared/chats";
import { unreadRunRoutines } from "@milagre/shared/routines";
import type { AgentSession } from "@milagre/shared/model";
import type { ChatSearchMatch, Client, Snapshot } from "./client";
import { ALL_CHATS_LABEL } from "@milagre/shared/chats-home";
import { useComposer, useListSnapshot, usePendingChats, useSession, type MobilePendingChat, type Session } from "./session";
import { savedChatPins } from "./hosts-native";
import { UpdateSettingsBadge } from "./update-sheet";
import { useLinks } from "./use-links";
import { useRoutinesAvailable } from "./use-routines";
import { endNamer, linkedLabels } from "./chat-links";
import { Icon } from "./icons";
import { LoadingLogo } from "./loading-logo";
import { ErrorNotice, IconButton, PullDown, useStyles } from "./ui";
import { subscribeNavigation, takeNavigation, type NavigationCommand } from "./navigation-commands";
import { ProjectSearch } from "./project-search";
import { useSplitLayout } from "./split-context";
import { useBesideChat } from "./split-chats";
import { useArchiveActivity } from "./archive-progress";
import { deletionKey } from "./archive";
import { ToastPill } from "./primitives/toast";
import { useHistoryToast } from "./undo-history";
import { useAttention } from "./attention";
import { useComputerChatPullRequests, type ComputerPullRequestTargets } from "./use-chat-pull-requests";
import { useLinear } from "./use-linear";
import { useWorktreeLinearIssues } from "./use-worktree-linear-issues";
import { useTheme } from "./theme";
import { useChatRowShow } from "./chat-row-store";
import { useChatList } from "./chat-display-setting";
import { allComputers, useAllComputers, useFoldedProjects } from "./all-computers";
import type { ProjectCopy } from "./all-computers-store";
import { ChatListControls, useControlsBottomInset, useControlsVisibility } from "./chat-list-controls";
import { chatFamily } from "@milagre/shared/subchats";
import { sameDeps, buildHost, type Destination, type Row, type HostBuild, type DoneMark, type Show } from "./navigation-build";
import { computeRows, searchRows } from "./navigation-rows";
import { ROW_FIELDS, useNavigationActions } from "./navigation-actions";
import { useProjectReorder } from "./navigation-reorder";
import { useS } from "./navigation-styles";
import { HeaderButton, HeaderGlass } from "./navigation-chrome";
import { NavigationRow, HeaderOverCell, createNavigationRowCache, type RowView } from "./navigation-row";

/** The Filters menu's Show choices: which Chats the list keeps. */
const SHOW: [Show, string, string][] = [
  ["all", "All Chats", "bubble.left.and.bubble.right"],
  ["needs", "Needs me", "exclamationmark.bubble"],
  ["running", "Running", "play.circle"],
  ["archived", "Archived", "archivebox"],
];
const FIELD_SYMBOLS: Record<string, string> = {
  pullRequests: "arrow.triangle.pull",
  linearIssue: "ticket",
  branch: "arrow.triangle.branch",
  diff: "plusminus",
  lastActivity: "clock",
};

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
type Watched = {
  session: Session;
  snapshot: Snapshot | null;
  pendingChats: Record<string, MobilePendingChat>;
};
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
  const watched = held.pick(props.visible ?? true, {
    session,
    snapshot,
    pendingChats,
  });
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
  const searchQuery = useDeferredValue(query);
  const needle = searchQuery.trim().toLowerCase();
  const searching = !!needle;
  const [show, setShow] = useState<Show>("all");
  // Searching or a Show filter reads every Project, folded or not.
  const views = useAllComputers({
    visible,
    expandAll: chatList === "list" || searching || show !== "all",
  });
  const folds = useFoldedProjects(views.map((view) => view.hostId));
  const rowShow = useChatRowShow();
  // The Done section starts folded and stays as the user left it while the app runs.
  const [doneOpen, setDoneOpen] = useState(false);
  // The Snoozed section starts folded too.
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [snoozeMinutes] = useSnoozeMinutes();
  // The Chats group folds for as long as the app runs; it isn't one computer's, so the per-computer folds don't hold it.
  const [chatsFolded, setChatsFolded] = useState(false);
  // Opened subchat families, by the parent row's key, for as long as the app runs (subchat-rows.ts): a family starts
  // folded, its parent alone, until its count is tapped.
  const [subchatOpen, setSubchatOpen] = useState<ReadonlySet<string>>(() => new Set());
  const subchatFolds = useMemo(() => ({ has: (key: string) => !subchatOpen.has(key) }), [subchatOpen]);
  // The open Chat's family unfolds around it, so its row is on screen and selected (the user can still fold it again).
  const openRoot =
    currentHostId && currentPath && activeChatId !== undefined
      ? chatFamily(snapshot?.project.state.sessions, `${currentPath}#${activeChatId}`)?.root
      : undefined;
  useEffect(() => {
    if (!openRoot || !currentHostId) return;
    const key = `${currentHostId}|${openRoot}`;
    setSubchatOpen((open) => (open.has(key) ? open : new Set(open).add(key)));
  }, [openRoot, currentHostId, activeChatId]);
  // Done and Reopen asked from this list, by `<computer>|<project>#<chat>`: the row moves before its computer answers.
  const [doneMarks, setDoneMarks] = useState<ReadonlyMap<string, DoneMark>>(() => new Map());
  // Snooze and Wake asked from this list, by the same key: the row moves before its computer answers.
  const [snoozeMarks, setSnoozeMarks] = useState<ReadonlyMap<string, SnoozeMark>>(() => new Map());
  const [page, setPage] = useState<"add" | null>(null);
  const [addHostId, setAddHostId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const archives = useArchiveActivity();
  const historyToast = useHistoryToast("list");
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
  const pinsVersion = useSyncExternalStore(savedChatPins.subscribe, savedChatPins.version);
  useEffect(() => {
    for (const view of views) void savedChatPins.load(view.hostId);
  }, [views]);
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
        snoozeMarks,
        savedChatPins.pins(view.hostId),
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
        snoozeMark: (projectPath, chatId) => (snoozeMarks.size ? snoozeMarks.get(`${view.hostId}|${projectPath}#${chatId}`) : undefined),
        fallback: cachedProject,
        show,
        pins: savedChatPins.pins(view.hostId),
      });
      cache.set(view.hostId, { deps, build });
      return build;
    });
    for (const id of cache.keys()) if (!views.some((view) => view.hostId === id)) cache.delete(id);
    return next;
    // pinsVersion: a pin changes savedChatPins.pins, which the deps above read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    views,
    needle,
    show,
    pendingChats,
    archives.chats,
    archives.hidden,
    doneMarks,
    snoozeMarks,
    snapshot,
    cachedProject,
    currentHostId,
    cache,
    archiveRequests,
    pinsVersion,
  ]);

  const manyHosts = builds.length > 1;
  const { rows, searchable, projectHits } = useMemo(
    () => computeRows({ builds, chatList, needle, show, manyHosts, folds, chatsFolded, doneOpen, snoozedOpen, subchatFolds }),
    [builds, chatList, needle, show, manyHosts, folds, chatsFolded, doneOpen, snoozedOpen, subchatFolds],
  );
  // Projects held without their messages (a preview, or a host that keeps them by Chat) are searched on their own
  // computer's host.
  const [hostMatches, setHostMatches] = useState<{
    query: string;
    matches: Record<string, ChatSearchMatch[]>;
  }>({ query: "", matches: {} });
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
  const listRows = useMemo(
    () =>
      needle
        ? searchRows({
            rows,
            needle,
            query: searchQuery,
            searchable,
            hostMatches,
            projectHits,
            manyHosts,
            connected: Boolean(session.client),
            ipad: Platform.OS === "ios" && Platform.isPad,
          })
        : rows,
    [rows, needle, searchQuery, session.client, searchable, hostMatches, projectHits, manyHosts],
  );

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

  const { registerHeader, reorderProjects } = useProjectReorder({ views, currentHostId, session });
  const { actions, enter, startNewChat, addProject, menuChoice, filterChoice } = useNavigationActions({
    busy,
    setBusy,
    setError,
    session,
    currentHostId,
    currentPath,
    activeChatId,
    onNavigate,
    onClose,
    docked,
    snoozeMinutes,
    clientOf,
    copyOf,
    archiveRequests,
    setDoneMarks,
    setSnoozeMarks,
    alive,
    links,
    worktreeForLinks,
    endNames,
    builds,
    readComposer,
    load,
    views,
    addHostId,
    setPage,
    setAddHostId,
    setChatsFolded,
    setDoneOpen,
    setSnoozedOpen,
    setSubchatOpen,
    registerHeader,
    reorderProjects,
    rowShow,
    setShow,
  });
  // Filters: which Projects, which Chats, and what each row shows, as desktop's Filters menu.
  const filterSections = [
    {
      items: [
        {
          id: "choose-projects",
          title: "Choose projects…",
          systemImage: "checklist",
        },
      ],
    },
    {
      title: "Show",
      items: SHOW.map(([id, title, systemImage]) => ({
        id,
        title,
        systemImage,
        checked: show === id,
      })),
    },
    {
      title: "On Chats",
      items: ROW_FIELDS.map((field) => ({
        id: `field:${field.id}`,
        title: field.label,
        systemImage: FIELD_SYMBOLS[field.id],
        checked: rowShow[field.id],
      })),
    },
  ];
  const doneHours = useDoneRetention(
    views.map((view) => view.hostId),
    clientOf,
    visible,
  );
  const rowView = useMemo<RowView>(
    () => ({
      currentHostId,
      currentPath,
      activeChatId,
      openRoot,
      busy,
      wide,
      beside,
      rowShow,
      chatList,
      selectedFill,
      attention,
      links,
      archivingChats: archives.chats,
      archiveRequests,
      clientOf,
      worktreeForLinks,
      doneHours,
      snoozeMinutes,
      background,
      actions,
    }),
    [
      doneHours,
      snoozeMinutes,
      background,
      currentHostId,
      currentPath,
      activeChatId,
      openRoot,
      busy,
      wide,
      beside,
      rowShow,
      chatList,
      selectedFill,
      attention,
      links,
      archives.chats,
      archiveRequests,
      clientOf,
      worktreeForLinks,
      actions,
    ],
  );
  const [rowCache] = useState(() => createNavigationRowCache<Row, RowView, ProjectCopy>());
  useEffect(() => rowCache.prune(new Set(displayedRows.map((row) => row.key))), [rowCache, displayedRows]);
  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      const copy = "hostId" in item ? copyOf(item.hostId, item.path) : undefined;
      const props = rowCache.pick(item, rowView, copy);
      return <NavigationRow {...props} />;
    },
    [rowCache, rowView, copyOf],
  );

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
        <View
          style={{
            paddingTop: insets.top + 4,
            paddingHorizontal: 8,
            paddingBottom: 4,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          <IconButton label={`Back to ${ALL_CHATS_LABEL}`} icon={ArrowLeft01Icon} size={44} onPress={() => setPage(null)} />
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              flex: 1,
              color: colors.ink,
              fontSize: type.body,
              lineHeight: lineHeight.body,
              fontWeight: "600",
            }}
          >
            Add project
          </Text>
          {onClose && <IconButton label="Close navigation" icon={Cancel01Icon} size={44} onPress={onClose} />}
        </View>
        <ProjectSearch onOpen={addProject} />
      </View>
    );
  const emptyText = needle
    ? "No Chats match your search."
    : builds.length
      ? "Add a project from your computer to start a Chat."
      : session.hosts.length
        ? "Every computer is hidden. Show one in Settings."
        : "Pair your computer. Open Settings → Phone & sharing in Milagre on your computer, then scan its pairing code.";
  return (
    <View style={[styles.screen, { backgroundColor: background }]}>
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
          gap: 8,
          paddingBottom: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={{
              flex: 1,
              color: colors.ink,
              fontSize: type.title2,
              lineHeight: lineHeight.title2,
              fontWeight: "600",
            }}
          >
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
                    {
                      id: "add",
                      title: "Add Project",
                      systemImage: "folder.badge.plus",
                    },
                    { id: "link", title: "Link Projects", systemImage: "link" },
                    {
                      id: "canvas",
                      title: "Canvas",
                      systemImage: "square.grid.2x2",
                    },
                  ],
                },
                {
                  items: [
                    {
                      id: "triage",
                      title: "Triage an issue",
                      systemImage: "ladybug",
                    },
                  ],
                },
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
        CellRendererComponent={HeaderOverCell}
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
        filters={{
          sections: filterSections,
          onSelect: filterChoice,
          active: show !== "all",
        }}
        onNewChat={() => startNewChat()}
        visible={visible}
      />
      {/* The undo history's toast for this list (Done, Reopen, pins, a deletion), floating over it without moving it. */}
      {historyToast ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: bottomInset + 8,
            alignItems: "center",
          }}
        >
          <ToastPill key={historyToast.id} {...historyToast} />
        </View>
      ) : null}
      {busy && (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Opening..."
          accessibilityLiveRegion="polite"
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: `${colors.page}e6`,
            },
          ]}
        >
          <LoadingLogo size={64} />
        </View>
      )}
    </View>
  );
});
