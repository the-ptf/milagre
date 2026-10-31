import { outbox, outboxAttachments, queueForComputer, hasQueuedChat, startOutbox } from "./lib/outbox";
import { OfflineTray, useOfflineTray } from "./components/OfflineTray";
import { preferenceStorage as localStorage } from "./lib/preference-storage.ts";
import { chatMentionChoices } from "@milagre/shared/prompt-mentions";
import { prepareImageUploads, prepareLocalFileUploads } from "./lib/attachment-uploads";
import { ProviderUpdateNotice } from "./components/ProviderUpdateNotice";
import { PersistenceNotices, SaveFailure, type UnsavedScope } from "./components/PersistenceNotice";
import { UpdateShell, useAppUpdates } from "./components/UpdateNotice";
import { ComputerAllowPrompt } from "./components/ComputerAllowPrompt";
import { LinkWorkspace } from "./components/LinkWorkspace";
import { AddComputerDialog } from "./components/AddComputerDialog";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { LinkProjectDialog } from "./components/LinkProjectDialog";
import { createScopeDrafts } from "./lib/link-scope";
import type { LinkState, NamedProjectLink, OpenLink } from "@milagre/shared/model";
import { scopeKey, isLinkScopeKey, scopeFromKey, LOCAL_COMPUTER, computerOfKey, qualifyKey } from "@milagre/shared/chat-scopes";
import { isChatsHomeProject, type ChatsHome } from "@milagre/shared/chats-home";
import { projectSurfaces } from "./lib/project-surfaces";
import { BridgeContext, ScopeContext, bridgeFor, bridgeForKey, forgetBridge, isRemoteKey, onAnyAgentEvent } from "./lib/computer-bridge";
import type { WorktreeRename } from "@milagre/shared/project-edits";
import { reconcileState } from "@milagre/shared/reconcile";
import { applyAgentEvent } from "@milagre/shared/agent-runs";
import { attentionLabel, chatsNeedingAttention, waitingFor } from "@milagre/shared/attention";
import { reportChatAction } from "./lib/chat-action";
import { confirmHeldState, isLean, numberedState, seedHeldState, stateEvents } from "./lib/state-events";
import { chatSummary } from "@milagre/shared/chat-summary";
import { ipcErrorMessage } from "@milagre/shared/result";
import { cliName } from "@milagre/shared/providers";
import { Activity, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type SetStateAction } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  ChatMessage,
  ImageAttachment,
  AgentSession,
  CoordinatorState,
  Isolation,
  MODEL_CATALOG,
  ModelOption,
  ModelProvider,
  OpenProject,
  PermissionDecision,
  QuestionAnswers,
  PermissionMode,
  PullRequestActionContext,
  AgentCliStatus,
  AgentModels,
  capabilityFor,
  effortFor,
  sessionForWorktree,
  sortedWorktrees,
} from "./model";
import { useAgentRuns } from "./components/useAgentRuns";
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
import { capabilitiesFrom, keepIfSame, mergeModels, nextSelection, providerForId, resolveModel } from "./lib/models";
import { chatMark, chatTitle, isChatListed, orderChats } from "./lib/chat-list";
import type { SessionPatch } from "@milagre/shared/project-edits";
import { patchChatShowingDone } from "./lib/done-pending.ts";
import { deleteUndoWindow, isMilagreWorktree, undoDelete, worktreeShared } from "./lib/archive";
import { archiveChat as runArchive } from "./lib/archive-flow";
import type { ArchiveMode, ArchivePlan } from "./lib/archive";
import { ChangesPanel, firstSection } from "./components/changes/ChangesPanel";
import { chatJumpIndex, setKeyContext, shortcutCommand } from "./lib/keybindings";
import { PanelToggles, sidePanelCount, useSidePanels } from "./components/agents/PanelToggles";
import { ChangesPanelSlot } from "./components/changes/ChangesPanelSlot";
import { AttentionButton, DiffBar, LayoutToggle, SubchatsButton } from "./components/changes/ChangesChrome";
import { AnimatePresence } from "motion/react";
import { useDiffComments } from "./components/changes/useDiffComments";
import { formatCommentsMessage } from "./lib/diff-comments";
import { DiffToolbar, useDiffPreferences, useDiffPresence } from "./components/changes/DiffPrefs";
import { useChanges } from "./components/changes/useChanges";
import { useLocalChanges, usePullRequest } from "./components/changes/usePullRequest";
import { PullRequestPanelBody, type PullRequestPanelActions } from "./components/changes/PullRequestPanel";
import type { ThreadActions } from "./components/changes/PullRequestReview";
import type { PrDiffReview } from "./components/changes/DiffView";
import { PullRequestOpenContext } from "./components/sidebar/ChatRow";
import { prRange, threadFixMessage } from "./lib/pull-request-view";
import type { DiffSelection } from "./lib/diff-comments";
import { openThreads, type PullRequestThread, type ReviewEvent } from "@milagre/shared/pull-request-review";
import { gitChatContext, type GitChatContext } from "./lib/git-dialog";
import { useWorktreePullRequests } from "./components/useWorktreePullRequests";
import { useLinear } from "./components/useLinear";
import { useWorktreeLinearIssues } from "./components/useWorktreeLinearIssues";
import { issueFirstMessage, LINK_PR_HINT, restoredDraft, type LinearIssue } from "@milagre/shared/linear";
import { linearIssueContext, linearIssueRequest } from "@milagre/shared/linear-issue";
import { chatPullRequests, pullRequestRefsCache } from "./lib/chat-pull-requests";
import { associatedPullRequest } from "@milagre/shared/chats";
import { usePastedImages } from "./components/usePastedImages";
import { DotBackground } from "./components/DotBackground";
import { StartupSplash } from "./components/StartupSplash";
import SidebarNav, { knownLink } from "./components/SidebarNav";
import { cachedProjectCopy, cachedScopeState, rememberProjectCopy, runKeys, seedScopeState, useScopeStates } from "./lib/sidebar-scopes";
import { activeChatKeys, draftTileKey, gridChats, isDraftTileKey, readChatLayout, saveChatLayout, splitChats, type ChatLayout } from "./lib/chat-grid";
import { chatOnScreen, keepsRoutinesView, readsOnPick, runPaneRestore, type RunPaneReturn } from "./lib/run-pane";
import { ChatGrid, GridDropOverlay } from "./components/ChatGrid";
import { dropSide, gridDrop, placeDropped, readGridPins, readSplitChats, saveGridPins, saveSplitChats, type GridDropTarget } from "./lib/grid-drop";
import { chatRevealPath } from "./lib/reveal";
import type { SettingsSection } from "./components/Settings";
import { createPendingChat, createResendMemory, pendingChatSessionId, withPendingChat, withPreview, type PendingChat } from "@milagre/shared/chats";
import { sendStatusLabel } from "@milagre/shared/tool-activity";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import { getSettings, toggleTheme, updateSettings, useApplyTheme, useSettings } from "./lib/settings";
import { EditorLinks, Notice } from "./components/editor-links";
// Notice above is editor-links' toast; this is the dismissable notice card.
import { clearNoticeOnNavigate, showNotice } from "./lib/notice";
import { RELOAD_HINT } from "@milagre/shared/chat-reload";
import { Notice as NoticeCard } from "./components/Notice";
import { openInEditor } from "./lib/editors";
import type { ProjectRead, RuntimeConnection, StateStamp } from "./electron";
import { SidebarUsage } from "./components/usage/SidebarUsage";
import { visibleProviders } from "./components/usage/format";
import { useUsage } from "./components/usage/useUsage";
import { loadChatPreferences, saveChatPreferences } from "./lib/chat-preferences";
import { useComposerPreferences } from "./lib/use-composer-preferences";
import { noteComputer, startOfflineCache } from "./lib/offline-cache";
import { useDisplayNow } from "./lib/display-clock";
import { computerTone, isDimmed, isReadOnly, offlineBanner, useApplyOtherComputers, useComputers } from "./lib/computers";
import { OfflineEmpty } from "./components/OfflineEmpty";
import { settingsCommands } from "./lib/settings-commands";
import type { Command } from "./lib/commands";
import { messageCommands, messageCommandsFrom } from "./lib/message-commands";
import { noteScopeOpening, prefetchChatMessages, useChatMessages } from "./lib/chat-messages";
import { beginChatSwitch } from "./lib/chat-switch-timing";
import { newChatProject, PROJECT_REMOVED, RECENT_PROJECTS_CHANGED, type RecentProject } from "./lib/project-list";
import { useHiddenProjects } from "./lib/hidden-projects";
import { useProjectImages } from "./lib/project-images";
import { isModalOpen } from "./lib/modal";
import { createDraftStore, draftKey } from "./lib/draft-store";
import { restoredChatsNotice } from "./lib/restored-chats";
import { lazyView } from "./lib/lazy-view";
import { MediaLightbox } from "./components/motion/LazyMediaLightbox";
import { chatFamily, OpenSubchatContext } from "./lib/subchat-rows";
import { reuseRows, useEvent, useStableSet } from "./lib/stable";
import { canOpenRunChat, unreadRunChats, unreadRunChatsOf, unreadRunRoutines } from "@milagre/shared/routines";
import { RoutineChip } from "./components/routines/RoutineChip";
import { RUN_CHAT_REPLY_NOTE, RunChatHeader } from "./components/routines/RunChatHeader";
import { delegatedChats, useLinkedWork } from "./lib/linked-work";
import { remoteDelegationsFrom } from "./lib/remote-delegation";
import { RemoteDelegationCard } from "./components/agents/RemoteDelegationCard";
import { DraftChatComposer } from "./components/DraftChatComposer";
import { queueControls } from "./components/QueuedMessages";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { Onboarding, firstChatStarters } from "./components/Onboarding";
import { busyTerminals, newTerminal, useTerminalSync } from "./lib/terminal-actions";
import { playNotificationChime } from "./lib/notification-chime";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import type { ChatRowActions, SidebarRecent } from "./components/sidebar/ChatRow";
import { shouldNotifyCompletion, useBots } from "./lib/bots-store";
import type { SidebarMode } from "./components/bots/SidebarModeSwitch";
import { BotThread } from "./components/bots/BotThread";
import { BotProfilePanel } from "./components/bots/BotProfilePanel";
import { BotProfileSlot } from "./components/bots/BotProfileSlot";

const SIDEBAR_MODE_KEY = "milagre.sidebarMode";

// Not on screen at first paint, so each loads as its own chunk; the effect in App fetches them once the window is idle.
const DiffView = lazyView(() => import("./components/changes/DiffView").then((module) => module.DiffView));
const GitActionsDialog = lazyView(() => import("./components/GitActionsDialog").then((module) => module.GitActionsDialog));
const SettingsNav = lazyView(() => import("./components/Settings").then((module) => module.SettingsNav));
const SettingsPanel = lazyView(() => import("./components/Settings").then((module) => module.SettingsPanel));
const CommandPalette = lazyView(() => import("./components/CommandPalette").then((module) => module.CommandPalette));
const PermissionCard = lazyView(() => import("./components/agents/PermissionCard").then((module) => module.PermissionCard));
const QuestionCard = lazyView(() => import("./components/agents/QuestionCard").then((module) => module.QuestionCard));
const CanvasView = lazyView(() => import("./components/CanvasView").then((module) => module.CanvasView));
const RoutinesPage = lazyView(() => import("./components/routines/RoutinesPage").then((module) => module.RoutinesPage));
const LAZY_VIEWS = [DiffView, GitActionsDialog, SettingsNav, CommandPalette, MediaLightbox, PermissionCard, QuestionCard];

// The chat with the most recent message, or none so the app opens on a new chat. Archived chats don't count.
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

// How long a scope's model lists and CLI status, and its branches, count as current: a switch back within it reads none again.
const PROVIDERS_FRESH_MS = 60_000;
const BRANCHES_FRESH_MS = 60_000;
const NO_MESSAGES: ChatMessage[] = [];
const NO_BRANCHES: string[] = [];
// Each Project's branches as last read, and when: opening it again shows them at once, and reads them again (git on its
// computer) in the background only once they are older than BRANCHES_FRESH_MS.
const branchLists = new Map<string, { at: number; branches: string[] }>();

/** Starts reading Chat `sessionId`'s page now, unless `state` (the scope's, as held) comes from a host that doesn't keep
 * messages by Chat. A scope not held yet (another computer's Project never opened here) reads too: every current host
 * keeps them by Chat, and waiting for its open first is what left such a Chat on its loading state. */
function prefetchLeanChat(scope: string, sessionId: number, state: CoordinatorState | LinkState | null | undefined) {
  if (!state || isLean(state)) prefetchChatMessages(scope, sessionId);
}
const NO_REFS: string[] = [];
const NO_KEYS: string[] = [];
const NO_ROUTINES = new Set<string>();
// `sent`: the main process saved the message; the preview stays until the saved message reaches the window's state.
// `creatingWorktree`: the send waits for its new Worktree; `provider`: the one the picker sent it to.
type PendingSend = PendingChat & {
  view: number;
  projectPath: string;
  originSessionId: number | null;
  originWorktreeId: number;
  sent?: boolean;
  creatingWorktree?: boolean;
  provider?: ModelProvider;
};
const NO_WORKTREE = -1;
// The model picked in each open chat, by chat key.
const CHAT_MODELS_KEY = "milagre.chatModels";
function readChatModels(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHAT_MODELS_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, string>) : {};
  } catch {
    return {};
  }
}
type PreparedSendTarget = { view: number; projectPath: string; sessionId: number | null; worktreeId: number };
type FailedSend = PendingSend & { draft: string; error: string; target: PreparedSendTarget | null };

