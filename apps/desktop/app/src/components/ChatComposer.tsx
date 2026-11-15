import { useCompactionFeedback } from "@milagre/shared/use-compaction-feedback";
import { type ComposerQuote } from "@milagre/shared/prompt-parts";
import { MessageSelection } from "./MessageSelection";
import { useQuoteInbox } from "../lib/quote-inbox";
import { compactionContext } from "@milagre/shared/compaction";
import { providerName } from "@milagre/shared/providers";
import { SubagentTrack } from "./agents/SubagentTrack";
import { UpdatePillSlot } from "./UpdateNotice";
import { BrowserPanel } from "./agents/BrowserPanel";
import { openBrowserTab } from "../lib/browser-panel";
import { SimulatorTrack } from "./agents/SimulatorTrack";
import { useEvent } from "../lib/stable";
import type { MessageDelivery } from "@milagre/shared/queued-messages";
import { chatHistory } from "@milagre/shared/chat-history";
import type { AgentPort, LimitResume, BackgroundTask, ChatPlan, ContextUsage, ImageAttachment, Subagent } from "../model";
import { PortTrack } from "./agents/PortTrack";
import { TaskTrack } from "./agents/TaskTrack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { runStatusLabel } from "@milagre/shared/tool-activity";
import { LoopbackPortsContext } from "../lib/ports";
import { ArrowDown01Icon, BubbleChatIcon, GitMergeIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { FirstChatStarters, type Starter } from "./Onboarding";
import type { LinearIssue } from "@milagre/shared/linear";
import type {
  AgentCliStatus,
  EffortLevel,
  ModelCapability,
  ChatMessage as AppChatMessage,
  ChatStep,
  Isolation,
  ModelOption,
  ModelProvider,
  PermissionMode,
} from "../model";
import { FindBar } from "./FindBar";
import { Notice } from "./Notice";
import { EMPTY_CHAT_MENTIONS, type ChatMentionScope } from "./ChatMentions";
import { type StepApproval } from "./agents/step-approval";
import { insertImageMentions } from "../lib/file-mentions";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import type { ImageDraft } from "./usePastedImages";
import { DraftPromptComposer } from "./DraftPromptComposer";
import type { DraftStore } from "../lib/draft-store";
import { QueuedMessages } from "./QueuedMessages";
import { NextCheck } from "./routines/NextCheck";
import type { QueueControls } from "./QueuedMessages";
import { NewChatHeading } from "./NewChatHeading";
import Tooltip from "./primitives/Tooltip";
import { PillSlot, StatusPill } from "./primitives/StatusPill";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { BackgroundWork } from "./agents/BackgroundWork";
import { backgroundItems } from "@milagre/shared/chat-activity";
import { ChatMarkDotInline } from "./sidebar/ChatRow";
import type { ChatActivity } from "@milagre/shared/chat-activity";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { undoableTasks, type Checkpoint, type CheckpointApi } from "@milagre/shared/checkpoints";
import { UndoPanel, type UndoIntent } from "./checkpoints/UndoPanel";
import { bridgeForKey } from "../lib/computer-bridge";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { STORAGE_COMMAND } from "@milagre/shared/storage";
import { openStorage } from "../lib/storage-open";
import { useChatsGroup, useProjectGroups } from "../lib/project-copies";
import { headingLayer, newChatLook } from "../lib/new-chat-look";
import { WelcomeSky } from "./WelcomeSky";
import { NewChatGlance } from "./NewChatGlance";
import type { ChatsHome, ProjectKind } from "@milagre/shared/chats-home";
import { isModalOpen } from "../lib/modal";
import { MessageScroller } from "./agents/message-scroller";
import { StepDetailsScope } from "./agents/step-details";
import { useSettings } from "../lib/settings";
import { LoadingMark } from "./StartupSplash";
import { MessageTranscript } from "./transcript/MessageTranscript";
import { ReplyProviders, TranscriptContexts, TranscriptSlots } from "./transcript/ChatTranscript";
import { NO_WORKTREES, NO_BRANCHES, NewChatHeader } from "./NewChatHeader";

export interface ChatComposerProps {
  limitPending?: LimitResume;
  limitSourceMessageId?: number;
  limitResumeBlocked?: boolean;
  mentionContext?: ChatMentionScope;
  /** The chat's computer is away: the composer is disabled and says so. */
  offlineName?: string | null;
  /** The connection to the chat's computer is coming back: the draft stays writable, and Send waits for it. */
  reconnectingName?: string | null;
  /** Above the prompt, inside a tray like a new Chat's: messages waiting on this Mac and the offline computer's chip. */
  offlineTray?: ReactNode;
  /** The Chat is mounted but not on screen (Settings, the canvas, Routines): its Browser panel and button go away. */
  offScreen?: boolean;
  /** Sends a comment on a design, or the design the user chose, to the agent; resolves whether it went. */
  onSendDesignMessage?: (text: string) => Promise<boolean>;
  /** Sends the Browser panel's page comments, with their screenshots. */
  onSendPageComments?: (text: string, images: ImageAttachment[]) => Promise<boolean>;
  /** Opens a file's diff in the Changes panel, from the undo preview. */
  onOpenDiff?: (path: string, worktree: string) => void;
  /** Opens an associated PR in this Chat's Git panel; false leaves normal link handling in place. */
  onOpenPullRequestLink?: (url: string) => boolean;
  /** A Link's Chat starts without the new-chat header. */
  scopeKind?: "project" | "link";
  /** The find bar over the message list; the parent owns it so ⌘F and the command palette can open it. */
  findOpen?: boolean;
  findSignal?: number;
  /** Text the find bar fills in when `findSignal` changes, e.g. the words a ⌘K message result matched. */
  findSeed?: string;
  onFindClose?: () => void;
  imageDraft: ImageDraft;
  projectPath: string;
  /** Where the `/` menu reads skills, when not `projectPath`: a Link's key, or a shared Chat's own folder. */
  skillScope?: string;
  /** Messages of the Chat the host holds before `messages` (chat-pages-v1): how many, and reading them. */
  earlier?: { count: number; load: () => Promise<void>; loadAll: (signal?: AbortSignal) => Promise<void> };
  /** Drops the Chat's window back to its last turns once `canTrim` (asked again if a read is on its way) still says so. */
  trimHistory?: (canTrim: () => boolean) => void;
  /** The Project or Link (scope key) the messages belong to, for step output the host keeps out of the state. */
  messageScope?: string;
  /** The open conversation keeps its scroll view when a draft gets its saved Chat id. */
  scrollKey?: number | string;
  messages: AppChatMessage[];
  /** A saved Chat's page is still being read, so an empty `messages` doesn't mean a new Chat. */
  loading?: boolean;
  loadError?: string;
  onRetryLoad?: () => void;
  /** Unsaved input appears below the reply still streaming while the backend prepares the send. */
  pendingMessageId?: number;
  /**
   * The Chat's draft: the typed text and the passages quoted above it. Only the prompt subscribes to it, so a keystroke
   * re-renders the prompt and not this whole composer; the handlers here read it when they run.
   */
  store: DraftStore;
  onSend: (delivery?: MessageDelivery) => void;
  onStop?: () => void;
  /** Sends `/compact` to the chat (Claude only); the context card offers it as Compact now. */
  onCompact?: () => void;
  /** One-click fix for whatever blocks the chat's PR from merging (conflicts, an outdated branch, requested changes). */
  /** The PR's next step: a blocker the agent can fix (red, orange), or a ready PR to merge (green, opens its panel). */
  pullRequestAction?: { label: string; tone: "red" | "orange" | "green"; onRun: () => void };
  /** The PR's unresolved review threads, beside the PR action: opens them in the PR panel. */
  pullRequestReview?: { count: number; onOpen: () => void };
  isSending: boolean;
  /** Sending is briefly blocked while a message is being prepared; a running turn doesn't block it. */
  sendBlocked: boolean;
  readOnlyHistory?: boolean;
  /** The chat key of the running turn whose streamed text the transcript shows (lib/run-text.ts); it reads the text itself. */
  streamingKey?: string;
  /** The running turn's text, for a caller that holds it itself (no `streamingKey`). */
  streamingText?: string;
  /** The running turn's tool steps, where they happened in its streamed text. */
  streamingSteps?: ChatStep[];
  subagents?: Subagent[];
  backgroundTasks?: BackgroundTask[];
  onArchiveFinishedSubagents?: () => void;
  onArchiveSubagent?: (id: string, archived: boolean) => void;
  onStopAdvisor?: (id: string) => void;
  onRetryAdvisor?: (id: string) => void;
  waitingForSubagents?: boolean;
  /** The Chat's activity (chat-activity.mjs): a background one shows how many background agents still work. */
  activity?: ChatActivity;
  /** The Chat's plan (tasks and phases), shown as a pill beside the subagents. */
  plan?: ChatPlan;
  /** How full the agent's context window is, shown as a ring beside Send. */
  contextUsage?: ContextUsage;
  suggestion?: string;
  /** The ports the chat's commands listen on, shown as a pill beside the to-do list. */
  ports?: AgentPort[];
  /** The runtime's key for this Chat (`projectPath#id`), which browser ownership is recorded under. */
  agentChatId?: string;
  /** Stops the command listening on one of the chat's ports. */
  onStopPort?: (pid: number) => Promise<unknown>;
  /** Steps of the running turn whose approval card is open. */
  waitingStepIds?: string[];
  /** The running turn is waiting on the user's answer to a question. */
  asking?: boolean;
  /** The model the open chat's running turn uses; the picker may already show another. */
  runModelName?: string;
  /** The provider the open chat runs on; the picker may already show the other one. */
  sessionProvider?: ModelProvider;
  /** The active turn's start time, independent of the chat view. */
  runStartedAt?: number;
  /** What the Chat waits on before its agent works (the send going out, the agent starting), beside the running mark. */
  statusLabel?: string;
  /** Opens the Chat a Delegation, report or agreement came from, in whichever Project it is. */
  onOpenLinkedChat?: (chatKey: string) => void;
  /** Opens Settings > Accounts, from the usage-limit card when the Project has no other account to switch to. */
  onOpenAccounts?: () => void;
  /** A chat a quit stopped longer ago than Milagre resumes by itself: Continue starts its turn again. */
  resume?: { onContinue: () => void };
  /** Messages waiting for the running turn of an agent that can't be steered, shown above the composer. */
  queue?: QueueControls;
  /** The models the picker offers (see mergeModels). */
  models: ModelOption[];
  /** How each agent's CLI stands, flagged in the model picker; null until it's known. */
  cliStatus: AgentCliStatus | null;
  /** The model picker was opened; the status is checked again. */
  onModelPickerOpen: () => void;
  onUpdateCli?: (provider: ModelProvider) => void;
  updatingCli?: ModelProvider | null;
  selectedModel: ModelOption;
  onModelChange: (model: ModelOption) => void;
  capability: ModelCapability;
  effort?: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  ultracode: boolean;
  onUltracodeChange: (on: boolean) => void;
  fastMode: boolean;
  onFastModeChange: (on: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onRecommendationSelect: (option: string) => void;
  approval?: ReactNode;
  /** The cards stay mounted but out of sight, such as a question whose answers are on their way to the agent. */
  approvalHidden?: boolean;
  /** The open approval, for the tool row it is about: Deny and Allow show there instead of on a card. */
  stepApproval?: StepApproval | null;
  /**
   * The Project a new Chat starts in, named in the "Start building in" heading; its dropdown moves the new Chat to another.
   * `kind: "chats"` is a Chats home draft (No project); `onChange` gets `home` when the move is to a Chats home, saying
   * whether that computer has made it yet.
   */
  newChatProject?: {
    key: string;
    name: string;
    kind?: ProjectKind;
    onChange?: (key: string, home?: Pick<ChatsHome, "exists">) => void;
    /** Starts the new Chat in one of this Mac's Links instead, picked from the same dropdown. */
    onLinkPick?: (id: string) => void;
  };
  worktrees: Array<{ id: number; name: string; path: string }>;
  selectedWorktreeId?: number;
  onWorktreeChange: (id: number) => void;
  isolation: Isolation;
  onIsolationChange: (isolation: Isolation) => void;
  branches: string[];
  baseBranch: string;
  onBaseBranchChange: (branch: string) => void;
  /** Linear is on and connected: the new-chat header offers a Linear issue to start from. */
  linearActive?: boolean;
  onStartFromIssue?: (issue: LinearIssue) => void;
  newChatError: string | null;
  saveNotice?: ReactNode;
  notice?: string | null;
  onDismissNotice?: () => void;
  /** A muted line under the composer, e.g. what replying to a hidden Run Chat does. */
  composerNote?: string;
  /** The Project is a folder outside Git: a new Chat works in it, with no isolation or branch to pick. */
  noGit?: boolean;
  /** The first Chat of a Project opened from onboarding: tasks to start with, sent as they are. */
  starters?: Starter[];
}

const EMPTY_SUBAGENTS: Subagent[] = [];

export function ChatComposer({
  mentionContext = EMPTY_CHAT_MENTIONS,
  offlineName,
  reconnectingName,
  offlineTray,
  offScreen = false,
  scopeKind,
  imageDraft,
  projectPath,
  skillScope,
  messageScope,
  scrollKey,
  earlier,
  trimHistory,
  messages,
  loading = false,
  loadError,
  onRetryLoad,
  pendingMessageId,
  store,
  onSend,
  onStop,
  onCompact,
  pullRequestAction,
  pullRequestReview,
  isSending,
  sendBlocked,
  readOnlyHistory = false,
  streamingKey,
  streamingText,
  streamingSteps,
  subagents = EMPTY_SUBAGENTS,
  backgroundTasks,
  onArchiveFinishedSubagents,
  onArchiveSubagent,
  onStopAdvisor,
  onRetryAdvisor,
  waitingForSubagents = false,
  activity,
  plan,
  contextUsage,
  suggestion,
  ports,
  agentChatId,
  onStopPort,
  waitingStepIds,
  asking = false,
  runModelName,
  sessionProvider,
  runStartedAt,
  statusLabel,
  onOpenLinkedChat,
  onOpenAccounts,
  limitPending,
  limitSourceMessageId,
  limitResumeBlocked,
  resume,
  queue,
  models,
  cliStatus,
  onModelPickerOpen,
  onUpdateCli,
  updatingCli,
  selectedModel,
  onModelChange,
  capability,
  effort,
  onEffortChange,
  ultracode,
  onUltracodeChange,
  fastMode,
  onFastModeChange,
  permissionMode,
  onPermissionModeChange,
  onRecommendationSelect,
  approval,
  approvalHidden = false,
  stepApproval = null,
  newChatProject,
  worktrees,
  selectedWorktreeId,
  onWorktreeChange,
  isolation,
  onIsolationChange,
  branches,
  baseBranch,
  onBaseBranchChange,
  linearActive,
  onStartFromIssue,
  newChatError,
  composerNote,
  noGit,
  starters,
  findOpen = false,
  findSignal = 0,
  findSeed,
  onFindClose,
  saveNotice,
  notice,
  onDismissNotice,
  onSendDesignMessage,
  onSendPageComments,
  onOpenDiff,
  onOpenPullRequestLink,
}: ChatComposerProps) {
  const loopbackPorts = useMemo(() => loopbackOnlyPorts(ports), [ports]);
  const { appearance, newChatGlance } = useSettings();
  const chatWidth = appearance.chatWidth;
  const root = useRef<HTMLDivElement>(null);
  const chatId = messages[0]?.session_id ?? "new";
  // A first message, including its preview while setup runs, opens the conversation layout. A saved Chat whose page is
  // still on its way from the host is not a new one: its conversation layout waits, empty, instead of the new-chat header.
  const isNewChat = messages.length === 0 && !loading && !loadError;
  // The top band's offset in the window, so its grain tile lines up with the window's (styles.css .chat-top-blur) without
  // a fixed background, which would make Chromium composite the band and everything over it.
  const topBandRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const band = topBandRef.current;
    const parent = band?.parentElement;
    if (isNewChat || !band || !parent) return;
    const update = () => {
      const { left, top } = band.getBoundingClientRect();
      band.style.setProperty("--chat-top-x", `${left}px`);
      band.style.setProperty("--chat-top-y", `${top}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [isNewChat]);
  // The docked chip row and composer: their height is the transcript's bottom pad, so the last line scrolls clear of them.
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const host = root.current;
    if (isNewChat || !dock || !host) return;
    const update = () => host.style.setProperty("--composer-dock", `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--composer-dock");
    };
  }, [isNewChat]);
  const reviewPill = !isNewChat && !!pullRequestReview && pullRequestReview.count > 0 && pullRequestReview;
  // A Project's new Chat: the heading sits in the upper middle, the setup chips and composer at the bottom. A Link's new
  // Chat keeps the composer centred.
  const [headingOpen, setHeadingOpen] = useState(false);
  const projectNewChat = isNewChat && (scopeKind ?? "project") === "project" && !offlineName;
  // A named Link's new Chat has no isolation or branch to choose, only an issue to start from.
  const linkNewChat = isNewChat && scopeKind === "link" && !offlineName && linearActive && !!onStartFromIssue;
  const newChatProjectKey = newChatProject?.key ?? projectPath;
  const newChatProjectName = newChatProject?.name ?? projectPath.split("/").findLast(Boolean) ?? projectPath;
  const projectGroups = useProjectGroups(projectNewChat && !!newChatProject?.onChange, newChatProjectKey, newChatProjectName, newChatProject?.kind);
  const chatsDraft = newChatProject?.kind === "chats";
  const noProjectGroup = useChatsGroup(projectNewChat && !!newChatProject?.onChange);
  const projectCopies = chatsDraft
    ? (noProjectGroup?.copies ?? [])
    : (projectGroups.find((group) => group.copies.some((copy) => copy.key === newChatProjectKey))?.copies ?? []);
  const newChatChange = newChatProject?.onChange;
  // The chip on a Chats home draft moves it to another computer's Chats home.
  const changeComputer = useMemo(
    () =>
      newChatChange && chatsDraft
        ? (key: string) => newChatChange(key, { exists: noProjectGroup?.copies.find((copy) => copy.key === key)?.exists ?? false })
        : newChatChange,
    [newChatChange, chatsDraft, noProjectGroup],
  );
  const workingModelName = runModelName ?? selectedModel.name;
  // The send's progress, or Worktree creation and setup, beside the running mark and timer. Tool calls and thinking name
  // themselves in the transcript's activity row, so the mark and timer stand alone for them.
  const phase = statusLabel ?? runStatusLabel(streamingSteps);
  // Set while the transcript is scrolled up: its "Go to bottom" sits at the right end of the chip row, never over text.
  // Kept with the transcript it belongs to, so a Chat opened next (or a parked one) never shows another's button.
  const [jumpToBottom, setJumpToBottom] = useState<{ key: string | null | undefined; jump: () => void } | null>(null);
  // At the transcript's end the dock floats over its empty bottom pad, so its glass has nothing to blur (styles.css).
  const [transcriptAtEnd, setTranscriptAtEnd] = useState(true);
  // The runtime knows a Chat by its Project's path, not the Worktree's `projectPath` it runs in.
  const runtimeChat = typeof chatId === "number" && chatId > 0 && projectPath ? (agentChatId ?? `${messageScope ?? projectPath}#${chatId}`) : null;
  // The transcript slot on screen (TranscriptSlots); a parked one comes back at its latest message.
  // A draft's transcript takes its view's key until the Chat is saved; its slot then becomes the Chat's.
  const draftKey = scrollKey === undefined ? null : `view:${scrollKey}`;
  const transcriptKey = isNewChat ? null : (agentChatId ?? runtimeChat ?? draftKey);
  // Pages open on the viewing Mac, including pages linked from a Chat on another computer.
  const browserChat = !isNewChat ? runtimeChat : null;
  // The panel docks outside the chat pane, so the pane hiding doesn't hide it.
  const browserShown = browserChat && !offScreen ? browserChat : null;
  // Undo changes: the Chat's task checkpoints, the panel that takes the composer's place, and the message it outlines.
  const checkpointApi = useMemo<CheckpointApi>(
    () => (runtimeChat ? keptCheckpoints(bridgeForKey(runtimeChat).checkpoints ?? NO_CHECKPOINTS) : NO_CHECKPOINTS),
    [runtimeChat],
  );
  const review = useCheckpoints(checkpointApi, runtimeChat ?? "");
  // Until the Chat's quiet list read answers, the list it had when it was last shown: its undo buttons show at once.
  const checkpointItems = review.items.length || !runtimeChat ? review.items : (lastCheckpoints.get(runtimeChat) ?? review.items);
  const [undoIntent, setUndoIntent] = useState<UndoIntent>("Undo");
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const reloadCheckpoints = review.reload;
  // A task's checkpoint gets its file count when the turn ends.
  useEffect(() => {
    if (runtimeChat && !isSending) void reloadCheckpoints();
  }, [runtimeChat, isSending, reloadCheckpoints]);
  const undoable = useMemo(
    () =>
      new Map(
        undoableTasks(checkpointItems)
          .filter((task) => task.messageId !== undefined)
          .map((task, index) => [task.messageId!, { id: task.id, latest: index === 0 }]),
      ),
    [checkpointItems],
  );
  const openUndo = useEvent(() => {
    if (readOnlyHistory) return;
    setUndoIntent("Undo");
    void review.open();
  });
  const undoTask = useEvent((id: string) => {
    if (readOnlyHistory) return;
    setUndoIntent("Undo");
    void review.inspect(id);
  });
  const previewRecovery = useEvent((id: string, action: UndoIntent) => {
    if (readOnlyHistory) return;
    setUndoIntent(action);
    void review.inspect(id);
  });
  const focusPrompt = useCallback((atEnd = false) => {
    requestAnimationFrame(() => {
      const editor = root.current?.querySelector<HTMLElement>("[data-prompt-editor]");
      editor?.focus();
      if (atEnd && editor) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    });
  }, []);
  // The prompt takes the keys at once after a pick, not the heading's button: what is typed while the draft moves to
  // the picked Project lands in the prompt, and goes along with it (App's moveNewChat).
  const moveDraft = useEvent((key: string, home?: Pick<ChatsHome, "exists">) => {
    root.current?.querySelector<HTMLElement>("[data-prompt-editor]")?.focus();
    newChatChange?.(key, home);
  });
  useEffect(() => {
    if (highlightId !== null) root.current?.querySelector(`#message-${highlightId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightId]);
  // Esc Esc in an idle Chat with an empty prompt lists its tasks to undo, as in Claude Code. It never writes anything.
  const lastEscape = useRef(0);
  const onEscape = useEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    // Escape in the prompt closes an open list, as it closes the slash menu.
    if (review.view !== "closed" && target?.closest("[data-promptbar]")) {
      event.preventDefault();
      review.close();
      return;
    }
    const typing =
      !!target?.closest("input, select, [contenteditable='true']:not([data-prompt-editor]), .xterm") ||
      (target?.tagName === "TEXTAREA" && !target.closest("[data-promptbar]"));
    const hidden = !root.current?.offsetParent;
    if (
      isSending ||
      review.view !== "closed" ||
      store.text().trim() ||
      store.quotes().length ||
      typing ||
      hidden ||
      isModalOpen() ||
      document.documentElement.hasAttribute("data-popover-open")
    ) {
      lastEscape.current = 0;
      return;
    }
    if (lastEscape.current && event.timeStamp - lastEscape.current < 450) {
      lastEscape.current = 0;
      event.preventDefault();
      openUndo();
    } else lastEscape.current = event.timeStamp;
  });
  useEffect(() => {
    if (!runtimeChat || offlineName) return;
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [runtimeChat, offlineName, onEscape]);
  // `/undo` opens the same list instead of going to the agent.
  const send = useEvent((delivery?: MessageDelivery) => {
    const draft = store.text();
    if (runtimeChat && draft.trim() === "/undo") {
      store.setText("");
      openUndo();
      return;
    }
    // `/storage` opens Clean up worktrees for the Chat's computer instead of going to the agent.
    if (draft.trim() === `/${STORAGE_COMMAND}`) {
      store.setText("");
      const computer = computerOfKey(runtimeChat ?? "");
      openStorage(computer === LOCAL_COMPUTER ? null : computer);
      return;
    }
    onSend(delivery);
  });
  // Designs are read through the Chat's key; a shared Link Chat uses its Link-scoped key too.
  const artifactChat = runtimeChat;
  const compactionFeedback = useCompactionFeedback(
    messages.findLast((item) => compactionContext(item)),
    runtimeChat,
  );
  const history = chatHistory(messages);
  const artifactSteps = useMemo(() => (streamingSteps?.length ? [...history.steps, ...streamingSteps] : history.steps), [history.steps, streamingSteps]);
  const { userMessages, promptHistory } = history;

  const addQuotes = useEvent((added: readonly ComposerQuote[]) => {
    store.setQuotes([...store.quotes(), ...added]);
    focusPrompt(true);
  });
  // A quote taken from this Chat's tile while another tile had the composer arrives once this one has it.
  useQuoteInbox(runtimeChat, addQuotes);

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    void imageDraft.attachFiles(files).then((indices) => {
      if (!indices.length) return;
      store.setText(insertImageMentions(store.text(), indices).value);
    });
    event.currentTarget.querySelector<HTMLElement>("[data-prompt-editor]")?.focus();
  }

  return (
    <ReplyProviders
      mentionContext={mentionContext}
      chatId={artifactChat}
      steps={artifactSteps}
      userMessages={userMessages}
      onSend={onSendDesignMessage}
      agent={providerName(sessionProvider ?? selectedModel.provider)}
      followAgent
      subagents={subagents}
    >
      <div
        ref={root}
        onClickCapture={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
          const href = anchor?.getAttribute("href");
          if (href && onOpenPullRequestLink?.(href)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        className={`relative flex h-full min-h-0 w-full flex-col overflow-visible bg-transparent ${isNewChat ? "isolate justify-center" : ""}`}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleFileDrop}
      >
        {/* The top edge under the window-drag strip and the Chat's title: solid under the bar, then the messages fade in. */}
        {!isNewChat && (
          <div
            ref={topBandRef}
            aria-hidden
            className="chat-top-blur pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(var(--window-chrome-height)+32px)]"
          >
            <div />
          </div>
        )}
        {isNewChat && !offScreen && <WelcomeSky />}
        {/* The room above the heading: a third of what's free with the stats under the composer, half without them. It
        doesn't depend on whether the cards have loaded, so they never move the composer. */}
        {projectNewChat && !offScreen && <div aria-hidden className="min-h-0 flex-1 basis-0" />}
        {!isNewChat && findOpen && onFindClose && <FindBar rootRef={root} focusSignal={findSignal} seed={findSeed} onClose={onFindClose} />}
        {projectNewChat && (
          <div
            className={[
              "chat-gutter relative mx-auto flex w-full max-w-[var(--chat-width)] shrink-0 flex-col items-center px-3 pb-6",
              headingLayer(headingOpen),
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}
          >
            <NewChatHeading
              projectKey={newChatProjectKey}
              projectName={newChatProjectName}
              projectKind={newChatProject?.kind}
              groups={projectGroups}
              noProject={noProjectGroup}
              onProjectChange={newChatChange ? moveDraft : undefined}
              onLinkPick={newChatProject?.onLinkPick}
              onOpenChange={setHeadingOpen}
            />
          </div>
        )}
        {/* One per composer, outside the transcript slots: a parked slot stays mounted, and a copy in each would quote
        the same selection once per slot. */}
        {!isNewChat && <MessageSelection container={root} provider={sessionProvider ?? selectedModel.provider} onQuote={(quote) => addQuotes([quote])} />}
        <TranscriptSlots
          activeKey={transcriptKey}
          view={scrollKey}
          messageCount={messages.length}
          element={
            isNewChat ? null : messages.length === 0 && !loadError ? (
              // The splash mark, as on the phone; it waits a beat so a transcript that is already near doesn't flash it.
              <div className="chat-loading relative flex min-h-0 flex-1 items-center justify-center" role="status" aria-label="Loading Chat">
                <LoadingMark size={48} />
              </div>
            ) : messages.length === 0 ? (
              <div className="relative flex min-h-0 flex-1 items-center justify-center px-6">
                <InlineError
                  variant="card"
                  className="w-full max-w-md"
                  action={
                    onRetryLoad && (
                      <Button variant="secondary" size={28} onClick={onRetryLoad}>
                        Try again
                      </Button>
                    )
                  }
                >
                  Could not load this Chat: {loadError}
                </InlineError>
              </div>
            ) : (
              <div className="relative flex min-h-0 flex-1 flex-col">
                <MessageScroller
                  navigation="rail"
                  followOutput
                  smooth
                  busy={isSending}
                  className="min-h-0 flex-1"
                  // The find bar floats over the top of the chat, so the first message moves below it while it is open.
                  // The chip row and composer float over the transcript (the composer dock), which scrolls on under their
                  // glass; the bottom pad is the dock's height plus 16, so the last line rests clear of them.
                  // The first message starts where the top fade ends (bar + 32px), fully readable at the top.
                  // At the window's bottom edge (one Chat alone) the text fades out over its last 24px instead of being cut.
                  viewportClassName={`${findOpen ? "pt-12" : "pt-7"} pb-[calc(var(--composer-dock,0px)+16px)] chat-edge-fade`}
                  contentClassName="min-h-full"
                  // Streamed text isn't in the key: the scroller follows the content's growth itself, once per layout.
                  autoScrollKey={`${messages.length}-${isSending}-${streamingSteps?.length ?? 0}`}
                  onAtEndChange={setTranscriptAtEnd}
                  onJumpToBottomChange={(jump) =>
                    setJumpToBottom((current) => (jump ? { key: transcriptKey, jump } : current?.key === transcriptKey ? null : current))
                  }
                >
                  <div
                    data-chat-width={chatWidth}
                    className="chat-column mx-auto flex min-h-full w-full max-w-[var(--chat-width)] flex-col gap-3 px-3 pt-12 pb-4"
                  >
                    {/* Reply links to this Chat's loopback-only servers stay localhost (Markdown.tsx). */}
                    <LoopbackPortsContext.Provider value={loopbackPorts}>
                      <StepDetailsScope scope={messageScope}>
                        <TranscriptContexts mentions={mentionContext} stepApproval={stepApproval}>
                          <MessageTranscript
                            findOpen={findOpen}
                            earlier={earlier}
                            trimHistory={trimHistory}
                            messages={messages}
                            pendingMessageId={pendingMessageId}
                            isSending={isSending}
                            streamingKey={streamingKey}
                            streamingText={streamingText}
                            streamingSteps={streamingSteps}
                            asking={asking}
                            undoable={undoable}
                            undoBlocked={isSending || Boolean(offlineName)}
                            onUndo={runtimeChat && !readOnlyHistory ? undoTask : undefined}
                            highlightId={highlightId}
                            onCheckpointPreview={runtimeChat && !readOnlyHistory ? previewRecovery : undefined}
                            waitingStepIds={waitingStepIds}
                            onRecommendationSelect={onRecommendationSelect}
                            onUpdateCli={onUpdateCli}
                            updatingCli={updatingCli}
                            cliStatus={cliStatus}
                            onOpenLinkedChat={onOpenLinkedChat}
                            onOpenAccounts={onOpenAccounts}
                            limitPending={limitPending}
                            limitSourceMessageId={limitSourceMessageId}
                            limitResumeBlocked={limitResumeBlocked}
                            offlineName={offlineName}
                            models={models}
                          />
                        </TranscriptContexts>
                      </StepDetailsScope>
                    </LoopbackPortsContext.Provider>

                    {/* A question or approval card follows the last item, so no empty stretch opens above a docked card. */}
                    {approval && (
                      <div data-slot="transcript-card" className={`w-full ${approvalHidden ? "hidden" : ""}`}>
                        {approval}
                      </div>
                    )}
                    {/* While a tool row waits on its approval, or a question waits on its answer, that row or card already shows
                        the time and the agent is blocked on the user: no running timer under it. */}
                    {isSending && !stepApproval && !asking && (
                      <div className="w-full" style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}>
                        <ThinkingIndicator
                          startedAt={runStartedAt}
                          label={phase ?? (waitingForSubagents ? "Waiting on subagents" : `Working with ${workingModelName}`)}
                          showLabel={Boolean(phase)}
                        />
                      </div>
                    )}
                    <BackgroundWork
                      key={runtimeChat}
                      items={backgroundItems({ provider: sessionProvider ?? selectedModel.provider, subagents, backgroundTasks }, ports)}
                      chatKey={runtimeChat}
                      showIndicator={!isSending && activity?.activity === "background"}
                      mark={<ChatMarkDotInline mark="background" failed={false} background={activity?.background ?? 0} />}
                    />
                    {runtimeChat && !isSending && <NextCheck chatKey={runtimeChat} />}
                    {resume && !isSending && (
                      <div data-resume-bar className="flex w-full items-center gap-3 rounded-control border border-line px-3 py-2 text-12 text-ink-2">
                        <span className="min-w-0 flex-1">Milagre closed while this Chat was working.</span>
                        <Button size={24} onClick={resume.onContinue} disabled={sendBlocked}>
                          Continue
                        </Button>
                      </div>
                    )}
                  </div>
                </MessageScroller>
              </div>
            )
          }
        />
        {/* An open Chat's chip row and composer float over the transcript's bottom, which scrolls on under their glass;
        the transcript's bottom pad is the dock's height (--composer-dock). A new Chat keeps them in the column's flow. */}
        <div
          ref={dockRef}
          data-composer-dock
          data-at-end={(!isNewChat && transcriptAtEnd) || undefined}
          className={isNewChat ? "contents" : "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col pb-[var(--chat-edge-pad,0px)]"}
        >
          <div
            data-chat-width={chatWidth}
            // While a composer popover (model, permissions, + or a menu) is open over it, the row steps aside instead of peeking out.
            className={`chat-gutter mx-auto flex w-full max-w-[var(--chat-width)] shrink-0 items-center justify-end gap-2 px-3 transition-[opacity,visibility] duration-fast empty:hidden [&:has(+[data-composer-wrap]_[data-picker-panel])]:invisible [&:has(+[data-composer-wrap]_[data-picker-panel])]:opacity-0 ${isNewChat ? "mb-2" : "pointer-events-none relative z-20 mb-3 has-[[data-expanded]]:z-[70] [&>*]:pointer-events-auto"}`}
          >
            {/* The PR fix sits at the left of the composer's chip row; the chat's ports, to-dos and subagents at the right.
          Each pill is frosted glass; the LayoutGroup slides the others over when one comes or goes. */}
            <LayoutGroup>
              <AnimatePresence initial={false}>
                {!isNewChat && pullRequestAction && (
                  <PillSlot key="pr-action" slot="pr-action" className={reviewPill ? "flex" : "mr-auto flex"}>
                    <StatusPill
                      onClick={pullRequestAction.onRun}
                      disabled={sendBlocked || isSending || imageDraft.loading}
                      icon={pullRequestAction.tone === "green" ? GitMergeIcon : GitPullRequestIcon}
                      label={pullRequestAction.label}
                      tone={pullRequestAction.tone}
                      className="font-medium"
                    />
                  </PillSlot>
                )}
                {reviewPill && (
                  <PillSlot key="pr-review" slot="pr-review" className="mr-auto flex">
                    {/* Neutral: orange is for what needs you now; the label says what the count is. */}
                    <StatusPill
                      data-review-pill
                      onClick={reviewPill.onOpen}
                      leading={
                        <>
                          <Icon icon={BubbleChatIcon} size={12} />
                          <span className="font-medium text-ink tabular-nums">{reviewPill.count}</span>
                        </>
                      }
                      label={reviewPill.count === 1 ? "review comment" : "review comments"}
                      tone="ink"
                    />
                  </PillSlot>
                )}
              </AnimatePresence>
              <PortTrack
                key={`ports-${messages[0]?.session_id ?? "new"}`}
                ports={ports}
                onStop={onStopPort}
                onOpen={browserChat ? (url) => openBrowserTab(browserChat, url) : undefined}
              />
              <TaskTrack key={`tasks-${messages[0]?.session_id ?? "new"}`} plan={plan} />
              {!isNewChat && runtimeChat && <SimulatorTrack key={`simulator-${runtimeChat}`} chatId={runtimeChat} />}
              {browserShown && (
                <BrowserPanel
                  key={`browser-panel-${browserShown}`}
                  chatKey={browserShown}
                  viewerChatId={agentChatId}
                  ports={ports ?? []}
                  onSendComments={onSendPageComments}
                />
              )}
              <SubagentTrack
                key={chatId}
                chatKey={runtimeChat}
                agents={subagents}
                provider={sessionProvider ?? selectedModel.provider}
                onArchiveFinished={onArchiveFinishedSubagents}
                onArchive={onArchiveSubagent}
                onStop={onStopAdvisor}
                onRetry={onRetryAdvisor}
              />
              {/* Keyed by Chat: switching drops the old button at once instead of playing its exit over the new Chat. */}
              <AnimatePresence key={`jump-${transcriptKey}`} initial={false}>
                {!isNewChat && jumpToBottom?.key === transcriptKey && (
                  <PillSlot key="jump-to-bottom" slot="jump-to-bottom" className="flex">
                    <Tooltip label="Go to bottom" asChild>
                      <button
                        type="button"
                        aria-label="Go to bottom"
                        data-jump-to-bottom
                        onClick={jumpToBottom.jump}
                        className="status-pill flex size-7 items-center justify-center rounded-full text-ink-2 transition-[color,scale] hover:text-ink active:scale-press"
                      >
                        <Icon icon={ArrowDown01Icon} size={14} />
                      </button>
                    </Tooltip>
                  </PillSlot>
                )}
              </AnimatePresence>
            </LayoutGroup>
          </div>

          <div
            data-chat-width={chatWidth}
            data-composer-wrap
            className={`chat-gutter relative mx-auto w-full max-w-[var(--chat-width)] shrink-0 p-1.5 ${isNewChat ? "" : "pointer-events-auto z-20 -mt-1.5"}`}
          >
            {/* The update pill floats centred on the chip row's line, outside its flow. */}
            <UpdatePillSlot className={`bottom-full ${isNewChat ? "mb-2" : "mb-1.5"}`} />
            {isNewChat && starters && starters.length > 0 && <FirstChatStarters starters={starters} />}
            {saveNotice}
            {notice && <Notice onDismiss={onDismissNotice}>{notice}</Notice>}
            {/* A new Chat's tray holds where it runs (computer, isolation, branch) and the composer as one piece. */}
            <div
              data-composer-tray={projectNewChat || undefined}
              data-offline-composer={(!projectNewChat && offlineTray) || undefined}
              className={
                projectNewChat || offlineTray ? `rounded-window border bg-inset p-1.5 pt-1 ${projectNewChat ? "border-line" : "border-line-strong"}` : ""
              }
            >
              {projectNewChat && (
                <NewChatHeader
                  worktrees={worktrees}
                  selectedWorktreeId={selectedWorktreeId}
                  onWorktreeChange={onWorktreeChange}
                  isolation={isolation}
                  onIsolationChange={onIsolationChange}
                  branches={branches}
                  baseBranch={baseBranch}
                  onBaseBranchChange={onBaseBranchChange}
                  linearActive={linearActive}
                  onStartFromIssue={onStartFromIssue}
                  noGit={noGit}
                  chats={chatsDraft}
                  copies={projectCopies}
                  currentKey={newChatProjectKey}
                  onComputerChange={changeComputer}
                />
              )}
              {linkNewChat && (
                <NewChatHeader
                  link
                  worktrees={NO_WORKTREES}
                  onWorktreeChange={() => {}}
                  isolation="worktree"
                  onIsolationChange={() => {}}
                  branches={NO_BRANCHES}
                  baseBranch=""
                  onBaseBranchChange={() => {}}
                  linearActive={linearActive}
                  onStartFromIssue={onStartFromIssue}
                />
              )}
              {offlineTray}
              {queue && !isNewChat && (
                <QueuedMessages
                  {...queue}
                  canSteer={queue.canSteer && compactionContext(messages.findLast((message) => compactionContext(message)))?.status !== "preparing"}
                  items={queue.held ? queue.items : queue.items.filter((item) => !compactionContext(item))}
                  disabled={sendBlocked}
                />
              )}
              {/* In a short grid tile (a size container) the cards scroll instead of pushing their buttons and the prompt out of it. */}
              {approval && (isNewChat || messages.length === 0) && (
                <ScrollArea className={`mb-2 max-h-[60cqh] w-full ${approvalHidden ? "hidden" : ""}`}>{approval}</ScrollArea>
              )}
              {review.view !== "closed" && !isNewChat && (
                <UndoPanel
                  readOnly={readOnlyHistory}
                  review={review}
                  intent={undoIntent}
                  onHighlight={setHighlightId}
                  onOpenFile={onOpenDiff}
                  onClosed={focusPrompt}
                />
              )}
              <div className={`${review.view === "preview" && !isNewChat ? "hidden" : ""}`}>
                <DraftPromptComposer
                  store={store}
                  offlineName={offlineName}
                  reconnectingName={reconnectingName}
                  imageDraft={imageDraft}
                  projectPath={projectPath}
                  skillScope={skillScope}
                  accountScope={messageScope ?? projectPath}
                  history={promptHistory}
                  onSend={send}
                  canUndo={Boolean(runtimeChat) && !readOnlyHistory}
                  onStop={onStop}
                  onCompact={onCompact}
                  compactionFeedback={compactionFeedback}
                  compacting={Boolean(compactionContext(messages.findLast((message) => compactionContext(message)))?.status === "preparing")}
                  compactQueued={Boolean(queue?.items.some((item) => Boolean(compactionContext(item))))}
                  onCancelCompact={() => {
                    const item = queue?.items.find((item) => Boolean(compactionContext(item)));
                    if (item) queue?.onRemove(item.id);
                  }}
                  sendBlocked={sendBlocked}
                  running={isSending}
                  runningProvider={sessionProvider}
                  suggestion={!approval && !asking && (!activity || activity.activity === "idle") ? suggestion : undefined}
                  models={models}
                  cliStatus={cliStatus}
                  onModelPickerOpen={onModelPickerOpen}
                  onUpdateCli={onUpdateCli}
                  updatingCli={updatingCli}
                  selectedModel={selectedModel}
                  onModelChange={onModelChange}
                  capability={capability}
                  effort={effort}
                  onEffortChange={onEffortChange}
                  ultracode={ultracode}
                  onUltracodeChange={onUltracodeChange}
                  fastMode={fastMode}
                  onFastModeChange={onFastModeChange}
                  permissionMode={permissionMode}
                  onPermissionModeChange={onPermissionModeChange}
                  contextUsage={contextUsage}
                  placeholder={chatsDraft && isNewChat ? newChatLook("chats").placeholder : undefined}
                />
              </div>
            </div>
            <InlineError size={12} className="mt-2 px-1">
              {newChatError}
            </InlineError>
            {readOnlyHistory && runtimeChat && (
              <Button
                variant="ghost"
                onClick={() => {
                  setUndoIntent("Undo");
                  void review.open();
                }}
              >
                View checkpoints
              </Button>
            )}
            {composerNote && (
              <p data-composer-note className="mt-1.5 px-2 text-12 text-ink-3">
                {composerNote}
              </p>
            )}
          </div>
        </div>
        {/* The Project's open PRs, plan usage and today's tokens, under a new Chat's composer. */}
        {/* The cards take the room under the composer (two thirds of what's free) and scroll in it when the window is short.
        The scrollbar's gutter is kept on both sides, just outside the column, so the cards keep the composer's edges. */}
        {projectNewChat && !offScreen && (
          <ScrollArea className={`-mx-2.5 w-[calc(100%+20px)] basis-0 [scrollbar-gutter:stable_both-edges] ${newChatGlance ? "flex-[2]" : "flex-1"}`}>
            {newChatGlance && <NewChatGlance projectKey={chatsDraft ? null : newChatProjectKey} scopeKey={messageScope ?? projectPath} chatWidth={chatWidth} />}
          </ScrollArea>
        )}
      </div>
    </ReplyProviders>
  );
}

const NO_CHECKPOINTS: CheckpointApi = {
  list: async () => [],
  preview: () => Promise.reject(new Error("Open a saved Chat to undo its changes")),
  restore: () => Promise.reject(new Error("Open a saved Chat to undo its changes")),
};
// Each Chat's checkpoints as last listed, for the most recently shown Chats: a Chat shown again marks its undoable
// messages from them while the list is read again.
const lastCheckpoints = new Map<string, Checkpoint[]>();
const KEPT_CHECKPOINT_LISTS = 32;
function keptCheckpoints(api: CheckpointApi): CheckpointApi {
  return {
    list: (request) =>
      api.list(request).then((items) => {
        lastCheckpoints.delete(request.chatId);
        lastCheckpoints.set(request.chatId, items);
        for (const oldest of lastCheckpoints.keys()) {
          if (lastCheckpoints.size <= KEPT_CHECKPOINT_LISTS) break;
          lastCheckpoints.delete(oldest);
        }
        return items;
      }),
    preview: (request) => api.preview(request),
    restore: (request) => api.restore(request),
  };
}
