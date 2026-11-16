import type { BranchPolicySettings } from "@milagre/shared/branch-policy";
import { outbox, outboxAttachments, queueForComputer, hasQueuedChat, startOutbox } from "./lib/outbox";
import type { MessageDelivery } from "@milagre/shared/queued-messages";
import { OfflineTray, useOfflineTray } from "./components/OfflineTray";
import { preferenceStorage as localStorage } from "./lib/preference-storage.ts";
import { chatMentionChoices } from "@milagre/shared/prompt-mentions";
import { prepareImageUploads, prepareLocalFileUploads } from "./lib/attachment-uploads";
import { PersistenceNotices, SaveFailure, type UnsavedScope } from "./components/PersistenceNotice";
import { UpdateShell, useAppUpdates } from "./components/UpdateNotice";
import { ComputerAllowPrompt } from "./components/ComputerAllowPrompt";
import { LinkWorkspace } from "./components/LinkWorkspace";
import { AppDialogs, AppSettingsModal, SettingsNav } from "./app/AppDialogs";
import { useAppDialogs } from "./app/useAppDialogs";
import { useAppShortcuts, useJumpToChat } from "./app/useAppShortcuts";
import { useFindInChat } from "./app/useFindInChat";
import { useChatLayout } from "./app/useChatLayout";
import { useModelSelection } from "./app/useModelSelection";
import { usePrPanel } from "./app/usePrPanel";
import { useChatRowActions } from "./app/useChatRowActions";
import { useSendPipeline } from "./app/useSendPipeline";
import { NO_WORKTREE, shownPendingSend, withSendPreviews } from "./lib/send-pending";
import { ChatApproval, PermissionCard, approvalShown, type ChatApprovalProps } from "./app/ChatApproval";
import { ChooseProjectScreen, HostNotices, QuitErrorDialog, StartupErrorScreen } from "./app/StartupScreens";
import { WorkspaceSlots } from "./app/WorkspaceSlots";
import { ProjectChangesPanel } from "./app/ProjectChangesPanel";
import { ProjectPalette } from "./app/ProjectPalette";
import { LinkProjectDialog } from "./components/LinkProjectDialog";
import { DeleteLinkDialog, linkDeletesInFlight } from "./components/DeleteLinkDialog";
import { createScopeDrafts } from "./lib/link-scope";
import type { LinkState, NamedLinkDeleted, NamedProjectLink, OpenLink } from "@milagre/shared/model";
import { isSnoozed } from "@milagre/shared/snooze";
import { deletedLinkText, isDeletedLinkState, isLinkGone, linkDeletedElsewhereText } from "@milagre/shared/worktree-link";
import { scopeKey, isLinkScopeKey, scopeFromKey, LOCAL_COMPUTER, computerOfKey, qualifyKey } from "@milagre/shared/chat-scopes";
import { isChatsHomeProject, type ChatsHome } from "@milagre/shared/chats-home";
import { projectSurfaces } from "./lib/project-surfaces";
import { BridgeContext, ScopeContext, bridgeFor, bridgeForKey, forgetBridge, isRemoteKey, onAnyAgentEvent } from "./lib/computer-bridge";
import type { WorktreeRename } from "@milagre/shared/project-edits";
import { reconcileState } from "@milagre/shared/reconcile";
import { applyAgentEvent } from "@milagre/shared/agent-runs";
import { chatsNeedingAttention } from "@milagre/shared/attention";
import { reportChatAction } from "./lib/chat-action";
import { confirmHeldState, isLean, numberedState, seedHeldState, stateEvents } from "./lib/state-events";
import { chatSummary } from "@milagre/shared/chat-summary";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type CSSProperties, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import {
  ChatMessage,
  ImageAttachment,
  AgentSession,
  CoordinatorState,
  Isolation,
  ModelProvider,
  OpenProject,
  PermissionDecision,
  QuestionAnswers,
  QuestionImages,
  PermissionMode,
  PullRequestActionContext,
  capabilityFor,
  effortFor,
  sessionForWorktree,
  sortedWorktrees,
} from "./model";
import { useAgentRuns } from "./components/useAgentRuns";
import { AgentRunsContext, useRunShell, useRunStatuses } from "./lib/agent-runs-store";
import { useAgentPorts } from "./lib/ports";
import { chatActivity } from "@milagre/shared/chat-activity";
import {
  chatInProject,
  chatKey,
  chatsAskingUser,
  chatsInBackground,
  chatsRunning,
  chatsWaitingForUser,
  lastUserModel,
  modelForOpenChat,
  projectOfKey,
  sentDecision,
  sentReply,
  sessionIdFromKey,
} from "./lib/agent-runs";
import { attachmentPrompt } from "./lib/media";
import { BLOCKERS, pullRequestAction, rowPullRequests } from "./lib/pr-blockers";
import { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } from "@milagre/shared/pr-action";
import { COMPACT_COMMAND } from "@milagre/shared/compaction";
import { providerForId, resolveModel } from "./lib/models";
import { chatMark, chatTitle, fullChatTitle, isChatListed, orderChats } from "./lib/chat-list";
import { deleteUndoWindow, worktreeShared } from "./lib/archive";
import { archiveChat as runArchive } from "./lib/archive-flow";
import type { ArchiveMode, ArchivePlan } from "./lib/archive";
import { changesPanelButtons } from "./app/changes-panel-buttons";
import { setKeyContext } from "./lib/keybindings";
import { CORNER_PITCH, PanelMenu, PanelToggles, cornerButtonCount, useSidePanels } from "./components/agents/PanelToggles";
import { CanvasButton, DiffBar } from "./components/changes/ChangesChrome";
import { AnimatePresence } from "motion/react";
import { formatCommentsMessage } from "./lib/diff-comments";
import { DiffToolbar, useDiffPreferences, useDiffPresence } from "./components/changes/DiffPrefs";
import { PullRequestOpenContext } from "./components/sidebar/ChatRow";
import { openThreads } from "@milagre/shared/pull-request-review";
import { gitChatContext } from "./lib/git-dialog";
import { useWorktreePullRequests } from "./components/useWorktreePullRequests";
import { useLinear } from "./components/useLinear";
import { useWorktreeLinearIssues } from "./components/useWorktreeLinearIssues";
import { issueFirstMessage, restoredDraft, type LinearIssue } from "@milagre/shared/linear";
import { linearIssueContext, linearIssueRequest } from "@milagre/shared/linear-issue";
import { chatPullRequests, pullRequestRefsCache } from "./lib/chat-pull-requests";
import { associatedPullRequest } from "@milagre/shared/chats";
import { usePastedImages } from "./components/usePastedImages";
import { DotBackground } from "./components/DotBackground";
import { AppSplash } from "./components/StartupSplash";
import { settleSplash, useSplash } from "./lib/startup-splash";
import SidebarNav, { knownLink } from "./components/SidebarNav";
import { cachedProjectCopy, cachedScopeState, rememberProjectCopy, runKeys, seedScopeState, useScopeStates } from "./lib/sidebar-scopes";
import { type AppView, chatOnScreen, keepsRoutinesView, readsOnPick, runPaneRestore, type RunPaneReturn } from "./lib/run-pane";
import { ChatGrid, GridDropOverlay } from "./components/ChatGrid";
import { createPendingChat, pendingChatSessionId, withPreview } from "@milagre/shared/chats";
import { sendStatusLabel } from "@milagre/shared/tool-activity";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import { getSettings, toggleTheme, useApplyTheme, useSettings } from "./lib/settings";
import { useChatPins } from "./lib/chat-pins";
import { sessionsWithPins } from "@milagre/shared/chat-pins";
import { EditorLinks, Notice } from "./components/editor-links";
import { clearNoticeOnNavigate } from "./lib/notice";
import { withReportPrompt } from "@milagre/shared/bug-report";
import type { ProjectRead, RuntimeConnection, StateStamp } from "./electron";
import { useSidebarUsage } from "./components/usage/use-sidebar-usage";
import { useUsage } from "./components/usage/useUsage";
import { loadChatPreferences, saveChatPreferences } from "./lib/chat-preferences";
import { useComposerPreferences } from "./lib/use-composer-preferences";
import { noteComputer, startOfflineCache } from "./lib/offline-cache";
import { useDisplayNow } from "./lib/display-clock";
import { computerTone, isDimmed, isReadOnly, offlineBanner, useApplyOtherComputers, useComputers, useHiddenComputers } from "./lib/computers";
import { OfflineEmpty } from "./components/OfflineEmpty";
import { buildCommands } from "./lib/app-commands";
import { findSetting } from "./lib/settings-find";
import { noteScopeOpening, prefetchChatMessages, useChatMessages } from "./lib/chat-messages";
import { beginChatSwitch, markChatSwitch } from "./lib/chat-switch-timing";
import { newChatProject, PROJECT_REMOVED, RECENT_PROJECTS_CHANGED, type RecentProject } from "./lib/project-list";
import { useHiddenProjects } from "./lib/hidden-projects";
import { useProjectImages } from "./lib/project-images";
import { createDraftStore, draftKey } from "./lib/draft-store";
import { restoredChatsNotice } from "./lib/restored-chats";
import { lazyView } from "./lib/lazy-view";
import { CommandPalette, DiffView, GitActionsDialog, QuestionCard } from "./components/lazy-views";
import { MediaLightbox } from "./components/motion/LazyMediaLightbox";
import { chatBookmark } from "@milagre/shared/subchats";
import { ChatIdentity } from "./components/agents/ChatIdentity";
import { SubchatBookmark } from "./components/agents/SubchatBookmark";
import { DetailsPanelHost } from "./components/agents/DetailsPanel";
import { useChatTerminals } from "./lib/terminal-store";
import { provideSubchatActions, type SubchatActions } from "./components/agents/SubchatMessages";
import { useStepApprovalScope } from "./components/agents/step-approval";
import { reuseRows, useEvent, useStableSet } from "./lib/stable";
import { canOpenRunChat, chatBranchLabel, RUN_WORKTREE_REMOVED_NOTE, unreadRunChats, unreadRunChatsOf, unreadRunRoutines } from "@milagre/shared/routines";
import { RoutineChip } from "./components/routines/RoutineChip";
import { OrchestratorPage, OrchestratorSidebarRow } from "./components/orchestrator";
import { RUN_CHAT_REPLY_NOTE, RunChatHeader } from "./components/routines/RunChatHeader";
import { delegatedChats, useLinkedWork } from "./lib/linked-work";
import { remoteDelegationsFrom } from "./lib/remote-delegation";
import { ChatComposer } from "./components/ChatComposer";
import { queueControls } from "./components/QueuedMessages";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { Onboarding, firstChatStarters } from "./components/Onboarding";
import { newTerminal, useTerminalSync } from "./lib/terminal-actions";
import { playNotificationChime } from "./lib/notification-chime";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import type { SidebarRecent } from "./components/sidebar/ChatRow";
import { openStorage } from "./lib/storage-open";

const CanvasView = lazyView(() => import("./components/CanvasView").then((module) => module.CanvasView));
const RoutinesPage = lazyView(() => import("./components/routines/RoutinesPage").then((module) => module.RoutinesPage));
const LAZY_VIEWS = [DiffView, GitActionsDialog, SettingsNav, CommandPalette, MediaLightbox, PermissionCard, QuestionCard];

function latestSessionId(state: CoordinatorState) {
  const sessions = Object.values(state.sessions).filter((session) => !session.archived);
  if (sessions.every((session) => session.summary)) {
    const latest = sessions.reduce<AgentSession | null>(
      (best, session) => ((session.summary!.lastId ?? -1) > (best?.summary!.lastId ?? -1) ? session : best),
      null,
    );
    return latest?.summary!.lastId === undefined ? null : latest.id;
  }
  return (
    state.messages
      .filter((message) => !state.sessions[message.session_id]?.archived)
      .reduce<ChatMessage | null>((latest, message) => (!latest || message.id > latest.id ? message : latest), null)?.session_id ?? null
  );
}

const BRANCHES_FRESH_MS = 60_000;
function prStateWord(pr: { state?: string; isDraft?: boolean } | undefined) {
  if (pr?.state === "MERGED") return "Merged";
  if (pr?.state === "CLOSED") return "Closed";
  return pr?.isDraft ? "Draft" : "Open";
}

const NO_MESSAGES: ChatMessage[] = [];
const NO_BRANCHES: string[] = [];
const branchLists = new Map<string, { at: number; branches: string[] }>();

function prefetchLeanChat(scope: string, sessionId: number, state: CoordinatorState | LinkState | null | undefined) {
  if (!state || isLean(state)) prefetchChatMessages(scope, sessionId);
}
const NO_REFS: string[] = [];
const NO_ROUTINES = new Set<string>();

const chatPanelsHidden = (view: string, taskOpen: boolean) => view === "orchestrator" && !taskOpen;

