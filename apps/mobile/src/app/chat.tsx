import { UI_COPY } from "@milagre/shared/model-copy";
import { withReportPrompt } from "@milagre/shared/bug-report";
import type { BranchPolicySettings } from "@milagre/shared/branch-policy";
import { chrome, lineHeight, type } from "../design-tokens";
import { useCompactionFeedback } from "@milagre/shared/use-compaction-feedback";
import { useContextSettings } from "../context-settings";
import { COMPACT_COMMAND, compactionContext, isCompaction } from "@milagre/shared/compaction";
import {
  ArrowDown01Icon,
  Globe02Icon,
  GitPullRequestIcon,
  Cancel01Icon,
  CleanIcon,
  LaptopIcon,
  Link04Icon,
  MoreHorizontalIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { outbox, outboxAttachments, hasQueuedChat } from "../outbox";
import { LINK_CHAT_WORKTREES_TEXT, isWorktreeLinked, linkDeletedElsewhereText } from "@milagre/shared/worktree-link";
import { GenerativeUIProvider } from "../genui/GenerativeUI";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatHistory } from "@milagre/shared/chat-history";
import type Reanimated from "react-native-reanimated";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Redirect, Stack, router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import type { NavigationProp } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sessionForWorktree } from "@milagre/shared/model";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { compactButtonState } from "@milagre/shared/chat-display";
import { useCompactButtonDisplay, useNewChatStats, useShowContextSize } from "../chat-display-setting";
import type { ChatMessage, LinkIssueResult, PullRequestActionContext } from "@milagre/shared/model";
import { BtwDock, messageForkAction } from "../chat-branch-actions";
import { CHAT_COMMANDS, STORAGE_COMMANDS, NO_CHECKPOINTS, composerCommandHandler, readComposerDraft } from "../chat-commands";
import { useBtw } from "../use-btw";
import { chatTitle, createPendingChat, createResendMemory, pendingChatSessionId } from "@milagre/shared/chats";
import { sendStatusLabel } from "@milagre/shared/tool-activity";
import { messageNavigationIndices } from "@milagre/shared/message-navigation";
import { LINK_PR_HINT, type LinearIssue } from "@milagre/shared/linear";
import { worktreeShared } from "@milagre/shared/archive";
import type { Client, OpenProject, Snapshot } from "../client";
import { answeredQuestions, lastUserModel, projectOfKey, secretAnswerFlag, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { pullRequestActionBody, pullRequestActionPrompt, pullRequestActionRequest } from "@milagre/shared/pr-action";
import { issueChoiceId, issueSendFields, issueStartContext, issueStartMessage, issueWorktreeFields, type PickedIssue } from "@milagre/shared/issue-start";
import { pickGithubIssue, pickLinearIssue } from "../issue-pickers";
import { useGithubIssuesAvailable } from "../use-github-issues";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { ChatLinkProvider, chatLinks } from "../chat-link-context";
import { composerQuote, quotedMessage, quoteSource, type ComposerQuote } from "@milagre/shared/prompt-parts";
import type { QuoteFrom } from "../message-actions";
import { useReachableHost } from "../routes-native";
import { sameSession, useComposer, useMainSession, usePendingChats, useRunShape, useSession } from "../session";
import { useChatEdit } from "../use-chat-edit";
import { checkpointLine } from "../message-edit-divider";
import { ChatComposerDock } from "../chat-composer-dock";
import { useTaskEffort } from "../use-orchestrator";
import { ChatsTrayLabel, IssueButton, NewChatTray } from "../new-chat-tray";
import { pendingOnScreen, pendingOrigin } from "../pending-chats";
import { composerPlaceholder } from "../composer-placeholder";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import { pickAttachments, preparePastedImage, discardPastedImage, type PastedImage } from "../attachment-picker";
import { chatMentionChoices, type MentionComputer } from "@milagre/shared/prompt-mentions";
import {
  addMention,
  appendAttachments,
  appendImageMentions,
  attachmentPrompt,
  mentionAttachments,
  prepareAnswerImages,
  prepareAttachments,
} from "../attachments";
import { BackgroundRing } from "../status-indicators";
import { ChatHeaderSubtitle } from "../chat-header-subtitle";
import { TabCountAction, useWorkspaceTabSync, WorkspaceTabStrip } from "../workspace-tabs-panel";
import { tabsAt } from "../workspace-tabs-kinds";
import { useWorkspaceTabs } from "../workspace-tabs-store";
import { openPrPage, openPullRequest } from "../pr-nav";
import { NewChatGlance } from "../new-chat-glance";
import { onPullRequestRequest, prChoiceKey, registerPrChat, type PrChoice } from "../pr-chat";
import { READING_WIDTH, widthClass } from "../split-width";
import { backgroundItems, chatActivity } from "@milagre/shared/chat-activity";
import { useBrowserShortcut } from "../browser";
import { useInternalBrowser } from "../browser-setting";
import { openBrowserLink } from "../browser-link";
import { useChatPorts } from "../ports";
import { TerminalDock, terminalPlaces } from "../terminal";
import { KeyboardChatScrollView, KeyboardStickyView, useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { ChatReply, ChatRow, type ReplyChat } from "../chat-reply";
import { onSendDesignMessageNow, sendWaitingDesign, type DesignMessage } from "../design-outbox";
import { PanelTabsContext } from "../panel-tabs";
import { chosenDesign } from "@milagre/shared/artifact";
import { HandoffDivider } from "../handoff-divider";
import { showBrief } from "../handoff-brief-store";
import { foldLinkedExchanges } from "@milagre/shared/linked-message";
import { WorktreeLinkDivider } from "../worktree-link-divider";
import { AccountSwitchDivider, LimitResetDivider } from "../account-switch-divider";
import { ChatReloadDivider } from "../chat-reload-divider";
import { BabysitStoppedDivider } from "../babysit-stopped-divider";
import { ValidationCard, isValidation } from "../validation-card";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import type { CheckpointApi } from "@milagre/shared/checkpoints";
import { type UndoIntent } from "../undo-panel";
import { isChatReload } from "@milagre/shared/chat-reload";
import { isBabysitStopped } from "@milagre/shared/babysit";
import { RoutineRunDivider } from "../routine-run-divider";
import { chatBranchLabel, RUN_WORKTREE_REMOVED_NOTE, chatRoutine, clock, groupQuietRuns, isRoutineRun } from "@milagre/shared/routines";
import { navigationLabel } from "../navigation-label";
import { isHandoff } from "@milagre/shared/handoff";
import { CompactionDivider } from "../compaction-divider";
import { isAccountSwitch, isLimitReset } from "@milagre/shared/usage-limit";
import { BackgroundIndicator } from "../running-logo";
import { RunIndicator } from "../run-indicator";
import { EdgeFade } from "../bottom-fade";
import { useDotBackground } from "../dot-background";
import { answersWithImages } from "../questions";
import { followUpDelivery } from "@milagre/shared/queued-messages";
import { afterSend, chatPreferences, modelsFor, selectedModel, sendOptions, turnTarget } from "../turn-options";
import { Icon } from "../icons";
import { PanelSwipe, useSidePanels } from "../side-panels";
import { useSplitLayout } from "../split-context";
import { useReadOpenChat } from "../read-open-chat";
import { LoadingLogo } from "../loading-logo";
import { useOpenProject } from "../use-open-project";
import { HeaderAction, HeaderActionGroup } from "../primitives/header-action-group";
import { ErrorNotice, GlassIconButton, PillButton, PullDown, pressStyle, useStyles } from "../ui";
import { clearSentDraft } from "../draft-clear";
import { createKnownFiles, mentionPaths } from "../file-mentions";
import { PlanPanel, usePlanPanel } from "../plan-pill";
import { SubchatPanel, useSubchatPanel } from "../subchat-pill";
import { useTheme } from "../theme";
import { ToastPill } from "../primitives/toast";
import { useHistoryToast } from "../undo-history";
import { leaveToList, markChatDone, settleActions, SettleFlight } from "../settle-flight";
import { archiveFromPhone, showArchiveNotice } from "../archive";
import { randomUUID } from "expo-crypto";
import { runChatAction } from "../chat-actions";
import { MessageNavigation } from "../message-navigation";
import { FloatingInboxSlot } from "../attention";
import { useLinear } from "../use-linear";
import { useRoutines } from "../use-routines";
import { useActivityClock } from "../chat-row-store";
import { useWorktreeLinearIssues } from "../use-worktree-linear-issues";
import { savedChatDefaults } from "../hosts-native";
import { showChoiceSheet } from "../choice-store";
import { allComputers, chatsHomePath, useComputerViews, useNewChatProjects, useNoProjectChoice } from "../all-computers";
import { isChatsHomeProject, JUST_CHAT_HEADING, NO_PROJECT_FOLDER, NO_PROJECT_LABEL, NO_PROJECT_LINE } from "@milagre/shared/chats-home";
import { newChatLinks as linksOf, newChatProjectGroups, openNewChatCopies, otherCopies, preferredCopy, type NewChatProject } from "../new-chat-project";
import { ChatsHomeIcon, ProjectIcon, ProjectIcons } from "../project-icon";
import { panelWorktree } from "../project-surfaces";
import { besideState, closeBeside, openBeside, useBesideChat } from "../split-chats";
import { chatBookmark, chatFamily } from "@milagre/shared/subchats";
import { subchatNotes, isSilentNote } from "../subchat-notes";
import { SubchatBookmarkHost } from "../subchat-bookmark";
import { BESIDE_PARENT } from "../subchat-family";
import { BesideSession, touchPane } from "../beside-session";
import { SENT_FROM } from "../sent-from";
import { promptText } from "../text-prompt";
import { useVisibleRunChatKeys } from "../visible-run-chats";
import { useArtifactShortcuts } from "../chat-artifact-shortcuts";
import { openLinearIssue } from "../issue-card";
import {
  ChatStackOptions,
  ChatToolbar,
  FamilyTitleMenu,
  HeaderTitleBox,
  HiddenHeaderOptions,
  SidebarButton,
  SidebarToolbar,
  chatPaneMenu,
} from "../chat-header";
import { issueRunDivider, LiveReply, transcriptRows, useLiveSteps } from "../chat-transcript-rows";
import { useChatPrs, useChatTranscriptData } from "../chat-transcript-data";
import { nextFollow, useTranscriptFollow } from "../chat-follow";

const PAGE = 40;
const KEEP_VISIBLE_POSITION = { minIndexForVisible: 0 };
const PLACE_FALLBACK_MS = 500;

const COMPACT_TRAY_ROW_WIDTH = 460;

type ChatParams = { id?: string; worktreeId?: string; projectPath?: string; hostId?: string; draft?: string; prefill?: string };

const NO_QUOTES: ComposerQuote[] = [];

export default function ChatScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<ChatParams>();
  const session = useSession();
  const split = useSplitLayout();
  const beside = useBesideChat();
  const sessions = session.snapshot?.project.state.sessions;
  const state = besideState(beside, {
    wide: split.widthClass === "wide",
    hostId: params.hostId || session.client?.url,
    projectPath: params.projectPath || session.snapshot?.project.path,
    chatId: params.id ? Number(params.id) : undefined,
    loadedPath: session.snapshot?.project.path,
    exists: (id) => !!sessions?.[id],
  });
  useEffect(() => {
    if (state === "ended") closeBeside();
  }, [state]);
  const routeKey = `${params.hostId}|${params.projectPath}|${params.id}|${params.worktreeId}`;
  const routed = useRef(routeKey);
  useEffect(() => {
    if (routed.current === routeKey) return;
    routed.current = routeKey;
    closeBeside();
  }, [routeKey]);
  const shown = state === "shown" && beside ? beside : null;
  const promote = useCallback(() => {
    if (!shown) return;
    router.setParams({ id: String(shown.chatId), worktreeId: undefined, draft: undefined, prefill: undefined });
    closeBeside();
  }, [shown]);
  const [typing, setTyping] = useState<"routed" | "beside">("routed");
  const besideTyping = Boolean(shown) && typing === "beside";
  const routedTypes = useCallback(() => setTyping("routed"), []);
  const besideTypes = useCallback(() => setTyping("beside"), []);
  const routedTouched = useCallback(() => touchPane("routed"), []);
  const besideTouched = useCallback(() => touchPane("beside"), []);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
      <SettleFlight style={{ flex: 1, overflow: "hidden" }} onTouchStart={routedTouched}>
        <ChatPane key="routed" params={params} pane={shown ? "primary" : "single"} keyboard={!besideTyping} onTyping={routedTypes} onClose={promote} />
      </SettleFlight>
      {shown && (
        <>
          <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.line }} />
          <SettleFlight style={{ flex: 1, overflow: "hidden" }} onTouchStart={besideTouched}>
            <BesideSession key={`${shown.hostId}|${shown.projectPath}`} chat={shown}>
              <ChatPane
                key={`${shown.hostId}|${shown.projectPath}#${shown.chatId}`}
                params={{ id: String(shown.chatId), hostId: shown.hostId, projectPath: shown.projectPath }}
                pane="secondary"
                keyboard={besideTyping}
                onTyping={besideTypes}
                onClose={closeBeside}
              />
            </BesideSession>
          </SettleFlight>
        </>
      )}
    </View>
  );
}

