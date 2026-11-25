import { preferenceStorage as localStorage } from "../lib/preference-storage.ts";
import type { NamedProjectLink } from "@milagre/shared/model";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { setBarControlsWidth, useWindowChrome } from "../lib/window-chrome";
import { ResizeHandle } from "./primitives/ResizeHandle";
import { useProjectImages } from "../lib/project-images";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Add01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  FolderAddIcon,
  Link04Icon,
  PencilEdit02Icon,
  TimeScheduleIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeft01Icon,
  SidebarRight01Icon,
} from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { ProjectAvatar } from "./primitives/ProjectAvatar";
import { FiltersButton, type PickerProject } from "./sidebar/FiltersMenu";
import { useShortcutHints } from "../lib/shortcut-hints";
import { ScrollArea } from "./primitives/ScrollArea";
import { projectMenu } from "./sidebar/project-menu";
import { projectRows, stableOrder, type RecentProject } from "@/lib/project-list";
import { linkOwners, nestUnder, worktreeGroups, worktreeHeading } from "@milagre/shared/project-list";
import { WorktreeHeading } from "./sidebar/WorktreeHeading";
import { type ChatRowActions, type RowComputer, type SidebarRecent } from "./sidebar/ChatRow";
import { useComputers, useHiddenComputers, isDimmed } from "../lib/computers";
import { computerSections, mergeScopes, useComputerScopes, withoutLocal } from "../lib/computer-scopes";
import { LOCAL_COMPUTER, computerOfKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { ALL_CHATS_LABEL, CHATS_GROUP_KEY, CHATS_GROUP_LABEL, type ProjectKind } from "@milagre/shared/chats-home";
import { useChatsGroup } from "../lib/project-copies";
import type { ArchiveMode, ArchivePlan } from "@/lib/archive";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { preferredCopy, rememberProjectComputer } from "../lib/project-copies";
import { SidebarLinksProvider, type LinkScopeChats } from "./sidebar/SidebarLinks";
import { updateSettings, useSettings } from "../lib/settings";
import { useChatPins } from "../lib/chat-pins";
import { UpdateSettingsBadge } from "./UpdateNotice";
import { RECENT_PROJECTS_CHANGED } from "../lib/project-list";
import { useRecentProjectsChanged } from "../lib/use-recent-projects-changed";
import {
  cachedProjectCopy,
  cachedScopeState,
  chatsSidebarRows,
  isChatsHomeScope,
  mergeScopeChats,
  railLive,
  rememberScopeRows,
  runMarkSets,
  scopeChats,
  useScopeStates,
  type ChatsGroupRow,
  type FlatChat,
} from "../lib/sidebar-scopes";
import { ScopeRail, type RailScope } from "./sidebar/ScopeRail";
import { isRemoteKey } from "../lib/computer-bridge";
import { DoneSection, type DoneEntry } from "./sidebar/DoneSection";
import { SnoozedSection, type SnoozedEntry } from "./sidebar/SnoozedSection";
import { SidebarToast } from "./sidebar/SidebarToast";
import { useDoneSettings } from "../lib/done-settings";
import { settleDonePending, useDonePending, withDonePending } from "../lib/done-pending";
import { inSnoozed, settleSnoozePending, useSnoozePending, withSnoozePending } from "../lib/snooze-pending";
import { jumpChatRows, useSubchatFolds } from "../lib/subchat-rows";
import { useSidebarKeys } from "./sidebar/use-sidebar-keys";
import { useScopeRowHandles } from "./sidebar/use-scope-row-handles";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useSidebarCollapse } from "./sidebar/use-sidebar-collapse";
import { sidebarModes, splitGroupRows } from "../lib/sidebar-modes";
import { ScopeMenuItem, ScopeHeader, ScopeBody } from "./sidebar/ScopeHeader";
import { ScopeBadge, FlatScope, NO_BADGE, CHATS_BADGE, FlatChatList, ChatList } from "./sidebar/ChatLists";
import { dragScopeHeader } from "./sidebar/scope-drag";
import { reopenFromDone, wakeFromSnoozed, withoutSetAside } from "./sidebar/chat-row-actions";

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

const WORKSPACE = { key: "creamery", name: "Creamery Ops", monogram: "C" };

const DEFAULT_RECENTS: SidebarRecent[] = [
  { id: "suppliers", label: "Supplier records" },
  { id: "todos", label: "Urgent to-dos this morning" },
  { id: "flavor", label: "Flavor page ticket" },
  { id: "workload", label: "Workload summary" },
  { id: "offboarding", label: "Off-board a supplier" },
  { id: "restock", label: "Batch restock function" },
  { id: "edits", label: "Propose flavor edits" },
  { id: "subway", label: "Subway surfing" },
];

type SidebarNavProps = {
  selectedLink?: { id: string; projects: Array<{ path: string; name: string }> };
  onSwitchLink?: (id: string) => void;
  onAddComputer?: () => void;
  onOpenComputerSettings?: (id: string | null) => void;
  onEditLink?: (id: string) => void;
  onDeleteLink?: (id: string) => void;
  workspaceName?: string;
  workspaceImage?: string | null;
  onOpenProject?: () => void;
  activeTitle?: string | null;
  activeId?: string | null;
  className?: string;
  fill?: boolean;
  onNewChat?: () => void;
  onNewCurrentScopeChat?: () => void;
  onPick?: (id: string, label: string, prompt?: string) => void;
  onJumpChatsChange?: (ids: string[]) => void;
  onOpenSettings?: () => void;
  onOpenRoutines?: () => void;
  routinesActive?: boolean;
  routinesUnread?: boolean;
  onOpenCommands?: () => void;
  hintsEnabled?: boolean;
  projectPath?: string;
  projectKind?: ProjectKind;
  onNewChatWithoutProject?: () => void;
  onSwitchProject?: (path: string) => void;
  attentionPaths?: string[];
  onOpenProjectSettings?: (path: string) => void;
  onNewChatInScope?: (scopeKey: string) => void;
  recents?: SidebarRecent[];
  chatActions?: ChatRowActions;
  scopeChatActions?: (scopeKey: string, gitless: boolean) => ChatRowActions;
  usage?: ReactNode;
  usageButton?: ReactNode;
  orchestrator?: ReactNode;
  variant?: string;
  runningKeys?: string;
  waitingKeys?: string;
  askingKeys?: string;
  onOpenScopeChat?: (scopeKey: string, id: string) => void;
  onScopeArchiveCheck?: (scopeKey: string, id: string) => Promise<ArchivePlan>;
  onScopeArchive?: (scopeKey: string, id: string, mode: ArchiveMode, plan: ArchivePlan) => Promise<unknown>;
  archivingChats?: ReadonlySet<string>;
  onHoverChat?: (scopeKey: string, id: string) => void;
  onAskChat?: (scopeKey: string, id: string, message: { body: string; prompt: string }) => Promise<unknown>;
};

const NO_CHAT_ACTIONS: ChatRowActions = {};
const NEVER_ACTIVE = () => false;

