import { providerName } from "@milagre/shared/providers";
import { SubagentTrack } from "./agents/SubagentTrack";
import { UpdatePillSlot } from "./UpdateNotice";
import { BrowserTrack } from "./agents/BrowserTrack";
import { SimulatorTrack } from "./agents/SimulatorTrack";
import { ArtifactCards, ArtifactsProvider, DesignFeedbackCard } from "./agents/ArtifactCard";
import { GenerativeUIProvider } from "./genui/GenerativeUI";
import { AnswerCard } from "./agents/AnswerCard";
import { PullRequestActionCard } from "./agents/PullRequestActionCard";
import { LinearIssueCard } from "./agents/LinearIssueCard";
import { UsageLimitCard } from "./agents/UsageLimitCard";
import { isAccountSwitch, usageLimitOf } from "@milagre/shared/usage-limit";
import { isPullRequestAction } from "@milagre/shared/pr-action";
import { isLinearIssueContext } from "@milagre/shared/linear-issue";
import { parseDesignFeedback } from "@milagre/shared/artifact";
import { SubagentCanvas } from "./agents/SubagentCanvas";
import { useEvent } from "../lib/stable";
import type { AgentPort, ChatPlan, ContextUsage, Subagent } from "../model";
import { PortTrack } from "./agents/PortTrack";
import { TaskTrack } from "./agents/TaskTrack";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, DragEvent, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, GitBranchIcon, GitForkIcon, GitPullRequestIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { LinearLogo } from "./ProviderLogo";
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
import { Attachments } from "./Attachments";
import type { ImageDraft } from "./usePastedImages";
import { PromptComposer } from "./PromptComposer";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { LinearIssuePicker } from "./LinearIssuePicker";
import Tooltip from "./primitives/Tooltip";
import { PillSlot, StatusPill } from "./primitives/StatusPill";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { HandoffDivider } from "./Handover";
import { WorktreeLinkDivider } from "./WorktreeLinkDivider";
import { AccountSwitchDivider } from "./AccountSwitchDivider";
import { CompactionDivider } from "./CompactionDivider";
import { advisorResultLabel, messageSender } from "@milagre/shared/advisor-result";
import { LinkedMessageHeader, linkedContext } from "./LinkedMessage";
import { isHandoff } from "@milagre/shared/handoff";
import { isCompaction } from "@milagre/shared/compaction";
import { isWorktreeLinked } from "@milagre/shared/worktree-link";
import { MessageScroller } from "./agents/message-scroller";
import { RecommendationCard } from "./agents/recommendation-card";
import { parseRecommendation } from "../lib/recommendation";
import { StepRow } from "./agents/StepRow";
import { StepDetailsMessage, StepDetailsScope } from "./agents/step-details";
import { ActivityBlock } from "./agents/ActivityBlock";
import { GeneratedImage } from "./agents/GeneratedImage";
import { Markdown, StreamingMarkdown } from "./markdown/Markdown";
import { replyActivity, unspokenThought } from "../lib/reply-parts";
import { extractOutdatedProvider } from "../lib/cli-status";
import { splitFences } from "../lib/message-fences";
import { CodeBlock } from "./markdown/CodeBlock";
import { useDismiss } from "../lib/use-dismiss";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 16 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

/**
 * A reply: its activity (thinking, tool steps and the text between them) folded into one block, the images it generated, then its answer.
 * A reply with no answer that ended or stopped to ask shows its last thinking instead, dimmed.
 */
/** What the user typed, as typed; only closed ``` fences render as code (diff comments send their snippets in them). */
function UserBody({ body }: { body: string }) {
  const parts = useMemo(() => splitFences(body), [body]);
  return (
    <div className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <div key={index} className="whitespace-normal">
            <CodeBlock code={part.code} fence={part.fence || undefined} diff />
          </div>
        ),
      )}
    </div>
  );
}