function ChatPane({
  params: routeParams,
  pane,
  keyboard: ownsKeyboard,
  onTyping,
  onClose,
}: {
  params: ChatParams;
  pane: "single" | "primary" | "secondary";
  keyboard: boolean;
  onTyping: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [showContextSize] = useShowContextSize();
  const [newChatStats] = useNewChatStats();
  const { settings: contextSettings } = useContextSettings();
  const [compactButtonDisplay] = useCompactButtonDisplay();
  const [internalBrowser] = useInternalBrowser();
  const [arriving, setArriving] = useState<ChatParams | null>(null);
  const params = arriving ?? routeParams;
  useEffect(() => {
    if (
      arriving &&
      routeParams.hostId === arriving.hostId &&
      routeParams.projectPath === arriving.projectPath &&
      routeParams.worktreeId === arriving.worktreeId
    )
      setArriving(null);
  }, [arriving, routeParams.hostId, routeParams.projectPath, routeParams.worktreeId]);
  const navigation = useNavigation<NavigationProp<{ chat: { worktreeId?: string } }, "chat">>();
  const secondary = pane === "secondary";
  const paired = pane !== "single";
  const [ownDraft] = useState(() => randomUUID());
  const draftId = params.draft || ownDraft;
  const session = useSession();
  const openSession = useMainSession();
  const ownProject = !sameSession(session, openSession);
  const composer = useComposer();
  const pendingStore = usePendingChats();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const split = useSplitLayout();
  const column = { width: "100%", maxWidth: READING_WIDTH, alignSelf: "center" } as const;
  const [actionBusy, setBusy] = useState(false);
  const [sentAnswers, setSentAnswers] = useState<{ requestId: string; message: ChatMessage | null; count: number } | null>(null);
  const sendingRef = useRef(new Set<string>());
  const [sendingKeys, setSendingKeys] = useState<string[]>([]);
  const knownFiles = useRef(createKnownFiles());
  const failedSends = useRef(createResendMemory());
  const [picking, setPicking] = useState(false);
  const [trayRowWidth, setTrayRowWidth] = useState(0);
  const [dockHeight, setDockHeight] = useState(140);
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const [terminalMounted, setTerminalMounted] = useState<string | null>(null);
  const [terminalHeight, setTerminalHeight] = useState(0);
  const [terminalCount, setTerminalCount] = useState<number | undefined>(undefined);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const askChatId = `${session.snapshot?.project.path ?? ""}#${params.id ?? `new:${params.worktreeId}`}`;
  const askProvider = params.id ? session.snapshot?.project.state.sessions[Number(params.id)]?.provider : undefined;
  const askTarget = useRef({ chatId: "", provider: askProvider, setQuotes: composer.setQuotes });
  useEffect(() => {
    askTarget.current = { chatId: askChatId, provider: askProvider, setQuotes: composer.setQuotes };
  });
  const askAboutPassage = useCallback((passage: string, from: QuoteFrom) => {
    const { chatId: target, provider, setQuotes } = askTarget.current;
    const quote = composerQuote(passage, quoteSource(from, provider));
    if (!quote) return;
    setQuotes((current) => ({ ...current, [target]: [...(current[target] || []), quote] }));
    setComposerFocusRequest((value) => value + 1);
  }, []);
  const [error, setError] = useState("");
  const [linkVersion, setLinkVersion] = useState(0);
  const [toast, setToast] = useState<{ text: string } | null>(null);
  const historyToast = useHistoryToast("chat");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const undoClient = session.client;
  const checkpointApi = useMemo<CheckpointApi | null>(
    () =>
      undoClient
        ? {
            list: (request) => undoClient.call("checkpoint:list", [request]),
            preview: (request) => undoClient.call("checkpoint:preview", [request]),
            restore: (request) => undoClient.call("checkpoint:restore", [request]),
          }
        : null,
    [undoClient],
  );
  const undo = useCheckpoints(checkpointApi ?? NO_CHECKPOINTS, session.snapshot && params.id ? `${session.snapshot.project.path}#${params.id}` : "");
  const [undoIntent, setUndoIntent] = useState<UndoIntent>("Undo");
  const targetHost = params.hostId || session.client?.url || "";
  const bookmark =
    !secondary && params.id && session.snapshot ? chatBookmark(session.snapshot.project.state.sessions, `${session.snapshot.project.path}#${params.id}`) : null;
  const topClear = insets.top + (bookmark ? 100 : 84);
  const reachableHost = useReachableHost(session.client?.url);
  const targetProject = params.projectPath || session.snapshot?.project.path || "";
  const targetScope = JSON.stringify([targetHost, targetProject]);
  const [targetChoice, setTargetChoice] = useState(() => ({ scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) }));
  const target = targetChoice.scope === targetScope ? targetChoice : { scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) };
  if (targetChoice.scope !== targetScope) setTargetChoice(target);
  const { isolation: pickedIsolation, baseBranch = "" } = target;
  const [explicitBase, setExplicitBase] = useState<{ scope: string; branch: string } | null>(null);
  const [projectGit, setProjectGit] = useState<{ client: Client; path: string; base: string } | null>(null);
  const chooseTarget = (patch: Partial<typeof target>) => {
    if (patch.baseBranch !== undefined) setExplicitBase({ scope: targetScope, branch: patch.baseBranch });
    setTargetChoice({ ...target, ...patch });
    void savedChatDefaults.saveTarget(targetHost, targetProject, patch);
  };
  const [branchList, setBranchList] = useState<{ client: Client; path: string; items: string[]; error?: string } | null>(null);
  const preparedTarget = useRef<{ client: Client; path: string; base: string; issueKey?: string; worktreeId: number; sessionId: number } | null>(null);
  const scroll = useRef<Reanimated.ScrollView>(null);
  const dots = useDotBackground();
  const { following, scrollingToBottom, dragging, cancelEndFrame, scrollToBottom, dragHandlers } = useTranscriptFollow(scroll);
  const contentHeight = useRef(0);
  const scrollOffset = useRef(0);
  const historyRead = useRef<object | null>(null);
  const pickingNow = useRef(false);
  const historyAnchor = useRef<{ id: number; y: number; offset: number; key: string } | null>(null);
  const scrollScope = `${params.hostId || session.client?.url}|${params.projectPath || session.snapshot?.project.path}`;
  const routeKey = `${scrollScope}|${params.id ?? `new:${params.worktreeId}`}`;
  const [scrollIdentity, setScrollIdentity] = useState({ route: routeKey, key: routeKey, revision: 0 });
  const scrollKey = scrollIdentity.route === routeKey ? scrollIdentity.key : `${routeKey}|${scrollIdentity.revision + 1}`;
  if (scrollIdentity.route !== routeKey) setScrollIdentity({ route: routeKey, key: scrollKey, revision: scrollIdentity.revision + 1 });
  const adoptChat = useCallback(
    (id: number) => {
      setScrollIdentity((current) => ({ ...current, route: `${scrollScope}|${id}`, key: scrollKey }));
      if (!secondary) router.setParams({ id: String(id) });
    },
    [scrollScope, scrollKey, secondary],
  );
  const currentScrollKey = useRef(scrollKey);
  const [historyState, setHistoryState] = useState({ key: scrollKey, loading: false, error: "" });
  const [jumpState, setJumpState] = useState({ key: scrollKey, visible: false });
  const showJumpToBottom = jumpState.key === scrollKey && jumpState.visible;
  const [underHeader, setUnderHeader] = useState(false);
  const [placedKey, setPlacedKey] = useState<string | null>(null);
  const placed = placedKey === scrollKey;
  const placeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEndVisible = useCallback(
    (visible: boolean) => {
      setJumpState((current) => (current.key === scrollKey && current.visible === !visible ? current : { key: scrollKey, visible: !visible }));
      if (visible) setPlacedKey(scrollKey);
    },
    [scrollKey],
  );
  const jumpToBottom = useCallback(() => {
    following.current = true;
    scrollToBottom(false);
    setJumpState({ key: scrollKey, visible: false });
  }, [scrollKey, scrollToBottom]);
  useEffect(() => {
    following.current = true;
    scrollingToBottom.current = false;
    contentHeight.current = 0;
    scrollOffset.current = 0;
    currentScrollKey.current = scrollKey;
    historyRead.current = null;
    historyAnchor.current = null;
    return () => {
      clearTimeout(placeTimer.current);
      placeTimer.current = undefined;
      cancelEndFrame();
    };
  }, [scrollKey, cancelEndFrame]);
  const viewport = useRef(0);
  const place = () => {
    if (placed || !viewport.current || !contentHeight.current) return;
    if (contentHeight.current <= viewport.current) {
      setPlacedKey(scrollKey);
      return;
    }
    scrollToBottom(false);
    placeTimer.current ??= setTimeout(() => setPlacedKey(scrollKey), PLACE_FALLBACK_MS);
  };
  const worktreeOf =
    session.snapshot?.project.state.worktrees[
      (params.id ? session.snapshot.project.state.sessions[Number(params.id)]?.worktree_id : Number(params.worktreeId)) ?? -1
    ];
  const connected = session.client;
  const projectPath = session.snapshot?.project.path;
  const readProjectGit = useCallback(() => {
    if (!connected || !projectPath || session.snapshot?.project.link || params.id) return;
    let live = true;
    connected.call<BranchPolicySettings>("project-git:read", [projectPath]).then(
      (value) => {
        if (live && value?.effective) setProjectGit({ client: connected, path: projectPath, base: value.effective.baseBranch });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [connected, projectPath, session.snapshot?.project.link, params.id]);
  useEffect(readProjectGit, [readProjectGit]);
  useFocusEffect(readProjectGit);
  const mentionState = session.snapshot?.project.state;
  const mentionLink = session.snapshot?.project.link;
  const liveRun = useRunShape(params.id && projectPath ? `${projectPath}#${params.id}` : undefined);
  const { items: pages, select: openPage } = useArtifactShortcuts(session.client, projectPath, params.id);
  useVisibleRunChatKeys(session.client, params.id && projectPath ? [`${projectPath}#${params.id}`] : []);
  const mentionKey = JSON.stringify(mentionState && !mentionLink ? chatMentionChoices(mentionState) : []);
  const mentionChats = useMemo(() => JSON.parse(mentionKey) as ReturnType<typeof chatMentionChoices>, [mentionKey]);
  const replyChatsKey = JSON.stringify(mentionChats.map(({ id, title, available }) => ({ id, title, available })));
  const replyChats = useMemo(() => JSON.parse(replyChatsKey) as ReplyChat[], [replyChatsKey]);
  const computerViews = useComputerViews();
  const mentionHost = connected?.url;
  const mentionComputerKey = JSON.stringify([
    ...(session.hostName && !computerViews.some((view) => view.hostId === mentionHost)
      ? [{ id: mentionHost ?? "this", name: session.hostName, online: true, self: true }]
      : []),
    ...computerViews.map((view) => ({ id: view.hostId, name: view.name, online: view.state === "online", self: view.hostId === mentionHost })),
  ]);
  const mentionComputers = useMemo(() => JSON.parse(mentionComputerKey) as MentionComputer[], [mentionComputerKey]);
  const { active: linearActive } = useLinear(connected);
  const { routines, enabled: routinesOn } = useRoutines(connected);
  const beating = routinesOn === true && routines.some((routine) => routine.enabled && routine.target.kind === "chat");
  const now = useActivityClock(beating);
  const chatsHomeOpen = isChatsHomeProject(session.snapshot?.project);
  const linearIssues = useWorktreeLinearIssues(
    connected,
    linearActive && projectPath && !session.snapshot?.project.link && !chatsHomeOpen ? [projectPath] : [],
    linkVersion,
  );
  const githubIssues = useGithubIssuesAvailable(connected, session.snapshot, { chatOpen: params.id, chatsHome: chatsHomeOpen });
  const targetMatches = (!params.projectPath || params.projectPath === projectPath) && (!params.hostId || params.hostId === connected?.url);
  const originChatId = pendingOrigin(projectPath, params.id, params.worktreeId, draftId);
  const pending = targetMatches
    ? pendingOnScreen(pendingStore.pendingChats, { hostId: connected?.url, projectPath, origin: originChatId, id: params.id })
    : undefined;
  const pendingCanonicalId = pending && session.snapshot ? pendingChatSessionId(session.snapshot.project.state, pending.preview) : null;
  const archiveRequest = useRef(false);
  const unsent = !!pending && !pending.accepted;
  const sendingKey = `${connected?.url}|${originChatId}`;
  const busy = actionBusy || unsent || sendingKeys.includes(sendingKey);
  const focused = useRef<object | null>(null);
  useFocusEffect(
    useCallback(() => {
      focused.current = { client: connected, projectPath, id: params.id, worktreeId: params.worktreeId };
      return () => {
        focused.current = null;
      };
    }, [connected, projectPath, params.id, params.worktreeId]),
  );
  useEffect(() => {
    let cancelled = false;
    if (connected && projectPath && !session.snapshot?.project.link && !params.id)
      void retrySend(() => connected.call<string[]>("project:branches", [projectPath]), {
        retryable: (error) => !cancelled && retryKind(error) !== null,
        budget: READ_RETRY_BUDGET,
      })
        .then((items) => {
          if (!cancelled) setBranchList({ client: connected, path: projectPath, items });
        })
        .catch((error) => {
          if (!cancelled) setBranchList({ client: connected, path: projectPath, items: [], error: (error as Error).message });
        });
    return () => {
      cancelled = true;
    };
  }, [connected, projectPath, params.id, session.snapshot?.project.link]);
  const acceptedSessionId = pending?.accepted ? pending.preview.targetSessionId : null;
  const pendingKey = pending ? `${pending.hostId}|${pending.originChatId}` : null;
  const { setPendingChats } = pendingStore;
  useFocusEffect(
    useCallback(() => {
      if (acceptedSessionId === null || pending?.promoted || !pendingKey) return;
      adoptChat(acceptedSessionId);
      setPendingChats((current) => (current[pendingKey] ? { ...current, [pendingKey]: { ...current[pendingKey], promoted: true } } : current));
    }, [acceptedSessionId, pending?.promoted, pendingKey, setPendingChats, adoptChat]),
  );
  const { lean, media, historyPage, messages } = useChatTranscriptData({
    session,
    connected,
    projectPath,
    params,
    targetMatches,
    mentionState,
    pending,
    pendingCanonicalId,
    scrollKey,
  });
  const compactionFeedback = useCompactionFeedback(
    messages.findLast((item) => compactionContext(item)),
    scrollKey,
  );
  const pageLoading = lean && Boolean(params.id) && historyPage.loading && !messages.length;
  const { prPath, prAction, rowPrs, pr, placeOf, prCwd, prChoices, prOpenThreads } = useChatPrs({
    session,
    chatsHomeOpen,
    worktreeOf,
    params,
    messages,
  });
  const remote = lean && (!pending || pendingCanonicalId !== null) ? Math.max(0, historyPage.total - historyPage.messages.length) : 0;
  const history = chatHistory(messages);
  const edit = useChatEdit(session, params.id, messages, liveRun, pending);
  const { liveSteps, onLiveSteps } = useLiveSteps();
  const chosen = useMemo(() => chosenDesign(history.userBodies), [history.userBodies]);
  const designChoice = chosen ? `${chosen.id}:${chosen.version}` : undefined;
  const [shown, setShown] = useState({ key: scrollKey, count: PAGE });
  const visible = shown.key === scrollKey ? shown.count : PAGE;
  const { trim: trimHistory } = historyPage;
  const seenCount = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > seenCount.current;
    seenCount.current = messages.length;
    if (!grew || !following.current || historyRead.current || historyAnchor.current) return;
    if (visible > PAGE) setShown({ key: scrollKey, count: PAGE });
    trimHistory(() => following.current && !historyRead.current && !historyAnchor.current);
  }, [messages.length, visible, scrollKey, trimHistory]);
  const groupedMessages = useMemo(() => foldLinkedExchanges(groupQuietRuns(messages)), [messages]);
  // The transcript renders its last `visible` rows, so new ones at the end push old ones out at the top. The native
  // view then moves the offset to keep what is on screen (maintainVisibleContentPosition) and reports that as a scroll,
  // with the new rows' height left to the end. When as much leaves as arrives, the content size doesn't change and
  // onContentSizeChange never jumps to the end (#972). The first row a scroll event last saw tells onScroll so.
  const firstRowId = groupedMessages[Math.max(0, groupedMessages.length - visible)]?.message.id;
  const scrolledFirstRow = useRef(firstRowId);
  async function showEarlier() {
    if (historyRead.current || historyAnchor.current || messages.length + remote <= visible) return;
    const request = {};
    historyRead.current = request;
    following.current = false;
    setHistoryState({ key: scrollKey, loading: true, error: "" });
    try {
      if (messages.length <= visible) await historyPage.loadEarlier();
      if (currentScrollKey.current !== scrollKey) return;
      const first = groupedMessages.slice(Math.max(0, messages.length - visible)).find((entry) => !entry.hidden)?.message;
      const y = first && messagePositions.current.get(first.id);
      historyAnchor.current = first && y !== undefined ? { id: first.id, y, offset: scrollOffset.current, key: scrollKey } : null;
      setShown({ key: scrollKey, count: visible + PAGE });
    } catch (error) {
      if (currentScrollKey.current === scrollKey) setHistoryState({ key: scrollKey, loading: false, error: (error as Error).message });
    } finally {
      if (historyRead.current === request) {
        historyRead.current = null;
        setHistoryState((current) => ({ ...current, loading: false }));
      }
    }
  }
  const handoffModels = useMemo(() => [...modelsFor("claude", session.models), ...modelsFor("codex", session.models)], [session.models]);
  const shownEntries = useMemo(() => groupedMessages.filter((entry) => !entry.hidden), [groupedMessages]);
  const navigationItems = useMemo(
    () =>
      messageNavigationIndices(shownEntries.length).flatMap((index) => {
        const entry = shownEntries[index];
        if (!entry || isSilentNote(entry.message)) return [];
        const { message, merged } = entry;
        const position = `${index + 1} of ${shownEntries.length}`;
        return {
          index,
          label: navigationLabel(message, merged, position, handoffModels),
        };
      }),
    [shownEntries, handoffModels],
  );
  const messagePositions = useRef(new Map<number, number>());
  const navigationTarget = useRef<number | null>(null);
  useEffect(() => {
    messagePositions.current.clear();
    navigationTarget.current = null;
  }, [params.id]);
  const navigateToMessage = (stop: number) => {
    const target = shownEntries[stop]?.message;
    const index = target ? messages.indexOf(target) : -1;
    if (!target || index < 0) return;
    if (stop === shownEntries.length - 1) {
      navigationTarget.current = null;
      following.current = true;
      scrollToBottom(true);
      return;
    }
    following.current = false;
    scrollingToBottom.current = false;
    const id = target.id;
    navigationTarget.current = id;
    if (index < messages.length - visible) {
      messagePositions.current.clear();
      setShown({ key: scrollKey, count: messages.length - index });
    } else {
      const y = messagePositions.current.get(id);
      if (y !== undefined) {
        navigationTarget.current = null;
        scroll.current?.scrollTo({ y: Math.max(0, y - topClear + 12), animated: true });
      }
    }
  };
  const openBrief = useCallback((brief: string, title?: string) => {
    showBrief(brief, title);
    router.push("/handoff-brief");
  }, []);
  const openActivity = useCallback(
    (message: string, stepId?: string) => router.push({ pathname: "/activity", params: { id: String(params.id), message, ...(stepId ? { stepId } : {}) } }),
    [params.id],
  );
  const openOtherChat = useCallback(
    (key: string) => {
      const target = { projectPath: projectOfKey(key), hostId: targetHost, id: String(sessionIdFromKey(key)) };
      if (secondary) {
        openBeside({ hostId: targetHost, projectPath: target.projectPath, chatId: sessionIdFromKey(key) });
        return;
      }
      closeBeside();
      router.replace({ pathname: "/chat", params: target });
    },
    [targetHost, secondary],
  );
  const { rememberChat } = session;
  const canRemember = !secondary && !!params.id && !!session.snapshot?.project.state.sessions[Number(params.id)] && targetMatches;
  useFocusEffect(
    useCallback(() => {
      if (canRemember) rememberChat(Number(params.id));
    }, [canRemember, params.id, rememberChat]),
  );
  const savedChatKey = targetMatches && projectPath && params.id ? `${projectPath}#${params.id}` : undefined;
  const prChatKey = targetMatches && projectPath ? (savedChatKey ?? `${projectPath}#new:${params.worktreeId}`) : undefined;
  const [workspaceTabsOn] = useWorkspaceTabs();
  const tabsProject = targetMatches ? session.snapshot?.project : undefined;
  const tabsWhere = workspaceTabsOn && !secondary ? tabsAt(targetHost, tabsProject, params.id ? Number(params.id) : undefined, params.worktreeId) : null;
  const shownTabs = useWorkspaceTabSync(workspaceTabsOn, tabsWhere, tabsProject?.state.sessions, params.id ? Number(params.id) : undefined);
  const panels = useSidePanels({
    chatId: pending ? (pendingCanonicalId ?? pending.preview.session.id) : params.id ? Number(params.id) : undefined,
    worktreeId: targetMatches && worktreeOf ? panelWorktree(session.snapshot?.project, worktreeOf.id) : undefined,
    pullRequest: prChatKey && pr && prCwd ? { number: pr.number, chatKey: prChatKey, choices: prChoices, ...(prPath ? {} : { cwd: prCwd }) } : undefined,
    passive: secondary,
  });
  const prChat = useRef<{
    send: (body: string) => Promise<boolean | "busy">;
    prefill: (text: string) => void;
    open: (number?: number) => void;
    pullRequests: () => PrChoice[];
    changes: () => void;
  } | null>(null);
  useEffect(() => {
    if (!prChatKey) return;
    const unregister = registerPrChat(prChatKey, {
      send: (body) => prChat.current?.send(body) ?? Promise.resolve(false),
      prefill: (text) => prChat.current?.prefill(text),
      pullRequests: () => prChat.current?.pullRequests() ?? [],
      changes: () => prChat.current?.changes(),
    });
    const unsubscribe = onPullRequestRequest(prChatKey, (number) => prChat.current?.open(number));
    return () => {
      unregister();
      unsubscribe();
    };
  }, [prChatKey]);
  const browserShortcut = useBrowserShortcut({
    chatId: savedChatKey ?? undefined,
    openInPanel: panels.openInPanel,
  });
  useReadOpenChat(
    connected,
    projectPath,
    !secondary && targetMatches && params.id ? session.snapshot?.project.state.sessions[Number(params.id)] : undefined,
    !!panels.open,
  );
  const { wanted, error: openError, retry: retryOpen } = useOpenProject(secondary ? {} : params);
  const deletedLink = secondary ? null : session.deletedLink;
  const routedScope = params.projectPath || session.snapshot?.project.path;
  const leftDeleted = !!deletedLink && routedScope === deletedLink.path && (!params.hostId || params.hostId === deletedLink.hostId);
  useEffect(() => {
    if (!leftDeleted || !deletedLink) return;
    showArchiveNotice(linkDeletedElsewhereText(deletedLink.name));
    router.replace("/projects");
  }, [leftDeleted, deletedLink]);
  const loaded = targetMatches && !!session.snapshot;
  const needsWorktree = !params.id && !params.worktreeId;
  const candidates = loaded && needsWorktree ? Object.values(session.snapshot!.project.state.worktrees) : [];
  const starterId = (candidates.find((item) => item.path === projectPath) || candidates[0])?.id;
  useEffect(() => {
    if (!needsWorktree || !loaded) return;
    if (starterId === undefined) router.replace("/projects");
    else router.setParams({ worktreeId: String(starterId) });
  }, [needsWorktree, loaded, starterId]);
  const prefillKey = loaded && !params.id && params.worktreeId && params.prefill ? `${session.snapshot!.project.path}#new:${params.worktreeId}` : null;
  const { setDrafts } = composer;
  useEffect(() => {
    if (!prefillKey || !params.prefill) return;
    const text = params.prefill;
    setDrafts((current) => (current[prefillKey] ? current : { ...current, [prefillKey]: text }));
    router.setParams({ prefill: undefined });
  }, [prefillKey, params.prefill, setDrafts]);
  const newChatProjects = useNewChatProjects(!params.id);
  const noProject = useNoProjectChoice(session.client?.url);
  const newChatLinks = useMemo(() => linksOf(computerViews, session.client?.url), [computerViews, session.client?.url]);
  const keyboard = useReanimatedKeyboardAnimation();
  const restingKeyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const startLift = Math.max(insets.bottom, 12) - 8;
  const startLineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.min(0, keyboard.height.get() + startLift * keyboard.progress.get()) / 2 }],
  }));
  const sidebar = <SidebarToolbar onOpenNavigation={panels.show} />;
  const startIssue = useRef<(issue: PickedIssue) => void>(() => {});
  const sendDesign = useRef<() => void>(() => {});
  const sendGenui = useRef<(text: string) => Promise<boolean | "busy">>(async () => false);
  const genuiSend = useCallback((text: string) => sendGenui.current(text), []);
  const designDeferred = useRef(false);
  const designSending = useRef<DesignMessage | null>(null);
  const designKey = session.client && session.snapshot ? `${session.client.url}|${session.snapshot.project.path}#${params.id}` : null;
  useFocusEffect(
    useCallback(() => {
      if (designKey && params.id) sendDesign.current();
    }, [designKey, params.id, session.designs.enabled]),
  );
  useEffect(() => {
    if (!busy && !picking && designDeferred.current) sendDesign.current();
  }, [busy, picking]);
  useEffect(() => {
    if (!designKey || !params.id) return;
    return onSendDesignMessageNow((key) => {
      if (key === designKey) sendDesign.current();
    });
  }, [designKey, params.id]);
  const compactSeen = useRef<Record<string, number> | null>(null);
  const compactRequests = composer.compactRequests;
  useEffect(() => {
    if (secondary && !ownProject) return;
    if (!compactSeen.current) {
      compactSeen.current = { ...compactRequests };
      return;
    }
    const snapshot = session.snapshot;
    const client = session.client;
    for (const [key, count] of Object.entries(compactRequests)) {
      if (compactSeen.current[key] === count) continue;
      compactSeen.current[key] = count;
      const target = snapshot?.project.state.sessions[sessionIdFromKey(key)];
      if (!snapshot || !client || !target || projectOfKey(key) !== snapshot.project.path) continue;
      const turn = turnTarget(composer.preferences[key], target.provider, composer.defaults);
      const model = selectedModel(turn.provider, turn.model || lastUserModel(snapshot.project.state, target.id), session.models);
      setError("");
      client
        .call("chat:send", [
          {
            projectPath: snapshot.project.path,
            sessionId: target.id,
            worktreeId: target.worktree_id,
            body: COMPACT_COMMAND,
            prompt: COMPACT_COMMAND,
            images: [],
            files: [],
            ...sendOptions(model, composer.preferences[key] || composer.defaults),
            sentFrom: SENT_FROM,
            compact: true,
          },
        ])
        .then(() => session.expectActivity())
        .catch((e: Error) => setError(e.message));
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the counters are the trigger; the rest is read as it stands when one moves
  }, [compactRequests]);
  const shownChat = params.id ? session.snapshot?.project?.state.sessions[Number(params.id)] : undefined;
  const shownKey = `${session.snapshot?.project?.path}#${params.id}`;
  const planPanel = usePlanPanel(shownChat?.plan, shownKey);
  const taskEffort = useTaskEffort(session.client, shownChat?.orchestrator?.taskId);
  const subchatPanel = useSubchatPanel(params.id && Number(params.id) > 0 ? session.snapshot?.project?.state.sessions : undefined, shownKey);
  const { attachRoom: attachPlanRoom } = planPanel;
  const { attachRoom: attachSubchatRoom } = subchatPanel;
  const attachPanelRooms = useCallback(
    (node: Parameters<typeof attachPlanRoom>[0]) => {
      attachPlanRoom(node);
      attachSubchatRoom(node);
    },
    [attachPlanRoom, attachSubchatRoom],
  );
  const portsChat = params.id && Number(params.id) > 0 && session.snapshot ? `${session.snapshot.project.path}#${params.id}` : undefined;
  const { ports } = useChatPorts(portsChat ? session.client : null, portsChat);
  const btw = useBtw(session.client, portsChat, !!session.error);
  const loopbackKey = [...loopbackOnlyPorts(ports)].sort((a, b) => a - b).join(",");
  const reachable = useMemo(
    () => ({ host: reachableHost, loopbackOnly: new Set(loopbackKey ? loopbackKey.split(",").map(Number) : []) as ReadonlySet<number> }),
    [reachableHost, loopbackKey],
  );
  const openFamilyRef = useRef<(key: string) => void>(() => {});
  const onOpenFamilyChat = useCallback((key: string) => openFamilyRef.current(key), []);
  if (secondary && (!session.client || !session.snapshot || !targetMatches)) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <View
          accessible={!session.error}
          accessibilityRole="progressbar"
          accessibilityLabel="Opening Chat…"
          style={{ alignItems: "center", justifyContent: "center" }}
        >
          {session.error ? (
            <ErrorNotice message={session.error} retry={() => void session.refresh().catch((e: Error) => session.setError(e.message))} retryTitle="Try again" />
          ) : (
            <LoadingLogo />
          )}
        </View>
        <View style={{ position: "absolute", top: insets.top + 6, right: 12 }}>
          <GlassIconButton label="Close Chat" systemImage="xmark" icon={Cancel01Icon} onPress={onClose} />
        </View>
      </View>
    );
  }
  if (!session.client || (!session.snapshot && !wanted)) return <Redirect href="/" />;
  if (!session.snapshot || !targetMatches || needsWorktree) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "", headerShown: true, headerBackVisible: false, gestureEnabled: false }} />
        {sidebar}
        <PanelSwipe panels={panels}>
          <View
            accessible={!openError}
            accessibilityRole="progressbar"
            accessibilityLabel="Opening Chat…"
            style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}
          >
            {openError ? <ErrorNotice message={openError} retry={retryOpen} retryTitle="Try again" /> : wanted || needsWorktree ? <LoadingLogo /> : null}
          </View>
        </PanelSwipe>
      </View>
    );
  }
  const client = session.client;
  const { project } = session.snapshot;
  const offline = !!session.error || allComputers.viewOf?.(client.url)?.state === "offline";
  const chat = params.id ? project.state.sessions[Number(params.id)] : null;
  const chatId = `${project.path}#${params.id ?? `new:${params.worktreeId}`}`;
  const forkFromMessage = messageForkAction({ client, projectPath: project.path, chat, offline, action, refresh: session.refresh, open: openOtherChat });
  const command = composerCommandHandler({
    chatId,
    setDrafts: composer.setDrafts,
    setUndoIntent,
    undo,
    chat,
    offline,
    hosts: session.hosts,
    targetHost,
    ask: btw.ask,
  });
  const heldDraft = () => readComposerDraft(composer.readDrafts(), chatId, NO_QUOTES);
  const attachmentDisabled = busy || picking;
  const run = chat ? liveRun : undefined;
  const phase =
    pending && !run
      ? sendStatusLabel({
          creatingWorktree: pending.newWorktree && pending.preview.targetSessionId === null,
          sent: pending.accepted,
          provider: pending.provider,
        })
      : (run?.status ?? null);
  const heartbeat =
    chat && beating
      ? routines.find((routine) => routine.enabled && !routine.completedAt && routine.target.kind === "chat" && routine.target.chatId === chatId)
      : undefined;
  const ownRoutine = chat && routinesOn === true ? chatRoutine(routines, chatId, chat.routine) : undefined;
  const ownHeartbeat = ownRoutine?.target.kind === "chat";
  const openRoutine = () => ownRoutine && router.push({ pathname: "/routine", params: { id: ownRoutine.id } });
  const undoHighlight = (undo.view === "list" ? undo.tasks[0] : undo.view === "preview" ? undo.preview : null)?.messageId;
  const activity = chat ? chatActivity(chat, run) : undefined;
  const background = chat ? backgroundItems(chat, ports) : [];
  const designsMoved = history.designActivity + (run?.designActivity ?? 0);
  const contextUsage = run?.contextUsage ?? chat?.contextUsage;
  const preferences = chatPreferences(composer.preferences[chatId], composer.defaults, chat?.permissionMode, run?.permissionMode, taskEffort);
  const turn = turnTarget(composer.preferences[chatId], chat?.provider, composer.defaults);
  const actualProvider = turn.provider;
  const model = selectedModel(actualProvider, turn.model || (chat && !turn.picked ? lastUserModel(project.state, chat.id) : ""), session.models);
  const ultracodeOn = model.ultracode && !!preferences.ultracode;
  const worktreeId = chat?.worktree_id ?? Number(params.worktreeId);
  const worktree = project.state.worktrees[worktreeId];
  const previewRecovery = (id: string, intent: UndoIntent) => void (setUndoIntent(intent), undo.inspect(id));
  function openPr(number = pr?.number, page?: "threads", memberCwd?: string) {
    if (!number || !worktree) return false;
    const cwd = project.link ? (memberCwd ?? prChoices.find((choice) => choice.number === number)?.cwd) : undefined;
    if (project.link && !cwd) return false;
    const route = { worktreeId: String(worktreeId), number: String(number), chat: chatId, ...(cwd ? { cwd } : {}) };
    if (widthClass(window.width) !== "compact" && !secondary) panels.showPullRequest(prChoiceKey({ number, cwd }));
    else if (page) openPrPage(page, route);
    else openPullRequest(route);
    return true;
  }
  const links = chatLinks(rowPrs, (entry) => openPr(entry.number, undefined, placeOf(entry)?.cwd), {
    on: internalBrowser,
    open: (url) => openBrowserLink(client.url, chatId, url, panels.openInPanel),
  });
  prChat.current = {
    send: (body) => send(body, false),
    prefill: (text) => composer.setDrafts((current) => ({ ...current, [chatId]: text })),
    open: openPr,
    pullRequests: () => prChoices,
    changes: secondary ? () => router.push({ pathname: "/changes", params: { worktreeId: String(worktreeId) } }) : () => panels.showChanges(),
  };
  const configuredBase = projectGit?.client === client && projectGit?.path === project.path ? projectGit?.base : undefined;
  const pickedBase = explicitBase?.scope === targetScope ? explicitBase.branch : undefined;
  const branches = branchList?.client === client && branchList.path === project.path ? branchList : null;
  const base =
    pickedBase ??
    (configuredBase ||
      (!branches?.items.length
        ? worktree?.name || ""
        : baseBranch && branches.items.includes(baseBranch)
          ? baseBranch
          : worktree?.name && branches.items.includes(worktree.name)
            ? worktree.name
            : branches.items[0]));
  const isolation = chatsHomeOpen ? "worktree" : pickedIsolation;
  const newWorktree = !project.link && !params.id && isolation === "worktree";
  const startTray = !params.id && !project.link;
  const targetDisabled = busy || picking;
  const branchDisabled = targetDisabled || (newWorktree && !branches?.items.length);
  const branchName = newWorktree ? base || "Choose branch" : worktree?.name || "Choose branch";
  const unavailable = session.cliStatus?.[actualProvider]?.state !== undefined && session.cliStatus[actualProvider].state !== "ready";
  const supportsCompact = Boolean(chat) && providerCapabilities(chat?.provider ?? "claude").compact;
  const quietContext = supportsCompact && contextSettings.autoCompact;
  const compactState = compactButtonState(compactButtonDisplay, contextUsage, supportsCompact, contextSettings.buttonThreshold, quietContext);
  const compactQueued = chat?.queued?.find((item) => compactionContext(item));
  const compacting = compactionContext(messages.findLast((item) => compactionContext(item)))?.status === "preparing";
  const canSteer = !compacting && providerCapabilities(chat?.provider ?? actualProvider).steer;
  const delivery = followUpDelivery(contextSettings.followUps);
  const queuesFollowUp = delivery === "queue" || !canSteer;
  const compactBlocked = compacting || busy || Boolean(session.error) || Boolean(chat?.archived) || unavailable;
  const compactButton =
    !quietContext && (compactState.visible || compactQueued || compacting) ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={compactQueued ? "Cancel queued compaction" : "Compact context"}
        accessibilityHint={run ? "Compact after the current turn." : "Summarize this Chat to free up context."}
        accessibilityState={{ disabled: compactBlocked }}
        disabled={compactBlocked}
        onPress={() =>
          compactQueued ? void action(() => client.call("chat:queue-remove", [chatId, compactQueued.id]), true) : composer.requestCompact(chatId)
        }
        style={({ pressed }) => ({
          minHeight: 44,
          minWidth: 44,
          flexDirection: "row",
          gap: 4,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 8,
          ...pressStyle({ pressed, disabled: compactBlocked }),
        })}
      >
        <Icon icon={compactQueued ? Cancel01Icon : CleanIcon} tone={compactState.warning ? "orangeInk" : "ink2"} size={12} />
        <Text
          style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "600", color: compactState.warning ? colors.orangeInk : colors.ink2 }}
        >
          {compacting ? "Compacting…" : compactQueued ? "Queued" : run ? "After turn" : "Compact"}
        </Text>
      </Pressable>
    ) : null;
  const title = chat ? chatTitle(chat, messages) : pending?.preview.session.title || "New Chat";
  const startingChat = !params.id && !pending && !messages.length;
  const projectName = chatsHomeOpen ? NO_PROJECT_LABEL : project.name || project.path.split("/").findLast(Boolean) || "Project";
  const hostIds = new Set(newChatProjects.map((item) => item.hostId));
  const projectGroups = newChatProjectGroups(newChatProjects);
  const isOpenCopy = (item: NewChatProject) => item.hostId === client.url && item.path === project.path;
  const projectCopies = projectGroups.find((group) => group.copies.some(isOpenCopy))?.copies ?? [];
  const projectOrigin = projectCopies.find(isOpenCopy)?.origin;
  const onSeveralComputers = projectCopies.length > 1;
  const hostName = onSeveralComputers ? "" : (newChatProjects.find((item) => item.hostId === client.url)?.hostName ?? session.hostName);
  const computerName = projectCopies.find(isOpenCopy)?.hostName ?? session.hostName;
  const trayTarget = {
    computerId: client.url,
    owner: project.path,
    sessionId: params.id ? Number(params.id) : null,
    computerName: computerName || "This computer",
    offline,
  };
  const computerCopies: NewChatProject[] = projectCopies.length
    ? projectCopies
    : [{ hostId: client.url, hostName: computerName || "This computer", offline: false, path: project.path, name: projectName }];
  const chatsComputer = noProject?.copies.find((copy) => copy.hostId === client.url)?.hostName ?? session.hostName ?? "this computer";
  const otherComputer = client.url !== openSession.client?.url;
  async function startWithoutProject(hostId: string) {
    const copy = noProject?.copies.find((item) => item.hostId === hostId);
    const homeClient = hostId === client.url ? client : allComputers.clientFor(hostId);
    if (!copy || !homeClient) {
      setError("This computer is no longer in your list.");
      return;
    }
    setError("");
    try {
      await switchProject(hostId, await chatsHomePath(homeClient, hostId, copy.home));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function chooseChatsComputer() {
    if (busy || !noProject) return;
    showChoiceSheet({
      title: `${JUST_CHAT_HEADING} on`,
      placeholder: "Search computers",
      emptyLabel: "No computers",
      icon: LaptopIcon,
      items: noProject.copies.map((copy) => ({ id: copy.hostId, title: copy.hostName, checked: copy.hostId === client.url, disabled: copy.offline })),
      onSelect: (hostId) => {
        if (hostId !== client.url) void startWithoutProject(hostId);
      },
    });
  }
  function chooseProject() {
    if (busy) return;
    showChoiceSheet({
      title: "Start building in",
      placeholder: "Search projects",
      emptyLabel: "No projects",
      items: [
        ...(noProject
          ? [
              {
                id: "no-project",
                title: NO_PROJECT_LABEL,
                subtitle: NO_PROJECT_FOLDER,
                keywords: "just chat",
                checked: chatsHomeOpen,
                disabled: noProject.copies.every((copy) => copy.offline),
                leading: <ChatsHomeIcon size={24} />,
              },
            ]
          : []),
        ...projectGroups.map((item, index) => ({
          id: String(index),
          title: item.name,
          ...(item.copies.length > 1 ? { subtitle: `${item.copies.length} computers` } : {}),
          keywords: item.copies.map((copy) => `${copy.hostName} ${copy.path}`).join(" "),
          checked: item.copies.some(isOpenCopy),
          disabled: item.copies.every((copy) => copy.offline),
          ...(hostIds.size > 1 ? { section: item.hostName } : {}),
          leading: <ProjectIcon client={item.hostId === client.url ? client : allComputers.clientFor(item.hostId)} path={item.path} size={24} />,
        })),
        ...newChatLinks.map((link, index) => ({
          id: `link:${index}`,
          title: link.name,
          subtitle: `${link.members.length} ${link.members.length === 1 ? "Project" : "Projects"}`,
          keywords: `link ${link.members.map((member) => member.name).join(" ")}`,
          checked: link.hostId === client.url && link.path === project.path,
          disabled: link.offline,
          section: "Links",
          leading: link.members.length ? (
            <ProjectIcons client={link.hostId === client.url ? client : allComputers.clientFor(link.hostId)} projects={link.members} size={24} />
          ) : (
            <Icon icon={Link04Icon} tone="ink3" size={20} />
          ),
        })),
      ],
      onSelect: (id) => {
        if (id === "no-project") {
          if (!chatsHomeOpen && noProject) void startWithoutProject(noProject.computerId);
          return;
        }
        if (id.startsWith("link:")) {
          const link = newChatLinks[Number(id.slice("link:".length))];
          if (link) void switchProject(link.hostId, link.path);
          return;
        }
        const group = projectGroups[Number(id)];
        if (!group || group.copies.some(isOpenCopy)) return;
        const copy = preferredCopy(group, group.origin ? savedChatDefaults.readOriginComputer(group.origin) : null, client.url);
        void switchProject(copy.hostId, copy.path, otherCopies(group, copy, client.url));
      },
    });
  }
  async function switchProject(firstHostId: string, firstPath: string, others: readonly NewChatProject[] = []) {
    if (busy || (firstHostId === client.url && firstPath === project.path)) return;
    setError("");
    setBusy(true);
    const openOne = async ({ hostId, path: projectPath }: { hostId: string; path: string }) => {
      const host = hostId === client.url ? null : allComputers.hostFor(hostId);
      if (hostId !== client.url && !host) throw new Error("This computer is no longer in your list.");
      const onOpen = (state: Snapshot) => {
        const worktrees = Object.values(state.project.state.worktrees);
        const starter = worktrees.find((item) => item.path === state.project.path) ?? worktrees[0];
        if (!starter) throw new Error("This Project has no available Worktree.");
        const destination = `${state.project.path}#new:${starter.id}`;
        composer.setDrafts((current) => {
          const { [chatId]: carried, ...rest } = current;
          return { ...rest, [destination]: carried || current[destination] || "" };
        });
        composer.setQuotes((current) => {
          const { [chatId]: carried, ...rest } = current;
          return carried?.length ? { ...rest, [destination]: [...(current[destination] || []), ...carried] } : current;
        });
        const destinationParams = { ...params, hostId, projectPath: state.project.path, worktreeId: String(starter.id), prefill: undefined };
        setArriving(destinationParams);
        router.setParams(destinationParams);
      };
      if (host) await session.connect(host, false, { projectPath, onOpen });
      else await session.open(projectPath, { background: true, onOpen });
      return true;
    };
    try {
      const notice = await openNewChatCopies([{ hostId: firstHostId, path: firstPath }, ...others], openOne, newChatProjects, client.url, session.hostName);
      if (notice) setError(notice);
    } finally {
      setBusy(false);
    }
  }
  async function action(work: () => Promise<unknown>, allowPending = false) {
    if (actionBusy || (!allowPending && pending)) return false;
    setBusy(true);
    setError("");
    try {
      await work();
      session.expectActivity();
      await session.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function pick(kind: "photos" | "camera" | "files" | "paste") {
    if (attachmentDisabled || pickingNow.current) return;
    pickingNow.current = true;
    setPicking(true);
    setError("");
    const { attachments } = heldDraft();
    try {
      const added = await pickAttachments(kind);
      if (currentScrollKey.current !== scrollKey) return;
      const existingImages = attachments.filter((item) => item.image).length;
      const addedImages = added.filter((item) => item.image).length;
      const next = appendAttachments(attachments, added);
      composer.setAttachments((current) => ({ ...current, [chatId]: next }));
      if (addedImages > 0) {
        composer.setDrafts((current) => ({ ...current, [chatId]: appendImageMentions(current[chatId] || "", existingImages, addedImages) }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pickingNow.current = false;
      setPicking(false);
    }
  }
  function mentionFile(path: string) {
    const root = worktree?.path;
    if (!root) return;
    const { error: refused } = addMention(heldDraft().attachments, root, path);
    if (refused) setError(refused);
    else {
      composer.setAttachments((current) => ({ ...current, [chatId]: addMention(current[chatId] || [], root, path).next }));
      knownFiles.current.seed(root, path);
    }
  }
  async function pasteImage(image: PastedImage) {
    if (attachmentDisabled || pickingNow.current) {
      discardPastedImage(image);
      setError("Wait for the current attachment to finish, then paste again.");
      return;
    }
    pickingNow.current = true;
    setPicking(true);
    setError("");
    const { attachments } = heldDraft();
    try {
      const added = await preparePastedImage(image);
      if (currentScrollKey.current !== scrollKey) return;
      const existingImages = attachments.filter((item) => item.image).length;
      const next = appendAttachments(attachments, [added]);
      composer.setAttachments((current) => ({ ...current, [chatId]: next }));
      composer.setDrafts((current) => ({ ...current, [chatId]: appendImageMentions(current[chatId] || "", existingImages, 1) }));
    } catch (failure) {
      if (currentScrollKey.current === scrollKey) setError((failure as Error).message);
    } finally {
      pickingNow.current = false;
      setPicking(false);
    }
  }
  sendGenui.current = (text: string) => send(text, false);
  sendDesign.current = () =>
    sendWaitingDesign(
      designKey,
      session.designs.enabled === true,
      { sending: designSending, deferred: designDeferred },
      (message) => send(message.text, false, undefined, undefined, false, message.images),
      () => sendDesign.current(),
    );
  startIssue.current = (issue) => void send(issueStartMessage(issue, heldDraft().draft), true, undefined, issue);
  async function chooseIssue() {
    await pickIssue((client) => pickLinearIssue(client, "Start from a Linear issue", (issue) => startIssue.current(issue)));
  }
  async function pickIssue(open: (client: Client) => Promise<void>) {
    if (targetDisabled || !client) return;
    setError("");
    await open(client).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }
  async function send(
    typedBody?: string,
    withAttachments = true,
    prAction?: PullRequestActionContext & { projectId?: string },
    issue?: PickedIssue,
    stay = false,
    extra: NonNullable<DesignMessage["images"]> = [],
  ) {
    const { draft, quotes, attachments } = heldDraft();
    const outgoing = quotedMessage(quotes, draft);
    const body = typedBody ?? outgoing;
    const messageDelivery = run && !prAction && !issue ? delivery : undefined;
    const own = !prAction && body === outgoing;
    const typed = own ? draft : body;
    const sentQuotes = own ? quotes : NO_QUOTES;
    const sentQuoteIds = new Set(sentQuotes.map((quote) => quote.id));
    const dropSentQuotes = () => {
      if (sentQuotes.length) composer.setQuotes((held) => ({ ...held, [chatId]: (held[chatId] || []).filter((quote) => !sentQuoteIds.has(quote.id)) }));
    };
    if (command(typed, withAttachments && !sentQuotes.length, sendOptions(model, preferences))) return false;
    const issueKey = issueChoiceId(issue);
    const steered = Boolean(run) && messageDelivery !== "queue" && canSteer;
    const stayDraft = stay ? randomUUID() : undefined;
    const origin = stayDraft ? pendingOrigin(project.path, undefined, String(worktreeId), stayDraft) : originChatId;
    const key = `${client.url}|${origin}`;
    const sendKey = stay ? key : sendingKey;
    if (!body && !(withAttachments && attachments.length)) return false;
    if (busy || sendingRef.current.has(sendKey) || picking) return "busy";
    sendingRef.current.add(sendKey);
    setSendingKeys((current) => [...current, sendKey]);
    setError("");
    if (!outbox.getSnapshot().loaded) await outbox.ready.catch(() => {});
    if (offline || hasQueuedChat(client.url, project.path, params.id ? Number(params.id) : null)) {
      try {
        if (!project.link && (newWorktree || stay || issue) && !base) throw new Error("Choose a base branch before queuing this message.");
        const id = randomUUID();
        const mentioned =
          withAttachments && worktree?.path
            ? mentionAttachments(typed, worktree.path, attachments, (path) => knownFiles.current.has(worktree.path, path)).added
            : [];
        const picked = withAttachments ? [...attachments, ...mentioned] : extra;
        await outbox.enqueue({
          id,
          computerId: client.url,
          computerName: computerName || "Computer",
          owner: project.path,
          conversation: params.id ? `chat:${params.id}` : id,
          request: {
            projectPath: project.path,
            sessionId: params.id ? Number(params.id) : null,
            worktreeId,
            body,
            images: [],
            files: [],
            prompt: prAction ? pullRequestActionPrompt(prAction) : body,
            ...sendOptions(model, preferences),
            delivery: messageDelivery,
            prAction: pullRequestActionRequest(prAction),
            ...issueSendFields(issue, draft),
          },
          ...(project.link ? { link: { linkId: project.link.link.id, operationId: id } } : {}),
          ...(!project.link && (newWorktree || stay || issue)
            ? {
                createWorktree: {
                  projectPath: project.path,
                  baseBranch: base,
                  useProjectBase: pickedBase === undefined,
                  prompt: body,
                  ...issueWorktreeFields(issue),
                },
              }
            : {}),
          attachments: outboxAttachments(picked),
        });
        if (own || issue) composer.setDrafts((current) => clearSentDraft(current, chatId, typed, !!issue));
        dropSentQuotes();
        const ids = new Set(picked.map((item) => item.id));
        composer.setAttachments((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((item) => !ids.has(item.id)) }));
        if (!stay) Keyboard.dismiss();
        void outbox.flush().catch(() => {});
        return true;
      } catch (error) {
        setError((error as Error).message);
        return false;
      } finally {
        sendingRef.current.delete(sendKey);
        setSendingKeys((current) => current.filter((key) => key !== sendKey));
      }
    }
    const mentionRoot = worktree?.path;
    if (withAttachments && mentionRoot && knownFiles.current.unchecked(mentionRoot, mentionPaths(typed), 1).length)
      await knownFiles.current.resolve(client, mentionRoot, mentionPaths(typed));
    const mentions =
      withAttachments && mentionRoot ? mentionAttachments(typed, mentionRoot, attachments, (path) => knownFiles.current.has(mentionRoot, path)) : { added: [] };
    const sent = body;
    const sendingProjectPath = project.path;
    if (!params.id) {
      void savedChatDefaults.saveLastComputer(client.url);
      if (!chatsHomeOpen) void savedChatDefaults.saveLastProject(client.url, sendingProjectPath);
      if (projectOrigin) void savedChatDefaults.saveOriginComputer(projectOrigin, client.url);
    }
    const sending = withAttachments ? [...attachments, ...mentions.added] : extra;
    const focus = focused.current;
    const current = () => !stay && focus !== null && focused.current === focus && session.isSelected();
    const clearsDraft = own || issueKey !== undefined;
    const creates = !project.link && (newWorktree || stay || issueKey !== undefined);
    const operationId = project.link
      ? composer.linkOperations.forSend(key, JSON.stringify([sent, sending.map((item) => item.id), prAction]), randomUUID)
      : null;
    const resendParts = sending.map((item) => item.id);
    const preview = createPendingChat({
      clientMessageId: failedSends.current.reuse(key, sent, resendParts),
      state: project.state,
      worktreeId,
      sessionId: params.id ? Number(params.id) : null,
      body: sent,
      images: sending.flatMap((item) => (item.image ? [item.image] : [])),
      files: sending.filter((item) => !item.image).map((item) => item.path || item.name),
      model: model.id,
      provider: actualProvider,
      context: issue ? issueStartContext(issue, draft) : (prAction ?? null),
    });
    pendingStore.setPendingChats((current) => ({
      ...current,
      [key]: {
        preview,
        hostId: client.url,
        projectPath: sendingProjectPath,
        originChatId: origin,
        ...(params.id ? {} : { draft: stayDraft ?? draftId }),
        originSessionId: params.id ? Number(params.id) : null,
        worktreeId,
        newWorktree: creates,
        accepted: false,
        provider: actualProvider,
      },
    }));
    if (clearsDraft) composer.setDrafts((current) => clearSentDraft(current, chatId, typed, issueKey !== undefined));
    dropSentQuotes();
    const sentIds = new Set(sending.map((item) => item.id));
    composer.setAttachments((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((item) => !sentIds.has(item.id)) }));
    following.current = true;
    if (!stay) Keyboard.dismiss();
    const options = { ...sendOptions(model, preferences), delivery: messageDelivery, prAction: pullRequestActionRequest(prAction) };
    const retried = <T,>(work: () => Promise<T>) => retrySend(work, { retryable: (error) => retryKind(error) !== null });
    const retriedUnsent = <T,>(work: () => Promise<T>) => retrySend(work, { retryable: (error) => retryKind(error) === "unsent" });
    let accepted = false;
    try {
      const media = await prepareAttachments(client, sendingProjectPath, sending, retried);
      let target = { sessionId: params.id ? Number(params.id) : (null as number | null), worktreeId };
      if (creates) {
        if (!base) throw new Error(branches?.error || "Choose a base branch before sending.");
        let ready = stay ? null : preparedTarget.current;
        if (!ready || ready.client !== client || ready.path !== sendingProjectPath || ready.base !== base || ready.issueKey !== issueKey) {
          const created = await retriedUnsent(() =>
            client.call<{ project: OpenProject; worktreeId: number }>("worktree:create", [
              {
                projectPath: sendingProjectPath,
                baseBranch: base,
                useProjectBase: pickedBase === undefined,
                prompt: sent,
                ...issueWorktreeFields(issue),
              },
            ]),
          );
          const chat = sessionForWorktree(created.project.state, created.worktreeId);
          if (!chat) throw new Error("No Chat was created for the new worktree.");
          ready = { client, path: sendingProjectPath, base, issueKey, worktreeId: created.worktreeId, sessionId: chat.id };
          if (!stay) preparedTarget.current = ready;
        }
        target = { sessionId: ready.sessionId, worktreeId: ready.worktreeId };
      }
      pendingStore.setPendingChats((current) =>
        current[key] ? { ...current, [key]: { ...current[key], preview: { ...current[key].preview, targetSessionId: target.sessionId } } } : current,
      );
      const link = project.link;
      const prompt = prAction ? pullRequestActionPrompt(prAction) : attachmentPrompt(sent, media.files);
      const result = await retriedUnsent(() =>
        link
          ? client.call<{ sessionId: number }>("link:send", [
              {
                linkId: link.link.id,
                sessionId: params.id ? Number(params.id) : null,
                operationId,
                clientMessageId: preview.message.clientMessageId,
                body: sent,
                ...media,
                prompt,
                ...options,
                sentFrom: SENT_FROM,
                ...issueSendFields(issue, draft),
              },
            ])
          : client.call<{ sessionId: number }>("chat:send", [
              {
                projectPath: sendingProjectPath,
                ...target,
                clientMessageId: preview.message.clientMessageId,
                body: sent,
                ...media,
                prompt,
                ...options,
                sentFrom: SENT_FROM,
                ...issueSendFields(issue, draft),
              },
            ]),
      ).catch(async (error) => {
        if (retryKind(error) !== "unknown") throw error;
        const receipt = await client
          .call<{ sessionId: number } | null>("chat:send-status", [sendingProjectPath, preview.message.clientMessageId])
          .catch(() => null);
        if (receipt) return receipt;
        throw error;
      });
      accepted = true;
      failedSends.current.forget(key);
      if (operationId) composer.linkOperations.accepted(key, operationId);
      const promote = current();
      pendingStore.setPendingChats((current) =>
        current[key]
          ? {
              ...current,
              [key]: {
                ...current[key],
                accepted: true,
                promoted: promote,
                preview: { ...current[key].preview, targetSessionId: result.sessionId, acceptedSessionId: result.sessionId },
              },
            }
          : current,
      );
      const destination = `${sendingProjectPath}#${result.sessionId}`;
      const here = promote || !!params.id;
      if (here && (clearsDraft || destination !== chatId))
        composer.setDrafts((current) => {
          const remaining = current[chatId] || "";
          const preserved = destination !== chatId ? current[destination] || "" : "";
          const next = { ...current, [destination]: [preserved, remaining].filter(Boolean).join("\n") };
          if (destination !== chatId) delete next[chatId];
          return next;
        });
      if (here && destination !== chatId)
        composer.setQuotes((held) => {
          const next = { ...held, [destination]: [...(held[destination] || []), ...(held[chatId] || [])] };
          delete next[chatId];
          return next;
        });
      if (here)
        composer.setAttachments((current) => {
          const sentIds = new Set(sending.map((item) => item.id));
          const remaining = (current[chatId] || []).filter((item) => !sentIds.has(item.id));
          const preserved = destination !== chatId ? current[destination] || [] : [];
          const next = { ...current, [destination]: [...preserved, ...remaining] };
          if (destination !== chatId) delete next[chatId];
          return next;
        });
      composer.setPreferences((current) => {
        const next = { ...current, [destination]: afterSend((here && current[chatId]) || preferences, turn, chat?.provider, model.id, steered) };
        if (here && destination !== chatId) delete next[chatId];
        return next;
      });
      session.expectActivity();
      if (current()) {
        following.current = true;
        Keyboard.dismiss();
        if (!params.id) adoptChat(result.sessionId);
      }
      void session.refresh().catch(() => {});
      return true;
    } catch (e) {
      if (!accepted) {
        failedSends.current.remember(key, preview.message.clientMessageId!, sent, resendParts);
        pendingStore.setPendingChats((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        if (clearsDraft) composer.setDrafts((current) => ({ ...current, [chatId]: [draft, current[chatId]].filter(Boolean).join("\n\n") }));
        if (sentQuotes.length)
          composer.setQuotes((held) => ({
            ...held,
            [chatId]: [...sentQuotes, ...(held[chatId] || []).filter((quote) => !sentQuoteIds.has(quote.id))],
          }));
        composer.setAttachments((current) => ({
          ...current,
          [chatId]: [...sending, ...(current[chatId] || []).filter((item) => !sending.some((sent) => sent.id === item.id))],
        }));
      }
      if (stay || current()) setError((e as Error).message);
      return accepted;
    } finally {
      sendingRef.current.delete(sendKey);
      setSendingKeys((current) => current.filter((key) => key !== sendKey));
    }
  }
  function headerAction(id: string) {
    // The ⋯ menu is native: its touch may never reach the pane, and what it opens is about this pane's Chat.
    touchPane(secondary ? "beside" : "routed");
    if (id === "changes" && secondary) router.push({ pathname: "/changes", params: { worktreeId: String(worktreeId) } });
    else if (id === "changes") panels.showChanges();
    else if (id === "routine") openRoutine();
    else if (id === "linear" && linearIssue) openLinearIssue(linearIssue.url);
    else if (id === "link-issue") linkIssue();
    else if (id === "unlink-issue") void unlinkWorktreeIssue();
    else if ((id === "undo" || id === "checkpoints") && chat) {
      setUndoIntent("Undo");
      void undo.open();
    } else if (id === "pr" && pr) openPr(pr.number);
    else if (id === "agents" && chat) router.push({ pathname: "/agents", params: { id: String(chat.id) } });
    else if (id === "rename" && chat)
      void promptText(UI_COPY.renameChat, { value: title }).then((value) =>
        value?.trim() ? action(() => client.call("chat:patch", [project.path, chat.id, { title: value.trim() }])) : undefined,
      );
    else if (id === "reload" && chat)
      void action(() => client.call("chat:reload", [chatId]), true).then((done) => done && showToast("Chat reloaded. Your next message starts a fresh agent."));
    else if (id === "report-bug" && chat) {
      composer.setDrafts((current) => ({ ...current, [chatId]: withReportPrompt(current[chatId] ?? "") }));
      setComposerFocusRequest((count) => count + 1);
    } else if (id === "done" && chat) void markDone(chat);
    else if (id === "reopen" && chat) void action(() => client.call("chat:patch", [project.path, chat.id, { done: false }]));
    else if (id === "archive" && chat?.archived) void action(() => client.call("chat:patch", [project.path, chat.id, { archived: false }]));
    else if (id === "archive" && chat) void archive(chat);
  }
  const leaveChat = () => (secondary ? closeBeside() : leaveToList(split.dockable, () => panels.show("left")));
  const markDone = (finished: NonNullable<typeof chat>) => markChatDone({ client, projectPath: project.path, chat: finished, action, leave: leaveChat });
  const settle = settleActions({ chat, messages, busy: { run, pending, offline } }, { client, projectPath: project.path, action, leave: leaveChat });
  async function archive(target: NonNullable<typeof chat>) {
    if (busy || archiveRequest.current) return;
    archiveRequest.current = true;
    let left = false;
    const leave = () => {
      left = true;
      if (secondary) closeBeside();
      else if (split.dockable) router.replace("/projects");
      else panels.show("left");
    };
    const refresh = () => Promise.all([session.refresh(), session.previewProject(project.path)]);
    setError("");
    try {
      if (project.link)
        await runChatAction({
          action: "archive",
          client,
          projectPath: project.path,
          state: project.state,
          link: project.link,
          chat: target,
          running: !!run,
          onConfirm: leave,
          expectActivity: session.expectActivity,
          refresh,
          notify: showArchiveNotice,
        });
      else
        await archiveFromPhone({
          client,
          projectPath: project.path,
          state: project.state,
          chat: target,
          running: !!run,
          chatsHome: chatsHomeOpen,
          hostId: params.hostId || session.client?.url,
          onConfirm: () => {
            session.expectActivity();
            leave();
          },
          notify: showArchiveNotice,
          refresh,
        });
    } catch (e) {
      if (left) showArchiveNotice(`Could not delete Chat: ${(e as Error).message}`);
      else setError((e as Error).message);
    } finally {
      archiveRequest.current = false;
    }
  }
  const agents = (chat?.subagents || []).filter((agent) => !agent.archived);
  const diff = worktree?.diff;
  const linearIssue: LinearIssue | undefined = worktree ? linearIssues[worktree.path] : undefined;
  const canLink =
    linearActive && !!chat && !project.link && !chatsHomeOpen && !!worktree?.path && worktree.path !== project.path && !worktreeShared(project.state, chat.id);
  const storedIssue = linearActive && !chatsHomeOpen ? worktree?.linearIssue : undefined;
  const linkHint = storedIssue && !(worktree?.name ?? "").toLowerCase().includes(storedIssue.toLowerCase()) ? LINK_PR_HINT(storedIssue) : null;
  function showToast(text: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }
  function linkIssue() {
    if (!worktree) return;
    void pickIssue((client) => pickLinearIssue(client, "Link a Linear issue", (issue) => void linkWorktreeIssue(issue.key, issue.workspace)));
  }
  async function linkWorktreeIssue(key: string, workspace?: string) {
    if (!worktree) return;
    setError("");
    try {
      const result = await client.call<LinkIssueResult>("worktree:link-issue", [
        { projectPath: project.path, worktreeId: worktree.id, key, ...(workspace ? { workspace } : {}) },
      ]);
      await session.refresh();
      setLinkVersion((version) => version + 1);
      showToast(result.mode === "renamed" ? `Branch renamed to ${result.branch}.` : `Issue linked. ${LINK_PR_HINT(key)}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function unlinkWorktreeIssue() {
    if (!worktree) return;
    setError("");
    try {
      await client.call("worktree:unlink-issue", [{ projectPath: project.path, worktreeId: worktree.id }]);
      await session.refresh();
      setLinkVersion((version) => version + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const family = chat && !secondary ? chatFamily(project.state.sessions, `${project.path}#${chat.id}`) : null;
  function openFamilyChat(key: string) {
    if (key === `${project.path}#${chat?.id}`) return;
    openOtherChat(key);
  }
  openFamilyRef.current = openFamilyChat;
  const besideParent = bookmark && split.widthClass === "wide" && !secondary ? sessionIdFromKey(bookmark.parent) : undefined;
  function selectFamilyItem(id: string) {
    if (id === BESIDE_PARENT) {
      if (besideParent !== undefined) openBeside({ hostId: targetHost, projectPath: project.path, chatId: besideParent });
      return;
    }
    openFamilyChat(id);
  }
  const titleRow = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600", flexShrink: 1 }}
      >
        {title}
      </Text>
      {family && <Icon icon={UnfoldMoreIcon} tone="ink3" size={12} />}
    </View>
  );
  const tabsInHeader = !!shownTabs && split.widthClass !== "compact";
  const header = tabsInHeader ? (
    <WorkspaceTabStrip where={shownTabs} activeChatId={chat?.id} actionCount={1 + Number(!!browserShortcut) + Number(!!pr)} />
  ) : (
    <>
      <HeaderTitleBox actionCount={1 + Number(!!browserShortcut) + Number(!!pr) + Number(!!shownTabs)}>
        {family && chat ? (
          <FamilyTitleMenu
            sessions={project.state.sessions}
            chatKey={`${project.path}#${chat.id}`}
            members={family.children}
            routines={routines}
            routinesOn={routinesOn === true}
            now={now}
            canOpenBeside={besideParent !== undefined}
            label={`${title}, ${family.children.length} Subchat${family.children.length === 1 ? "" : "s"} in this family`}
            title={title}
            onSelect={selectFamilyItem}
          >
            {titleRow}
          </FamilyTitleMenu>
        ) : (
          titleRow
        )}
        <ChatHeaderSubtitle
          paired={paired}
          linked={!!project.link}
          home={chatsHomeOpen}
          hasChat={!!chat}
          place={{ label: otherComputer ? `${projectName} · ${hostName}` : projectName, spoken: otherComputer ? `${projectName} on ${hostName}` : projectName }}
          branch={chatBranchLabel(chat, worktree?.name) ?? ""}
          worktreeShown={!!worktree}
          diff={diff}
          pr={pr}
          onPr={(number) => openPr(number)}
        />
      </HeaderTitleBox>
    </>
  );
  const paneMenu = chatPaneMenu({ chatsHomeOpen, diff, chat, run, ownRoutine, ownHeartbeat, linearIssue, linkHint, agents, busy, canLink, storedIssue, pages });
  const headerActions = (
    <HeaderActionGroup>
      {shownTabs && !tabsInHeader && <TabCountAction where={shownTabs} onPress={panels.showTabs} />}
      {browserShortcut && (
        <HeaderAction
          label={browserShortcut.accessibilityLabel}
          icon={Globe02Icon}
          onPress={() => {
            touchPane(secondary ? "beside" : "routed");
            browserShortcut.onPress();
          }}
        />
      )}
      {pr && <HeaderAction label={`Pull request #${pr.number}`} icon={GitPullRequestIcon} iconSize={24} onPress={() => headerAction("pr")} />}
      <PullDown label="Chat actions" sections={paneMenu} onSelect={(id) => void (openPage(id) || headerAction(id))}>
        <HeaderAction label="Chat actions" icon={MoreHorizontalIcon} />
      </PullDown>
    </HeaderActionGroup>
  );
  const more = <ChatToolbar shape={`${!!browserShortcut}|${!!pr}|${!!shownTabs}`}>{headerActions}</ChatToolbar>;
  const paneHeader = paired ? (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top,
        left: 0,
        right: 0,
        height: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
      }}
    >
      {!secondary && <SidebarButton />}
      <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
        {startingChat ? null : header}
      </View>
      {headerActions}
      <GlassIconButton label="Close Chat" systemImage="xmark" icon={Cancel01Icon} onPress={onClose} />
    </View>
  ) : null;
  const question = run?.questions[0];
  const answering = !!question && sentAnswers?.requestId === question.requestId;
  const answerPreview = answering && sentAnswers.count === messages.length ? sentAnswers.message : null;
  const notes = subchatNotes(messages, !!question || !!run?.approvals.length);
  const { renderSubchatNote, renderLinkedLine, renderToolApproval } = transcriptRows({
    outcomes: notes.outcomes,
    client,
    chatId,
    actionBusy,
    action,
    openFamilyChat,
    onOpenFamilyChat,
  });
  const pendingInput = pending && pendingCanonicalId === null ? pending.preview.message : null;
  const liveReply = run ? (
    <LiveReply
      key="run"
      chatKey={chatId}
      onSteps={onLiveSteps}
      media={media}
      basePath={worktree?.path || project.path}
      chatId={chatId}
      designChoice={designChoice}
      designsMoved={designsMoved}
      onActivity={openActivity}
    />
  ) : null;
  const sendBlocked =
    busy || picking || (newWorktree && !base) || !!chat?.archived || !!chat?.formerWorktree || !!chat?.readOnlyReason || (!offline && unavailable);
  const terminalDocks = !secondary && split.widthClass !== "compact";
  const terminalShown = terminalDocks && terminalFor === chatId && !!chat && !chat.archived;
  if (terminalShown && terminalMounted !== chatId) setTerminalMounted(chatId);
  const dockPadding = terminalShown ? 12 : Math.max(insets.bottom, 12);
  const terminalTyping = terminalShown && !composerFocused;
  const lift = dockPadding - 8 + (terminalShown ? Math.min(terminalHeight, restingKeyboard) : 0);
  const tray =
    startTray && chatsHomeOpen ? (
      <ChatsTrayLabel />
    ) : startTray ? (
      <NewChatTray
        computerName={computerName}
        computers={computerCopies}
        isOpenCopy={isOpenCopy}
        disabled={targetDisabled}
        onComputer={(hostId, path) => {
          if (projectOrigin) void savedChatDefaults.saveOriginComputer(projectOrigin, hostId);
          void switchProject(hostId, path);
        }}
        isolation={isolation}
        onIsolation={(next) => chooseTarget({ isolation: next })}
        newWorktree={newWorktree}
        branchName={branchName}
        branchDisabled={branchDisabled}
        branches={branches?.items || []}
        base={base}
        worktrees={Object.values(project.state.worktrees)}
        worktreeId={worktreeId}
        onBranch={(id) => {
          if (newWorktree) chooseTarget({ baseBranch: id });
          else navigation.setParams({ worktreeId: id });
        }}
        linear={linearActive}
        onIssue={() => void chooseIssue()}
        github={githubIssues}
        onGithubIssue={() => void pickIssue((client) => pickGithubIssue(client, project.path, (issue) => startIssue.current(issue)))}
        labelIssue={trayRowWidth >= COMPACT_TRAY_ROW_WIDTH}
        onRowWidth={setTrayRowWidth}
      />
    ) : !params.id && project.link && linearActive ? (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <IssueButton source="linear" labelled disabled={targetDisabled} onPress={() => void chooseIssue()} />
      </View>
    ) : null;
  const dock = (
    <ChatComposerDock
      settle={settle}
      btw={<BtwDock btw={btw} chatId={chatId} setQuotes={composer.setQuotes} focus={() => setComposerFocusRequest((value) => value + 1)} />}
      editing={edit.card}
      column={column}
      padding={dockPadding}
      onRoom={attachPanelRooms}
      onHeight={setDockHeight}
      client={client}
      project={project}
      chat={chat}
      chatId={chatId}
      chatsHomeOpen={chatsHomeOpen}
      disconnected={!!session.error}
      subchatPanel={subchatPanel}
      messages={messages}
      onOpenChat={onOpenFamilyChat}
      question={question}
      answering={answering}
      chips={{
        savedId: params.id,
        actionPr: prAction?.pr,
        actionDisabled: busy || !!run,
        onAction: () => prAction && void send(pullRequestActionBody(prAction.request), false, prAction.request),
        pr,
        mergeable: !prAction && pr?.state === "OPEN" && !!pr.readyToMerge,
        openThreads: prOpenThreads,
        onOpenPr: (page) => pr && openPr(pr.number, page, placeOf(pr)?.cwd),
        terminalDocks,
        terminalShown,
        terminalCount,
        onTerminal: () => setTerminalFor((current) => (current === chatId ? null : chatId)),
        ports,
        planPanel,
        agents,
        onAgents: () => headerAction("agents"),
      }}
      running={Boolean(run)}
      canSteer={canSteer}
      actionBusy={actionBusy}
      onQueueSend={(id) => void action(() => client.call("chat:queue-send", [chatId, id]), true)}
      onQueueRemove={(id) => void action(() => client.call("chat:queue-remove", [chatId, id]), true)}
      waiting={notes.waiting}
      approvals={run?.approvals.map(renderToolApproval)}
      sessionId={Number(params.id)}
      dictationChat={
        worktree?.path || !project.link
          ? { client, cwd: worktree?.path || project.path, chatTitle: title, provider: chat?.provider ?? actualProvider, chatId: chat?.id }
          : undefined
      }
      onAnswer={(answers, summary, images) => {
        if (!question) return;
        const answered = answeredQuestions(question, answers && answersWithImages(answers, images));
        const photos = Object.values(images ?? {}).flatMap((list) => list.flatMap((item) => (item.image ? [item.image] : [])));
        setSentAnswers({
          requestId: question.requestId,
          message: answered && {
            id: -1,
            session_id: Number(params.id),
            body: summary,
            context: null,
            role: "user",
            answered,
            ...(photos.length ? { images: photos } : {}),
          },
          count: messages.length,
        });
        void action(async () => {
          const uploaded = await prepareAnswerImages(client, projectOfKey(chatId), images);
          const accepted = await client.call("agent:answer-question", [
            { chatId, requestId: question.requestId, answers, summary, ...(uploaded ? { images: uploaded } : {}), ...secretAnswerFlag(question) },
          ]);
          if (!accepted) throw new Error("This question is no longer pending. Refresh the Chat.");
        }, true).then((ok) => {
          if (!ok) setSentAnswers((current) => (current?.requestId === question.requestId ? null : current));
        });
      }}
      undo={undo}
      undoIntent={undoIntent}
      onOpenUndoFile={
        project.link || !worktree
          ? undefined
          : (file) => router.push({ pathname: "/diff", params: { worktreeId: String(worktreeId), path: file.path, mode: "uncommitted" } })
      }
      start={startTray}
      trayTarget={trayTarget}
      tray={tray}
      composer={{
        fieldKey: params.id ? chatId : "new",
        ultracodeOn,
        picking,
        busy,
        running: Boolean(run),
        offline,
        actionBusy,
        sendLabel: busy ? "Sending…" : offline ? "Queue message" : run ? (queuesFollowUp ? "Queue message" : "Send now") : "Send message",
        ...edit.composer(sendBlocked),
        chats: mentionChats,
        computers: mentionComputers,
        currentId: chat?.id,
        client,
        projectPath: worktree?.path || (project.link ? "" : project.path),
        skillScope: project.link ? worktree?.path || project.path : undefined,
        suggestion:
          !run && !busy && !picking && activity?.activity === "idle" && chat?.provider === "claude" && actualProvider === "claude"
            ? chat.suggestion?.text
            : undefined,
        chatTitle: title,
        provider: chat?.provider ?? actualProvider,
        onImagePaste: (image) => void pasteImage(image),
        known: knownFiles.current,
        onMention: worktree?.path ? mentionFile : undefined,
        commands: chat && !chat.readOnlyReason ? CHAT_COMMANDS : STORAGE_COMMANDS,
        placeholder: composerPlaceholder({ offline, computerName, running: Boolean(run), queuesFollowUp, chatsHome: chatsHomeOpen && !params.id }),
        focusRequest: composerFocusRequest,
        onSend: () => void (edit.editing ? edit.send({ projectPath: project.path, worktreeId, model, preferences }) : send()),
        onSendStay: () => void send(undefined, true, undefined, undefined, true),
        onStop: () => void action(() => client.call("agent:interrupt", [chatId]), true),
        onFocus: () => {
          setComposerFocused(true);
          onTyping();
        },
        onBlur: () => setComposerFocused(false),
        onTouchStart: onTyping,
      }}
      controls={{
        attachDisabled: attachmentDisabled,
        onPick: (kind) => void pick(kind),
        compactButton,
        model,
        preferences,
        onModel: () =>
          router.push({
            pathname: "/model-sheet",
            params: {
              chatId,
              model: model.id,
              provider: actualProvider,
              ...(chat?.provider ? { on: chat.provider } : {}),
              ...(run ? { busy: "1" } : {}),
            },
          }),
        quietContext,
        compactionFeedback,
        contextUsage,
        showContextSize,
        compactWarning: compactState.warning,
        canCompact: supportsCompact,
        threshold: contextSettings.buttonThreshold,
        onContext: params.id ? () => router.push({ pathname: "/context-sheet", params: { id: params.id } }) : undefined,
      }}
    />
  );
  return (
    <GenerativeUIProvider send={genuiSend}>
      <ChatLinkProvider reachable={reachable} links={links} ask={askAboutPassage} steps={history.steps} liveSteps={liveSteps}>
        <PanelTabsContext value={panels.openInPanel}>
          <View style={[styles.screen, dots]}>
            {!paired && <ChatStackOptions title={title} starting={startingChat} header={header} />}
            {pane === "primary" && <HiddenHeaderOptions title={title} />}
            {!paired && sidebar}
            {!paired && more}
            <View style={{ flex: 1 }}>
              <PanelSwipe panels={panels} covered={planPanel.phase !== "closed" || subchatPanel.phase !== "closed"}>
                {/* The header clearance is in paddingTop; an automatic iOS inset would add it a second time. */}
                <KeyboardChatScrollView
                  key={scrollKey}
                  ref={scroll}
                  freeze={terminalTyping}
                  offset={lift}
                  keyboardLiftBehavior="whenAtEnd"
                  onEndVisible={onEndVisible}
                  contentInsetAdjustmentBehavior="never"
                  // iOS reads a tap on a React Native button near the top edge (the PR button, the Chat's title) as a tap on
                  // the status bar too and scrolls this transcript to its first message. Only native header buttons stop it.
                  scrollsToTop={false}
                  // Images above the screen load after the Chat is placed. The native view keeps the first visible message
                  // where it was in the same frame; a JS jump from onContentSizeChange arrives frames later and flickers.
                  maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  contentContainerStyle={[
                    styles.content,
                    column,
                    { paddingTop: topClear, paddingLeft: 28, paddingRight: 20, gap: 16, paddingBottom: dockHeight + 16 },
                  ]}
                  scrollEventThrottle={32}
                  {...dragHandlers}
                  onScroll={({ nativeEvent: e }) => {
                    const previous = scrollOffset.current;
                    scrollOffset.current = e.contentOffset.y;
                    const under = e.contentOffset.y > 4;
                    setUnderHeader((current) => (current === under ? current : under));
                    const distance = e.contentSize.height + (e.contentInset?.bottom ?? 0) - e.contentOffset.y - e.layoutMeasurement.height;
                    if (!placed && distance <= 1) setPlacedKey(scrollKey);
                    // Native scroll events can arrive before the jump catches up with image layout.
                    const step = nextFollow(
                      {
                        following: following.current,
                        scrollingToBottom: scrollingToBottom.current,
                        dragging: dragging.current,
                        scrolledFirstRow: scrolledFirstRow.current,
                      },
                      { offset: e.contentOffset.y, previous, distance, firstRowId },
                    );
                    following.current = step.following;
                    scrollingToBottom.current = step.scrollingToBottom;
                    scrolledFirstRow.current = step.scrolledFirstRow;
                    if (step.toBottom) scrollToBottom(false);
                    if (step.stop) return;
                    if (placed && e.contentOffset.y < previous && e.contentOffset.y <= 160 && !(historyState.key === scrollKey && historyState.error))
                      void showEarlier();
                  }}
                  style={{ opacity: placed ? 1 : 0 }}
                  onLayout={({ nativeEvent }) => {
                    viewport.current = nativeEvent.layout.height;
                    place();
                  }}
                  onContentSizeChange={(_, height) => {
                    contentHeight.current = height;
                    if (!placed) place();
                    else if (!historyAnchor.current && following.current && height > viewport.current) scrollToBottom(false);
                  }}
                >
                  {process.env.EXPO_PUBLIC_DEMO === "1" && (
                    <Text style={styles.caption}>Demo agent. Send tools, approval, question, or slow to try the controls.</Text>
                  )}
                  {session.providerError ? <Text style={styles.caption}>{session.providerError}</Text> : null}
                  {chat?.readOnlyReason ? (
                    <View style={styles.card}>
                      <Text style={styles.muted}>{chat.readOnlyReason}</Text>
                    </View>
                  ) : chat?.formerWorktree ? (
                    <View style={styles.card}>
                      <Text style={styles.muted}>{RUN_WORKTREE_REMOVED_NOTE}</Text>
                    </View>
                  ) : (
                    chat?.archived && (
                      <View style={styles.card}>
                        <Text style={styles.muted}>This Chat is archived. Restore it to send a message.</Text>
                        <PillButton
                          title="Restore Chat"
                          disabled={busy}
                          onPress={() => void action(() => client.call("chat:patch", [project.path, chat.id, { archived: false }]))}
                          style={{ alignSelf: "flex-start" }}
                        />
                      </View>
                    )
                  )}
                  {!messages.length && !run && !pageLoading && !historyPage.error && !startingChat && (
                    <View style={{ paddingVertical: 48, alignItems: "center", gap: 8 }}>
                      <Text style={styles.subtitle}>What are we working on?</Text>
                      <Text style={[styles.muted, { textAlign: "center" }]}>
                        {project.link
                          ? LINK_CHAT_WORKTREES_TEXT
                          : newWorktree
                            ? `Your agent starts in a new worktree from ${base || "the selected branch"} on your computer.`
                            : `Your agent runs in ${worktree?.name || "this Worktree"} on your computer.`}
                      </Text>
                    </View>
                  )}
                  {newWorktree && branches?.error && !base ? <ErrorNotice message={branches.error} /> : null}
                  {pageLoading ? <LoadingLogo /> : null}
                  {lean && historyPage.error ? (
                    <ErrorNotice message={`Could not load this Chat: ${historyPage.error}`} retry={() => void historyPage.retry()} />
                  ) : null}
                  {historyState.key === scrollKey && historyState.error ? <ErrorNotice message={historyState.error} retry={() => void showEarlier()} /> : null}
                  {messages.length + remote > visible && (
                    <PillButton
                      title={
                        historyState.key === scrollKey && historyState.loading
                          ? "Loading earlier messages..."
                          : `Show earlier messages (${messages.length + remote - visible})`
                      }
                      secondary
                      disabled={historyState.key === scrollKey && historyState.loading}
                      onPress={showEarlier}
                      style={{ alignSelf: "center" }}
                    />
                  )}
                  {groupedMessages.slice(-visible).flatMap(({ message, hidden, merged, exchange }) => [
                    ...(liveReply && message === pendingInput ? [liveReply] : []),
                    ...(hidden || notes.silent.has(message.id)
                      ? []
                      : [
                          <View
                            key={message.clientMessageId ?? message.id}
                            nativeID={`chat-message-${message.id}`}
                            style={edit.dimmed(message)}
                            onLayout={({ nativeEvent: { layout } }) => {
                              messagePositions.current.set(message.id, layout.y);
                              const anchor = historyAnchor.current;
                              if (anchor?.key === scrollKey && anchor.id === message.id) {
                                historyAnchor.current = null;
                                // From the offset when the page was asked for: the native position keeping may have moved it already.
                                const y = Math.max(0, anchor.offset + layout.y - anchor.y);
                                scrollOffset.current = y;
                                scroll.current?.scrollTo({ y, animated: false });
                              }
                              if (navigationTarget.current === message.id) {
                                navigationTarget.current = null;
                                scroll.current?.scrollTo({ y: Math.max(0, layout.y - topClear + 12), animated: true });
                              }
                            }}
                          >
                            {renderSubchatNote(message) ??
                              renderLinkedLine(message, exchange) ??
                              checkpointLine(message, run || chat?.readOnlyReason ? undefined : previewRecovery) ??
                              (isHandoff(message) ? (
                                <HandoffDivider context={message.context} models={handoffModels} onOpen={openBrief} />
                              ) : isWorktreeLinked(message) ? (
                                <WorktreeLinkDivider context={message.context} client={session.client} onOpen={(title, text) => openBrief(text, title)} />
                              ) : isCompaction(message) ? (
                                <CompactionDivider context={message.context} />
                              ) : isAccountSwitch(message) ? (
                                <AccountSwitchDivider context={message.context} />
                              ) : isLimitReset(message) ? (
                                <LimitResetDivider />
                              ) : isChatReload(message) ? (
                                <ChatReloadDivider />
                              ) : isBabysitStopped(message) ? (
                                <BabysitStoppedDivider context={message.context} />
                              ) : isRoutineRun(message) ? (
                                <RoutineRunDivider context={message.context} merged={merged} />
                              ) : isValidation(message) ? (
                                <ValidationCard
                                  context={message.context}
                                  chatId={chat?.readOnlyReason ? null : chatId}
                                  call={client?.call.bind(client)}
                                  onAskToFix={(text) => void send(text, false)}
                                />
                              ) : (
                                <>
                                  {issueRunDivider(message, merged)}
                                  <ChatRow
                                    message={message}
                                    onFork={forkFromMessage}
                                    chats={message.role === "user" ? replyChats : undefined}
                                    media={media}
                                    basePath={worktree?.path || project.path}
                                    chatId={chatId}
                                    designChoice={designChoice}
                                    designsMoved={message.role === "user" ? designsMoved : undefined}
                                    limitPending={message.id === chat?.limitResume?.sourceMessageId ? chat.limitResume : undefined}
                                    limitResumeAvailable={message.id === chat?.limitTurn?.sourceMessageId}
                                    limitResumeBlocked={message.id === chat?.limitTurn?.sourceMessageId ? !!chat?.queued?.length : undefined}
                                    limitProjectPath={
                                      !run && !pending && message.id === (chat?.limitTurn?.sourceMessageId ?? messages[messages.length - 1]?.id)
                                        ? project.path
                                        : undefined
                                    }
                                    onActivity={openActivity}
                                    {...edit.row(message, message.id === undoHighlight, chat, offline)}
                                    onOpenChat={onOpenFamilyChat}
                                  />
                                </>
                              ))}
                          </View>,
                        ]),
                  ])}
                  {!pendingInput && liveReply}
                  {answerPreview && <ChatReply key="answers" message={answerPreview} media={media} chatId={chatId} onActivity={openActivity} />}
                  {(run || pending) && <RunIndicator chatKey={chatId} startedAt={pending?.preview.startedAt} phase={phase} model={model.name} />}
                  {!run && !pending && activity?.activity === "background" && background.length > 0 && (
                    <BackgroundIndicator
                      count={background.length}
                      startedAt={background[0]?.startedAt}
                      mark={<BackgroundRing count={background.length} />}
                      onPress={() => chat && router.push({ pathname: "/background", params: { id: String(chat.id) } })}
                    />
                  )}
                  {heartbeat && !run && !pending && typeof heartbeat.nextRunAt === "number" && heartbeat.nextRunAt > now ? (
                    <Text
                      style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, textAlign: "center" }}
                    >{`Next check ${clock(heartbeat.nextRunAt)}`}</Text>
                  ) : null}
                  {chat?.resumeTurn && !run && (
                    <PillButton
                      title="Continue interrupted turn"
                      secondary
                      disabled={busy}
                      onPress={() => void action(() => client.call("chat:resume", [project.path, chat.id]))}
                      style={{ alignSelf: "flex-start" }}
                    />
                  )}
                  {error ? <ErrorNotice message={error} /> : null}
                  {session.error && !offline ? <ErrorNotice message={session.error} retry={() => router.dismissTo("/")} /> : null}
                </KeyboardChatScrollView>
                {/* The transcript blurs and fades under the transparent header, as under the composer. iOS's own soft edge can't
        find this scroll view (it only follows each view's first child), so the blur is drawn here. It ends where the
        transcript's top padding does and gradually strengthens toward the status bar. It shows only while the transcript
        is under the header, so the dots run edge to edge otherwise. */}
                {underHeader && <EdgeFade edge="top" height={topClear} width={window.width} />}
                {paneHeader}
                {bookmark && (
                  <SubchatBookmarkHost sessions={project.state.sessions} chatKey={chatId} top={insets.top + chrome.header + 8} onBack={onOpenFamilyChat} />
                )}
                {startingChat && (
                  <Animated.View
                    pointerEvents="box-none"
                    style={[
                      {
                        position: "absolute",
                        left: 24,
                        right: 24,
                        top: insets.top + 56,
                        bottom: dockHeight,
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                      },
                      startLineStyle,
                    ]}
                  >
                    <View pointerEvents="none" style={{ flex: 1 }} />
                    {chatsHomeOpen ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${JUST_CHAT_HEADING} on ${chatsComputer}. Change computer`}
                          disabled={busy}
                          onPress={chooseChatsComputer}
                          style={({ pressed }) => ({
                            flexDirection: "row",
                            flexWrap: "wrap",
                            justifyContent: "center",
                            alignItems: "center",
                            columnGap: 6,
                            ...pressStyle({ pressed }),
                          })}
                        >
                          <Text style={{ fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600", color: colors.ink }}>
                            {JUST_CHAT_HEADING} on
                          </Text>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
                            <Text
                              numberOfLines={1}
                              style={{ fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600", color: colors.accent, flexShrink: 1 }}
                            >
                              {chatsComputer}
                            </Text>
                            <Icon icon={ArrowDown01Icon} tone="accent" size={18} />
                          </View>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${NO_PROJECT_LABEL}, ${NO_PROJECT_FOLDER.toLowerCase()}. Change project`}
                          disabled={busy}
                          onPress={chooseProject}
                          hitSlop={8}
                          style={({ pressed }) => pressStyle({ pressed })}
                        >
                          <Text style={{ fontSize: type.subheadline, lineHeight: lineHeight.subheadline, color: colors.ink3, textAlign: "center" }}>
                            {NO_PROJECT_LINE}
                          </Text>
                        </Pressable>
                      </>
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Start building in ${projectName}. Change project`}
                        disabled={busy}
                        onPress={chooseProject}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          flexWrap: "wrap",
                          justifyContent: "center",
                          alignItems: "center",
                          columnGap: 6,
                          ...pressStyle({ pressed }),
                        })}
                      >
                        <Text style={{ fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600", color: colors.ink }}>Start building in</Text>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
                          <Text
                            numberOfLines={1}
                            style={{ fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600", color: colors.accent, flexShrink: 1 }}
                          >
                            {projectName}
                          </Text>
                          <Icon icon={ArrowDown01Icon} tone="accent" size={18} />
                        </View>
                      </Pressable>
                    )}
                    <View pointerEvents="box-none" style={{ flex: newChatStats ? 3 : 1, alignSelf: "stretch" }}>
                      {restingKeyboard === 0 && newChatStats && (
                        <NewChatGlance
                          client={session.client}
                          projectPath={chatsHomeOpen ? null : (session.snapshot?.project.path ?? null)}
                          scopeKey={session.snapshot?.project.path ?? ""}
                        />
                      )}
                    </View>
                  </Animated.View>
                )}
                {!secondary && <FloatingInboxSlot bottom={dockHeight + 12} />}
                {toast ? (
                  <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, top: insets.top + 64, alignItems: "center" }}>
                    <ToastPill text={toast.text} />
                  </View>
                ) : null}
                {historyToast && !secondary ? (
                  <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, top: insets.top + 64, alignItems: "center" }}>
                    <ToastPill key={historyToast.id} {...historyToast} />
                  </View>
                ) : null}
                <MessageNavigation
                  items={navigationItems}
                  onSelect={navigateToMessage}
                  top={topClear - 12}
                  bottom={dockHeight + 12}
                  keyboardOffset={lift}
                  followKeyboard={!terminalTyping}
                />
                <KeyboardStickyView
                  enabled={!terminalTyping}
                  pointerEvents="box-none"
                  offset={{ closed: 0, opened: lift }}
                  style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
                >
                  {dock}
                  {showJumpToBottom && (
                    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: dockHeight, height: 56, alignItems: "center" }}>
                      <GlassIconButton label="Go to bottom" systemImage="chevron.down" icon={ArrowDown01Icon} onPress={jumpToBottom} />
                    </View>
                  )}
                </KeyboardStickyView>
              </PanelSwipe>
            </View>
            {terminalMounted === chatId && chat && (
              <TerminalDock
                key={chatId}
                chatId={chatId}
                places={terminalPlaces(chat)}
                open={terminalShown}
                onClosed={() => setTerminalMounted(null)}
                keyboard={ownsKeyboard && terminalTyping}
                onHeight={setTerminalHeight}
                onCount={setTerminalCount}
                onClose={() => setTerminalFor(null)}
              />
            )}
            <PlanPanel panel={planPanel} />
            <SubchatPanel panel={subchatPanel} messages={messages} onOpenChat={onOpenFamilyChat} />
          </View>
        </PanelTabsContext>
      </ChatLinkProvider>
    </GenerativeUIProvider>
  );
}