const CLOSED_SCOPES_KEY = "milagre.sidebarClosedScopes";
function readClosedScopes(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_SCOPES_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const SCOPE_ORDER_KEY = "milagre.sidebarScopeOrder";
let syncedScopeOrder = "";
function readScopeOrder(): string[] {
  try {
    const raw = localStorage.getItem(SCOPE_ORDER_KEY) ?? "[]";
    const saved = JSON.parse(raw);
    const order = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    syncedScopeOrder = JSON.stringify(order);
    return order;
  } catch {
    return [];
  }
}
function writeScopeOrder(order: string[]) {
  try {
    const next = JSON.stringify(order);
    if (next === syncedScopeOrder) return;
    syncedScopeOrder = next;
    localStorage.setItem(SCOPE_ORDER_KEY, next);
  } catch {
    // Storage full or blocked: the order lasts for this session only.
  }
}

const NO_PATHS: string[] = [];
const scrollPositions = new Map<string, number>();
const lastLists = {
  links: [] as NamedProjectLink[],
  registered: [] as Array<{ id: string; name: string; path: string }>,
  recent: [] as RecentProject[],
  recentLoaded: false,
  order: null as string[] | null,
};

export function knownLink(id: string): { link: NamedProjectLink; projects: Array<{ id: string; name: string; path: string }> } | null {
  const link = lastLists.links.find((item) => item.id === id);
  if (!link) return null;
  const projects = link.projectIds.map(
    (projectId) =>
      lastLists.registered.find((project) => project.id === projectId) ?? {
        id: projectId,
        name: projectId.split(/[\\/]/).filter(Boolean).at(-2) ?? projectId,
        path: "",
      },
  );
  return { link, projects };
}

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 44,
  duration: "var(--duration-slow)",
  copyDuration: "var(--duration-base)",
  copyOffset: 8,
  easing: "var(--ease-enter)",
};

const FILTERS_BUTTON =
  "flex size-8 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,scale] duration-fast ease-enter hover:bg-hover hover:text-ink active:scale-press";

const RETRY = "relative cursor-pointer text-accent-ink underline-offset-2 hover:underline before:absolute before:-inset-x-1 before:-inset-y-1";

