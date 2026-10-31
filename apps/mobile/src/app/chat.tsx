import { useCompactionFeedback } from "@milagre/shared/use-compaction-feedback";
import { useContextSettings } from "../context-settings";
import { compactionContext } from "@milagre/shared/compaction";
import { CleanIcon } from "@hugeicons/core-free-icons";
import { outbox, outboxAttachments, hasQueuedChat } from "../outbox";
import { ComposerTray, OfflineTray } from "../offline-tray";
import { LINK_CHAT_WORKTREES_TEXT } from "@milagre/shared/worktree-link";
import { GenerativeUIProvider } from "../genui/GenerativeUI";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chatHistory } from "@milagre/shared/chat-history";
import type Reanimated from "react-native-reanimated";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Alert, Image, Keyboard, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { UltracodeGlow } from "../ultracode-glow";
import { Redirect, Stack, router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import type { NavigationProp } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  BubbleChatIcon,
  Globe02Icon,
  GitPullRequestIcon,
  Cancel01Icon,
  File01Icon,
  GitBranchIcon,
  GitForkIcon,
  ComputerIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  SidebarLeftIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { sessionForWorktree } from "@milagre/shared/model";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { compactButtonState } from "@milagre/shared/chat-display";
import { useCompactButtonDisplay, useShowContextSize } from "../chat-display-setting";
import type { ChatMessage, LinkIssueResult, PullRequestActionContext, RoutineRunContext, WorktreeBinding } from "@milagre/shared/model";
import {
  associatedPullRequest,
  chatPullRequests,
  chatTitle,
  createPendingChat,
  createResendMemory,
  pendingChatSessionId,
  pullRequestRefs,
  withPreview,
} from "@milagre/shared/chats";
import { runStatusLabel, sendStatusLabel } from "@milagre/shared/tool-activity";
import { messageSender } from "@milagre/shared/advisor-result";
import { messageNavigationIndices } from "@milagre/shared/message-navigation";
import { LINK_PR_HINT, issueChipLabel, issueFirstMessage, type LinearIssue, type LinearIssuesResult } from "@milagre/shared/linear";
import { worktreeShared } from "@milagre/shared/archive";
import type { Client, OpenProject, Snapshot } from "../client";
import { answeredQuestions, lastUserModel, projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { pullRequestAction, pullRequestPresentation, rowPullRequests } from "@milagre/shared/pr-blockers";
import { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } from "@milagre/shared/pr-action";
import { linearIssueContext, linearIssueRequest } from "@milagre/shared/linear-issue";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { ChatLinkProvider } from "../chat-link-context";
import { useReachableHost } from "../routes-native";
import { sameSession, useComposer, useMainSession, usePendingChats, useRun, useSession } from "../session";
import { pendingOnScreen, pendingOrigin } from "../pending-chats";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import { pickAttachments, preparePastedImage, discardPastedImage, type PastedImage } from "../attachment-picker";
import { chatMentionChoices, shiftImageMentions } from "@milagre/shared/prompt-mentions";
import { addMention, appendAttachments, appendImageMentions, attachmentPrompt, mentionAttachments, prepareAttachments } from "../attachments";
import { BackgroundRing, HeaderPullRequestChip, PullRequestAction, PullRequestMerge, PullRequestReview, SubagentChip } from "../status-indicators";
import { usePrDetail } from "../pr-store";
import { openThreads } from "@milagre/shared/pull-request-review";
import { openPrPage, openPullRequest } from "../pr-nav";
import { onPullRequestRequest, prChoiceKey, registerPrChat, type PrChoice } from "../pr-chat";
import { widthClass } from "../split-width";
import { backgroundItems, chatActivity } from "@milagre/shared/chat-activity";
import { useChatPullRequests } from "../use-chat-pull-requests";
import { SimulatorChip } from "../simulator";
import { useBrowserShortcut } from "../browser";
import { useInternalBrowser } from "../browser-setting";
import { openBrowserLink } from "../browser-link";
import { PortsChip, useChatPorts } from "../ports";
import { TerminalChip, TerminalDock, terminalPlaces } from "../terminal";
import { KeyboardChatScrollView, KeyboardStickyView, useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { ChatReply } from "../chat-reply";
import { designMessageSent, onSendDesignMessageNow, peekDesignMessage } from "../design-outbox";
import { PanelTabsContext } from "../panel-tabs";
import { chosenDesign, designActivity } from "@milagre/shared/artifact";
import { handoffSides } from "../handoff-sides";
import { HandoffDivider } from "../handoff-divider";
import { showBrief } from "../handoff-brief-store";
import { WorktreeLinkDivider } from "../worktree-link-divider";
import { AccountSwitchDivider } from "../account-switch-divider";
import { ChatReloadDivider } from "../chat-reload-divider";
import { BabysitStoppedDivider } from "../babysit-stopped-divider";
import { CheckpointRestoreDivider } from "../checkpoint-restore-divider";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import type { CheckpointApi } from "@milagre/shared/checkpoints";
import { UndoPanel, type UndoIntent } from "../undo-panel";
import { isChatReload, RELOAD_TEXT } from "@milagre/shared/chat-reload";
import { babysitStoppedText, isBabysitStopped } from "@milagre/shared/babysit";
import { RoutineRunDivider } from "../routine-run-divider";
import { chatRoutine, clock, groupQuietRuns, isRoutineRun, mergedRoutineRunText, routineRunOf, routineRunText } from "@milagre/shared/routines";
import { CompactionDivider } from "../compaction-divider";
import { isHandoff } from "@milagre/shared/handoff";
import { COMPACT_COMMAND, compactionText, isCompaction } from "@milagre/shared/compaction";
import { accountSwitchText, isAccountSwitch } from "@milagre/shared/usage-limit";
import { isWorktreeLinked, worktreeLinkText } from "@milagre/shared/worktree-link";
import { BackgroundIndicator, ThinkingIndicator } from "../running-logo";
import { BottomFade, EdgeFade } from "../bottom-fade";
import { useDotBackground } from "../dot-background";
import { Approval, ActivityQuestions } from "../questions";
import { QueuedMessages } from "../queued-messages";
import { AgentControls, PermissionChip } from "../agent-controls";
import { afterSend, chatPreferences, modelsFor, selectedModel, sendOptions, turnTarget } from "../turn-options";
import { Icon, LinearLogo } from "../icons";
import { PanelSwipe, useSidePanels } from "../side-panels";
import { useSplit, useSplitLayout } from "../split-context";
import { chatAreaWidth, READING_WIDTH } from "../split-width";
import { useReadOpenChat } from "../read-open-chat";
import { LoadingLogo } from "../loading-logo";
import { useOpenProject } from "../use-open-project";
import { PersistenceNotice } from "../persistence-notice";
import { HeaderAction, HeaderActionGroup } from "../primitives/header-action-group";
import { ErrorNotice, GlassIconButton, IconButton, PageScroll, PillButton, PullDown, useStyles, type MenuSection } from "../ui";
import { clearSentDraft } from "../draft-clear";
import { PromptField } from "../prompt-field";
import { createKnownFiles, mentionPaths } from "../file-mentions";
import { ContextRing } from "../context-ring";
import { PlanPanel, PlanPill, usePlanPanel } from "../plan-pill";
import { useTheme } from "../theme";
import { ToastPill } from "../primitives/toast";
import { archiveFromPhone, showArchiveNotice } from "../archive";
import { randomUUID } from "expo-crypto";
import { runChatAction } from "../chat-actions";
import { useChatPage } from "../chat-pages";
import { MessageNavigation } from "../message-navigation";
import { AttentionPill } from "../attention";
import { useLinear } from "../use-linear";
import { useRoutines } from "../use-routines";
import { useActivityClock } from "../chat-row-store";
import { useWorktreeLinearIssues } from "../use-worktree-linear-issues";
import { savedChatDefaults } from "../hosts-native";
import { showChoiceSheet } from "../choice-store";
import { allComputers, chatsHomePath, useNewChatProjects, useNoProjectChoice } from "../all-computers";
import {
  CHATS_PLACEHOLDER,
  CHATS_TRAY_LABEL,
  isChatsHomeProject,
  JUST_CHAT_HEADING,
  NO_PROJECT_FOLDER,
  NO_PROJECT_LABEL,
  NO_PROJECT_LINE,
} from "@milagre/shared/chats-home";
import { newChatProjectGroups, preferredCopy, type NewChatProject } from "../new-chat-project";
import { ChatsHomeIcon, ProjectIcon } from "../project-icon";
import { panelWorktree } from "../project-surfaces";
import { besideState, closeBeside, openBeside, useBesideChat } from "../split-chats";
import { BesideSession, touchPane } from "../beside-session";
import { SENT_FROM } from "../sent-from";

const PAGE = 40;
const KEEP_VISIBLE_POSITION = { minIndexForVisible: 0 };
const PLACE_FALLBACK_MS = 500;

// A Linear Run's first message is its issue card carrying the Run: its divider shows above the card.
function issueRunDivider(message: ChatMessage, merged?: { count: number; last: RoutineRunContext }) {
  const run = isRoutineRun(message) ? null : routineRunOf(message);
  return run ? <RoutineRunDivider context={run} merged={merged} /> : null;
}

/** Below this, the new-Chat tray's Linear chip shows only its logo so the row fits on one line (a phone; an iPad keeps the label). */
const COMPACT_TRAY_ROW_WIDTH = 460;

/** A row's id: two workspaces can both have an ENG-1. A Mac that predates workspaces sends the key alone. */
const issueChoiceId = (issue: LinearIssue) => (issue.workspace ? `${issue.workspace}:${issue.key}` : issue.key);
/** The choice sheet's rows for a list of Linear issues. */
function issueChoices(issues: LinearIssue[]) {
  return issues.map((issue) => ({ id: issueChoiceId(issue), title: `${issue.key} ${issue.title}`, subtitle: issue.state.name }));
}
/** The workspace the issue sheet showed last, so it opens there again. */
let lastLinearWorkspace: string | undefined;
const UNDO_COMMANDS = [{ name: "undo", description: "Undo a task's file changes" }];
const NO_CHECKPOINTS: CheckpointApi = {
  list: async () => [],
  preview: () => Promise.reject(new Error("Connect to the computer to undo changes")),
  restore: () => Promise.reject(new Error("Connect to the computer to undo changes")),
};

// The native header lays its title out between the sidebar button and the toolbar group, and lets a title wider than that run
// under the group. These are the pieces of that room, in points: the header's inset from the screen edge, one round button,
// the Browser, PR and ⋯ buttons sharing a pill, and the clear space beside the title. The title is never wider than 230.
const HEADER_EDGE = 16;
const HEADER_BUTTON = 44;
const HEADER_BUTTON_PITCH = 44;
const HEADER_GAP = 12;
const HEADER_TITLE_MAX = 230;
/** The widest the header title may be on a screen `screenWidth` wide: what is left between the sidebar button and the toolbar group. */
function headerTitleWidth(screenWidth: number, actionCount: number) {
  const left = HEADER_EDGE + HEADER_BUTTON + HEADER_GAP;
  const right = HEADER_EDGE + (HEADER_BUTTON + (actionCount - 1) * HEADER_BUTTON_PITCH) + HEADER_GAP;
  return Math.max(0, Math.min(HEADER_TITLE_MAX, screenWidth - left - right));
}

/** The header title's box, as wide as the room the pinned sidebar leaves. */
function HeaderTitleBox({ actionCount, children }: { actionCount: number; children: ReactNode }) {
  const window = useWindowDimensions();
  const { pinned } = useSplit();
  return <View style={{ alignItems: "center", width: "100%", maxWidth: headerTitleWidth(chatAreaWidth(window.width, pinned), actionCount) }}>{children}</View>;
}

/** The native header's sidebar button: shows or hides the pinned sidebar, or slides the navigation over on a narrower window. */
function SidebarToolbar({ onOpenNavigation }: { onOpenNavigation: (side: "left") => void }) {
  const split = useSplit();
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button
        icon="sidebar.left"
        accessibilityLabel={split.dockable ? (split.pinned ? "Hide sidebar" : "Show sidebar") : "Open navigation"}
        onPress={() => (split.dockable ? split.toggle() : onOpenNavigation("left"))}
      />
    </Stack.Toolbar>
  );
}

/** The sidebar button of a Chat with another beside it, which draws its own header. */
function SidebarButton() {
  const { pinned, toggle } = useSplit();
  return <GlassIconButton label={pinned ? "Hide sidebar" : "Show sidebar"} systemImage="sidebar.left" icon={SidebarLeftIcon} onPress={toggle} />;
}

// `prefill`: a new Chat's first draft, from a search that found nothing or the Project it switched from.
type ChatParams = { id?: string; worktreeId?: string; projectPath?: string; hostId?: string; draft?: string; prefill?: string };

/**
 * The routed Chat, and on a wide iPad a second Chat beside it, of any Project on any computer, opened from a sidebar
 * row's "Open beside" (split-chats.ts). The routed Chat keeps its place in the tree as the one beside comes and goes.
 */
const NO_MEMBERS: WorktreeBinding[] = [];
const NO_REFS: string[] = [];

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
  const shown = state === "shown" && beside ? beside : null;
  // Closing the routed Chat leaves the one beside it in its place.
  const promote = useCallback(() => {
    if (!shown) return;
    router.setParams({ id: String(shown.chatId), worktreeId: undefined, draft: undefined, prefill: undefined });
    closeBeside();
  }, [shown]);
  // The pane whose composer has focus owns the keyboard: only its composer rides it and only its transcript makes room, so
  // the other pane does no keyboard-driven layout work on every frame of the animation.
  const [typing, setTyping] = useState<"routed" | "beside">("routed");
  const besideTyping = Boolean(shown) && typing === "beside";
  const routedTypes = useCallback(() => setTyping("routed"), []);
  const besideTypes = useCallback(() => setTyping("beside"), []);
  // A sheet a pane opens is about that pane's Chat, so it reads that pane's Project (beside-session.tsx).
  const routedTouched = useCallback(() => touchPane("routed"), []);
  const besideTouched = useCallback(() => touchPane("beside"), []);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
      {/* Each pane clips its edge fades, which are as wide as the window so that the sidebar's slide never resizes them. */}
      <View style={{ flex: 1, overflow: "hidden" }} onTouchStart={routedTouched}>
        <ChatPane
          key="routed"
          visibleChat={shown && shown.hostId === (params.hostId || session.client?.url) ? `${shown.projectPath}#${shown.chatId}` : undefined}
          params={params}
          pane={shown ? "primary" : "single"}
          keyboard={!besideTyping}
          onTyping={routedTypes}
          onClose={promote}
        />
      </View>
      {shown && (
        <>
          <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.line }} />
          <View style={{ flex: 1, overflow: "hidden" }} onTouchStart={besideTouched}>
            {/* A Chat of another Project or computer reads its own Project's session; one of the open Project shares it. */}
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
          </View>
        </>
      )}
    </View>
  );
}