function App() {
  const [project, setProject] = useState<OpenProject | null>(null);
  const projectRef = useRef<OpenProject | null>(null);
  const projectsSeen = useRef(new Map<string, Pick<OpenProject, "path" | "name">>());
  const projectNavigation = useRef(0);
  projectRef.current = project;
  const [selectedLink, setSelectedLink] = useState<OpenLink | null>(null);
  const [lastLink, setLastLink] = useState<OpenLink | null>(null);
  const [linkOpenNonce, setLinkOpenNonce] = useState(0);
  const linksSeen = useRef(new Map<string, OpenLink>());
  const selectedLinkRef = useRef(selectedLink);
  selectedLinkRef.current = selectedLink;
  const [linkInitialSession, setLinkInitialSession] = useState<number | null | undefined>();
  const [linkNewChatText, setLinkNewChatText] = useState("");
  const [linkDialogOpen, setLinkDialogOpen] = useState<boolean | NamedProjectLink>(false);
  const [deletingLink, setDeletingLink] = useState<NamedProjectLink | null>(null);
  const scopeDrafts = useMemo(createScopeDrafts, []);
  const [linkStates, setLinkStates] = useState<Record<string, LinkState>>({});
  const linkStatesRef = useRef(linkStates);
  linkStatesRef.current = linkStates;
  const [states, setStates] = useState<Record<string, CoordinatorState>>({});
  const statesRef = useRef(states);
  const state = project ? (states[project.path] ?? null) : null;
  const openState = () => (projectRef.current ? statesRef.current[projectRef.current.path] : undefined);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionState] = useState<number | null>(null);
  const selectedSessionRef = useRef<number | null>(null);
  selectedSessionRef.current = selectedSessionId;
  const draftStore = useMemo(createDraftStore, []);
  const setDraft = draftStore.set;
  function setSelectedSessionId(next: SetStateAction<number | null>) {
    const value = typeof next === "function" ? next(selectedSessionRef.current) : next;
    selectedSessionRef.current = value;
    draftStore.select(draftKey(projectRef.current?.path ?? "", value));
    setSelectedSessionState(value);
  }
  useLayoutEffect(() => draftStore.select(draftKey(project?.path ?? "", selectedSessionId)), [project?.path, selectedSessionId]);
  const accountScope = selectedLink ? `milagre-link:${selectedLink.link.id}` : project?.path;
  const accountScopeIsHome = !selectedLink && isChatsHomeProject(project);
  const currentChatKey = draftKey(accountScope ?? "", selectedSessionId);
  const composerPrefs = useComposerPreferences(currentChatKey);
  const effort = composerPrefs.effort;
  const setEffort = composerPrefs.setEffort;
  const ultracode = composerPrefs.ultracode;
  const setUltracode = composerPrefs.setUltracode;
  const fastMode = composerPrefs.fastMode;
  const setFastMode = composerPrefs.setFastMode;
  const [view, setView] = useState<AppView>("chat");
  const viewRef = useRef(view);
  viewRef.current = view;
  const openChatKey = (key: string) => {
    setView("chat");
    openChatByKey(key);
  };
  const [routineId, setRoutineId] = useState<string | null>(null);
  const [runPane, setRunPane] = useState<string | null>(null);
  const holdRoutinesView = useRef<string | null>(null);
  const runPaneReturn = useRef<RunPaneReturn | null>(null);
  const runPaneRef = useRef<string | null>(null);
  runPaneRef.current = runPane;
  const [pickedIsolation, setIsolation] = useState<Isolation>(() => loadChatPreferences(localStorage, "").isolation);
  const noGit = project?.git === false;
  const isolation: Isolation = isChatsHomeProject(project) ? "worktree" : noGit ? "local" : pickedIsolation;
  const surfaces = projectSurfaces(project);
  const showGit = !isChatsHomeProject(project) && (surfaces.git || noGit);
  const [, setBranchesRead] = useState(0);
  const branches = (project ? branchLists.get(project.path)?.branches : undefined) ?? NO_BRANCHES;
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [baseOverride, setBaseOverride] = useState<string | null>(null);
  const [projectGit, setProjectGit] = useState<{ path: string; base: string } | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [quitError, setQuitError] = useState<string | null>(null);
  useEffect(() => window.milagre.onQuitFailed?.(setQuitError), []);
  const [notice, setNotice] = useState<string | null>(null);
  const {
    selectedModel,
    setSelectedModel,
    models,
    capabilities,
    selectedCapability,
    cliStatus,
    refreshCliStatus,
    staleProviders,
    preferredProviderRef,
    chatModels,
    chooseModel,
    updatingCli,
    handleUpdateCli,
    handleProvidersUpdated,
  } = useModelSelection({ accountScope, selectedSessionRef, selectedLinkRef, projectRef, setNotice });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dialogs = useAppDialogs(`${selectedLink?.link.id ?? ""}|${project?.path ?? ""}|${selectedSessionId ?? ""}`);
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    openCommandPalette,
    recentProjects,
    settingsOpen,
    setSettingsOpen,
    settingsOpenRef,
    settingsSection,
    setSettingsSection,
    openSettingsAt,
    openSettings,
    openAccounts,
    setSettingsProject,
    openComputerSettings,
    openAddComputer,
    setAddProjectOpen,
    gitDialog,
    setGitDialog,
    settingsProject,
  } = dialogs;
  const chatView = useRef(0);
  const nextChatView = useRef(0);
  const [, setChatView] = useState(0);
  function advanceChatView() {
    clearNoticeOnNavigate();
    chatView.current = ++nextChatView.current;
    setChatView(chatView.current);
  }
  const {
    sendsInFlight,
    movingDraft,
    failedSendIds,
    pendingSends,
    dispatchPending,
    preparedTarget,
    failedSends,
    setFailedSends,
    restoringSend,
    setRestoringSend,
  } = useSendPipeline(states);
  const [loading, setLoading] = useState(true);
  const [hostConnection, setHostConnection] = useState<RuntimeConnection>({ connected: true });
  const [restartingHost, setRestartingHost] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [firstChat, setFirstChat] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const update = useAppUpdates();
  useApplyTheme();
  useApplyOtherComputers();
  useEffect(() => startOfflineCache(), []);
  useEffect(() => startOutbox(), []);
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1000));
    idle(() => {
      for (const view of LAZY_VIEWS) view.preload();
    });
  }, []);

  const projectImage = useProjectImages([project?.path ?? ""]);

  async function loadInitialProject() {
    setLoading(true);
    setStartupError(null);
    try {
      const initial = await window.milagre.getCurrentProject();
      if (initial) adoptProject(initial);
      else setOnboarding(true);
    } catch (error) {
      setStartupError(ipcErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadInitialProject();
  }, []);
  const { computers: pairedComputers } = useComputers();
  const openChatComputer = useRef<string>(LOCAL_COMPUTER);
  const knownComputers = pairedComputers.map((computer) => computer.id).join("\n");
  useEffect(() => {
    const open = selectedLinkRef.current ? `milagre-link:${selectedLinkRef.current.link.id}` : projectRef.current?.path;
    if (!open || !isRemoteKey(open)) return;
    const computerId = computerOfKey(open);
    if (knownComputers.split("\n").includes(computerId)) return;
    forgetBridge(computerId);
    if (openChatComputer.current === computerId) openChatComputer.current = LOCAL_COMPUTER;
    void loadInitialProject();
  }, [knownComputers]);
  const openComputer = project && isRemoteKey(project.path) ? pairedComputers.find((computer) => computer.id === computerOfKey(project.path)) : undefined;
  const readOnly = Boolean(project && isRemoteKey(project.path) && isReadOnly(openComputer));
  const reconnecting = Boolean(openComputer && computerTone(openComputer) === "connecting");
  const away = Boolean(openComputer && isDimmed(openComputer));
  const bannerNow = useDisplayNow(60_000, away);
  const awayBanner = openComputer && away ? offlineBanner(openComputer, bannerNow) : null;
  const linkGone = useEvent((id: string) => {
    if (linkDeletesInFlight.has(id)) return false;
    const open = selectedLinkRef.current?.link.id === id ? selectedLinkRef.current.link : null;
    const left = leaveDeletedLink(id);
    if (left && open) setNotice(linkDeletedElsewhereText(open.name));
    return left;
  });
  useEffect(
    () =>
      stateEvents.onLinkState((update) => {
        setLinkStates((previous) => ({ ...previous, [update.linkId]: update.state }));
        if (isDeletedLinkState(update.state)) linkGone(update.linkId);
      }),
    [linkGone],
  );

  useEffect(() => {
    let updated = false;
    const off = window.milagre.onRuntimeConnection?.((state) => {
      updated = true;
      setHostConnection(state);
      if (state.notice) setNotice(state.notice);
    });
    void window.milagre
      .getRuntimeConnection?.()
      .then((state) => {
        if (!updated) setHostConnection(state);
      })
      .catch(() => {});
    const snapshotOff = window.milagre.onRuntimeSnapshot?.((snapshot) => {
      for (const next of snapshot.projects) receiveState(next.path, next.state);
      for (const next of snapshot.links ?? []) setLinkStates((previous) => ({ ...previous, [next.linkId]: next.state }));
    });
    const remoteSnapshotOff = window.milagre.onComputerEvent?.((event) => {
      if (event.channel !== "runtime:snapshot" || !event.payload) return;
      for (const next of event.payload.projects ?? []) receiveState(next.path, next.state);
      for (const next of event.payload.links ?? []) setLinkStates((previous) => ({ ...previous, [next.linkId]: next.state }));
    });
    return () => {
      updated = true;
      off?.();
      snapshotOff?.();
      remoteSnapshotOff?.();
    };
  }, []);

  const rememberBranches = (path: string, next: string[]) => {
    const kept = branchLists.get(path)?.branches;
    const same = kept?.length === next.length && next.every((branch, index) => branch === kept[index]);
    branchLists.set(path, { at: Date.now(), branches: same ? kept : next });
    if (!same && projectRef.current?.path === path) setBranchesRead((count) => count + 1);
  };
  useEffect(() => {
    if (!project) return;
    const path = project.path;
    const hit = branchLists.get(path);
    if (hit && Date.now() - hit.at < BRANCHES_FRESH_MS) return;
    let cancelled = false;
    void retrySend(() => bridgeForKey(path).listBranches(path), {
      retryable: (error) => !cancelled && retryKind(error) !== null,
      budget: READ_RETRY_BUDGET,
    }).then(
      (next) => rememberBranches(path, next),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [project?.path]);

  const worktrees = useMemo(() => (state ? sortedWorktrees(state) : []), [state]);
  const firstWorktree = worktrees[0];
  const selectedSession = state && selectedSessionId !== null ? state.sessions[selectedSessionId] : undefined;
  const offlineTray = useOfflineTray(project?.path, selectedSession?.id ?? null, readOnly);
  const subagents = useMemo(
    () => selectedSession?.subagents?.filter((agent) => agent.id !== selectedSession.native_session_id),
    [selectedSession?.subagents, selectedSession?.native_session_id],
  );
  const selectedWorktree = worktrees.find((worktree) => worktree.id === (selectedSession?.worktree_id ?? selectedWorktreeId)) ?? firstWorktree;
  const imageDraft = usePastedImages(`${project?.path ?? ""}:${chatView.current}`, project?.path, !!project && queueForComputer(project.path));
  useEffect(() => {
    if (!restoringSend) return;
    imageDraft.restore(restoringSend.message.images ?? [], restoringSend.message.files ?? []);
    setRestoringSend(null);
  }, [restoringSend]);
  const lean = isLean(state);
  const chatWindow = useChatMessages(lean ? project?.path : null, selectedSession && selectedSession.id > 0 ? selectedSession.id : null);
  const messages = useMemo(
    () =>
      state && selectedSession ? (lean ? chatWindow.messages : state.messages.filter((message) => message.session_id === selectedSession.id)) : NO_MESSAGES,
    [state?.messages, selectedSession?.id, lean, chatWindow.messages],
  );
  const pendingSend = shownPendingSend(pendingSends, { project, view: chatView.current, session: selectedSession, state });
  const pendingHere = Boolean(pendingSend);
  const preparingHere = Boolean(pendingSend && !pendingSend.sent);
  const pendingCanonicalId = state && pendingSend?.projectPath === project?.path ? pendingChatSessionId(state, pendingSend) : null;
  const canonicalWindow = useChatMessages(lean && pendingCanonicalId !== null ? project?.path : null, pendingCanonicalId);
  const remoteCount = lean ? chatWindow.total - chatWindow.messages.length : 0;
  const earlierMessages = useMemo(
    () => (remoteCount > 0 ? { count: remoteCount, load: chatWindow.loadEarlier, loadAll: chatWindow.loadAll } : undefined),
    [remoteCount, chatWindow.loadEarlier, chatWindow.loadAll],
  );
  const sidebarState = useMemo(() => {
    if (!state) return state;
    return withSendPreviews(state, project?.path, pendingSends, failedSends);
  }, [state, pendingSends, failedSends, project?.path]);
  const loadedMessages = useMemo(
    () =>
      pendingHere && pendingSend
        ? pendingCanonicalId !== null
          ? lean
            ? canonicalWindow.messages
            : state!.messages.filter((message) => message.session_id === pendingCanonicalId)
          : withPreview(messages, pendingSend)
        : messages,
    [pendingHere, pendingSend, pendingCanonicalId, state?.messages, messages, lean, canonicalWindow.messages],
  );
  const transcriptKey = `${project?.path}|${chatView.current}`;
  const [transcript, setTranscript] = useState({ key: transcriptKey, messages: loadedMessages });
  const transcriptLoading = pendingHere && pendingCanonicalId !== null ? canonicalWindow.loading : chatWindow.loading;
  const displayedMessages = lean && transcriptLoading && !loadedMessages.length && transcript.key === transcriptKey ? transcript.messages : loadedMessages;
  if (transcript.key !== transcriptKey || transcript.messages !== displayedMessages) setTranscript({ key: transcriptKey, messages: displayedMessages });
  const messagesLoading = lean && transcriptLoading && !displayedMessages.length && Boolean(selectedSession && selectedSession.id > 0);
  const chatCount = lean ? (selectedSession?.summary?.count ?? messages.length) : messages.length;
  preferredProviderRef.current = chatCount > 0 ? selectedSession?.provider : undefined;

  const agentRuns = useAgentRuns(receiveState, (chatId) => {
    const owner = projectOfKey(chatId);
    const latest = isLinkScopeKey(owner) ? linkStatesRef.current[owner.slice("milagre-link:".length)] : statesRef.current[owner];
    return latest ? lastUserModel(latest, sessionIdFromKey(chatId)) : "";
  });
  const runStatuses = useRunStatuses(agentRuns.store);
  const { pullRequests, chatPullRequests: chatPrs, dismissedBlockers, dismissBlockerAction } = useWorktreePullRequests(project?.path ?? "", state);
  const linear = useLinear();
  const { issues: linearIssues, refresh: refreshLinearIssues } = useWorktreeLinearIssues(project?.path ?? "", linear.active);
  const sidePanels = useSidePanels();
  const { branchPr, prChatKey, setPrPick, setRowPr, prNumber, prReview, changes, prShown, localChanges, diffComments, prDiffReview, prPanelActions } =
    usePrPanel({
      showGit,
      projectPath: project?.path,
      selectedSession,
      selectedWorktree,
      chatView: view === "chat",
      branchPullRequests: pullRequests,
      sendPrToChat: (text) => sendPrToChat(text),
    });
  const diffPrefs = useDiffPreferences();
  const diffPresence = useDiffPresence(changes.diffOpen);
  const changesAvailable = view === "chat" && showGit && Boolean(selectedSession && selectedWorktree);
  const changesAvailableRef = useRef(false);
  changesAvailableRef.current = changesAvailable;
  const terminalChatId = view === "chat" && project && selectedSession && !selectedSession.archived ? chatKey(project.path, selectedSession.id) : null;
  const terminalOpen = useChatTerminals(terminalChatId).open;
  const terminalChatRef = useRef(terminalChatId);
  terminalChatRef.current = terminalChatId;
  useTerminalSync(terminalChatId);
  const run = useRunShell(agentRuns.store, project && selectedSession ? chatKey(project.path, selectedSession.id) : undefined);
  const permissionMode = composerPrefs.pickedPermissionMode ?? run?.permissionMode ?? composerPrefs.permissionMode;
  const waitingStepIds = useMemo(() => run?.approvals.flatMap((request) => (request.stepId ? [request.stepId] : [])), [run?.approvals]);
  const agentPorts = useAgentPorts();
  const isSending = preparingHere || Boolean(run);
  const usage = useUsage(accountScope);
  const {
    chatOrder,
    usageInSidebar,
    keepAwake,
    defaultModelId,
    defaultPermissionMode,
    notifyOnCompletion,
    showDockBadge,
    notifyWhenWaiting,
    notificationChime,
    notificationSchedule,
    floatingInbox,
    routineNudges,
  } = useSettings();
  const chatPins = useChatPins();
  useEffect(() => {
    void window.milagre.setFloatingInbox?.(floatingInbox).catch(() => {});
  }, [floatingInbox]);
  useEffect(
    () =>
      window.milagre.onOpenExperimental?.(() => {
        setSettingsSection("experimental");
        setSettingsOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (selectedSessionId !== null) return;
    setSelectedModel(resolveModel(models, defaultModelId, providerForId(defaultModelId)));
    changePermissionMode(defaultPermissionMode);
  }, [selectedSessionId, defaultModelId, defaultPermissionMode, models]);

  const configuredBase = projectGit?.path === project?.path ? projectGit?.base : undefined;
  const effectiveBaseBranch =
    baseOverride ?? (configuredBase || (baseBranch && branches.includes(baseBranch) ? baseBranch : (selectedWorktree?.name ?? branches[0] ?? "")));
  useEffect(() => {
    if (!project || selectedLink || selectedSessionId !== null) return;
    let live = true;
    const path = project.path;
    Promise.resolve()
      .then(() => bridgeForKey(path).readProjectGit(path))
      .then(
        (value: BranchPolicySettings) => {
          if (live && value) setProjectGit({ path, base: value.effective.baseBranch });
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [project?.path, selectedSessionId, settingsSection, view]);

  function restoreProjectChoices(nextState: CoordinatorState, path: string) {
    const saved = loadChatPreferences(localStorage, path);
    setSelectedWorktreeId(sortedWorktrees(nextState).find((tree) => tree.path === saved.worktreePath)?.id ?? sortedWorktrees(nextState)[0]?.id ?? null);
    setBaseBranch(saved.baseBranch ?? null);
    setBaseOverride(null);
  }
  const runningCount = Object.keys(runStatuses).length;
  const previousRunningCount = useRef(runningCount);

  useEffect(() => {
    if (runningCount < previousRunningCount.current) void usage.refresh();
    previousRunningCount.current = runningCount;
  }, [runningCount, usage.refresh]);
  const pendingApproval = run?.approvals[0];
  const pendingQuestion = pendingApproval ? undefined : run?.questions[0];
  const questionSent = Boolean(pendingQuestion && sentReply(run, pendingQuestion.requestId));
  const stepApproval = useStepApprovalScope(
    pendingApproval,
    (run?.approvals.length ?? 1) - 1,
    pendingApproval ? sentDecision(run, pendingApproval.requestId) : null,
    answerApproval,
  );
  const approvalCard = stepApproval.inline ? undefined : pendingApproval;

  function changePermissionMode(mode: PermissionMode) {
    composerPrefs.setPermissionMode(mode);
    if (project && selectedSession)
      void bridgeForKey(project.path)
        .setAgentPermissionMode(chatKey(project.path, selectedSession.id), mode)
        .catch(() => {});
  }

  function answerApproval(decision: PermissionDecision) {
    if (!project || !selectedSession || !pendingApproval) return;
    if (readOnly) {
      setNotice(`${openComputer?.name ?? "That computer"} is offline.`);
      return;
    }
    void agentRuns.respond(chatKey(project.path, selectedSession.id), pendingApproval.requestId, decision).catch(() => {});
  }

  function answerQuestion(answers: QuestionAnswers | null, images?: QuestionImages) {
    if (!project || !selectedSession || !pendingQuestion) return;
    if (readOnly) {
      setNotice(`${openComputer?.name ?? "That computer"} is offline.`);
      return;
    }
    void agentRuns
      .answerQuestion(chatKey(project.path, selectedSession.id), pendingQuestion.requestId, answers, images)
      .catch((error) => setNotice(ipcErrorMessage(error)));
  }

  const modelForChatKey = (chat: string, provider: ModelProvider | undefined, own: ChatMessage[]) =>
    modelForOpenChat(chatModels.current[chat], provider, own, models, resolveModel(models, defaultModelId, providerForId(defaultModelId)));

  useEffect(() => {
    if (!project || !selectedSession || selectedLink) return;
    const own = messages.filter((message) => message.session_id === selectedSession.id);
    const nextModel = modelForChatKey(chatKey(project.path, selectedSession.id), selectedSession.provider, own);
    if (nextModel.id !== selectedModel.id) setSelectedModel(nextModel);
  }, [project?.path, selectedSession?.id, selectedSession?.provider, messages, models, selectedLink?.link.id]);

  function receiveState(projectPath: string, next: CoordinatorState | LinkState) {
    if (isLinkScopeKey(projectPath)) {
      setLinkStates((previous) => ({
        ...previous,
        [scopeFromKey(projectPath).kind === "link" ? projectPath.slice("milagre-link:".length) : projectPath]: next as LinkState,
      }));
      return;
    }
    if (!("worktrees" in next)) return;
    const previous = statesRef.current[projectPath];
    const reconciled = reconcileState(previous, next);
    if (reconciled === previous) return;
    statesRef.current = { ...statesRef.current, [projectPath]: reconciled };
    setStates(statesRef.current);
    const seen = projectsSeen.current.get(projectPath);
    if (seen) rememberProjectCopy({ ...seen, state: reconciled });
  }

  useEffect(() => stateEvents.onProjectState(({ path, state: next }) => receiveState(path, next)), []);

  const waiting = useStableSet(useMemo(() => chatsWaitingForUser(runStatuses, project?.path ?? ""), [runStatuses, project?.path]));
  const asking = useStableSet(useMemo(() => chatsAskingUser(runStatuses, project?.path ?? ""), [runStatuses, project?.path]));
  const running = useStableSet(useMemo(() => chatsRunning(runStatuses, project?.path ?? ""), [runStatuses, project?.path]));
  const backgroundKey = useMemo(
    () => [...chatsInBackground(runStatuses, project?.path ?? "", state?.sessions)].map(([id, count]) => `${id}:${count}`).join(","),
    [runStatuses, project?.path, state?.sessions],
  );
  const backgroundChats = useMemo(
    () => new Map(backgroundKey ? backgroundKey.split(",").map((entry) => entry.split(":").map(Number) as [number, number]) : []),
    [backgroundKey],
  );
  const linkedWork = useLinkedWork();
  const remoteDelegations = useMemo(
    () => remoteDelegationsFrom(linkedWork, project && selectedSession ? chatKey(project.path, selectedSession.id) : null),
    [linkedWork, project, selectedSession],
  );
  const hiddenProjects = useHiddenProjects();
  const hiddenComputers = useHiddenComputers();
  const attentionKey = chatsNeedingAttention(
    runStatuses,
    view === "chat" && project && selectedSession ? chatKey(project.path, selectedSession.id) : "",
    hiddenProjects,
    hiddenComputers,
  ).join("\n");
  const attentionChats = useMemo(() => (attentionKey ? attentionKey.split("\n") : []), [attentionKey]);
  const attentionPaths = useMemo(() => [...new Set(attentionChats.map(projectOfKey))], [attentionChats]);
  const { states: scopeStates } = useScopeStates(
    true,
    attentionPaths.filter((path) => path !== project?.path),
  );
  const projectName = useCallback(
    (path: string) => recentProjects.find((recent) => recent.path === path)?.name ?? path.split("/").pop() ?? path,
    [recentProjects],
  );
  const delegated = useStableSet(useMemo(() => delegatedChats(linkedWork, project?.path ?? ""), [linkedWork, project?.path]));
  const gridStates = useMemo(() => ({ ...scopeStates, ...states }), [scopeStates, states]);
  const unreadRunRoutineIds = useStableSet(useMemo(() => (routineNudges ? unreadRunRoutines(gridStates) : NO_ROUTINES), [routineNudges, gridStates]));
  const unreadRunChatKeys = useStableSet(useMemo(() => unreadRunChats(gridStates), [gridStates]));
  const canOpenRun = useCallback((key: string) => canOpenRunChat(gridStates, key), [gridStates]);
  const markRoutineRead = useEvent((id: string) => {
    for (const key of unreadRunChatsOf(gridStates, id)) {
      const path = projectOfKey(key);
      void reportChatAction(bridgeForKey(path).patchChat(path, sessionIdFromKey(key), { unread: false }), "Could not mark the Run read", setNotice);
    }
  });
  const focusedChatKey = project && selectedSession && selectedSession.id > 0 ? chatKey(project.path, selectedSession.id) : null;
  const runPaneOpen = (view === "orchestrator" || (view === "routines" && routineId !== null)) && runPane !== null && runPane === focusedChatKey;
  const {
    layout,
    toggleLayout,
    gridOn,
    gridFocusKey,
    gridFocusKeyRef,
    focusedChatKeyRef,
    shownTiles,
    stackedTiles,
    shownTilesRef,
    splitOn,
    pinnedTiles,
    toggleGridPin,
    closeSplitTile,
    openBeside,
    showFamily,
    tileMenu,
  } = useChatLayout({
    view,
    viewRef,
    projectPath: project?.path,
    projectRef,
    linkOpenRef: selectedLinkRef,
    linkOpen: Boolean(selectedLink),
    focusedChatKey,
    gridStates,
    runs: runStatuses,
    linkedWork,
    openLinkedChat: (key) => openLinkedChat(key),
    openAlone: (key) => openAlone(key),
  });
  setKeyContext({ chatView: view === "chat", linkOpen: Boolean(selectedLink), gridShown: gridOn });
  const familySessionsRef = useRef<typeof familySessions>(undefined);
  const familySessions = focusedChatKey && !selectedLink ? (gridStates[projectOfKey(focusedChatKey)] as CoordinatorState | undefined)?.sessions : undefined;
  familySessionsRef.current = familySessions;
  const bookmarkShown = view === "chat" && !diffPresence.occupied && shownTiles.length === 0 && !runPaneOpen;
  const chatToEdge = bookmarkShown && Boolean(selectedSession && selectedSession.id > 0) && !terminalOpen;
  const bookmarkedParent = bookmarkShown && focusedChatKey ? (chatBookmark(familySessions, focusedChatKey)?.parent ?? null) : null;
  const canvasButtonShown = view === "chat" || view === "canvas";
  const trailingCorner = canvasButtonShown ? 1 : 0;
  const cornerButtons = cornerButtonCount(splitOn, sidePanels, changesAvailable, prNumber, view);
  const stopTileRun = useEvent((key: string) => void agentRuns.interrupt(key));
  const dismissTile = useEvent(
    (key: string) =>
      void reportChatAction(
        bridgeForKey(projectOfKey(key)).patchChat(projectOfKey(key), sessionIdFromKey(key), { unread: false }),
        "Could not mark Chat read",
        setNotice,
      ),
  );
  const delegatedKeys = useMemo(() => new Set(linkedWork.delegations.flatMap((item) => (item.to_chat ? [item.to_chat] : []))), [linkedWork]);
  const messagesBySession = useMemo(() => {
    const grouped = new Map<number, ChatMessage[]>();
    if (!Object.values(sidebarState?.sessions ?? {}).some((session) => !session.summary)) return grouped;
    for (const message of sidebarState?.messages ?? []) {
      const list = grouped.get(message.session_id);
      if (list) list.push(message);
      else grouped.set(message.session_id, [message]);
    }
    return grouped;
  }, [sidebarState?.messages, sidebarState?.sessions]);
  const readPullRequestRefs = useMemo(pullRequestRefsCache, []);
  const selectedPullRequests =
    showGit && project && selectedSession && selectedWorktree
      ? chatPullRequests(
          selectedSession.summary
            ? (selectedSession.summary.pullRequests ?? NO_REFS)
            : readPullRequestRefs(chatKey(project.path, selectedSession.id), messagesBySession.get(selectedSession.id) ?? NO_MESSAGES),
          chatPrs[selectedWorktree.path] ?? {},
          pullRequests[selectedWorktree.path] ?? undefined,
        )
      : [];
  const pullRequestBlockerAction = pullRequestAction(selectedPullRequests, dismissedBlockers);
  const firstRowPr = rowPullRequests(selectedPullRequests)[0]?.number;
  useEffect(() => {
    if (prChatKey) setRowPr(firstRowPr ? { chat: prChatKey, number: firstRowPr } : null);
  }, [prChatKey, firstRowPr]);
  const prOpenThreads = prReview.pr?.state === "OPEN" && prReview.pr.number === prNumber ? openThreads(prReview.pr).length : 0;
  const pullRequestActionRequest = pullRequestBlockerAction
    ? pullRequestActionContext({ action: pullRequestBlockerAction.blocker, pr: pullRequestBlockerAction.pr.number, url: pullRequestBlockerAction.pr.url })
    : null;
  const previousChats = useRef<SidebarRecent[]>([]);
  const [archivingChats, setArchivingChats] = useState<ReadonlySet<string>>(() => new Set());
  const chats = useMemo(() => {
    const state = sidebarState;
    if (!state) return [];
    const sessions = project ? sessionsWithPins(state.sessions, project.path, chatPins) : state.sessions;
    const withMessages = Object.values(sessions)
      .filter((session) => !session.archived && !(project && archivingChats.has(chatKey(project.path, session.id))))
      .map((session) => ({ session, sessionMessages: messagesBySession.get(session.id) ?? NO_MESSAGES }))
      .filter(({ session, sessionMessages }) => isChatListed(session, sessionMessages, waiting.has(session.id) || asking.has(session.id)));
    const rows = orderChats(withMessages, chatOrder).map(({ session, sessionMessages }) => {
      const worktree = state.worktrees[session.worktree_id];
      const failed = failedSends.find((send) => send.projectPath === project?.path && session.id === send.session.id);
      const pending = pendingSends.some((send) => send.projectPath === project?.path && session.id === (pendingChatSessionId(state, send) ?? send.session.id));
      const summary = chatSummary(session, sessionMessages);
      return {
        id: String(session.id),
        label: chatTitle(session, sessionMessages),
        pending: pending || Boolean(failed),
        pinned: Boolean(session.pinned),
        pinOrder: session.pin_order,
        ...(session.done_at ? { doneAt: session.done_at } : {}),
        ...(isSnoozed(session) ? { snoozedUntil: session.snoozed_until } : {}),
        ...(session.parent !== undefined ? { parent: String(session.parent) } : {}),
        mark: chatMark({
          asking: asking.has(session.id),
          waiting: waiting.has(session.id),
          delegated: delegated.has(session.id),
          running: running.has(session.id) || pending,
          background: backgroundChats.has(session.id),
          unread: Boolean(session.unread),
        }),
        ...(backgroundChats.has(session.id) ? { background: backgroundChats.get(session.id) } : {}),
        unread: Boolean(session.unread),
        details: {
          branch: showGit ? worktree?.name : undefined,
          path: showGit ? worktree?.path : undefined,
          diff: showGit ? worktree?.diff : undefined,
          linearIssue: showGit && worktree ? linearIssues[worktree.path] : undefined,
          linearKey: showGit && linear.active ? (worktree?.linearIssue ?? undefined) : undefined,
          linkable: showGit && linear.active && !!worktree && worktree.path !== project?.path && !worktreeShared(state, session.id),
          pullRequests:
            showGit && worktree
              ? chatPullRequests(
                  session.summary ? (summary.pullRequests ?? NO_REFS) : readPullRequestRefs(chatKey(project?.path ?? "", session.id), sessionMessages),
                  chatPrs[worktree.path] ?? {},
                  pullRequests[worktree.path] ?? undefined,
                )
              : [],
          failed: Boolean(failed) || summary.lastOutcome === "failed",
          lastAt: summary.lastAt,
          firstAt: summary.firstAt,
          ports: project ? agentPorts[chatKey(project.path, session.id)] : undefined,
        },
      };
    });
    return (previousChats.current = reuseRows<SidebarRecent>(previousChats.current, rows));
  }, [
    sidebarState,
    chatPins,
    pendingSends,
    failedSends,
    messagesBySession,
    chatOrder,
    asking,
    waiting,
    delegated,
    running,
    backgroundChats,
    pullRequests,
    chatPrs,
    linearIssues,
    linear.active,
    agentPorts,
    project,
    showGit,
    archivingChats,
  ]);
  const openProjectPath = () => projectRef.current?.path;
  const { archiveState, patchChat, checkArchive, revealChat, openChatInEditor, reloadChat, chatActions, scopeChatActions } = useChatRowActions({
    projectRef,
    project,
    state,
    statesRef,
    showGit,
    setNotice,
    receiveState,
    refreshLinearIssues,
    handlers: { openGitDialog, archiveChat, markChatDone, reportMilagreBug },
  });
  function markChatDone(sessionId: number, path: string | undefined) {
    if (!selectedLinkRef.current && selectedSessionRef.current === sessionId) startNewChat();
    patchChat(sessionId, { done: true, unread: false }, path);
  }

  function controlAdvisor(action: "stop" | "retry", id: string) {
    const current = projectRef.current;
    const parentId = selectedSessionRef.current;
    if (readOnly) {
      setNotice(`${openComputer?.name ?? "That computer"} is offline.`);
      return;
    }
    if (current && parentId !== null)
      void reportChatAction(
        (action === "stop" ? bridgeForKey(current.path).stopAdvisor : bridgeForKey(current.path).retryAdvisor)(`${current.path}#${parentId}`, id),
        `Could not ${action} advisor`,
        setNotice,
      );
  }
  function archiveChild(id: string, archived: boolean) {
    const current = projectRef.current;
    const parentId = selectedSessionRef.current;
    if (current && parentId !== null)
      void reportChatAction(bridgeForKey(current.path).archiveSubagent(current.path, parentId, id, archived), "Could not update subagent", setNotice);
  }

  function archiveFinishedChildren() {
    const current = projectRef.current;
    const parentId = selectedSessionRef.current;
    if (current && parentId !== null)
      void reportChatAction(bridgeForKey(current.path).archiveFinishedSubagents(current.path, parentId), "Could not archive finished subagents", setNotice);
  }

  function openChat(sessionId: number) {
    const shownProject = projectRef.current;
    if (shownProject) prefetchLeanChat(shownProject.path, sessionId, openState());
    const failed = failedSends.find((send) => send.projectPath === projectRef.current?.path && send.session.id === sessionId);
    if (failed) {
      chatView.current = failed.view;
      setChatView(failed.view);
      setSelectedSessionId(failed.originSessionId);
      setSelectedWorktreeId(failed.originWorktreeId);
      setView("chat");
      setDraft([failed.draft, draftStore.get()].filter(Boolean).join("\n\n"));
      setNewChatError(failed.error);
      preparedTarget.current = failed.target;
      setRestoringSend(failed);
      setFailedSends((current) => current.filter((send) => send !== failed));
      return;
    }
    const pendingSend = pendingSends.findLast(
      (send) =>
        send.projectPath === shownProject?.path && (sessionId === send.session.id || (openState() && sessionId === pendingChatSessionId(openState()!, send))),
    );
    if (pendingSend) {
      chatView.current = pendingSend.view;
      setChatView(chatView.current);
      setSelectedSessionId(pendingSend.originSessionId);
      setSelectedWorktreeId(pendingSend.originWorktreeId);
      setView("chat");
      return;
    }
    if (sessionId !== selectedSessionRef.current) {
      if (projectRef.current) beginChatSwitch(chatKey(projectRef.current.path, sessionId));
      advanceChatView();
    } else if (
      shownProject &&
      readsOnPick({
        onScreen: chatOnScreen({ view, runPane: runPaneOpen ? runPane : null, projectPath: shownProject.path, sessionId: selectedSessionRef.current }),
        picked: chatKey(shownProject.path, sessionId),
        unread: Boolean(openState()?.sessions[sessionId]?.unread),
      })
    )
      patchChat(sessionId, { unread: false }, openProjectPath());
    setSelectedSessionId(sessionId);
    setSelectedWorktreeId(openState()?.sessions[sessionId]?.worktree_id ?? null);
    if (!keepsRoutinesView(holdRoutinesView.current, projectRef.current?.path, sessionId)) setView("chat");
  }

  useEffect(() => {
    if (selectedLink) {
      void bridgeFor(openChatComputer.current)
        .setOpenChat(null)
        .catch(() => {});
      openChatComputer.current = LOCAL_COMPUTER;
      return;
    }
    const key = chatOnScreen({ view, runPane: runPaneOpen ? runPane : null, projectPath: project?.path ?? null, sessionId: selectedSessionId });
    const computerId = project ? computerOfKey(project.path) : LOCAL_COMPUTER;
    if (openChatComputer.current !== computerId)
      void bridgeFor(openChatComputer.current)
        .setOpenChat(null)
        .catch(() => {});
    openChatComputer.current = computerId;
    void bridgeFor(computerId)
      .setOpenChat(key)
      .catch(() => {});
  }, [selectedSessionId, view, runPaneOpen, project?.path, selectedLink?.link.id]);

  function archiveChat(sessionId: number, mode: ArchiveMode, plan: ArchivePlan | null, projectPath: string | undefined) {
    if (!projectPath) return Promise.resolve();
    const open = projectPath === project?.path;
    const key = chatKey(projectPath, sessionId);
    const wasOpen = open && selectedSessionId === sessionId;
    setArchivingChats((current) => new Set(current).add(key));
    if (wasOpen) startNewChat();
    void runArchive(
      {
        projectPath,
        chatId: key,
        getState: () => archiveState(projectPath) ?? null,
        currentProjectPath: () => projectRef.current?.path,
        stop: () => (agentRuns.store.latest()[key] ? agentRuns.interrupt(key).catch(() => {}) : undefined),
        undoWindow: () => deleteUndoWindow(key),
        hide: () => bridgeForKey(projectPath).patchChat(projectPath, sessionId, { archived: true, unread: false }),
        destroy: () => bridgeForKey(projectPath).deleteChat(projectPath, sessionId),
        restore: async () => {
          await bridgeForKey(projectPath).patchChat(projectPath, sessionId, { archived: false });
          if (wasOpen && selectedSessionRef.current === null) openChat(sessionId);
        },
        remove: (worktree, options) => bridgeForKey(options.projectPath).removeWorktree(worktree.path, options),
        applyRemoval: (removed) => {
          if (removed.sessionIds.includes(selectedSessionRef.current ?? -1) || removed.worktreeId === selectedWorktree?.id) advanceChatView();
          setSelectedSessionId((current) => (current !== null && removed.sessionIds.includes(current) ? null : current));
          setSelectedWorktreeId((current) => (current === removed.worktreeId ? null : current));
        },
        refreshBranches: () =>
          void bridgeForKey(projectPath)
            .listBranches(projectPath)
            .then((next) => rememberBranches(projectPath, next))
            .catch(() => {}),
        notify: setNotice,
      },
      sessionId,
      mode,
      plan,
    )
      .catch((error) => {
        if (archiveState(projectPath)?.sessions[sessionId]) setNotice(`Could not delete Chat: ${ipcErrorMessage(error)}`);
      })
      .finally(() =>
        setArchivingChats((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        }),
      );
    return Promise.resolve();
  }

  const trackLinkArchive = useEvent((key: string, work: Promise<unknown>) => {
    setArchivingChats((current) => new Set(current).add(key));
    void work
      .catch((error) => {
        if (!selectedLinkRef.current) setNotice(`Could not delete Chat: ${ipcErrorMessage(error)}`);
      })
      .finally(() =>
        setArchivingChats((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        }),
      );
  });

  async function openGitDialog(sessionId: number, path: string | undefined): Promise<void> {
    if (path && (path !== projectRef.current?.path || selectedLinkRef.current)) {
      await openCanvasChat(path, sessionId);
      if (projectRef.current?.path !== path) return;
      return openGitDialog(sessionId, openProjectPath());
    }
    const currentState = openState();
    const session = currentState?.sessions[sessionId];
    const worktree = session ? currentState.worktrees[session.worktree_id] : undefined;
    if (!currentState || !session || !worktree) return;
    const sessionMessages =
      isLean(currentState) && project
        ? (
            await bridgeForKey(project.path)
              .readChatMessages(project.path, sessionId, { turns: 30 })
              .catch(() => ({ messages: [] as ChatMessage[] }))
          ).messages
        : currentState.messages.filter((message) => message.session_id === sessionId);
    openChat(sessionId);
    setGitDialog({
      sessionId,
      worktreeId: worktree.id,
      cwd: worktree.path,
      base: worktree.base,
      provider: session.provider,
      chat: gitChatContext(chatTitle(session, sessionMessages), sessionMessages),
    });
  }

  function recordGitNote(sessionId: number, body: string) {
    const current = projectRef.current;
    if (current)
      void bridgeForKey(current.path)
        .addGitNote(chatKey(current.path, sessionId), body)
        .catch(() => {});
  }

  useEffect(() => {
    void window.milagre.setKeepAwake(keepAwake).catch(() => {});
  }, [keepAwake]);

  const unreadChatIds = useMemo(
    () =>
      state && project
        ? Object.values(state.sessions)
            .filter((session) => session.unread && !session.archived)
            .map((session) => chatKey(project.path, session.id))
        : [],
    [state?.sessions, project?.path],
  );
  useEffect(() => {
    if (!project || selectedLink) return;
    void window.milagre
      .syncNotifications({
        projectPath: project.path,
        activeChatId: chatOnScreen({ view, runPane: runPaneOpen ? runPane : null, projectPath: project.path, sessionId: selectedSessionId }),
        unread: unreadChatIds,
        notifyOnCompletion,
        showDockBadge,
        hidden: [...hiddenProjects],
      })
      .catch(() => {});
  }, [selectedLink?.link.id, project?.path, view, runPaneOpen, selectedSessionId, unreadChatIds.join("\n"), notifyOnCompletion, showDockBadge, hiddenProjects]);

  useEffect(() => {
    void window.milagre.setNotifyWhenWaiting(notifyWhenWaiting).catch(() => {});
  }, [notifyWhenWaiting]);

  useEffect(() => {
    void window.milagre.setNotificationChime?.(notificationChime).catch(() => {});
  }, [notificationChime]);
  useEffect(() => window.milagre.onPlayChime?.(playNotificationChime), []);
  useEffect(() => {
    void window.milagre.setNotificationSchedule?.(notificationSchedule).catch(() => {});
  }, [notificationSchedule]);

  useEffect(
    () =>
      onAnyAgentEvent(({ chatId, event }) => {
        if (event.type === "turn-failed" && event.login) staleProviders();
        if (event.type === "subagent-update") {
          const path = projectOfKey(chatId);
          const linkId = isLinkScopeKey(path) ? path.slice("milagre-link:".length) : null;
          if (linkId)
            setLinkStates((previous) => {
              const cached = previous[linkId];
              return cached ? { ...previous, [linkId]: applyAgentEvent(cached, {}, path, chatId, event).state } : previous;
            });
          const cached = statesRef.current[path];
          if (cached) receiveState(path, applyAgentEvent(cached, {}, path, chatId, event).state);
        }
        const link = selectedLinkRef.current;
        if (link && chatInProject(scopeKey({ kind: "link", linkId: link.link.id }), chatId)) {
          const latest = linkStatesRef.current[link.link.id] ?? link.state;
          const session = latest.sessions[sessionIdFromKey(chatId)];
          if (session && !session.archived && ((event.type === "turn-completed" && !isSnoozed(session)) || event.type === "turn-failed"))
            void window.milagre
              .notifyCompletion({
                chatId,
                title: chatTitle(
                  session,
                  latest.messages.filter((message) => message.session_id === session.id),
                ),
              })
              .catch(() => {});
          return;
        }
        const current = projectRef.current;
        const latest = openState();
        if (!current || !latest || !chatInProject(current.path, chatId)) return;
        const session = latest.sessions[sessionIdFromKey(chatId)];
        if (!session || session.archived) return;
        if ((event.type === "turn-completed" && !isSnoozed(session)) || event.type === "turn-failed") {
          void window.milagre
            .notifyCompletion({
              chatId,
              title: chatTitle(
                session,
                latest.messages.filter((message) => message.session_id === session.id),
              ),
            })
            .catch(() => {});
        }
      }),
    [],
  );

  useEffect(() => {
    const renamed = (rename: WorktreeRename) => {
      if (projectRef.current?.path === rename.projectPath)
        void bridgeForKey(rename.projectPath)
          .listBranches(rename.projectPath)
          .then(
            (next) => rememberBranches(rename.projectPath, next),
            () => {},
          );
      else branchLists.delete(rename.projectPath);
    };
    const offLocal = window.milagre.onWorktreeRenamed(renamed);
    const offRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "worktree:renamed") renamed(event.payload);
    });
    return () => {
      offLocal();
      offRemote?.();
    };
  }, []);

  const pendingNotificationChat = useRef<string | null>(null);
  const openChatByKey = useEvent((chatId: string) => {
    const owner = projectOfKey(chatId);
    if (!isLinkScopeKey(owner) && owner !== projectRef.current?.path)
      prefetchLeanChat(owner, sessionIdFromKey(chatId), statesRef.current[owner] ?? cachedProjectCopy(owner)?.state);
    if (isLinkScopeKey(owner)) {
      void selectLink(owner.slice("milagre-link:".length), sessionIdFromKey(chatId));
      return;
    }
    const current = projectRef.current;
    const session = current && chatInProject(current.path, chatId) ? openState()?.sessions[sessionIdFromKey(chatId)] : undefined;
    if (session) {
      openChat(session.id);
      return;
    }
    const separator = chatId.lastIndexOf("#");
    if (separator <= 0) return;
    pendingNotificationChat.current = chatId;
    void switchProject(chatId.slice(0, separator));
  });
  useEffect(() => window.milagre.onOpenChat(openChatByKey), []);

  useEffect(
    () =>
      window.milagre.onOpenPhoneSettings(() => {
        setSettingsSection("devices");
        setSettingsOpen(true);
      }),
    [],
  );

  function startNewChat(draftText = "") {
    advanceChatView();
    const latest = openState();
    if (latest && projectRef.current) restoreProjectChoices(latest, projectRef.current.path);
    setSelectedSessionId(null);
    changes.hide();
    if (draftText) setDraft(draftText);
    setNewChatError(null);
    setView("chat");
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-prompt-editor]")?.focus());
  }

  function selectInitialChat(nextState: CoordinatorState, path: string) {
    restoreProjectChoices(nextState, path);
    const target = pendingNotificationChat.current;
    const targetId = target && chatInProject(path, target) ? sessionIdFromKey(target) : null;
    const sessionId = targetId !== null && nextState.sessions[targetId] ? targetId : latestSessionId(nextState);
    pendingNotificationChat.current = null;
    setSelectedSessionId(sessionId);
    if (sessionId !== null) setSelectedWorktreeId(nextState.sessions[sessionId]?.worktree_id ?? null);
  }

  function adoptProject(
    nextProject: OpenProject & StateStamp,
    { keepView = false, forgetChat = false, sessionId }: { keepView?: boolean; forgetChat?: boolean; sessionId?: number } = {},
  ) {
    handOverShownScope();
    if (!selectedLinkRef.current && projectRef.current)
      scopeDrafts.save(
        { kind: "project", projectPath: projectRef.current.path },
        { text: draftStore.get(), sessionId: forgetChat ? null : selectedSessionRef.current },
      );
    setOnboarding(false);
    setSelectedLink(null);
    projectsSeen.current.set(nextProject.path, { path: nextProject.path, name: nextProject.name });
    advanceChatView();
    setStartupError(null);
    setLoading(false);
    receiveState(nextProject.path, nextProject.state);
    keepOpenedState(nextProject);
    projectRef.current = nextProject;
    flushSync(() => {
      setProject(nextProject);
      selectInitialChat(nextProject.state, nextProject.path);
      const remembered = scopeDrafts.read({ kind: "project", projectPath: nextProject.path });
      const target = sessionId !== undefined && nextProject.state.sessions[sessionId] ? sessionId : remembered.sessionId;
      if (target !== null && nextProject.state.sessions[target]) setSelectedSessionId(target);
      if (selectedSessionRef.current !== null) markChatSwitch(chatKey(nextProject.path, selectedSessionRef.current));
      setGitDialog(null);
      if (!keepView) setView("chat");
    });
    const restored = restoredChatsNotice(nextProject.restoredChats);
    if (restored) setNotice(restored);
  }

  function keepOpenedState(reply: OpenProject & StateStamp) {
    seedHeldState(reply.path, reply);
    seedScopeState(reply.path, statesRef.current[reply.path]);
  }
  function handOverShownScope() {
    const link = selectedLinkRef.current;
    if (link) {
      const scope = `milagre-link:${link.link.id}`;
      seedScopeState(scope, cachedScopeState(scope) ?? linkStatesRef.current[link.link.id] ?? link.state);
    } else if (projectRef.current) seedScopeState(projectRef.current.path, statesRef.current[projectRef.current.path]);
  }

  function refreshOpenProject(next: OpenProject & StateStamp, adopted: CoordinatorState | undefined) {
    projectsSeen.current.set(next.path, { path: next.path, name: next.name });
    if (statesRef.current[next.path] === adopted) {
      receiveState(next.path, next.state);
      keepOpenedState(next);
    }
    const current = projectRef.current;
    if (!current || current.path !== next.path || current.name !== next.name || current.git !== next.git) setProject(next);
    const restored = restoredChatsNotice(next.restoredChats);
    if (restored) setNotice(restored);
  }

  function requestProject(projectPath: string): Promise<OpenProject & StateStamp> {
    return isRemoteKey(projectPath) ? readRemoteProject(projectPath) : bridgeForKey(projectPath).switchProject(projectPath);
  }
  async function readRemoteProject(projectPath: string): Promise<OpenProject & StateStamp> {
    const bridge = bridgeForKey(projectPath);
    const held = numberedState(projectPath);
    if (held && "worktrees" in held) {
      const reply: ProjectRead = await bridge.readProject(projectPath, { state: false });
      if (reply.state?.sessions) return reply as OpenProject & StateStamp;
      confirmHeldState(projectPath, reply);
      const { version: _version, epoch: _epoch, ...header } = reply;
      return { ...header, state: (numberedState(projectPath) as CoordinatorState | undefined) ?? held };
    }
    return bridge.readProject(projectPath, { state: true });
  }

  async function replaceProject(load: () => Promise<(OpenProject & StateStamp) | null>, path?: string, adopt: Parameters<typeof adoptProject>[1] = {}) {
    const navigation = ++projectNavigation.current;
    const cached = path ? projectsSeen.current.get(path) : undefined;
    const cachedState = path ? statesRef.current[path] : undefined;
    const instant = cached && cachedState ? { ...cached, state: cachedState } : path ? cachedProjectCopy(path) : undefined;
    let request: Promise<(OpenProject & StateStamp) | null>;
    try {
      request = load();
    } catch (error) {
      request = Promise.reject(error);
    }
    if (path) noteScopeOpening(path, request);
    if (instant && (instant.path !== projectRef.current?.path || selectedLinkRef.current)) adoptProject(instant, adopt);
    const adopted = path ? statesRef.current[path] : undefined;
    try {
      const next = await request;
      if (navigation !== projectNavigation.current || !next) return;
      if (next.path !== projectRef.current?.path || selectedLinkRef.current) adoptProject(next, adopt);
      else refreshOpenProject(next, path ? adopted : statesRef.current[next.path]);
    } catch (error) {
      if (navigation !== projectNavigation.current) return;
      if (!projectRef.current && onboarding) setStartupError(ipcErrorMessage(error));
      setNotice(ipcErrorMessage(error));
    }
  }

  const openProject = () => Promise.resolve(setAddProjectOpen(true));
  const switchProject = (projectPath: string, adopt: Parameters<typeof adoptProject>[1] = {}) =>
    replaceProject(() => requestProject(projectPath), projectPath, adopt);
  const onProjectRemoved = useEvent((event: Event) => {
    const removed = (event as CustomEvent<string>).detail;
    if (settingsProject?.path === removed) {
      setSettingsProject(null);
      setView("chat");
    }
    if (projectRef.current?.path !== removed || selectedLinkRef.current) return;
    const navigation = ++projectNavigation.current;
    scopeDrafts.save({ kind: "project", projectPath: removed }, { text: draftStore.get(), sessionId: selectedSessionRef.current });
    advanceChatView();
    projectRef.current = null;
    setProject(null);
    setSelectedSessionId(null);
    setSelectedWorktreeId(null);
    setOnboarding(false);
    setView("chat");
    void window.milagre
      .listRecentProjects()
      .then((list) => {
        const next = list.find((entry) => !entry.hidden && entry.path !== removed);
        if (next && navigation === projectNavigation.current && !projectRef.current) return switchProject(next.path);
        return undefined;
      })
      .catch(() => {});
  });
  useEffect(() => {
    window.addEventListener(PROJECT_REMOVED, onProjectRemoved);
    return () => window.removeEventListener(PROJECT_REMOVED, onProjectRemoved);
  }, [onProjectRemoved]);
  async function selectLink(id: string, sessionId?: number | null, { keepView = false, draftFrom }: { keepView?: boolean; draftFrom?: string } = {}) {
    const scope = `milagre-link:${id}`;
    const known = linksSeen.current.get(id) ?? knownLink(id);
    const held = linkStatesRef.current[id] ?? cachedScopeState(scope) ?? scopeStates[scope];
    if (typeof sessionId === "number") {
      prefetchLeanChat(scope, sessionId, held);
      beginChatSwitch(chatKey(scope, sessionId));
    }
    let request: Promise<OpenLink & StateStamp>;
    try {
      request = bridgeForKey(scope).openNamedLink(id);
    } catch (error) {
      request = Promise.reject(error);
    }
    const navigation = ++projectNavigation.current;
    const sourceView = chatView.current;
    const adopt = (next: OpenLink) => {
      handOverShownScope();
      setLinkNewChatText(draftFrom ? draftStore.take(draftFrom) : "");
      if (!selectedLinkRef.current && projectRef.current)
        scopeDrafts.save({ kind: "project", projectPath: projectRef.current.path }, { text: draftStore.get(), sessionId: selectedSessionRef.current });
      advanceChatView();
      setLinkStates((previous) => ({ ...previous, [id]: next.state }));
      setLinkInitialSession(sessionId);
      setLinkOpenNonce((count) => count + 1);
      setSelectedLink(next);
      setLastLink(next);
      if (!keepView) setView("chat");
      setNewChatError(null);
    };
    const instant = !draftFrom && known && held && !("worktrees" in held) ? { link: known.link, projects: known.projects, state: held } : null;
    if (instant) adopt(instant);
    try {
      const reply = await request;
      if (navigation !== projectNavigation.current) return;
      if (
        draftFrom &&
        (sourceView !== chatView.current || selectedLinkRef.current || draftFrom !== draftKey(projectRef.current?.path ?? "", selectedSessionRef.current))
      )
        return;
      const { version: _version, epoch: _epoch, ...next } = reply;
      linksSeen.current.set(id, next);
      seedHeldState(scope, reply);
      seedScopeState(scope, next.state);
      if (!instant) {
        adopt(next);
        return;
      }
      setLinkStates((previous) => {
        const reconciled = reconcileState(previous[id], next.state);
        return reconciled === previous[id] ? previous : { ...previous, [id]: reconciled };
      });
      const refresh = (current: OpenLink | null) => {
        if (current?.link.id !== id) return current;
        const link = reconcileState(current.link, next.link);
        const projects = reconcileState(current.projects, next.projects);
        return link === current.link && projects === current.projects ? current : { ...current, link, projects };
      };
      setSelectedLink(refresh);
      setLastLink(refresh);
    } catch (error) {
      if (navigation === projectNavigation.current) linkMissing(id, error);
    }
  }
  function noteMissingChat(projectPath: string, sessionId: number, source: string, state: CoordinatorState | undefined) {
    if (!isRemoteKey(projectPath) || !state?.sessions || state.sessions[sessionId]) return;
    noteComputer(projectPath, `${projectPath} opened Chat ${sessionId} from ${source}, which lacks it (${Object.keys(state.sessions).length} Chats)`);
  }
  async function openCanvasChat(projectPath: string, sessionId: number, adopt: Parameters<typeof adoptProject>[1] = {}) {
    if (isLinkScopeKey(projectPath)) {
      await selectLink(projectPath.slice("milagre-link:".length), sessionId, adopt);
      return;
    }
    if (!selectedLinkRef.current && projectRef.current?.path === projectPath) {
      openChat(sessionId);
      return;
    }
    const cachedState = statesRef.current[projectPath];
    prefetchLeanChat(projectPath, sessionId, cachedState ?? cachedProjectCopy(projectPath)?.state);
    beginChatSwitch(chatKey(projectPath, sessionId));
    let request: Promise<OpenProject & StateStamp>;
    try {
      request = isRemoteKey(projectPath) ? readRemoteProject(projectPath) : window.milagre.openCanvasProject(projectPath);
    } catch (error) {
      request = Promise.reject(error);
    }
    noteScopeOpening(projectPath, request);
    const navigation = ++projectNavigation.current;
    const seen = projectsSeen.current.get(projectPath);
    const instant = cachedState && seen ? { ...seen, state: cachedState } : cachedProjectCopy(projectPath);
    if (instant) {
      noteMissingChat(projectPath, sessionId, cachedState && seen ? "the window's copy" : "the sidebar's copy", instant.state);
      adoptProject(instant, { ...adopt, sessionId });
      openChat(sessionId);
    }
    const adopted = statesRef.current[projectPath];
    try {
      const next = await request;
      if (navigation !== projectNavigation.current) return;
      noteMissingChat(projectPath, sessionId, "version" in next ? `the host's read (state ${next.version})` : "a copy without a number", next.state);
      if (!instant || next.path !== projectRef.current?.path || selectedLinkRef.current) {
        adoptProject(next, { ...adopt, sessionId });
        openChat(sessionId);
        return;
      }
      refreshOpenProject(next, adopted);
    } catch (error) {
      if (navigation === projectNavigation.current) setNotice(ipcErrorMessage(error));
    }
  }

  async function resolveSendTarget(body: string, issue?: IssueRef, view = chatView.current) {
    if (!state || !project || !selectedWorktree) return null;
    if (!issue && preparedTarget.current?.view === view && preparedTarget.current.projectPath === project.path) return preparedTarget.current;
    if (selectedSession) return { sessionId: selectedSession.id as number | null, worktreeId: selectedWorktree.id };
    if (isolation === "local" && !issue) return { sessionId: null, worktreeId: selectedWorktree.id };
    setBaseBranch(effectiveBaseBranch);
    saveChatPreferences(localStorage, project.path, { baseBranch: effectiveBaseBranch });
    const created = await retrySend(
      () =>
        bridgeForKey(project.path).createWorktree({
          projectPath: project.path,
          baseBranch: effectiveBaseBranch,
          useProjectBase: baseOverride === null,
          prompt: body,
          ...(issue ? { issueKey: issue.key, ...(issue.workspace ? { issueWorkspace: issue.workspace } : {}) } : {}),
        }),
      { retryable: (error) => retryKind(error) === "unsent" },
    );
    receiveState(project.path, created.project.state);
    const session = sessionForWorktree(created.project.state, created.worktreeId);
    if (!session) throw new Error(`No chat session was created for ${created.project.state.worktrees[created.worktreeId]?.name}.`);
    if (created.setupNote) setNotice(created.setupNote);
    void bridgeForKey(project.path)
      .listBranches(project.path)
      .then((next) => rememberBranches(project.path, next))
      .catch(() => {});
    return { sessionId: session.id as number | null, worktreeId: created.worktreeId };
  }

  async function executeSend(
    body: string,
    mode: PermissionMode,
    images: ImageAttachment[] = imageDraft.images,
    files: string[] = imageDraft.files,
    preserveComposer = false,
    prAction?: PullRequestActionContext,
    issue?: LinearIssue,
    delivery?: MessageDelivery,
  ): Promise<boolean> {
    if ((!body && !images.length && !files.length) || !state || !selectedWorktree || !project || preparingHere || imageDraft.loading) return false;
    if (movingDraft.current) return false;
    const view = chatView.current;
    const sendKey = `${project.path}#${selectedSession?.id ?? `new${view}`}`;
    if (sendsInFlight.current.has(sendKey)) return false;
    sendsInFlight.current.add(sendKey);
    const stillHere = () => projectRef.current?.path === project.path && chatView.current === view;
    setNewChatError(null);
    const model = selectedModel;
    const firstMessage = chatCount === 0;
    const submittedDraft = draftStore.get();
    if (!outbox.getSnapshot().loaded) await outbox.ready.catch(() => {});
    if (queueForComputer(project.path) || hasQueuedChat(project.path, selectedSession?.id ?? null)) {
      try {
        const id = crypto.randomUUID();
        await outbox.enqueue({
          id,
          computerId: computerOfKey(project.path),
          computerName: openComputer?.name ?? "This computer",
          owner: project.path,
          conversation: selectedSession ? `chat:${selectedSession.id}` : id,
          request: {
            projectPath: project.path,
            sessionId: selectedSession?.id ?? null,
            delivery,
            worktreeId: selectedWorktree.id,
            body,
            images: [],
            files: [],
            prompt: prAction ? pullRequestActionPrompt(prAction) : body,
            provider: model.provider,
            model: model.id,
            permissionMode: mode,
            effort: effortFor(capabilityFor(model, capabilities), effort),
            ultracode: capabilityFor(model, capabilities).ultracode && ultracode,
            fastMode: capabilityFor(model, capabilities).fastMode && fastMode,
            replies: getSettings().claudeReplies,
            tldrEnabled: getSettings().tldrEnabled,
            ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
            ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: submittedDraft })! } : {}),
          },
          ...(!selectedSession && (isolation !== "local" || issue)
            ? {
                createWorktree: {
                  projectPath: project.path,
                  baseBranch: effectiveBaseBranch,
                  useProjectBase: baseOverride === null,
                  prompt: body,
                  ...(issue ? { issueKey: issue.key, issueWorkspace: issue.workspace } : {}),
                },
              }
            : {}),
          attachments: await outboxAttachments(images, files, imageDraft.localFiles),
        });
        if (!preserveComposer && stillHere()) {
          if (draftStore.get() === submittedDraft) setDraft("");
          for (const image of images) imageDraft.remove(image.id);
          for (const file of files) imageDraft.removeFile(file);
        }
        void outbox.flush().catch(() => {});
        return true;
      } catch (error) {
        setNewChatError(ipcErrorMessage(error));
        return false;
      } finally {
        sendsInFlight.current.delete(sendKey);
      }
    }
    const prepared = preparedTarget.current?.view === view && preparedTarget.current.projectPath === project.path ? preparedTarget.current : null;
    const previewWorktreeId = prepared?.worktreeId ?? (selectedSession || (isolation === "local" && !issue) ? selectedWorktree.id : NO_WORKTREE);
    const resendKey = `${project.path}#${selectedSession?.id ?? `new${view}`}`;
    const resendParts = [...images.map((image) => image.id), ...files];
    const preview = createPendingChat({
      clientMessageId: failedSendIds.current.reuse(resendKey, body, resendParts),
      state,
      sessionId: selectedSession?.id,
      worktreeId: previewWorktreeId,
      body,
      images,
      files,
      model: model.id,
      provider: model.provider,
      context: issue ? linearIssueContext(issue, submittedDraft) : (prAction ?? null),
    });
    dispatchPending({
      type: "add",
      send: {
        ...preview,
        view,
        projectPath: project.path,
        originSessionId: selectedSession?.id ?? null,
        originWorktreeId: selectedWorktree.id,
        creatingWorktree: previewWorktreeId === NO_WORKTREE,
        provider: model.provider,
      },
    });
    if (!preserveComposer) {
      setDraft("");
      imageDraft.clear();
    }
    const options = {
      delivery,
      provider: model.provider,
      model: model.id,
      permissionMode: mode,
      effort: effortFor(capabilityFor(model, capabilities), effort),
      ultracode: capabilityFor(model, capabilities).ultracode && ultracode,
      fastMode: capabilityFor(model, capabilities).fastMode && fastMode,
      replies: getSettings().claudeReplies,
      tldrEnabled: getSettings().tldrEnabled,
    };
    let target: Awaited<ReturnType<typeof resolveSendTarget>> = null;
    let sent = false;
    let uploading = true;
    try {
      const uploadedFiles = await prepareLocalFileUploads(project.path, files, images, imageDraft.localFiles);
      const uploadedImages = await prepareImageUploads(project.path, images);
      uploading = false;
      target = await resolveSendTarget(body, issue, view);
      if (!target) return false;
      if (firstMessage && stillHere()) preparedTarget.current = { ...target, view, projectPath: project.path };
      dispatchPending({ type: "target", clientMessageId: preview.message.clientMessageId, sessionId: target.sessionId, worktreeId: target.worktreeId });
      const sendTarget = target;
      const { sessionId } = await retrySend(
        () =>
          agentRuns.send({
            projectPath: project.path,
            clientMessageId: preview.message.clientMessageId,
            sessionId: sendTarget.sessionId,
            worktreeId: sendTarget.worktreeId,
            body,
            images: uploadedImages,
            files: uploadedFiles,
            prompt: prAction ? pullRequestActionPrompt(prAction) : attachmentPrompt(body, uploadedFiles),
            ...options,
            ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
            ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: submittedDraft })! } : {}),
          }),
        { retryable: (error) => retryKind(error) !== null },
      );
      if (preparedTarget.current?.view === view) preparedTarget.current = null;
      sent = true;
      failedSendIds.current.forget(resendKey);
      dispatchPending({ type: "sent", clientMessageId: preview.message.clientMessageId, sessionId, worktreeId: target.worktreeId });
      if (stillHere()) {
        const carried = draftStore.get();
        setDraft("");
        setSelectedSessionId(sessionId);
        setDraft([draftStore.get(), carried].filter(Boolean).join("\n\n"));
        setSelectedWorktreeId(openState()?.sessions[sessionId]?.worktree_id ?? target.worktreeId);
      }
      return true;
    } catch (error) {
      failedSendIds.current.remember(resendKey, preview.message.clientMessageId!, body, resendParts);
      const message = `${uploading ? "Could not upload attachments" : target ? "Could not send the message" : "Could not create the worktree"}: ${ipcErrorMessage(error)}`;
      if (stillHere()) {
        setNewChatError(message);
        if (!preserveComposer) {
          const nextDraft = draftStore.get();
          const remapped = imageDraft.restore(images, files, nextDraft);
          setDraft([restoredDraft(body, submittedDraft, issue !== undefined), remapped].filter(Boolean).join("\n\n"));
        }
      } else {
        if (!preserveComposer)
          setFailedSends((current) => [
            ...current,
            {
              ...preview,
              view,
              projectPath: project.path,
              originSessionId: selectedSession?.id ?? null,
              originWorktreeId: selectedWorktree.id,
              draft: restoredDraft(body, submittedDraft, issue !== undefined),
              error: message,
              target: target ? { ...target, view, projectPath: project.path } : null,
            },
          ]);
        setNotice(message);
      }
      return false;
    } finally {
      if (!sent) dispatchPending({ type: "drop", clientMessageId: preview.message.clientMessageId });
      sendsInFlight.current.delete(sendKey);
    }
  }

  async function sendDiffComments() {
    const sent = diffComments.sendable;
    if (sent.length === 0) return;
    const base =
      changes.mode === "pr" && prReview.pr ? `PR #${prReview.pr.number}` : changes.list.state === "ready" && changes.list.isRepo ? changes.list.base : null;
    changes.closeDiff();
    if (
      await executeSend(formatCommentsMessage(sent, { mode: changes.mode === "uncommitted" ? "uncommitted" : "committed", base }), permissionMode, [], [], true)
    )
      diffComments.removeMany(sent.map((comment) => comment.id));
  }

  const sendPrToChat = useEvent((text: string) => {
    changes.closeDiff();
    void executeSend(text, permissionMode, [], [], true);
  });
  const openRowPullRequest = useEvent((item: { id: string; details?: { path?: string } }, pr: { number: number }) => {
    const path = item.details?.path;
    const session = state?.sessions[Number(item.id)];
    if (!project || !path || !session || state?.worktrees[session.worktree_id]?.path !== path) return false;
    const key = chatKey(project.path, session.id);
    openChatByKey(key);
    setPrPick({ chat: key, number: pr.number });
    changes.showPullRequest();
    return true;
  });

  function startFromIssue(issue: LinearIssue) {
    void executeSend(issueFirstMessage(issue, draftStore.get()), permissionMode, imageDraft.images, imageDraft.files, false, undefined, issue);
  }

  function reportMilagreBug(sessionId: number) {
    if (selectedSessionRef.current !== sessionId) openChat(sessionId);
    setDraft(withReportPrompt(draftStore.get()));
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-prompt-editor]")?.focus());
  }

  async function compactContext() {
    if (!project || !selectedSession || !selectedWorktree || readOnly) return;
    const model = selectedModel;
    try {
      await agentRuns.send({
        projectPath: project.path,
        sessionId: selectedSession.id,
        worktreeId: selectedWorktree.id,
        body: COMPACT_COMMAND,
        prompt: COMPACT_COMMAND,
        images: [],
        files: [],
        provider: model.provider,
        model: model.id,
        permissionMode,
        effort: effortFor(capabilityFor(model, capabilities), effort),
        replies: getSettings().claudeReplies,
        tldrEnabled: getSettings().tldrEnabled,
        compact: true,
      });
    } catch (error) {
      setNotice(`Could not compact the context: ${ipcErrorMessage(error)}`);
    }
  }

  async function sendMessage(delivery?: MessageDelivery) {
    const body = draftStore.get().trim();
    if ((!body && !imageDraft.images.length && !imageDraft.files.length) || !state || !selectedWorktree || !project || preparingHere || imageDraft.loading)
      return;
    await executeSend(body, permissionMode, imageDraft.images, imageDraft.files, false, undefined, undefined, delivery);
  }

  const recommendationRef = useRef<(option: string) => void>(() => {});
  recommendationRef.current = (option) => {
    void executeSend(option, permissionMode);
  };
  const sendRecommendation = useCallback((option: string) => recommendationRef.current(option), []);

  function escapeOpenChat(event: KeyboardEvent) {
    if (!run || !project || !selectedSession) return;
    event.preventDefault();
    const approval = run.approvals[0];
    const question = approval ? undefined : run.questions[0];
    if (approval && !run.answered[approval.requestId]) answerApproval("deny");
    else if (question && !run.answered[question.requestId]) answerQuestion(null);
    else void agentRuns.interrupt(chatKey(project.path, selectedSession.id));
  }
  const { findOpen, setFindOpen, findSignal, findSeed, findRef, openFind, openMessage } = useFindInChat({
    canOpen: view === "chat" && chatCount > 0,
    shownSessionId: view === "chat" ? selectedSession?.id : undefined,
    messageCount: messages.length,
    openChat: (sessionId) => openChat(sessionId),
  });
  useAppShortcuts(
    {
      setSettingsOpen,
      settingsOpenRef,
      openSettingsAt,
      linkOpenRef: selectedLinkRef,
      shownTilesRef,
      gridFocusKeyRef,
      familySessionsRef,
      changesAvailableRef,
      terminalChatRef,
      findRef,
      changes,
      setView,
      openLinkedChat: (key) => openLinkedChat(key),
      openAlone: (key) => openAlone(key),
      openFind,
      setFindOpen,
      openCommandPalette,
      startNewChat: () => startNewChatOnThisMac(),
      openProject,
      setNotice,
    },
    {
      settingsOpenRef,
      linkOpenRef: selectedLinkRef,
      findRef,
      setFindOpen,
      runPaneOpen,
      closeRunPane: () => closeRunPane(),
      view,
      routineId,
      setRoutineId,
      setView,
      escapeOpenChat,
      deps: [run, project?.path, selectedSession?.id, view, routineId, runPaneOpen],
    },
  );
  const setJumpChats = useJumpToChat({ enabled: () => !selectedLinkRef.current && view === "chat", openChat });

  const pickChat = useEvent((id: string) => openChat(Number(id)));
  const checkScopeArchive = useEvent((scopeKey: string, id: string) => checkArchive(Number(id), scopeKey));
  const archiveScopeChat = useEvent((scopeKey: string, id: string, mode: ArchiveMode, plan: ArchivePlan) => archiveChat(Number(id), mode, plan, scopeKey));
  const startNewChatFromSidebar = useEvent(() => startNewChatOnThisMac());
  const openProjectFromSidebar = useEvent(() => void openProject());
  const switchProjectFromSidebar = useEvent((path: string) => void switchProject(path));
  const newChatInScope = useEvent((key: string) => {
    if (isLinkScopeKey(key)) {
      void selectLink(key.slice("milagre-link:".length));
      return;
    }
    startNewChatIn(key);
  });
  const newChatInLink = useEvent(async (id: string) => {
    if (movingDraft.current) return;
    const draftFrom = draftKey(projectRef.current?.path ?? "", selectedSessionRef.current);
    movingDraft.current = true;
    try {
      await selectLink(id, null, { draftFrom });
    } finally {
      movingDraft.current = false;
    }
  });
  function startNewChatIn(key: string, draftText = "") {
    if (!selectedLinkRef.current && projectRef.current?.path === key) {
      startNewChat(draftText);
      return;
    }
    const remembered = scopeDrafts.read({ kind: "project", projectPath: key });
    const start = () => startNewChat(draftText || (remembered.sessionId === null ? remembered.text : ""));
    const switched = switchProject(key);
    if (!selectedLinkRef.current && projectRef.current?.path === key) start();
    else
      void switched.then(() => {
        if (!selectedLinkRef.current && projectRef.current?.path === key) start();
      });
  }
  const startNewChatOnThisMac = useEvent(async (draftText: string = "") => {
    const current = projectRef.current?.path;
    const currentKind = projectRef.current?.kind;
    if (!selectedLinkRef.current && current && currentKind !== "chats" && computerOfKey(current) === LOCAL_COMPUTER) {
      startNewChat(draftText);
      return;
    }
    const recent = await window.milagre.listRecentProjects().catch((): RecentProject[] => []);
    const home = newChatProject({ currentPath: current, currentKind, recent });
    if (home) startNewChatIn(home, draftText);
    else if (!selectedLinkRef.current) startNewChat(draftText);
  });
  const startTriage = useEvent(async () => {
    const { prompt } = await window.milagre.prepareTriage(`Milagre desktop ${await window.milagre.getAppVersion()} on ${navigator.platform}`);
    await startNewChatOnThisMac(prompt);
  });
  const moveNewChat = useEvent(async (key: string, home?: Pick<ChatsHome, "exists">) => {
    const from = projectRef.current?.path;
    if (selectedLinkRef.current || !from || from === key) return;
    const typedKey = draftKey(from, selectedSessionRef.current);
    movingDraft.current = true;
    try {
      await moveDraftTo(key, from, typedKey, home);
    } finally {
      movingDraft.current = false;
    }
  });
  async function moveDraftTo(key: string, from: string, typedKey: string, home?: Pick<ChatsHome, "exists">) {
    if (home && !home.exists) {
      try {
        await bridgeForKey(key).ensureChatsHome();
      } catch (error) {
        if (!selectedLinkRef.current && projectRef.current?.path === from)
          setNewChatError(`Could not start a Chat without a Project: ${ipcErrorMessage(error)}`);
        return;
      }
      if (selectedLinkRef.current || projectRef.current?.path !== from) return;
    }
    const remembered = scopeDrafts.read({ kind: "project", projectPath: key });
    const start = () => {
      const carried = draftStore.take(typedKey);
      if (carried) scopeDrafts.save({ kind: "project", projectPath: from }, { text: "", sessionId: null });
      startNewChat(carried || (remembered.sessionId === null ? remembered.text : ""));
    };
    const arrived = () => !selectedLinkRef.current && projectRef.current?.path === key;
    const switched = switchProject(key);
    if (arrived()) start();
    else {
      await switched;
      if (arrived()) start();
    }
  }
  const newChatWithoutProject = useEvent(async () => {
    const bridge = bridgeFor(LOCAL_COMPUTER);
    try {
      const home = await bridge.chatsHome();
      startNewChatIn(home.exists ? home.path : (await bridge.ensureChatsHome()).path);
    } catch (error) {
      setNotice(`Could not start a Chat without a Project: ${ipcErrorMessage(error)}`);
    }
  });
  const sidebarRunKeys = runKeys(runStatuses);
  const openScopeChat = useEvent((scopeKey: string, id: string) => void openCanvasChat(scopeKey, Number(id)));
  const switchLinkFromSidebar = useEvent((id: string) => void selectLink(id));
  const editLinkFromSidebar = useEvent((id: string) => void editLink(id));
  const deleteLinkFromSidebar = useEvent((id: string) => void deleteLink(id));
  const hoverChat = useEvent((scopeKey: string, id: string) => {
    const state = isLinkScopeKey(scopeKey)
      ? (linkStatesRef.current[scopeKey.slice("milagre-link:".length)] ?? cachedScopeState(scopeKey))
      : (statesRef.current[scopeKey] ?? scopeStates[scopeKey] ?? cachedScopeState(scopeKey) ?? cachedProjectCopy(scopeKey)?.state);
    prefetchLeanChat(scopeKey, Number(id), state);
  });
  const askLinkedChat = useEvent(async (scopeKey: string, id: string, message: { body: string; prompt: string }) => {
    const sessionId = Number(id);
    const state = statesRef.current[scopeKey] ?? (await bridgeForKey(scopeKey).readProject(scopeKey)).state;
    const session = state.sessions[sessionId];
    if (!session || session.archived) throw new Error("That chat is no longer in its Project.");
    const fallback = resolveModel(models, defaultModelId, providerForId(defaultModelId));
    const own = state.messages.filter((item) => item.session_id === sessionId);
    const model = modelForOpenChat(chatModels.current[chatKey(scopeKey, sessionId)], session.provider, own, models, fallback);
    await agentRuns.send({
      projectPath: scopeKey,
      sessionId,
      worktreeId: session.worktree_id,
      body: message.body,
      images: [],
      files: [],
      prompt: message.prompt,
      provider: model.provider,
      model: model.id,
      permissionMode: getSettings().defaultPermissionMode,
      effort: effortFor(capabilityFor(model, capabilities), effort),
      replies: getSettings().claudeReplies,
      tldrEnabled: getSettings().tldrEnabled,
    });
    void openCanvasChat(scopeKey, sessionId);
  });
  const openCanvas = useEvent(() => {
    changes.closeDiff();
    setView("canvas");
  });
  const openRoutines = useEvent(() => {
    changes.closeDiff();
    setRoutineId(null);
    setView("routines");
  });
  const openOrchestrator = useEvent(() => {
    changes.closeDiff();
    setView("orchestrator");
  });
  const openUsage = useEvent(() => {
    changes.closeDiff();
    setSettingsSection("usage");
    setSettingsOpen(true);
  });
  const openUsageChat = useEvent((computerId: string, projectPath: string, sessionId: number) => {
    setView("chat");
    void openCanvasChat(qualifyKey(computerId, projectPath), sessionId);
  });
  const openRoutine = useEvent((id: string | null) => {
    changes.closeDiff();
    setRoutineId(id);
    setView("routines");
  });
  const openProjectSettings = useEvent((path?: string) => {
    setSettingsProject(path && path !== projectRef.current?.path ? { path, name: projectName(path) } : null);
    setSettingsSection("project");
    setSettingsOpen(true);
  });
  const openLinkedChat = useEvent((key: string) => void openCanvasChat(projectOfKey(key), sessionIdFromKey(key)));
  const openAlone = useEvent((key: string) => openLinkedChat(key));
  const { answerQuestion: answerSubchatQuestion, dismissSuggestion } = agentRuns;
  const subchatActions = useMemo<SubchatActions>(
    () => ({
      sendSuggestion: (subchat, requestId, answers, suggestionId) => answerSubchatQuestion(subchat, requestId, answers, undefined, suggestionId),
      dismissSuggestion,
    }),
    [answerSubchatQuestion, dismissSuggestion],
  );
  useEffect(() => provideSubchatActions(subchatActions), [subchatActions]);
  const openRunChat = useEvent((key: string) => {
    runPaneReturn.current ??= project
      ? { projectPath: project.path, linkId: selectedLink?.link.id ?? null, sessionId: selectedSessionId, worktreeId: selectedWorktreeId }
      : null;
    setRunPane(key);
    holdRoutinesView.current = key;
    void openCanvasChat(projectOfKey(key), sessionIdFromKey(key), { keepView: true }).finally(() => {
      if (holdRoutinesView.current === key) holdRoutinesView.current = null;
    });
  });
  const closeRunPane = useEvent(() => {
    const saved = runPaneReturn.current;
    const paneKey = runPaneRef.current;
    runPaneReturn.current = null;
    if (holdRoutinesView.current !== null) projectNavigation.current += 1;
    holdRoutinesView.current = null;
    setRunPane(null);
    const back = runPaneRestore(saved, paneKey, focusedChatKeyRef.current, projectRef.current?.path ?? null);
    if (!back) return;
    if (back.kind === "link") void selectLink(back.linkId, back.sessionId ?? undefined, { keepView: true });
    else if (back.kind === "same") {
      if (back.sessionId !== selectedSessionRef.current) {
        if (back.sessionId !== null && projectRef.current) markChatSwitch(chatKey(projectRef.current.path, back.sessionId));
        advanceChatView();
      }
      setSelectedSessionId(back.sessionId);
      setSelectedWorktreeId(back.worktreeId);
    } else if (back.sessionId !== null) void openCanvasChat(back.projectPath, back.sessionId, { keepView: true, forgetChat: true });
    else void switchProject(back.projectPath, { keepView: true, forgetChat: true });
  });
  useEffect(() => {
    closeRunPane();
  }, [routineId, view]);
  const { sidebarUsage, sidebarUsageButton } = useSidebarUsage(usageInSidebar, usage, accountScope, accountScopeIsHome);
  const mentionKey = JSON.stringify(state && !isLinkScopeKey(project?.path ?? "") ? chatMentionChoices(state) : []);
  const mentionChats = useMemo(() => JSON.parse(mentionKey) as ReturnType<typeof chatMentionChoices>, [mentionKey]);
  const mentionContext = useMemo(
    () => ({ chats: mentionChats, project: project?.path ?? "", currentId: selectedSession?.id, onOpen: openLinkedChat }),
    [mentionChats, project?.path, selectedSession?.id, openLinkedChat],
  );
  const composerWorktrees = useMemo(
    () => worktrees.filter((worktree) => !worktree.sharedChat).map((worktree) => ({ id: worktree.id, name: worktree.name, path: worktree.path })),
    [worktrees],
  );

  const { phase: splash } = useSplash();
  const [appEntered, setAppEntered] = useState(false);
  const splashOverlay = (leaving: boolean) => (splash === "gone" ? null : <AppSplash key="startup-splash" leaving={leaving} />);
  useLayoutEffect(settleSplash);

  if (!loading && !project && onboarding)
    return (
      <Onboarding
        splash={splashOverlay(true)}
        onOpened={(opened) => {
          setFirstChat(opened.path);
          adoptProject(opened);
        }}
        onSkip={() => {
          setOnboarding(false);
          void newChatWithoutProject();
        }}
      />
    );

  if (startupError) {
    return (
      <StartupErrorScreen
        error={startupError}
        splash={splashOverlay(true)}
        onRetry={() => void loadInitialProject()}
        onOpenAnother={() => void openProject()}
      />
    );
  }

  async function findLink(id: string) {
    const link = (await bridgeForKey(`milagre-link:${id}`).listNamedLinks()).find((item) => item.id === id);
    if (!link) throw new Error("Link no longer exists");
    return link;
  }
  function linkMissing(id: string, error: unknown) {
    const message = ipcErrorMessage(error);
    if (!(isLinkGone(message) && linkGone(id))) setNotice(message);
  }
  async function editLink(id: string) {
    try {
      setLinkDialogOpen(await findLink(id));
    } catch (error) {
      linkMissing(id, error);
    }
  }
  async function deleteLink(id: string) {
    try {
      setDeletingLink(await findLink(id));
    } catch (error) {
      linkMissing(id, error);
    }
  }
  function linkDeleted(link: NamedProjectLink, result: NamedLinkDeleted) {
    setDeletingLink(null);
    const kept = deletedLinkText(link.name, result.kept);
    if (kept) setNotice(kept);
    leaveDeletedLink(link.id);
  }
  function leaveDeletedLink(id: string) {
    window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    setLastLink((current) => (current?.link.id === id ? null : current));
    if (selectedLinkRef.current?.link.id !== id) return false;
    const navigation = ++projectNavigation.current;
    selectedLinkRef.current = null;
    setSelectedLink(null);
    setView("chat");
    void window.milagre
      .listRecentProjects()
      .then((list) => {
        const next = list.find((entry) => !entry.hidden);
        if (!next || navigation !== projectNavigation.current || selectedLinkRef.current || next.path === projectRef.current?.path) return undefined;
        return switchProject(next.path);
      })
      .catch(() => {});
    return true;
  }
  async function linkEdited(link: NamedProjectLink) {
    window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    if (selectedLinkRef.current?.link.id !== link.id) return;
    try {
      const next = await bridgeForKey(`milagre-link:${link.id}`).openNamedLink(link.id);
      if (selectedLinkRef.current?.link.id === link.id) setSelectedLink(next);
    } catch (error) {
      linkMissing(link.id, error);
    }
  }
  const unsavedScopes: UnsavedScope[] = Object.entries({
    ...gridStates,
    ...Object.fromEntries(
      Object.entries({ ...(selectedLink ? { [selectedLink.link.id]: selectedLink.state } : {}), ...linkStates }).map(([id, state]) => [
        `milagre-link:${id}`,
        state,
      ]),
    ),
  }).flatMap(([scope, saved]) =>
    saved.persistence
      ? [
          {
            scope,
            name: isLinkScopeKey(scope)
              ? selectedLink && `milagre-link:${selectedLink.link.id}` === scope
                ? selectedLink.link.name
                : "Shared Chats"
              : projectName(scope),
            failure: saved.persistence,
            offline: isRemoteKey(scope) ? isReadOnly(pairedComputers.find((computer) => computer.id === computerOfKey(scope))) : !hostConnection.connected,
          },
        ]
      : [],
  );
  const openSaveScope = selectedLink ? `milagre-link:${selectedLink.link.id}` : project?.path;
  const openFailure = unsavedScopes.find((entry) => entry.scope === openSaveScope);
  const dockSaveNotice = openFailure ? <SaveFailure key={openFailure.scope} {...openFailure} /> : undefined;
  const globalUnsavedScopes = unsavedScopes.filter(
    (entry) => view !== "chat" || (!selectedLink && diffPresence.occupied && !runPaneOpen) || entry.scope !== openSaveScope,
  );
  const saveNotices = <PersistenceNotices scopes={globalUnsavedScopes} />;
  const linkDialog = (
    <>
      {linkDialogOpen ? (
        <LinkProjectDialog
          link={typeof linkDialogOpen === "object" ? linkDialogOpen : undefined}
          onClose={() => setLinkDialogOpen(false)}
          onCreated={(link) => {
            const edited = typeof linkDialogOpen === "object";
            setLinkDialogOpen(false);
            void (edited ? linkEdited(link) : selectLink(link.id));
          }}
          onDelete={(link) => {
            setLinkDialogOpen(false);
            setDeletingLink(link);
          }}
        />
      ) : null}
      {deletingLink ? <DeleteLinkDialog link={deletingLink} onClose={() => setDeletingLink(null)} onDeleted={linkDeleted} /> : null}
    </>
  );
  const appDialogs = (
    <AppDialogs
      dialogs={dialogs}
      computerName={(id) => pairedComputers.find((computer) => computer.id === id)?.name ?? null}
      onLinkProjects={() => setLinkDialogOpen(true)}
      onOpened={(opened) => void replaceProject(async () => opened)}
    />
  );
  const settingsModal = (
    <AppSettingsModal
      dialogs={dialogs}
      project={project}
      inProject={Boolean(project) && !selectedLink}
      projectSettings={surfaces.settings}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      accountScope={accountScope}
      models={models}
      update={update}
      onOpenUsageChat={openUsageChat}
    />
  );
  const shownLink = selectedLink ?? lastLink;
  const linkWorkspace = shownLink && (
    <LinkWorkspace
      key={shownLink.link.id}
      opened={shownLink}
      state={linkStates[shownLink.link.id] ?? shownLink.state}
      openNonce={linkOpenNonce}
      hostConnection={hostConnection}
      saveNotice={dockSaveNotice}
      saveScopes={unsavedScopes}
      ports={agentPorts}
      agents={agentRuns}
      drafts={scopeDrafts}
      initialSessionId={linkInitialSession}
      initialDraft={linkNewChatText}
      preferences={{
        models,
        selectedModel,
        onModelChange: chooseModel,
        modelForChat: modelForChatKey,
        showModel: setSelectedModel,
        cliStatus,
        onModelPickerOpen: refreshCliStatus,
        onUpdateCli: handleUpdateCli,
        updatingCli,
        capability: selectedCapability,
      }}
      onSwitchProject={(path) => void switchProject(path)}
      onSwitchLink={(id) => void selectLink(id)}
      onLinkProject={() => setLinkDialogOpen(true)}
      onAddComputer={openAddComputer}
      onOpenComputerSettings={openComputerSettings}
      onEditLink={(id) => void editLink(id)}
      onDeleteLink={deleteLinkFromSidebar}
      onOpenProject={() => void openProject()}
      onSettings={() => openSettingsAt("accounts")}
      onOpenAccounts={openAccounts}
      linkedWork={linkedWork}
      onCanvasChat={(path, id) => void openCanvasChat(path, id)}
      usage={sidebarUsage}
      usageButton={sidebarUsageButton}
      onNewChatInScope={newChatInScope}
      onNewChat={startNewChatOnThisMac}
      onPickChat={() => setSettingsOpen(false)}
      archivingChats={archivingChats}
      onArchiving={trackLinkArchive}
      scopeChatActions={scopeChatActions}
    />
  );
  const linkDialogs = (
    <>
      {linkDialog}
      {appDialogs}
    </>
  );
  if (selectedLink && (loading || !project || !state))
    return (
      <>
        {splashOverlay(true)}
        {linkWorkspace}
        {linkDialogs}
        {settingsModal}
      </>
    );

  if (!loading && !project)
    return (
      <ChooseProjectScreen
        splash={splashOverlay(true)}
        saveNotices={saveNotices}
        notice={notice}
        onAddProject={openProjectFromSidebar}
        sidebar={
          <SidebarNav
            fill
            workspaceName="Projects"
            recents={[]}
            onOpenProject={openProjectFromSidebar}
            onSwitchProject={switchProjectFromSidebar}
            onSwitchLink={(id) => void selectLink(id)}
            onEditLink={(id) => void editLink(id)}
            onDeleteLink={deleteLinkFromSidebar}
            onAddComputer={openAddComputer}
            onOpenComputerSettings={openComputerSettings}
            onOpenProjectSettings={openProjectSettings}
            onNewChatInScope={newChatInScope}
            onOpenScopeChat={openScopeChat}
            onHoverChat={hoverChat}
            onOpenSettings={() => {
              setSettingsSection("general");
              setSettingsOpen(true);
            }}
            runningKeys={sidebarRunKeys.running}
            waitingKeys={sidebarRunKeys.waiting}
            askingKeys={sidebarRunKeys.asking}
            attentionPaths={attentionPaths}
          />
        }
      >
        {linkDialogs}
        {settingsModal}
      </ChooseProjectScreen>
    );

  if (loading || !project || !state) {
    return <>{splashOverlay(false)}</>;
  }

  const paletteCommands = (current: OpenProject) =>
    buildCommands({
      current,
      terminalChatId,
      projectSettings: surfaces.settings,
      view,
      settingsOpen,
      layout,
      selectedSession,
      selectedWorktreePath: selectedWorktree?.path,
      showGit,
      remoteProject: isRemoteKey(project?.path),
      chatCount,
      chats,
      recentProjects,
      actions: {
        newChat: () => startNewChatOnThisMac(),
        newTerminal: (chatId) => newTerminal(chatId, undefined, setNotice),
        openProject: () => openProject(),
        openCanvas,
        openRoutines,
        openOrchestrator,
        openUsage,
        openStorage: () => openStorage(null),
        startTriage,
        openSettingsAt: (section, row) => {
          setSettingsSection(section);
          setSettingsOpen(true);
          if (row) findSetting(section, row);
        },
        toggleTheme,
        openProjectSettings,
        backToChat: () => {
          setSettingsOpen(false);
          setView("chat");
        },
        showOneChat: () => {
          setView("chat");
          toggleLayout();
        },
        openGitDialog: (sessionId) => openGitDialog(sessionId, openProjectPath()),
        openChatInEditor: (sessionId) => openChatInEditor(sessionId, openProjectPath()),
        revealChat: (sessionId) => revealChat(sessionId, openProjectPath()),
        openFind,
        setUnread: (sessionId, unread) => patchChat(sessionId, { unread }, openProjectPath()),
        reloadChat: (sessionId) => reloadChat(sessionId, openProjectPath()),
        reportMilagreBug,
        copyPath: (path) => navigator.clipboard.writeText(path),
        openChat,
        switchProject: (path) => void switchProject(path),
      },
    });

  const projectBridge = bridgeForKey(project.path);
  const approvalProps: ChatApprovalProps = {
    chatId: chatKey(project.path, selectedSession?.id ?? 0),
    run,
    messages: displayedMessages,
    pendingApproval,
    approvalCard,
    pendingQuestion,
    questionSent,
    remoteDelegations,
    dictationChat: { cwd: selectedWorktree?.path ?? project.path, scope: project.path, chatId: selectedSession?.id, provider: selectedModel.provider },
    onAnswerApproval: answerApproval,
    onAnswerQuestion: answerQuestion,
    onRespond: agentRuns.respond,
    onInterrupt: agentRuns.interrupt,
    onOpenChat: openChatKey,
  };
  const panelButtons = changesPanelButtons(changes, changesAvailable, prShown, prNumber);
  const projectWorkspace = (
    <BridgeContext.Provider value={projectBridge}>
      <ScopeContext.Provider value={project.path}>
        <DotBackground key="app">
          <HostNotices
            scopes={globalUnsavedScopes}
            hostConnection={hostConnection}
            restartingHost={restartingHost}
            setRestartingHost={setRestartingHost}
            setNotice={setNotice}
            onSettings={openAccounts}
            onProvidersUpdated={handleProvidersUpdated}
          />
          <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
          <PanelToggles hidden={chatPanelsHidden(view, runPaneOpen)} split={splitOn} right={12 + trailingCorner * CORNER_PITCH} {...panelButtons} />
          {canvasButtonShown && (
            <CanvasButton active={view === "canvas"} hidden={splitOn} onToggle={() => (view === "canvas" ? setView("chat") : openCanvas())} />
          )}
          <div
            className={`flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink ${appEntered ? "" : "app-enter"}`}
            onAnimationEnd={(event) => {
              if (event.animationName === "app-enter-main") setAppEntered(true);
            }}
          >
            <div className="flex min-h-0 shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
              <PullRequestOpenContext.Provider value={openRowPullRequest}>
                <SidebarNav
                  fill
                  workspaceName={surfaces.name}
                  workspaceImage={projectImage(project.path)}
                  onSwitchLink={switchLinkFromSidebar}
                  onAddComputer={openAddComputer}
                  onOpenComputerSettings={openComputerSettings}
                  onEditLink={editLinkFromSidebar}
                  onDeleteLink={deleteLinkFromSidebar}
                  onOpenProject={openProjectFromSidebar}
                  recents={chats}
                  activeId={
                    view === "chat"
                      ? pendingHere && pendingSend
                        ? String(pendingCanonicalId ?? pendingSend.session.id)
                        : selectedSession
                          ? String(selectedSession.id)
                          : null
                      : null
                  }
                  onPick={pickChat}
                  onJumpChatsChange={setJumpChats}
                  chatActions={chatActions}
                  scopeChatActions={scopeChatActions}
                  onNewChat={startNewChatFromSidebar}
                  onOpenSettings={openSettings}
                  onOpenRoutines={openRoutines}
                  routinesActive={view === "routines"}
                  routinesUnread={unreadRunRoutineIds.size > 0}
                  onOpenCommands={openCommandPalette}
                  hintsEnabled={view === "chat" && !commandPaletteOpen && !gitDialog}
                  projectPath={project.path}
                  projectKind={project.kind}
                  onNewChatWithoutProject={newChatWithoutProject}
                  onSwitchProject={switchProjectFromSidebar}
                  attentionPaths={attentionPaths}
                  onOpenProjectSettings={surfaces.settings ? openProjectSettings : undefined}
                  onNewChatInScope={newChatInScope}
                  usage={sidebarUsage}
                  usageButton={sidebarUsageButton}
                  runningKeys={sidebarRunKeys.running}
                  waitingKeys={sidebarRunKeys.waiting}
                  askingKeys={sidebarRunKeys.asking}
                  onOpenScopeChat={openScopeChat}
                  onScopeArchiveCheck={checkScopeArchive}
                  onScopeArchive={archiveScopeChat}
                  archivingChats={archivingChats}
                  onHoverChat={hoverChat}
                  onAskChat={askLinkedChat}
                  orchestrator={<OrchestratorSidebarRow active={view === "orchestrator"} onShow={openOrchestrator} />}
                />
              </PullRequestOpenContext.Provider>
            </div>

            <main
              data-workspace-main
              data-chat-to-edge={chatToEdge || undefined}
              className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent pr-3 ${chatToEdge ? "[--chat-edge-fade:24px] [--chat-edge-pad:12px]" : "pb-3"}`}
            >
              <DiffBar
                open={changes.diffOpen}
                onBack={changes.closeDiff}
                label={selectedSession ? (chats.find((row) => row.id === String(selectedSession.id))?.label ?? chatTitle(selectedSession)) : undefined}
                send={{ count: diffComments.sendable.length, onSend: () => void sendDiffComments() }}
                trailing={<DiffToolbar changes={changes} prefs={diffPrefs} />}
                corner={cornerButtons * CORNER_PITCH}
              />
              <AnimatePresence initial={false} onExitComplete={diffPresence.onExitComplete}>
                {changes.diffOpen && <DiffView key="diff" changes={changes} prefs={diffPrefs} comments={diffComments} review={prDiffReview} />}
              </AnimatePresence>
              {view === "chat" && !diffPresence.occupied && shownTiles.length === 0 && focusedChatKey && (
                <RoutineChip chatKey={focusedChatKey} run={selectedSession?.routine} place="strip" onOpen={openRoutine} />
              )}
              {bookmarkShown && !bookmarkedParent && selectedSession && focusedChatKey && (
                <ChatIdentity
                  title={fullChatTitle(selectedSession, messagesBySession.get(selectedSession.id) ?? NO_MESSAGES)}
                  project={surfaces.settings ? surfaces.name : undefined}
                  corner={cornerButtons * CORNER_PITCH}
                />
              )}
              {bookmarkedParent && focusedChatKey && (
                <SubchatBookmark
                  chatKey={focusedChatKey}
                  reads={{ sessions: familySessions, work: linkedWork }}
                  corner={cornerButtons * CORNER_PITCH}
                  onOpen={openAlone}
                  onBeside={openBeside}
                  onShowAll={showFamily}
                />
              )}
              {view === "canvas" && (
                <CanvasView
                  states={states}
                  runs={runStatuses}
                  linkedWork={linkedWork}
                  onOpenChat={(path, id) => void openCanvasChat(path, id)}
                  onNewChat={(path) => {
                    setView("chat");
                    newChatInScope(path);
                  }}
                  onBack={() => setView("chat")}
                />
              )}
              <div
                data-routine-split={runPaneOpen || undefined}
                className={runPaneOpen ? "flex min-h-0 flex-1 gap-3 pt-[var(--window-chrome-height)]" : "contents"}
              >
                <div className={runPaneOpen ? `flex min-h-0 ${view === "orchestrator" ? "" : "w-[420px]"} shrink-0 flex-col` : "contents"}>
                  {view === "routines" && (
                    <RoutinesPage
                      models={models}
                      capabilities={capabilities}
                      projectPath={project.path}
                      unreadRoutines={unreadRunRoutineIds}
                      routineId={routineId}
                      unreadChats={unreadRunChatKeys}
                      canOpen={canOpenRun}
                      runChat={runPaneOpen ? runPane : null}
                      onOpenRoutine={openRoutine}
                      onOpenChat={openLinkedChat}
                      onMarkRead={markRoutineRead}
                      onOpenRunChat={openRunChat}
                      onCloseRunChat={closeRunPane}
                    />
                  )}
                  {view === "orchestrator" && <OrchestratorPage pane={runPaneOpen ? runPane : null} onOpen={openRunChat} onBack={closeRunPane} />}
                </div>
                <div
                  data-chat-pane
                  data-run-chat-pane={runPaneOpen || undefined}
                  className={`min-h-0 flex-1 flex-col overflow-hidden ${(view === "chat" && !diffPresence.occupied) || runPaneOpen ? "flex" : "hidden"} ${runPaneOpen ? "min-w-0 rounded-window border border-line bg-surface [&_.chat-column]:pt-4" : ""}`}
                  style={
                    runPaneOpen
                      ? ({ animation: "fade-in var(--duration-base) var(--ease-enter)", "--window-chrome-height": "0px" } as CSSProperties)
                      : { animation: "fade-in var(--duration-base) var(--ease-enter)" }
                  }
                >
                  {runPaneOpen && focusedChatKey && selectedSession && (
                    <RunChatHeader
                      chatKey={focusedChatKey}
                      title={chatTitle(selectedSession, displayedMessages)}
                      branch={showGit ? chatBranchLabel(selectedSession, selectedWorktree?.name) : undefined}
                      onClose={closeRunPane}
                      running={Boolean(run)}
                    />
                  )}
                  {awayBanner && lean && selectedSession && !chatWindow.loading && chatWindow.messages.length === 0 && <OfflineEmpty />}
                  <ChatGrid
                    keys={shownTiles}
                    stacked={stackedTiles}
                    focused={gridFocusKey}
                    states={gridStates}
                    delegated={delegatedKeys}
                    models={models}
                    onFocus={openLinkedChat}
                    onOpenRoutine={openRoutine}
                    onDismiss={dismissTile}
                    pinned={pinnedTiles}
                    onTogglePin={toggleGridPin}
                    onClose={splitOn ? closeSplitTile : undefined}
                    menu={splitOn ? tileMenu : undefined}
                    panelMenu={<PanelMenu {...panelButtons} />}
                    onStop={stopTileRun}
                  >
                    <EditorLinks
                      root={isRemoteKey(project.path) ? "" : (selectedWorktree?.path ?? project.path)}
                      files={selectedWorktree?.path ?? (isRemoteKey(project.path) ? "" : project.path)}
                    >
                      <ChatComposer
                        store={draftStore}
                        stepApproval={stepApproval.value}
                        offScreen={!(view === "chat" || runPaneOpen)}
                        mentionContext={mentionContext}
                        messages={displayedMessages}
                        limitPending={selectedSession?.limitResume}
                        limitSourceMessageId={selectedSession?.limitTurn?.sourceMessageId}
                        limitResumeBlocked={!!selectedSession?.queued?.length}
                        loading={messagesLoading}
                        loadError={lean ? (pendingHere && pendingCanonicalId !== null ? canonicalWindow : chatWindow).error : undefined}
                        onRetryLoad={() => void (pendingHere && pendingCanonicalId !== null ? canonicalWindow : chatWindow).retry()}
                        scrollKey={chatView.current}
                        pendingMessageId={pendingHere && pendingCanonicalId === null ? pendingSend?.message.id : undefined}
                        imageDraft={imageDraft}
                        projectPath={selectedWorktree?.path ?? project.path}
                        messageScope={project.path}
                        earlier={earlierMessages}
                        trimHistory={lean && !(pendingHere && pendingCanonicalId !== null) ? chatWindow.trim : undefined}
                        onSend={(delivery) => void sendMessage(delivery)}
                        onCompact={
                          selectedSession && providerCapabilities(selectedSession.provider ?? "claude").compact && !readOnly
                            ? () => void compactContext()
                            : undefined
                        }
                        onSendDesignMessage={(text) => executeSend(text, permissionMode, [], [], true)}
                        onSendPageComments={(text, images) => executeSend(text, permissionMode, images, [], true)}
                        linearActive={linear.active}
                        onStartFromIssue={surfaces.git ? startFromIssue : undefined}
                        onStop={run && selectedSession ? () => void agentRuns.interrupt(chatKey(project.path, selectedSession.id)) : undefined}
                        pullRequestAction={
                          selectedSession && pullRequestBlockerAction && pullRequestActionRequest
                            ? {
                                label: BLOCKERS[pullRequestBlockerAction.blocker].action,
                                tone: BLOCKERS[pullRequestBlockerAction.blocker].tone,
                                onRun: () => {
                                  dismissBlockerAction(pullRequestBlockerAction.pr, pullRequestBlockerAction.blocker);
                                  void executeSend(pullRequestActionBody(pullRequestActionRequest), permissionMode, [], [], true, pullRequestActionRequest);
                                },
                              }
                            : selectedSession && branchPr?.state === "OPEN" && branchPr.readyToMerge && !prShown
                              ? // Nothing blocks the Chat's PR: the pill opens its panel, where it merges.
                                { label: `Merge #${branchPr.number}`, tone: "green", onRun: changes.showPullRequest }
                              : undefined
                        }
                        pullRequestReview={
                          showGit && selectedSession && prOpenThreads && !prShown ? { count: prOpenThreads, onOpen: changes.showPullRequest } : undefined
                        }
                        isSending={isSending}
                        readOnlyHistory={!!selectedSession?.readOnlyReason}
                        sendBlocked={preparingHere || Boolean(selectedSession?.formerWorktree || selectedSession?.readOnlyReason)}
                        offlineName={readOnly ? (openComputer?.name ?? "That computer") : null}
                        offlineTray={
                          offlineTray.shown && project ? (
                            <OfflineTray
                              owner={project.path}
                              sessionId={selectedSession?.id ?? null}
                              computerName={openComputer?.name ?? "That computer"}
                              offline={readOnly}
                              chip={Boolean(selectedSession)}
                              detail={awayBanner ?? undefined}
                            />
                          ) : undefined
                        }
                        reconnectingName={reconnecting ? (openComputer?.name ?? "That computer") : null}
                        runStartedAt={run?.startedAt ?? (pendingHere ? pendingSend?.startedAt : undefined)}
                        statusLabel={pendingHere && pendingSend && !run ? sendStatusLabel(pendingSend) : undefined}
                        streamingKey={run && project && selectedSession ? chatKey(project.path, selectedSession.id) : undefined}
                        subagents={subagents}
                        backgroundTasks={selectedSession?.backgroundTasks}
                        onArchiveFinishedSubagents={archiveFinishedChildren}
                        onArchiveSubagent={archiveChild}
                        onStopAdvisor={(id) => controlAdvisor("stop", id)}
                        onRetryAdvisor={(id) => controlAdvisor("retry", id)}
                        waitingForSubagents={run?.waitingForSubagents}
                        activity={selectedSession ? chatActivity(selectedSession, run) : undefined}
                        plan={selectedSession?.plan}
                        contextUsage={run?.contextUsage ?? selectedSession?.contextUsage}
                        suggestion={selectedSession?.provider === "claude" ? selectedSession.suggestion?.text : undefined}
                        ports={project && selectedSession ? agentPorts[chatKey(project.path, selectedSession.id)] : undefined}
                        agentChatId={project && selectedSession ? chatKey(project.path, selectedSession.id) : undefined}
                        onOpenPullRequestLink={(url) => {
                          const pr = associatedPullRequest(url, selectedPullRequests);
                          if (!pr || !prChatKey) return false;
                          setPrPick({ chat: prChatKey, number: pr.number });
                          changes.showPullRequest();
                          return true;
                        }}
                        onOpenDiff={(path) => {
                          if (!changes.open) changes.toggle();
                          changes.openFile(path);
                        }}
                        onStopPort={
                          project && selectedSession
                            ? (pid) => bridgeForKey(project.path).stopAgentPort(chatKey(project.path, selectedSession.id), pid)
                            : undefined
                        }
                        waitingStepIds={waitingStepIds}
                        asking={Boolean(run?.questions.length)}
                        sessionProvider={selectedSession?.provider}
                        runModelName={run ? (models.find((model) => model.id === run.model)?.name ?? run.model) : undefined}
                        resume={
                          project && selectedSession?.resumeTurn
                            ? {
                                onContinue: () =>
                                  void bridgeForKey(project.path)
                                    .resumeChat(project.path, selectedSession.id)
                                    .catch((error) => setNotice(`Couldn't continue the chat: ${error instanceof Error ? error.message : String(error)}`)),
                              }
                            : undefined
                        }
                        queue={
                          project && selectedSession
                            ? queueControls(bridgeForKey(project.path), chatKey(project.path, selectedSession.id), selectedSession, Boolean(run), setNotice)
                            : undefined
                        }
                        onOpenLinkedChat={openAlone}
                        onOpenAccounts={openAccounts}
                        models={models}
                        cliStatus={cliStatus}
                        onModelPickerOpen={refreshCliStatus}
                        onUpdateCli={handleUpdateCli}
                        updatingCli={updatingCli}
                        selectedModel={selectedModel}
                        onModelChange={chooseModel}
                        capability={selectedCapability}
                        effort={effortFor(selectedCapability, effort)}
                        onEffortChange={setEffort}
                        ultracode={selectedCapability.ultracode && ultracode}
                        onUltracodeChange={setUltracode}
                        fastMode={fastMode}
                        onFastModeChange={setFastMode}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        onRecommendationSelect={sendRecommendation}
                        newChatProject={{ key: project.path, name: project.name, kind: project.kind, onChange: moveNewChat, onLinkPick: newChatInLink }}
                        worktrees={composerWorktrees}
                        selectedWorktreeId={selectedWorktree?.id}
                        onWorktreeChange={(id) => {
                          advanceChatView();
                          setSelectedWorktreeId(id);
                          saveChatPreferences(localStorage, project.path, { worktreePath: state.worktrees[id]?.path });
                        }}
                        isolation={isolation}
                        noGit={noGit}
                        starters={
                          firstChat === project.path && displayedMessages.length === 0 && !isSending
                            ? firstChatStarters(surfaces.name).map((starter) => ({
                                ...starter,
                                onPick: () => {
                                  setFirstChat(null);
                                  void executeSend(starter.prompt, permissionMode, [], []);
                                },
                              }))
                            : undefined
                        }
                        onIsolationChange={(next) => {
                          preparedTarget.current = null;
                          setIsolation(next);
                          saveChatPreferences(localStorage, project.path, { isolation: next });
                          setNewChatError(null);
                        }}
                        branches={branches}
                        baseBranch={effectiveBaseBranch}
                        onBaseBranchChange={(branch) => {
                          preparedTarget.current = null;
                          setBaseBranch(branch);
                          setBaseOverride(branch);
                          saveChatPreferences(localStorage, project.path, { baseBranch: branch });
                        }}
                        newChatError={newChatError}
                        composerNote={
                          selectedSession?.readOnlyReason ??
                          (selectedSession?.formerWorktree
                            ? RUN_WORKTREE_REMOVED_NOTE
                            : runPaneOpen && selectedSession?.routine?.hidden
                              ? RUN_CHAT_REPLY_NOTE
                              : undefined)
                        }
                        findOpen={findOpen}
                        findSignal={findSignal}
                        findSeed={findSeed}
                        onFindClose={() => setFindOpen(false)}
                        saveNotice={dockSaveNotice}
                        notice={notice}
                        onDismissNotice={() => setNotice(null)}
                        approvalHidden={questionSent && !pendingApproval && !remoteDelegations.length}
                        approval={approvalShown(approvalProps) ? <ChatApproval {...approvalProps} /> : undefined}
                      />
                    </EditorLinks>
                  </ChatGrid>
                  <GridDropOverlay />
                  <TerminalPanel chatId={terminalChatId} notify={setNotice} />
                </div>
              </div>
            </main>
            <ProjectChangesPanel
              changes={changes}
              prReview={prReview}
              localChanges={localChanges}
              commentCounts={diffComments.counts}
              prNumber={prNumber}
              prChoices={rowPullRequests(selectedPullRequests)}
              onPickPr={(number) => prChatKey && setPrPick({ chat: prChatKey, number })}
              source={selectedWorktree ? { bridge: bridgeForKey(prChatKey).pr, cwd: selectedWorktree.path } : undefined}
              actions={prPanelActions}
            />
            <DetailsPanelHost
              chatKey={
                view === "chat" && !selectedLink && project && selectedSession && selectedSession.id > 0 ? chatKey(project.path, selectedSession.id) : null
              }
              project={project ? { name: project.name, path: project.path } : undefined}
              worktree={selectedWorktree ? { name: selectedWorktree.name, path: selectedWorktree.path } : undefined}
              remoteComputer={openComputer ? { name: openComputer.name, offline: isDimmed(openComputer) } : undefined}
              family={state ? { sessions: state.sessions, work: linkedWork } : undefined}
              backgroundTasks={selectedSession?.backgroundTasks}
              ports={project && selectedSession ? agentPorts[chatKey(project.path, selectedSession.id)] : undefined}
              subagents={subagents}
              pullRequest={
                changesAvailable && prNumber
                  ? { number: prNumber, state: prStateWord(selectedPullRequests.find((pr) => pr.number === prNumber)), onOpen: changes.showPullRequest }
                  : undefined
              }
              onOpenChat={openAlone}
              onReveal={() => selectedSession && revealChat(selectedSession.id, openProjectPath())}
              chats={chats}
              chatActions={chatActions}
            />
          </div>
          {linkDialog}
          {appDialogs}
          {commandPaletteOpen && (
            <ProjectPalette
              commands={paletteCommands(project)}
              chats={chats}
              messages={lean ? null : (sidebarState?.messages ?? NO_MESSAGES)}
              searchChats={lean ? (query) => bridgeForKey(project.path).searchChats(project.path, query) : null}
              openMessage={openMessage}
              onStartChat={(query) => startNewChatOnThisMac(query)}
              onClose={() => setCommandPaletteOpen(false)}
              onError={setNotice}
            />
          )}
          {gitDialog && (
            <GitActionsDialog
              key={gitDialog.sessionId}
              cwd={gitDialog.cwd}
              base={gitDialog.base}
              provider={gitDialog.provider}
              chat={gitDialog.chat}
              turnRunning={Boolean(runStatuses[chatKey(project.path, gitDialog.sessionId)])}
              onClose={() => setGitDialog(null)}
              onSendToAgent={(text) => {
                if (selectedSession?.id === gitDialog.sessionId) void executeSend(text, permissionMode, []);
                else {
                  openChat(gitDialog.sessionId);
                  setDraft(text);
                }
              }}
              onRan={(note) => {
                recordGitNote(gitDialog.sessionId, note);
                void bridgeForKey(project.path)
                  .refreshDiffs(project.path, [gitDialog.worktreeId])
                  .catch(() => {});
              }}
            />
          )}
          <Notice />
        </DotBackground>
        {splashOverlay(true)}
        {quitError && <QuitErrorDialog error={quitError} setError={setQuitError} />}
      </ScopeContext.Provider>
    </BridgeContext.Provider>
  );
  return (
    <AgentRunsContext.Provider value={agentRuns.store}>
      <WorkspaceSlots
        shown={selectedLink ? "link" : "project"}
        slots={[...(linkWorkspace ? [{ key: "link", element: linkWorkspace }] : []), { key: "project", element: projectWorkspace }]}
      />
      {selectedLink && linkDialogs}
      {settingsModal}
    </AgentRunsContext.Provider>
  );
}

type IssueRef = Pick<LinearIssue, "key" | "workspace">;
export default function AppWithUpdates() {
  return (
    <UpdateShell>
      <App />
      <ComputerAllowPrompt />
    </UpdateShell>
  );
}