function App() {
  const [project, setProject] = useState<OpenProject | null>(null);
  const projectRef = useRef<OpenProject | null>(null);
  const projectsSeen = useRef(new Map<string, Pick<OpenProject, "path" | "name">>());
  const projectNavigation = useRef(0);
  projectRef.current = project;
  // The latest state of every project the main process has sent this window; it's their only writer
  // (see ADR-0001). The ref leads, so callbacks read a state that arrived since the last render.
  const [selectedLink, setSelectedLink] = useState<OpenLink | null>(null);
  // The Link shown last stays mounted behind the Project (an <Activity>), so going back to it is a style change.
  const [lastLink, setLastLink] = useState<OpenLink | null>(null);
  // Counts the requests to show a Link's Chat, so asking for the same Chat again shows it again.
  const [linkOpenNonce, setLinkOpenNonce] = useState(0);
  // Each Link as the host last opened it, so opening it again shows at once while the host answers.
  const linksSeen = useRef(new Map<string, OpenLink>());
  const selectedLinkRef = useRef(selectedLink);
  selectedLinkRef.current = selectedLink;
  const [linkInitialSession, setLinkInitialSession] = useState<number | undefined>();
  // `true` creates a Link; a Link edits that one.
  const [linkDialogOpen, setLinkDialogOpen] = useState<boolean | NamedProjectLink>(false);
  // oxlint-disable-next-line react/use-memo -- useMemo is given a factory function reference so the instance is created once
  const scopeDrafts = useMemo(createScopeDrafts, []);
  const [linkStates, setLinkStates] = useState<Record<string, LinkState>>({});
  const linkStatesRef = useRef(linkStates);
  linkStatesRef.current = linkStates;
  const [states, setStates] = useState<Record<string, CoordinatorState>>({});
  const statesRef = useRef(states);
  const state = project ? (states[project.path] ?? null) : null;
  /** The open project's latest state. */
  const openState = () => (projectRef.current ? statesRef.current[projectRef.current.path] : undefined);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<number | null>(null);
  const [selectedSessionId, setSelectedSessionState] = useState<number | null>(null);
  const selectedSessionRef = useRef<number | null>(null);
  selectedSessionRef.current = selectedSessionId;
  // The draft lives outside React state: a keystroke re-renders the composer (DraftChatComposer), not the whole app.
  // oxlint-disable-next-line react/use-memo -- useMemo is given a factory function reference so the instance is created once
  const draftStore = useMemo(createDraftStore, []);
  const setDraft = draftStore.set;
  // Each Chat, and each project's new-chat screen, keeps its own draft. The store switches with the selection, before
  // the render, so a draft written right after picking a Chat lands in that Chat.
  function setSelectedSessionId(next: SetStateAction<number | null>) {
    const value = typeof next === "function" ? next(selectedSessionRef.current) : next;
    selectedSessionRef.current = value;
    draftStore.select(draftKey(projectRef.current?.path ?? "", value));
    setSelectedSessionState(value);
  }
  // Catches a project change that did not go through the setter above.
  useLayoutEffect(() => draftStore.select(draftKey(project?.path ?? "", selectedSessionId)), [project?.path, selectedSessionId]);
  const [selectedModel, setSelectedModel] = useState<ModelOption>(() =>
    resolveModel(MODEL_CATALOG, getSettings().defaultModelId, providerForId(getSettings().defaultModelId)),
  );
  const accountScope = selectedLink ? `milagre-link:${selectedLink.link.id}` : project?.path;
  // A Chats home's account is shared by every Chat without a Project on its computer; the usage card says so.
  const accountScopeIsHome = !selectedLink && isChatsHomeProject(project);
  const currentChatKey = draftKey(accountScope ?? "", selectedSessionId);
  const composerPrefs = useComposerPreferences(currentChatKey);
  const effort = composerPrefs.effort;
  const setEffort = composerPrefs.setEffort;
  const ultracode = composerPrefs.ultracode;
  const setUltracode = composerPrefs.setUltracode;
  const fastMode = composerPrefs.fastMode;
  const setFastMode = composerPrefs.setFastMode;
  // The agents' own model lists; the maintained list stands in until they arrive, and for a missing CLI.
  const accountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;
  const accountGeneration = useRef(0);
  const [loadedAccountScope, setLoadedAccountScope] = useState<string | undefined>(undefined);
  const [rawReported, setReported] = useState<AgentModels | null>(null);
  const reported = loadedAccountScope === accountScope ? rawReported : null;
  const models = useMemo(() => mergeModels(reported, MODEL_CATALOG), [reported]);
  // Whether each agent's CLI is missing, outdated, broken or logged out, for the model picker. Loaded at
  // startup and again each time the picker opens, so a fix shows without a restart.
  const [rawCliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);
  // The model lists come along: the main process keeps a good list for the run but asks again for an agent
  // that had none (a CLI that was missing, or Claude Code before it was logged in).
  const cliStatus = loadedAccountScope === accountScope ? rawCliStatus : null;
  const refreshCliStatus = () => {
    const generation = ++accountGeneration.current;
    const live = () => generation === accountGeneration.current && accountScopeRef.current === accountScope;
    // A refetch that changed nothing keeps the old objects, so opening the picker doesn't re-render the app or
    // re-apply anything that depends on the lists.
    void bridgeForKey(accountScope)
      .getCliStatus(accountScope)
      .then((next) => {
        if (live()) {
          setLoadedAccountScope(accountScope);
          setCliStatus((previous) => keepIfSame(previous, next));
          if (accountScope)
            providerCache.current.set(accountScope, {
              ...(providerCache.current.get(accountScope) ?? { reported: null }),
              cliStatus: next,
              cliStatusAt: Date.now(),
            });
        }
      })
      .catch(() => undefined);
    void bridgeForKey(accountScope)
      .getModels(accountScope)
      .then((next) => {
        if (live()) {
          setLoadedAccountScope(accountScope);
          setReported((previous) => keepIfSame(previous, next));
          if (accountScope)
            providerCache.current.set(accountScope, {
              ...(providerCache.current.get(accountScope) ?? { cliStatus: null }),
              reported: next,
              reportedAt: Date.now(),
            });
        }
      })
      .catch(() => undefined);
  };
  // Each Project's or Link's last model lists and CLI status, with when each was read: switching back shows them at once,
  // and reads them again (a provider CLI on the scope's computer) only once they are older than PROVIDERS_FRESH_MS. The
  // picker's open, a CLI update and an accounts change read them at once.
  const providerCache = useRef(
    new Map<string, { reported: AgentModels | null; cliStatus: AgentCliStatus | null; reportedAt?: number; cliStatusAt?: number }>(),
  );
  // A CLI updated, or a sign-in that failed, changes the status every scope shows: each reads it again when next shown.
  const staleProviders = () => {
    for (const [scope, entry] of providerCache.current) providerCache.current.set(scope, { reported: entry.reported, cliStatus: entry.cliStatus });
  };
  useEffect(() => {
    const reset = (dropCache: boolean) => {
      if (dropCache) providerCache.current.clear();
      const hit = accountScope ? providerCache.current.get(accountScope) : undefined;
      setReported(hit?.reported ?? null);
      setCliStatus(hit?.cliStatus ?? null);
      if (hit) setLoadedAccountScope(accountScope);
      const fresh = (at: number | undefined) => at !== undefined && Date.now() - at < PROVIDERS_FRESH_MS;
      if (!hit || !fresh(hit.reportedAt) || !fresh(hit.cliStatusAt)) refreshCliStatus();
    };
    reset(false);
    const off = window.milagre.onAccountsChanged?.(() => reset(true));
    return () => {
      accountGeneration.current++;
      off?.();
    };
  }, [accountScope]);
  const capabilities = useMemo(() => capabilitiesFrom(reported), [reported]);
  // The Settings default applies once, when the agents' lists first arrive, if the user hasn't picked a model
  // and the open chat isn't on the other agent. After that a model the agents don't offer only gives way to
  // its provider's recommended model (see nextSelection).
  const pickedModel = useRef(false);
  const appliedDefault = useRef(false);
  const preferredProviderRef = useRef<ModelProvider | undefined>(undefined);
  useEffect(() => {
    const applyDefault = reported !== null && !appliedDefault.current && !pickedModel.current;
    if (reported !== null) appliedDefault.current = true;
    setSelectedModel((current) =>
      nextSelection(models, current, { defaultId: getSettings().defaultModelId, applyDefault, preferredProvider: preferredProviderRef.current }),
    );
  }, [models]);
  // A pick in an open chat stays with that chat (a Link's composer names its chat); on a new-chat screen it becomes the default.
  const chatModels = useRef<Record<string, string>>(readChatModels());
  const chooseModel = (model: ModelOption, linkChat?: string | null) => {
    pickedModel.current = true;
    setSelectedModel(model);
    const sessionId = selectedSessionRef.current;
    const chat = selectedLinkRef.current ? linkChat : sessionId !== null && projectRef.current ? chatKey(projectRef.current.path, sessionId) : null;
    if (!chat) {
      updateSettings({ defaultModelId: model.id });
      return;
    }
    chatModels.current = { ...chatModels.current, [chat]: model.id };
    localStorage.setItem(CHAT_MODELS_KEY, JSON.stringify(chatModels.current));
  };
  const selectedCapability = capabilityFor(selectedModel, capabilities);
  const [view, setView] = useState<"chat" | "canvas" | "settings" | "routines">("chat");
  const viewRef = useRef(view);
  viewRef.current = view;
  const bots = useBots();
  const botsRef = useRef(bots.snapshot);
  botsRef.current = bots.snapshot;
  // Projects | Bots in the sidebar. Bots off (Settings › Experimental), the sidebar is back on Projects.
  const [storedSidebarMode, setStoredSidebarMode] = useState<SidebarMode>(() => (localStorage.getItem(SIDEBAR_MODE_KEY) === "bots" ? "bots" : "projects"));
  const sidebarMode: SidebarMode = bots.enabled ? storedSidebarMode : "projects";
  const storedSidebarModeRef = useRef(storedSidebarMode);
  storedSidebarModeRef.current = storedSidebarMode;
  // Bots shows the bot thread, from Routines, the canvas or Settings too.
  const setSidebarMode = useEvent((mode: SidebarMode) => {
    if (mode === "bots") {
      changes.closeDiff();
      setView("chat");
    }
    setStoredSidebarMode(mode);
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
  });
  // Opening a Project's Chat or a Link any other way (a notification, ⌘N, the palette, a Routine's Run, a Link) shows it,
  // not the bot thread over it. Read from a ref: listeners registered renders ago call this too.
  const leaveBots = () => {
    if (storedSidebarModeRef.current === "bots") setSidebarMode("projects");
  };
  // Only a successful read that says Bots are off resets the sidebar: a daemon still starting keeps it on Bots.
  useEffect(() => {
    if (bots.ready && !bots.error && !bots.enabled && storedSidebarMode === "bots") setSidebarMode("projects");
  }, [bots.ready, bots.error, bots.enabled, storedSidebarMode]);
  const [pickedBotId, setSelectedBotId] = useState<string | null>(null);
  // The bot picked last, or the first one while that one is gone.
  const selectedBotId = bots.snapshot?.bots.some((bot) => bot.id === pickedBotId) ? pickedBotId : (bots.snapshot?.bots[0]?.id ?? null);
  const selectedBot = bots.snapshot?.bots.find((bot) => bot.id === selectedBotId);
  const pickBot = useEvent((id: string) => {
    setSelectedBotId(id);
    setView("chat");
  });
  const botsShown = view === "chat" && sidebarMode === "bots";
  const [botProfileOpen, setBotProfileOpen] = useState(true);
  // "Open Chat" on a bot's card: back to Projects, in that Chat.
  const openChatKey = (key: string) => {
    setSidebarMode("projects");
    setView("chat");
    openChatByKey(key);
  };
  // The Routine whose page the Routines view shows, or null for the list.
  const [routineId, setRoutineId] = useState<string | null>(null);
  // The Run Chat open beside its Routine's page ("<path>#<id>"), or null.
  const [runPane, setRunPane] = useState<string | null>(null);
  // The Chat a Run row is opening beside its Routine's page, by chat key: opening it (in its own Project, or after switching
  // to another) keeps the Routines view instead of showing the Chat alone. Cleared once that opening settles.
  const holdRoutinesView = useRef<string | null>(null);
  // The window's Chat before a Run Chat took the Chat pane: closing the pane, or leaving the Routines view on it, goes back.
  const runPaneReturn = useRef<RunPaneReturn | null>(null);
  const runPaneRef = useRef<string | null>(null);
  runPaneRef.current = runPane;
  const [layout, setLayout] = useState<ChatLayout>(() => readChatLayout(localStorage));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => saveChatLayout(localStorage, layout), [layout]);
  const toggleLayout = () => setLayout((current) => (current === "grid" ? "single" : "grid"));
  const showGrid = () => setLayout("grid");
  // Chats kept in the grid while idle: dropped there from the sidebar, or pinned from a tile's header.
  const [gridPins, setGridPins] = useState<readonly string[]>(() => readGridPins(localStorage));
  const changeGridPins = (change: (pins: readonly string[]) => readonly string[]) =>
    setGridPins((current) => {
      const next = change(current);
      saveGridPins(localStorage, next);
      return next;
    });
  // The split view's Chats, in order: the open one and the ones dragged beside it from the sidebar.
  const [splitKeys, setSplitKeys] = useState<readonly string[]>(() => readSplitChats(localStorage));
  useEffect(() => saveSplitChats(localStorage, splitKeys), [splitKeys]);
  // The split tile being closed while focus moves to its neighbour: it leaves the split once focus has left it.
  const [closingTile, setClosingTile] = useState<string | null>(null);
  // A subchat opening beside its parent (openBesideParent): the split waits for it instead of ending while it loads.
  const [splitTarget, setSplitTarget] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (!commandPaletteOpen) return;
    let cancelled = false;
    window.milagre
      .listRecentProjects()
      .then((projects) => {
        if (!cancelled) setRecentProjects(projects);
      })
      .catch(() => {
        if (!cancelled) setRecentProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [commandPaletteOpen]);
  const [pickedIsolation, setIsolation] = useState<Isolation>(() => loadChatPreferences(localStorage, "").isolation);
  // A Project outside Git has one Worktree, the folder itself: its Chats always work there. A Chat without a Project
  // always gets its own Worktree of the Chats home, a new empty folder.
  const noGit = project?.git === false;
  const isolation: Isolation = isChatsHomeProject(project) ? "worktree" : noGit ? "local" : pickedIsolation;
  const surfaces = projectSurfaces(project);
  // Git controls stay wherever they are today, a plain folder included (the places that need a repository check `noGit`
  // themselves); only a Chat without a Project, whose repository is internal, loses them.
  const showGit = !isChatsHomeProject(project) && (surfaces.git || noGit);
  // The open Project's branches, from the last read of them (branchLists); a read that changes them renders again.
  const [, setBranchesRead] = useState(0);
  const branches = (project ? branchLists.get(project.path)?.branches : undefined) ?? NO_BRANCHES;
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  // A short message about something that happened off to the side (a worktree that wouldn't go).
  const [quitError, setQuitError] = useState<string | null>(null);
  useEffect(() => window.milagre.onQuitFailed?.(setQuitError), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingCli, setUpdatingCli] = useState<ModelProvider | null>(null);

  const refreshCliStatusRef = useRef(refreshCliStatus);
  refreshCliStatusRef.current = refreshCliStatus;
  const updateCli = async (provider: ModelProvider) => {
    setUpdatingCli(provider);
    try {
      const result = await window.milagre.updateCli(provider);
      // Updating the CLI is global; read authentication and models for the scope open now, and for the others when shown.
      staleProviders();
      refreshCliStatusRef.current();
      if (result.ok) {
        setNotice(`${cliName(provider)} updated to version ${result.version ?? "latest"} successfully!`);
      } else {
        setNotice(result.error ?? `Failed to update ${cliName(provider)}.`);
      }
    } catch (error) {
      setNotice(`Error updating ${cliName(provider)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUpdatingCli(null);
    }
  };
  // Every finished message card gets this (an outdated CLI's reply shows an Update button), so it keeps one identity
  // across renders: a new function per keystroke or streamed batch would re-render the whole transcript (see sendRecommendation).
  const updateCliRef = useRef(updateCli);
  updateCliRef.current = updateCli;
  const handleUpdateCli = useCallback((provider: ModelProvider) => updateCliRef.current(provider), []);
  const handleProvidersUpdated = useCallback(() => {
    staleProviders();
    refreshCliStatusRef.current();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  // Which Project the Settings page shows; any recent Project can be picked there, the open one by default.
  const [settingsProject, setSettingsProject] = useState<{ path: string; name: string } | null>(null);
  // The Chats home is no Project to the user: it is never the Settings Project, and a leftover Project section falls back.
  const shownSettingsProject = settingsProject ?? (surfaces.settings ? (project ?? undefined) : undefined);
  const shownSettingsSection = settingsSection === "project" && !shownSettingsProject ? "general" : settingsSection;
  const [settingsComputer, setSettingsComputer] = useState<string | null>(null);
  const [addComputerOpen, setAddComputerOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // A send may finish after the user opens another Chat. Its feedback and completion belong to the view that sent it.
  const chatView = useRef(0);
  const nextChatView = useRef(0);
  const [, setChatView] = useState(0);
  function advanceChatView() {
    // A confirmation like "Chat archived" belongs to the screen it was said on.
    clearNoticeOnNavigate();
    chatView.current = ++nextChatView.current;
    setChatView(chatView.current);
  }
  const sendsInFlight = useRef(new Set<string>());
  // A new Chat's draft is on its way to another Project (moveNewChat): Enter waits for it to get there.
  const movingDraft = useRef(false);
  // The id of a send that failed before the host answered: it may have been saved, so the same text resent reuses it.
  const failedSendIds = useRef(createResendMemory());
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  // If persistence fails after setup, retry in the Worktree already prepared for this Chat.
  const preparedTarget = useRef<PreparedSendTarget | null>(null);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [restoringSend, setRestoringSend] = useState<FailedSend | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostConnection, setHostConnection] = useState<RuntimeConnection>({ connected: true });
  const [restartingHost, setRestartingHost] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  // The Project onboarding opened: its first, empty Chat offers starter tasks.
  const [firstChat, setFirstChat] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const update = useAppUpdates();
  const [gitDialog, setGitDialog] = useState<{
    sessionId: number;
    worktreeId: number;
    cwd: string;
    base?: string;
    provider?: ModelProvider;
    chat: GitChatContext;
  } | null>(null);
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
      // oxlint-disable-next-line react/immutability -- React Compiler heuristic: the ref or handler is assigned or called after render, not during it
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
  // The computer whose Project or Link is open was removed, or Other computers turned off: this Mac's Project comes back.
  const { computers: pairedComputers } = useComputers();
  // The Mac that was last told which chat is on screen (see the effect that sends it).
  const openChatComputer = useRef<string>(LOCAL_COMPUTER);
  const knownComputers = pairedComputers.map((computer) => computer.id).join("\n");
  useEffect(() => {
    const open = selectedLinkRef.current ? `milagre-link:${selectedLinkRef.current.link.id}` : projectRef.current?.path;
    if (!open || !isRemoteKey(open)) return;
    const computerId = computerOfKey(open);
    if (knownComputers.split("\n").includes(computerId)) return;
    forgetBridge(computerId);
    // Its bridge must not be recreated to tell it nothing is open: this Mac's Project is about to open.
    if (openChatComputer.current === computerId) openChatComputer.current = LOCAL_COMPUTER;
    void loadInitialProject();
  }, [knownComputers]);
  // The open Project's computer, when it is another Mac: read-only while it is away, with the banner then.
  const openComputer = project && isRemoteKey(project.path) ? pairedComputers.find((computer) => computer.id === computerOfKey(project.path)) : undefined;
  const readOnly = Boolean(project && isRemoteKey(project.path) && isReadOnly(openComputer));
  // A dropped socket or a LAN/relay switch reads Connecting or Reconnecting for a moment. That isn't read-only: the draft
  // stays writable, a send waits for the computer (computers.cjs invoke), and the placeholder says it is reconnecting.
  const reconnecting = Boolean(openComputer && computerTone(openComputer) === "connecting");
  const away = Boolean(openComputer && isDimmed(openComputer));
  const bannerNow = useDisplayNow(60_000, away);
  const awayBanner = openComputer && away ? offlineBanner(openComputer, bannerNow) : null;
  useEffect(() => stateEvents.onLinkState((update) => setLinkStates((previous) => ({ ...previous, [update.linkId]: update.state }))), []);

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
      // oxlint-disable-next-line react/immutability -- React Compiler heuristic: the ref or handler is assigned or called after render, not during it
      for (const next of snapshot.projects) receiveState(next.path, next.state);
      for (const next of snapshot.links ?? []) setLinkStates((previous) => ({ ...previous, [next.linkId]: next.state }));
    });
    // A computer's runtime sends a snapshot after each reconnect, with its open Projects' and Links' states (keys name it).
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

  // Every read of a Project's branches goes through here: the open Project's list renders again only when it changed.
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
    // Another computer's busy host (429) answers a later try; meanwhile a new Worktree starts from the checkout's branch.
    void retrySend(() => bridgeForKey(path).listBranches(path), {
      retryable: (error) => !cancelled && retryKind(error) !== null,
      budget: READ_RETRY_BUDGET,
    }).then(
      // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
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
  // Messages waiting on this Mac for the open Chat (or its New Chat), in the composer's tray while its computer is away.
  const offlineTray = useOfflineTray(project?.path, selectedSession?.id ?? null, readOnly);
  const subagents = useMemo(
    () => selectedSession?.subagents?.filter((agent) => agent.id !== selectedSession.native_session_id),
    // oxlint-disable-next-line react/preserve-manual-memoization -- the callback reads selectedSession.subagents and selectedSession.native_session_id, both listed; the compiler infers the whole selectedSession object from the property access
    [selectedSession?.subagents, selectedSession?.native_session_id],
  );
  const selectedWorktree = worktrees.find((worktree) => worktree.id === (selectedSession?.worktree_id ?? selectedWorktreeId)) ?? firstWorktree;
  // Assigning a new Chat its persisted id keeps attachments for the next message; navigating away clears them.
  const imageDraft = usePastedImages(`${project?.path ?? ""}:${chatView.current}`, project?.path, !!project && queueForComputer(project.path));
  useEffect(() => {
    if (!restoringSend) return;
    imageDraft.restore(restoringSend.message.images ?? [], restoringSend.message.files ?? []);
    setRestoringSend(null);
  }, [restoringSend]);
  // A host that keeps messages by Chat (chat-pages-v1) sends states without them: the open Chat reads its own.
  const lean = isLean(state);
  const chatWindow = useChatMessages(lean ? project?.path : null, selectedSession && selectedSession.id > 0 ? selectedSession.id : null);
  const messages = useMemo(
    () =>
      state && selectedSession ? (lean ? chatWindow.messages : state.messages.filter((message) => message.session_id === selectedSession.id)) : NO_MESSAGES,
    [state?.messages, selectedSession?.id, lean, chatWindow.messages],
  );
  const pendingSend = pendingSends.findLast(
    (send) =>
      send.projectPath === project?.path &&
      (send.view === chatView.current ||
        (selectedSession && (send.originSessionId === selectedSession.id || (state && pendingChatSessionId(state, send) === selectedSession.id)))),
  );
  const pendingHere = Boolean(pendingSend);
  const preparingHere = Boolean(pendingSend && !pendingSend.sent);
  const pendingCanonicalId = state && pendingSend?.projectPath === project?.path ? pendingChatSessionId(state, pendingSend) : null;
  const canonicalWindow = useChatMessages(lean && pendingCanonicalId !== null ? project?.path : null, pendingCanonicalId);
  const remoteCount = lean ? chatWindow.total - chatWindow.messages.length : 0;
  const earlierMessages = useMemo(
    () => (remoteCount > 0 ? { count: remoteCount, load: chatWindow.loadEarlier, loadAll: chatWindow.loadAll } : undefined),
    [remoteCount, chatWindow.loadEarlier, chatWindow.loadAll],
  );
  // A large Project's state can reach the window after the send's reply; dropping the preview then would hide the new chat until it does.
  useEffect(() => {
    setPendingSends((current) => {
      const next = current.filter((send) => {
        const latest = states[send.projectPath];
        return !send.sent || (latest && pendingChatSessionId(latest, send) === null);
      });
      return next.length === current.length ? current : next;
    });
  }, [pendingSends, states]);
  const sidebarState = useMemo(() => {
    if (!state) return state;
    const recovered = failedSends.filter((send) => send.projectPath === project?.path).reduce((current, send) => withPendingChat(current, send), state);
    return pendingSends.filter((send) => send.projectPath === project?.path).reduce((current, send) => withPendingChat(current, send), recovered);
  }, [state, pendingSends, failedSends, project?.path]);
  // The renderer's preview never enters project state. The main process still owns the persisted transcript.
  const loadedMessages = useMemo(
    () =>
      pendingHere && pendingSend
        ? pendingCanonicalId !== null
          ? lean
            ? canonicalWindow.messages
            : state!.messages.filter((message) => message.session_id === pendingCanonicalId)
          : withPreview(messages, pendingSend)
        : messages,
    // oxlint-disable-next-line react/preserve-manual-memoization -- the callback reads state!.messages (non-null assertion) and the list names state?.messages, the same value; the compiler infers state itself from the assertion
    [pendingHere, pendingSend, pendingCanonicalId, state?.messages, messages, lean, canonicalWindow.messages],
  );
  // The saved Chat's summary may reach us before its page. Preserve the visible input through that read.
  const transcriptKey = `${project?.path}|${chatView.current}`;
  const [transcript, setTranscript] = useState({ key: transcriptKey, messages: loadedMessages });
  const transcriptLoading = pendingHere && pendingCanonicalId !== null ? canonicalWindow.loading : chatWindow.loading;
  const displayedMessages = lean && transcriptLoading && !loadedMessages.length && transcript.key === transcriptKey ? transcript.messages : loadedMessages;
  if (transcript.key !== transcriptKey || transcript.messages !== displayedMessages) setTranscript({ key: transcriptKey, messages: displayedMessages });
  // A saved Chat with nothing to show yet because its page is still on its way: not a new Chat.
  const messagesLoading = lean && transcriptLoading && !displayedMessages.length && Boolean(selectedSession && selectedSession.id > 0);
  // How many messages the open Chat has: its summary's count while its window is still loading from the host.
  const chatCount = lean ? (selectedSession?.summary?.count ?? messages.length) : messages.length;
  preferredProviderRef.current = chatCount > 0 ? selectedSession?.provider : undefined;

  const agentRuns = useAgentRuns(receiveState, (chatId) => {
    const owner = projectOfKey(chatId);
    const latest = isLinkScopeKey(owner) ? linkStatesRef.current[owner.slice("milagre-link:".length)] : statesRef.current[owner];
    return latest ? lastUserModel(latest, sessionIdFromKey(chatId)) : "";
  });
  const { pullRequests, chatPullRequests: chatPrs, dismissedBlockers, dismissBlockerAction } = useWorktreePullRequests(project?.path ?? "", state);
  const linear = useLinear();
  const { issues: linearIssues, refresh: refreshLinearIssues } = useWorktreeLinearIssues(project?.path ?? "", linear.active);
  const sidePanels = useSidePanels();
  // The PR the open Chat's branch opened: the Changes panel's "PR #n" mode and its diff.
  const branchPr = showGit && selectedWorktree ? (pullRequests[selectedWorktree.path] ?? null) : null;
  const prChatKey = project && selectedSession ? chatKey(project.path, selectedSession.id) : null;
  const [prWanted, setPrWanted] = useState(false);
  // A PR picked in the panel's menu (or opened from a row's PR chip), over the branch's own, while its Chat is open.
  const [prPick, setPrPick] = useState<{ chat: string; number: number } | null>(null);
  // The PR the Chat's row shows first (its latest open PR), as the phone opens on; set below, where the row's PRs are read.
  const [rowPr, setRowPr] = useState<{ chat: string; number: number } | null>(null);
  const prNumber = prPick && prPick.chat === prChatKey ? prPick.number : rowPr && rowPr.chat === prChatKey ? rowPr.number : branchPr?.number;
  // Read while the panel shows it, and while its Chat is open so the composer's Review pill counts open threads.
  const prReview = usePullRequest({
    cwd: selectedWorktree?.path,
    number: prNumber,
    active: prWanted || (view === "chat" && Boolean(selectedSession && selectedWorktree && prNumber)),
    bridge: bridgeForKey(prChatKey),
  });
  const changes = useChanges({
    cwd: selectedWorktree?.path,
    base: selectedWorktree?.base,
    chatId: prChatKey,
    available: view === "chat" && showGit && Boolean(selectedSession && selectedWorktree),
    pullRequest: prNumber ? { number: prNumber, range: prRange(prReview.pr) } : undefined,
  });
  const prShown = changes.open && changes.mode === "pr";
  const localChanges = useLocalChanges({ cwd: selectedWorktree?.path, active: prShown, bridge: bridgeForKey(prChatKey) });
  useEffect(() => setPrWanted(prShown), [prShown]);
  const diffComments = useDiffComments(project && selectedSession ? chatKey(project.path, selectedSession.id) : null, changes);
  const diffPrefs = useDiffPreferences();
  const diffPresence = useDiffPresence(changes.diffOpen);
  const changesAvailable = view === "chat" && showGit && Boolean(selectedSession && selectedWorktree);
  const changesAvailableRef = useRef(false);
  changesAvailableRef.current = changesAvailable;
  // The open Chat's Terminals; a draft has none until it is sent.
  const terminalChatId = view === "chat" && project && selectedSession && !selectedSession.archived ? chatKey(project.path, selectedSession.id) : null;
  const terminalChatRef = useRef(terminalChatId);
  terminalChatRef.current = terminalChatId;
  useTerminalSync(terminalChatId);
  const run = project && selectedSession ? agentRuns.runs[chatKey(project.path, selectedSession.id)] : undefined;
  // A Chat another Chat started (MCP, Delegation) has no pick of its own: show the mode its turn runs in, not the default.
  const permissionMode = composerPrefs.pickedPermissionMode ?? run?.permissionMode ?? composerPrefs.permissionMode;
  const waitingStepIds = useMemo(() => run?.approvals.flatMap((request) => (request.stepId ? [request.stepId] : [])), [run?.approvals]);
  const agentPorts = useAgentPorts();
  const isSending = preparingHere || Boolean(run);
  const usage = useUsage(accountScope);
  const {
    chatOrder,
    showUsageInSidebar,
    keepAwake,
    defaultModelId,
    defaultPermissionMode,
    notifyOnCompletion,
    showDockBadge,
    notifyWhenWaiting,
    notificationChime,
    notificationSchedule,
    showAttentionButton,
    floatingInbox,
    routineNudges,
  } = useSettings();
  useEffect(() => {
    void window.milagre.setFloatingInbox?.(floatingInbox).catch(() => {});
  }, [floatingInbox]);
  useEffect(
    () =>
      window.milagre.onOpenExperimental?.(() => {
        setSettingsSection("experimental");
        setView("settings");
      }),
    [],
  );

  // Visiting an old chat can change its displayed model, but never the preference for new chats.
  useEffect(() => {
    if (selectedSessionId !== null) return;
    setSelectedModel(resolveModel(models, defaultModelId, providerForId(defaultModelId)));
    changePermissionMode(defaultPermissionMode);
  }, [selectedSessionId, defaultModelId, defaultPermissionMode, models]);

  const effectiveBaseBranch = baseBranch && branches.includes(baseBranch) ? baseBranch : (selectedWorktree?.name ?? branches[0] ?? "");

  function restoreProjectChoices(nextState: CoordinatorState, path: string) {
    const saved = loadChatPreferences(localStorage, path);
    setSelectedWorktreeId(sortedWorktrees(nextState).find((tree) => tree.path === saved.worktreePath)?.id ?? sortedWorktrees(nextState)[0]?.id ?? null);
    setBaseBranch(saved.baseBranch ?? null);
  }
  const runningCount = Object.keys(agentRuns.runs).length;
  const previousRunningCount = useRef(runningCount);

  // A turn just ended: plan usage has moved, so re-read it.
  useEffect(() => {
    if (runningCount < previousRunningCount.current) void usage.refresh();
    previousRunningCount.current = runningCount;
  }, [runningCount, usage.refresh]);
  const pendingApproval = run?.approvals[0];
  // Approvals come first; a question shows once none is waiting.
  const pendingQuestion = pendingApproval ? undefined : run?.questions[0];
  // Its answers were sent: the card goes at once, as on the phone, instead of waiting for the agent's word back.
  const questionSent = Boolean(pendingQuestion && sentReply(run, pendingQuestion.requestId));

  // A running turn takes the new mode at once instead of at its next message.
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
    // The run keeps the answer; if it doesn't reach the agent, the card goes back to pending.
    void agentRuns.respond(chatKey(project.path, selectedSession.id), pendingApproval.requestId, decision).catch(() => {});
  }

  /** Sends the answers to the open question, or dismisses it (null). */
  function answerQuestion(answers: QuestionAnswers | null) {
    if (!project || !selectedSession || !pendingQuestion) return;
    if (readOnly) {
      setNotice(`${openComputer?.name ?? "That computer"} is offline.`);
      return;
    }
    void agentRuns
      .answerQuestion(chatKey(project.path, selectedSession.id), pendingQuestion.requestId, answers)
      .catch((error) => setNotice(ipcErrorMessage(error)));
  }

  // The model a chat's picker shows, by chat key: as for the open Project chat.
  const modelForChatKey = (chat: string, provider: ModelProvider | undefined, own: ChatMessage[]) =>
    modelForOpenChat(chatModels.current[chat], provider, own, models, resolveModel(models, defaultModelId, providerForId(defaultModelId)));

  // The picker follows the open chat: the model picked there, else the one it last ran, on the agent it's bound to.
  // A Link keeps the Project open behind it; its own chat sets the picker then (LinkWorkspace).
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
    // The same state again (an open's reply the window already holds) renders nothing.
    if (reconciled === previous) return;
    statesRef.current = { ...statesRef.current, [projectPath]: reconciled };
    setStates(statesRef.current);
    const seen = projectsSeen.current.get(projectPath);
    if (seen) rememberProjectCopy({ ...seen, state: reconciled });
  }

  useEffect(() => stateEvents.onProjectState(({ path, state: next }) => receiveState(path, next)), []);

  // Approvals never time out, so mark chats that wait on one (the open chat too: its card may be scrolled away).
  // The sets are rebuilt on every streamed batch; keeping the old one while its members hold keeps the sidebar rows still.
  const waiting = useStableSet(useMemo(() => chatsWaitingForUser(agentRuns.runs, project?.path ?? ""), [agentRuns.runs, project?.path]));
  const asking = useStableSet(useMemo(() => chatsAskingUser(agentRuns.runs, project?.path ?? ""), [agentRuns.runs, project?.path]));
  const running = useStableSet(useMemo(() => chatsRunning(agentRuns.runs, project?.path ?? ""), [agentRuns.runs, project?.path]));
  // Chats whose turn ended with background agents still at work (chat-activity.mjs), with their count. Joined, so a
  // streamed batch that changes nothing keeps the map.
  const backgroundKey = useMemo(
    () => [...chatsInBackground(agentRuns.runs, project?.path ?? "", state?.sessions)].map(([id, count]) => `${id}:${count}`).join(","),
    [agentRuns.runs, project?.path, state?.sessions],
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
  // Other Chats that wait on an approval or question, except in Projects hidden from the sidebar. Joined, so a
  // streamed batch that changes nothing keeps the arrays.
  const hiddenProjects = useHiddenProjects();
  const attentionKey = chatsNeedingAttention(
    agentRuns.runs,
    view === "chat" && project && selectedSession ? chatKey(project.path, selectedSession.id) : "",
    hiddenProjects,
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
  // Every Project's state the window holds: the sidebar's reads of the ones not open, kept live, then this window's own on top.
  // The grid tiles its active Chats from them, and the Routines dot reads hidden Run Chats from them.
  const gridOn = layout === "grid" && view === "chat";
  // What a keybinding's `when` can ask about the window.
  setKeyContext({ chatView: view === "chat", linkOpen: Boolean(selectedLink), gridShown: gridOn });
  const gridStates = useMemo(() => ({ ...scopeStates, ...states }), [scopeStates, states]);
  // The Routines with a hidden Run Chat nobody opened yet: the sidebar's Routines button and their rows show a dot.
  // Settings › Routines can turn these nudges off on this Mac: no dots, so no Mark as read either.
  const unreadRunRoutineIds = useStableSet(useMemo(() => (routineNudges ? unreadRunRoutines(gridStates) : NO_ROUTINES), [routineNudges, gridStates]));
  // The hidden Run Chats nobody opened: their Runs show a dot on their Routine's page.
  const unreadRunChatKeys = useStableSet(useMemo(() => unreadRunChats(gridStates), [gridStates]));
  // Whether a Run's row opens its Chat: one still there, archived or not, or one in a Project the window holds no state for,
  // which opening loads by path (openCanvasChat). A Run whose Chat left with its Worktree opens nothing.
  const canOpenRun = useCallback((key: string) => canOpenRunChat(gridStates, key), [gridStates]);
  // A Routine row's Mark as read: each of its unread hidden Run Chats is marked read in its own Project.
  const markRoutineRead = useEvent((id: string) => {
    for (const key of unreadRunChatsOf(gridStates, id)) {
      const path = projectOfKey(key);
      void reportChatAction(bridgeForKey(path).patchChat(path, sessionIdFromKey(key), { unread: false }), "Could not mark the Run read", setNotice);
    }
  });
  const focusedChatKey = project && selectedSession && selectedSession.id > 0 ? chatKey(project.path, selectedSession.id) : null;
  // A Run's Chat beside its Routine's page: the window's Chat pane, moved next to the Runs, once that Chat is the open one.
  const runPaneOpen = view === "routines" && routineId !== null && runPane !== null && runPane === focusedChatKey;
  // A pin whose Chat was archived or left with its Worktree drops out; one in a Project not read yet stays.
  const livePins = useMemo(
    () =>
      gridPins.filter((key) => {
        const state = gridStates[projectOfKey(key)];
        const session = state?.sessions?.[sessionIdFromKey(key)];
        return !state || Boolean(session && !session.archived);
      }),
    [gridPins, gridStates],
  );
  const activeKeys = useMemo(
    () => (gridOn ? [...activeChatKeys(agentRuns.runs, linkedWork, gridStates), ...livePins] : NO_KEYS),
    [gridOn, agentRuns.runs, linkedWork, gridStates, livePins],
  );
  const pinnedTiles = useMemo(() => new Set(livePins), [livePins]);
  const toggleGridPin = useEvent((key: string) => changeGridPins((pins) => (pins.includes(key) ? pins.filter((item) => item !== key) : [...pins, key])));
  // A new Chat not saved yet keeps the grid as a draft tile, whose slot the Chat takes once it is saved.
  const gridFocusKey = focusedChatKey ?? (project && !selectedLink ? draftTileKey(project.path) : null);
  const [gridTiles, setGridTiles] = useState<readonly string[]>(NO_KEYS);
  const nextGridTiles = gridChats(gridTiles, activeKeys, gridOn ? gridFocusKey : null);
  if (nextGridTiles !== gridTiles) setGridTiles(nextGridTiles);
  // In the split view a Chat opened from the sidebar takes the focused tile's place, so the split keeps its size. Only focus
  // moves in the Chat view count: a Run Chat opened beside its Routine's page never joins the split.
  const [splitFocus, setSplitFocus] = useState(gridFocusKey);
  let split = splitKeys;
  if (view === "chat" && splitFocus !== gridFocusKey) {
    setSplitFocus(gridFocusKey);
    if (closingTile !== null) setClosingTile(null);
    if (layout === "split")
      split = closingTile === splitFocus ? splitKeys.filter((key) => key !== closingTile) : splitChats(splitKeys, splitFocus, gridFocusKey);
  }
  // A split Chat archived or gone with its Worktree drops out, as a pin does; the focused draft tile stays.
  const liveSplit = useMemo(
    () =>
      split.filter((key) => {
        if (key === gridFocusKey) return true;
        const state = gridStates[projectOfKey(key)];
        const session = state?.sessions?.[sessionIdFromKey(key)];
        return !isDraftTileKey(key) && (!state || Boolean(session && !session.archived));
      }),
    [split, gridStates, gridFocusKey],
  );
  const splitShown = layout === "split" && gridFocusKey !== null && liveSplit.length > 1 && liveSplit.includes(gridFocusKey);
  if (splitTarget !== null && gridFocusKey === splitTarget) setSplitTarget(null);
  // A split down to one Chat, or one the open Chat isn't in (after a reload), ends: the view shows that Chat alone. A new
  // Chat's draft focus doesn't end it, since the window shows one while it restores the open Chat.
  if (
    layout === "split" &&
    view === "chat" &&
    !splitShown &&
    closingTile === null &&
    splitTarget === null &&
    gridFocusKey !== null &&
    !isDraftTileKey(gridFocusKey)
  ) {
    split = NO_KEYS;
    setLayout("single");
  }
  if (split !== splitKeys) setSplitKeys(split);
  const splitOn = splitShown && view === "chat";
  const shownTiles = splitOn ? liveSplit : gridOn && gridFocusKey ? gridTiles : NO_KEYS;
  // Each waiting chat's project and title, for the attention menu. Titles change with state, not with each streamed batch.
  const attentionTitles = useMemo(
    () =>
      attentionChats
        .filter((key) => !shownTiles.includes(key))
        .map((key) => {
          const path = projectOfKey(key);
          const other = path === project?.path ? state : (states[path] ?? scopeStates[path]);
          const session = other?.sessions[sessionIdFromKey(key)];
          return {
            key,
            project: projectName(path),
            title: session
              ? chatTitle(
                  session,
                  other.messages.filter((message) => message.session_id === session.id),
                )
              : undefined,
          };
        }),
    [attentionChats, shownTiles, states, scopeStates, projectName, project?.path, state],
  );
  const shownTilesRef = useRef(shownTiles);
  shownTilesRef.current = shownTiles;
  const focusedChatKeyRef = useRef(focusedChatKey);
  focusedChatKeyRef.current = focusedChatKey;
  const gridFocusKeyRef = useRef(gridFocusKey);
  gridFocusKeyRef.current = gridFocusKey;
  // A Chat dropped on the grid is kept there where it was dropped. Dropped beside the one Chat on screen, or on a split's
  // tile, it joins a split view of only those Chats: the other active Chats stay out of it.
  const dropOnGrid = useEvent((key: string, target: GridDropTarget) => {
    const focused = focusedChatKeyRef.current;
    if (layoutRef.current === "grid") {
      changeGridPins((pins) => [...pins.filter((item) => item !== key), key]);
      setGridTiles((tiles) => placeDropped(tiles, key, target, focused));
      return;
    }
    setSplitKeys(placeDropped(shownTilesRef.current, key, target, focused));
    setLayout("split");
  });
  // Closing a split tile leaves the others; the last one left shows alone. Closing the focused tile focuses its neighbour
  // first and leaves the split once that Chat is open, so the split never drops to one Chat while it loads.
  const closeSplitTile = useEvent((key: string) => {
    const tiles = shownTilesRef.current;
    const next = tiles.filter((item) => item !== key);
    const at = tiles.indexOf(key);
    const neighbour = [...next.slice(at), ...next.slice(0, at).toReversed()].find((item) => !isDraftTileKey(item));
    if (key !== gridFocusKeyRef.current || !neighbour) {
      setSplitKeys(next);
      return;
    }
    setClosingTile(key);
    openLinkedChat(neighbour);
  });
  // Subchats (subchat-rows.ts): the focused Chat's family, a subchat opened beside its parent, and the whole family at once.
  const focusedFamily = useMemo(
    () => (focusedChatKey ? chatFamily(gridStates[projectOfKey(focusedChatKey)]?.sessions, focusedChatKey) : null),
    [gridStates, focusedChatKey],
  );
  const familyShown =
    splitOn &&
    focusedFamily !== null &&
    liveSplit.length === focusedFamily.children.length + 1 &&
    liveSplit.includes(focusedFamily.root) &&
    focusedFamily.children.every((key) => liveSplit.includes(key));
  // A subchat opens beside its parent in the split; one already on screen is only focused. False when `key` has no parent.
  const openBesideParent = useEvent((key: string) => {
    const family = chatFamily(gridStates[projectOfKey(key)]?.sessions, key);
    if (!family || family.root === key || selectedLinkRef.current) return false;
    if (!(layoutRef.current === "split" && shownTilesRef.current.includes(key) && shownTilesRef.current.includes(family.root))) {
      setSplitKeys([family.root, key]);
      setLayout("split");
    }
    if (key !== gridFocusKeyRef.current) setSplitTarget(key);
    void openCanvasChat(projectOfKey(key), sessionIdFromKey(key));
    return true;
  });
  // The Subchats button: the parent and every subchat side by side, or back to the open subchat beside its parent (the
  // parent alone when it is the open one).
  const toggleFamily = useEvent(() => {
    if (!focusedFamily) return;
    if (familyShown) {
      const focused = gridFocusKeyRef.current;
      if (focused && focused !== focusedFamily.root) setSplitKeys([focusedFamily.root, focused]);
      else setLayout("single");
      return;
    }
    setSplitKeys([focusedFamily.root, ...focusedFamily.children]);
    setLayout("split");
  });
  useEffect(
    () =>
      gridDrop.register({
        hit: (x, y, key) => {
          if (viewRef.current !== "chat" || selectedLinkRef.current || !projectRef.current) return null;
          const under = document.elementFromPoint(x, y);
          const tile = under?.closest<HTMLElement>("[data-chat-tile]");
          if (tile) {
            const tileKey = tile.dataset.chatTile ?? "";
            return tileKey === key ? null : { tile: tileKey, ...dropSide(tile.getBoundingClientRect(), x, 12) };
          }
          const focused = focusedChatKeyRef.current;
          if (shownTilesRef.current.length || !focused || focused === key) return null;
          const pane = under?.closest<HTMLElement>("[data-chat-pane]");
          return pane ? { tile: null, ...dropSide(pane.getBoundingClientRect(), x, 0) } : null;
        },
        drop: dropOnGrid,
      }),
    [],
  );
  const dismissTile = useEvent(
    (key: string) =>
      void reportChatAction(
        bridgeForKey(projectOfKey(key)).patchChat(projectOfKey(key), sessionIdFromKey(key), { unread: false }),
        "Could not mark Chat read",
        setNotice,
      ),
  );
  const delegatedKeys = useMemo(() => new Set(linkedWork.delegations.flatMap((item) => (item.to_chat ? [item.to_chat] : []))), [linkedWork]);
  // Chats carry a summary of their messages; only an older host's state, without one, is grouped message by message.
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
  // oxlint-disable-next-line react/use-memo -- useMemo is given a factory function reference so the instance is created once
  const readPullRequestRefs = useMemo(pullRequestRefsCache, []);
  // The open Chat's PRs, the same list its sidebar row shows, so the composer's action and the row agree.
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
  // Unresolved review threads on the Chat's open PR: the composer's Review pill.
  const prOpenThreads = prReview.pr?.state === "OPEN" && prReview.pr.number === prNumber ? openThreads(prReview.pr).length : 0;
  // The pill's action, checked here too: a PR without a number yet shows no pill instead of sending a broken one.
  const pullRequestActionRequest = pullRequestBlockerAction
    ? pullRequestActionContext({ action: pullRequestBlockerAction.blocker, pr: pullRequestBlockerAction.pr.number, url: pullRequestBlockerAction.pr.url })
    : null;
  const previousChats = useRef<SidebarRecent[]>([]);
  // Chats with an archive under way, by chat key: their rows are gone from the sidebar from the tap on.
  const [archivingChats, setArchivingChats] = useState<ReadonlySet<string>>(() => new Set());
  const chats = useMemo(() => {
    const state = sidebarState;
    if (!state) return [];
    const withMessages = Object.values(state.sessions)
      .filter((session) => !session.archived && !(project && archivingChats.has(chatKey(project.path, session.id))))
      .map((session) => ({ session, sessionMessages: messagesBySession.get(session.id) ?? NO_MESSAGES }))
      // A hidden Run Chat shows only while its run waits on an approval or a question.
      .filter(({ session, sessionMessages }) => isChatListed(session, sessionMessages, waiting.has(session.id) || asking.has(session.id)));
    const rows = orderChats(withMessages, chatOrder).map(({ session, sessionMessages }) => {
      const worktree = state.worktrees[session.worktree_id];
      const failed = failedSends.find((send) => send.projectPath === project?.path && session.id === send.session.id);
      const pending = pendingSends.some((send) => send.projectPath === project?.path && session.id === (pendingChatSessionId(state, send) ?? send.session.id));
      // The commit dialog's notes aren't replies: they don't hide a failed turn (see summarizeChat).
      const summary = chatSummary(session, sessionMessages);
      return {
        id: String(session.id),
        label: chatTitle(session, sessionMessages),
        pending: pending || Boolean(failed),
        pinned: Boolean(session.pinned),
        pinOrder: session.pin_order,
        ...(session.done_at ? { doneAt: session.done_at } : {}),
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
          // A Chat without a Project names no folder: its Worktree is the Chats home's, internal to Milagre.
          path: showGit ? worktree?.path : undefined,
          diff: showGit ? worktree?.diff : undefined,
          linearIssue: showGit && worktree ? linearIssues[worktree.path] : undefined,
          // The stored link (Worktree.linearIssue) and whether "Link issue…" applies: the chat's own Worktree,
          // not the main checkout, and not one another chat shares.
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
    // Rows that came out the same stay the same objects, so only a changed chat's row renders.
    return (previousChats.current = reuseRows<SidebarRecent>(previousChats.current, rows));
  }, [
    sidebarState,
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
  const latest = useRef({
    patchChat,
    markChatDone,
    revealChat,
    openChatInEditor,
    openGitDialog,
    checkArchive,
    archiveChat,
    linkChatIssue,
    unlinkChatIssue,
    reloadChat,
  });
  latest.current = {
    patchChat,
    markChatDone,
    revealChat,
    openChatInEditor,
    openGitDialog,
    checkArchive,
    archiveChat,
    linkChatIssue,
    unlinkChatIssue,
    reloadChat,
  };
  // The main process applies chat row actions to the latest state, so a turn that finished since the last render isn't lost.
  function patchChat(sessionId: number, patch: SessionPatch, path = projectRef.current?.path) {
    if (path) void reportChatAction(patchChatShowingDone(path, sessionId, patch), "Could not update Chat", setNotice);
  }
  // Done on the open Chat leaves it for a new Chat in the same Project, as archiving it does: the work there is
  // finished, and the next thing starts fresh. The row keeps moving to the Done section meanwhile.
  function markChatDone(sessionId: number) {
    if (!selectedLinkRef.current && selectedSessionRef.current === sessionId) startNewChat();
    patchChat(sessionId, { done: true, unread: false });
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
    // The Chat's page read goes out before this click renders anything (see prefetchChatMessages).
    const shownProject = projectRef.current;
    if (shownProject) prefetchLeanChat(shownProject.path, sessionId, openState());
    leaveBots();
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
      patchChat(sessionId, { unread: false });
    setSelectedSessionId(sessionId);
    setSelectedWorktreeId(openState()?.sessions[sessionId]?.worktree_id ?? null);
    if (!keepsRoutinesView(holdRoutinesView.current, projectRef.current?.path, sessionId)) setView("chat");
  }

  // The main process reads the chat on screen (on opening it, and when the window regains focus over it),
  // and leaves a chat unread when its turn ends anywhere else, or while no window has focus. The Mac that had the
  // chat on screen before hears there is none when the next one is on another Mac.
  useEffect(() => {
    // A Link on screen is no Project's chat: whichever Mac had one open hears there is none now.
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

  // Archiving hides the chat for good; a turn still running in it is stopped first. The steps and their order
  // live in lib/archive-flow.ts, which is passed what it touches.
  // Another Project's chat (a row of the all-Projects sidebar) archives the same way, from the copy its group shows.
  // As on the phone, the row goes and the window leaves the chat at once; the host's work goes on behind, and a chat
  // whose archive fails (or whose worktree stays) comes back with a notice.
  // The permanent steps wait out the sidebar toast's Undo (deleteUndoWindow); an Undo brings the Chat back as a kept one does.
  function archiveChat(sessionId: number, mode: ArchiveMode, plan: ArchivePlan | null, projectPath = project?.path) {
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
        stop: () => (agentRuns.runs[key] ? agentRuns.interrupt(key).catch(() => {}) : undefined),
        undoWindow: () => deleteUndoWindow(key),
        hide: () => bridgeForKey(projectPath).patchChat(projectPath, sessionId, { archived: true, unread: false }),
        destroy: () => bridgeForKey(projectPath).deleteChat(projectPath, sessionId),
        // The worktree stays (or the deletion was undone), so the chat comes back with it; it is reopened only if it was
        // open and nothing else has been since.
        restore: async () => {
          await bridgeForKey(projectPath).patchChat(projectPath, sessionId, { archived: false });
          if (wasOpen && selectedSessionRef.current === null) openChat(sessionId);
        },
        remove: (worktree, options) => bridgeForKey(options.projectPath).removeWorktree(worktree.path, options),
        // The main process has dropped the worktree and its chats; a removal that drops the open chat or the picked
        // worktree moves the selection on.
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
      // A call that timed out may still have landed: only a conversation that is still saved needs an error.
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

  // A Link Chat archives from its Link's sidebar; its row is gone from this window's sidebars too until the host answers,
  // and comes back if the archive fails. The Link shows the error; a window that left it for a Project shows the notice.
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

  // What the archive menu offers depends on the chat's worktree: whether Milagre made it, whether another chat
  // uses it, and what it would lose.
  // The menu's Archive waits on this, so its reads go out together: one after another, each waiting its turn on a busy
  // host, they kept Archive disabled for seconds.
  async function checkArchive(sessionId: number, projectPath = project?.path): Promise<ArchivePlan> {
    if (!projectPath) return { milagreOwned: false, shared: false, status: null };
    const bridge = bridgeForKey(projectPath);
    const latest = archiveState(projectPath);
    const worktree = latest ? latest.worktrees[latest.sessions[sessionId]?.worktree_id ?? -1] : undefined;
    const shared = latest ? worktreeShared(latest, sessionId) : false;
    // Only a worktree Milagre made needs its status, and only then does a failed read count.
    const status = worktree?.base && !shared ? bridge.getWorktreeStatus(worktree.path, worktree.base) : Promise.resolve(null);
    status.catch(() => {});
    const [terminals, roots] = await Promise.all([busyTerminals(chatKey(projectPath, sessionId)), bridge.getWorktreeRoots()]);
    if (!latest || !isMilagreWorktree(worktree, roots)) return { milagreOwned: false, shared: false, status: null, terminals };
    if (shared) return { milagreOwned: true, shared: true, status: null, terminals };
    return { milagreOwned: true, shared: false, status: await status, terminals };
  }

  // The state the archive steps read: the open Project's, or the copy another Project's sidebar group shows.
  function archiveState(projectPath: string) {
    // A Project's key (not a `milagre-link:` one) holds a Project's state.
    const scoped = isLinkScopeKey(projectPath) ? undefined : (cachedScopeState(projectPath) as CoordinatorState | undefined);
    return statesRef.current[projectPath] ?? scoped ?? cachedProjectCopy(projectPath)?.state;
  }

  // "Commit and open PR…" opens the chat, with the dialog over it.
  async function openGitDialog(sessionId: number, path = projectRef.current?.path): Promise<void> {
    if (path && (path !== projectRef.current?.path || selectedLinkRef.current)) {
      await openCanvasChat(path, sessionId);
      if (projectRef.current?.path !== path) return;
      return latest.current.openGitDialog(sessionId);
    }
    const currentState = openState();
    const session = currentState?.sessions[sessionId];
    const worktree = session ? currentState.worktrees[session.worktree_id] : undefined;
    if (!currentState || !session || !worktree) return;
    // The dialog reads the Chat's recent turns (its test commands, what was asked); a lean state has them on the host.
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

  // What the dialog did goes on record as a short line in the chat; the main process holds it back while the
  // chat's turn runs, so it lands after the reply instead of inside it.
  function recordGitNote(sessionId: number, body: string) {
    const current = projectRef.current;
    if (current)
      void bridgeForKey(current.path)
        .addGitNote(chatKey(current.path, sessionId), body)
        .catch(() => {});
  }

  function revealChat(sessionId: number, path = projectRef.current?.path) {
    if (!path || isRemoteKey(path)) return;
    void window.milagre.revealInFolder(chatRevealPath(archiveState(path) ?? null, sessionId, path)).catch(() => {});
  }

  function openChatInEditor(sessionId: number, path = projectRef.current?.path) {
    const latest = path ? archiveState(path) : undefined;
    const worktree = latest?.worktrees[latest.sessions[sessionId]?.worktree_id ?? -1];
    if (worktree) void openInEditor(worktree.path);
  }

  // The daemon keeps the Mac awake while Milagre runs, if the setting says so.
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
      })
      .catch(() => {});
  }, [selectedLink?.link.id, project?.path, view, runPaneOpen, selectedSessionId, unreadChatIds.join("\n"), notifyOnCompletion, showDockBadge]);

  // The main process notifies about a chat that waits on the user while Milagre is in the background.
  useEffect(() => {
    void window.milagre.setNotifyWhenWaiting(notifyWhenWaiting).catch(() => {});
  }, [notifyWhenWaiting]);

  // A chat's notification goes silent and this window plays the chosen chime instead.
  useEffect(() => {
    void window.milagre.setNotificationChime?.(notificationChime).catch(() => {});
  }, [notificationChime]);
  useEffect(() => window.milagre.onPlayChime?.(playNotificationChime), []);
  useEffect(() => {
    void window.milagre.setNotificationSchedule?.(notificationSchedule).catch(() => {});
  }, [notificationSchedule]);

  // A turn that ends in the open project while Milagre is in the background gets a completion alert, unless a bot runs it.
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
          if (
            session &&
            !session.archived &&
            (event.type === "turn-completed" || event.type === "turn-failed") &&
            shouldNotifyCompletion(botsRef.current, chatId)
          )
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
        if ((event.type === "turn-completed" || event.type === "turn-failed") && shouldNotifyCompletion(botsRef.current, chatId)) {
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

  // A new worktree's branch is renamed a few seconds in, once its chat's name is picked; its Mac saves the new name.
  useEffect(() => {
    const renamed = (rename: WorktreeRename) => {
      if (projectRef.current?.path === rename.projectPath)
        void bridgeForKey(rename.projectPath)
          .listBranches(rename.projectPath)
          .then(
            (next) => rememberBranches(rename.projectPath, next),
            () => {},
          );
      // A Project not on screen reads its branches again when it is opened.
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
  // Opens a chat by its key, in another project too: a notification's, or the one the attention button points at.
  const openChatByKey = useEvent((chatId: string) => {
    const owner = projectOfKey(chatId);
    // Another Project's Chat: its page read goes out before the switch (the open Project's goes through openChat).
    if (!isLinkScopeKey(owner) && owner !== projectRef.current?.path)
      prefetchLeanChat(owner, sessionIdFromKey(chatId), statesRef.current[owner] ?? cachedProjectCopy(owner)?.state);
    leaveBots();
    if (isLinkScopeKey(owner)) {
      // oxlint-disable-next-line react/immutability -- React Compiler heuristic: the ref or handler is assigned or called after render, not during it
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
    // oxlint-disable-next-line react/immutability -- React Compiler heuristic: the ref or handler is assigned or called after render, not during it
    void switchProject(chatId.slice(0, separator));
  });
  useEffect(() => window.milagre.onOpenChat(openChatByKey), []);

  // Clicking the "phone paired" notification opens Settings → Devices, where it can be removed.
  useEffect(
    () =>
      window.milagre.onOpenPhoneSettings(() => {
        setSettingsSection("devices");
        setView("settings");
      }),
    [],
  );

  function startNewChat(draftText = "") {
    leaveBots();
    advanceChatView();
    const latest = openState();
    if (latest && projectRef.current) restoreProjectChoices(latest, projectRef.current.path);
    setSelectedSessionId(null);
    // The new-chat screen keeps its own draft; only text handed in replaces it.
    if (draftText) setDraft(draftText);
    setNewChatError(null);
    setView("chat");
    // The composer may only mount on this render (coming from settings), so focus after it lands.
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

  // Switching projects leaves the other project's turns running; their marks come back with it.
  // `keepView` leaves the view as it is: a Run Chat opening beside its Routine's page, or the Chat it replaced coming back.
  // `forgetChat` doesn't remember the Chat on screen for the Project being left (a Run Chat the pane had).
  // `sessionId` is the Chat to open there, picked in the same render as the Project, so the one it remembered is never
  // put on screen (which would mark it read) on the way.
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
    // The project's remembered worktree and base branch come back with it; nothing about the old project's chats
    // carries over, the commit dialog included (it names a chat by id, and every project has a chat 2).
    flushSync(() => {
      setProject(nextProject);
      selectInitialChat(nextProject.state, nextProject.path);
      const remembered = scopeDrafts.read({ kind: "project", projectPath: nextProject.path });
      const target = sessionId !== undefined && nextProject.state.sessions[sessionId] ? sessionId : remembered.sessionId;
      if (target !== null && nextProject.state.sessions[target]) setSelectedSessionId(target);
      setGitDialog(null);
      if (!keepView) setView("chat");
    });
    const restored = restoredChatsNotice(nextProject.restoredChats);
    if (restored) setNotice(restored);
  }

  /**
   * An open's reply reached the window: the host's next patch applies to its state (a host that numbers states), and the
   * sidebars take the window's state as their read, so leaving the Project doesn't read it again.
   */
  function keepOpenedState(reply: OpenProject & StateStamp) {
    seedHeldState(reply.path, reply);
    seedScopeState(reply.path, statesRef.current[reply.path]);
  }
  /**
   * The Project or Link on screen is being left: its group in the sidebars shows its chats from this window's latest
   * state. A Link's comes from the sidebars' own copy when they hold one: link events reach it at once, and the window's
   * linkStates only on its next render.
   */
  function handOverShownScope() {
    const link = selectedLinkRef.current;
    if (link) {
      const scope = `milagre-link:${link.link.id}`;
      seedScopeState(scope, cachedScopeState(scope) ?? linkStatesRef.current[link.link.id] ?? link.state);
    } else if (projectRef.current) seedScopeState(projectRef.current.path, statesRef.current[projectRef.current.path]);
  }

  // A Project's revalidated open, once the window shows it: its state (unless events brought a newer one while the open was
  // on its way, `adopted` being the state then) and its name. The same name keeps the same object, so nothing re-renders.
  function refreshOpenProject(next: OpenProject & StateStamp, adopted: CoordinatorState | undefined) {
    // Revalidation updates the list without resetting a Chat or draft picked while it was in flight.
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

  /**
   * Opens Project `projectPath` for this window. This Mac's Projects switch here (project:switch: the host shows it and
   * moves it to the top of its recent list). Another computer's Project is only read there (project:read), which loads
   * it on that host without reordering its recent list or changing the Project it shows. When this window holds the
   * host's numbered state of it (kept current by its patches), the read leaves the state out and the window keeps that
   * (a host from before the option sends the state anyway); a copy without a number is read whole.
   */
  function requestProject(projectPath: string): Promise<OpenProject & StateStamp> {
    return isRemoteKey(projectPath) ? readRemoteProject(projectPath) : bridgeForKey(projectPath).switchProject(projectPath);
  }
  async function readRemoteProject(projectPath: string): Promise<OpenProject & StateStamp> {
    const bridge = bridgeForKey(projectPath);
    const held = numberedState(projectPath);
    if (held && "worktrees" in held) {
      const reply: ProjectRead = await bridge.readProject(projectPath, { state: false });
      if (reply.state?.sessions) return reply as OpenProject & StateStamp;
      // Checked against the host's number: a copy that missed a change is read again.
      confirmHeldState(projectPath, reply);
      // Without the reply's number: it names the host's state, which the copy below follows.
      const { version: _version, epoch: _epoch, ...header } = reply;
      return { ...header, state: (numberedState(projectPath) as CoordinatorState | undefined) ?? held };
    }
    // With its options, so the host can tell a window opening the Project from a sidebar listing it.
    return bridge.readProject(projectPath, { state: true });
  }

  // Opens a project in place of the one shown; a cancelled dialog, or the project already open, changes nothing.
  async function replaceProject(load: () => Promise<(OpenProject & StateStamp) | null>, path?: string, adopt: Parameters<typeof adoptProject>[1] = {}) {
    const navigation = ++projectNavigation.current;
    const cached = path ? projectsSeen.current.get(path) : undefined;
    const cachedState = path ? statesRef.current[path] : undefined;
    const instant = cached && cachedState ? { ...cached, state: cachedState } : path ? cachedProjectCopy(path) : undefined;
    // The open goes out before the last copy renders, so a busy host starts on it at once.
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
      // Host events may have supplied a newer state while this request was pending.
      else refreshOpenProject(next, path ? adopted : statesRef.current[next.path]);
    } catch (error) {
      if (navigation !== projectNavigation.current) return;
      if (!projectRef.current && onboarding) setStartupError(ipcErrorMessage(error));
      setNotice(ipcErrorMessage(error));
    }
  }

  // With other computers, Add project asks which computer first; with this Mac alone, the folder dialog.
  const openProject = () => (pairedComputers.length > 0 ? Promise.resolve(setAddProjectOpen(true)) : replaceProject(() => window.milagre.openProject()));
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
    // An established window keeps its Project/Link picker, even when no local Project remains.
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
  async function selectLink(id: string, sessionId?: number, { keepView = false } = {}) {
    const scope = `milagre-link:${id}`;
    const known = linksSeen.current.get(id) ?? knownLink(id);
    const held = linkStatesRef.current[id] ?? cachedScopeState(scope) ?? scopeStates[scope];
    // The Chat's page read, then the Link's open, go out before anything renders.
    if (sessionId !== undefined) {
      prefetchLeanChat(scope, sessionId, held);
      beginChatSwitch(chatKey(scope, sessionId));
    }
    let request: Promise<OpenLink & StateStamp>;
    try {
      request = bridgeForKey(scope).openNamedLink(id);
    } catch (error) {
      request = Promise.reject(error);
    }
    leaveBots();
    const navigation = ++projectNavigation.current;
    const adopt = (next: OpenLink) => {
      handOverShownScope();
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
    // The Link shows at once from what this window holds (the host's last open, or the sidebar's read); the host's
    // open then refreshes it in place. Opening on the host recovers its Chats and can take a while when the Mac is busy.
    const instant = known && held && !("worktrees" in held) ? { link: known.link, projects: known.projects, state: held } : null;
    if (instant) adopt(instant);
    try {
      const reply = await request;
      if (navigation !== projectNavigation.current) return;
      // Its state's number goes to state-events (the host's next patch applies to it); the window keeps the Link alone.
      const { version: _version, epoch: _epoch, ...next } = reply;
      linksSeen.current.set(id, next);
      seedHeldState(scope, reply);
      seedScopeState(scope, next.state);
      if (!instant) {
        adopt(next);
        return;
      }
      // What didn't change keeps its objects, so a reply that changes nothing re-renders nothing.
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
      if (navigation === projectNavigation.current) setNotice(ipcErrorMessage(error));
    }
  }
  // Another computer's Project opened from a copy that lacks the Chat being opened lists none of its Chats ("No chats
  // yet"). Nothing on screen says which copy that was, so it goes to daemon.log.
  function noteMissingChat(projectPath: string, sessionId: number, source: string, state: CoordinatorState | undefined) {
    if (!isRemoteKey(projectPath) || !state?.sessions || state.sessions[sessionId]) return;
    noteComputer(projectPath, `${projectPath} opened Chat ${sessionId} from ${source}, which lacks it (${Object.keys(state.sessions).length} Chats)`);
  }
  async function openCanvasChat(projectPath: string, sessionId: number, adopt: Parameters<typeof adoptProject>[1] = {}) {
    // A Link's Chat, or one of the open Project's: selectLink and openChat read its page and measure the switch first.
    if (isLinkScopeKey(projectPath)) {
      await selectLink(projectPath.slice("milagre-link:".length), sessionId, adopt);
      return;
    }
    if (!selectedLinkRef.current && projectRef.current?.path === projectPath) {
      openChat(sessionId);
      return;
    }
    // The Chat's page read goes out first, then the Project's open, before anything renders: on a busy Mac the reads the
    // switch's render starts would otherwise go ahead of them. This Mac's Project opens from the canvas; another
    // computer's is only read there (requestProject).
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
    leaveBots();
    const navigation = ++projectNavigation.current;
    // The last copy shows at once; the main process's answer then refreshes it in place, so the switch never waits.
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
      // A host read carries its state's number; the offline copy and the numbered copy kept here don't.
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

  // Where a message goes: an open chat keeps its session, a new local chat (session null) gets one
  // from the main process, and a new chat in "New worktree" isolation gets its own worktree first.
  // A chat started from a Linear issue always gets its own worktree, whatever the isolation picker says.
  async function resolveSendTarget(body: string, issue?: IssueRef, view = chatView.current) {
    if (!state || !project || !selectedWorktree) return null;
    if (!issue && preparedTarget.current?.view === view && preparedTarget.current.projectPath === project.path) return preparedTarget.current;
    if (selectedSession) return { sessionId: selectedSession.id as number | null, worktreeId: selectedWorktree.id };
    if (isolation === "local" && !issue) return { sessionId: null, worktreeId: selectedWorktree.id };
    setBaseBranch(effectiveBaseBranch);
    saveChatPreferences(localStorage, project.path, { baseBranch: effectiveBaseBranch });
    // A worktree:create has no id the host could match a resend by: it is tried again only while the host is unreachable.
    const created = await retrySend(
      () =>
        bridgeForKey(project.path).createWorktree({
          projectPath: project.path,
          baseBranch: effectiveBaseBranch,
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
      // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
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
  ): Promise<boolean> {
    if ((!body && !images.length && !files.length) || !state || !selectedWorktree || !project || preparingHere || imageDraft.loading) return false;
    if (movingDraft.current) return false;
    const view = chatView.current;
    const sendKey = `${project.path}#${selectedSession?.id ?? `new${view}`}`;
    if (sendsInFlight.current.has(sendKey)) return false;
    sendsInFlight.current.add(sendKey);
    const stillHere = () => projectRef.current?.path === project.path && chatView.current === view;
    setNewChatError(null);
    // The picker decides the provider: a chat on another one hands off to it.
    const model = selectedModel;
    const firstMessage = chatCount === 0;
    const submittedDraft = draftStore.get();
    // Load the saved queue before deciding whether this Chat already has a pending message after restart.
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
    // A chat bound for a worktree that doesn't exist yet shows no worktree (and none of its PRs) until it does.
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
    setPendingSends((current) => [
      ...current,
      {
        ...preview,
        view,
        projectPath: project.path,
        originSessionId: selectedSession?.id ?? null,
        originWorktreeId: selectedWorktree.id,
        creatingWorktree: previewWorktreeId === NO_WORKTREE,
        provider: model.provider,
      },
    ]);
    if (!preserveComposer) {
      setDraft("");
      imageDraft.clear();
    }
    // Capture the user's choices before setup runs in the background.
    const options = {
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
      setPendingSends((current) =>
        current.map((pending) =>
          pending.message.clientMessageId === preview.message.clientMessageId
            ? { ...pending, creatingWorktree: false, targetSessionId: target!.sessionId, session: { ...pending.session, worktree_id: target!.worktreeId } }
            : pending,
        ),
      );
      const sendTarget = target;
      // The main process saves the message, then starts the Chat's turn, even if the user has navigated away. A busy or
      // restarting host gets it again until it takes it; the host recognises a resend by its clientMessageId.
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
            // A Mac that predates PR actions ignores prAction and sends this prompt as it is.
            prompt: prAction ? pullRequestActionPrompt(prAction) : attachmentPrompt(body, uploadedFiles),
            ...options,
            ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
            // A Mac that predates issue cards ignores linearIssue and sends the body as a plain message.
            ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: submittedDraft })! } : {}),
          }),
        { retryable: (error) => retryKind(error) !== null },
      );
      if (preparedTarget.current?.view === view) preparedTarget.current = null;
      sent = true;
      failedSendIds.current.forget(resendKey);
      setPendingSends((current) =>
        current.map((pending) =>
          pending.message.clientMessageId === preview.message.clientMessageId
            ? { ...pending, sent: true, originSessionId: sessionId, originWorktreeId: target!.worktreeId }
            : pending,
        ),
      );
      if (stillHere()) {
        // Text typed while a new chat was being created belongs to that chat, not to the next new one.
        const carried = draftStore.get();
        setDraft("");
        setSelectedSessionId(sessionId);
        setDraft([draftStore.get(), carried].filter(Boolean).join("\n\n"));
        setSelectedWorktreeId(openState()?.sessions[sessionId]?.worktree_id ?? target.worktreeId);
      }
      return true;
    } catch (error) {
      // The host may have saved the message and lost only its answer: a resend of this text carries the same id.
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
      if (!sent) setPendingSends((current) => current.filter((pending) => pending.message.clientMessageId !== preview.message.clientMessageId));
      sendsInFlight.current.delete(sendKey);
    }
  }

  // Every comment that still matches the diff goes out as one message, like any send (a running turn is steered).
  async function sendDiffComments() {
    const sent = diffComments.sendable;
    if (sent.length === 0) return;
    const base =
      changes.mode === "pr" && prReview.pr ? `PR #${prReview.pr.number}` : changes.list.state === "ready" && changes.list.isRepo ? changes.list.base : null;
    // Back to the chat first, so the message shows up as it lands.
    changes.closeDiff();
    if (
      await executeSend(formatCommentsMessage(sent, { mode: changes.mode === "uncommitted" ? "uncommitted" : "committed", base }), permissionMode, [], [], true)
    )
      diffComments.removeMany(sent.map((comment) => comment.id));
  }

  // "Fix in Chat" on a PR's thread: back to the Chat, and the ask goes out like any send.
  const sendPrToChat = useEvent((text: string) => {
    changes.closeDiff();
    void executeSend(text, permissionMode, [], [], true);
  });
  const prThreadActions = useMemo<ThreadActions>(
    () => ({
      reply: async (thread, body) => (await latestPr.current.write("reply", (pr, cwd, number) => pr.reply({ cwd, number, threadId: thread.id, body }))).ok,
      resolve: (thread, resolved) =>
        void latestPr.current.write(
          "resolve",
          (pr, cwd) => pr.resolveThread({ cwd, threadId: thread.id, resolved }),
          (current) => ({ ...current, threads: current.threads.map((entry) => (entry.id === thread.id ? { ...entry, resolved } : entry)) }),
        ),
      deleteComment: (commentId) =>
        void latestPr.current.write(
          "delete",
          (pr, cwd) => pr.deleteComment({ cwd, commentId }),
          (current) => ({
            ...current,
            threads: current.threads
              .map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => comment.id !== commentId) }))
              .filter((thread) => thread.comments.length > 0),
          }),
        ),
      fixInChat: (thread: PullRequestThread) => {
        const pr = latestPr.current.pr;
        if (pr) sendPrToChat(threadFixMessage(pr, thread));
      },
    }),
    [sendPrToChat],
  );
  const latestPr = useRef(prReview);
  latestPr.current = prReview;
  const addToReview = useEvent(
    (selection: DiffSelection, path: string, body: string) =>
      void prReview.write("comment", (pr, cwd, number) =>
        pr.comment({
          cwd,
          number,
          path,
          line: selection.end,
          startLine: selection.start < selection.end ? selection.start : undefined,
          side: selection.side === "old" ? "LEFT" : "RIGHT",
          body,
        }),
      ),
  );
  const submitPrReview = useEvent(
    async (event: ReviewEvent, body: string) => (await prReview.write("submit", (pr, cwd, number) => pr.submitReview({ cwd, number, event, body }))).ok,
  );
  const prDiffReview: PrDiffReview | undefined =
    changes.mode === "pr" && prReview.pr
      ? { pr: prReview.pr, threadActions: prThreadActions, addToReview, submit: submitPrReview, error: prReview.writeError }
      : undefined;
  const prPanelActions = useMemo<PullRequestPanelActions>(
    () => ({
      openFile: (path) => changes.selectFile(path),
    }),
    [changes.selectFile],
  );
  // A sidebar row's PR chip: the Chat's own PR opens in its panel; any other PR (or another computer's) on GitHub.
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

  // The new chat starts at once from an issue: its first message is the issue, then whatever the user typed.
  function startFromIssue(issue: LinearIssue) {
    void executeSend(issueFirstMessage(issue, draftStore.get()), permissionMode, imageDraft.images, imageDraft.files, false, undefined, issue);
  }

  // The chat's Worktree gets the issue (its branch is renamed when the branch is still a milagre/ one with no open PR).
  async function linkChatIssue(sessionId: number, key: string, workspace?: string, path = projectRef.current?.path) {
    const worktreeId = path ? archiveState(path)?.sessions[sessionId]?.worktree_id : undefined;
    if (!path || worktreeId === undefined) return;
    const linked = async () => {
      const result = await bridgeForKey(path).linkWorktreeIssue({ projectPath: path, worktreeId, key, ...(workspace ? { workspace } : {}) });
      receiveState(path, result.project.state);
      refreshLinearIssues();
      // A toast, as on the phone: the result needs no answer.
      showNotice(result.mode === "renamed" ? `Branch renamed to ${result.branch}.` : `Issue linked. ${LINK_PR_HINT(key)}`);
    };
    await reportChatAction(linked(), "Could not link issue", setNotice);
  }

  // Reload chat: a running turn stops and the agent's process ends; the next message resumes the session in a new
  // one, which reads MCP servers, skills and the sign-in again.
  async function reloadChat(sessionId: number, path = projectRef.current?.path) {
    if (!path) return;
    const reloaded = async () => {
      await bridgeForKey(path).reloadChat(chatKey(path, sessionId));
      showNotice("Chat reloaded. Your next message starts a fresh agent.");
    };
    await reportChatAction(reloaded(), "Could not reload chat", setNotice);
  }

  async function unlinkChatIssue(sessionId: number, path = projectRef.current?.path) {
    const worktreeId = path ? archiveState(path)?.sessions[sessionId]?.worktree_id : undefined;
    if (!path || worktreeId === undefined) return;
    const unlinked = async () => {
      const result = await bridgeForKey(path).unlinkWorktreeIssue({ projectPath: path, worktreeId });
      receiveState(path, result.project.state);
      refreshLinearIssues();
    };
    await reportChatAction(unlinked(), "Could not unlink issue", setNotice);
  }

  // Compact now on the context card: Claude's /compact as a divider in the chat, with no handoff and no draft touched.
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

  async function sendMessage() {
    const body = draftStore.get().trim();
    if ((!body && !imageDraft.images.length && !imageDraft.files.length) || !state || !selectedWorktree || !project || preparingHere || imageDraft.loading)
      return;
    await executeSend(body, permissionMode);
  }

  // Keep finished message cards out of the typing render path. Recommendations still use
  // the current model and permission mode when clicked.
  const recommendationRef = useRef<(option: string) => void>(() => {});
  recommendationRef.current = (option) => {
    void executeSend(option, permissionMode);
  };
  const sendRecommendation = useCallback((option: string) => recommendationRef.current(option), []);

  // The find bar belongs to one open chat; ⌘F again while it is open refocuses and selects its text.
  const [findOpen, setFindOpen] = useState(false);
  const [findSignal, setFindSignal] = useState(0);
  // Text the find bar starts with, from a ⌘K message result; ⌘F clears it.
  const [findSeed, setFindSeed] = useState<string | undefined>();
  const findRef = useRef({ open: false, canOpen: false });
  findRef.current = { open: findOpen, canOpen: view === "chat" && !botsShown && chatCount > 0 };
  function openFind(seed?: string) {
    if (!findRef.current.canOpen) return;
    setFindSeed(seed);
    setFindOpen(true);
    setFindSignal((current) => current + 1);
  }
  useEffect(() => setFindOpen(false), [selectedSession?.id, view]);
  // A ⌘K message result opens its chat first; the find bar opens once that chat's messages are on screen.
  const pendingFind = useRef<{ sessionId: number; term: string } | null>(null);
  useEffect(() => {
    const pending = pendingFind.current;
    if (!pending || view !== "chat" || selectedSession?.id !== pending.sessionId || !messages.length) return;
    pendingFind.current = null;
    openFind(pending.term);
  }, [selectedSession?.id, view, messages.length]);
  function openMessage(sessionId: number, term: string) {
    leaveBots();
    if (view === "chat" && selectedSession?.id === sessionId) {
      openFind(term);
      return;
    }
    pendingFind.current = { sessionId, term };
    openChat(sessionId);
  }

  // The main process sends on the app's frame-wide keys (Settings, the theme, the canvas, the grid, the side panels) pressed
  // in any frame, including an embedded one (a design, an HTML reply, the simulator) the window's listeners never see;
  // replayed here, every handler takes them as if pressed in the window.
  useEffect(
    () =>
      window.milagre.onAppShortcut?.(({ key, code, meta, control, alt, shift }) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: code ?? "",
            metaKey: meta,
            ctrlKey: control,
            altKey: alt,
            shiftKey: shift,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    [],
  );
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      const command = shortcutCommand(event);
      if (!command) return;
      // A Link's workspace takes its own Chat shortcuts (Changes, New Chat, search, New Terminal, Find) and has its own
      // canvas and grid; the window-wide ones, Settings and the theme, still work over it.
      const inLink = Boolean(selectedLinkRef.current);
      if (command === "settings.open") {
        event.preventDefault();
        setView("settings");
        return;
      }
      if (command === "theme.toggle") {
        event.preventDefault();
        toggleTheme();
        return;
      }
      if (inLink) return;
      if (command === "grid.focusPrevious" || command === "grid.focusNext") {
        const tiles = shownTilesRef.current;
        if (tiles.length < 2) return;
        event.preventDefault();
        const step = command === "grid.focusPrevious" ? -1 : 1;
        const at = tiles.indexOf(gridFocusKeyRef.current ?? "");
        // A new Chat's draft tile is left, never landed on: it has no Chat to open.
        const others = tiles.filter((key, index) => index === at || !isDraftTileKey(key));
        const from = others.indexOf(gridFocusKeyRef.current ?? "");
        const next = others[(from + step + others.length) % others.length];
        if (next && next !== gridFocusKeyRef.current) openLinkedChat(next);
        return;
      }
      if (command === "changes.toggle") {
        if (!changesAvailableRef.current) return;
        event.preventDefault();
        changes.toggleDefault();
      } else if (command === "canvas.open") {
        event.preventDefault();
        changes.closeDiff();
        setView("canvas");
      } else if (command === "usage.open") {
        event.preventDefault();
        changes.closeDiff();
        setSettingsSection("usage");
        setView("settings");
      } else if (command === "grid.toggle") {
        event.preventDefault();
        // Away from the Chat view the grid has nothing to toggle: the shortcut shows it there instead.
        if (viewRef.current === "chat") toggleLayout();
        else {
          changes.closeDiff();
          setView("chat");
          showGrid();
        }
      } else if (command === "chat.find") {
        if (!findRef.current.canOpen) return;
        event.preventDefault();
        openFind();
      } else if (command === "commandPalette.toggle") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (command === "chat.new") {
        event.preventDefault();
        startNewChatOnThisMac();
      } else if (command === "project.add") {
        event.preventDefault();
        void openProject();
      } else if (command === "terminal.new" && terminalChatRef.current) {
        event.preventDefault();
        newTerminal(terminalChatRef.current, undefined, setNotice);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      // A menu, picker or search that Escape closed has already consumed it.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Settings opened over a Link goes back to it; the Link's workspace takes every other Escape.
      if (selectedLinkRef.current) {
        if (view === "settings") {
          event.preventDefault();
          setView("chat");
        }
        return;
      }
      if (findRef.current.open) {
        event.preventDefault();
        setFindOpen(false);
        return;
      }
      // A Run Chat beside its Routine's page closes first, then the page goes back to the Routines page.
      if (runPaneOpen) {
        event.preventDefault();
        closeRunPane();
        return;
      }
      if (view === "routines" && routineId) {
        event.preventDefault();
        setRoutineId(null);
        return;
      }
      if (view === "settings" || view === "canvas" || view === "routines") {
        event.preventDefault();
        setView("chat");
        return;
      }
      // The bot thread is on screen: Escape never stops a turn in the Chat behind it.
      if (run && project && selectedSession && !botsShown) {
        event.preventDefault();
        // Escape denies the open approval or dismisses the open question; once that's sent, Escape stops the turn.
        const approval = run.approvals[0];
        const question = approval ? undefined : run.questions[0];
        if (approval && !run.answered[approval.requestId]) answerApproval("deny");
        else if (question && !run.answered[question.requestId]) answerQuestion(null);
        else void agentRuns.interrupt(chatKey(project.path, selectedSession.id));
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [run, project?.path, selectedSession?.id, view, botsShown, routineId, runPaneOpen]);

  // The sidebar owns the visible order, including folds, pins, Done and its collapsed rail.
  const jumpChats = useRef<string[]>([]);
  const setJumpChats = useEvent((ids: string[]) => {
    jumpChats.current = ids;
  });
  const jumpToChat = useEvent((event: KeyboardEvent) => {
    if (selectedLinkRef.current) return;
    if (view !== "chat" || event.defaultPrevented || event.isComposing) return;
    const index = chatJumpIndex(shortcutCommand(event));
    if (index === null) return;
    if (isModalOpen() || document.querySelector('[role="menu"], [aria-label="Chat name"]')) return;
    const chat = jumpChats.current[index];
    if (!chat) return;
    event.preventDefault();
    openChat(Number(chat));
  });
  useEffect(() => {
    window.addEventListener("keydown", jumpToChat);
    return () => window.removeEventListener("keydown", jumpToChat);
  }, [jumpToChat]);

  // The sidebar is memo()'d: these keep one identity across renders (each runs the latest closure) so a streamed
  // batch or another pane's state change doesn't re-render it.
  const pickChat = useEvent((id: string) => openChat(Number(id)));
  const remoteProject = isRemoteKey(project?.path);
  const scopeChatActions = useEvent((path: string, gitless: boolean): ChatRowActions => ({
    onRename: (id, title) => latest.current.patchChat(Number(id), { title }, path),
    onMarkUnread: (id, unread) => latest.current.patchChat(Number(id), { unread }, path),
    onReload: (id) => void latest.current.reloadChat(Number(id), path),
    onArchiveCheck: (id) => latest.current.checkArchive(Number(id), path),
    onArchive: (id, mode, plan) => latest.current.archiveChat(Number(id), mode, plan, path),
    onUndoArchive: (id) => undoDelete(chatKey(path, Number(id))),
    ...(isRemoteKey(path)
      ? { remote: true }
      : {
          onReveal: (id) => latest.current.revealChat(Number(id), path),
          onOpenInEditor: (id) => latest.current.openChatInEditor(Number(id), path),
        }),
    ...(gitless ? { gitless: true } : { onCommit: (id) => void latest.current.openGitDialog(Number(id), path) }),
    onLinkIssue: (id, key, workspace) => void latest.current.linkChatIssue(Number(id), key, workspace, path),
    onUnlinkIssue: (id) => void latest.current.unlinkChatIssue(Number(id), path),
  }));
  const chatActions = useMemo<ChatRowActions>(
    () => ({
      onRename: (id, title) => latest.current.patchChat(Number(id), { title }),
      onMarkUnread: (id, unread) => latest.current.patchChat(Number(id), { unread }),
      onReload: (id) => void latest.current.reloadChat(Number(id)),
      onPin: (id, order) => latest.current.patchChat(Number(id), order == null ? { pinned: false, pin_order: undefined } : { pinned: true, pin_order: order }),
      onDone: (id) => latest.current.markChatDone(Number(id)),
      onReopen: (id) => latest.current.patchChat(Number(id), { done: false }),
      ...(remoteProject
        ? { remote: true }
        : {
            onReveal: (id: string) => latest.current.revealChat(Number(id)),
            onOpenInEditor: (id: string) => latest.current.openChatInEditor(Number(id)),
          }),
      ...(showGit ? { onCommit: (id: string) => latest.current.openGitDialog(Number(id)) } : { gitless: true }),
      onArchiveCheck: (id) => latest.current.checkArchive(Number(id)),
      // The row shows the progress until this settles.
      onArchive: (id, mode, plan) => latest.current.archiveChat(Number(id), mode, plan),
      onUndoArchive: (id) => !!projectRef.current && undoDelete(chatKey(projectRef.current.path, Number(id))),
      onLinkIssue: (id, key, workspace) => void latest.current.linkChatIssue(Number(id), key, workspace),
      onUnlinkIssue: (id) => void latest.current.unlinkChatIssue(Number(id)),
    }),
    [remoteProject, showGit],
  );
  // Another Project's rows in the all-Projects sidebar archive through the same steps, against that Project.
  const checkScopeArchive = useEvent((scopeKey: string, id: string) => checkArchive(Number(id), scopeKey));
  const archiveScopeChat = useEvent((scopeKey: string, id: string, mode: ArchiveMode, plan: ArchivePlan) => archiveChat(Number(id), mode, plan, scopeKey));
  const startNewChatFromSidebar = useEvent(() => startNewChatOnThisMac());
  const openProjectFromSidebar = useEvent(() => void openProject());
  const switchProjectFromSidebar = useEvent((path: string) => void switchProject(path));
  // "+" on another Project's header switches to it (from its last copy, so at once) and starts a chat there.
  const newChatInScope = useEvent((key: string) => {
    leaveBots();
    if (isLinkScopeKey(key)) {
      void selectLink(key.slice("milagre-link:".length));
      return;
    }
    startNewChatIn(key);
  });
  // A new Chat in a Project, switched to first (a Link on screen closes). `draftText` replaces what waits there.
  function startNewChatIn(key: string, draftText = "") {
    if (!selectedLinkRef.current && projectRef.current?.path === key) {
      startNewChat(draftText);
      return;
    }
    // A new chat left unsent there comes back with its draft; a draft for one of its chats stays with that chat.
    const remembered = scopeDrafts.read({ kind: "project", projectPath: key });
    const start = () => startNewChat(draftText || (remembered.sessionId === null ? remembered.text : ""));
    const switched = switchProject(key);
    if (!selectedLinkRef.current && projectRef.current?.path === key) start();
    else
      void switched.then(() => {
        if (!selectedLinkRef.current && projectRef.current?.path === key) start();
      });
  }
  // New chat (⌘N, the sidebar's +, the command palette, a Link's) always opens the same screen on this Mac: the open
  // Project when it is this Mac's, else the one opened here last. Another computer's Project or a Link gets a new Chat
  // from its own header's +, or the heading's Project dropdown. A Chat without a Project on screen goes to that last
  // real Project instead (only No project in the heading's dropdown starts one), and stays in the Chats home only when
  // this Mac has no real Project.
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
    // This Mac has no real Project: the new Chat stays where it is, the Chats home included.
    else if (!selectedLinkRef.current) startNewChat(draftText);
  });
  // A new Chat on this Mac whose draft points its agent at a triage playbook; the user writes what went wrong after it.
  const startTriage = useEvent(async () => {
    const { prompt } = await window.milagre.prepareTriage(`Milagre desktop ${await window.milagre.getAppVersion()} on ${navigator.platform}`);
    await startNewChatOnThisMac(prompt);
  });
  // The new-chat heading's Project dropdown: the new Chat moves to that Project with whatever was typed so far. No project
  // (or the computer chip on its draft) moves it to that computer's Chats home, made first when it isn't there yet;
  // making it doesn't open it anywhere, the switch below does.
  const moveNewChat = useEvent(async (key: string, home?: Pick<ChatsHome, "exists">) => {
    const from = projectRef.current?.path;
    if (selectedLinkRef.current || !from || from === key) return;
    // The prompt keeps the keys while the draft moves (ChatComposer focuses it on the pick): what is typed here until the
    // new Chat opens there goes along with it, and Enter waits for it to arrive instead of sending here.
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
        // The draft stays where it was typed.
        if (!selectedLinkRef.current && projectRef.current?.path === from)
          setNewChatError(`Could not start a Chat without a Project: ${ipcErrorMessage(error)}`);
        return;
      }
      if (selectedLinkRef.current || projectRef.current?.path !== from) return;
    }
    const remembered = scopeDrafts.read({ kind: "project", projectPath: key });
    const start = () => {
      // Keep the text visible while the computer loads, as on mobile. Only take it when the destination is ready;
      // edits made during the wait come with it, and a failed switch leaves the original draft untouched.
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
  // The sidebar Chats group's +: a new Chat without a Project on this Mac, in its Chats home, made first when missing.
  const newChatWithoutProject = useEvent(async () => {
    leaveBots();
    const bridge = bridgeFor(LOCAL_COMPUTER);
    try {
      const home = await bridge.chatsHome();
      startNewChatIn(home.exists ? home.path : (await bridge.ensureChatsHome()).path);
    } catch (error) {
      setNotice(`Could not start a Chat without a Project: ${ipcErrorMessage(error)}`);
    }
  });
  const sidebarRunKeys = runKeys(agentRuns.runs);
  const openScopeChat = useEvent((scopeKey: string, id: string) => void openCanvasChat(scopeKey, Number(id)));
  // One identity each, so memo(SidebarNav) skips the renders a streaming reply or a run change makes here.
  const switchLinkFromSidebar = useEvent((id: string) => void selectLink(id));
  const linkProjectFromSidebar = useEvent(() => setLinkDialogOpen(true));
  const addComputerFromSidebar = useEvent(() => setAddComputerOpen(true));
  const editLinkFromSidebar = useEvent((id: string) => void editLink(id));
  // The pointer rests on a chat's row: its page is read now (a host that keeps messages by Chat), so the click paints
  // at once instead of waiting on the host, or on another computer's network.
  const hoverChat = useEvent((scopeKey: string, id: string) => {
    const state = isLinkScopeKey(scopeKey)
      ? (linkStatesRef.current[scopeKey.slice("milagre-link:".length)] ?? cachedScopeState(scopeKey))
      : (statesRef.current[scopeKey] ?? scopeStates[scopeKey] ?? cachedScopeState(scopeKey) ?? cachedProjectCopy(scopeKey)?.state);
    prefetchLeanChat(scopeKey, Number(id), state);
  });
  // "Link and ask A…" from the sidebar's Link popover: a plain user message to chat A on its own model, as its composer
  // would pick it, and the permission mode new turns get. A's agent decides whether to make a Delegation. Then A opens,
  // so the message and the reply are in view.
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
  const openSettings = useEvent(() => setView("settings"));
  const openAccounts = useEvent(() => {
    setSettingsSection("accounts");
    setView("settings");
  });
  // The computers popover's gears: a computer's own section, or This Mac's devices.
  const openComputerSettings = useEvent((id: string | null) => {
    if (id === null) setSettingsSection("devices");
    else {
      setSettingsComputer(id);
      setSettingsSection("computer");
    }
    setView("settings");
  });
  const selectSettingsComputer = (id: string) => {
    setSettingsComputer(id);
    setSettingsSection("computer");
  };
  const openCanvas = useEvent(() => {
    changes.closeDiff();
    setView("canvas");
  });
  const openRoutines = useEvent(() => {
    changes.closeDiff();
    setRoutineId(null);
    setView("routines");
  });
  // Token usage is a section of Settings.
  const openUsage = useEvent(() => {
    changes.closeDiff();
    setSettingsSection("usage");
    setView("settings");
  });
  // A Chat named on the Usage page, on the computer whose transcripts it reads.
  const openUsageChat = useEvent((computerId: string, projectPath: string, sessionId: number) => {
    setView("chat");
    void openCanvasChat(qualifyKey(computerId, projectPath), sessionId);
  });
  // A Routine's own page, with its Runs: from its row, or from a Chat's Routine chip.
  const openRoutine = useEvent((id: string | null) => {
    changes.closeDiff();
    setRoutineId(id);
    setView("routines");
  });
  const openProjectSettings = useEvent((path?: string) => {
    setSettingsProject(path && path !== projectRef.current?.path ? { path, name: projectName(path) } : null);
    setSettingsSection("project");
    setView("settings");
  });
  const openCommandPalette = useEvent(() => setCommandPaletteOpen(true));
  // Saved message cards also receive this callback: keep their memoization during sends and streamed updates.
  const openLinkedChat = useEvent((key: string) => void openCanvasChat(projectOfKey(key), sessionIdFromKey(key)));
  // A Delegation's header in a transcript: a subchat opens beside its parent, any other Chat as itself.
  const openMessageChat = useEvent((key: string) => {
    if (!openBesideParent(key)) openLinkedChat(key);
  });
  // A Run's row on its Routine's page opens the Run's Chat beside the Runs, in the window's own Chat pane.
  // It remembers the Chat the window had, which closing the pane brings back (a Run Chat in another Project switches the
  // window's Project, and the Routines view stays).
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
  // Closes the Run Chat pane and, while the window still shows that Run Chat, brings back the Chat it replaced, so the Chat
  // view never opens on a hidden Run Chat. A Chat picked meanwhile (the sidebar, a notification) stays.
  const closeRunPane = useEvent(() => {
    const saved = runPaneReturn.current;
    const paneKey = runPaneRef.current;
    runPaneReturn.current = null;
    // A Run Chat still opening (its Project loading) is called off, so it can't land in the Chat view afterwards.
    if (holdRoutinesView.current !== null) projectNavigation.current += 1;
    holdRoutinesView.current = null;
    setRunPane(null);
    const back = runPaneRestore(saved, paneKey, focusedChatKeyRef.current, projectRef.current?.path ?? null);
    if (!back) return;
    if (back.kind === "link") void selectLink(back.linkId, back.sessionId ?? undefined, { keepView: true });
    else if (back.kind === "same") {
      if (back.sessionId !== selectedSessionRef.current) advanceChatView();
      setSelectedSessionId(back.sessionId);
      setSelectedWorktreeId(back.worktreeId);
    } else if (back.sessionId !== null) void openCanvasChat(back.projectPath, back.sessionId, { keepView: true, forgetChat: true });
    else void switchProject(back.projectPath, { keepView: true, forgetChat: true });
  });
  // The pane belongs to the Routine page it opened on: another page, or another view, closes it.
  useEffect(() => {
    closeRunPane();
  }, [routineId, view]);
  const sidebarUsage = useMemo(
    () =>
      showUsageInSidebar && usage.snapshot && visibleProviders(usage.snapshot).length > 0 ? (
        <SidebarUsage usage={usage} scope={accountScope} chatsHome={accountScopeIsHome} />
      ) : undefined,
    [showUsageInSidebar, usage.snapshot, usage.loading, accountScope, accountScopeIsHome],
  );
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

  // Fast loads would cut the startup animation off at the bare legs, so the splash stays until the logo is whole,
  // then fades out over the app while the panes slide in. Same key in both trees keeps the logo from restarting.
  const [splash, setSplash] = useState<"intro" | "done" | "gone">("intro");
  const [appEntered, setAppEntered] = useState(false);
  const splashOverlay = (leaving: boolean) =>
    splash === "gone" ? null : (
      <StartupSplash
        key="startup-splash"
        leaving={leaving}
        onIntroEnd={() => setSplash((current) => (current === "intro" ? "done" : current))}
        onLeft={() => setSplash("gone")}
      />
    );

  if (!loading && !project && onboarding)
    return (
      <Onboarding
        splash={splashOverlay(splash === "done")}
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
      <main data-startup-error className="flex min-h-screen items-center justify-center p-8 text-ink">
        <section className="w-full max-w-xl rounded-2xl border border-line bg-surface p-6 shadow-overlay" aria-labelledby="startup-error-title">
          <h1 id="startup-error-title" className="text-lg font-semibold">
            Project could not open
          </h1>
          <p role="alert" className="mt-3 break-words text-sm leading-relaxed text-ink-2">
            {startupError}
          </p>
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => void loadInitialProject()}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => void openProject()}
            >
              Open another project
            </button>
          </div>
        </section>
      </main>
    );
  }

  async function editLink(id: string) {
    try {
      const link = (await bridgeForKey(`milagre-link:${id}`).listNamedLinks()).find((item) => item.id === id);
      if (!link) throw new Error("Link no longer exists");
      setLinkDialogOpen(link);
    } catch (error) {
      setNotice(ipcErrorMessage(error));
    }
  }
  // An edited Link that is open reloads in place, so its header and member Projects follow.
  async function linkEdited(link: NamedProjectLink) {
    window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    if (selectedLinkRef.current?.link.id !== link.id) return;
    try {
      const next = await bridgeForKey(`milagre-link:${link.id}`).openNamedLink(link.id);
      if (selectedLinkRef.current?.link.id === link.id) setSelectedLink(next);
    } catch (error) {
      setNotice(ipcErrorMessage(error));
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
  const linkDialog = linkDialogOpen ? (
    <LinkProjectDialog
      link={typeof linkDialogOpen === "object" ? linkDialogOpen : undefined}
      onClose={() => setLinkDialogOpen(false)}
      onCreated={(link) => {
        const edited = typeof linkDialogOpen === "object";
        setLinkDialogOpen(false);
        void (edited ? linkEdited(link) : selectLink(link.id));
      }}
    />
  ) : null;
  const addComputerDialog = addComputerOpen ? <AddComputerDialog onClose={() => setAddComputerOpen(false)} onAdded={() => setAddComputerOpen(false)} /> : null;
  const addProjectDialog = addProjectOpen ? (
    <AddProjectDialog
      onClose={() => setAddProjectOpen(false)}
      onOpened={(opened) => {
        setAddProjectOpen(false);
        void replaceProject(async () => opened);
      }}
    />
  ) : null;
  if ((selectedLink || !project) && view === "settings")
    return (
      <DotBackground>
        {saveNotices}
        <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
        {/* The same frame as Settings beside a Project: the nav under the top bar, the page from the window's top. */}
        <div className="flex h-screen gap-3 pr-3">
          <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
            <SettingsNav
              showProjectSettings={!selectedLink || !!settingsProject}
              project={settingsProject ?? undefined}
              section={settingsSection}
              onSelectProject={(picked) => {
                setSettingsProject(picked);
                setSettingsSection("project");
              }}
              onSelect={setSettingsSection}
              computerId={settingsComputer ?? undefined}
              onSelectComputer={selectSettingsComputer}
              onBack={() => setView("chat")}
            />
          </div>
          <main className="min-w-0 flex-1 pb-3">
            <SettingsPanel
              section={settingsSection}
              project={settingsProject ?? undefined}
              computerId={settingsComputer ?? undefined}
              accountScope={accountScope}
              models={models}
              update={update}
              onSectionChange={setSettingsSection}
              onAddComputer={() => setAddComputerOpen(true)}
              onOpenUsageChat={openUsageChat}
            />
          </main>
        </div>
        {addComputerDialog}
      </DotBackground>
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
        // Options are now managed internally by LinkWorkspace via useComposerPreferences
      }}
      onSwitchProject={(path) => void switchProject(path)}
      onSwitchLink={(id) => void selectLink(id)}
      onLinkProject={() => setLinkDialogOpen(true)}
      onAddComputer={() => setAddComputerOpen(true)}
      onOpenComputerSettings={openComputerSettings}
      onEditLink={(id) => void editLink(id)}
      onOpenProject={() => void openProject()}
      onSettings={() => {
        setSettingsSection("project-accounts");
        setView("settings");
      }}
      onOpenAccounts={openAccounts}
      linkedWork={linkedWork}
      onCanvasChat={(path, id) => void openCanvasChat(path, id)}
      usage={sidebarUsage}
      onNewChatInScope={newChatInScope}
      onNewChat={startNewChatOnThisMac}
      archivingChats={archivingChats}
      onArchiving={trackLinkArchive}
      scopeChatActions={scopeChatActions}
    />
  );
  const linkDialogs = (
    <>
      {linkDialog}
      {addComputerDialog}
      {addProjectDialog}
    </>
  );
  // A Link with no Project to stand behind it (none open yet) is the whole window.
  if (selectedLink && (loading || !project || !state || splash === "intro"))
    return (
      <>
        {linkWorkspace}
        {linkDialogs}
      </>
    );

  if (!loading && !project && splash !== "intro")
    return (
      <DotBackground>
        {saveNotices}
        <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
        <div data-project-chooser className="flex h-screen w-full gap-3 text-ink">
          <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
            <SidebarNav
              fill
              workspaceName="Projects"
              recents={[]}
              onOpenProject={openProjectFromSidebar}
              onSwitchProject={switchProjectFromSidebar}
              onSwitchLink={(id) => void selectLink(id)}
              onLinkProject={() => setLinkDialogOpen(true)}
              onEditLink={(id) => void editLink(id)}
              onAddComputer={() => setAddComputerOpen(true)}
              onOpenComputerSettings={openComputerSettings}
              onOpenProjectSettings={openProjectSettings}
              onNewChatInScope={newChatInScope}
              onOpenScopeChat={openScopeChat}
              onHoverChat={hoverChat}
              onOpenSettings={() => {
                setSettingsSection("general");
                setView("settings");
              }}
              runningKeys={sidebarRunKeys.running}
              waitingKeys={sidebarRunKeys.waiting}
              askingKeys={sidebarRunKeys.asking}
              attentionPaths={attentionPaths}
            />
          </div>
          <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            {notice && (
              <p role="alert" className="break-words text-[13px] text-red-ink">
                {notice}
              </p>
            )}
            <h1 className="text-[22px] font-semibold">Choose a Project</h1>
            <p className="text-[14px] text-ink-3">Open a Project or Link from the sidebar, or add a Project.</p>
            <button type="button" onClick={openProjectFromSidebar} className="rounded-control bg-ink px-4 py-2 text-[13px] font-medium text-surface">
              Add Project
            </button>
          </main>
        </div>
        {linkDialogs}
      </DotBackground>
    );

  if (loading || !project || !state || splash === "intro") {
    return <>{splashOverlay(false)}</>;
  }

  // Only the open palette reads the list, so it is built then and not on every render.
  function buildCommands(current: OpenProject): Command[] {
    const commands: Command[] = [
      {
        id: "new-chat",
        label: "New chat",
        group: "Actions",
        icon: "add",
        keybinding: "chat.new" as const,
        keywords: "create agent session",
        run: () => startNewChatOnThisMac(),
      },
      ...(terminalChatId
        ? [
            {
              id: "new-terminal",
              label: "New Terminal",
              group: "Actions",
              icon: "add" as const,
              keybinding: "terminal.new" as const,
              keywords: "shell console command line",
              run: () => newTerminal(terminalChatId, undefined, setNotice),
            },
          ]
        : []),
      {
        id: "open-project",
        label: "Add project…",
        group: "Actions",
        icon: "folder",
        keybinding: "project.add" as const,
        keywords: "add repository workspace folder",
        run: () => openProject(),
      },
      {
        id: "canvas",
        label: "Projects and Links",
        group: "Actions",
        icon: "git",
        keybinding: "canvas.open" as const,
        keywords: "canvas linked worktrees",
        run: openCanvas,
      },
      {
        id: "routines",
        label: "Routines",
        group: "Actions",
        icon: "routines",
        keywords: "heartbeats triggers schedule linear webhook automations",
        run: openRoutines,
      },
      {
        id: "usage",
        label: "Token usage",
        group: "Actions",
        icon: "usage",
        keybinding: "usage.open" as const,
        keywords: "tokens cost spend analytics dollars models claude codex",
        run: openUsage,
      },
      {
        id: "triage",
        label: "Triage an issue",
        group: "Actions",
        icon: "triage",
        keywords: "bug report problem diagnose help support broken",
        run: startTriage,
      },
      {
        id: "settings",
        label: "Settings",
        group: "Actions",
        icon: "settings",
        keybinding: "settings.open" as const,
        keywords: "preferences model permissions",
        run: () => {
          setSettingsSection("general");
          setView("settings");
        },
      },
      {
        id: "appearance",
        label: "Appearance settings",
        group: "Actions",
        icon: "settings",
        keywords: "theme preferences",
        run: () => {
          setSettingsSection("appearance");
          setView("settings");
        },
      },
      {
        id: "toggle-theme",
        label: "Toggle theme",
        group: "Actions",
        icon: "settings",
        keybinding: "theme.toggle" as const,
        keywords: "appearance switch color mode",
        run: toggleTheme,
      },
      ...(surfaces.settings
        ? [
            {
              id: "project-settings",
              label: "Project settings",
              group: "Actions",
              icon: "settings" as const,
              detail: current.name,
              keywords: "worktree setup files",
              run: openProjectSettings,
            },
          ]
        : []),
    ];
    if (view === "settings" || view === "routines")
      commands.push({ id: "back-to-chat", label: "Back to chat", group: "Actions", icon: "chat", run: () => setView("chat") });
    commands.push({
      id: "chat-layout",
      label: layout === "grid" ? "Show one Chat" : "Show active Chats as a grid",
      group: "Actions",
      icon: "chat",
      keybinding: "grid.toggle" as const,
      keywords: "grid layout split multiple chats tiles",
      run: () => {
        setView("chat");
        toggleLayout();
      },
    });
    commands.push(...settingsCommands(getSettings(), updateSettings));
    if (selectedSession && view === "chat") {
      const sessionId = selectedSession.id;
      commands.unshift(
        ...(showGit
          ? [
              {
                id: "git",
                label: "Commit and open PR…",
                group: "Current chat",
                icon: "git" as const,
                keywords: "git changes pull request push",
                run: () => openGitDialog(sessionId),
              },
            ]
          : []),
        // A Chat without a Project has no folder to the user (as in its row's menu).
        ...(isRemoteKey(project?.path) || !showGit
          ? []
          : [
              {
                id: "editor",
                label: "Open in editor",
                group: "Current chat",
                icon: "editor" as const,
                keywords: "code vscode cursor",
                run: () => openChatInEditor(sessionId),
              },
              {
                id: "reveal",
                label: "Reveal folder",
                group: "Current chat",
                icon: "folder" as const,
                keywords: "finder explorer worktree",
                run: () => revealChat(sessionId),
              },
            ]),
        ...(chatCount
          ? [
              {
                id: "find",
                label: "Find in chat",
                group: "Current chat",
                icon: "search" as const,
                keybinding: "chat.find" as const,
                keywords: "search text messages",
                run: openFind,
              },
            ]
          : []),
        {
          id: "unread",
          label: selectedSession.unread ? "Mark as read" : "Mark as unread",
          group: "Current chat",
          icon: "unread",
          run: () => patchChat(sessionId, { unread: !selectedSession.unread }),
        },
        {
          id: "reload",
          label: "Reload chat",
          group: "Current chat",
          icon: "reload",
          detail: RELOAD_HINT,
          keywords: "restart agent mcp skills login refresh",
          run: () => void reloadChat(sessionId),
        },
      );
      if (selectedWorktree && showGit)
        commands.splice(3, 0, {
          id: "copy-path",
          label: "Copy worktree path",
          group: "Current chat",
          icon: "copy",
          run: () => navigator.clipboard.writeText(selectedWorktree.path),
        });
    }
    commands.push(
      ...chats.map((chat): Command => ({
        id: `chat:${chat.id}`,
        label: chat.label,
        group: "Chats",
        icon: "chat",
        detail: [
          chat.mark === "waiting" || chat.mark === "question"
            ? "Needs you"
            : chat.mark === "running"
              ? "Working"
              : chat.mark === "background"
                ? "In the background"
                : chat.unread
                  ? "Unread"
                  : "",
          chat.details?.branch,
        ]
          .filter(Boolean)
          .join(" · "),
        keywords: [chat.details?.path, ...(chat.details?.pullRequests ?? []).flatMap((pr) => [pr.title, `#${pr.number}`])].filter(Boolean).join(" "),
        run: () => openChat(Number(chat.id)),
      })),
    );
    commands.push(
      ...recentProjects
        .filter((recent) => recent.path !== current.path)
        .map((recent): Command => ({
          id: `project:${recent.path}`,
          label: recent.name,
          group: "Projects",
          icon: "folder",
          detail: recent.path,
          run: () => {
            leaveBots();
            void switchProject(recent.path);
          },
        })),
    );
    return commands;
  }

  // The Link on screen and the Project behind it (or the other way round) both stay mounted: the hidden one keeps
  // its DOM and state out of the document, with its effects and listeners off, so switching between them is one
  // insertion.
  const projectBridge = bridgeForKey(project.path);
  const projectWorkspace = (
    <BridgeContext.Provider value={projectBridge}>
      <ScopeContext.Provider value={project.path}>
        <DotBackground key="app">
          <PersistenceNotices scopes={globalUnsavedScopes}>
            <div className="pointer-events-none absolute bottom-5 right-5 z-50 max-w-[calc(100%-40px)] [&>*]:pointer-events-auto [-webkit-app-region:no-drag]">
              <ProviderUpdateNotice onSettings={openAccounts} onUpdated={handleProvidersUpdated} />
            </div>
            {hostConnection.connected && hostConnection.hostOutdated && (
              <div
                role="status"
                data-host-outdated
                className="flex w-full items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-[13px] leading-snug text-ink shadow-overlay [-webkit-app-region:no-drag]"
              >
                <span>{hostConnection.message ?? "Restart Milagre's background host to load large projects."}</span>
                <button
                  type="button"
                  disabled={restartingHost}
                  onClick={() => {
                    setRestartingHost(true);
                    void window.milagre
                      .restartHost()
                      .catch((error) => setNotice(`Couldn't restart the host: ${ipcErrorMessage(error)}`))
                      .finally(() => setRestartingHost(false));
                  }}
                  className="shrink-0 rounded-control bg-ink px-2.5 py-1 font-medium text-surface transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40"
                >
                  {restartingHost ? "Restarting…" : "Restart host"}
                </button>
              </div>
            )}
            {!hostConnection.connected && (
              <div
                role="status"
                data-host-disconnected
                className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-overlay [-webkit-app-region:no-drag]"
              >
                {hostConnection.failed ? (
                  <>
                    <p className="font-medium">Couldn't restart Milagre's background host</p>
                    <p className="mt-1 text-ink-2">{hostConnection.message} Your draft is kept here. Quit and reopen Milagre to try again.</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">Reconnecting to your computer</p>
                    <p className="mt-1 text-ink-2">Your draft is kept here. Messages will be available when the host reconnects.</p>
                  </>
                )}
              </div>
            )}
          </PersistenceNotices>
          <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
          {!botsShown && (
            <PanelToggles
              right={12}
              changes={
                changesAvailable
                  ? {
                      open: changes.open && !prShown,
                      toggle: () => {
                        if (!changes.open || prShown) changes.setMode(firstSection(changes.lists));
                        if (!prShown) changes.toggle();
                      },
                    }
                  : undefined
              }
              pullRequest={
                changesAvailable && prNumber
                  ? { number: prNumber, open: prShown, toggle: () => (prShown ? changes.toggle() : changes.showPullRequest()) }
                  : undefined
              }
            />
          )}
          {view === "chat" && !botsShown && (
            <LayoutToggle
              grid={layout === "grid"}
              offset={sidePanelCount(sidePanels, changesAvailable, changesAvailable && !!prNumber)}
              onToggle={toggleLayout}
            />
          )}
          {view === "chat" && !botsShown && focusedFamily && focusedFamily.children.length > 0 && (
            <SubchatsButton
              count={focusedFamily.children.length}
              shown={familyShown}
              offset={sidePanelCount(sidePanels, changesAvailable, changesAvailable && !!prNumber) + 1}
              onToggle={toggleFamily}
            />
          )}
          {showAttentionButton && !floatingInbox && !botsShown && attentionTitles[0] && (
            <AttentionButton
              label={attentionLabel(attentionTitles.map((item) => item.title || "Chat"))}
              items={attentionTitles.map((item) => ({
                ...item,
                asking: !agentRuns.runs[item.key]?.approvals.length,
                waitingFor: waitingFor(agentRuns.runs[item.key]),
              }))}
              offset={
                sidePanelCount(sidePanels, changesAvailable, changesAvailable && !!prNumber) +
                (view === "chat" ? 1 : 0) +
                (view === "chat" && focusedFamily && focusedFamily.children.length > 0 ? 1 : 0)
              }
              onOpen={openChatByKey}
            />
          )}
          <div
            className={`flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink ${appEntered ? "" : "app-enter"}`}
            onAnimationEnd={(event) => {
              if (event.animationName === "app-enter-main") setAppEntered(true);
            }}
          >
            <div
              className={`min-h-0 shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3 ${view === "chat" || view === "canvas" || view === "routines" ? "flex" : "hidden"}`}
            >
              <PullRequestOpenContext.Provider value={openRowPullRequest}>
                <OpenSubchatContext.Provider value={openBesideParent}>
                  <SidebarNav
                    fill
                    workspaceName={surfaces.name}
                    workspaceImage={projectImage(project.path)}
                    onSwitchLink={switchLinkFromSidebar}
                    onLinkProject={linkProjectFromSidebar}
                    onAddComputer={addComputerFromSidebar}
                    onOpenComputerSettings={openComputerSettings}
                    onEditLink={editLinkFromSidebar}
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
                    onOpenCanvas={openCanvas}
                    canvasActive={view === "canvas"}
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
                    runningKeys={sidebarRunKeys.running}
                    waitingKeys={sidebarRunKeys.waiting}
                    askingKeys={sidebarRunKeys.asking}
                    onOpenScopeChat={openScopeChat}
                    onScopeArchiveCheck={checkScopeArchive}
                    onScopeArchive={archiveScopeChat}
                    archivingChats={archivingChats}
                    onHoverChat={hoverChat}
                    onAskChat={askLinkedChat}
                    sidebarMode={sidebarMode}
                    onSidebarMode={setSidebarMode}
                    selectedBotId={selectedBotId}
                    onPickBot={pickBot}
                    models={models}
                    defaultModel={selectedModel}
                  />
                </OpenSubchatContext.Provider>
              </PullRequestOpenContext.Provider>
            </div>
            {view === "settings" && (
              <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
                <SettingsNav
                  section={shownSettingsSection}
                  project={shownSettingsProject}
                  current={surfaces.settings ? project : undefined}
                  onSelect={setSettingsSection}
                  computerId={settingsComputer ?? undefined}
                  onSelectComputer={selectSettingsComputer}
                  onSelectProject={(picked) => {
                    setSettingsProject(picked);
                    setSettingsSection("project");
                  }}
                  onBack={() => setView("chat")}
                />
              </div>
            )}

            <main data-workspace-main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent pr-3 pb-3">
              <DiffBar
                open={changes.diffOpen}
                onBack={changes.closeDiff}
                send={{ count: diffComments.sendable.length, onSend: () => void sendDiffComments() }}
                trailing={<DiffToolbar changes={changes} prefs={diffPrefs} />}
              />
              <AnimatePresence initial={false} onExitComplete={diffPresence.onExitComplete}>
                {changes.diffOpen && <DiffView key="diff" changes={changes} prefs={diffPrefs} comments={diffComments} review={prDiffReview} />}
              </AnimatePresence>
              {/* The open Chat's Routine (a Run Chat's, or a Heartbeat's), over the Chat; a grid's tiles show theirs in their headers. */}
              {view === "chat" && !diffPresence.occupied && shownTiles.length === 0 && focusedChatKey && (
                <RoutineChip chatKey={focusedChatKey} run={selectedSession?.routine} place="strip" onOpen={openRoutine} />
              )}
              {view === "settings" && (
                <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                  {notice && (
                    <NoticeCard className="mx-auto mt-2 mb-1 max-w-2xl" onDismiss={() => setNotice(null)}>
                      {notice}
                    </NoticeCard>
                  )}
                  <SettingsPanel
                    section={shownSettingsSection}
                    project={shownSettingsProject}
                    computerId={settingsComputer ?? undefined}
                    models={models}
                    update={update}
                    onSectionChange={setSettingsSection}
                    onAddComputer={() => setAddComputerOpen(true)}
                    onOpenUsageChat={openUsageChat}
                  />
                </div>
              )}
              {view === "canvas" && (
                <CanvasView
                  states={states}
                  runs={agentRuns.runs}
                  linkedWork={linkedWork}
                  onOpenChat={(path, id) => void openCanvasChat(path, id)}
                  onNewChat={(path) => {
                    setView("chat");
                    newChatInScope(path);
                  }}
                  onBack={() => setView("chat")}
                />
              )}
              {/* A Run's Chat opens beside its Routine's page: the two sit side by side, the Chat pane in a card of its own.
                  The wrappers stay mounted (display: contents otherwise), so neither side remounts as the pane opens. */}
              <div
                data-routine-split={runPaneOpen || undefined}
                className={runPaneOpen ? "flex min-h-0 flex-1 gap-3 pt-[var(--window-chrome-height)]" : "contents"}
              >
                <div className={runPaneOpen ? "flex min-h-0 w-[420px] shrink-0 flex-col" : "contents"}>
                  {view === "routines" && (
                    <RoutinesPage
                      models={models}
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
                </div>
                {/* Fades back in when the diff has gone: a display:none element restarts its animation when shown. */}
                <div
                  data-chat-pane
                  data-run-chat-pane={runPaneOpen || undefined}
                  className={`min-h-0 flex-1 flex-col overflow-hidden ${(view === "chat" && !botsShown && !diffPresence.occupied) || runPaneOpen ? "flex" : "hidden"} ${runPaneOpen ? "min-w-0 rounded-[14px] border border-line bg-surface [&_.chat-column]:pt-4" : ""}`}
                  // In the pane the Chat sits under its own header, not under the window's title bar.
                  style={
                    runPaneOpen
                      ? ({ animation: "fade-in 160ms ease-out", "--window-chrome-height": "0px" } as CSSProperties)
                      : { animation: "fade-in 160ms ease-out" }
                  }
                >
                  {runPaneOpen && focusedChatKey && selectedSession && (
                    <RunChatHeader
                      chatKey={focusedChatKey}
                      title={chatTitle(selectedSession, displayedMessages)}
                      branch={showGit ? selectedWorktree?.name : undefined}
                      onClose={closeRunPane}
                    />
                  )}
                  {awayBanner && lean && selectedSession && !chatWindow.loading && chatWindow.messages.length === 0 && <OfflineEmpty />}
                  <ChatGrid
                    keys={shownTiles}
                    focused={gridFocusKey}
                    states={gridStates}
                    runs={agentRuns.runs}
                    delegated={delegatedKeys}
                    models={models}
                    onFocus={openLinkedChat}
                    onOpenRoutine={openRoutine}
                    onDismiss={dismissTile}
                    pinned={pinnedTiles}
                    onTogglePin={toggleGridPin}
                    onClose={splitOn ? closeSplitTile : undefined}
                  >
                    <EditorLinks
                      root={isRemoteKey(project.path) ? "" : (selectedWorktree?.path ?? project.path)}
                      files={selectedWorktree?.path ?? (isRemoteKey(project.path) ? "" : project.path)}
                    >
                      {/* One composer across Projects: its parked transcripts (TranscriptSlots) outlive a Project switch. */}
                      <DraftChatComposer
                        store={draftStore}
                        offScreen={!((view === "chat" && !botsShown) || runPaneOpen)}
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
                        // A draft becoming its saved Chat shows that Chat's window, not the selected one's.
                        trimHistory={lean && !(pendingHere && pendingCanonicalId !== null) ? chatWindow.trim : undefined}
                        onSend={() => void sendMessage()}
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
                        sendBlocked={preparingHere}
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
                        streamingText={run?.text}
                        streamingSteps={run?.steps}
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
                        onOpenLinkedChat={openMessageChat}
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
                        newChatProject={{ key: project.path, name: project.name, kind: project.kind, onChange: moveNewChat }}
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
                          saveChatPreferences(localStorage, project.path, { baseBranch: branch });
                        }}
                        newChatError={newChatError}
                        composerNote={runPaneOpen && selectedSession?.routine?.hidden ? RUN_CHAT_REPLY_NOTE : undefined}
                        findOpen={findOpen}
                        findSignal={findSignal}
                        findSeed={findSeed}
                        onFindClose={() => setFindOpen(false)}
                        saveNotice={dockSaveNotice}
                        notice={notice}
                        onDismissNotice={() => setNotice(null)}
                        approvalHidden={questionSent && !pendingApproval && !remoteDelegations.length}
                        approval={
                          pendingApproval || pendingQuestion || remoteDelegations.length ? (
                            <div className="flex w-full flex-col gap-2">
                              {pendingApproval ? (
                                <PermissionCard
                                  key={`${chatKey(project.path, selectedSession?.id ?? 0)}:${pendingApproval.requestId}`}
                                  request={pendingApproval}
                                  waiting={(run?.approvals.length ?? 1) - 1}
                                  answering={sentDecision(run, pendingApproval.requestId)}
                                  onAnswer={answerApproval}
                                />
                              ) : pendingQuestion ? (
                                // Hidden, not unmounted, while the answers travel: if they don't arrive, the card comes back as it was.
                                <div className={questionSent ? "hidden" : "contents"}>
                                  <QuestionCard
                                    key={`${chatKey(project.path, selectedSession?.id ?? 0)}:${pendingQuestion.requestId}`}
                                    request={pendingQuestion}
                                    waiting={(run?.questions.length ?? 1) - 1}
                                    answering={sentReply(run, pendingQuestion.requestId)}
                                    onAnswer={answerQuestion}
                                  />
                                </div>
                              ) : null}
                              {/* Delegations this Chat sent to other computers, their turns mirrored live from there. */}
                              {remoteDelegations.map((delegation) => (
                                <RemoteDelegationCard
                                  key={delegation.id}
                                  delegation={delegation}
                                  run={delegation.to_chat ? agentRuns.runs[delegation.to_chat] : undefined}
                                  onAnswer={(requestId, decision) => {
                                    if (delegation.to_chat) void agentRuns.respond(delegation.to_chat, requestId, decision).catch(() => {});
                                  }}
                                  onOpenChat={openChatKey}
                                  onStop={(key) => void agentRuns.interrupt(key).catch(() => {})}
                                />
                              ))}
                            </div>
                          ) : undefined
                        }
                      />
                    </EditorLinks>
                  </ChatGrid>
                  <GridDropOverlay />
                  <TerminalPanel chatId={terminalChatId} notify={setNotice} />
                </div>
              </div>
              {botsShown && selectedBot && bots.snapshot && (
                <BotThread
                  key={selectedBot.id}
                  bot={selectedBot}
                  snapshot={bots.snapshot}
                  agents={agentRuns}
                  preferences={{ models, cliStatus, onModelPickerOpen: refreshCliStatus, onUpdateCli: handleUpdateCli, updatingCli }}
                  onOpenChat={openChatKey}
                  profileOpen={botProfileOpen}
                  onToggleProfile={() => setBotProfileOpen((open) => !open)}
                />
              )}
            </main>
            <BotProfileSlot open={botsShown && botProfileOpen && Boolean(selectedBot)}>
              {selectedBot && bots.snapshot && <BotProfilePanel key={selectedBot.id} bot={selectedBot} snapshot={bots.snapshot} onOpenChat={openChatKey} />}
            </BotProfileSlot>
            <ChangesPanelSlot open={changes.open && !botsShown}>
              <ChangesPanel
                lists={changes.lists}
                comparison={changes.comparison}
                mode={changes.mode}
                onModeChange={changes.setMode}
                onRefresh={() => {
                  if (changes.mode !== "pr") return changes.refresh();
                  localChanges.refresh();
                  return Promise.all([changes.refresh(), prReview.refresh()]);
                }}
                onSelectFile={changes.selectFile}
                activePath={changes.activePath}
                commentCounts={diffComments.counts}
                pullRequest={
                  prNumber
                    ? {
                        number: prNumber,
                        choices: rowPullRequests(selectedPullRequests),
                        onPick: (number) => prChatKey && setPrPick({ chat: prChatKey, number }),
                        loading: prReview.state.status === "loading" || prReview.busy !== null,
                        body: (
                          <PullRequestPanelBody
                            review={prReview}
                            source={selectedWorktree ? { bridge: bridgeForKey(prChatKey).pr, cwd: selectedWorktree.path } : undefined}
                            actions={prPanelActions}
                            activePath={changes.activePath}
                            local={{ count: localChanges.count, onOpen: () => changes.setMode(firstSection(changes.lists)) }}
                          />
                        ),
                      }
                    : undefined
                }
              />
            </ChangesPanelSlot>
          </div>
          {linkDialog}
          {addComputerDialog}
          {addProjectDialog}
          {commandPaletteOpen && (
            <CommandPalette
              commands={buildCommands(project)}
              searchMessages={
                lean
                  ? undefined
                  : (query) =>
                      messageCommands(sidebarState?.messages ?? NO_MESSAGES, query, new Map(chats.map((chat) => [Number(chat.id), chat.label])), openMessage)
              }
              searchMessagesAsync={
                lean && project
                  ? async (query) =>
                      messageCommandsFrom(
                        await bridgeForKey(project.path).searchChats(project.path, query),
                        new Map(chats.map((chat) => [Number(chat.id), chat.label])),
                        openMessage,
                      )
                  : undefined
              }
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
              turnRunning={Boolean(agentRuns.runs[chatKey(project.path, gitDialog.sessionId)])}
              onClose={() => setGitDialog(null)}
              // The dialog's chat is the open one; a message sent while its turn runs steers it.
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
        {quitError && (
          <dialog
            ref={(element) => {
              if (element && !element.open) element.showModal();
            }}
            onCancel={(event) => event.preventDefault()}
            className="fixed inset-0 m-0 h-screen w-screen max-w-none max-h-none items-center justify-center bg-black/40 backdrop-blur-overlay p-6 open:flex"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="save-failure-title"
          >
            <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 text-ink shadow-xl">
              <h2 id="save-failure-title" className="text-lg font-semibold">
                Chats could not be saved
              </h2>
              <p className="mt-3 text-sm">Keep Milagre open while you fix the storage problem, then retry saving.</p>
              <p className="mt-3 break-words text-sm text-ink-2">{quitError}</p>
              <button
                autoFocus
                className="mt-5 rounded-lg bg-ink px-4 py-2 text-sm text-surface"
                onClick={() => void window.milagre.retryQuit().catch((error) => setQuitError(ipcErrorMessage(error)))}
              >
                Retry saving and quit
              </button>
            </div>
          </dialog>
        )}
      </ScopeContext.Provider>
    </BridgeContext.Provider>
  );
  return (
    <>
      <WorkspaceSlots
        shown={selectedLink ? "link" : "project"}
        slots={[...(linkWorkspace ? [{ key: "link", element: linkWorkspace }] : []), { key: "project", element: projectWorkspace }]}
      />
      {/* The Project's copy of these sits in the hidden tree while a Link is on screen. */}
      {selectedLink && linkDialogs}
    </>
  );
}

/**
 * The workspaces a window keeps mounted: the one on screen, in the host, and the hidden ones in nodes of their own
 * outside the document (as ChatComposer parks transcripts), so nothing that queries the document meets them. A hidden
 * one is an <Activity> in its hidden mode: its state and DOM stay, its effects and listeners stop.
 */
function WorkspaceSlots({ shown, slots }: { shown: string; slots: { key: string; element: ReactNode }[] }) {
  const [nodes] = useState(() => new Map<string, HTMLDivElement>());
  const nodeFor = (key: string) => {
    let node = nodes.get(key);
    if (!node) {
      node = document.createElement("div");
      node.className = "contents";
      node.dataset.workspaceSlot = key;
      nodes.set(key, node);
    }
    return node;
  };
  // The host takes the shown slot's node as a ref, in the layout phase before the portals' own layout effects.
  const host = useCallback(
    (hostNode: HTMLDivElement | null) => {
      if (!hostNode) return;
      for (const child of Array.from(hostNode.children)) if (child !== nodes.get(shown)) child.remove();
      const node = nodeFor(shown);
      if (node.parentElement !== hostNode) hostNode.appendChild(node);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new callback per shown slot is what makes React run it again
    [shown],
  );
  return (
    <>
      <div ref={host} className="contents" />
      {slots.map((slot) => createPortal(<Activity mode={slot.key === shown ? "visible" : "hidden"}>{slot.element}</Activity>, nodeFor(slot.key), slot.key))}
    </>
  );
}

/** A Linear issue a new chat starts from: its key and the workspace it was picked in. */
type IssueRef = Pick<LinearIssue, "key" | "workspace">;
export default function AppWithUpdates() {
  return (
    <UpdateShell>
      <App />
      {/* Beside the app, so it asks whatever screen is open, Settings and Links included. */}
      <ComputerAllowPrompt />
    </UpdateShell>
  );
}
