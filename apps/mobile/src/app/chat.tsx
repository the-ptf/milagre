import { GenerativeUIProvider } from "../genui/GenerativeUI";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Reanimated from "react-native-reanimated";
import { Alert, Image, Keyboard, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";
import { UltracodeGlow } from "../ultracode-glow";
import { Redirect, Stack, router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import type { NavigationProp } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  File01Icon,
  GitBranchIcon,
  GitForkIcon,
  LaptopIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { sessionForWorktree } from "@milagre/shared/model";
import type { ChatMessage, LinkIssueResult, PullRequestActionContext } from "@milagre/shared/model";
import { chatTitle, createPendingChat, pendingChatSessionId } from "@milagre/shared/chats";
import { messageSender } from "@milagre/shared/advisor-result";
import { messageNavigationIndices } from "@milagre/shared/message-navigation";
import { LINK_PR_HINT, issueChipLabel, issueFirstMessage, type LinearIssue, type LinearIssuesResult } from "@milagre/shared/linear";
import { worktreeShared } from "@milagre/shared/archive";
import type { Client, OpenProject } from "../client";
import { answeredQuestions, lastUserModel, projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { pullRequestBlockers } from "@milagre/shared/pr-blockers";
import { pullRequestActionBody, pullRequestActionContext, pullRequestActionPrompt } from "@milagre/shared/pr-action";
import { linearIssueContext, linearIssueRequest } from "@milagre/shared/linear-issue";
import { useComposer, usePendingChats, useSession } from "../session";
import { pickAttachments, preparePastedImage, discardPastedImage, type PastedImage } from "../attachment-picker";
import { appendAttachments, attachmentPrompt, prepareAttachments } from "../attachments";
import { PullRequestAction, SubagentChip, usePullRequest } from "../status-indicators";
import { SimulatorChip } from "../simulator";
import { BrowserChip } from "../browser";
import { PortsChip } from "../ports";
import { TerminalChip, terminalPlaces } from "../terminal";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { ChatReply } from "../chat-reply";
import { designMessageSent, peekDesignMessage } from "../design-outbox";
import { chosenDesign, designActivity } from "@milagre/shared/artifact";
import { handoffSides } from "../handoff-sides";
import { HandoffDivider } from "../handoff-divider";
import { showBrief } from "../handoff-brief-store";
import { WorktreeLinkDivider } from "../worktree-link-divider";
import { CompactionDivider } from "../compaction-divider";
import { isHandoff } from "@milagre/shared/handoff";
import { COMPACT_COMMAND, compactionText, isCompaction } from "@milagre/shared/compaction";
import { isWorktreeLinked, worktreeLinkText } from "@milagre/shared/worktree-link";
import { ThinkingIndicator } from "../running-logo";
import { BottomFade, EdgeFade } from "../bottom-fade";
import { useDotBackground } from "../dot-background";
import { Approval, ActivityQuestions } from "../questions";
import { AgentControls, PermissionChip } from "../agent-controls";
import { afterSend, modelsFor, selectedModel, sendOptions, turnTarget } from "../turn-options";
// Linear's mark as a template image, so iOS tints it like the SF Symbols beside it in menus.
import LINEAR_MARK from "../../assets/linear-mark.png";
import { Icon, LinearLogo } from "../icons";
import { PanelSwipe, useSidePanels } from "../side-panels";
import { LoadingLogo } from "../loading-logo";
import { useOpenProject } from "../use-open-project";
import { ErrorNotice, GlassIconButton, IconButton, PageScroll, PillButton, PullDown, useStyles } from "../ui";
import { PromptField } from "../prompt-field";
import { ContextRing } from "../context-ring";
import { useTheme } from "../theme";
import { archiveFromPhone, showArchiveNotice } from "../archive";
import { confirmSheet } from "../confirm-store";
import { randomUUID } from "expo-crypto";
import { runChatAction } from "../chat-actions";
import { useChatPage } from "../chat-pages";
import { MessageNavigation } from "../message-navigation";
import { AttentionPill } from "../attention";
import { useLinear } from "../use-linear";
import { useWorktreeLinearIssues } from "../use-worktree-linear-issues";
import { savedChatDefaults } from "../hosts-native";
import { showChoiceSheet } from "../choice-store";

const PAGE = 40;

/** A row's id: two workspaces can both have an ENG-1. A Mac that predates workspaces sends the key alone. */
const issueChoiceId = (issue: LinearIssue) => (issue.workspace ? `${issue.workspace}:${issue.key}` : issue.key);
/** The choice sheet's rows for a list of Linear issues. */
function issueChoices(issues: LinearIssue[]) {
  return issues.map((issue) => ({ id: issueChoiceId(issue), title: `${issue.key} ${issue.title}`, subtitle: issue.state.name }));
}
/** The workspace the issue sheet showed last, so it opens there again. */
let lastLinearWorkspace: string | undefined;

export default function ChatScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const navigation = useNavigation<NavigationProp<{ chat: { worktreeId?: string } }, "chat">>();
  const params = useLocalSearchParams<{ id?: string; worktreeId?: string; projectPath?: string; hostId?: string }>();
  const session = useSession();
  const composer = useComposer();
  const pendingStore = usePendingChats();
  const insets = useSafeAreaInsets();
  const [actionBusy, setBusy] = useState(false);
  // Answers just sent: the card leaves and the answers show at once, until the host's copy arrives.
  const [sentAnswers, setSentAnswers] = useState<{ requestId: string; message: ChatMessage | null; count: number } | null>(null);
  const sendingRef = useRef(false);
  const [picking, setPicking] = useState(false);
  const [dockHeight, setDockHeight] = useState(140);
  const [error, setError] = useState("");
  // Bumped after a link or unlink so the Linear issues of the Worktrees are read again.
  const [linkVersion, setLinkVersion] = useState(0);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const targetHost = params.hostId || session.client?.url || "";
  const targetProject = params.projectPath || session.snapshot?.project.path || "";
  const targetScope = JSON.stringify([targetHost, targetProject]);
  const [targetChoice, setTargetChoice] = useState(() => ({ scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) }));
  const target = targetChoice.scope === targetScope ? targetChoice : { scope: targetScope, ...savedChatDefaults.readTarget(targetHost, targetProject) };
  if (targetChoice.scope !== targetScope) setTargetChoice(target);
  const { isolation, baseBranch = "" } = target;
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
  const historyAnchor = useRef<{ id: number; y: number; key: string } | null>(null);
  const scrollScope = `${params.hostId || session.client?.url}|${params.projectPath || session.snapshot?.project.path}`;
  const routeKey = `${scrollScope}|${params.id ?? `new:${params.worktreeId}`}`;
  const [scrollIdentity, setScrollIdentity] = useState({ route: routeKey, key: routeKey, revision: 0 });
  const scrollKey = scrollIdentity.route === routeKey ? scrollIdentity.key : `${routeKey}|${scrollIdentity.revision + 1}`;
  if (scrollIdentity.route !== routeKey) setScrollIdentity({ route: routeKey, key: scrollKey, revision: scrollIdentity.revision + 1 });
  // Saving a draft changes its address, not its transcript or native keyboard/scroll state.
  const adoptChat = useCallback(
    (id: number) => {
      setScrollIdentity((current) => ({ ...current, route: `${scrollScope}|${id}`, key: scrollKey }));
      router.setParams({ id: String(id) });
    },
    [scrollScope, scrollKey],
  );
  const currentScrollKey = useRef(scrollKey);
  const [historyState, setHistoryState] = useState({ key: scrollKey, loading: false, error: "" });
  const [jumpState, setJumpState] = useState({ key: scrollKey, visible: false });
  const showJumpToBottom = jumpState.key === scrollKey && jumpState.visible;
  const onEndVisible = useCallback(
    (visible: boolean) => {
      setJumpState((current) => (current.key === scrollKey && current.visible === !visible ? current : { key: scrollKey, visible: !visible }));
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
  }, [scrollKey]);
  // Short transcripts never auto-scroll: a scroll to the end while the keyboard is up would stay offset after it hides.
  const viewport = useRef(0);
  // A Chat opens already at its newest message: the transcript stays hidden until the first jump to the end.
  const [placedKey, setPlacedKey] = useState<string | null>(null);
  const placed = placedKey === scrollKey;
  const place = () => {
    if (placed || !viewport.current || !contentHeight.current) return;
    if (contentHeight.current > viewport.current) scrollToBottom(false);
    setPlacedKey(scrollKey);
  };
  const worktreeOf =
    session.snapshot?.project.state.worktrees[
      (params.id ? session.snapshot.project.state.sessions[Number(params.id)]?.worktree_id : Number(params.worktreeId)) ?? -1
    ];
  const pr = usePullRequest(session.snapshot?.project.link ? undefined : worktreeOf);
  // Stable props keep each memoized ChatReply from re-rendering on every keystroke and poll tick.
  const connected = session.client;
  const projectPath = session.snapshot?.project.path;
  // Linear is read only while the Mac has it on and connected; a linked Chat has no Worktrees of its own.
  const { active: linearActive } = useLinear(connected);
  const linearIssues = useWorktreeLinearIssues(connected, linearActive && projectPath && !session.snapshot?.project.link ? [projectPath] : [], linkVersion);
  const targetMatches = (!params.projectPath || params.projectPath === projectPath) && (!params.hostId || params.hostId === connected?.url);
  const originChatId = `${projectPath}#${params.id ?? `new:${params.worktreeId}`}`;
  const pending = targetMatches
    ? Object.values(pendingStore.pendingChats).find(
        (item) =>
          item.hostId === connected?.url &&
          item.projectPath === projectPath &&
          (item.originChatId === originChatId || (!!params.id && item.preview.targetSessionId === Number(params.id))),
      )
    : undefined;
  const pendingCanonicalId = pending && session.snapshot ? pendingChatSessionId(session.snapshot.project.state, pending.preview) : null;
  const archiveRequest = useRef(false);
  const busy = actionBusy || !!pending;
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
      void connected
        .call<string[]>("project:branches", [projectPath])
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
  // A host that keeps messages by Chat sends the snapshot without them: the Chat on screen reads its own as pages.
  const lean = !!session.snapshot?.project.state.messagesInChats;
  const page = useChatPage(lean ? connected : null, projectPath, params.id ? Number(params.id) : null, session.snapshot);
  const canonicalPage = useChatPage(lean && pendingCanonicalId !== null ? connected : null, projectPath, pendingCanonicalId, session.snapshot);
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
          : [...savedMessages, pending.preview.message]
        : savedMessages,
    [pending, pendingCanonicalId, lean, canonicalPage.messages, allMessages, savedMessages],
  );
  // Messages the host still holds before the ones here.
  const historyPage = pendingCanonicalId !== null ? canonicalPage : page;
  // A summary can acknowledge a send before its message page arrives. Keep what is already on screen during that read.
  const [transcript, setTranscript] = useState({ key: scrollKey, messages: loadedMessages });
  const messages = lean && historyPage.loading && !loadedMessages.length && transcript.key === scrollKey ? transcript.messages : loadedMessages;
  if (transcript.key !== scrollKey || transcript.messages !== messages) setTranscript({ key: scrollKey, messages });
  const remote = lean && (!pending || pendingCanonicalId !== null) ? Math.max(0, historyPage.total - historyPage.messages.length) : 0;
  // The design the user last chose on the design sheet, which its cards mark.
  const chosen = useMemo(() => chosenDesign(messages.filter((message) => message.role === "user").map((message) => message.body)), [messages]);
  const designChoice = chosen ? `${chosen.id}:${chosen.version}` : undefined;
  // Long Chats mount their newest messages first; earlier ones load on request.
  const [shown, setShown] = useState({ key: scrollKey, count: PAGE });
  const visible = shown.key === scrollKey ? shown.count : PAGE;
  async function showEarlier() {
    if (historyRead.current || historyAnchor.current || messages.length + remote <= visible) return;
    const request = {};
    historyRead.current = request;
    following.current = false;
    setHistoryState({ key: scrollKey, loading: true, error: "" });
    try {
      if (messages.length <= visible) await historyPage.loadEarlier();
      if (currentScrollKey.current !== scrollKey) return;
      const first = messages[Math.max(0, messages.length - visible)];
      const y = first && messagePositions.current.get(first.id);
      historyAnchor.current = first && y !== undefined ? { id: first.id, y, key: scrollKey } : null;
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
  const navigationItems = useMemo(
    () =>
      messageNavigationIndices(messages.length).map((index) => ({
        index,
        label: isHandoff(messages[index])
          ? `Go to ${handoffSides(messages[index].context, handoffModels).restored ? "context restored" : "context handoff"} ${index + 1} of ${messages.length}.`
          : isWorktreeLinked(messages[index])
            ? `Go to ${worktreeLinkText(messages[index].context)}, ${index + 1} of ${messages.length}.`
            : isCompaction(messages[index])
              ? `Go to ${compactionText(messages[index].context)}, ${index + 1} of ${messages.length}.`
              : `Go to ${messageSender(messages[index])} message ${index + 1} of ${messages.length}. ${messages[index].body.slice(0, 88)}`,
      })),
    [messages, handoffModels],
  );
  const messagePositions = useRef(new Map<number, number>());
  const navigationTarget = useRef<number | null>(null);
  useEffect(() => {
    messagePositions.current.clear();
    navigationTarget.current = null;
  }, [params.id]);
  const navigateToMessage = (index: number) => {
    if (index === messages.length - 1) {
      navigationTarget.current = null;
      following.current = true;
      scrollToBottom(true);
      return;
    }
    following.current = false;
    scrollingToBottom.current = false;
    const id = messages[index].id;
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
  const openActivity = useCallback((message: string) => router.push({ pathname: "/activity", params: { id: String(params.id), message } }), [params.id]);
  const { rememberChat } = session;
  const canRemember = !!params.id && !!session.snapshot?.project.state.sessions[Number(params.id)] && targetMatches;
  useFocusEffect(
    useCallback(() => {
      if (canRemember) rememberChat(Number(params.id));
    }, [canRemember, params.id, rememberChat]),
  );
  const panels = useSidePanels({
    chatId: pending ? (pendingCanonicalId ?? pending.preview.session.id) : params.id ? Number(params.id) : undefined,
    worktreeId: targetMatches && worktreeOf ? worktreeOf.id : undefined,
  });
  // A Chat picked in another Project opens that Project here, behind the splash mark, rather than in the navigation.
  const { wanted, error: openError, retry: retryOpen } = useOpenProject(params);
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
  const sidebar = (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel="Open navigation" onPress={() => panels.show("left")} />
    </Stack.Toolbar>
  );
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
    }, [designKey, params.id]),
  );
  useEffect(() => {
    if (!busy && !picking && designDeferred.current) sendDesign.current();
  }, [busy, picking]);
  // Compact now, pressed on the context sheet: Claude's /compact as a divider in the chat, with no handoff and the
  // draft kept. Each new count per chat key sends once; counts already there when the screen mounts are old news.
  // The Chat's values are read from the key here, so the effect sits above the Redirect with the other hooks.
  const compactSeen = useRef<Record<string, number> | null>(null);
  const compactRequests = composer.compactRequests;
  useEffect(() => {
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
  if (!session.client || (!session.snapshot && !wanted)) return <Redirect href="/" />;
  if (!session.snapshot || !targetMatches || needsWorktree) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "", headerBackVisible: false, gestureEnabled: false }} />
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
  const { project, runs } = session.snapshot;
  const chat = params.id ? project.state.sessions[Number(params.id)] : null;
  const chatId = `${project.path}#${params.id ?? `new:${params.worktreeId}`}`;
  const draft = composer.drafts[chatId] || "";
  const attachments = composer.attachments[chatId] || [];
  const attachmentDisabled = busy || picking || attachments.length >= 4;
  const run = chat ? runs.runs[chatId] : undefined;
  // Feedback cards read the agent's resolutions again only when a comment may have changed.
  const designsMoved = designActivity(
    [...messages.flatMap((message) => message.steps ?? []), ...(run?.steps ?? [])],
    messages.filter((message) => message.role === "user").map((message) => message.body),
  );
  const contextUsage = run?.contextUsage ?? chat?.contextUsage;
  const preferences = composer.preferences[chatId] || composer.defaults;
  const turn = turnTarget(composer.preferences[chatId], chat?.provider, composer.defaults);
  const actualProvider = turn.provider;
  const model = selectedModel(actualProvider, turn.model || (chat && !turn.picked ? lastUserModel(project.state, chat.id) : ""), session.models);
  const ultracodeOn = model.ultracode && !!preferences.ultracode;
  const worktreeId = chat?.worktree_id ?? Number(params.worktreeId);
  const worktree = project.state.worktrees[worktreeId];
  const branches = branchList?.client === client && branchList.path === project.path ? branchList : null;
  const base =
    baseBranch && branches?.items.includes(baseBranch)
      ? baseBranch
      : worktree?.name && branches?.items.includes(worktree.name)
        ? worktree.name
        : branches?.items[0] || "";
  const newWorktree = !project.link && !params.id && isolation === "worktree";
  const targetDisabled = busy || picking;
  const branchDisabled = targetDisabled || (newWorktree && !branches?.items.length);
  const branchName = newWorktree ? base || "Choose branch" : worktree?.name || "Choose branch";
  const unavailable = session.cliStatus?.[actualProvider]?.state !== undefined && session.cliStatus[actualProvider].state !== "ready";
  const title = chat ? chatTitle(chat, messages) : pending?.preview.session.title || "New Chat";
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
      const next = appendAttachments(attachments, added);
      composer.setAttachments((current) => ({ ...current, [chatId]: next }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pickingNow.current = false;
      setPicking(false);
    }
  }
  async function pasteImage(image: PastedImage) {
    if (attachmentDisabled || pickingNow.current) {
      discardPastedImage(image);
      setError(attachments.length >= 4 ? "Attach up to 4 photos or files per message." : "Wait for the current attachment to finish, then paste again.");
      return;
    }
    pickingNow.current = true;
    setPicking(true);
    setError("");
    try {
      const added = await preparePastedImage(image);
      if (currentScrollKey.current !== scrollKey) return;
      const next = appendAttachments(attachments, [added]);
      composer.setAttachments((current) => ({ ...current, [chatId]: next }));
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
    if (!message || !designKey) return;
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
    const issueKey = issue?.key;
    // A turn running now takes this message as a steer, on the provider it already runs.
    const steered = Boolean(run);
    if (!body && !(withAttachments && attachments.length)) return false;
    if (busy || sendingRef.current || pending || picking) return "busy";
    sendingRef.current = true;
    setBusy(true);
    setError("");
    const sent = body;
    const sendingProjectPath = project.path;
    const sending = withAttachments ? attachments : [];
    const focus = focused.current;
    const current = () => focus !== null && focused.current === focus && session.isSelected();
    const clearsDraft = sent === draft || issueKey !== undefined;
    const creates = newWorktree || issueKey !== undefined;
    const key = `${client.url}|${chatId}`;
    const operationId = project.link ? composer.linkOperations.forSend(key, JSON.stringify([sent, sending.map((item) => item.id)]), randomUUID) : null;
    const preview = createPendingChat({
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
        originChatId: chatId,
        originSessionId: params.id ? Number(params.id) : null,
        worktreeId,
        newWorktree: creates,
        accepted: false,
      },
    }));
    if (clearsDraft) composer.setDrafts((current) => ({ ...current, [chatId]: "" }));
    const sentIds = new Set(sending.map((item) => item.id));
    composer.setAttachments((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((item) => !sentIds.has(item.id)) }));
    following.current = true;
    Keyboard.dismiss();
    const options = sendOptions(model, preferences);
    let accepted = false;
    try {
      const media = await prepareAttachments(client, sendingProjectPath, sending);
      let target = { sessionId: params.id ? Number(params.id) : (null as number | null), worktreeId };
      if (creates) {
        if (!base) throw new Error(branches?.error || "Choose a base branch before sending.");
        let ready = preparedTarget.current;
        if (!ready || ready.client !== client || ready.path !== sendingProjectPath || ready.base !== base || ready.issueKey !== issueKey) {
          const created = await client.call<{ project: OpenProject; worktreeId: number }>("worktree:create", [
            {
              projectPath: sendingProjectPath,
              baseBranch: base,
              prompt: sent,
              ...(issueKey !== undefined ? { issueKey, ...(issue?.workspace ? { issueWorkspace: issue.workspace } : {}) } : {}),
            },
          ]);
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
      const result = project.link
        ? await client.call<{ sessionId: number }>("link:send", [
            {
              linkId: project.link.link.id,
              sessionId: params.id ? Number(params.id) : null,
              operationId,
              clientMessageId: preview.message.clientMessageId,
              body: sent,
              ...media,
              prompt: attachmentPrompt(sent, media.files),
              ...options,
            },
          ])
        : await client.call<{ sessionId: number }>("chat:send", [
            {
              projectPath: sendingProjectPath,
              ...target,
              clientMessageId: preview.message.clientMessageId,
              body: sent,
              ...media,
              // A Mac that predates PR actions ignores prAction and sends this prompt as it is.
              prompt: prAction ? pullRequestActionPrompt(prAction) : attachmentPrompt(sent, media.files),
              ...options,
              ...(prAction ? { prAction: { action: prAction.action, pr: prAction.pr, url: prAction.url } } : {}),
              // A Mac that predates issue cards ignores linearIssue and sends the body as a plain message.
              ...(issue ? { linearIssue: linearIssueRequest({ key: issue.key, workspace: issue.workspace, note: draft })! } : {}),
            },
          ]);
      accepted = true;
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
      if (clearsDraft || destination !== chatId)
        composer.setDrafts((current) => {
          const remaining = current[chatId] || "";
          const preserved = destination !== chatId ? current[destination] || "" : "";
          const next = { ...current, [destination]: [preserved, remaining].filter(Boolean).join("\n") };
          if (destination !== chatId) delete next[chatId];
          return next;
        });
      composer.setAttachments((current) => {
        const sentIds = new Set(sending.map((item) => item.id));
        const remaining = (current[chatId] || []).filter((item) => !sentIds.has(item.id));
        const preserved = destination !== chatId ? current[destination] || [] : [];
        const next = { ...current, [destination]: [...preserved, ...remaining] };
        if (destination !== chatId) delete next[chatId];
        return next;
      });
      composer.setPreferences((current) => {
        const next = { ...current, [destination]: afterSend(current[chatId] || preferences, turn, chat?.provider, model.id, steered) };
        if (destination !== chatId) delete next[chatId];
        return next;
      });
      session.expectActivity();
      if (current()) {
        following.current = true;
        Keyboard.dismiss();
        if (!params.id) adoptChat(result.sessionId);
      }
      await session.refresh();
      return true;
    } catch (e) {
      if (!accepted) {
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
      sendingRef.current = false;
      setBusy(false);
    }
  }
  function headerAction(id: string) {
    if (id === "changes") panels.show("right");
    // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with -- pr comes unvalidated from the host's JSON response, so pr.url may be missing and startsWith would throw
    else if (id === "pr" && pr && /^https:\/\//.test(pr.url)) void Linking.openURL(pr.url).catch(() => {});
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
    else if (id === "archive" && chat?.archived) void action(() => client.call("chat:patch", [project.path, chat.id, { archived: false }]));
    else if (id === "archive" && chat) void archive(chat);
  }
  // Archive asks first, as desktop does, with what removing the worktree would lose; a running turn is stopped. Once
  // confirmed the sidebar opens and the archive finishes there, on the Chat's row. Keeping the same sidebar mounted
  // preserves its scroll and avoids a second screen transition. Completion never moves the phone again.
  async function archive(target: NonNullable<typeof chat>) {
    if (busy || archiveRequest.current) return;
    archiveRequest.current = true;
    let left = false;
    const leave = () => {
      left = true;
      panels.show("left");
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
          alert: confirmSheet,
          projectPath: project.path,
          state: project.state,
          chat: target,
          running: !!run,
          onConfirm: () => {
            session.expectActivity();
            leave();
          },
          notify: showArchiveNotice,
          refresh,
        });
    } catch (e) {
      if (left) showArchiveNotice(`Could not archive Chat: ${(e as Error).message}`);
      else setError((e as Error).message);
    } finally {
      archiveRequest.current = false;
    }
  }
  const blockers = pullRequestBlockers(pr);
  // The pill's action, checked here too: a PR without a number yet shows no pill instead of sending a broken one.
  const prActionRequest = pr && blockers[0] ? pullRequestActionContext({ action: blockers[0], pr: pr.number, url: pr.url }) : null;
  const agents = (chat?.subagents || []).filter((agent) => !agent.archived);
  const diff = worktree?.diff;
  const linearIssue: LinearIssue | undefined = worktree ? linearIssues[worktree.path] : undefined;
  function openLinearIssue(url: string) {
    // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with -- the issue comes from the host's JSON, so url may be missing and startsWith would throw
    if (/^https:\/\//.test(url)) void Linking.openURL(url).catch(() => {});
  }
  // A Chat's own Worktree (not the main checkout, not one another Chat shares) can link an issue; a stored one is shown
  // with its hint when Linear can't see it. Nothing about the link shows while Linear is off.
  const canLink = linearActive && !!chat && !project.link && !!worktree?.path && worktree.path !== project.path && !worktreeShared(project.state, chat.id);
  const storedIssue = linearActive ? worktree?.linearIssue : undefined;
  const linkHint = storedIssue && !(worktree?.name ?? "").toLowerCase().includes(storedIssue.toLowerCase()) ? LINK_PR_HINT(storedIssue) : null;
  /** Picks an issue from the list and links it to this Chat's Worktree. */
  /** A short confirmation over the transcript that goes away on its own, for results that need no answer. */
  function showToast(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
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
      <View style={{ alignItems: "center", maxWidth: 230 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16, fontWeight: "600", flexShrink: 1 }}>
            {title}
          </Text>
        </View>
        {!project.link && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, opacity: worktree ? 1 : 0 }}>
            <Icon icon={GitBranchIcon} tone="ink3" size={11} />
            <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12, flexShrink: 1 }}>
              {worktree?.name ?? ""}
            </Text>
            <Text style={{ fontSize: 12 }}>
              <Text style={{ color: colors.green }}>{diff && (diff.added > 0 || diff.removed > 0) ? `+${diff.added}` : ""}</Text>
              {diff && (diff.added > 0 || diff.removed > 0) ? " " : ""}
              <Text style={{ color: colors.red }}>{diff && (diff.added > 0 || diff.removed > 0) ? `−${diff.removed}` : ""}</Text>
            </Text>
          </View>
        )}
      </View>
    </>
  );
  const more = (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Chat actions">
        <Stack.Toolbar.MenuAction
          icon="doc.text.magnifyingglass"
          subtitle={diff ? `+${diff.added} −${diff.removed}` : undefined}
          onPress={() => headerAction("changes")}
        >
          View changes
        </Stack.Toolbar.MenuAction>
        {pr && (
          <Stack.Toolbar.MenuAction
            icon="arrow.triangle.pull"
            subtitle={blockers.length ? blockers.join(", ").replace(/-/g, " ") : pr.state === "MERGED" ? "Merged" : "Open on GitHub"}
            onPress={() => headerAction("pr")}
          >{`Pull request #${pr.number}`}</Stack.Toolbar.MenuAction>
        )}
        {linearIssue && (
          <Stack.Toolbar.MenuAction icon={LINEAR_MARK} iconRenderingMode="template" onPress={() => openLinearIssue(linearIssue.url)}>
            {issueChipLabel(linearIssue)}
          </Stack.Toolbar.MenuAction>
        )}
        {linkHint && (
          <Stack.Toolbar.MenuAction icon="info.circle" disabled>
            {linkHint}
          </Stack.Toolbar.MenuAction>
        )}
        {agents.length > 0 && (
          <Stack.Toolbar.MenuAction icon="person.2" subtitle={String(agents.length)} onPress={() => headerAction("agents")}>
            Subagents
          </Stack.Toolbar.MenuAction>
        )}
        {chat && (
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="pencil" onPress={() => headerAction("rename")}>
              Rename
            </Stack.Toolbar.MenuAction>
            {canLink &&
              (storedIssue ? (
                <Stack.Toolbar.MenuAction icon={LINEAR_MARK} iconRenderingMode="template" disabled={busy} onPress={() => void unlinkWorktreeIssue()}>
                  Unlink issue
                </Stack.Toolbar.MenuAction>
              ) : (
                <Stack.Toolbar.MenuAction icon={LINEAR_MARK} iconRenderingMode="template" disabled={busy} onPress={linkIssue}>
                  Link issue…
                </Stack.Toolbar.MenuAction>
              ))}
            <Stack.Toolbar.MenuAction icon={chat.archived ? "tray.and.arrow.up" : "archivebox"} disabled={busy} onPress={() => headerAction("archive")}>
              {chat.archived ? "Restore" : "Archive"}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        )}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
  const question = run?.questions[0];
  const answering = !!question && sentAnswers?.requestId === question.requestId;
  // The host's message replaces the preview as soon as the transcript grows by it.
  const answerPreview = answering && sentAnswers.count === messages.length ? sentAnswers.message : null;
  const pendingInput = pending && pendingCanonicalId === null ? pending.preview.message : null;
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
  // The composer floats above the transcript and rides the keyboard, stopping 8pt above it.
  const dockPadding = Math.max(insets.bottom, 12);
  const lift = dockPadding - 8;
  return (
    <GenerativeUIProvider send={genuiSend}>
      <View style={[styles.screen, dots]}>
        <Stack.Screen options={{ title, headerTitle: () => header, headerBackVisible: false, gestureEnabled: false }} />
        {sidebar}
        {more}
        <PanelSwipe panels={panels}>
          {/* The header clearance is in paddingTop; an automatic iOS inset would add it a second time. */}
          <KeyboardChatScrollView
            key={scrollKey}
            ref={scroll}
            offset={lift}
            keyboardLiftBehavior="whenAtEnd"
            onEndVisible={onEndVisible}
            contentInsetAdjustmentBehavior="never"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 84, paddingLeft: 28, gap: 16, paddingBottom: dockHeight + 16 }]}
            scrollEventThrottle={32}
            onScrollBeginDrag={() => {
              scrollingToBottom.current = false;
            }}
            onScroll={({ nativeEvent: e }) => {
              const previous = scrollOffset.current;
              scrollOffset.current = e.contentOffset.y;
              const distance = e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height;
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
            {!messages.length && !run && (
              <View style={{ paddingVertical: 48, alignItems: "center", gap: 8 }}>
                <Text style={styles.subtitle}>What are we working on?</Text>
                <Text style={[styles.muted, { textAlign: "center" }]}>
                  {project.link
                    ? "One Chat, with a new Worktree in each linked Project on your computer."
                    : newWorktree
                      ? `Your agent starts in a new worktree from ${base || "the selected branch"} on your computer.`
                      : `Your agent runs in ${worktree?.name || "this Worktree"} on your computer.`}
                </Text>
              </View>
            )}
            {newWorktree && branches?.error ? <ErrorNotice message={branches.error} /> : null}
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
            {messages.slice(-visible).flatMap((message) => [
              ...(liveReply && message === pendingInput ? [liveReply] : []),
              <View
                key={message.clientMessageId ?? message.id}
                nativeID={`chat-message-${message.id}`}
                onLayout={({ nativeEvent: { layout } }) => {
                  messagePositions.current.set(message.id, layout.y);
                  const anchor = historyAnchor.current;
                  if (anchor?.key === scrollKey && anchor.id === message.id) {
                    historyAnchor.current = null;
                    const y = Math.max(0, scrollOffset.current + layout.y - anchor.y);
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
                ) : (
                  <ChatReply
                    message={message}
                    media={media}
                    basePath={worktree?.path || project.path}
                    chatId={chatId}
                    designChoice={designChoice}
                    designsMoved={designsMoved}
                    onActivity={openActivity}
                  />
                )}
              </View>,
            ])}
            {!pendingInput && liveReply}
            {answerPreview && <ChatReply key="answers" message={answerPreview} media={media} chatId={chatId} onActivity={openActivity} />}
            {(run || pending) && (
              <ThinkingIndicator
                startedAt={pending?.preview.startedAt ?? run?.startedAt}
                label={run?.waitingForSubagents ? "Waiting on subagents" : `Working with ${model.name}`}
              />
            )}
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
            {session.error ? <ErrorNotice message={session.error} retry={() => router.dismissTo("/")} /> : null}
          </KeyboardChatScrollView>
          {/* The transcript blurs and fades under the transparent header, as under the composer. iOS's own soft edge can't
        find this scroll view (it only follows each view's first child), so the blur is drawn here. It ends where the
        transcript's top padding does and gradually strengthens toward the status bar. */}
          <EdgeFade edge="top" height={insets.top + 84} />
          <AttentionPill projectPath={project.path} bottom={dockHeight + 12} />
          {toast ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, top: insets.top + 64, alignItems: "center" }}>
              <View
                accessibilityLiveRegion="polite"
                style={{ maxWidth: 360, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.ink }}
              >
                <Text style={{ color: colors.surface, fontSize: 14 }}>{toast}</Text>
              </View>
            </View>
          ) : null}
          <MessageNavigation items={navigationItems} onSelect={navigateToMessage} top={insets.top + 72} bottom={dockHeight + 12} keyboardOffset={lift} />
          <KeyboardStickyView pointerEvents="box-none" offset={{ closed: 0, opened: lift }} style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
            {showJumpToBottom && (
              <View pointerEvents="box-none" style={{ height: 56, alignItems: "center", zIndex: 1 }}>
                <GlassIconButton label="Go to bottom" systemImage="chevron.down" icon={ArrowDown01Icon} onPress={jumpToBottom} />
              </View>
            )}
            {/* The transcript blurs and fades under the composer like desktop's. */}
            <BottomFade height={dockHeight + 48} />
            <View
              onLayout={({ nativeEvent }) => setDockHeight(Math.round(nativeEvent.layout.height))}
              style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: dockPadding, gap: 8 }}
            >
              {(!question || answering) && (
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 8 }}>
                  {pr && prActionRequest && chat && (
                    <PullRequestAction
                      pr={pr}
                      disabled={busy || !!run}
                      onRun={() => void send(pullRequestActionBody(prActionRequest), false, prActionRequest)}
                    />
                  )}
                  <View style={{ flex: 1 }} />
                  <BrowserChip chatId={params.id ? chatId : undefined} />
                  {params.id && Number(params.id) > 0 && chat && !chat.archived && (
                    <TerminalChip key={`terminal-${chatId}`} chatId={chatId} places={terminalPlaces(chat)} />
                  )}
                  {params.id && Number(params.id) > 0 && <PortsChip key={`ports-${chatId}`} chatId={chatId} />}
                  {params.id && Number(params.id) > 0 && <SimulatorChip key={chatId} chatId={chatId} />}
                  {agents.length > 0 && <SubagentChip agents={agents} onPress={() => headerAction("agents")} />}
                </View>
              )}
              {run?.approvals.map((approval) => (
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
              ))}
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
              {(!question || answering) && (
                <View
                  style={{
                    backgroundColor: "transparent",
                    borderWidth: 1,
                    borderColor: colors.lineStrong,
                    borderRadius: 24,
                    borderCurve: "continuous",
                    overflow: "hidden",
                    paddingTop: 8,
                    paddingHorizontal: 8,
                    paddingBottom: 6,
                    gap: 4,
                    boxShadow: ultracodeOn ? `0 4px 22px ${colors.purple}47` : "0 4px 20px #0000000f",
                  }}
                >
                  <LiquidGlassView
                    pointerEvents="none"
                    glassType="clear"
                    isInteractive={false}
                    reducedTransparencyFallbackColor={colors.surface}
                    style={[StyleSheet.absoluteFill, { borderRadius: 24, borderCurve: "continuous" }]}
                  />
                  {/* With Ultracode on, the composer takes its purple: a breathing tint and border, and a glow. */}
                  {ultracodeOn && <UltracodeGlow radius={24} />}
                  {!params.id && !project.link && (
                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
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
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            opacity: targetDisabled ? 0.35 : 1,
                          }}
                        >
                          <Icon icon={isolation === "local" ? LaptopIcon : GitForkIcon} tone="ink2" size={14} />
                          <Text style={styles.label}>{isolation === "local" ? "Local" : "New worktree"}</Text>
                          <Icon icon={ArrowDown01Icon} tone="ink3" size={12} />
                        </View>
                      </PullDown>
                      <PullDown
                        label="Choose branch"
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
                                  subtitle: item.path?.split("/").filter(Boolean).pop(),
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
                          <Text style={styles.label}>Linear issue</Text>
                        </Pressable>
                      )}
                    </View>
                  )}
                  {!!attachments.length && (
                    <PageScroll horizontal contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 8 }}>
                      {attachments.map((item) => (
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
                                router.push({ pathname: "/file-preview", params: item.path ? { path: item.path } : { uri: item.uri, name: item.name } })
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
                              {item.name}
                            </Text>
                          )}
                          <IconButton
                            label={`Remove ${item.name}`}
                            icon={Cancel01Icon}
                            size={32}
                            disabled={busy || picking}
                            onPress={() =>
                              composer.setAttachments((current) => ({
                                ...current,
                                [chatId]: (current[chatId] || []).filter((attachment) => attachment.id !== item.id),
                              }))
                            }
                          />
                        </View>
                      ))}
                    </PageScroll>
                  )}
                  <PromptField
                    key={chatId}
                    client={client}
                    projectPath={worktree?.path || (project.link ? "" : project.path)}
                    draft={draft}
                    onImagePaste={(image) => void pasteImage(image)}
                    onChangeText={(value) => composer.setDrafts((current) => ({ ...current, [chatId]: value }))}
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
                    {contextUsage && contextUsage.size > 0 && params.id && (
                      <ContextRing
                        {...contextUsage}
                        canCompact={Boolean(chat) && (chat?.provider ?? "claude") === "claude"}
                        onPress={() => router.push({ pathname: "/context-sheet", params: { id: params.id } })}
                      />
                    )}
                    {run && !draft.trim() && !attachments.length && (
                      <IconButton
                        label="Stop"
                        icon={StopIcon}
                        filled
                        size={34}
                        disabled={actionBusy}
                        onPress={() => void action(() => client.call("agent:interrupt", [chatId]), true)}
                      />
                    )}
                    {(!run || !!draft.trim() || !!attachments.length) && (
                      <IconButton
                        label={busy ? "Sending..." : run ? "Send follow-up" : "Send message"}
                        icon={ArrowUp01Icon}
                        filled
                        size={34}
                        loading={busy}
                        disabled={
                          busy ||
                          picking ||
                          (newWorktree && !base) ||
                          (!draft.trim() && !attachments.length) ||
                          !!session.error ||
                          !!chat?.archived ||
                          unavailable
                        }
                        onPress={() => void send()}
                      />
                    )}
                  </View>
                </View>
              )}
            </View>
          </KeyboardStickyView>
        </PanelSwipe>
      </View>
    </GenerativeUIProvider>
  );
}