export default memo(function SidebarNav({
  workspaceName = WORKSPACE.name,
  workspaceImage,
  selectedLink,
  onAddComputer,
  onOpenComputerSettings,
  onEditLink,
  onDeleteLink,
  onOpenProject,
  onSwitchLink,
  onSwitchProject,
  activeTitle,
  activeId,
  className = "",
  fill = false,
  onNewChat,
  onNewCurrentScopeChat,
  onPick,
  onJumpChatsChange,
  onOpenSettings,
  onOpenRoutines,
  routinesActive = false,
  routinesUnread = false,
  onOpenCommands,
  hintsEnabled = true,
  projectPath,
  projectKind,
  onNewChatWithoutProject,
  onOpenProjectSettings,
  attentionPaths = NO_PATHS,
  recents: hostRecents = DEFAULT_RECENTS,
  chatActions = NO_CHAT_ACTIONS,
  scopeChatActions,
  usage,
  usageButton,
  orchestrator,
  runningKeys = "",
  waitingKeys = "",
  askingKeys = "",
  onOpenScopeChat,
  onScopeArchiveCheck,
  onScopeArchive,
  archivingChats,
  onHoverChat,
  onNewChatInScope,
  onAskChat,
}: SidebarNavProps) {
  const keys = useSidebarKeys();
  const currentKey = selectedLink ? `milagre-link:${selectedLink.id}` : (projectPath ?? "");
  const donePending = useDonePending();
  const snoozePending = useSnoozePending();
  const listedRecents = useMemo(
    () => withSnoozePending(currentKey, withDonePending(currentKey, hostRecents, donePending), snoozePending),
    [currentKey, hostRecents, donePending, snoozePending],
  );
  const recents = useMemo(() => withoutSetAside(listedRecents), [listedRecents]);
  const { settings: doneSettings } = useDoneSettings();
  const { chatOrder, chatRowShow, chatList } = useSettings();
  const pins = useChatPins();
  const { thisMac, computers } = useComputers();
  const remote = useComputerScopes(computers);
  const multi = computers.length > 0;
  const hiddenComputers = useHiddenComputers();
  const remoteScopes = remote.scopes.filter((scope) => !hiddenComputers.has(scope.computerId));
  const homeCopies = useChatsGroup(true)?.copies;
  const homeKeys = useMemo(() => new Set(homeCopies?.map((home) => home.key)), [homeCopies]);
  const isHome = (key: string) => isChatsHomeScope(key, { currentKey: projectPath ?? "", currentKind: projectKind, homeKeys });
  const rowComputers = useRef(new Map<string, RowComputer>());
  const rowComputer = (key: string): RowComputer | undefined => {
    if (!multi) return undefined;
    const id = computerOfKey(key);
    const view = computers.find((computer) => computer.id === id);
    const name = id === LOCAL_COMPUTER ? thisMac : (view?.name ?? "Computer");
    const offline = id !== LOCAL_COMPUTER && isDimmed(view);
    const cacheKey = `${id}\n${name}\n${offline}`;
    let made = rowComputers.current.get(cacheKey);
    if (!made) rowComputers.current.set(cacheKey, (made = { name, offline, local: id === LOCAL_COMPUTER }));
    return made;
  };
  const scrollRef = useRef<HTMLElement>(null);
  const scrollKey = chatList;
  const restoreScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    restoreScroll.current = scrollPositions.get(scrollKey) ?? 0;
  }, [scrollKey]);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const top = restoreScroll.current;
    if (!node || top === null) return;
    node.scrollTop = top;
    if (node.scrollTop === top) {
      restoreScroll.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      restoreScroll.current = null;
      scrollPositions.set(scrollKey, node.scrollTop);
    });
    return () => window.cancelAnimationFrame(frame);
  });
  const [listsChanged, setListsChanged] = useState(0);
  const { collapsed, toggle, expandedWidth, setExpandedWidth, saveWidth } = useSidebarCollapse();
  const subchatFolds = useSubchatFolds();
  const jumpIds = useMemo(
    () => jumpChatRows(recents, currentKey, subchatFolds, collapsed).map((row) => row.id),
    [recents, currentKey, subchatFolds, collapsed],
  );
  useLayoutEffect(() => {
    onJumpChatsChange?.(jumpIds);
  }, [jumpIds, onJumpChatsChange]);
  const [resizing, setResizing] = useState(false);
  const [demoActiveTitle, setDemoActiveTitle] = useState<string | null>(null);
  const [namedLinks, setNamedLinks] = useState(() => lastLists.links);
  const [registeredProjects, setRegisteredProjects] = useState(() => lastLists.registered);
  const [recentProjects, setRecentProjects] = useState(() => lastLists.recent);
  const [recentLoaded, setRecentLoaded] = useState(() => lastLists.recentLoaded);
  const scopeOrder = useRef<string[]>(lastLists.order ?? readScopeOrder());
  const showHints = useShortcutHints() && hintsEnabled;

  const selectedTitle = activeTitle === undefined ? demoActiveTitle : activeTitle;
  const pickChat = useCallback(
    (item: SidebarRecent) => {
      if (activeTitle === undefined) setDemoActiveTitle(item.label);
      onPick?.(item.id, item.label, item.prompt);
    },
    [activeTitle, onPick],
  );
  const workspace = { name: workspaceName, image: workspaceImage, monogram: workspaceName.trim().slice(0, 1).toUpperCase() || "M" };
  const projects = projectPath
    ? projectRows({ recent: recentProjects, currentPath: projectPath, currentName: workspaceName })
    : recentProjects.map((project) => ({ ...project, initial: project.name.slice(0, 1).toUpperCase(), current: false }));

  const readBefore = useRef(false);
  useLayoutEffect(() => {
    const { links, registered, recent, recentLoaded, order } = lastLists;
    if (readBefore.current) {
      setNamedLinks(links);
      setRegisteredProjects(registered);
      setRecentProjects(recent);
      setRecentLoaded(recentLoaded);
      if (order) scopeOrder.current = order;
    }
    readBefore.current = true;
  }, []);
  useEffect(() => {
    let live = true;
    window.milagre?.listRecentProjects?.().then(
      (list) => {
        if (live) {
          setRecentProjects(Array.isArray(list) ? list : []);
          setRecentLoaded(true);
        }
      },
      () => {},
    );
    void window.milagre
      ?.listNamedLinks?.()
      .then((links) => {
        if (live) setNamedLinks(Array.isArray(links) ? links : []);
      })
      .catch(() => {});
    void window.milagre
      ?.listProjects?.()
      .then((projects) => {
        if (live) setRegisteredProjects(Array.isArray(projects) ? projects : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, selectedLink?.id, listsChanged]);
  useRecentProjectsChanged(() => setListsChanged((count) => count + 1));
  const [, setOrderSynced] = useState(0);
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key !== SCOPE_ORDER_KEY) return;
      scopeOrder.current = readScopeOrder();
      setOrderSynced((count) => count + 1);
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, []);

  const projectScopes = projects
    .filter((row) => !isHome(row.path))
    .filter((row) => row.current || (!recentProjects.find((project) => project.path === row.path)?.hidden && !hiddenComputers.has(computerOfKey(row.path))))
    .map((row) => ({
      key: row.path,
      name: row.name,
      initial: row.initial,
      link: null as NamedProjectLink | null,
      computerId: computerOfKey(row.path),
      origin: recentProjects.find((project) => project.path === row.path)?.origin,
    }));
  if (recentLoaded)
    scopeOrder.current = stableOrder(
      scopeOrder.current,
      projectScopes.map((scope) => scope.key),
    );
  const orderedProjects = recentLoaded ? scopeOrder.current.map((key) => projectScopes.find((scope) => scope.key === key)!).filter(Boolean) : projectScopes;
  useEffect(() => {
    Object.assign(lastLists, { links: namedLinks, registered: registeredProjects, recent: recentProjects, recentLoaded, order: scopeOrder.current });
    if (recentLoaded) writeScopeOrder(scopeOrder.current);
  });
  const localScopes = [
    ...orderedProjects,
    ...namedLinks
      .filter((link) => link.id === selectedLink?.id || (!link.hidden && !hiddenComputers.has(LOCAL_COMPUTER)))
      .map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId: LOCAL_COMPUTER, origin: undefined })),
  ];
  const scopes = multi
    ? mergeScopes(
        [...localScopes, ...withoutLocal(remoteScopes, localScopes).filter((scope) => !isHome(scope.key))],
        computers.map((computer) => computer.id),
        scopeOrder.current,
      )
    : localScopes;
  const scopeImage = useProjectImages([
    ...projects.map((row) => row.path),
    ...registeredProjects.map((project) => project.path),
    ...remote.scopes.filter((scope) => !scope.link).map((scope) => scope.key),
  ]);
  const { showAll, oneList, buildGroups, bySection, tree, railByScope, railByChat } = sidebarModes({
    collapsed,
    chatList,
    currentKey,
    scopeCount: scopes.length,
  });
  const openHome = projectKind === "chats" && projectPath ? projectPath : undefined;
  const homeScopes = [
    ...(openHome ? [openHome] : []),
    ...(homeCopies ?? [])
      .filter((home) => home.key !== openHome && (home.exists || cachedScopeState(home.key) || cachedProjectCopy(home.key)))
      .map((home) => home.key),
  ];
  const {
    states: scopeStates,
    failed: failedScopes,
    retry: retryScope,
  } = useScopeStates(
    true,
    [...scopes.map((scope) => scope.key), ...homeScopes].filter((key) => key !== currentKey),
  );
  useEffect(() => rememberScopeRows(currentKey, recents), [currentKey, recents]);
  const marks = useMemo(() => runMarkSets(runningKeys, waitingKeys, askingKeys), [runningKeys, waitingKeys, askingKeys]);
  const { withBeats, actionsFor, pickerFor, hoverFor } = useScopeRowHandles({
    scopeStates,
    scopeChatActions,
    onScopeArchiveCheck,
    onScopeArchive,
    onOpenScopeChat,
    onHoverChat,
  });
  const hostRows: [string, SidebarRecent[]][] = [[currentKey, hostRecents]];
  const pendingDone = (key: string, rows: SidebarRecent[]) => {
    hostRows.push([key, rows]);
    return withSnoozePending(key, withDonePending(key, rows, donePending), snoozePending);
  };
  useEffect(() => {
    if (donePending.size) for (const [key, rows] of hostRows) settleDonePending(key, rows);
    if (snoozePending.size) for (const [key, rows] of hostRows) settleSnoozePending(key, rows);
  });
  const unarchived = (key: string, rows: SidebarRecent[]) => (archivingChats?.size ? rows.filter((row) => !archivingChats.has(`${key}#${row.id}`)) : rows);
  const withoutDone = withoutSetAside;
  const linkProjectIdOf = (key: string | undefined) =>
    key && !key.startsWith("milagre-link:") && !isRemoteKey(key) ? (registeredProjects.find((project) => project.path === key)?.id ?? null) : null;
  const groups = buildGroups
    ? scopes.map((scope) => {
        const current = scope.key === currentKey;
        const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
        const all = withBeats(
          scope.key,
          current ? listedRecents : state ? unarchived(scope.key, pendingDone(scope.key, scopeChats(scope.key, state, chatOrder, marks, { pins }))) : [],
        );
        const rows = withoutDone(all);
        const list = current
          ? {
              isActive: (item: SidebarRecent) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle),
              collapsed: false,
              actions: chatActions,
              showHints,
              onPick: pickChat,
              onHover: hoverFor(scope.key),
              linkProjectId: scope.link ? null : linkProjectIdOf(scope.key),
              computer: rowComputer(scope.key),
              show: chatRowShow,
            }
          : {
              isActive: NEVER_ACTIVE,
              collapsed: false,
              actions: actionsFor(scope.key),
              showHints: false,
              onPick: pickerFor(scope.key),
              onHover: hoverFor(scope.key),
              linkProjectId: scope.link ? null : linkProjectIdOf(scope.key),
              computer: rowComputer(scope.key),
              show: chatRowShow,
            };
        return {
          scope,
          current,
          state,
          list,
          dimmed: scope.computerId !== LOCAL_COMPUTER && isDimmed(computers.find((computer) => computer.id === scope.computerId)),
          ...splitGroupRows(all, rows, inSnoozed),
        };
      })
    : [];
  const homeGroups = buildGroups
    ? homeScopes.map((key) => {
        const current = key === currentKey;
        const state = scopeStates[key] ?? cachedProjectCopy(key)?.state;
        const all = withBeats(
          key,
          current ? listedRecents : state ? unarchived(key, pendingDone(key, scopeChats(key, state, chatOrder, marks, { gitless: true, pins }))) : [],
        );
        const rows = withoutDone(all);
        const list = {
          isActive: current ? (item: SidebarRecent) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle) : NEVER_ACTIVE,
          collapsed: false,
          actions: current ? chatActions : actionsFor(key, true),
          showHints: current && showHints,
          onPick: current ? pickChat : pickerFor(key),
          onHover: hoverFor(key),
          linkProjectId: null,
          computer: rowComputer(key),
          show: chatRowShow,
        };
        const offline = computerOfKey(key) !== LOCAL_COMPUTER && isDimmed(computers.find((computer) => computer.id === computerOfKey(key)));
        return {
          key,
          current,
          list,
          offline,
          ...splitGroupRows(all, rows, inSnoozed),
        };
      })
    : [];
  const chatsRows: ChatsGroupRow[] = chatsSidebarRows(
    homeGroups.map(({ key, offline, pinned, rest }) => ({ key, offline, rows: [...pinned, ...rest] })),
    chatOrder,
  );
  const chatsScopes = new Map(
    homeGroups.map(({ key, list, pinned, rest }) => [key, { name: CHATS_GROUP_LABEL, badge: CHATS_BADGE, list, rows: [...pinned, ...rest] }]),
  );
  const sections = bySection ? groupByOrigin(groups.map((group) => ({ ...group, origin: group.scope.origin, computerId: group.scope.computerId }))) : [];
  const memberPaths = (link: NamedProjectLink) => link.projectIds.map((id) => registeredProjects.find((project) => project.id === id)?.path ?? "");
  const linkOwnerOf = tree
    ? linkOwners(
        sections
          .filter((section) => section.scope.link)
          .map((section) => ({
            key: section.scope.key,
            memberPaths: memberPaths(section.scope.link!),
          })),
      )
    : new Map<string, string>();
  const sectionTree = nestUnder(
    sections,
    (section) => section.scope.key,
    (section) => (section.copies.length > 1 ? undefined : linkOwnerOf.get(section.scope.key)),
  ).map((node) => {
    if (!node.item.scope.link || node.children.length < 2) return node;
    const order = memberPaths(node.item.scope.link);
    return { ...node, children: node.children.toSorted((a, b) => order.indexOf(a.scope.key) - order.indexOf(b.scope.key)) };
  });
  const linkFirstProject = (scope: (typeof scopes)[number], link: NamedProjectLink, current: boolean) => {
    const firstId = link.projectIds[0];
    return (
      (firstId ? registeredProjects.find((project) => project.id === firstId) : undefined) ??
      (current ? selectedLink?.projects[0] : undefined) ?? { path: "", name: scope.name || "Project" }
    );
  };
  const scopeBadge = (scope: (typeof scopes)[number], current: boolean): ScopeBadge => {
    if (scope.link) {
      const first = linkFirstProject(scope, scope.link, current);
      return { projectImage: scopeImage(first.path) ?? null, projectInitial: first.name, linkProjects: scope.link.projectIds.length };
    }
    return {
      projectImage: (current && !selectedLink ? workspace.image : scopeImage(scope.key)) ?? null,
      projectInitial: scope.initial || scope.name,
    };
  };
  const scopeIcon = (scope: (typeof scopes)[number], current: boolean) => {
    if (scope.link) {
      const first = linkFirstProject(scope, scope.link, current);
      const fallback = (first.name.trim().slice(0, 1) || scope.name.trim().slice(0, 1) || "P").toUpperCase();
      return (
        <span data-rail-link-icon className="flex">
          <ProjectAvatar name={first.name} src={scopeImage(first.path)} initial={fallback} size={24}>
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/65 text-on-ink">
              <Icon icon={Link04Icon} size={12} />
            </span>
          </ProjectAvatar>
        </span>
      );
    }
    return <ProjectAvatar name={scope.name} src={current && !selectedLink ? workspace.image : scopeImage(scope.key)} initial={scope.initial} size={24} />;
  };
  const railScopes: RailScope[] | null = railByScope
    ? scopes.map((scope) => {
        const current = scope.key === currentKey;
        const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
        const rows = current
          ? recents
          : state
            ? withoutDone(unarchived(scope.key, pendingDone(scope.key, scopeChats(scope.key, state, chatOrder, marks, { pins }))))
            : [];
        const { status, chats } = railLive(rows);
        return { key: scope.key, name: scope.name, icon: scopeIcon(scope, current), current, status, chats };
      })
    : null;
  const openRailScope = (key: string) => {
    if (key.startsWith("milagre-link:")) onSwitchLink?.(key.slice("milagre-link:".length));
    else onSwitchProject?.(key);
  };
  const openRailChat = (key: string, id: string) => {
    if (key === currentKey) {
      const item = recents.find((row) => row.id === id);
      if (item) pickChat(item);
    } else onOpenScopeChat?.(key, id);
  };
  const currentLinkId = selectedLink ? null : linkProjectIdOf(projectPath);
  const linkScopes: LinkScopeChats[] = showAll
    ? groups.flatMap(({ scope, list, pinned, rest }) =>
        list.linkProjectId ? [{ scopeKey: scope.key, projectId: list.linkProjectId, projectName: scope.name, rows: [...pinned, ...rest] }] : [],
      )
    : currentLinkId && projectPath
      ? [{ scopeKey: projectPath, projectId: currentLinkId, projectName: workspaceName, rows: recents }]
      : [];
  const anyPinned = groups.some((group) => group.pinned.length > 0) || homeGroups.some((group) => group.pinned.length > 0);
  const doneEntries: DoneEntry[] = (
    showAll
      ? [...homeGroups.map(({ key, list, done }) => ({ key, list, done })), ...groups.map(({ scope, list, done }) => ({ key: scope.key, list, done }))]
      : [
          {
            key: currentKey,
            list: { onPick: pickChat, actions: chatActions, computer: rowComputer(currentKey) },
            done: listedRecents.filter((row) => row.doneAt),
          },
        ]
  )
    .flatMap(({ key, list, done }) =>
      done.map((item) => ({ key, item, onPick: list.onPick, onReopen: list.actions.onReopen && reopenFromDone(list.actions), computer: list.computer })),
    )
    .sort((a, b) => (b.item.doneAt ?? 0) - (a.item.doneAt ?? 0));
  const snoozedEntries: SnoozedEntry[] = (
    showAll
      ? [
          ...homeGroups.map(({ key, list, snoozed }) => ({ key, list, snoozed })),
          ...groups.map(({ scope, list, snoozed }) => ({ key: scope.key, list, snoozed })),
        ]
      : [
          {
            key: currentKey,
            list: { onPick: pickChat, actions: chatActions, computer: rowComputer(currentKey) },
            snoozed: listedRecents.filter(inSnoozed),
          },
        ]
  )
    .flatMap(({ key, list, snoozed }) =>
      snoozed.map((item) => ({ key, item, onPick: list.onPick, onWake: list.actions.onWake && wakeFromSnoozed(list.actions), computer: list.computer })),
    )
    .sort((a, b) => (a.item.snoozedUntil ?? 0) - (b.item.snoozedUntil ?? 0));
  const [pinSlots, setPinSlots] = useState<Record<string, HTMLElement | null>>({});
  const pinSlotRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const pinSlotRef = (key: string) => {
    let ref = pinSlotRefs.current.get(key);
    if (!ref) {
      ref = (node) => setPinSlots((slots) => (slots[key] === node ? slots : { ...slots, [key]: node }));
      pinSlotRefs.current.set(key, ref);
    }
    return ref;
  };
  const [closedScopes, setClosedScopes] = useState(readClosedScopes);
  const toggleScope = (key: string) =>
    setClosedScopes((previous) => {
      const next = previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key];
      localStorage.setItem(CLOSED_SCOPES_KEY, JSON.stringify(next));
      return next;
    });

  const [draggingScope, setDraggingScope] = useState<string | null>(null);
  const canDragScope = (key: string) => scopeOrder.current.includes(key);
  const reorderScope = (key: string, beforeKey: string | null) => {
    if (key === beforeKey) return;
    const without = scopeOrder.current.filter((item) => item !== key);
    const at = beforeKey === null ? without.length : without.indexOf(beforeKey);
    if (at === -1) return;
    const next = [...without.slice(0, at), key, ...without.slice(at)];
    if (next.length === scopeOrder.current.length && next.every((item, index) => item === scopeOrder.current[index])) return;
    scopeOrder.current = next;
    writeScopeOrder(next);
    setOrderSynced((count) => count + 1);
  };
  const startScopeDrag = (event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (event.button !== 0 || !canDragScope(key)) return;
    const pressed = event.target as HTMLElement;
    if (pressed.closest("a, input, [aria-haspopup], [data-scope-action], [data-scope-menu]")) return;
    dragScopeHeader(event, key, canDragScope, setDraggingScope, reorderScope);
  };

  const [removingProject, setRemovingProject] = useState<{ path: string; name: string } | null>(null);

  const showProject = (path: string, show: boolean) => {
    if (isRemoteKey(path)) {
      remote.setHidden(path, !show);
      return;
    }
    if (path.startsWith("milagre-link:")) {
      const id = path.slice("milagre-link:".length);
      const link = namedLinks.find((l) => l.id === id);
      if (link) {
        setNamedLinks((links) => links.map((l) => (l.id === id ? { ...l, hidden: !show } : l)));
        window.milagre?.updateNamedLink?.({ id, name: link.name, projectIds: link.projectIds, hidden: !show }).catch(() => {
          setListsChanged((count) => count + 1);
        });
      }
      return;
    }
    setRecentProjects((list) => list.map((project) => (project.path === path ? { ...project, hidden: !show } : project)));
    window.milagre?.setProjectHidden?.(path, !show).then(
      (list) => {
        if (Array.isArray(list)) setRecentProjects(list);
        window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
      },
      () => setListsChanged((count) => count + 1),
    );
  };
  const pickerProjects: PickerProject[] = [
    ...projects.map((row) => {
      const recent = recentProjects.find((project) => project.path === row.path) ?? remote.projects.find((project) => project.path === row.path);
      return { ...row, shown: !recent?.hidden, listed: !!recent, computerId: computerOfKey(row.path) };
    }),
    ...namedLinks.map((link) => ({
      path: `milagre-link:${link.id}`,
      name: link.name,
      initial: link.name.slice(0, 1).toUpperCase(),
      current: link.id === selectedLink?.id,
      shown: !link.hidden,
      listed: true,
      computerId: LOCAL_COMPUTER,
    })),
    ...remote.projects
      .filter((project) => !projects.some((row) => row.path === project.path))
      .map((project) => ({
        path: project.path,
        name: project.name,
        initial: project.name.slice(0, 1).toUpperCase(),
        current: false,
        shown: !project.hidden,
        listed: true,
        computerId: project.computerId,
      })),
  ]
    // A hidden computer's Projects leave the chooser too; the open one stays, as it stays in the sidebar. No Chats home is a Project.
    .filter((project) => !isHome(project.path) && (project.current || !hiddenComputers.has(project.computerId)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));

  const scopeMenu = (scope: { key: string; name: string; link: NamedProjectLink | null }): ScopeMenuItem[] => {
    const link = scope.link;
    if (link)
      return [
        { key: "copy-name", label: "Copy Link name", icon: Copy01Icon, run: () => copy(scope.name) },
        ...(onEditLink ? [{ key: "edit", label: "Edit Link…", icon: PencilEdit02Icon, run: () => onEditLink(link.id) }] : []),
        ...(onDeleteLink
          ? [{ key: "delete", label: "Delete Link…", icon: Delete02Icon, destructive: true, separatorBefore: true, run: () => onDeleteLink(link.id) }]
          : []),
      ];
    return [
      ...projectMenu(scope, onOpenProjectSettings),
      {
        key: "remove",
        label: "Remove Project",
        icon: Cancel01Icon,
        destructive: true,
        separatorBefore: true,
        run: () => setRemovingProject({ path: scope.key, name: scope.name }),
      },
    ];
  };

  const flatScopes = new Map<string, FlatScope>([
    ...chatsScopes,
    ...groups.map(({ scope, current, list, pinned, rest }): [string, FlatScope] => [
      scope.key,
      { name: scope.name, badge: scopeBadge(scope, current), list, rows: [...pinned, ...rest] },
    ]),
  ]);
  const offlineHomes = new Set(homeGroups.filter(({ offline }) => offline).map(({ key }) => key));
  const flatChats: (FlatChat & { offline?: boolean })[] = oneList
    ? mergeScopeChats(
        [...homeGroups.map(({ key, rest }) => ({ key, rows: rest })), ...groups.map(({ scope, rest }) => ({ key: scope.key, rows: rest }))],
        chatOrder,
      ).map((chat) => (offlineHomes.has(chat.scopeKey) ? { ...chat, offline: true } : chat))
    : [];
  const railItems: RailScope[] | null = railByChat
    ? [
        ...homeGroups.flatMap(({ key, pinned }) => pinned.map((row) => ({ scopeKey: key, row }))),
        ...groups.flatMap(({ scope, pinned }) => pinned.map((row) => ({ scopeKey: scope.key, row }))),
        ...flatChats,
      ].map(({ scopeKey, row }) => {
        const scope = scopes.find((item) => item.key === scopeKey);
        const current = scopeKey === currentKey;
        const hintIndex = current && showHints ? jumpIds.indexOf(row.id) : -1;
        return {
          key: `${scopeKey}#${row.id}`,
          name: scope?.name ?? CHATS_GROUP_LABEL,
          icon: scope ? scopeIcon(scope, current) : <Icon icon={BubbleChatIcon} size={18} />,
          current: current && (activeId !== undefined ? row.id === activeId : row.label === selectedTitle),
          status: railLive([row]).status,
          chats: [row],
          chat: { scopeKey, id: row.id },
          shortcutHint: hintIndex >= 0 && hintIndex < 9 ? keys.jump(hintIndex) : undefined,
        };
      })
    : railScopes;
  const loadingScopes = groups.some(({ scope, state, current }) => !state && !current && !failedScopes.has(scope.key));
  const chatsPinned = homeGroups.map(({ key, list, pinned }) =>
    pinned.length > 0 ? (
      <ChatList key={key} recents={pinned} scopeKey={key} {...list} header={null} pinnedTarget={pinSlots[key] ?? null} anyPinned={anyPinned} />
    ) : null,
  );
  const chatsOpen = !closedScopes.includes(CHATS_GROUP_KEY);
  const chatsGroup = chatsRows.length > 0 && (
    <section data-sidebar-chats aria-label={CHATS_GROUP_LABEL} className="mb-2">
      <ScopeHeader
        name={CHATS_GROUP_LABEL}
        icon={
          <span className="flex size-5 items-center justify-center rounded-chip bg-ink text-on-ink">
            <Icon icon={BubbleChatIcon} size={12} />
          </span>
        }
        open={chatsOpen}
        current={homeGroups.some(({ current }) => current)}
        plusIsCurrent={false}
        attention={homeGroups.some(({ key, current }) => !current && attentionPaths.includes(key))}
        onToggle={() => toggleScope(CHATS_GROUP_KEY)}
        onNewChat={
          onNewChatWithoutProject &&
          (() => {
            if (activeTitle === undefined) setDemoActiveTitle(null);
            onNewChatWithoutProject();
          })
        }
        menu={[]}
      />
      <div
        inert={!chatsOpen}
        data-scope-body
        className="grid transition-[grid-template-rows,opacity] duration-base ease-enter motion-reduce:transition-none"
        style={{ gridTemplateRows: chatsOpen ? "1fr" : "0fr", opacity: chatsOpen ? 1 : 0 }}
      >
        <div className="min-w-0 overflow-hidden">
          <FlatChatList chats={chatsRows} scopes={chatsScopes} inbox={false} />
        </div>
      </div>
    </section>
  );
  const flatBody = (
    <>
      {groups.map(({ scope, current, pinned, list }) =>
        pinned.length > 0 ? (
          <ChatList
            {...scopeBadge(scope, current)}
            key={scope.key}
            recents={pinned}
            scopeKey={scope.key}
            {...list}
            header={null}
            pinnedTarget={pinSlots[scope.key] ?? null}
            anyPinned={anyPinned}
            projectName={scope.name}
          />
        ) : null,
      )}
      <div data-one-list-header className="sidebar-copy mx-2 mb-1 flex h-8 items-center justify-between pl-2">
        <span className="text-[length:calc(12px+var(--sidebar-delta))] font-medium text-ink-3">{ALL_CHATS_LABEL}</span>
        <Tooltip label="New chat" shortcut={keys.newChat} align="end">
          <IconButton
            size={32}
            label="New chat"
            icon={Add01Icon}
            onClick={() => {
              if (activeTitle === undefined) setDemoActiveTitle(null);
              onNewChat?.();
            }}
          />
        </Tooltip>
      </div>
      <FlatChatList chats={flatChats} scopes={flatScopes} />
      {groups
        .filter(({ scope, state, current }) => !state && !current && failedScopes.has(scope.key))
        .map(({ scope }) => (
          <p key={scope.key} className="mx-2 flex h-8 items-center gap-1 pl-2 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
            <span className="truncate">Couldn't load Chats of {scope.name}.</span>
            <button type="button" onClick={() => retryScope(scope.key)} className={`shrink-0 ${RETRY}`}>
              Retry
            </button>
          </p>
        ))}
      {groups.length > 0 && flatChats.length === 0 && !anyPinned && (
        <p data-one-list-empty className="mx-2 h-8 pl-2 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">
          {loadingScopes ? "Loading Chats…" : snoozedEntries.length || doneEntries.length ? "All caught up" : "No Chats yet"}
        </p>
      )}
    </>
  );

  const mergedSection = (section: (typeof sections)[number]) => {
    const { scope, copies } = section;
    const open = !closedScopes.includes(scope.key);
    const current = copies.find((part) => part.current);
    const iconScope = current?.scope ?? scope;
    const chats = mergeScopeChats(
      copies.map((part) => ({ key: part.scope.key, rows: part.rest })),
      chatOrder,
    );
    const lists = new Map(
      copies.map((part) => [part.scope.key, { name: part.scope.name, badge: NO_BADGE, list: part.list, rows: [...part.pinned, ...part.rest] }]),
    );
    const failed = copies.filter((part) => !part.state && !part.current && failedScopes.has(part.scope.key));
    const loading = copies.some((part) => !part.state && !part.current && !failedScopes.has(part.scope.key));
    const dimmed = copies.every((part) => part.dimmed);
    return (
      <section
        key={scope.key}
        data-sidebar-scope={scope.key}
        data-sidebar-copies={copies.map((part) => part.scope.key).join("\n")}
        data-current={current ? true : undefined}
        aria-label={scope.name}
        data-offline={dimmed || undefined}
        className={`mb-2 ${dimmed ? "opacity-60" : ""}`}
      >
        <ScopeHeader
          name={scope.name}
          icon={<ProjectAvatar name={scope.name} src={current && !selectedLink ? workspace.image : scopeImage(iconScope.key)} initial={iconScope.initial} />}
          open={open}
          current={!!current}
          attention={copies.some((part) => !part.current && attentionPaths.includes(part.scope.key))}
          onToggle={() => toggleScope(scope.key)}
          onDragStart={canDragScope(scope.key) ? (event) => startScopeDrag(event, scope.key) : undefined}
          dragging={draggingScope === scope.key}
          onNewChat={() => {
            if (current) {
              if (activeTitle === undefined) setDemoActiveTitle(null);
              (onNewCurrentScopeChat ?? onNewChat)?.();
              return;
            }
            const [first, ...others] = copies.map((item): ScopeCopy => ({ key: item.scope.key, computerId: item.scope.computerId }));
            const picked = preferredCopy(scope.origin, [first!, ...others]);
            rememberProjectComputer({ origin: scope.origin, computerId: picked.computerId });
            onNewChatInScope?.(picked.key);
          }}
          menu={scopeMenu(scope)}
        />
        {copies.map((part) =>
          part.pinned.length > 0 ? (
            <ChatList
              key={part.scope.key}
              {...scopeBadge(part.scope, part.current)}
              recents={part.pinned}
              scopeKey={part.scope.key}
              {...part.list}
              header={null}
              pinnedTarget={pinSlots[part.scope.key] ?? null}
              anyPinned={anyPinned}
            />
          ) : null,
        )}
        <div
          inert={!open}
          data-scope-body
          className="grid transition-[grid-template-rows,opacity] duration-base ease-enter motion-reduce:transition-none"
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        >
          <div className="min-w-0 overflow-hidden">
            <FlatChatList chats={chats} scopes={lists} inbox={false} />
            {failed.map((part) => (
              <p key={part.scope.key} className="mx-2 flex h-8 items-center gap-1 pl-9 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
                <span className="truncate">Couldn't load Chats{part.list.computer ? ` on ${part.list.computer.name}` : ""}.</span>
                <button type="button" onClick={() => retryScope(part.scope.key)} className={`shrink-0 ${RETRY}`}>
                  Retry
                </button>
              </p>
            ))}
            {chats.length === 0 && failed.length === 0 && !copies.some((part) => part.pinned.length > 0) && (
              <p className="mx-2 h-8 pl-9 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">{loading ? "Loading Chats…" : "No Chats yet"}</p>
            )}
          </div>
        </div>
      </section>
    );
  };

  const scopeChatsBody = (section: (typeof sections)[number], quiet = false) => {
    const { scope, current, state, rest, pinned, list } = section;
    const chatList = (recents: SidebarRecent[], pinTo = false, key?: string) => (
      <ChatList
        key={key}
        {...scopeBadge(scope, current)}
        recents={recents}
        scopeKey={scope.key}
        {...list}
        header={null}
        {...(pinTo ? { pinnedTarget: pinSlots[scope.key] ?? null, anyPinned } : {})}
      />
    );
    if (rest.length > 0 || pinned.length > 0) {
      if (!tree || scope.link) return chatList(pinned.length ? [...pinned, ...rest] : rest, true);
      const worktrees =
        state && "worktrees" in state
          ? Object.values(state.worktrees).map((worktree) => ({ path: worktree.path, name: worktree.name }))
          : rest.flatMap((row) => (row.details?.path && row.details.branch ? [{ path: row.details.path, name: row.details.branch }] : []));
      const groups = worktreeGroups({
        projectPath: unqualifyKey(scope.key),
        worktrees,
        rows: rest,
        pathOf: (row) => row.details?.path,
        branchOf: (row) => row.details?.branch,
      });
      return (
        <>
          {pinned.length > 0 && chatList(pinned, true)}
          {groups.map((group) =>
            worktreeHeading(group) ? (
              <div key={group.path} data-sidebar-worktree={group.path}>
                <WorktreeHeading name={group.name} running={group.rows.some((row) => row.mark === "running" || row.mark === "background")} />
                <div className="ml-3">{chatList(group.rows)}</div>
              </div>
            ) : group.rows.length ? (
              chatList(group.rows, false, group.path)
            ) : null,
          )}
        </>
      );
    }
    if (!state && !current && failedScopes.has(scope.key))
      return (
        <p className="mx-2 flex h-8 items-center gap-1 pl-9 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
          Couldn't load Chats.
          <button type="button" onClick={() => retryScope(scope.key)} className={RETRY}>
            Retry
          </button>
        </p>
      );
    if (quiet) return null;
    return (
      <p className="mx-2 h-8 pl-9 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">{state || current ? "No Chats yet" : "Loading Chats…"}</p>
    );
  };

  const linkMember = (section: (typeof sections)[number]) => {
    const { scope, current, list, dimmed } = section;
    const open = !closedScopes.includes(scope.key);
    return (
      <section
        key={scope.key}
        data-sidebar-scope={scope.key}
        data-sidebar-link-member
        data-current={current || undefined}
        aria-label={scope.name}
        data-offline={dimmed || undefined}
        className={`ml-3 ${dimmed ? "opacity-60" : ""}`}
      >
        <ScopeHeader
          name={scope.name}
          icon={<ProjectAvatar name={scope.name} src={current && !selectedLink ? workspace.image : scopeImage(scope.key)} initial={scope.initial} />}
          open={open}
          current={current}
          attention={!current && attentionPaths.includes(scope.key)}
          computer={list.show.computer ? list.computer : undefined}
          onToggle={() => toggleScope(scope.key)}
          onNewChat={
            current
              ? () => {
                  if (activeTitle === undefined) setDemoActiveTitle(null);
                  (onNewCurrentScopeChat ?? onNewChat)?.();
                }
              : () => onNewChatInScope?.(scope.key)
          }
          menu={scopeMenu(scope)}
        />
        <ScopeBody open={open}>{scopeChatsBody(section, true)}</ScopeBody>
      </section>
    );
  };

  const chrome = useWindowChrome();
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const report = () => setBarControlsWidth(node.offsetWidth);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      observer.disconnect();
      setBarControlsWidth(0);
    };
  }, []);
  return (
    <div className={`relative flex min-h-0 shrink-0 flex-col ${fill ? "h-full" : "h-[600px]"} ${className}`}>
      <div
        ref={bar}
        data-sidebar-bar
        className="absolute top-[calc(var(--window-chrome-top)-var(--window-chrome-height))] z-[60] flex items-center gap-2"
        style={{ left: chrome.sidebarLeft - 12 }}
      >
        <div data-sidebar-toggle>
          <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut={keys.sidebar} side="bottom">
            <IconButton
              size={32}
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              icon={collapsed ? SidebarRight01Icon : SidebarLeft01Icon}
              onClick={toggle}
              className="no-drag"
            />
          </Tooltip>
        </div>
        <div data-sidebar-tools className="no-drag flex items-center gap-2">
          {onOpenRoutines && (
            <Tooltip label="Routines" side="bottom">
              <IconButton
                size={32}
                label={routinesUnread ? "Routines, unread Runs" : "Routines"}
                aria-pressed={routinesActive}
                data-sidebar-routines
                onClick={onOpenRoutines}
              >
                <span className="relative flex">
                  <Icon icon={TimeScheduleIcon} size={16} />
                  {routinesUnread && (
                    <span aria-hidden data-routines-unread className="absolute -top-1 -right-1 size-2 rounded-full bg-accent ring-2 ring-canvas" />
                  )}
                </span>
              </IconButton>
            </Tooltip>
          )}
          {onOpenCommands && (
            <Tooltip label="Search commands, Chats and Projects" side="bottom" shortcut={keys.search}>
              <IconButton size={32} label="Command palette" icon={Search01Icon} aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"} onClick={onOpenCommands} />
            </Tooltip>
          )}
        </div>
      </div>
      <aside
        data-sidebar-collapsed={collapsed}
        aria-label="Workspace navigation"
        className="panel-grain relative flex min-h-0 shrink-0 overflow-hidden rounded-window bg-surface shadow-card transition-[width]"
        style={
          {
            width: collapsed ? SIDEBAR_MOTION.collapsedWidth : expandedWidth,
            flex: "1 1 0%",
            transitionDuration: resizing ? "0ms" : `calc(${SIDEBAR_MOTION.duration} * var(--motion-scale))`,
            transitionTimingFunction: SIDEBAR_MOTION.easing,
            "--sidebar-copy-duration": `calc(${SIDEBAR_MOTION.copyDuration} * var(--motion-scale))`,
            "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
            "--sidebar-easing": SIDEBAR_MOTION.easing,
          } as CSSProperties
        }
      >
        <div className="flex min-h-0 w-full shrink-0 flex-col">
          {orchestrator}
          <ScrollArea
            ref={scrollRef}
            onScroll={(event) => {
              if (event.currentTarget.isConnected && restoreScroll.current === null) scrollPositions.set(scrollKey, event.currentTarget.scrollTop);
            }}
            className="sidebar-scroll flex-1 overflow-x-hidden pt-2"
          >
            <SidebarLinksProvider scopes={linkScopes} projects={registeredProjects} onAskChat={onAskChat}>
              {showAll ? (
                <>
                  <div data-all-pinned={anyPinned || undefined} className={anyPinned ? "mb-2" : ""}>
                    {anyPinned && (
                      <p className="sidebar-copy mx-2 mb-1 flex h-8 items-center pl-2 text-[length:calc(12px+var(--sidebar-delta))] font-medium text-ink-3">
                        Pinned
                      </p>
                    )}
                    {homeGroups.map(({ key }) => (
                      <div key={key} ref={pinSlotRef(key)} data-pinned-scope={key} />
                    ))}
                    {groups.map((group) => (
                      <div key={group.scope.key} ref={pinSlotRef(group.scope.key)} data-pinned-scope={group.scope.key} />
                    ))}
                  </div>
                  {chatsPinned}
                  {!oneList && chatsGroup}
                  {oneList
                    ? flatBody
                    : sectionTree.map(({ item: section, children: members }, index) => {
                        if (section.copies.length > 1) return mergedSection(section);
                        const { scope, current, list, dimmed } = section;
                        const open = !closedScopes.includes(scope.key);
                        return (
                          <section
                            key={scope.key}
                            data-sidebar-scope={scope.key}
                            data-current={current || undefined}
                            aria-label={scope.name}
                            data-offline={dimmed || undefined}
                            className={`mb-2 ${dimmed ? "opacity-60" : ""}`}
                          >
                            {scope.link && !sectionTree[index - 1]?.item.scope.link && (
                              <p className="mx-2 mt-1 mb-1 flex h-6 items-center pl-2 text-[length:calc(12px+var(--sidebar-delta))] font-medium text-ink-3">
                                Links
                              </p>
                            )}
                            <ScopeHeader
                              name={scope.name}
                              icon={
                                scope.link ? (
                                  <ProjectAvatarStack
                                    projects={scope.link.projectIds.map(
                                      (id) => registeredProjects.find((project) => project.id === id) ?? { path: "", name: "Project" },
                                    )}
                                  />
                                ) : (
                                  <ProjectAvatar
                                    name={scope.name}
                                    src={current && !selectedLink ? workspace.image : scopeImage(scope.key)}
                                    initial={scope.initial}
                                  />
                                )
                              }
                              open={open}
                              current={current}
                              attention={!current && attentionPaths.includes(scope.key)}
                              computer={list.show.computer ? list.computer : undefined}
                              onToggle={() => toggleScope(scope.key)}
                              onDragStart={canDragScope(scope.key) ? (event) => startScopeDrag(event, scope.key) : undefined}
                              dragging={draggingScope === scope.key}
                              onNewChat={
                                current
                                  ? () => {
                                      if (activeTitle === undefined) setDemoActiveTitle(null);
                                      (onNewCurrentScopeChat ?? onNewChat)?.();
                                    }
                                  : () => onNewChatInScope?.(scope.key)
                              }
                              menu={scopeMenu(scope)}
                            />
                            <ScopeBody open={open}>
                              {scopeChatsBody(section, members.length > 0)}
                              {members.map(linkMember)}
                            </ScopeBody>
                          </section>
                        );
                      })}
                </>
              ) : railItems ? (
                <>
                  <ScopeRail scopes={railItems} onOpenScope={openRailScope} onOpenChat={openRailChat} />
                  {oneList && (
                    <div className="mx-auto mt-1 flex size-8 items-center justify-center">
                      <Tooltip label="New chat" shortcut={keys.newChat} align="end">
                        <button
                          type="button"
                          aria-label="New chat"
                          onClick={() => {
                            if (activeTitle === undefined) setDemoActiveTitle(null);
                            onNewChat?.();
                          }}
                          className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                        >
                          <Icon icon={Add01Icon} size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </>
              ) : (
                <ChatList
                  recents={recents}
                  projectImage={workspace.image}
                  projectInitial={workspace.name}
                  scopeKey={currentKey}
                  isActive={(item) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle)}
                  collapsed={collapsed}
                  actions={chatActions}
                  showHints={showHints}
                  onPick={pickChat}
                  onHover={hoverFor(currentKey)}
                  show={chatRowShow}
                  linkProjectId={selectedLink ? null : linkProjectIdOf(projectPath)}
                  header={
                    <div className={`sidebar-copy mx-2 mb-1 flex h-8 items-center justify-between pl-2 ${collapsed ? "hidden" : ""}`}>
                      <span className="text-[length:calc(12px+var(--sidebar-delta))] font-medium text-ink-3">Chats</span>
                      <Tooltip label="New chat" shortcut={keys.newChat} align="end">
                        <IconButton
                          size={32}
                          label="New chat"
                          icon={Add01Icon}
                          onClick={() => {
                            if (activeTitle === undefined) setDemoActiveTitle(null);
                            onNewChat?.();
                          }}
                        />
                      </Tooltip>
                    </div>
                  }
                />
              )}
            </SidebarLinksProvider>
          </ScrollArea>

          <SnoozedSection entries={snoozedEntries} collapsed={collapsed} />

          <DoneSection entries={doneEntries} retentionHours={doneSettings.retentionHours} collapsed={collapsed} />

          <SidebarToast collapsed={collapsed} />

          {usage && <div className={`mt-1 pt-0.5 ${collapsed ? "mx-auto w-8" : "mx-2 w-[calc(100%-16px)]"}`}>{usage}</div>}

          <div
            className={`flex py-1.5 ${usage ? "mt-0.5" : "mt-3"} ${collapsed ? "mx-auto w-8 flex-col-reverse items-center gap-1" : "mx-2 w-[calc(100%-16px)] items-center justify-between"}`}
          >
            <div className={collapsed ? "flex flex-col-reverse items-center gap-1" : "flex items-center gap-1"}>
              <Tooltip label="Add Project" shortcut={keys.addProject}>
                <IconButton size={32} label="Add Project" icon={FolderAddIcon} onClick={() => onOpenProject?.()} />
              </Tooltip>
              <FiltersButton
                projects={pickerProjects}
                computerMenu={onAddComputer && onOpenComputerSettings ? { onAddComputer, onOpenSettings: onOpenComputerSettings } : null}
                computers={multi ? computerSections(thisMac, computers) : null}
                imageOf={scopeImage}
                currentImage={selectedLink ? undefined : workspace.image}
                onShowProject={showProject}
                show={chatRowShow}
                offerComputer={multi}
                onShowField={(field, on) => updateSettings({ chatRowShow: { ...chatRowShow, [field]: on } })}
                collapsed={collapsed}
                className={FILTERS_BUTTON}
              />
              {usageButton}
            </div>
            <Tooltip label="Settings" shortcut={keys.settings} align={collapsed ? "start" : "end"}>
              <IconButton size={32} data-update-settings="" label="Settings" onClick={onOpenSettings}>
                <Icon icon={Settings01Icon} size={16} />
                <UpdateSettingsBadge />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </aside>
      {removingProject && <RemoveProjectDialog project={removingProject} onClose={() => setRemovingProject(null)} />}
      {!collapsed && (
        <ResizeHandle
          label="Resize sidebar"
          side="right"
          width={expandedWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          reset={SIDEBAR_MIN_WIDTH}
          onResize={setExpandedWidth}
          onCommit={saveWidth}
          onResizingChange={setResizing}
        />
      )}
    </div>
  );
});

type ScopeCopy = { key: string; computerId: string };