/**
 * One Chat: the routed one (`single`, or `primary` with another beside it), or the one beside it (`secondary`), which
 * leaves the route, the native header, the side panels and the open Project to the routed one. Every read and action
 * goes through useSession, which for a Chat beside of another Project is that Project's own (beside-session.tsx).
 */
function ChatPane({
  visibleChat,
  params: routeParams,
  pane,
  keyboard: ownsKeyboard,
  onTyping,
  onClose,
}: {
  visibleChat?: string;
  params: ChatParams;
  pane: "single" | "primary" | "secondary";
  /** Whether this pane follows the keyboard: always alone, only the last touched one in a split. */
  keyboard: boolean;
  /** Its composer took focus: in a split, this pane gets the keyboard. */
  onTyping: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [showContextSize] = useShowContextSize();
  const { settings: contextSettings } = useContextSettings();
  const [compactButtonDisplay] = useCompactButtonDisplay();
  // Navigation can publish setParams after the session's React state. Bridge that commit with the destination's
  // params, so the new snapshot never renders against the old route and briefly unmounts the composer.
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
  // This New Chat's own id; the drawer passes a sending one's back to reopen it (pending-chats.ts).
  const [ownDraft] = useState(() => randomUUID());
  const draftId = params.draft || ownDraft;
  const session = useSession();
  // The Chat beside reads its own Project when that isn't the open one.
  const openSession = useMainSession();
  const ownProject = !sameSession(session, openSession);
  const composer = useComposer();
  const pendingStore = usePendingChats();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // Only the pieces that read whether the sidebar is pinned (SidebarToolbar, SidebarButton, HeaderTitleBox) re-render as it
  // shows or hides; the Chat itself doesn't.
  const split = useSplitLayout();
  // On a wide iPad the transcript and composer keep to a centered reading column. It is a max width, not padding
  // worked out from the window, so the column slides without reflowing while the sidebar opens or closes.
  const column = { width: "100%", maxWidth: READING_WIDTH, alignSelf: "center" } as const;
  const [actionBusy, setBusy] = useState(false);
  // Answers just sent: the card leaves and the answers show at once, until the host's copy arrives.
  const [sentAnswers, setSentAnswers] = useState<{ requestId: string; message: ChatMessage | null; count: number } | null>(null);
  const sendingRef = useRef(new Set<string>());
  const [sendingKeys, setSendingKeys] = useState<string[]>([]);
  /** Which typed @mentions name a Project file: those are tinted and attached at send. */
  const knownFiles = useRef(createKnownFiles());
  // The id of a send that failed before the host answered: it may have been saved, so the same text resent reuses it.
  const failedSends = useRef(createResendMemory());
  const [picking, setPicking] = useState(false);
  // The new-Chat tray row's width: 0 until it is laid out, which keeps the Linear chip compact on a phone from the start.
  const [trayRowWidth, setTrayRowWidth] = useState(0);
  const [dockHeight, setDockHeight] = useState(140);
  // The Chat whose Terminals are docked below it (an iPad); another Chat in this pane starts without them.
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  // The Chat whose docked Terminals are on screen, also while they sink away after being put away.
  const [terminalMounted, setTerminalMounted] = useState<string | null>(null);
  const [terminalHeight, setTerminalHeight] = useState(0);
  const [terminalCount, setTerminalCount] = useState<number | undefined>(undefined);
  // The composer has the keyboard; without it, a keyboard up over the docked Terminal is the Terminal's.
  const [composerFocused, setComposerFocused] = useState(false);
  const [error, setError] = useState("");
  // Bumped after a link or unlink so the Linear issues of the Worktrees are read again.
  const [linkVersion, setLinkVersion] = useState(0);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  // Undo changes: the Chat's task checkpoints, shown in the composer's place from ⋯, /undo or an undo line's Redo.
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
  const reachableHost = useReachableHost(session.client?.url);
  const targetProject = params.projectPath || session.snapshot?.project.path || "";
  const targetScope = JSON.stringify([targetHost, targetProject]);
  const [targetChoice, setTargetChoice] = useState(() => ({ scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) }));
  const target = targetChoice.scope === targetScope ? targetChoice : { scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) };
  if (targetChoice.scope !== targetScope) setTargetChoice(target);
  const { isolation: pickedIsolation, baseBranch = "" } = target;
  const chooseTarget = (patch: Partial<typeof target>) => {
    setTargetChoice({ ...target, ...patch });
    void savedChatDefaults.saveTarget(targetHost, targetProject, patch);
  };
  const [branchList, setBranchList] = useState<{ client: Client; path: string; items: string[]; error?: string } | null>(null);
  // A failed send can retry in the checkout already created for this draft.
  const preparedTarget = useRef<{ client: Client; path: string; base: string; issueKey?: string; worktreeId: number; sessionId: number } | null>(null);
  const scroll = useRef<Reanimated.ScrollView>(null);
  const dots = useDotBackground();
  const following = useRef(true);
  const scrollingToBottom = useRef(false);
  const scrollToBottom = useCallback((animated: boolean) => {
    scrollingToBottom.current = true;
    scroll.current?.scrollToEnd({ animated });
  }, []);
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
  // Saving a draft changes its address, not its transcript or native keyboard/scroll state.
  const adoptChat = useCallback(
    (id: number) => {
      setScrollIdentity((current) => ({ ...current, route: `${scrollScope}|${id}`, key: scrollKey }));
      // The Chat beside the routed one never has a route of its own to change.
      if (!secondary) router.setParams({ id: String(id) });
    },
    [scrollScope, scrollKey, secondary],
  );
  const currentScrollKey = useRef(scrollKey);
  const [historyState, setHistoryState] = useState({ key: scrollKey, loading: false, error: "" });
  const [jumpState, setJumpState] = useState({ key: scrollKey, visible: false });
  const showJumpToBottom = jumpState.key === scrollKey && jumpState.visible;
  // Whether the transcript has scrolled under the header: its fade shows only then, as desktop's top blur does.
  const [underHeader, setUnderHeader] = useState(false);
  // A Chat opens already at its newest message: the transcript stays hidden until the scroll view reports its end on
  // screen. The jump to the end can land frames after a long transcript mounts, and showing it earlier flashes the top.
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
    };
  }, [scrollKey]);
  // Short transcripts never auto-scroll: a scroll to the end while the keyboard is up would stay offset after it hides.
  const viewport = useRef(0);
  const place = () => {
    if (placed || !viewport.current || !contentHeight.current) return;
    if (contentHeight.current <= viewport.current) {
      setPlacedKey(scrollKey);
      return;
    }
    // Asked again on every layout until shown, so the jump reaches the latest end. The timer shows a Chat whose end
    // never reports, rather than leaving it hidden.
    scrollToBottom(false);
    placeTimer.current ??= setTimeout(() => setPlacedKey(scrollKey), PLACE_FALLBACK_MS);
  };
  const worktreeOf =
    session.snapshot?.project.state.worktrees[
      (params.id ? session.snapshot.project.state.sessions[Number(params.id)]?.worktree_id : Number(params.worktreeId)) ?? -1
    ];
  // Stable props keep each memoized ChatReply from re-rendering on every keystroke and poll tick.
  const connected = session.client;
  const projectPath = session.snapshot?.project.path;
  const mentionState = session.snapshot?.project.state;
  const mentionLink = session.snapshot?.project.link;
  // This Chat's streaming turn, read on its own: a runs read for another Chat of the Project re-renders nothing here.
  const liveRun = useRun(params.id && projectPath ? `${projectPath}#${params.id}` : undefined);
  const mentionKey = JSON.stringify(mentionState && !mentionLink ? chatMentionChoices(mentionState) : []);
  const mentionChats = useMemo(() => JSON.parse(mentionKey) as ReturnType<typeof chatMentionChoices>, [mentionKey]);
  // Linear is read only while the Mac has it on and connected; a linked Chat has no Worktrees of its own.
  const { active: linearActive } = useLinear(connected);
  // The Mac's Routines, for this Chat's Heartbeat: the header button and the Next check line.
  // With the Mac's switch off nothing runs, so a listed Heartbeat promises no check.
  const { routines, enabled: routinesOn } = useRoutines(connected);
  const beating = routinesOn === true && routines.some((routine) => routine.enabled && routine.target.kind === "chat");
  // Now, to the half minute, only while some Heartbeat could show a Next check.
  const now = useActivityClock(beating);
  // A Chat without a Project runs in the Chats home: no branch, PR or Linear issue of its own to show (as on desktop).
  const chatsHomeOpen = isChatsHomeProject(session.snapshot?.project);
  const linearIssues = useWorktreeLinearIssues(
    connected,
    linearActive && projectPath && !session.snapshot?.project.link && !chatsHomeOpen ? [projectPath] : [],
    linkVersion,
  );
  const targetMatches = (!params.projectPath || params.projectPath === projectPath) && (!params.hostId || params.hostId === connected?.url);
  const originChatId = pendingOrigin(projectPath, params.id, params.worktreeId, draftId);
  const pending = targetMatches
    ? pendingOnScreen(pendingStore.pendingChats, { hostId: connected?.url, projectPath, origin: originChatId, id: params.id })
    : undefined;
  const pendingCanonicalId = pending && session.snapshot ? pendingChatSessionId(session.snapshot.project.state, pending.preview) : null;
  const archiveRequest = useRef(false);
  // A send the computer took no longer holds the composer while its saved copy is on the way: a stale snapshot would
  // otherwise keep the button spinning until the turn ends.
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
    // A busy Mac (429) or a dropped answer is read again for a minute; the error shows only once that gives up.
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
  // A screen reopened from the drawer adopts its own acknowledged Chat; the original async handler may be unfocused.
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
  const allMessages = session.snapshot?.project.state.messages;
  // A host that keeps messages by Chat sends the snapshot without them: the Chat on screen reads its own as pages, its
  // last turns again as the Project state changes (a saved message changes it), never on a read of the streaming turns.
  const lean = !!session.snapshot?.project.state.messagesInChats;
  const page = useChatPage(lean && targetMatches ? connected : null, projectPath, params.id ? Number(params.id) : null, mentionState, session.reconnects);
  const canonicalPage = useChatPage(
    lean && targetMatches && pendingCanonicalId !== null ? connected : null,
    projectPath,
    pendingCanonicalId,
    mentionState,
    session.reconnects,
  );
  const media = useCallback((path: string) => connected!.image(projectPath!, path), [connected, projectPath]);
  const savedMessages = useMemo(
    () => (lean ? page.messages : params.id && allMessages ? allMessages.filter((m) => m.session_id === Number(params.id)) : []),
    [lean, page.messages, allMessages, params.id],
  );
  const loadedMessages = useMemo(
    () =>
      pending
        ? pendingCanonicalId !== null
          ? lean
            ? canonicalPage.messages
            : (allMessages || []).filter((message) => message.session_id === pendingCanonicalId)
          : withPreview(savedMessages, pending.preview)
        : savedMessages,
    [pending, pendingCanonicalId, lean, canonicalPage.messages, allMessages, savedMessages],
  );
  // Messages the host still holds before the ones here.
  const historyPage = pendingCanonicalId !== null ? canonicalPage : page;
  // A summary can acknowledge a send before its message page arrives. Keep what is already on screen during that read.
  const [transcript, setTranscript] = useState({ key: scrollKey, messages: loadedMessages });
  const messages = lean && historyPage.loading && !loadedMessages.length && transcript.key === scrollKey ? transcript.messages : loadedMessages;
  const compactionFeedback = useCompactionFeedback(
    messages.findLast((item) => compactionContext(item)),
    scrollKey,
  );
  if (transcript.key !== scrollKey || transcript.messages !== messages) setTranscript({ key: scrollKey, messages });
  // A saved Chat whose page is still on its way shows nothing yet, not the new-chat welcome.
  const pageLoading = lean && Boolean(params.id) && historyPage.loading && !messages.length;
  // The open Chat's PRs, read as its row in the Chat list reads them (same refs, same pooled lookups), so the PR action
  // above the composer and the row's status are about the same PRs.
  const prPath = session.snapshot?.project.link || chatsHomeOpen ? undefined : worktreeOf?.path;
  const openChat = params.id ? session.snapshot?.project.state.sessions[Number(params.id)] : undefined;
  const savedPrRefs = openChat ? (openChat.summary?.pullRequests ?? session.snapshot?.project.pullRequestRefs?.[openChat.id]) : undefined;
  const prRefs = useMemo(() => (openChat ? (savedPrRefs ?? pullRequestRefs(messages)) : []), [openChat, savedPrRefs, messages]);
  // A Link Chat's PRs are the ones its Projects' Worktree branches opened, each read in that Worktree.
  const linkView = session.snapshot?.project.link;
  const linkMembers = (linkView && params.id ? linkView.state.sessions[params.id]?.worktrees : undefined) ?? NO_MEMBERS;
  const prStatus = useChatPullRequests(
    session.client,
    prPath ? [{ path: prPath, refs: prRefs }] : linkMembers.map((member) => ({ path: member.worktreePath, refs: NO_REFS })),
  );
  const chatPrs = prPath ? chatPullRequests(prRefs, prStatus[prPath]?.found ?? {}, prStatus[prPath]?.branch) : [];
  const linkPrs = linkMembers.flatMap((member) => {
    const branch = prStatus[member.worktreePath]?.branch;
    return branch
      ? [
          {
            pr: branch,
            cwd: member.worktreePath,
            project: linkView?.projects.find((entry) => entry.id === member.projectId)?.name,
            projectPath: member.projectPath,
          },
        ]
      : [];
  });
  // The header menu's PR is the one the row shows first.
  const rowPrs = rowPullRequests(prPath ? chatPrs : linkPrs.map((entry) => entry.pr));
  const pr = rowPrs[0] ?? null;
  // Each Link PR is the object its member's lookup returned, so it finds its own Worktree even when two share a number.
  const placeOf = (entry: (typeof rowPrs)[number]) => linkPrs.find((place) => place.pr === entry);
  // The folder the PR is read in: the Chat's Worktree, or the Link Chat's Project it came from.
  const prCwd = pr ? (prPath ?? placeOf(pr)?.cwd) : undefined;
  // Every PR the row shows, for the PR panel's menu; the list keeps one identity while it says the same.
  const prChoicesJson = JSON.stringify(
    rowPrs.map((entry) => {
      const place = prPath ? undefined : placeOf(entry);
      const { number, title, state } = entry;
      const { tone, icon } = pullRequestPresentation(entry);
      return {
        number,
        title,
        state,
        look: { tone, icon },
        ...(place ? { cwd: place.cwd, projectPath: place.projectPath, ...(place.project ? { project: place.project } : {}) } : {}),
      };
    }),
  );
  const prChoices = useMemo(() => JSON.parse(prChoicesJson) as PrChoice[], [prChoicesJson]);
  // The open PR's detail, read every 30 s while it's open, for the Review pill's count of unresolved threads.
  const prDetail = usePrDetail(session.client, prCwd, pr?.number ?? Number.NaN, pr?.state === "OPEN");
  const prOpenThreads = pr && prDetail.pr?.state === "OPEN" && prDetail.pr.number === pr.number ? openThreads(prDetail.pr).length : 0;
  const remote = lean && (!pending || pendingCanonicalId !== null) ? Math.max(0, historyPage.total - historyPage.messages.length) : 0;
  // The design the user last chose on the design sheet, which its cards mark.
  const history = chatHistory(messages);
  const chosen = useMemo(() => chosenDesign(history.userBodies), [history.userBodies]);
  const designChoice = chosen ? `${chosen.id}:${chosen.version}` : undefined;
  // Long Chats mount their newest messages first; earlier ones load on request.
  const [shown, setShown] = useState({ key: scrollKey, count: PAGE });
  const visible = shown.key === scrollKey ? shown.count : PAGE;
  // A Chat followed at its bottom as new messages arrive lets go of the history it showed: its earlier messages unmount
  // and its window keeps its last turns, so a Chat open for hours costs what a fresh one does. Scrolling up reads them again.
  const { trim: trimHistory } = historyPage;
  const seenCount = useRef(messages.length);
  useEffect(() => {
    const grew = messages.length > seenCount.current;
    seenCount.current = messages.length;
    if (!grew || !following.current || historyRead.current || historyAnchor.current) return;
    if (visible > PAGE) setShown({ key: scrollKey, count: PAGE });
    trimHistory();
  }, [messages.length, visible, scrollKey, trimHistory]);
  // Quiet heartbeats fold into one line and their replies drop out.
  const groupedMessages = useMemo(() => groupQuietRuns(messages), [messages]);
  async function showEarlier() {
    if (historyRead.current || historyAnchor.current || messages.length + remote <= visible) return;
    const request = {};
    historyRead.current = request;
    following.current = false;
    setHistoryState({ key: scrollKey, loading: true, error: "" });
    try {
      if (messages.length <= visible) await historyPage.loadEarlier();
      if (currentScrollKey.current !== scrollKey) return;
      // A hidden heartbeat reply never lays out, so anchor on the first message after it that does.
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
  // The rail runs over what the transcript shows: hidden (pass) replies and merged-away quiet dividers are not stops.
  const shownEntries = useMemo(() => groupedMessages.filter((entry) => !entry.hidden), [groupedMessages]);
  const navigationItems = useMemo(
    () =>
      messageNavigationIndices(shownEntries.length).flatMap((index) => {
        const entry = shownEntries[index];
        if (!entry) return [];
        const { message, merged } = entry;
        const position = `${index + 1} of ${shownEntries.length}`;
        // A routine-run divider, or a Linear Run's issue card carrying its Run.
        const run = routineRunOf(message);
        return {
          index,
          label: isHandoff(message)
            ? `Go to ${handoffSides(message.context, handoffModels).restored ? "context restored" : "context handoff"} ${position}.`
            : isWorktreeLinked(message)
              ? `Go to ${worktreeLinkText(message.context)}, ${position}.`
              : isCompaction(message)
                ? `Go to ${compactionText(message.context)}, ${position}.`
                : isAccountSwitch(message)
                  ? `Go to ${accountSwitchText(message.context)}, ${position}.`
                  : isChatReload(message)
                    ? `Go to ${RELOAD_TEXT}, ${position}.`
                    : isBabysitStopped(message)
                      ? `Go to ${babysitStoppedText(message.context).replace(/\.$/, "")}, ${position}.`
                      : run
                        ? `Go to ${merged ? mergedRoutineRunText(merged) : routineRunText(run)}, ${position}.`
                        : isCheckpointRestore(message)
                          ? `Go to ${message.body}, ${position}.`
                          : `Go to ${messageSender(message)} message ${position}. ${message.body.slice(0, 88)}`,
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
        scroll.current?.scrollTo({ y: Math.max(0, y - insets.top - 72), animated: true });
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
  // The Chat a Delegation came from or went to, on the same computer, as the attention pill opens one. The Chat beside
  // opens it in its own place, so the routed Chat and the open Project stay.
  const openOtherChat = useCallback(
    (key: string) =>
      secondary
        ? openBeside({ hostId: targetHost, projectPath: projectOfKey(key), chatId: sessionIdFromKey(key) })
        : router.replace({ pathname: "/chat", params: { projectPath: projectOfKey(key), hostId: targetHost, id: String(sessionIdFromKey(key)) } }),
    [targetHost, secondary],
  );
  const { rememberChat } = session;
  const canRemember = !secondary && !!params.id && !!session.snapshot?.project.state.sessions[Number(params.id)] && targetMatches;
  useFocusEffect(
    useCallback(() => {
      if (canRemember) rememberChat(Number(params.id));
    }, [canRemember, params.id, rememberChat]),
  );
  // A saved Chat's key, as its drafts and the PR sheet name it.
  const savedChatKey = targetMatches && projectPath && params.id ? `${projectPath}#${params.id}` : undefined;
  const panels = useSidePanels({
    chatId: pending ? (pendingCanonicalId ?? pending.preview.session.id) : params.id ? Number(params.id) : undefined,
    worktreeId: targetMatches && worktreeOf ? panelWorktree(session.snapshot?.project, worktreeOf.id) : undefined,
    pullRequest: savedChatKey && pr && prCwd ? { number: pr.number, chatKey: savedChatKey, choices: prChoices, ...(prPath ? {} : { cwd: prCwd }) } : undefined,
    passive: secondary,
  });
  // The PR sheet and the iPad panel send to this Chat and fill its composer ("Send to Chat", "Ask Chat"), and a Chat row's
  // PR link opens the PR here; they reach the latest send through these.
  const prChat = useRef<{
    send: (body: string) => Promise<boolean | "busy">;
    prefill: (text: string) => void;
    open: (number?: number) => void;
    pullRequests: () => PrChoice[];
    changes: () => void;
  } | null>(null);
  useEffect(() => {
    if (!savedChatKey) return;
    const unregister = registerPrChat(savedChatKey, {
      send: (body) => prChat.current?.send(body) ?? Promise.resolve(false),
      prefill: (text) => prChat.current?.prefill(text),
      pullRequests: () => prChat.current?.pullRequests() ?? [],
      changes: () => prChat.current?.changes(),
    });
    const unsubscribe = onPullRequestRequest(savedChatKey, (number) => prChat.current?.open(number));
    return () => {
      unregister();
      unsubscribe();
    };
  }, [savedChatKey]);
  const browserShortcut = useBrowserShortcut({
    chatId: savedChatKey ?? undefined,
    openInPanel: panels.openInPanel,
  });
  // Only the routed Chat clears its Unread mark: the one beside is read when it is opened on its own.
  useReadOpenChat(
    connected,
    projectPath,
    !secondary && targetMatches && params.id ? session.snapshot?.project.state.sessions[Number(params.id)] : undefined,
    !!panels.open,
  );
  // A Chat picked in another Project opens that Project here, behind the splash mark, rather than in the navigation.
  // The Chat beside is always of the open Project, and never opens another.
  const { wanted, error: openError, retry: retryOpen } = useOpenProject(secondary ? {} : params);
  // A new Chat picked without a Worktree starts in the Project's own checkout once the Project is here.
  const loaded = targetMatches && !!session.snapshot;
  const needsWorktree = !params.id && !params.worktreeId;
  const candidates = loaded && needsWorktree ? Object.values(session.snapshot!.project.state.worktrees) : [];
  const starterId = (candidates.find((item) => item.path === projectPath) || candidates[0])?.id;
  useEffect(() => {
    if (!needsWorktree || !loaded) return;
    if (starterId === undefined) router.replace("/projects");
    else router.setParams({ worktreeId: String(starterId) });
  }, [needsWorktree, loaded, starterId]);
  // A prefill lands in the new Chat's composer once its Worktree is known, unless something is typed there already.
  const prefillKey = loaded && !params.id && params.worktreeId && params.prefill ? `${session.snapshot!.project.path}#new:${params.worktreeId}` : null;
  const { setDrafts } = composer;
  useEffect(() => {
    if (!prefillKey || !params.prefill) return;
    const text = params.prefill;
    setDrafts((current) => (current[prefillKey] ? current : { ...current, [prefillKey]: text }));
    router.setParams({ prefill: undefined });
  }, [prefillKey, params.prefill, setDrafts]);
  // The Projects a new Chat can switch to, on every shown computer: each computer's every known Project while it is new.
  const newChatProjects = useNewChatProjects(!params.id);
  const noProject = useNoProjectChoice(session.client?.url);
  // The "Start building in" line stays centred over the transcript, which the keyboard shortens: it rises half as far as
  // the composer does (the keyboard less the composer's own lift, as its KeyboardStickyView below).
  const keyboard = useReanimatedKeyboardAnimation();
  // The keyboard's height once it has settled (0 closed): read on show and hide only, never per frame.
  const restingKeyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const startLift = Math.max(insets.bottom, 12) - 8;
  const startLineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ownsKeyboard ? Math.min(0, keyboard.height.get() + startLift * keyboard.progress.get()) / 2 : 0 }],
  }));
  const sidebar = <SidebarToolbar onOpenNavigation={panels.show} />;
  // A comment or a choice from the design sheet is sent from here when the Chat comes back into view. Sent while the
  // Chat is busy, it waits and goes once it no longer is; one that fails waits for the Chat's next focus.
  // A Chat started from an issue: the choice sheet outlives this render, so it calls the latest send through this ref.
  const startIssue = useRef<(issue: LinearIssue) => void>(() => {});
  const sendDesign = useRef<() => void>(() => {});
  const sendGenui = useRef<(text: string) => Promise<boolean | "busy">>(async () => false);
  const genuiSend = useCallback((text: string) => sendGenui.current(text), []);
  const designDeferred = useRef(false);
  const designKey = session.client && session.snapshot ? `${session.client.url}|${session.snapshot.project.path}#${params.id}` : null;
  useFocusEffect(
    useCallback(() => {
      if (designKey && params.id) sendDesign.current();
    }, [designKey, params.id, session.designs.enabled]),
  );
  useEffect(() => {
    if (!busy && !picking && designDeferred.current) sendDesign.current();
  }, [busy, picking]);
  // Feedback sent from the designs docked beside this Chat (an iPad) goes at once: the Chat never left the screen.
  useEffect(() => {
    if (!designKey || !params.id) return;
    return onSendDesignMessageNow((key) => {
      if (key === designKey) sendDesign.current();
    });
  }, [designKey, params.id]);
  // Compact now, pressed on the context sheet: Claude's /compact as a divider in the chat, with no handoff and the
  // draft kept. Each new count per chat key sends once; counts already there when the screen mounts are old news.
  // The Chat's values are read from the key here, so the effect sits above the Redirect with the other hooks.
  const compactSeen = useRef<Record<string, number> | null>(null);
  const compactRequests = composer.compactRequests;
  useEffect(() => {
    // The routed Chat sends for every Chat of the open Project, the one beside it included; a Chat beside of another
    // Project sends for its own.
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
            compact: true,
          },
        ])
        .then(() => session.expectActivity())
        .catch((e: Error) => setError(e.message));
    }
    // The counters are the trigger; the rest is read as it stands when one moves.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [compactRequests]);
  // The Tasks pill grows into its panel over the transcript; the panel is drawn at the screen's root, above the composer.
  const planPanel = usePlanPanel(
    params.id ? session.snapshot?.project?.state.sessions[Number(params.id)]?.plan : undefined,
    `${session.snapshot?.project?.path}#${params.id}`,
  );
  // Polled here, not in the chip: a command serving one of these ports leaves the background line.
  const portsChat = params.id && Number(params.id) > 0 && session.snapshot ? `${session.snapshot.project.path}#${params.id}` : undefined;
  const { ports } = useChatPorts(portsChat ? session.client : null, portsChat);
  const reachable = useMemo(() => ({ host: reachableHost, loopbackOnly: loopbackOnlyPorts(ports) }), [reachableHost, ports]);
  // The Chat beside waits for its own Project in its pane; it never sends the app back to the computers.
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
  const draft = composer.drafts[chatId] || "";
  const attachments = composer.attachments[chatId] || [];
  const attachmentDisabled = busy || picking;
  const run = chat ? liveRun : undefined;
  // What the Chat waits on before its agent works (its new Worktree, the send, the agent starting), or mid-turn a Link
  // Chat's Worktree or a setup: named beside the running mark, as on desktop.
  const phase =
    pending && !run
      ? sendStatusLabel({
          creatingWorktree: pending.newWorktree && pending.preview.targetSessionId === null,
          sent: pending.accepted,
          provider: pending.provider,
        })
      : runStatusLabel(run?.steps);
  const heartbeat =
    chat && beating
      ? routines.find((routine) => routine.enabled && !routine.completedAt && routine.target.kind === "chat" && routine.target.chatId === chatId)
      : undefined;
  // The Routine this Chat belongs to: the one whose Run opened it (a Run Chat, hidden or kept), else its Heartbeat. Its
  // header button opens the Routine's page; with the Mac's switch off, nothing shows, as for the Next check.
  const ownRoutine = chat && routinesOn === true ? chatRoutine(routines, chatId, chat.routine) : undefined;
  const ownHeartbeat = ownRoutine?.target.kind === "chat";
  const openRoutine = () => ownRoutine && router.push({ pathname: "/routine", params: { id: ownRoutine.id } });
  const undoHighlight = (undo.view === "list" ? undo.tasks[0] : undo.view === "preview" ? undo.preview : null)?.messageId;
  // What the Chat is doing (chat-activity.mjs), the same as its sidebar row and desktop's composer show.
  const activity = chat ? chatActivity(chat, run) : undefined;
  const background = chat ? backgroundItems(chat, ports) : [];
  // Feedback cards read the agent's resolutions again only when a comment may have changed.
  const designsMoved = history.designActivity + designActivity(run?.steps ?? [], []);
  const contextUsage = run?.contextUsage ?? chat?.contextUsage;
  const preferences = chatPreferences(composer.preferences[chatId], composer.defaults, chat?.permissionMode, run?.permissionMode);
  const turn = turnTarget(composer.preferences[chatId], chat?.provider, composer.defaults);
  const actualProvider = turn.provider;
  const model = selectedModel(actualProvider, turn.model || (chat && !turn.picked ? lastUserModel(project.state, chat.id) : ""), session.models);
  const ultracodeOn = model.ultracode && !!preferences.ultracode;
  const worktreeId = chat?.worktree_id ?? Number(params.worktreeId);
  const worktree = project.state.worktrees[worktreeId];
  /** The Chat's PR: in the right panel on an iPad, in the PR sheet on a phone. */
  function openPr(number = pr?.number, page?: "threads", memberCwd?: string) {
    if (!number || !params.id || !worktree) return false;
    // A Link Chat's PR is read in the Project it came from.
    const cwd = project.link ? (memberCwd ?? prChoices.find((choice) => choice.number === number)?.cwd) : undefined;
    if (project.link && !cwd) return false;
    const route = { worktreeId: String(worktreeId), number: String(number), chat: chatId, ...(cwd ? { cwd } : {}) };
    // The right panel shows the routed Chat's PR; the Chat beside it opens the PR sheet.
    if (widthClass(window.width) !== "compact" && !secondary) panels.showPullRequest(prChoiceKey({ number, cwd }));
    else if (page) openPrPage(page, route);
    else openPullRequest(route);
    return true;
  }
  function openChatLink(url: string) {
    const entry = associatedPullRequest(url, rowPrs);
    if (entry && openPr(entry.number, undefined, placeOf(entry)?.cwd)) return true;
    return internalBrowser && openBrowserLink(client.url, chatId, url, panels.openInPanel);
  }
  prChat.current = {
    send: (body) => send(body, false),
    prefill: (text) => composer.setDrafts((current) => ({ ...current, [chatId]: text })),
    open: openPr,
    pullRequests: () => prChoices,
    // The right panel holds the routed Chat's Changes; the Chat beside it opens its own as a page.
    changes: secondary ? () => router.push({ pathname: "/changes", params: { worktreeId: String(worktreeId) } }) : () => panels.showChanges(),
  };
  const branches = branchList?.client === client && branchList.path === project.path ? branchList : null;
  // Until the branch list arrives a new Worktree starts from this checkout's branch, as on desktop, so a busy Mac
  // never holds the send.
  const base = !branches?.items.length
    ? worktree?.name || ""
    : baseBranch && branches.items.includes(baseBranch)
      ? baseBranch
      : worktree?.name && branches.items.includes(worktree.name)
        ? worktree.name
        : branches.items[0];
  // Each Chat without a Project gets its own new, empty folder: a Worktree of the Chats home, never its checkout.
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
          opacity: compactBlocked ? 0.4 : pressed ? 0.6 : 1,
        })}
      >
        <Icon icon={compactQueued ? Cancel01Icon : CleanIcon} tone={compactState.warning ? "orangeInk" : "ink2"} size={14} />
        <Text style={{ fontSize: 12, fontWeight: "600", color: compactState.warning ? colors.orangeInk : colors.ink2 }}>
          {compacting ? "Compacting…" : compactQueued ? "Queued" : run ? "After turn" : "Compact"}
        </Text>
      </Pressable>
    ) : null;
  const title = chat ? chatTitle(chat, messages) : pending?.preview.session.title || "New Chat";
  // A new Chat before its first message: "Start building in <Computer / Project>" in the middle of the screen picks its Project.
  const startingChat = !params.id && !pending && !messages.length;
  const projectName = chatsHomeOpen ? NO_PROJECT_LABEL : project.name || project.path.split("/").findLast(Boolean) || "Project";
  const hostIds = new Set(newChatProjects.map((item) => item.hostId));
  // One row per repository: a Project cloned on several computers is one row, and the computer chip picks the copy.
  const projectGroups = newChatProjectGroups(newChatProjects);
  const isOpenCopy = (item: NewChatProject) => item.hostId === client.url && item.path === project.path;
  const projectCopies = projectGroups.find((group) => group.copies.some(isOpenCopy))?.copies ?? [];
  const projectOrigin = projectCopies.find(isOpenCopy)?.origin;
  const onSeveralComputers = projectCopies.length > 1;
  const hostName = onSeveralComputers ? "" : (newChatProjects.find((item) => item.hostId === client.url)?.hostName ?? session.hostName);
  const computerName = projectCopies.find(isOpenCopy)?.hostName ?? session.hostName;
  // Messages waiting on this device for this Chat (or its New Chat) sit in the composer's tray (offline-tray.tsx).
  const trayTarget = {
    computerId: client.url,
    owner: project.path,
    sessionId: params.id ? Number(params.id) : null,
    computerName: computerName || "This computer",
    offline,
  };
  // The computer chip's rows: every copy of the Project, or the open one alone before the lists have found it.
  const computerCopies: NewChatProject[] = projectCopies.length
    ? projectCopies
    : [{ hostId: client.url, hostName: computerName || "This computer", offline: false, path: project.path, name: projectName }];
  // The computer a Chat without a Project runs on, named in its "Just chat on <Computer>" heading.
  const chatsComputer = noProject?.copies.find((copy) => copy.hostId === client.url)?.hostName ?? session.hostName ?? "this computer";
  // A Chat beside on another computer than the open one says which.
  const otherComputer = client.url !== openSession.client?.url;
  /** Moves the new Chat to a computer's Chats home, made there first when it doesn't exist yet. */
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
  /** "Just chat on <Computer> ▾": the computers that can hold a Chat without a Project. */
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
        // First, above every Project: a Chat with no repository, in its own empty folder.
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
      ],
      onSelect: (id) => {
        if (id === "no-project") {
          if (!chatsHomeOpen && noProject) void startWithoutProject(noProject.computerId);
          return;
        }
        const group = projectGroups[Number(id)];
        if (!group || group.copies.some(isOpenCopy)) return;
        const copy = preferredCopy(group, group.origin ? savedChatDefaults.readOriginComputer(group.origin) : null, client.url);
        void switchProject(copy.hostId, copy.path);
      },
    });
  }
  // Keep the composer, keyboard and heading mounted while the destination loads, as on desktop. Its route, Worktree
  // and draft move in the same commit as the loaded Project, so there is no intermediate splash or empty composer.
  async function switchProject(hostId: string, projectPath: string) {
    if (busy || (hostId === client.url && projectPath === project.path)) return;
    const host = hostId === client.url ? null : allComputers.hostFor(hostId);
    if (hostId !== client.url && !host) {
      setError("This computer is no longer in your list.");
      return;
    }
    setError("");
    setBusy(true);
    const onOpen = (state: Snapshot) => {
      const worktrees = Object.values(state.project.state.worktrees);
      const starter = worktrees.find((item) => item.path === state.project.path) ?? worktrees[0];
      if (!starter) throw new Error("This Project has no available Worktree.");
      const destination = `${state.project.path}#new:${starter.id}`;
      composer.setDrafts((current) => {
        const { [chatId]: carried, ...rest } = current;
        return { ...rest, [destination]: carried || current[destination] || "" };
      });
      const destinationParams = { ...params, hostId, projectPath: state.project.path, worktreeId: String(starter.id), prefill: undefined };
      setArriving(destinationParams);
      router.setParams(destinationParams);
    };
    try {
      if (host) await session.connect(host, false, { projectPath, onOpen });
      else await session.open(projectPath, { background: true, onOpen });
    } catch (e) {
      setError((e as Error).message);
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
  /** The @ menu's pick: attach the file the mention names. */
  function mentionFile(path: string) {
    const root = worktree?.path;
    if (!root) return;
    const { error: refused } = addMention(attachments, root, path);
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
  // eslint-disable-next-line react-hooks/refs -- latest-callback ref, read only from effects and the choice sheet.
  sendGenui.current = (text: string) => send(text, false);
  // eslint-disable-next-line react-hooks/refs -- latest-callback ref for design messages.
  sendDesign.current = () => {
    const message = designKey ? peekDesignMessage(designKey) : null;
    if (!message || !designKey || (message.kind !== "artifacts" && session.designs.enabled !== true)) return;
    void send(message.text, false).then((sent) => {
      designDeferred.current = sent === "busy";
      if (sent === true) designMessageSent(designKey, message);
    });
  };
  // eslint-disable-next-line react-hooks/refs -- latest-callback ref, read only when an issue is picked in the choice sheet.
  startIssue.current = (issue) => void send(issueFirstMessage(issue, draft), true, undefined, issue);
  /** Lists the open issues in the choice sheet; picking one starts the Chat from it. */
  async function chooseIssue() {
    await pickLinearIssue("Start from a Linear issue", (issue) => startIssue.current(issue));
  }
  /** Shows the open issues in the choice sheet under `title` and hands the picked one to `onPick`. */
  async function pickLinearIssue(title: string, onPick: (issue: LinearIssue) => void) {
    if (targetDisabled || !client) return;
    setError("");
    let result: LinearIssuesResult;
    try {
      result = await client.call<LinearIssuesResult>("linear:issues", [lastLinearWorkspace ? { workspace: lastLinearWorkspace } : {}]);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // Every list read from any tab, so a pick resolves to the issue on the row that was tapped.
    const seen = new Map<string, LinearIssue>();
    const keep = (list: LinearIssue[]) => {
      for (const issue of list) seen.set(issueChoiceId(issue), issue);
      return issueChoices(list);
    };
    lastLinearWorkspace = result.workspace;
    showChoiceSheet({
      title,
      placeholder: "Search issues",
      emptyLabel: "No issues found.",
      leading: <LinearLogo size={18} tone="ink" />,
      items: keep(result.issues),
      // One tab per workspace when there are several; a Mac that predates workspaces sends none.
      tabs: result.workspaces?.map((workspace) => ({ id: workspace.id, label: workspace.name })),
      tab: result.workspace,
      // The Mac keeps each list for a minute; a pull reads it from Linear again.
      load: async (workspace, fresh) => {
        const next = await client.call<LinearIssuesResult>("linear:issues", [{ fresh, ...(workspace ? { workspace } : {}) }]);
        if ("error" in next) throw new Error(next.error);
        if (next.workspace) lastLinearWorkspace = next.workspace;
        return keep(next.issues);
      },
      onSelect: (id) => {
        const issue = seen.get(id);
        if (issue) onPick(issue);
      },
    });
  }
  /** Whether the message went: "busy" when it wasn't tried, the Chat being busy. An issue key starts the Chat in its own new worktree. */
  async function send(body = draft, withAttachments = true, prAction?: PullRequestActionContext, issue?: LinearIssue): Promise<boolean | "busy"> {
    // `/undo` opens Undo changes instead of reaching the agent, even mid-turn; its preview waits for the turn to end.
    if (chat && withAttachments && body.trim() === "/undo") {
      composer.setDrafts((current) => ({ ...current, [chatId]: "" }));
      setUndoIntent("Undo");
      void undo.open();
      return false;
    }
    const issueKey = issue?.key;
    // A turn running now takes this message as a steer, on the provider it already runs.
    const steered = Boolean(run);
    if (!body && !(withAttachments && attachments.length)) return false;
    if (busy || sendingRef.current.has(sendingKey) || picking) return "busy";
    sendingRef.current.add(sendingKey);
    setSendingKeys((current) => [...current, sendingKey]);
    setError("");
    // A restored queue must be read before an online send can bypass it.
    if (!outbox.getSnapshot().loaded) await outbox.ready.catch(() => {});
    if (offline || hasQueuedChat(client.url, project.path, params.id ? Number(params.id) : null)) {
      try {
        if (!project.link && (newWorktree || issue) && !base) throw new Error("Choose a base branch before queuing this message.");
        const id = randomUUID();
        const mentioned =
          withAttachments && worktree?.path
            ? mentionAttachments(body, worktree.path, attachments, (path) => knownFiles.current.has(worktree.path, path)).added
            : [];
        const picked = withAttachments ? [...attachments, ...mentioned] : [];
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
            ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
            ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: draft })! } : {}),
          },
          ...(project.link ? { link: { linkId: project.link.link.id, operationId: id } } : {}),
          ...(!project.link && (newWorktree || issue)
            ? {
                createWorktree: {
                  projectPath: project.path,
                  baseBranch: base!,
                  prompt: body,
                  ...(issue ? { issueKey: issue.key, issueWorkspace: issue.workspace } : {}),
                },
              }
            : {}),
          attachments: outboxAttachments(picked),
        });
        if (body === draft || issue) composer.setDrafts((current) => clearSentDraft(current, chatId, body, !!issue));
        const ids = new Set(picked.map((item) => item.id));
        composer.setAttachments((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((item) => !ids.has(item.id)) }));
        Keyboard.dismiss();
        void outbox.flush().catch(() => {});
        return true;
      } catch (error) {
        setError((error as Error).message);
        return false;
      } finally {
        sendingRef.current.delete(sendingKey);
        setSendingKeys((current) => current.filter((key) => key !== sendingKey));
      }
    }
    // Mentioned files attach when the message goes (a removed tile does not unmention the file). A mention not yet checked
    // against the Project (the one just typed) is asked about now, for up to a second.
    const mentionRoot = worktree?.path;
    // Only a mention the Mac has not answered about waits (up to a second); an ordinary send still clears the composer before its first await.
    if (withAttachments && mentionRoot && knownFiles.current.unchecked(mentionRoot, mentionPaths(body), 1).length)
      await knownFiles.current.resolve(client, mentionRoot, mentionPaths(body));
    const mentions =
      withAttachments && mentionRoot ? mentionAttachments(body, mentionRoot, attachments, (path) => knownFiles.current.has(mentionRoot, path)) : { added: [] };
    const sent = body;
    const sendingProjectPath = project.path;
    // The next New Chat opens where this one started, and so does a pick of this repository's Project.
    // A Chat without a Project moves only the computer: New Chat still opens the last real Project.
    if (!params.id) {
      void savedChatDefaults.saveLastComputer(client.url);
      if (!chatsHomeOpen) void savedChatDefaults.saveLastProject(client.url, sendingProjectPath);
      if (projectOrigin) void savedChatDefaults.saveOriginComputer(projectOrigin, client.url);
    }
    const sending = withAttachments ? [...attachments, ...mentions.added] : [];
    const focus = focused.current;
    const current = () => focus !== null && focused.current === focus && session.isSelected();
    const clearsDraft = sent === draft || issueKey !== undefined;
    const creates = newWorktree || issueKey !== undefined;
    // A new Chat's send is this screen's, not every New Chat's in the Worktree (pending-chats.ts).
    const key = `${client.url}|${originChatId}`;
    const operationId = project.link ? composer.linkOperations.forSend(key, JSON.stringify([sent, sending.map((item) => item.id)]), randomUUID) : null;
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
      context: issue ? linearIssueContext(issue, draft) : (prAction ?? null),
    });
    pendingStore.setPendingChats((current) => ({
      ...current,
      [key]: {
        preview,
        hostId: client.url,
        projectPath: sendingProjectPath,
        originChatId,
        ...(params.id ? {} : { draft: draftId }),
        originSessionId: params.id ? Number(params.id) : null,
        worktreeId,
        newWorktree: creates,
        accepted: false,
        provider: actualProvider,
      },
    }));
    if (clearsDraft) composer.setDrafts((current) => clearSentDraft(current, chatId, sent, issueKey !== undefined));
    const sentIds = new Set(sending.map((item) => item.id));
    composer.setAttachments((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((item) => !sentIds.has(item.id)) }));
    following.current = true;
    Keyboard.dismiss();
    const options = sendOptions(model, preferences);
    // A busy or unreachable Mac gets the send again until it takes it; the message shows as sending meanwhile. The host
    // recognises a resend by its clientMessageId (or a Link's operationId), so only a new Worktree, which has no such
    // id, waits for a Mac that never read the request.
    const retried = <T,>(work: () => Promise<T>) => retrySend(work, { retryable: (error) => retryKind(error) !== null });
    const retriedUnsent = <T,>(work: () => Promise<T>) => retrySend(work, { retryable: (error) => retryKind(error) === "unsent" });
    let accepted = false;
    try {
      const media = await prepareAttachments(client, sendingProjectPath, sending, retried);
      let target = { sessionId: params.id ? Number(params.id) : (null as number | null), worktreeId };
      if (creates) {
        if (!base) throw new Error(branches?.error || "Choose a base branch before sending.");
        let ready = preparedTarget.current;
        if (!ready || ready.client !== client || ready.path !== sendingProjectPath || ready.base !== base || ready.issueKey !== issueKey) {
          const created = await retriedUnsent(() =>
            client.call<{ project: OpenProject; worktreeId: number }>("worktree:create", [
              {
                projectPath: sendingProjectPath,
                baseBranch: base,
                prompt: sent,
                ...(issueKey !== undefined ? { issueKey, ...(issue?.workspace ? { issueWorkspace: issue.workspace } : {}) } : {}),
              },
            ]),
          );
          const chat = sessionForWorktree(created.project.state, created.worktreeId);
          if (!chat) throw new Error("No Chat was created for the new worktree.");
          ready = { client, path: sendingProjectPath, base, issueKey, worktreeId: created.worktreeId, sessionId: chat.id };
          preparedTarget.current = ready;
        }
        target = { sessionId: ready.sessionId, worktreeId: ready.worktreeId };
      }
      pendingStore.setPendingChats((current) =>
        current[key] ? { ...current, [key]: { ...current[key], preview: { ...current[key].preview, targetSessionId: target.sessionId } } } : current,
      );
      const link = project.link;
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
                prompt: attachmentPrompt(sent, media.files),
                ...options,
                sentFrom: SENT_FROM,
              },
            ])
          : client.call<{ sessionId: number }>("chat:send", [
              {
                projectPath: sendingProjectPath,
                ...target,
                clientMessageId: preview.message.clientMessageId,
                body: sent,
                ...media,
                // A Mac that predates PR actions ignores prAction and sends this prompt as it is.
                prompt: prAction ? pullRequestActionPrompt(prAction) : attachmentPrompt(sent, media.files),
                ...options,
                sentFrom: SENT_FROM,
                ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
                // A Mac that predates issue cards ignores linearIssue and sends the body as a plain message.
                ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: draft })! } : {}),
              },
            ]),
      ).catch(async (error) => {
        if (retryKind(error) !== "unknown") throw error;
        // Read the saved receipt before another send. An absent receipt may still be in flight, so it never triggers an automatic resend.
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
      // What was typed here while the send went belongs to the Chat it made. Once a New Chat's screen is gone, the
      // composer under chatId is the next New Chat's, so it stays put; an open Chat's composer is its own.
      const here = promote || !!params.id;
      if (here && (clearsDraft || destination !== chatId))
        composer.setDrafts((current) => {
          const remaining = current[chatId] || "";
          const preserved = destination !== chatId ? current[destination] || "" : "";
          const next = { ...current, [destination]: [preserved, remaining].filter(Boolean).join("\n") };
          if (destination !== chatId) delete next[chatId];
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
      // The message went; a busy Mac that can't answer this read yet is caught up by the live connection.
      void session.refresh().catch(() => {});
      return true;
    } catch (e) {
      if (!accepted) {
        // The host may have saved the message and lost only its answer: a resend of this text carries the same id.
        failedSends.current.remember(key, preview.message.clientMessageId!, sent, resendParts);
        pendingStore.setPendingChats((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        if (clearsDraft) composer.setDrafts((current) => ({ ...current, [chatId]: [draft, current[chatId]].filter(Boolean).join("\n\n") }));
        composer.setAttachments((current) => ({
          ...current,
          [chatId]: [...sending, ...(current[chatId] || []).filter((item) => !sending.some((sent) => sent.id === item.id))],
        }));
      }
      if (current()) setError((e as Error).message);
      return accepted;
    } finally {
      sendingRef.current.delete(sendingKey);
      setSendingKeys((current) => current.filter((key) => key !== sendingKey));
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
    else if (id === "undo" && chat) {
      setUndoIntent("Undo");
      void undo.open();
    } else if (id === "pr" && pr) openPr(pr.number);
    else if (id === "agents" && chat) router.push({ pathname: "/agents", params: { id: String(chat.id) } });
    else if (id === "rename" && chat)
      Alert.prompt(
        "Rename Chat",
        undefined,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save",
            onPress: (value?: string) => {
              if (value?.trim()) void action(() => client.call("chat:patch", [project.path, chat.id, { title: value.trim() }]));
            },
          },
        ],
        "plain-text",
        title,
      );
    else if (id === "reload" && chat)
      void action(() => client.call("chat:reload", [chatId]), true).then((done) => done && showToast("Chat reloaded. Your next message starts a fresh agent."));
    else if (id === "done" && chat) void markDone(chat);
    else if (id === "reopen" && chat) void action(() => client.call("chat:patch", [project.path, chat.id, { done: false }]));
    else if (id === "archive" && chat?.archived) void action(() => client.call("chat:patch", [project.path, chat.id, { archived: false }]));
    else if (id === "archive" && chat) void archive(chat);
  }
  // Done leaves the finished Chat for a new one in the same Project (the Chat beside just closes); the toast's Undo
  // brings it back to the list.
  async function markDone(finished: NonNullable<typeof chat>) {
    const ok = await action(() => client.call("chat:patch", [project.path, finished.id, { done: true, unread: false }]));
    if (!ok) return;
    if (secondary) closeBeside();
    else router.setParams({ id: undefined, worktreeId: undefined, draft: undefined, prefill: undefined });
    showToast("Moved to Done", () => void action(() => client.call("chat:patch", [project.path, finished.id, { done: false }])));
  }
  // Archive starts immediately, preserves unsaved work, and stops a running turn.
  // The sidebar opens and the archive finishes there, on the Chat's row. Keeping the same sidebar mounted
  // preserves its scroll and avoids a second screen transition. Completion never moves the phone again.
  async function archive(target: NonNullable<typeof chat>) {
    if (busy || archiveRequest.current) return;
    archiveRequest.current = true;
    let left = false;
    const leave = () => {
      left = true;
      // The Chat beside the routed one closes; the routed one stays.
      if (secondary) closeBeside();
      // The pinned sidebar is already there to pick the next Chat; narrower, it slides over the archived one.
      else if (split.dockable) router.replace("/projects");
      else panels.show("left");
    };
    // By the time the archive ends the phone may show another Project, so the list's copy of this one is read too.
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
  const prAction = pullRequestAction(chatPrs);
  // The pill's action, checked here too: a PR without a number yet shows no pill instead of sending a broken one.
  const prActionRequest = prAction ? pullRequestActionContext({ action: prAction.blocker, pr: prAction.pr.number, url: prAction.pr.url }) : null;
  const agents = (chat?.subagents || []).filter((agent) => !agent.archived);
  const diff = worktree?.diff;
  const linearIssue: LinearIssue | undefined = worktree ? linearIssues[worktree.path] : undefined;
  function openLinearIssue(url: string) {
    // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with -- the issue comes from the host's JSON, so url may be missing and startsWith would throw
    if (/^https:\/\//.test(url)) void Linking.openURL(url).catch(() => {});
  }
  // A Chat's own Worktree (not the main checkout, not one another Chat shares) can link an issue; a stored one is shown
  // with its hint when Linear can't see it. Nothing about the link shows while Linear is off.
  const canLink =
    linearActive && !!chat && !project.link && !chatsHomeOpen && !!worktree?.path && worktree.path !== project.path && !worktreeShared(project.state, chat.id);
  const storedIssue = linearActive && !chatsHomeOpen ? worktree?.linearIssue : undefined;
  const linkHint = storedIssue && !(worktree?.name ?? "").toLowerCase().includes(storedIssue.toLowerCase()) ? LINK_PR_HINT(storedIssue) : null;
  /** Picks an issue from the list and links it to this Chat's Worktree. */
  /** A short confirmation over the transcript that goes away on its own; one with `undo` stays longer and offers Undo. */
  function showToast(text: string, undo?: () => void) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 6000 : 3000);
  }
  function linkIssue() {
    if (!worktree) return;
    void pickLinearIssue("Link a Linear issue", (issue) => void linkWorktreeIssue(issue.key, issue.workspace));
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
  const header = (
    <>
      <HeaderTitleBox actionCount={1 + Number(!!browserShortcut) + Number(!!pr)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.ink, fontSize: 16, fontWeight: "600", flexShrink: 1 }}>
            {title}
          </Text>
        </View>
        {(paired || (!project.link && !chatsHomeOpen) || (!!pr && !!chat && !chatsHomeOpen)) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" }}>
            {/* Two Chats side by side may be of two Projects, or two computers: each names its own. */}
            {paired && (
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                accessibilityLabel={otherComputer ? `${projectName} on ${hostName}` : projectName}
                style={{ color: colors.ink2, fontSize: 12, fontWeight: "500", flexShrink: 1 }}
              >
                {otherComputer ? `${projectName} · ${hostName}` : projectName}
              </Text>
            )}
            {!project.link && !chatsHomeOpen && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1, opacity: worktree ? 1 : 0 }}>
                <Icon icon={GitBranchIcon} tone="ink3" size={11} />
                <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.ink2, fontSize: 12, flexShrink: 1 }}>
                  {worktree?.name ?? ""}
                </Text>
                <Text style={{ fontSize: 12 }}>
                  <Text style={{ color: colors.add }}>{diff && (diff.added > 0 || diff.removed > 0) ? `+${diff.added}` : ""}</Text>
                  {diff && (diff.added > 0 || diff.removed > 0) ? " " : ""}
                  <Text style={{ color: colors.remove }}>{diff && (diff.added > 0 || diff.removed > 0) ? `−${diff.removed}` : ""}</Text>
                </Text>
                {pr && chat && <HeaderPullRequestChip pr={pr} onPress={() => openPr(pr.number)} />}
              </View>
            )}
            {/* A Link Chat has no branch of its own; its first PR (from one of its Projects) still shows. */}
            {project.link && pr && chat && <HeaderPullRequestChip pr={pr} onPress={() => openPr(pr.number)} />}
          </View>
        )}
      </HeaderTitleBox>
    </>
  );
  // Both header layouts use the same actions and one glass capsule.
  const paneMenu: MenuSection[] = [
    {
      items: [
        ...(chatsHomeOpen
          ? []
          : [
              { id: "changes", title: "View changes", systemImage: "doc.text.magnifyingglass", subtitle: diff ? `+${diff.added} −${diff.removed}` : undefined },
            ]),
        ...(chat ? [{ id: "undo", title: "Undo changes", systemImage: "arrow.uturn.backward", disabled: !!run }] : []),
        ...(ownRoutine ? [{ id: "routine", title: ownHeartbeat ? "Heartbeat" : "Routine", systemImage: ownHeartbeat ? "waveform.path.ecg" : "repeat" }] : []),
        ...(linearIssue ? [{ id: "linear", title: issueChipLabel(linearIssue), systemImage: "link" }] : []),
        ...(linkHint ? [{ id: "link-hint", title: linkHint, systemImage: "info.circle", disabled: true }] : []),
        ...(agents.length > 0 ? [{ id: "agents", title: "Subagents", systemImage: "person.2", subtitle: String(agents.length) }] : []),
      ],
    },
    ...(chat
      ? [
          {
            items: [
              { id: "rename", title: "Rename", systemImage: "pencil" },
              { id: "reload", title: "Reload chat", systemImage: "arrow.clockwise", disabled: busy },
              ...(canLink
                ? [
                    {
                      id: storedIssue ? "unlink-issue" : "link-issue",
                      title: storedIssue ? "Unlink issue" : "Link issue…",
                      systemImage: "link",
                      disabled: busy,
                    },
                  ]
                : []),
              {
                id: "archive",
                title: chat.archived ? "Restore" : "Delete",
                systemImage: chat.archived ? "tray.and.arrow.up" : "trash",
                destructive: !chat.archived,
                disabled: busy,
              },
            ],
          },
        ]
      : []),
  ];
  const headerActions = (
    <HeaderActionGroup>
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
      <PullDown label="Chat actions" sections={paneMenu} onSelect={headerAction}>
        <HeaderAction label="Chat actions" icon={MoreHorizontalIcon} />
      </PullDown>
    </HeaderActionGroup>
  );
  const more = (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.View hidesSharedBackground>{headerActions}</Stack.Toolbar.View>
    </Stack.Toolbar>
  );
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
  // The host's message replaces the preview as soon as the transcript grows by it.
  const answerPreview = answering && sentAnswers.count === messages.length ? sentAnswers.message : null;
  const pendingInput = pending && pendingCanonicalId === null ? pending.preview.message : null;
  const renderToolApproval = (approval: NonNullable<typeof run>["approvals"][number]) => (
    <Approval
      key={approval.requestId}
      approval={approval}
      busy={actionBusy}
      respond={(decision) =>
        void action(async () => {
          const accepted = await client.call("agent:respond-permission", [{ chatId, requestId: approval.requestId, decision }]);
          if (!accepted) throw new Error("This approval is no longer pending. Refresh the Chat.");
        }, true)
      }
    />
  );
  const liveReply = run ? (
    <ChatReply
      key="run"
      run={run}
      media={media}
      basePath={worktree?.path || project.path}
      chatId={chatId}
      designChoice={designChoice}
      designsMoved={designsMoved}
      onActivity={openActivity}
    />
  ) : null;
  const sendDisabled = busy || picking || (newWorktree && !base) || (!draft.trim() && !attachments.length) || !!chat?.archived || (!offline && unavailable);
  // On an iPad the routed Chat's Terminals dock below it instead of opening full screen.
  const terminalDocks = !secondary && split.widthClass !== "compact";
  const terminalShown = terminalDocks && terminalFor === chatId && !!chat && !chat.archived;
  if (terminalShown && terminalMounted !== chatId) setTerminalMounted(chatId);
  // The composer floats above the transcript and rides the keyboard, stopping 8pt above it; with the Terminal below, it
  // sits clear of the home indicator already.
  const dockPadding = terminalShown ? 12 : Math.max(insets.bottom, 12);
  // Only what is being typed into rides the keyboard: the Terminal lifts over the composer when it is typed into, and the
  // composer rises above a keyboard taller than the Terminal under it otherwise.
  const terminalTyping = terminalShown && !composerFocused;
  const lift = dockPadding - 8 + (terminalShown ? Math.min(terminalHeight, restingKeyboard) : 0);
  return (
    <GenerativeUIProvider send={genuiSend}>
      <ChatLinkProvider reachable={reachable} openLink={openChatLink}>
        <PanelTabsContext value={panels.openInPanel}>
          <View style={[styles.screen, dots]}>
            {/* A new Chat has no title until it has a name. With a Chat beside it, each draws its own header instead. */}
            {!paired && (
              <Stack.Screen
                options={{
                  title: startingChat ? "" : title,
                  headerTitle: () => (startingChat ? null : header),
                  headerShown: true,
                  headerBackVisible: false,
                  gestureEnabled: false,
                }}
              />
            )}
            {pane === "primary" && <Stack.Screen options={{ title, headerShown: false, headerBackVisible: false, gestureEnabled: false }} />}
            {!paired && sidebar}
            {!paired && more}
            <View style={{ flex: 1 }}>
              <PanelSwipe panels={panels} covered={planPanel.phase !== "closed"}>
                {/* The header clearance is in paddingTop; an automatic iOS inset would add it a second time. */}
                <KeyboardChatScrollView
                  key={scrollKey}
                  ref={scroll}
                  freeze={!ownsKeyboard || terminalTyping}
                  offset={lift}
                  keyboardLiftBehavior="whenAtEnd"
                  onEndVisible={onEndVisible}
                  contentInsetAdjustmentBehavior="never"
                  // Images above the screen load after the Chat is placed. The native view keeps the first visible message
                  // where it was in the same frame; a JS jump from onContentSizeChange arrives frames later and flickers.
                  maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  contentContainerStyle={[
                    styles.content,
                    column,
                    { paddingTop: insets.top + 84, paddingLeft: 28, paddingRight: 20, gap: 16, paddingBottom: dockHeight + 16 },
                  ]}
                  scrollEventThrottle={32}
                  onScrollBeginDrag={() => {
                    scrollingToBottom.current = false;
                  }}
                  onScroll={({ nativeEvent: e }) => {
                    const previous = scrollOffset.current;
                    scrollOffset.current = e.contentOffset.y;
                    const under = e.contentOffset.y > 4;
                    setUnderHeader((current) => (current === under ? current : under));
                    const distance = e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height;
                    if (!placed && distance <= 1) setPlacedKey(scrollKey);
                    // Native scroll events can arrive before the jump catches up with image layout.
                    if (scrollingToBottom.current) {
                      if (distance <= 1) scrollingToBottom.current = false;
                      return;
                    }
                    following.current = distance < 120;
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
                  {chat?.archived && (
                    <View style={styles.card}>
                      <Text style={styles.muted}>This Chat is archived. Restore it to send a message.</Text>
                      <PillButton
                        title="Restore Chat"
                        disabled={busy}
                        onPress={() => void action(() => client.call("chat:patch", [project.path, chat.id, { archived: false }]))}
                        style={{ alignSelf: "flex-start" }}
                      />
                    </View>
                  )}
                  {/* A new Chat's empty state is the centred "Start building in" line instead. */}
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
                  {groupedMessages.slice(-visible).flatMap(({ message, hidden, merged }) => [
                    ...(liveReply && message === pendingInput ? [liveReply] : []),
                    ...(hidden
                      ? []
                      : [
                          <View
                            key={message.clientMessageId ?? message.id}
                            nativeID={`chat-message-${message.id}`}
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
                                scroll.current?.scrollTo({ y: Math.max(0, layout.y - insets.top - 72), animated: true });
                              }
                            }}
                          >
                            {isHandoff(message) ? (
                              <HandoffDivider context={message.context} models={handoffModels} onOpen={openBrief} />
                            ) : isWorktreeLinked(message) ? (
                              <WorktreeLinkDivider context={message.context} client={session.client} onOpen={(title, text) => openBrief(text, title)} />
                            ) : isCompaction(message) ? (
                              <CompactionDivider context={message.context} />
                            ) : isAccountSwitch(message) ? (
                              <AccountSwitchDivider context={message.context} />
                            ) : isChatReload(message) ? (
                              <ChatReloadDivider />
                            ) : isBabysitStopped(message) ? (
                              <BabysitStoppedDivider context={message.context} />
                            ) : isRoutineRun(message) ? (
                              <RoutineRunDivider context={message.context} merged={merged} />
                            ) : isCheckpointRestore(message) ? (
                              <CheckpointRestoreDivider
                                context={message.context}
                                onPreview={
                                  run
                                    ? undefined
                                    : (recoveryId, intent) => {
                                        setUndoIntent(intent);
                                        void undo.inspect(recoveryId);
                                      }
                                }
                              />
                            ) : (
                              <>
                                {/* A Linear Run's first message is its issue card carrying the Run: the divider, then the card. */}
                                {issueRunDivider(message, merged)}
                                <ChatReply
                                  message={message}
                                  chats={mentionChats}
                                  media={media}
                                  basePath={worktree?.path || project.path}
                                  chatId={chatId}
                                  designChoice={designChoice}
                                  designsMoved={designsMoved}
                                  // A limit card offers other accounts only on the Chat's last message, with no turn running.
                                  limitProjectPath={!run && !pending && message === messages[messages.length - 1] ? project.path : undefined}
                                  onActivity={openActivity}
                                  highlighted={message.id === undoHighlight}
                                  onOpenChat={openOtherChat}
                                />
                              </>
                            )}
                          </View>,
                        ]),
                  ])}
                  {!pendingInput && liveReply}
                  {answerPreview && <ChatReply key="answers" message={answerPreview} media={media} chatId={chatId} onActivity={openActivity} />}
                  {(run || pending) && (
                    <ThinkingIndicator
                      startedAt={pending?.preview.startedAt ?? run?.startedAt}
                      label={phase ?? (run?.waitingForSubagents ? "Waiting on subagents" : `Working with ${model.name}`)}
                      showLabel={Boolean(phase)}
                    />
                  )}
                  {!run && !pending && activity?.activity === "background" && background.length > 0 && (
                    <BackgroundIndicator
                      count={background.length}
                      startedAt={background[0]?.startedAt}
                      mark={<BackgroundRing count={background.length} />}
                      onPress={() => chat && router.push({ pathname: "/background", params: { id: String(chat.id) } })}
                    />
                  )}
                  {heartbeat && !run && !pending && typeof heartbeat.nextRunAt === "number" && heartbeat.nextRunAt > now ? (
                    <Text style={{ color: colors.ink2, fontSize: 12, textAlign: "center" }}>{`Next check ${clock(heartbeat.nextRunAt)}`}</Text>
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
                {underHeader && <EdgeFade edge="top" height={insets.top + 84} width={window.width} />}
                {paneHeader}
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
                    {chatsHomeOpen ? (
                      // No Project to pick here: the heading picks the computer, and the line under it goes back to the Projects.
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
                            opacity: pressed ? 0.6 : 1,
                          })}
                        >
                          <Text style={{ fontSize: 20, fontWeight: "600", color: colors.ink }}>{JUST_CHAT_HEADING} on</Text>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
                            <Text numberOfLines={1} style={{ fontSize: 20, fontWeight: "600", color: colors.accent, flexShrink: 1 }}>
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
                          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                        >
                          <Text style={{ fontSize: 15, color: colors.ink3, textAlign: "center" }}>{NO_PROJECT_LINE}</Text>
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
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Text style={{ fontSize: 20, fontWeight: "600", color: colors.ink }}>Start building in</Text>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
                          <Text numberOfLines={1} style={{ fontSize: 20, fontWeight: "600", color: colors.accent, flexShrink: 1 }}>
                            {projectName}
                          </Text>
                          <Icon icon={ArrowDown01Icon} tone="accent" size={18} />
                        </View>
                      </Pressable>
                    )}
                  </Animated.View>
                )}
                {!secondary && <AttentionPill currentChat={chatId} visibleChat={visibleChat} bottom={dockHeight + 12} />}
                {toast ? (
                  <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, top: insets.top + 64, alignItems: "center" }}>
                    <ToastPill
                      text={toast.text}
                      onUndo={
                        toast.undo &&
                        (() => {
                          const { undo } = toast;
                          if (toastTimer.current) clearTimeout(toastTimer.current);
                          setToast(null);
                          undo?.();
                        })
                      }
                    />
                  </View>
                ) : null}
                <MessageNavigation
                  items={navigationItems}
                  onSelect={navigateToMessage}
                  top={insets.top + 72}
                  bottom={dockHeight + 12}
                  keyboardOffset={lift}
                  followKeyboard={ownsKeyboard && !terminalTyping}
                />
                <KeyboardStickyView
                  enabled={ownsKeyboard && !terminalTyping}
                  pointerEvents="box-none"
                  // The other pane's composer jumps clear of the open keyboard once, so a tap can move the keyboard to it. A
                  // disabled sticky view sits at its `closed` offset, which overrides any transform in `style`.
                  offset={{ closed: ownsKeyboard ? 0 : Math.min(0, lift - restingKeyboard), opened: lift }}
                  style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
                >
                  {/* The transcript blurs and fades under the composer like desktop's, while the Chat's end is below it. */}
                  {showJumpToBottom && <BottomFade height={dockHeight + 48} width={window.width} />}
                  <View
                    ref={planPanel.attachRoom}
                    collapsable={false}
                    onLayout={({ nativeEvent }) => setDockHeight(Math.round(nativeEvent.layout.height))}
                    style={[column, { paddingHorizontal: 12, paddingTop: 6, paddingBottom: dockPadding, gap: 8 }]}
                  >
                    <PersistenceNotice
                      key={`${client.url}|${project.path}`}
                      client={client}
                      scope={project.path}
                      name={chatsHomeOpen ? NO_PROJECT_LABEL : project.name}
                      failure={project.state.persistence}
                      offline={!!session.error}
                    />
                    {(!question || answering) && (
                      // More pills than fit scroll sideways; the spacer still right-aligns them when they fit.
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        style={{ marginHorizontal: -12, flexGrow: 0 }}
                        contentContainerStyle={{ flexGrow: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 8 }}
                      >
                        {prAction && prActionRequest && chat && !chatsHomeOpen && (
                          <PullRequestAction
                            pr={prAction.pr}
                            disabled={busy || !!run}
                            onRun={() => void send(pullRequestActionBody(prActionRequest), false, prActionRequest)}
                          />
                        )}
                        {!prAction && chat && !chatsHomeOpen && pr?.state === "OPEN" && pr.readyToMerge && (
                          <PullRequestMerge pr={pr} onOpen={() => openPr(pr.number)} />
                        )}
                        {chat && !chatsHomeOpen && pr && prOpenThreads > 0 && (
                          <PullRequestReview count={prOpenThreads} onOpen={() => openPr(pr.number, "threads")} />
                        )}
                        <View style={{ flex: 1 }} />
                        {params.id && Number(params.id) > 0 && chat && !chat.archived && (
                          <TerminalChip
                            key={`terminal-${chatId}`}
                            chatId={chatId}
                            places={terminalPlaces(chat)}
                            onOpen={terminalDocks ? () => setTerminalFor((current) => (current === chatId ? null : chatId)) : undefined}
                            docked={terminalDocks ? terminalShown : undefined}
                            liveCount={terminalCount}
                          />
                        )}
                        {params.id && Number(params.id) > 0 && <PortsChip key={`ports-${chatId}`} chatId={chatId} ports={ports} />}
                        <PlanPill panel={planPanel} />
                        {params.id && Number(params.id) > 0 && <SimulatorChip key={chatId} chatId={chatId} />}
                        {agents.length > 0 && <SubagentChip agents={agents} onPress={() => headerAction("agents")} />}
                      </ScrollView>
                    )}
                    {chat?.queued?.length ? (
                      <QueuedMessages
                        items={chat.queued.filter((item) => !compactionContext(item) || chat.queueHeld)}
                        held={Boolean(chat.queueHeld)}
                        running={Boolean(run)}
                        disabled={actionBusy}
                        onSendNow={(id) => void action(() => client.call("chat:queue-send", [chatId, id]), true)}
                        onRemove={(id) => void action(() => client.call("chat:queue-remove", [chatId, id]), true)}
                      />
                    ) : null}
                    {run?.approvals.map(renderToolApproval)}
                    {question && (
                      // Hidden, not unmounted, while the answers travel: if they don't arrive, the card comes back as it was.
                      <View style={answering ? { display: "none" } : undefined}>
                        <ActivityQuestions
                          hostId={client.url}
                          projectPath={project.path}
                          sessionId={Number(params.id)}
                          key={question.requestId}
                          request={question}
                          busy={actionBusy || answering}
                          submit={(answers, summary) => {
                            const answered = answeredQuestions(question, answers);
                            setSentAnswers({
                              requestId: question.requestId,
                              message: answered && { id: -1, session_id: Number(params.id), body: summary, context: null, role: "user", answered },
                              count: messages.length,
                            });
                            void action(async () => {
                              const accepted = await client.call("agent:answer-question", [{ chatId, requestId: question.requestId, answers, summary }]);
                              if (!accepted) throw new Error("This question is no longer pending. Refresh the Chat.");
                            }, true).then((ok) => {
                              if (!ok) setSentAnswers((current) => (current?.requestId === question.requestId ? null : current));
                            });
                          }}
                        />
                      </View>
                    )}
                    {undo.view !== "closed" && chat ? (
                      <UndoPanel
                        review={undo}
                        intent={undoIntent}
                        onOpenFile={
                          project.link || !worktree
                            ? undefined
                            : (file) => router.push({ pathname: "/diff", params: { worktreeId: String(worktreeId), path: file.path, mode: "uncommitted" } })
                        }
                      />
                    ) : (
                      (!question || answering) && (
                        // A new Chat's tray holds where it runs (computer, isolation, branch) and the composer as one piece, as on desktop.
                        <ComposerTray start={startTray} target={trayTarget}>
                          {startTray && chatsHomeOpen ? (
                            // A Chat without a Project has no isolation, branch or issue to pick: the tray only says what it is.
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
                              <Icon icon={BubbleChatIcon} tone="ink2" size={14} />
                              <Text style={styles.label}>{CHATS_TRAY_LABEL}</Text>
                            </View>
                          ) : (
                            startTray && (
                              // One row, never wrapped: the computer and branch names truncate, and the Linear chip drops its label when the row is narrow.
                              <View
                                style={{ flexDirection: "row", alignItems: "center" }}
                                onLayout={(event) => setTrayRowWidth(event.nativeEvent.layout.width)}
                              >
                                {/* Every Project has the chip, on one computer or several: the heading never names the computer. */}
                                {
                                  <PullDown
                                    label="Choose computer"
                                    style={{ flexShrink: 1 }}
                                    nativeTrigger={{
                                      title: computerName,
                                      systemImage: "desktopcomputer",
                                      icon: "computer",
                                      disabled: targetDisabled,
                                      maxWidth: 140,
                                    }}
                                    sections={[
                                      {
                                        title: "Run on",
                                        items: computerCopies.map((item) => ({
                                          id: `${item.hostId}\n${item.path}`,
                                          title: item.hostName,
                                          subtitle: item.offline ? "Offline" : item.path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~"),
                                          systemImage: "desktopcomputer",
                                          icon: "computer",
                                          checked: isOpenCopy(item),
                                          disabled: targetDisabled || item.offline,
                                        })),
                                      },
                                    ]}
                                    onSelect={(id) => {
                                      const [hostId = "", ...rest] = id.split("\n");
                                      if (targetDisabled) return;
                                      if (projectOrigin) void savedChatDefaults.saveOriginComputer(projectOrigin, hostId);
                                      void switchProject(hostId, rest.join("\n"));
                                    }}
                                  >
                                    <View
                                      style={{
                                        maxWidth: 140,
                                        flexShrink: 1,
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: 6,
                                        paddingHorizontal: 10,
                                        paddingVertical: 6,
                                        opacity: targetDisabled ? 0.35 : 1,
                                      }}
                                    >
                                      <Icon icon={ComputerIcon} tone="ink2" size={14} />
                                      <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
                                        {computerName}
                                      </Text>
                                      <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
                                    </View>
                                  </PullDown>
                                }
                                <PullDown
                                  label="Choose isolation"
                                  nativeTrigger={{
                                    title: isolation === "local" ? "Local" : "New worktree",
                                    systemImage: isolation === "local" ? "laptopcomputer" : "arrow.triangle.branch",
                                    icon: isolation === "local" ? "laptop" : "fork",
                                    disabled: targetDisabled,
                                  }}
                                  sections={[
                                    {
                                      title: "Isolation",
                                      items: [
                                        {
                                          id: "local",
                                          title: "Local",
                                          systemImage: "laptopcomputer",
                                          icon: "laptop",
                                          checked: isolation === "local",
                                          disabled: targetDisabled,
                                        },
                                        {
                                          id: "worktree",
                                          title: "New worktree",
                                          systemImage: "arrow.triangle.branch",
                                          icon: "fork",
                                          checked: isolation === "worktree",
                                          disabled: targetDisabled,
                                        },
                                      ],
                                    },
                                  ]}
                                  onSelect={(id) => {
                                    if (!targetDisabled) chooseTarget({ isolation: id === "worktree" ? "worktree" : "local" });
                                  }}
                                >
                                  <View
                                    style={{
                                      flexShrink: 1,
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 6,
                                      paddingHorizontal: 10,
                                      paddingVertical: 6,
                                      opacity: targetDisabled ? 0.35 : 1,
                                    }}
                                  >
                                    <Icon icon={isolation === "local" ? LaptopIcon : GitForkIcon} tone="ink2" size={14} />
                                    <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
                                      {isolation === "local" ? "Local" : "New worktree"}
                                    </Text>
                                    <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
                                  </View>
                                </PullDown>
                                <PullDown
                                  label="Choose branch"
                                  style={{ flexShrink: 1 }}
                                  searchable={{
                                    placeholder: newWorktree ? "Search branches" : "Search worktrees",
                                    emptyLabel: newWorktree ? "No branches found." : "No worktrees found.",
                                  }}
                                  nativeTrigger={{ title: branchName, systemImage: "arrow.triangle.branch", disabled: branchDisabled, maxWidth: 180 }}
                                  sections={[
                                    {
                                      title: newWorktree ? "Branch from" : "Choose a worktree",
                                      items: newWorktree
                                        ? (branches?.items || []).map((item) => ({
                                            id: item,
                                            title: item,
                                            checked: item === base,
                                            systemImage: "arrow.triangle.branch",
                                            disabled: branchDisabled,
                                          }))
                                        : Object.values(project.state.worktrees).map((item) => ({
                                            id: String(item.id),
                                            title: item.name,
                                            subtitle: item.path?.split("/").findLast(Boolean),
                                            checked: item.id === worktreeId,
                                            systemImage: "arrow.triangle.branch",
                                            disabled: targetDisabled,
                                          })),
                                    },
                                  ]}
                                  onSelect={(id) => {
                                    if (!branchDisabled) {
                                      if (newWorktree) chooseTarget({ baseBranch: id });
                                      else navigation.setParams({ worktreeId: id });
                                    }
                                  }}
                                >
                                  <View
                                    style={{
                                      maxWidth: 180,
                                      flexShrink: 1,
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 6,
                                      paddingHorizontal: 10,
                                      paddingVertical: 6,
                                      opacity: branchDisabled ? 0.35 : 1,
                                    }}
                                  >
                                    <Icon icon={GitBranchIcon} tone="ink2" size={14} />
                                    <Text numberOfLines={1} style={[styles.label, { flexShrink: 1 }]}>
                                      {branchName}
                                    </Text>
                                    <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
                                  </View>
                                </PullDown>
                                {linearActive && (
                                  <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="Start from a Linear issue"
                                    disabled={targetDisabled}
                                    onPress={() => void chooseIssue()}
                                    style={({ pressed }) => ({
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 6,
                                      paddingHorizontal: 10,
                                      paddingVertical: 6,
                                      opacity: targetDisabled ? 0.35 : pressed ? 0.6 : 1,
                                    })}
                                  >
                                    <LinearLogo size={13} />
                                    {trayRowWidth >= COMPACT_TRAY_ROW_WIDTH && <Text style={styles.label}>Linear issue</Text>}
                                  </Pressable>
                                )}
                              </View>
                            )
                          )}
                          <OfflineTray target={trayTarget} chip={!startTray} />
                          <View
                            style={{
                              backgroundColor: colors.surface,
                              borderWidth: 1,
                              borderColor: colors.lineStrong,
                              borderRadius: startTray || offline ? 23 : 24,
                              borderCurve: "continuous",
                              // Not clipped: a dictation message floats over the mic, past the card's top edge.
                              paddingTop: 8,
                              paddingHorizontal: 8,
                              paddingBottom: 6,
                              gap: 4,
                              boxShadow: ultracodeOn ? `0 4px 22px ${colors.purple}47` : startTray ? undefined : "0 4px 20px #0000000f",
                            }}
                          >
                            {/* With Ultracode on, the composer takes its purple: a breathing tint and border, and a glow. */}
                            {ultracodeOn && <UltracodeGlow radius={startTray ? 23 : 24} />}
                            {!!attachments.length && (
                              <PageScroll horizontal contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 8 }}>
                                {attachments.map((item) => {
                                  const imageIndex = item.image ? attachments.filter((attachment) => attachment.image).indexOf(item) + 1 : 0;
                                  return (
                                    <View
                                      key={item.id}
                                      style={{
                                        backgroundColor: colors.field,
                                        borderRadius: 12,
                                        borderCurve: "continuous",
                                        paddingLeft: item.image ? 4 : 10,
                                        flexDirection: "row",
                                        alignItems: "center",
                                        maxWidth: 220,
                                      }}
                                    >
                                      {item.image ? (
                                        <Image source={{ uri: item.uri }} accessibilityLabel={item.name} style={{ width: 44, height: 44, borderRadius: 8 }} />
                                      ) : (
                                        <Pressable
                                          accessibilityRole="button"
                                          accessibilityLabel={`Preview ${item.name}`}
                                          onPress={() =>
                                            router.push({
                                              pathname: "/file-preview",
                                              params: item.path ? { path: item.path } : { uri: item.uri, name: item.name },
                                            })
                                          }
                                          style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}
                                        >
                                          <Icon icon={File01Icon} tone="ink2" size={18} />
                                          <Text numberOfLines={1} style={[styles.label, { flexShrink: 1, paddingLeft: 6 }]}>
                                            {item.name}
                                          </Text>
                                        </Pressable>
                                      )}
                                      {item.image && (
                                        <Text numberOfLines={1} style={[styles.label, { flexShrink: 1, paddingLeft: 6 }]}>
                                          {`#${imageIndex} ${item.name}`}
                                        </Text>
                                      )}
                                      <IconButton
                                        label={`Remove ${item.name}`}
                                        icon={Cancel01Icon}
                                        size={32}
                                        disabled={busy || picking}
                                        onPress={() => {
                                          // Removing this tile may leave room again, which ends the limit error.
                                          composer.setAttachments((currentAttachments) => ({
                                            ...currentAttachments,
                                            [chatId]: (currentAttachments[chatId] || []).filter((attachment) => attachment.id !== item.id),
                                          }));
                                          if (imageIndex > 0) {
                                            composer.setDrafts((current) => ({
                                              ...current,
                                              [chatId]: shiftImageMentions(current[chatId] || "", imageIndex),
                                            }));
                                          }
                                        }}
                                      />
                                    </View>
                                  );
                                })}
                              </PageScroll>
                            )}
                            <PromptField
                              // A draft keeps its native text input when its computer or Project changes, preserving
                              // keyboard focus and the caret. Saved Chats still get an input of their own.
                              key={params.id ? chatId : "new"}
                              chats={mentionChats}
                              currentId={chat?.id}
                              client={client}
                              projectPath={worktree?.path || (project.link ? "" : project.path)}
                              draft={draft}
                              suggestion={
                                !run &&
                                !busy &&
                                !picking &&
                                !attachments.length &&
                                activity?.activity === "idle" &&
                                chat?.provider === "claude" &&
                                actualProvider === "claude"
                                  ? chat.suggestion?.text
                                  : undefined
                              }
                              onAcceptSuggestion={(text) => composer.setDrafts((current) => (current[chatId] ? current : { ...current, [chatId]: text }))}
                              chatTitle={title}
                              provider={chat?.provider ?? actualProvider}
                              images={attachments.filter((item) => item.image).length}
                              onImagePaste={(image) => void pasteImage(image)}
                              known={knownFiles.current}
                              onMention={worktree?.path ? mentionFile : undefined}
                              commands={chat ? UNDO_COMMANDS : undefined}
                              // A provider that can't steer mid-turn takes the message at the start of the next turn (desktop says the same).
                              placeholder={
                                offline
                                  ? `Queue a message for ${computerName || "this computer"}`
                                  : run && !providerCapabilities(chat?.provider ?? actualProvider).steer
                                    ? "Queue a message for the next turn"
                                    : chatsHomeOpen && !params.id
                                      ? CHATS_PLACEHOLDER
                                      : undefined
                              }
                              // Return on an iPad's keyboard sends, as Enter does on desktop; nothing happens while Send is unavailable.
                              onSubmit={() => {
                                if (!sendDisabled) void send();
                              }}
                              onFocus={() => {
                                setComposerFocused(true);
                                onTyping();
                              }}
                              onBlur={() => setComposerFocused(false)}
                              onChangeText={(value) => {
                                // Clearing the composer also clears the limit error that its mentions caused.
                                composer.setDrafts((current) => ({ ...current, [chatId]: value }));
                              }}
                            />
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                              <PullDown
                                label="Add photos or files"
                                nativeTrigger={{ systemImage: "plus", disabled: attachmentDisabled }}
                                sections={[
                                  {
                                    items: [
                                      { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled: attachmentDisabled },
                                      { id: "camera", title: "Take Photo", systemImage: "camera", disabled: attachmentDisabled },
                                      { id: "files", title: "Choose Files", systemImage: "folder", disabled: attachmentDisabled },
                                      { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled: attachmentDisabled },
                                    ],
                                  },
                                ]}
                                onSelect={(kind) => void pick(kind as "photos" | "camera" | "files" | "paste")}
                              >
                                <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: attachmentDisabled ? 0.35 : 1 }}>
                                  <Icon icon={Add01Icon} tone="ink2" size={21} />
                                </View>
                              </PullDown>
                              <AgentControls
                                compact={Boolean(compactButton)}
                                model={model}
                                effort={preferences.effort}
                                fastMode={preferences.fastMode}
                                ultracode={preferences.ultracode}
                                onToggle={() => {
                                  router.push({
                                    pathname: "/model-sheet",
                                    params: {
                                      chatId,
                                      model: model.id,
                                      provider: actualProvider,
                                      ...(chat?.provider ? { on: chat.provider } : {}),
                                      ...(run ? { busy: "1" } : {}),
                                    },
                                  });
                                }}
                              />
                              <PermissionChip
                                mode={preferences.permissionMode}
                                onPress={() => router.push({ pathname: "/permission-sheet", params: { chatId, ...(run ? { busy: "1" } : {}) } })}
                              />
                              <View style={{ flex: 1 }} />
                              {!quietContext && compactionFeedback ? (
                                <Text
                                  accessibilityRole="text"
                                  accessibilityLiveRegion="polite"
                                  style={{ fontSize: 12, color: colors.greenInk, paddingHorizontal: 8 }}
                                >
                                  ✓ {compactionFeedback.percent}% · {compactionFeedback.freed} freed
                                </Text>
                              ) : (
                                !quietContext &&
                                (compactButton || (showContextSize && contextUsage && contextUsage.size > 0)) && (
                                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                                    {/* The tint is the send button's 34pt height; the buttons keep their 44pt touch targets. */}
                                    {compactState.warning && (
                                      <View
                                        pointerEvents="none"
                                        style={{
                                          position: "absolute",
                                          left: 0,
                                          right: 0,
                                          top: "50%",
                                          height: 34,
                                          marginTop: -17,
                                          borderRadius: 999,
                                          backgroundColor: colors.orangeTint,
                                        }}
                                      />
                                    )}
                                    {compactButton}
                                    {contextUsage && contextUsage.size > 0 && params.id && (
                                      <ContextRing
                                        {...contextUsage}
                                        canCompact={supportsCompact}
                                        threshold={contextSettings.buttonThreshold}
                                        showSize={showContextSize}
                                        onPress={() => router.push({ pathname: "/context-sheet", params: { id: params.id } })}
                                      />
                                    )}
                                  </View>
                                )
                              )}
                              {run && !offline && !draft.trim() && !attachments.length && (
                                <IconButton
                                  label="Stop"
                                  icon={StopIcon}
                                  filled
                                  size={34}
                                  disabled={actionBusy}
                                  onPress={() => void action(() => client.call("agent:interrupt", [chatId]), true)}
                                />
                              )}
                              {(offline || !run || !!draft.trim() || !!attachments.length) && (
                                <IconButton
                                  label={
                                    busy
                                      ? "Sending..."
                                      : offline
                                        ? "Queue message"
                                        : run
                                          ? providerCapabilities(chat?.provider ?? actualProvider).steer
                                            ? "Send follow-up"
                                            : "Queue message"
                                          : "Send message"
                                  }
                                  icon={ArrowUp01Icon}
                                  filled
                                  size={34}
                                  loading={busy}
                                  disabled={sendDisabled}
                                  onPress={() => void send()}
                                />
                              )}
                            </View>
                          </View>
                        </ComposerTray>
                      )
                    )}
                  </View>
                  {/* Drawn last and floated above the dock, so showing it changes no other view's layout or order: either
            replays the pills' layout transition. */}
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
          </View>
        </PanelTabsContext>
      </ChatLinkProvider>
    </GenerativeUIProvider>
  );
}