function ReplyContent({
  body,
  steps,
  streaming,
  asking = false,
  waitingStepIds,
}: {
  body: string;
  steps: ChatStep[];
  streaming: boolean;
  asking?: boolean;
  waitingStepIds: string[];
}) {
  const { setup, activity, images, artifacts, answer } = replyActivity(body, steps);
  const thought = !streaming || asking ? unspokenThought(body, steps) : "";
  return (
    <>
      {setup.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      <ActivityBlock entries={activity} streaming={streaming} waitingStepIds={waitingStepIds} />
      {images.map((step) => (
        <GeneratedImage key={step.id} step={step} />
      ))}
      <ArtifactCards steps={artifacts} />
      {answer.trim() && <div data-slot="message-content">{streaming ? <StreamingMarkdown text={answer} /> : <Markdown text={answer} />}</div>}
      {thought && (
        <div data-slot="message-thought" className="text-ink-2">
          <Markdown text={thought} />
        </div>
      )}
    </>
  );
}

const MessageSection = memo(function MessageSection({
  message,
  isUser,
  onRecommendationSelect,
  onUpdateCli,
  updatingCli,
  cliStatus,
  streaming = false,
  asking = false,
  waitingStepIds = [],
  animate = false,
  onOpenChat,
  limitInteractive = false,
  onOpenAccounts,
  models,
}: {
  message: AppChatMessage;
  isUser: boolean;
  models: ModelOption[];
  onRecommendationSelect: (option: string) => void;
  onUpdateCli?: (provider: ModelProvider) => void;
  updatingCli?: ModelProvider | null;
  cliStatus?: AgentCliStatus | null;
  streaming?: boolean;
  /** The running turn is waiting on the user's answer to a question. */
  asking?: boolean;
  /** Steps whose approval card is open. */
  waitingStepIds?: string[];
  /** Fade in on arrival; messages already there when the chat opened skip it, so a long chat doesn't animate all at once. */
  animate?: boolean;
  /** Opens another Chat by key, from a message it sent across a Link. */
  onOpenChat?: (chatKey: string) => void;
  /** The usage-limit card may offer account switches: this is the Chat's last message and no turn runs. */
  limitInteractive?: boolean;
  /** Opens Settings > Accounts, from the limit card. */
  onOpenAccounts?: () => void;
}) {
  if (isHandoff(message)) return <HandoffDivider context={message.context} models={models} />;
  if (isWorktreeLinked(message)) return <WorktreeLinkDivider context={message.context} />;
  if (isCompaction(message)) return <CompactionDivider context={message.context} />;
  if (isAccountSwitch(message)) return <AccountSwitchDivider context={message.context} />;
  const linked = linkedContext(message);
  const advisor = typeof message.context === "object" && message.context?.kind === "advisor-result" ? message.context : null;
  // A PR-blocker pill's message shows as a card, not as the skill prompt the agent read.
  const prAction = isUser && isPullRequestAction(message.context) ? message.context : null;
  // So does a Chat's first message when it was started from a Linear issue.
  const issue = isUser && isLinearIssueContext(message.context) ? message.context : null;
  // A message another Chat sent sits apart from the user's own: left-aligned, with its sender over it.
  // Feedback sent from the design canvas shows as a card, not as the text the agent reads.
  const feedback = isUser && !linked && !advisor && !prAction && !issue ? parseDesignFeedback(message.body) : null;
  // So do the answers to the agent's questions.
  const answered = isUser && !linked && !advisor && !feedback && message.answered?.length ? message.answered : null;
  const bubble = isUser && !linked && !advisor && !feedback && !answered && !prAction && !issue;
  const recommendation = !isUser && !streaming ? parseRecommendation(message.body) : null;
  const outdatedProvider = !isUser && !streaming ? extractOutdatedProvider(message.body) : null;
  const isCurrentlyOutdated = outdatedProvider ? (cliStatus ? cliStatus[outdatedProvider]?.state === "outdated" : true) : false;
  const showUpdateButton = Boolean(outdatedProvider && onUpdateCli && (isCurrentlyOutdated || updatingCli === outdatedProvider));
  const limit = !isUser && !streaming ? usageLimitOf(message) : null;
  const steps = message.steps ?? [];
  return (
    <article
      id={`message-${message.id}`}
      data-slot="message"
      data-from={messageSender(message)}
      data-linked={linked?.kind}
      data-streaming={streaming || undefined}
      className={`flex min-w-0 w-full flex-col gap-1.5 transition-[opacity,transform] duration-300 ${bubble || feedback || answered || prAction || issue ? "items-end pl-12" : ""}`}
      style={animate ? { animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" } : undefined}
    >
      {advisor && (
        <p data-advisor-result className="text-[11px] text-ink-3">
          {advisorResultLabel(advisor)}
        </p>
      )}
      {linked && <LinkedMessageHeader context={linked} onOpenChat={onOpenChat} />}
      <div
        className={`min-w-0 max-w-full text-[13px] leading-[1.55] text-ink ${bubble ? "rounded-xl bg-field px-3 py-1.5" : feedback || answered || prAction || issue ? "w-full max-w-md" : isUser ? "rounded-xl border border-line px-3 py-2" : ""}`}
      >
        <Attachments images={isUser ? message.images : message.images?.filter((image) => !image.sourcePath)} files={message.files} />
        {prAction ? (
          <PullRequestActionCard action={prAction} />
        ) : issue ? (
          <LinearIssueCard issue={issue} />
        ) : feedback ? (
          <DesignFeedbackCard feedback={feedback} messageId={message.id} />
        ) : answered ? (
          <AnswerCard answered={answered} />
        ) : isUser ? (
          message.body.trim() ? (
            <UserBody body={message.body} />
          ) : null
        ) : recommendation ? (
          <>
            <StepDetailsMessage id={message.id}>
              <ReplyContent body={recommendation.intro} steps={steps} streaming={false} waitingStepIds={waitingStepIds} />
            </StepDetailsMessage>
            <div className={recommendation.intro ? "mt-2" : undefined}>
              <RecommendationCard
                question={recommendation.question}
                options={recommendation.options}
                onSelect={(option) => onRecommendationSelect(option.label)}
              />
            </div>
          </>
        ) : (
          <StepDetailsMessage id={message.id}>
            <ReplyContent body={message.body} steps={steps} streaming={streaming} asking={asking} waitingStepIds={waitingStepIds} />
          </StepDetailsMessage>
        )}
        {limit && <UsageLimitCard limit={limit} sessionId={message.session_id} interactive={limitInteractive} onOpenAccounts={onOpenAccounts} />}
        {showUpdateButton && outdatedProvider && onUpdateCli && (
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              disabled={updatingCli === outdatedProvider}
              onClick={() => onUpdateCli(outdatedProvider)}
              className="flex items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-xs transition-colors hover:bg-hover active:scale-[0.98] disabled:opacity-50"
            >
              {updatingCli === outdatedProvider ? (
                <>
                  <span className="size-3 animate-spin rounded-full border-2 border-ink border-t-transparent" />
                  <span>Updating {providerName(outdatedProvider)}…</span>
                </>
              ) : (
                <span>Update {providerName(outdatedProvider)} now</span>
              )}
            </button>
          </div>
        )}
      </div>
    </article>
  );
});

// Background turns and draft edits must not rebuild a long, unchanged transcript.
const MessageTranscript = memo(function MessageTranscript({
  messages,
  pendingMessageId,
  isSending,
  streamingText,
  streamingSteps,
  asking,
  waitingStepIds,
  onRecommendationSelect,
  onUpdateCli,
  updatingCli,
  cliStatus,
  onOpenLinkedChat,
  onOpenAccounts,
  offlineName,
  findOpen,
  models,
  earlier,
}: Pick<
  ChatComposerProps,
  | "earlier"
  | "messages"
  | "pendingMessageId"
  | "isSending"
  | "streamingText"
  | "streamingSteps"
  | "asking"
  | "waitingStepIds"
  | "onRecommendationSelect"
  | "onUpdateCli"
  | "updatingCli"
  | "cliStatus"
  | "onOpenLinkedChat"
  | "onOpenAccounts"
  | "offlineName"
  | "findOpen"
  | "models"
>) {
  const chatId = messages[0]?.session_id ?? "new";
  // The messages a chat opens with don't animate in; later ones do. A new chat's first message counts as later.
  const openingMessages = useRef<{ chat: number | string; ids: Set<number> } | null>(null);
  if (!openingMessages.current) openingMessages.current = { chat: chatId, ids: new Set(messages.map((message) => message.id)) };
  if (openingMessages.current.chat !== chatId) {
    openingMessages.current = { chat: chatId, ids: openingMessages.current.chat === "new" ? new Set() : new Set(messages.map((message) => message.id)) };
  }
  // Keep the same recent-history page size as mobile. New messages extend the page without dropping its first row.
  const [page, setPage] = useState(() => ({ chat: chatId, firstId: messages[Math.max(0, messages.length - 40)]?.id }));
  let firstId = page.chat === chatId ? page.firstId : messages[Math.max(0, messages.length - 40)]?.id;
  if (findOpen) firstId = messages[0]?.id;
  if (page.chat !== chatId || page.firstId !== firstId) setPage({ chat: chatId, firstId });
  const start = Math.max(
    0,
    messages.findIndex((message) => message.id === firstId),
  );
  const earlierButton = useRef<HTMLButtonElement>(null);
  const historyRead = useRef(false);
  const historyChat = useRef(chatId);
  const anchor = useRef<{ element: HTMLElement; top: number; viewport: HTMLElement } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    historyChat.current = chatId;
    historyRead.current = false;
    setHistoryError(null);
    setHistoryLoading(false);
    anchor.current = null;
  }, [chatId]);
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    anchor.current = null;
    let frame = 0;
    let remaining = 3;
    const restore = () => {
      if (!saved.element.isConnected) return;
      saved.viewport.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
      // content-visibility replaces estimated heights as the newly exposed rows enter the viewport.
      if (remaining-- > 0) frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [page]);
  // Messages the host still holds before the ones here (chat-pages-v1); find in chat reads them all.
  const remote = earlier?.count ?? 0;
  useEffect(() => {
    if (findOpen && remote > 0) void earlier?.loadAll();
  }, [findOpen, remote, earlier]);
  async function showEarlier() {
    if (historyRead.current || start + remote <= 0) return;
    historyRead.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    const column = earlierButton.current?.parentElement;
    const element = column?.querySelector<HTMLElement>('[data-slot="message"]');
    const viewport = column?.closest<HTMLElement>('[aria-label="Conversation"]');
    if (element && viewport) anchor.current = { element, viewport, top: element.getBoundingClientRect().top };
    try {
      if (start > 0 || !earlier) {
        setPage({ chat: chatId, firstId: messages[Math.max(0, start - 40)]?.id });
        return;
      }
      await earlier.load();
      if (historyChat.current === chatId) setPage({ chat: chatId, firstId: Number.NEGATIVE_INFINITY });
    } catch (error) {
      anchor.current = null;
      if (historyChat.current === chatId) setHistoryError((error as Error).message);
    } finally {
      if (historyChat.current === chatId) {
        historyRead.current = false;
        setHistoryLoading(false);
      }
    }
  }
  const loadOnScroll = useEvent(() => {
    if (!historyError) void showEarlier();
  });
  useEffect(() => {
    const viewport = earlierButton.current?.closest<HTMLElement>('[aria-label="Conversation"]');
    if (!viewport || start + remote <= 0 || findOpen) return;
    let previous = viewport.scrollTop;
    const onScroll = () => {
      const y = viewport.scrollTop;
      if (y < previous && y <= 160) loadOnScroll();
      previous = y;
    };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [chatId, start, remote, findOpen, loadOnScroll]);
  const streamingMessage: AppChatMessage | undefined =
    isSending && (streamingText || streamingSteps?.length)
      ? { id: -1, session_id: messages.at(-1)?.session_id ?? -1, body: streamingText ?? "", context: null, role: "assistant", steps: streamingSteps }
      : undefined;
  const transcript = messages.slice(start);
  if (streamingMessage) {
    const pendingIndex = transcript.findIndex((message) => message.id === pendingMessageId);
    transcript.splice(pendingIndex < 0 ? transcript.length : pendingIndex, 0, streamingMessage);
  }

  const openingIds = openingMessages.current.ids;
  // Only the Chat's last message, once its turn is over, can still switch accounts.
  const limitMessageId = isSending || offlineName ? undefined : messages.at(-1)?.id;
  return (
    <>
      {historyError && (
        <p role="alert" className="text-xs text-ink-2">
          Could not load earlier messages: {historyError}. Use Show earlier messages to retry.
        </p>
      )}
      {start + remote > 0 && (
        <button
          ref={earlierButton}
          type="button"
          onClick={() => void showEarlier()}
          disabled={historyLoading}
          className="self-center rounded-control border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-hover"
        >
          {historyLoading ? "Loading earlier messages..." : `Show earlier messages (${start + remote})`}
        </button>
      )}
      {transcript.map((message) => (
        <MessageSection
          key={message.clientMessageId ?? message.id}
          message={message}
          isUser={message.role === "user"}
          onRecommendationSelect={onRecommendationSelect}
          onUpdateCli={onUpdateCli}
          updatingCli={updatingCli}
          cliStatus={cliStatus}
          streaming={message === streamingMessage}
          asking={message === streamingMessage && asking}
          waitingStepIds={message === streamingMessage ? waitingStepIds : undefined}
          animate={!message.clientMessageId && !openingIds.has(message.id)}
          onOpenChat={onOpenLinkedChat}
          limitInteractive={message.id === limitMessageId}
          onOpenAccounts={onOpenAccounts}
          models={models}
        />
      ))}
    </>
  );
});

interface ChatComposerProps {
  /** The chat's computer is away: the composer is disabled and says so. */
  offlineName?: string | null;
  /** Sends a comment on a design, or the design the user chose, to the agent; resolves whether it went. */
  onSendDesignMessage?: (text: string) => Promise<boolean>;
  scopeKind?: "project" | "link";
  /** The find bar over the message list; the parent owns it so ⌘F and the command palette can open it. */
  findOpen?: boolean;
  findSignal?: number;
  /** Text the find bar fills in when `findSignal` changes, e.g. the words a ⌘K message result matched. */
  findSeed?: string;
  onFindClose?: () => void;
  imageDraft: ImageDraft;
  projectPath: string;
  /** Messages of the Chat the host holds before `messages` (chat-pages-v1): how many, and reading them. */
  earlier?: { count: number; load: () => Promise<void>; loadAll: () => Promise<void> };
  /** The Project or Link (scope key) the messages belong to, for step output the host keeps out of the state. */
  messageScope?: string;
  /** The open conversation keeps its scroll view when a draft gets its saved Chat id. */
  scrollKey?: number | string;
  messages: AppChatMessage[];
  /** Unsaved input appears below the reply still streaming while the backend prepares the send. */
  pendingMessageId?: number;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** Sends `/compact` to the chat (Claude only); the context card offers it as Compact now. */
  onCompact?: () => void;
  /** One-click fix for whatever blocks the chat's PR from merging (conflicts, an outdated branch, requested changes). */
  pullRequestAction?: { label: string; tone: "red" | "orange"; onRun: () => void };
  isSending: boolean;
  /** Sending is briefly blocked while a message is being prepared; a running turn doesn't block it. */
  sendBlocked: boolean;
  streamingText?: string;
  /** The running turn's tool steps, where they happened in `streamingText`. */
  streamingSteps?: ChatStep[];
  subagents?: Subagent[];
  onArchiveFinishedSubagents?: () => void;
  onArchiveSubagent?: (id: string, archived: boolean) => void;
  onStopAdvisor?: (id: string) => void;
  onRetryAdvisor?: (id: string) => void;
  waitingForSubagents?: boolean;
  /** The Chat's plan (tasks and phases), shown as a pill beside the subagents. */
  plan?: ChatPlan;
  /** How full the agent's context window is, shown as a ring beside Send. */
  contextUsage?: ContextUsage;
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
  /** Opens the Chat a Delegation, report or agreement came from, in whichever Project it is. */
  onOpenLinkedChat?: (chatKey: string) => void;
  /** Opens Settings > Accounts, from the usage-limit card when the Project has no other account to switch to. */
  onOpenAccounts?: () => void;
  /** A chat a quit stopped longer ago than Milagre resumes by itself: Continue starts its turn again. */
  resume?: { onContinue: () => void };
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
  notice?: string | null;
  onDismissNotice?: () => void;
}

const ISOLATIONS: Array<{ id: Isolation; name: string; description: string; icon: IconData }> = [
  { id: "local", name: "Local", description: "Work in the selected checkout", icon: LaptopIcon },
  { id: "worktree", name: "New worktree", description: "Start a new branch in its own worktree", icon: GitForkIcon },
];

function ChipButton({
  icon,
  leading,
  label,
  open,
  onClick,
}: {
  icon?: IconData;
  /** Drawn instead of `icon`, e.g. a brand mark. */
  leading?: ReactNode;
  label: string;
  open: boolean;
  onClick: (trigger: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={(event) => onClick(event.currentTarget)}
      className={`flex h-7 items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] font-medium transition-colors hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "text-ink-2"}`}
    >
      {leading ?? (icon && <Icon icon={icon} size={14} />)}
      {label}
      <span className="text-ink-3">
        <Icon icon={ArrowDown01Icon} size={12} />
      </span>
    </button>
  );
}

type NewChatHeaderProps = Pick<
  ChatComposerProps,
  | "worktrees"
  | "selectedWorktreeId"
  | "onWorktreeChange"
  | "isolation"
  | "onIsolationChange"
  | "branches"
  | "baseBranch"
  | "onBaseBranchChange"
  | "linearActive"
  | "onStartFromIssue"
>;

function NewChatHeader({
  worktrees,
  selectedWorktreeId,
  onWorktreeChange,
  isolation,
  onIsolationChange,
  branches,
  baseBranch,
  onBaseBranchChange,
  linearActive = false,
  onStartFromIssue,
}: NewChatHeaderProps) {
  const [menu, setMenu] = useState<"isolation" | "branch" | "issue" | null>(null);
  const [query, setQuery] = useState("");
  const [popover, setPopover] = useState({ left: 0, maxHeight: 480 });
  const selected = worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? worktrees[0];
  const isolationOption = ISOLATIONS.find((option) => option.id === isolation) ?? ISOLATIONS[0];
  const search = query.trim().toLowerCase();
  // Local runs in an existing checkout; a new worktree branches from any local branch.
  const branchRows =
    isolation === "local"
      ? worktrees
          .filter((worktree) => worktree.name.toLowerCase().includes(search))
          .map((worktree) => ({
            key: String(worktree.id),
            name: worktree.name,
            description: worktree.path.split("/").filter(Boolean).pop(),
            selected: worktree.id === selected?.id,
            choose: () => onWorktreeChange(worktree.id),
          }))
      : branches
          .filter((branch) => branch.toLowerCase().includes(search))
          .map((branch) => ({ key: branch, name: branch, description: undefined, selected: branch === baseBranch, choose: () => onBaseBranchChange(branch) }));

  const lastTrigger = useRef<HTMLElement | null>(null);
  function place(trigger: HTMLElement) {
    lastTrigger.current = trigger;
    const row = trigger.parentElement?.getBoundingClientRect();
    const button = trigger.getBoundingClientRect();
    setPopover({ left: button.left - (row?.left ?? button.left), maxHeight: window.innerHeight - button.bottom - 24 });
  }

  useDismiss(
    menu !== null,
    () => setMenu(null),
    (target) => !!target.closest("[data-picker-panel], [data-new-chat-pickers] button[aria-expanded]"),
    () => {
      if (lastTrigger.current) place(lastTrigger.current);
    },
  );

  function toggle(next: "isolation" | "branch" | "issue", trigger: HTMLElement) {
    place(trigger);
    setQuery("");
    setMenu((current) => (current === next ? null : next));
  }

  function close() {
    setMenu(null);
    setQuery("");
  }

  const popoverStyle = { left: popover.left, maxHeight: popover.maxHeight, transformOrigin: "top left" };

  return (
    // The entrance animation makes this a stacking context, so lift it above the composer while a popover is open.
    <div className={`px-1 ${menu ? "relative z-30" : ""}`} style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <h1 className="text-[17px] font-medium text-ink">New chat</h1>
      {selected && (
        <div data-new-chat-pickers className="relative mt-4 mb-2.5 -ml-1.5 flex items-center gap-1">
          <Tooltip label="Choose the isolation level">
            <ChipButton
              icon={isolationOption.icon}
              label={isolationOption.name}
              open={menu === "isolation"}
              onClick={(trigger) => toggle("isolation", trigger.parentElement ?? trigger)}
            />
          </Tooltip>
          <ChipButton
            icon={GitBranchIcon}
            label={isolation === "local" ? selected.name : baseBranch}
            open={menu === "branch"}
            onClick={(trigger) => toggle("branch", trigger)}
          />
          {linearActive && onStartFromIssue && (
            <ChipButton leading={<LinearLogo size={13} />} label="Linear issue" open={menu === "issue"} onClick={(trigger) => toggle("issue", trigger)} />
          )}
          {menu === "isolation" && (
            <PickerPanel title="Isolation" className="absolute top-[calc(100%+0.375rem)] w-[320px]" style={popoverStyle}>
              {ISOLATIONS.map((option) => (
                <PickerRow
                  key={option.id}
                  icon={<Icon icon={option.icon} size={14} />}
                  label={option.name}
                  description={option.description}
                  selected={option.id === isolation}
                  onClick={() => {
                    onIsolationChange(option.id);
                    close();
                  }}
                />
              ))}
            </PickerPanel>
          )}
          {menu === "issue" && (
            <LinearIssuePicker
              style={popoverStyle}
              onPick={(issue) => {
                onStartFromIssue?.(issue);
                close();
              }}
              onClose={close}
            />
          )}
          {menu === "branch" && (
            <PickerPanel
              title={isolation === "local" ? "Choose a worktree" : "Branch from"}
              query={query}
              onQueryChange={setQuery}
              placeholder={isolation === "local" ? "Search worktrees" : "Search branches"}
              searchPlacement="bottom"
              emptyLabel={isolation === "local" ? "No worktrees found." : "No branches found."}
              isEmpty={branchRows.length === 0}
              className="absolute top-[calc(100%+0.375rem)] w-[420px] max-w-[calc(100vw-2rem)]"
              style={popoverStyle}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }}
            >
              {branchRows.map((row) => (
                <PickerRow
                  key={row.key}
                  icon={<Icon icon={GitBranchIcon} size={14} />}
                  label={row.name}
                  description={row.description}
                  selected={row.selected}
                  wrapLabel
                  onClick={() => {
                    row.choose();
                    close();
                  }}
                />
              ))}
            </PickerPanel>
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY_SUBAGENTS: Subagent[] = [];

export function ChatComposer({
  offlineName,
  scopeKind,
  imageDraft,
  projectPath,
  messageScope,
  scrollKey,
  earlier,
  messages,
  pendingMessageId,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onCompact,
  pullRequestAction,
  isSending,
  sendBlocked,
  streamingText,
  streamingSteps,
  subagents = EMPTY_SUBAGENTS,
  onArchiveFinishedSubagents,
  onArchiveSubagent,
  onStopAdvisor,
  onRetryAdvisor,
  waitingForSubagents = false,
  plan,
  contextUsage,
  ports,
  agentChatId,
  onStopPort,
  waitingStepIds,
  asking = false,
  runModelName,
  sessionProvider,
  runStartedAt,
  onOpenLinkedChat,
  onOpenAccounts,
  resume,
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
  findOpen = false,
  findSignal = 0,
  findSeed,
  onFindClose,
  notice,
  onDismissNotice,
  onSendDesignMessage,
}: ChatComposerProps) {
  const root = useRef<HTMLDivElement>(null);
  const chatId = messages[0]?.session_id ?? "new";
  const [canvasChat, setCanvasChat] = useState<number | string | null>(null);
  const canvasOpened = canvasChat === chatId;
  const stopAdvisor = useEvent((id: string) => onStopAdvisor?.(id));
  const retryAdvisor = useEvent((id: string) => onRetryAdvisor?.(id));
  const closeCanvas = useCallback(() => {
    setCanvasChat(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[data-slot=subagent-track] > button")?.focus());
  }, []);
  // A first message, including its preview while setup runs, opens the conversation layout.
  const isNewChat = messages.length === 0;
  const workingModelName = runModelName ?? selectedModel.name;
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (isNewChat) setScrolled(false);
  }, [isNewChat]);

  // The runtime knows a Chat by its Project's path, not the Worktree's `projectPath` it runs in.
  const runtimeChat = typeof chatId === "number" && chatId > 0 && projectPath ? (agentChatId ?? `${messageScope ?? projectPath}#${chatId}`) : null;
  // Designs are read through the Chat's key; a shared Link Chat uses its Link-scoped key too.
  const artifactChat = runtimeChat;
  const artifactSteps = useMemo(() => [...messages.flatMap((message) => message.steps ?? []), ...(streamingSteps ?? [])], [messages, streamingSteps]);
  const userMessages = useMemo(() => messages.filter((message) => message.role === "user").map(({ id, body }) => ({ id, body })), [messages]);

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    void imageDraft.attachFiles(files);
    event.currentTarget.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.focus();
  }

  return (
    <ReplyProviders chatId={artifactChat} steps={artifactSteps} userMessages={userMessages} onSend={onSendDesignMessage}>
      <div
        ref={root}
        className={`relative flex h-full min-h-0 w-full flex-col overflow-visible bg-transparent ${isNewChat ? "justify-center" : ""}`}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleFileDrop}
      >
        <SubagentCanvas
          key={`canvas-${chatId}`}
          chatKey={runtimeChat}
          opened={canvasOpened}
          agents={subagents}
          working={isSending}
          waiting={waitingForSubagents}
          activity={streamingSteps?.filter((step) => step.status === "running").at(-1)?.title}
          onClose={closeCanvas}
          onStop={onStopAdvisor ? stopAdvisor : undefined}
          onRetry={onRetryAdvisor ? retryAdvisor : undefined}
        />
        <div className={canvasOpened ? "hidden" : "contents"} aria-hidden={canvasOpened || undefined}>
          {/* Messages scrolled past the top soften into a progressive blur under the window-drag strip. The layers fade,
          not the wrapper: a wrapper below full opacity would cut the layers' blur off from the messages behind it. */}
          {!isNewChat && (
            <div
              aria-hidden
              data-busy={isSending || undefined}
              className={`chat-top-blur progressive-blur pointer-events-none absolute inset-x-0 top-0 z-10 h-16 [&>*]:transition-opacity [&>*]:duration-200 ${scrolled ? "" : "[&>*]:opacity-0"}`}
            >
              <ProgressiveBlurLayers />
            </div>
          )}
          {!isNewChat && findOpen && onFindClose && <FindBar rootRef={root} focusSignal={findSignal} seed={findSeed} onClose={onFindClose} />}
          {!isNewChat && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <MessageScroller
                key={scrollKey ?? messages[0]?.session_id ?? "new"}
                navigation="rail"
                followOutput
                smooth
                busy={isSending}
                className="min-h-0 flex-1"
                // The find bar floats over the top of the chat, so the first message moves below it while it is open.
                // The chip row floats over the bottom blur, so the last message can scroll clear of it.
                viewportClassName={`${findOpen ? "pt-12" : "pt-4"} pb-10`}
                contentClassName="min-h-full"
                // Streamed text isn't in the key: the scroller follows the content's growth itself, once per layout.
                autoScrollKey={`${messages.length}-${isSending}-${streamingSteps?.length ?? 0}`}
                viewportProps={{ onScroll: (event) => setScrolled(event.currentTarget.scrollTop > 4) }}
              >
                <div className="chat-column mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-3 pt-12 pb-4">
                  <StepDetailsScope scope={messageScope}>
                    <MessageTranscript
                      findOpen={findOpen}
                      earlier={earlier}
                      messages={messages}
                      pendingMessageId={pendingMessageId}
                      isSending={isSending}
                      streamingText={streamingText}
                      streamingSteps={streamingSteps}
                      asking={asking}
                      waitingStepIds={waitingStepIds}
                      onRecommendationSelect={onRecommendationSelect}
                      onUpdateCli={onUpdateCli}
                      updatingCli={updatingCli}
                      cliStatus={cliStatus}
                      onOpenLinkedChat={onOpenLinkedChat}
                      onOpenAccounts={onOpenAccounts}
                      offlineName={offlineName}
                      models={models}
                    />
                  </StepDetailsScope>

                  {isSending && (
                    <div className="w-full" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
                      <ThinkingIndicator startedAt={runStartedAt} label={waitingForSubagents ? "Waiting on subagents" : `Working with ${workingModelName}`} />
                    </div>
                  )}
                  {resume && !isSending && (
                    <div data-resume-bar className="flex w-full items-center gap-3 rounded-control border border-line px-3 py-2 text-[12px] text-ink-2">
                      <span className="min-w-0 flex-1">Milagre closed while this chat was working.</span>
                      <button
                        type="button"
                        onClick={resume.onContinue}
                        disabled={sendBlocked}
                        className="shrink-0 rounded-control bg-ink px-2.5 py-1 font-medium text-surface transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40"
                      >
                        Continue
                      </button>
                    </div>
                  )}
                </div>
              </MessageScroller>
              {/* Messages passing under the chip row soften into a progressive blur that reaches the composer. */}
              <div
                aria-hidden
                data-busy={isSending || undefined}
                className="chat-bottom-blur progressive-blur pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20"
              >
                <ProgressiveBlurLayers />
              </div>
            </div>
          )}
          <div
            className={`mx-auto flex w-full max-w-3xl shrink-0 items-center justify-end gap-2 px-3 empty:hidden ${isNewChat ? "mb-2" : "pointer-events-none relative z-20 -mt-[38px] mb-3.5 [&>*]:pointer-events-auto"}`}
          >
            {/* The PR fix sits at the left of the composer's chip row; the chat's ports, to-dos and subagents at the right.
            Each pill is frosted glass; the LayoutGroup slides the others over when one comes or goes. */}
            <LayoutGroup>
              <AnimatePresence initial={false}>
                {!isNewChat && pullRequestAction && (
                  <PillSlot key="pr-action" slot="pr-action" className="mr-auto flex">
                    <StatusPill
                      onClick={pullRequestAction.onRun}
                      disabled={sendBlocked || isSending || imageDraft.loading}
                      icon={GitPullRequestIcon}
                      label={pullRequestAction.label}
                      tone={pullRequestAction.tone === "orange" ? "orange" : "red"}
                      className="font-medium"
                    />
                  </PillSlot>
                )}
              </AnimatePresence>
              <PortTrack key={`ports-${messages[0]?.session_id ?? "new"}`} ports={ports} onStop={onStopPort} />
              <TaskTrack key={`tasks-${messages[0]?.session_id ?? "new"}`} plan={plan} />
              <BrowserTrack key={`browser-${agentChatId ?? chatId}`} chatId={agentChatId} />
              {!isNewChat && runtimeChat && <SimulatorTrack key={`simulator-${runtimeChat}`} chatId={runtimeChat} />}
              <SubagentTrack
                key={chatId}
                chatKey={runtimeChat}
                agents={subagents}
                provider={sessionProvider ?? selectedModel.provider}
                onOpenCanvas={() => setCanvasChat(chatId)}
                onArchiveFinished={onArchiveFinishedSubagents}
                onArchive={onArchiveSubagent}
                onStop={onStopAdvisor}
                onRetry={onRetryAdvisor}
              />
            </LayoutGroup>
          </div>

          <div className={`relative mx-auto w-full max-w-3xl shrink-0 p-1.5 ${isNewChat ? "" : "z-20 -mt-1.5"}`}>
            {/* The update pill floats centred on the chip row's line, outside its flow. */}
            {!canvasOpened && <UpdatePillSlot className="bottom-full mb-2" />}
            {isNewChat && scopeKind !== "link" && !offlineName && (
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
              />
            )}
            {notice && <Notice onDismiss={onDismissNotice}>{notice}</Notice>}
            {approval && <div className="mb-2 w-full">{approval}</div>}
            <div className={offlineName ? "pointer-events-none opacity-60" : undefined}>
              <PromptComposer
                offlineName={offlineName}
                imageDraft={imageDraft}
                projectPath={projectPath}
                draft={draft}
                onDraftChange={onDraftChange}
                onSend={onSend}
                onStop={onStop}
                onCompact={onCompact}
                sendBlocked={sendBlocked}
                running={isSending}
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
                alwaysExpanded={isNewChat}
                contextUsage={contextUsage}
              />
            </div>
            {newChatError && (
              <p role="alert" className="mt-2 px-1 text-[12px] text-red">
                {newChatError}
              </p>
            )}
          </div>
        </div>
      </div>
    </ReplyProviders>
  );
}

/** The contexts a Chat's replies read: its designs and the send function a generative UI button posts through. */
function ReplyProviders({
  chatId,
  steps,
  userMessages,
  onSend,
  children,
}: {
  chatId: string | null;
  steps: ChatStep[];
  userMessages: { id: number | string; body: string }[];
  onSend?: (text: string) => Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <ArtifactsProvider chatId={chatId} steps={steps} userMessages={userMessages} onSend={onSend}>
      <GenerativeUIProvider onSend={onSend}>{children}</GenerativeUIProvider>
    </ArtifactsProvider>
  );
}

/** The four blur layers and the tint of a `.progressive-blur` (styles.css). */
function ProgressiveBlurLayers() {
  return (
    <>
      <div />
      <div />
      <div />
      <div />
      <div />
    </>
  );
}
