import { useCompactionFeedback } from "@milagre/shared/use-compaction-feedback";
import { compactionContext } from "@milagre/shared/compaction";
import { providerName } from "@milagre/shared/providers";
import { SubagentTrack } from "./agents/SubagentTrack";
import { UpdatePillSlot } from "./UpdateNotice";
import { BrowserPanel } from "./agents/BrowserPanel";
import { isPageCommentImage, PageCommentsCard } from "./agents/BrowserComments";
import { parsePageComments } from "@milagre/shared/page-comments";
import { openBrowserTab } from "../lib/browser-panel";
import { SimulatorTrack } from "./agents/SimulatorTrack";
import { ArtifactCards, ArtifactsProvider, DesignFeedbackCard } from "./agents/ArtifactCard";
import { GenerativeUIProvider } from "./genui/GenerativeUI";
import { AnswerCard } from "./agents/AnswerCard";
import { PullRequestActionCard } from "./agents/PullRequestActionCard";
import { LinearIssueCard } from "./agents/LinearIssueCard";
import { AdvisorResultCard } from "./agents/AdvisorResultCard";
import { UsageLimitCard } from "./agents/UsageLimitCard";
import { isAccountSwitch, usageLimitOf } from "@milagre/shared/usage-limit";
import { isPullRequestAction } from "@milagre/shared/pr-action";
import { isLinearIssueContext } from "@milagre/shared/linear-issue";
import { parseDesignFeedback } from "@milagre/shared/artifact";
import { useEvent } from "../lib/stable";
import { chatHistory } from "@milagre/shared/chat-history";
import type { AgentPort, BackgroundTask, ChatPlan, ContextUsage, ImageAttachment, Subagent } from "../model";
import { PortTrack } from "./agents/PortTrack";
import { TaskTrack } from "./agents/TaskTrack";
import { createContext, Fragment, memo, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, DragEvent, ReactElement, ReactNode } from "react";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { runStatusLabel } from "@milagre/shared/tool-activity";
import { LoopbackPortsContext } from "../lib/ports";
import { createPortal } from "react-dom";
import { commitChatSwitch, transcriptShown } from "../lib/chat-switch-timing";
import { showSlot, trimSlots, type TranscriptSlot } from "../lib/transcript-slots";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  BubbleChatIcon,
  Comment01Icon,
  Folder01Icon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ComputerIcon,
  LaptopIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { LinearLogo } from "./ProviderLogo";
import { FirstChatStarters, type Starter } from "./Onboarding";
import type { LinearIssue } from "@milagre/shared/linear";
import type { RoutineRunContext } from "@milagre/shared/model";
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
import { lazyView } from "../lib/lazy-view";
import { ChatMentionsContext, EMPTY_CHAT_MENTIONS, type ChatMentionScope } from "./ChatMentions";
import { PromptText } from "./PromptText";
import { onlyImageMentions } from "@milagre/shared/prompt-parts";
import { useFilesRoot } from "./editor-links";
import { useSentSkills } from "./useSentSkills";
import { isRemoteKey, useScope } from "../lib/computer-bridge";
import { isMentionOfFile, mentionedFile, mentionedFiles } from "../lib/prompt-mentions";
import { insertImageMentions } from "../lib/file-mentions";
import { mediaUrl } from "../lib/media";
import { useRemoteMedia } from "../lib/remote-media";
import { MediaLightbox } from "./motion/LazyMediaLightbox";
import { ScrollArea } from "./primitives/ScrollArea";
import type { LightboxItem } from "./motion/MediaLightbox";
import type { ImageDraft } from "./usePastedImages";
import { PromptComposer } from "./PromptComposer";
import { QueuedMessages } from "./QueuedMessages";
import { ComputerUseCard } from "./agents/ComputerUseCard";
import { HeartbeatCard } from "./routines/HeartbeatCard";
import { NextCheck } from "./routines/NextCheck";
import type { QueueControls } from "./QueuedMessages";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { LinearIssuePicker } from "./LinearIssuePicker";
import { NewChatHeading } from "./NewChatHeading";
import Tooltip from "./primitives/Tooltip";
import { CopyButton } from "./primitives/CopyButton";
import { PillSlot, StatusPill } from "./primitives/StatusPill";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { BackgroundWork } from "./agents/BackgroundWork";
import { backgroundItems } from "@milagre/shared/chat-activity";
import { ChatMarkDotInline } from "./sidebar/ChatRow";
import type { ChatActivity } from "@milagre/shared/chat-activity";
import { HandoffDivider } from "./Handover";
import { WorktreeLinkDivider } from "./WorktreeLinkDivider";
import { AccountSwitchDivider } from "./AccountSwitchDivider";
import { ChatReloadDivider } from "./ChatReloadDivider";
import { BabysitStoppedDivider } from "./BabysitStoppedDivider";
import { isBabysitStopped } from "@milagre/shared/babysit";
import { isChatReload } from "@milagre/shared/chat-reload";
import { groupQuietRuns, isRoutineRun, routineRunOf } from "@milagre/shared/routines";
import { RoutineRunDivider } from "./RoutineRunDivider";
import { CompactionDivider } from "./CompactionDivider";
import { CheckpointRestoreDivider } from "./CheckpointRestoreDivider";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { undoableTasks, type Checkpoint, type CheckpointApi } from "@milagre/shared/checkpoints";
import { UndoPanel, type UndoIntent } from "./checkpoints/UndoPanel";
import { bridgeForKey } from "../lib/computer-bridge";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { rememberProjectComputer, shortPath, useChatsGroup, useProjectGroups, type ProjectCopy } from "../lib/project-copies";
import { headingLayer, newChatLook } from "../lib/new-chat-look";
import { WelcomeSky } from "./WelcomeSky";
import type { ChatsHome, ProjectKind } from "@milagre/shared/chats-home";
import { isModalOpen } from "../lib/modal";
import { messageSender } from "@milagre/shared/advisor-result";
import { LinkedMessageHeader, linkedContext } from "./LinkedMessage";
import { isHandoff } from "@milagre/shared/handoff";
import { isCompaction } from "@milagre/shared/compaction";
import { isWorktreeLinked } from "@milagre/shared/worktree-link";
import { MessageScroller, TRANSCRIPT_SHOWN_EVENT } from "./agents/message-scroller";
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
import { useSettings } from "../lib/settings";
import { ThisComputer } from "../lib/shortcut-hints";
import { LoadingMark } from "./StartupSplash";

const NO_WAITING_STEPS: string[] = [];

const AttachmentPreview = lazyView(() => import("./AttachmentPreview").then((module) => module.AttachmentPreview));

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 16 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

/**
 * A reply: its activity (thinking, tool steps and the text between them) folded into one block, the images it generated, then its answer.
 * A reply with no answer that ended or stopped to ask shows its last thinking instead, dimmed.
 */
const NO_FILES: readonly string[] = [];
const NO_IMAGES: NonNullable<AppChatMessage["images"]> = [];

/** The skills a sent message names (lowercase name to description) and the attached files and images it mentions inline as chips. */
function usePromptMentions(message: AppChatMessage, isUser: boolean) {
  const root = useFilesRoot() ?? "";
  const scope = useScope();
  const files = message.files;
  const images = message.images;
  const body = message.body;
  const described = useSentSkills(scope, isUser && /(^|\s)\//.test(body));
  const isFile = useMemo(() => isMentionOfFile(files ?? [], root), [files, root]);
  const inline = useMemo(() => (isUser && files?.length ? mentionedFiles(body, files, root) : null), [isUser, body, files, root]);
  return { root, files, images, described, isFile, inline };
}

/** What the user typed, as typed, with skills, mentioned files and inline images as chips; only closed ``` fences render as code (diff comments send their snippets in them). */
function UserBody({
  body,
  skills,
  files,
  root,
  attached,
  images = NO_IMAGES,
}: {
  body: string;
  skills: ReadonlyMap<string, string>;
  files: (path: string) => boolean;
  root: string;
  attached: readonly string[];
  images?: NonNullable<AppChatMessage["images"]>;
}) {
  const parts = useMemo(() => splitFences(body), [body]);
  const [opened, setOpened] = useState<string | null>(null);
  const [openedImage, setOpenedImage] = useState<number | null>(null);
  const open = useCallback((path: string) => setOpened(mentionedFile(path, attached, root) ?? null), [attached, root]);
  const scope = useScope();
  const remote = isRemoteKey(scope);
  const { sources: remoteSources } = useRemoteMedia(
    remote && images.length ? scope : null,
    images.flatMap((image) => (image.dataUrl || !image.path ? [] : [image.path])),
  );
  const media = useMemo(
    () =>
      images
        .map((image, i) => ({
          id: image.id,
          index: i + 1,
          name: image.name,
          src: image.dataUrl ?? (remote ? (remoteSources[image.path ?? ""] ?? "") : mediaUrl(image.path ?? "")),
          kind: "image" as const,
          file: remote && image.path ? (remoteSources[image.path] ?? image.dataUrl) : (image.path ?? image.dataUrl),
        }))
        .filter((item): item is typeof item & LightboxItem => !!item.src),
    [images, remote, remoteSources],
  );
  const imageNames = useMemo(() => images.map((image) => image.name), [images]);
  const openImage = useCallback(
    (index: number) => {
      const target = media.findIndex((item) => item.index === index);
      if (target >= 0) setOpenedImage(target);
    },
    [media],
  );
  const closeImage = useCallback(() => setOpenedImage(null), []);
  const noThumb = useCallback(() => undefined, []);
  return (
    <div className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <PromptText
            key={index}
            text={part.text}
            skills={skills}
            files={files}
            images={images.length}
            imageNames={imageNames}
            onOpenFile={open}
            onOpenImage={media.length ? openImage : undefined}
          />
        ) : (
          <div key={index} className="whitespace-normal">
            <CodeBlock code={part.code} fence={part.fence || undefined} diff />
          </div>
        ),
      )}
      {opened && <AttachmentPreview path={opened} name={opened.split("/").at(-1) || opened} close={() => setOpened(null)} />}
      {openedImage !== null && media[openedImage] && (
        <MediaLightbox items={media} start={openedImage} thumbFor={noThumb} onIndexChange={setOpenedImage} close={closeImage} />
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
  credits,
  copyable = true,
}: {
  body: string;
  copyable?: boolean;
  steps: ChatStep[];
  streaming: boolean;
  asking?: boolean;
  waitingStepIds: string[];
  credits?: number;
}) {
  const { setup, activity, images, artifacts, heartbeats, desktop, answer } = replyActivity(body, steps);
  const thought = !streaming || asking ? unspokenThought(body, steps) : "";
  return (
    <>
      {setup.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      <ActivityBlock entries={activity} streaming={streaming} waitingStepIds={waitingStepIds} credits={credits} />
      {images.map((step) => (
        <GeneratedImage key={step.id} step={step} />
      ))}
      {desktop.length > 0 && <ComputerUseCard steps={desktop} />}
      <ArtifactCards steps={artifacts} />
      {heartbeats.map((step) => (
        <HeartbeatCard key={step.id} step={step} />
      ))}
      {answer.trim() && <div data-slot="message-content">{streaming ? <StreamingMarkdown text={answer} /> : <Markdown text={answer} />}</div>}
      {/* Reserve the footer while streaming so completion and hover keep the transcript still. */}
      {copyable && answer.trim() && (
        <div className="h-7" data-message-copy-footer>
          {!streaming && (
            <div className="w-fit opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
              <CopyButton text={answer} />
            </div>
          )}
        </div>
      )}
      {thought && (
        <div data-slot="message-thought" className="text-ink-2">
          <Markdown text={thought} />
        </div>
      )}
    </>
  );
}

/**
 * A card that stands for a message Milagre wrote into the transcript (a bot's thread shows its Chats and sign-offs this
 * way); null keeps the message as it is.
 */
export const MessageCardContext = createContext<((message: AppChatMessage) => ReactNode) | null>(null);

const MessageSection = memo(function MessageSection({
  message,
  isUser,
  onRecommendationSelect,
  onUpdateCli,
  updatingCli,
  cliStatus,
  streaming = false,
  asking = false,
  waitingStepIds = NO_WAITING_STEPS,
  animate = false,
  onOpenChat,
  limitInteractive = false,
  onOpenAccounts,
  models,
  merged,
  undoId,
  undoLatest = false,
  undoDisabled = false,
  onUndo,
  highlighted = false,
  onCheckpointPreview,
}: {
  message: AppChatMessage;
  /** Quiet heartbeats folded into this one: how many, and the last. */
  merged?: { count: number; last: RoutineRunContext };
  isUser: boolean;
  models: ModelOption[];
  /** The checkpoint of the task this message started, when it changed files: the hover button opens its preview. */
  undoId?: string;
  /** It is the newest such task, the one Esc Esc lists first. */
  undoLatest?: boolean;
  /** A turn is running: undo waits for it. */
  undoDisabled?: boolean;
  onUndo?: (checkpointId: string) => void;
  /** The task in the undo panel's view: its message is outlined. */
  highlighted?: boolean;
  /** Opens the preview behind an undo line's Redo. */
  onCheckpointPreview?: (recoveryId: string, action: UndoIntent) => void;
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
  const card = useContext(MessageCardContext)?.(message);
  const mentions = usePromptMentions(message, isUser);
  if (card)
    return (
      <article id={`message-${message.id}`} data-slot="message" data-from="milagre" className="flex min-w-0 w-full flex-col">
        {card}
      </article>
    );
  if (isHandoff(message)) return <HandoffDivider context={message.context} models={models} />;
  if (isWorktreeLinked(message)) return <WorktreeLinkDivider context={message.context} />;
  if (isCompaction(message)) return <CompactionDivider context={message.context} />;
  if (isAccountSwitch(message)) return <AccountSwitchDivider context={message.context} />;
  if (isChatReload(message)) return <ChatReloadDivider />;
  if (isBabysitStopped(message)) return <BabysitStoppedDivider context={message.context} />;
  if (isRoutineRun(message)) return <RoutineRunDivider context={message.context} merged={merged} />;
  if (isCheckpointRestore(message)) return <CheckpointRestoreDivider context={message.context} onPreview={onCheckpointPreview} />;
  const linked = linkedContext(message);
  const advisor = typeof message.context === "object" && message.context?.kind === "advisor-result" ? message.context : null;
  // A PR-blocker pill's message shows as a card, not as the skill prompt the agent read.
  const prAction = isUser && isPullRequestAction(message.context) ? message.context : null;
  // So does a Chat's first message when it was started from a Linear issue.
  const issue = isUser && isLinearIssueContext(message.context) ? message.context : null;
  // A message another Chat sent sits apart from the user's own: left-aligned, with its sender over it.
  // Feedback sent from the design canvas shows as a card, not as the text the agent reads.
  const feedback = isUser && !linked && !advisor && !prAction && !issue ? parseDesignFeedback(message.body) : null;
  // So do comments sent from a Browser panel page.
  const pageFeedback = isUser && !linked && !advisor && !prAction && !issue && !feedback ? parsePageComments(message.body) : null;
  // So do the answers to the agent's questions.
  const answered = isUser && !linked && !advisor && !feedback && !pageFeedback && message.answered?.length ? message.answered : null;
  const bubble = isUser && !linked && !advisor && !feedback && !pageFeedback && !answered && !prAction && !issue;
  const recommendation = !isUser && !streaming ? parseRecommendation(message.body) : null;
  const outdatedProvider = !isUser && !streaming ? extractOutdatedProvider(message.body) : null;
  const isCurrentlyOutdated = outdatedProvider ? (cliStatus ? cliStatus[outdatedProvider]?.state === "outdated" : true) : false;
  const showUpdateButton = Boolean(outdatedProvider && onUpdateCli && (isCurrentlyOutdated || updatingCli === outdatedProvider));
  const limit = !isUser && !streaming ? usageLimitOf(message) : null;
  const steps = message.steps ?? [];
  const copyUser = (bubble || (isUser && linked)) && !advisor && Boolean(message.body.trim()) && !onlyImageMentions(message.body, message.images?.length ?? 0);
  return (
    <article
      id={`message-${message.id}`}
      data-slot="message"
      data-from={messageSender(message)}
      data-linked={linked?.kind}
      data-streaming={streaming || undefined}
      className={`group/message flex min-w-0 w-full flex-col gap-1.5 transition-[opacity,transform] duration-300 ${bubble ? (copyUser && undoId && onUndo ? "items-end pl-18" : "items-end pl-12") : feedback || pageFeedback || answered || prAction || issue ? "items-end pl-12" : ""}`}
      style={animate ? { animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" } : undefined}
    >
      {linked && (
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          <LinkedMessageHeader context={linked} onOpenChat={onOpenChat} />
          {copyUser && (
            <div className="shrink-0 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
              <CopyButton text={message.body} />
            </div>
          )}
        </div>
      )}
      <div
        className={`min-w-0 max-w-full text-[length:var(--chat-size)] leading-[1.55] text-ink ${advisor ? "w-full rounded-[14px]" : bubble ? "relative rounded-xl bg-field px-3 py-1.5" : feedback || pageFeedback || answered || prAction || issue ? "w-full max-w-md" : isUser ? "relative rounded-xl border border-line px-3 py-2" : ""} ${highlighted ? "outline outline-[1.5px] -outline-offset-[1.5px] outline-accent" : ""}`}
      >
        {/* Beside the bubble, not under it: showing it on hover never moves the transcript. */}
        {bubble && (copyUser || (undoId && onUndo)) && (
          <div className="absolute top-[3px] right-full mr-1.5 flex opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
            {bubble && undoId && onUndo && (
              <Tooltip
                label={undoDisabled ? "Wait for the task to finish" : "Undo changes"}
                keyHint={undoLatest && !undoDisabled ? "Esc Esc" : undefined}
                align="end"
              >
                <button
                  type="button"
                  data-undo-message={message.id}
                  aria-label="Undo this task's changes"
                  disabled={undoDisabled}
                  onClick={() => onUndo(undoId)}
                  className="flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
                >
                  <Icon icon={Undo02Icon} size={15} />
                </button>
              </Tooltip>
            )}
            {copyUser && <CopyButton text={message.body} />}
          </div>
        )}
        <Attachments
          images={
            pageFeedback
              ? message.images?.filter((image) => !isPageCommentImage(image))
              : isUser
                ? message.images
                : message.images?.filter((image) => !image.sourcePath)
          }
          files={mentions.inline ? message.files?.filter((file) => !mentions.inline!.has(file)) : message.files}
        />
        {advisor ? (
          <AdvisorResultCard context={advisor} body={message.body} />
        ) : prAction ? (
          <PullRequestActionCard action={prAction} />
        ) : issue ? (
          <LinearIssueCard issue={issue} />
        ) : feedback ? (
          <DesignFeedbackCard feedback={feedback} messageId={message.id} />
        ) : pageFeedback ? (
          <PageCommentsCard comments={pageFeedback} images={message.images} />
        ) : answered ? (
          <AnswerCard answered={answered} />
        ) : isUser ? (
          // A send that is only its images shows them above, without an "Image #1" bubble.
          message.body.trim() && !onlyImageMentions(message.body, message.images?.length ?? 0) ? (
            <UserBody
              body={message.body}
              skills={mentions.described}
              files={mentions.isFile}
              root={mentions.root}
              attached={mentions.files ?? NO_FILES}
              images={mentions.images ?? NO_IMAGES}
            />
          ) : null
        ) : recommendation ? (
          <>
            <StepDetailsMessage id={message.id}>
              <ReplyContent body={recommendation.intro} steps={steps} streaming={false} waitingStepIds={waitingStepIds} copyable={false} />
            </StepDetailsMessage>
            <div className={recommendation.intro ? "mt-2" : undefined}>
              <RecommendationCard
                question={recommendation.question}
                options={recommendation.options}
                onSelect={(option) => onRecommendationSelect(option.label)}
              />
            </div>
            <div className="h-7" data-message-copy-footer>
              <div className="w-fit opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
                <CopyButton text={message.body} />
              </div>
            </div>
          </>
        ) : (
          <StepDetailsMessage id={message.id}>
            <ReplyContent body={message.body} steps={steps} streaming={streaming} asking={asking} waitingStepIds={waitingStepIds} credits={message.credits} />
          </StepDetailsMessage>
        )}
        {!isUser && !streaming && message.outcome === "cancelled" && <p className="mt-2 text-xs text-ink-3">Turn stopped</p>}
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

// A Chat's first render mounts only its last few messages, so the window paints them at once; the rest of the page
// follows in a transition (TAIL_FIRST is enough to fill a tall window's viewport).
const TAIL_FIRST = 6;

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
  undoable,
  undoBlocked = false,
  onUndo,
  highlightId = null,
  onCheckpointPreview,
}: {
  /** Message id → the checkpoint of the task it started, for tasks that changed files; `latest` is the newest. */
  undoable?: Map<number, { id: string; latest: boolean }>;
  undoBlocked?: boolean;
  onUndo?: (checkpointId: string) => void;
  highlightId?: number | null;
  onCheckpointPreview?: (recoveryId: string, action: UndoIntent) => void;
} & Pick<
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
  | "reconnectingName"
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
  const loadAll = earlier?.loadAll;
  useEffect(() => {
    if (!findOpen || !loadAll) return;
    const controller = new AbortController();
    void loadAll(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [findOpen, loadAll]);
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
  // Quiet heartbeats fold away; grouped over the whole Chat so a page boundary doesn't strand a hidden reply.
  const grouped = useMemo(() => groupQuietRuns(messages), [messages]);
  const transcript = grouped.slice(start).filter((entry) => !entry.hidden);
  if (streamingMessage) {
    const pendingIndex = transcript.findIndex((entry) => entry.message.id === pendingMessageId);
    transcript.splice(pendingIndex < 0 ? transcript.length : pendingIndex, 0, { message: streamingMessage });
  }

  // Markdown parses as each message mounts, so a long first page would hold the window until all of it has. The
  // tail renders now and the rest in a transition that yields to the browser; the scroller, already at the bottom,
  // stays there as the earlier messages appear above, and measures them once so they keep their real heights.
  const [fullChat, setFullChat] = useState<number | string | null>(null);
  const cut = fullChat !== chatId && transcript.length > TAIL_FIRST;
  useEffect(() => {
    if (fullChat !== chatId) startTransition(() => setFullChat(chatId));
  }, [fullChat, chatId]);
  const tailMarker = useRef<HTMLSpanElement>(null);
  const expanding = useRef<{ viewport: HTMLElement; anchor: Element | null; top: number; short: boolean } | null>(null);
  useLayoutEffect(() => {
    if (cut) {
      const viewport = tailMarker.current?.closest<HTMLElement>('[aria-label="Conversation"]');
      if (!viewport) {
        setFullChat(chatId);
        return;
      }
      const anchor = tailMarker.current?.nextElementSibling ?? null;
      const top = anchor ? anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop : 0;
      // A tail too short to fill the window would paint at its top and then drop to the bottom when the rest
      // arrives: then the whole page renders now, before paint, as it did before.
      const short = viewport.scrollHeight <= viewport.clientHeight;
      expanding.current = { viewport, anchor, top, short };
      if (short) setFullChat(chatId);
      return;
    }
    const pending = expanding.current;
    expanding.current = null;
    if (!pending) return;
    const { viewport, anchor, top, short } = pending;
    if (short) viewport.scrollTop = viewport.scrollHeight;
    else if (anchor?.isConnected) {
      // The earlier messages went in above: move by their height, so the bottom (or a spot the reader scrolled
      // to meanwhile) stays where it was on screen.
      viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - top;
    }
    viewport.dispatchEvent(new Event(TRANSCRIPT_SHOWN_EVENT));
  }, [cut, chatId]);
  const shown = cut ? transcript.slice(-TAIL_FIRST) : transcript;

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
      {cut && <span ref={tailMarker} hidden />}
      {shown.map(({ message, merged }) => {
        // A Linear Run's first message is its issue card carrying the Run: the divider comes first, then the card.
        const issueRun = isRoutineRun(message) ? null : routineRunOf(message);
        return (
          <Fragment key={message.clientMessageId ?? message.id}>
            {issueRun ? <RoutineRunDivider context={issueRun} merged={merged} /> : null}
            <MessageSection
              message={message}
              merged={merged}
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
              // Only the messages that show undo get its props: a send or turn end leaves the rest memoized.
              undoId={message.role === "user" ? undoable?.get(message.id)?.id : undefined}
              undoLatest={message.role === "user" && undoable?.get(message.id)?.latest}
              undoDisabled={message.role === "user" && undoable?.has(message.id) && undoBlocked}
              onUndo={message.role === "user" && undoable?.has(message.id) ? onUndo : undefined}
              highlighted={message.id === highlightId}
              onCheckpointPreview={isCheckpointRestore(message) && !undoBlocked ? onCheckpointPreview : undefined}
            />
          </Fragment>
        );
      })}
    </>
  );
});

interface ChatComposerProps {
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
  /** A Link's or a bot's Chat starts without the new-chat header. */
  scopeKind?: "project" | "link" | "bot";
  /** The find bar over the message list; the parent owns it so ⌘F and the command palette can open it. */
  findOpen?: boolean;
  findSignal?: number;
  /** Text the find bar fills in when `findSignal` changes, e.g. the words a ⌘K message result matched. */
  findSeed?: string;
  onFindClose?: () => void;
  imageDraft: ImageDraft;
  projectPath: string;
  /** Messages of the Chat the host holds before `messages` (chat-pages-v1): how many, and reading them. */
  earlier?: { count: number; load: () => Promise<void>; loadAll: (signal?: AbortSignal) => Promise<void> };
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
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
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
  streamingText?: string;
  /** The running turn's tool steps, where they happened in `streamingText`. */
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
  /** The mode is fixed (a bot's thread runs in Bot rules): the chip shows it and opens no picker. */
  permissionLocked?: boolean;
  onRecommendationSelect: (option: string) => void;
  approval?: ReactNode;
  /** The cards stay mounted but out of sight, such as a question whose answers are on their way to the agent. */
  approvalHidden?: boolean;
  /**
   * The Project a new Chat starts in, named in the "Start building in" heading; its dropdown moves the new Chat to another.
   * `kind: "chats"` is a Chats home draft (No project); `onChange` gets `home` when the move is to a Chats home, saying
   * whether that computer has made it yet.
   */
  newChatProject?: { key: string; name: string; kind?: ProjectKind; onChange?: (key: string, home?: Pick<ChatsHome, "exists">) => void };
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

type IsolationOption = { id: Isolation; name: string; description: string; icon: IconData };
const ISOLATIONS: [IsolationOption, ...IsolationOption[]] = [
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
      className={`flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "text-ink-2"}`}
    >
      <span className="flex shrink-0">{leading ?? (icon && <Icon icon={icon} size={14} />)}</span>
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-ink-3">
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
  | "noGit"
> & {
  /** A Chats home draft: the tray holds only the computer chip and its label, nothing about Git. */
  chats?: boolean;
  /** The open Project's copies on every computer with its repository; the computer chip shows once there are two. */
  copies?: ProjectCopy[];
  currentKey?: string;
  onComputerChange?: (key: string) => void;
};

const NO_COPIES: ProjectCopy[] = [];

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
  noGit = false,
  chats = false,
  copies = NO_COPIES,
  currentKey,
  onComputerChange,
}: NewChatHeaderProps) {
  const [menu, setMenu] = useState<"computer" | "isolation" | "branch" | "issue" | null>(null);
  const copy = copies.find((item) => item.key === currentKey);
  // Shown for every Project, on one computer or several, so the heading never has to name the computer.
  const chooseComputer = copy && onComputerChange;
  const [query, setQuery] = useState("");
  const [popover, setPopover] = useState({ left: 0, maxHeight: 480, up: true });
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
            description: worktree.path.split("/").findLast(Boolean),
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
    // The chips sit right above the composer, so their pickers open upward into the room above, unless there's more below.
    const above = button.top - 24;
    const below = window.innerHeight - button.bottom - 24;
    setPopover({ left: button.left - (row?.left ?? button.left), maxHeight: Math.max(above, below), up: above >= below });
  }

  useDismiss(
    menu !== null,
    () => setMenu(null),
    (target) => !!target.closest("[data-picker-panel], [data-new-chat-pickers] button[aria-expanded]"),
    () => {
      if (lastTrigger.current) place(lastTrigger.current);
    },
  );

  function toggle(next: "computer" | "isolation" | "branch" | "issue", trigger: HTMLElement) {
    place(trigger);
    setQuery("");
    setMenu((current) => (current === next ? null : next));
  }

  function close() {
    setMenu(null);
    setQuery("");
  }

  const popoverStyle = { left: popover.left, maxHeight: popover.maxHeight, transformOrigin: popover.up ? "bottom left" : "top left" };
  const popoverEdge = popover.up ? "bottom-[calc(100%+0.375rem)]" : "top-[calc(100%+0.375rem)]";

  return (
    // The entrance animation makes this a stacking context, so lift it above the composer while a popover is open.
    <div className={`px-1 ${menu ? "relative z-30" : ""}`} style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {!chats && noGit && selected && (
        <p data-no-git-note className="mt-1 mb-2 flex items-center gap-1.5 text-[13px] text-ink-2">
          <Icon icon={Folder01Icon} size={14} />
          {selected.name} has no Git, so this Chat works in the folder itself.
        </p>
      )}
      {(chats || (!noGit && selected)) && (
        // One row, never wrapped: a narrow composer truncates the chips' names instead.
        <div data-new-chat-pickers className="relative mb-1 flex min-w-0 items-center gap-1">
          {chooseComputer && (
            <Tooltip label="Choose the computer" className="min-w-0">
              <ChipButton
                icon={ComputerIcon}
                label={copy.computer}
                open={menu === "computer"}
                onClick={(trigger) => toggle("computer", trigger.parentElement ?? trigger)}
              />
            </Tooltip>
          )}
          {chats ? (
            <span data-new-chat-label className="flex h-7 items-center gap-1.5 px-1.5 text-[12px] font-medium text-ink-2">
              <Icon icon={BubbleChatIcon} size={14} />
              {newChatLook("chats").trayLabel}
            </span>
          ) : (
            selected && (
              <>
                <Tooltip label="Choose the isolation level" className="min-w-0">
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
              </>
            )
          )}
          {!chats && linearActive && onStartFromIssue && (
            <ChipButton leading={<LinearLogo size={13} />} label="Linear issue" open={menu === "issue"} onClick={(trigger) => toggle("issue", trigger)} />
          )}
          {menu === "computer" && chooseComputer && (
            <PickerPanel title="Run on" className={`absolute ${popoverEdge} w-[320px]`} style={popoverStyle}>
              {copies.map((item) => (
                <PickerRow
                  key={item.key}
                  icon={<Icon icon={ComputerIcon} size={14} />}
                  label={item.computerId === LOCAL_COMPUTER ? `${item.computer} · ${ThisComputer}` : item.computer}
                  // A Chats home's folder is Milagre's own, not a place the user picked.
                  description={chats ? undefined : shortPath(item.key)}
                  trailing={item.online ? undefined : "Offline"}
                  selected={item.key === currentKey}
                  disabled={!item.online}
                  wrapLabel
                  onClick={() => {
                    close();
                    if (item.key === currentKey) return;
                    rememberProjectComputer(item);
                    onComputerChange(item.key);
                  }}
                />
              ))}
            </PickerPanel>
          )}
          {menu === "isolation" && (
            <PickerPanel title="Isolation" className={`absolute ${popoverEdge} w-[320px]`} style={popoverStyle}>
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
              className={`absolute ${popoverEdge} w-[420px] max-w-[calc(100vw-2rem)]`}
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
              className={`absolute ${popoverEdge} w-[420px] max-w-[calc(100vw-2rem)]`}
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
  mentionContext = EMPTY_CHAT_MENTIONS,
  offlineName,
  reconnectingName,
  offlineTray,
  offScreen = false,
  scopeKind,
  imageDraft,
  projectPath,
  messageScope,
  scrollKey,
  earlier,
  messages,
  loading = false,
  loadError,
  onRetryLoad,
  pendingMessageId,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onCompact,
  pullRequestAction,
  pullRequestReview,
  isSending,
  sendBlocked,
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
  permissionLocked,
  onRecommendationSelect,
  approval,
  approvalHidden = false,
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
  const chatWidth = useSettings().appearance.chatWidth;
  const root = useRef<HTMLDivElement>(null);
  const chatId = messages[0]?.session_id ?? "new";
  // A first message, including its preview while setup runs, opens the conversation layout. A saved Chat whose page is
  // still on its way from the host is not a new one: its conversation layout waits, empty, instead of the new-chat header.
  const isNewChat = messages.length === 0 && !loading && !loadError;
  const reviewPill = !isNewChat && !!pullRequestReview && pullRequestReview.count > 0 && pullRequestReview;
  // A Project's new Chat: the heading sits in the upper middle, the setup chips and composer at the bottom. A Link's or a
  // bot's new Chat keeps the composer centred.
  const [headingOpen, setHeadingOpen] = useState(false);
  const projectNewChat = isNewChat && (scopeKind ?? "project") === "project" && !offlineName;
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
  // A Link Chat's Worktree being made, or a setup running, is named; the agent's own work shows the mark alone.
  const phase = statusLabel ?? runStatusLabel(streamingSteps);
  const [scrolled, setScrolled] = useState(false);
  // The runtime knows a Chat by its Project's path, not the Worktree's `projectPath` it runs in.
  const runtimeChat = typeof chatId === "number" && chatId > 0 && projectPath ? (agentChatId ?? `${messageScope ?? projectPath}#${chatId}`) : null;
  // The transcript slot on screen (TranscriptSlots); a parked one comes back at the scroll position it left at.
  // A draft's transcript takes its view's key until the Chat is saved; its slot then becomes the Chat's.
  const draftKey = scrollKey === undefined ? null : `view:${scrollKey}`;
  const transcriptKey = isNewChat ? null : (agentChatId ?? runtimeChat ?? draftKey);
  // Pages open on the viewing Mac, including pages linked from a Chat on another computer.
  const browserChat = !isNewChat ? runtimeChat : null;
  // The panel docks outside the chat pane, so the pane hiding doesn't hide it.
  const browserShown = browserChat && !offScreen ? browserChat : null;
  useEffect(() => {
    if (isNewChat) {
      setScrolled(false);
      return;
    }
    const viewport = root.current?.querySelector<HTMLElement>('[data-transcript-slot] [aria-label="Conversation"]');
    setScrolled((viewport?.scrollTop ?? 0) > 4);
  }, [isNewChat, transcriptKey]);
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
    setUndoIntent("Undo");
    void review.open();
  });
  const undoTask = useEvent((id: string) => {
    setUndoIntent("Undo");
    void review.inspect(id);
  });
  const previewRecovery = useEvent((id: string, action: UndoIntent) => {
    setUndoIntent(action);
    void review.inspect(id);
  });
  const focusPrompt = useCallback(() => {
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-prompt-editor]")?.focus());
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
      draft.trim() ||
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
  const send = useEvent(() => {
    if (runtimeChat && draft.trim() === "/undo") {
      onDraftChange("");
      openUndo();
      return;
    }
    onSend();
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

  const draftLatest = useRef(draft);
  draftLatest.current = draft;

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    void imageDraft.attachFiles(files).then((indices) => {
      if (!indices.length) return;
      onDraftChange(insertImageMentions(draftLatest.current, indices).value);
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
        {isNewChat && <WelcomeSky />}
        {!isNewChat && findOpen && onFindClose && <FindBar rootRef={root} focusSignal={findSignal} seed={findSeed} onClose={onFindClose} />}
        {projectNewChat && (
          <div
            className={[
              "chat-gutter relative mx-auto flex w-full max-w-[var(--chat-width)] shrink-0 flex-col items-center px-3 pb-6",
              headingLayer(headingOpen),
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            <NewChatHeading
              projectKey={newChatProjectKey}
              projectName={newChatProjectName}
              projectKind={newChatProject?.kind}
              groups={projectGroups}
              noProject={noProjectGroup}
              onProjectChange={newChatChange ? moveDraft : undefined}
              onOpenChange={setHeadingOpen}
            />
          </div>
        )}
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
              <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-ink-2" role="alert">
                <p>Could not load this Chat: {loadError}</p>
                {onRetryLoad && (
                  <button type="button" onClick={onRetryLoad} className="rounded-control border border-line px-3 py-1.5 hover:bg-hover">
                    Try again
                  </button>
                )}
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
                  // The chip row floats over the bottom blur, so the last message can scroll clear of it.
                  viewportClassName={`${findOpen ? "pt-12" : "pt-4"} pb-10`}
                  contentClassName="min-h-full"
                  // Streamed text isn't in the key: the scroller follows the content's growth itself, once per layout.
                  autoScrollKey={`${messages.length}-${isSending}-${streamingSteps?.length ?? 0}`}
                  viewportProps={{ onScroll: (event) => setScrolled(event.currentTarget.scrollTop > 4) }}
                >
                  <div
                    data-chat-width={chatWidth}
                    className="chat-column mx-auto flex min-h-full w-full max-w-[var(--chat-width)] flex-col gap-3 px-3 pt-12 pb-4"
                  >
                    {/* Reply links to this Chat's loopback-only servers stay localhost (Markdown.tsx). */}
                    <LoopbackPortsContext.Provider value={loopbackPorts}>
                      <StepDetailsScope scope={messageScope}>
                        <ChatMentionsContext value={mentionContext}>
                          <MessageTranscript
                            findOpen={findOpen}
                            earlier={earlier}
                            messages={messages}
                            pendingMessageId={pendingMessageId}
                            isSending={isSending}
                            streamingText={streamingText}
                            streamingSteps={streamingSteps}
                            asking={asking}
                            undoable={undoable}
                            undoBlocked={isSending || Boolean(offlineName)}
                            onUndo={runtimeChat ? undoTask : undefined}
                            highlightId={highlightId}
                            onCheckpointPreview={runtimeChat ? previewRecovery : undefined}
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
                        </ChatMentionsContext>
                      </StepDetailsScope>
                    </LoopbackPortsContext.Provider>

                    {isSending && (
                      <div className="w-full" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
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
                  className="chat-bottom-blur progressive-blur pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14"
                >
                  <ProgressiveBlurLayers />
                </div>
              </div>
            )
          }
        />
        <div
          data-chat-width={chatWidth}
          className={`chat-gutter mx-auto flex w-full max-w-[var(--chat-width)] shrink-0 items-center justify-end gap-2 px-3 empty:hidden ${isNewChat ? "mb-2" : "pointer-events-none relative z-20 -mt-[38px] mb-3.5 has-[[data-expanded]]:z-[70] [&>*]:pointer-events-auto"}`}
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
                  <StatusPill onClick={reviewPill.onOpen} icon={Comment01Icon} label={`Review ${reviewPill.count}`} tone="orange" className="font-medium" />
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
          </LayoutGroup>
        </div>

        <div
          data-chat-width={chatWidth}
          data-composer-wrap
          className={`chat-gutter relative mx-auto w-full max-w-[var(--chat-width)] shrink-0 p-1.5 ${isNewChat ? "" : "z-20 -mt-1.5"}`}
        >
          {/* The update pill floats centred on the chip row's line, outside its flow. */}
          <UpdatePillSlot className="bottom-full mb-2" />
          {isNewChat && starters && starters.length > 0 && <FirstChatStarters starters={starters} />}
          {saveNotice}
          {notice && <Notice onDismiss={onDismissNotice}>{notice}</Notice>}
          {/* A new Chat's tray holds where it runs (computer, isolation, branch) and the composer as one piece. */}
          <div
            data-composer-tray={projectNewChat || undefined}
            data-offline-composer={(!projectNewChat && offlineTray) || undefined}
            className={
              projectNewChat || offlineTray ? `rounded-[28px] border bg-inset p-1.5 pt-1 ${projectNewChat ? "border-line" : "border-line-strong"}` : ""
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
            {offlineTray}
            {queue && !isNewChat && (
              <QueuedMessages {...queue} items={queue.held ? queue.items : queue.items.filter((item) => !compactionContext(item))} disabled={sendBlocked} />
            )}
            {/* In a short grid tile (a size container) the cards scroll instead of pushing their buttons and the prompt out of it. */}
            {approval && <ScrollArea className={`mb-2 max-h-[60cqh] w-full ${approvalHidden ? "hidden" : ""}`}>{approval}</ScrollArea>}
            {review.view !== "closed" && !isNewChat && (
              <UndoPanel review={review} intent={undoIntent} onHighlight={setHighlightId} onOpenFile={onOpenDiff} onClosed={focusPrompt} />
            )}
            <div className={`${review.view === "preview" && !isNewChat ? "hidden" : ""}`}>
              <PromptComposer
                offlineName={offlineName}
                reconnectingName={reconnectingName}
                imageDraft={imageDraft}
                projectPath={projectPath}
                draft={draft}
                onDraftChange={onDraftChange}
                history={promptHistory}
                onSend={send}
                canUndo={Boolean(runtimeChat)}
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
                permissionLocked={permissionLocked}
                alwaysExpanded={isNewChat}
                contextUsage={contextUsage}
                placeholder={chatsDraft && isNewChat ? newChatLook("chats").placeholder : undefined}
              />
            </div>
          </div>
          {newChatError && (
            <p role="alert" className="mt-2 px-1 text-[12px] text-red-ink">
              {newChatError}
            </p>
          )}
          {composerNote && (
            <p data-composer-note className="mt-1.5 px-2 text-[12px] text-ink-3">
              {composerNote}
            </p>
          )}
        </div>
      </div>
    </ReplyProviders>
  );
}

const NO_OP = () => {};
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

/** A Chat's transcript alone, following its stream: an unfocused tile of the Chat grid. Replying means focusing the tile. */
export function ChatTranscript({
  mentionContext,
  chatKey,
  messages,
  messageScope,
  earlier,
  isSending,
  streamingText,
  streamingSteps,
  asking,
  waitingStepIds,
  runStartedAt,
  models,
}: { chatKey: string; mentionContext?: ChatMentionScope } & Pick<
  ChatComposerProps,
  "messages" | "messageScope" | "earlier" | "isSending" | "streamingText" | "streamingSteps" | "asking" | "waitingStepIds" | "runStartedAt" | "models"
>) {
  const history = chatHistory(messages);
  const steps = useMemo(() => (streamingSteps?.length ? [...history.steps, ...streamingSteps] : history.steps), [history.steps, streamingSteps]);
  const { userMessages } = history;
  return (
    <ReplyProviders chatId={chatKey} steps={steps} userMessages={userMessages} mentionContext={mentionContext}>
      <MessageScroller
        navigation="none"
        followOutput
        busy={isSending}
        className="min-h-0 flex-1"
        viewportClassName="pt-2 pb-3"
        contentClassName="min-h-full"
        autoScrollKey={`${messages.length}-${isSending}-${streamingSteps?.length ?? 0}`}
      >
        <div className="flex min-h-full w-full flex-col gap-3 px-3">
          <StepDetailsScope scope={messageScope}>
            <MessageTranscript
              earlier={earlier}
              messages={messages}
              isSending={isSending}
              streamingText={streamingText}
              streamingSteps={streamingSteps}
              asking={asking}
              waitingStepIds={waitingStepIds}
              onRecommendationSelect={NO_OP}
              cliStatus={null}
              models={models}
            />
          </StepDetailsScope>
          {isSending && <ThinkingIndicator startedAt={runStartedAt} label="Working" />}
        </div>
      </MessageScroller>
    </ReplyProviders>
  );
}

/** The contexts a Chat's replies read: its designs and the send function a generative UI button posts through. */
function ReplyProviders({
  mentionContext = EMPTY_CHAT_MENTIONS,
  chatId,
  steps,
  userMessages,
  onSend,
  agent,
  followAgent,
  subagents,
  children,
}: {
  mentionContext?: ChatMentionScope;
  chatId: string | null;
  steps: ChatStep[];
  userMessages: { id: number | string; body: string }[];
  onSend?: (text: string) => Promise<boolean>;
  agent?: string;
  /** The Chat this window shows, whose Designs open as the agent starts designing (not a grid tile). */
  followAgent?: boolean;
  subagents?: readonly Subagent[];
  children: ReactNode;
}) {
  return (
    <ArtifactsProvider chatId={chatId} steps={steps} userMessages={userMessages} onSend={onSend} agent={agent} followAgent={followAgent} subagents={subagents}>
      <GenerativeUIProvider onSend={onSend}>
        <ChatMentionsContext value={mentionContext}>{children}</ChatMentionsContext>
      </GenerativeUIProvider>
    </ArtifactsProvider>
  );
}

/**
 * The transcript on screen and the last few shown before it, kept mounted (lib/transcript-slots.ts, after MonoCode's
 * TranscriptPool). Each slot renders through a portal into a node of its own; the shown one's node sits in the host,
 * the parked ones' leave the document with their DOM intact, so DOM queries never meet them and coming back is one
 * insertion, not parsing and laying out every message again. A parked transcript keeps the
 * element it was last shown with, so React leaves its tree alone. Without a key (a Chat not saved yet) the element
 * renders in place and nothing is parked.
 */
/** The height styles.css gives a message content-visibility has never laid out (`contain-intrinsic-size: auto 160px`). */
const MESSAGE_PLACEHOLDER_HEIGHT = 160;

function TranscriptSlots({
  activeKey,
  view,
  element,
  messageCount,
}: {
  activeKey: string | null;
  /** The conversation on screen (App's chat view): a key change within one view is a draft becoming its saved Chat. */
  view: number | string | undefined;
  element: ReactElement | null;
  messageCount: number;
}) {
  const [slots, setSlots] = useState<TranscriptSlot<ReactElement>[]>([]);
  const [nodes] = useState(() => new Map<number, HTMLDivElement>());
  const [scrollTops] = useState(() => new Map<number, number>());
  const [unmeasured] = useState(() => new Set<number>());
  const [last, setLast] = useState<{ view: typeof view; key: string | null }>({ view, key: activeKey });
  const alias = last.view !== undefined && last.view === view && last.key && last.key !== activeKey ? last.key : undefined;
  const next = activeKey && element ? showSlot(slots, activeKey, element, alias) : slots;
  if (next !== slots) setSlots(next);
  if (last.view !== view || last.key !== activeKey) setLast({ view, key: activeKey });
  const nodeFor = (id: number) => {
    let node = nodes.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "contents";
      node.dataset.transcriptSlot = String(id);
      nodes.set(id, node);
    }
    return node;
  };
  const activeId = activeKey ? next.find((slot) => slot.key === activeKey)?.id : undefined;
  // The host takes the shown slot's node as a ref, in the layout phase before the portals' own layout effects: a
  // transcript that opens measures itself inside the document. The node it replaces leaves with its scroll position.
  const [hosts] = useState<{ current: HTMLDivElement | null }>(() => ({ current: null }));
  const host = useCallback(
    (hostNode: HTMLDivElement | null) => {
      const node = activeId === undefined ? null : nodeFor(activeId);
      // Whatever other slot the host holds is parked: it leaves with its scroll position. The host leaving (a new
      // Chat takes the window) parks its slot the same way. Only slot nodes leave: React may reuse this div for the
      // in-place transcript of a Chat without a key, whose children it has already placed when the ref lets go.
      for (const child of Array.from((hostNode ?? hosts.current)?.querySelectorAll<HTMLElement>(":scope > [data-transcript-slot]") ?? [])) {
        if (hostNode && child === node) continue;
        const viewport = child.querySelector<HTMLElement>('[aria-label="Conversation"]');
        if (viewport) scrollTops.set(Number(child.dataset.transcriptSlot), viewport.scrollTop);
        // Out of the document, content-visibility forgets the size of every skipped message. Each keeps its own, so
        // the transcript comes back at the same height and opens where it should without measuring again. A message
        // never laid out stands at the placeholder size (styles.css), which says nothing: the transcript measures again.
        const id = Number(child.dataset.transcriptSlot);
        const messages = Array.from(child.querySelectorAll<HTMLElement>('[data-slot="message"]'));
        // Every read before any write: one layout, not one per message.
        const heights = messages.map((message) => message.offsetHeight);
        messages.forEach((message, index) => {
          const height = heights[index]!;
          if (height > 0 && height !== MESSAGE_PLACEHOLDER_HEIGHT) message.style.containIntrinsicSize = `auto ${height}px`;
          else unmeasured.add(id);
        });
        child.remove();
      }
      hosts.current = hostNode;
      if (!hostNode || !node || activeId === undefined) return;
      if (node.parentElement !== hostNode) {
        hostNode.appendChild(node);
        // A Chat opens at its latest turn, parked or not; the scroller hears the move and follows again.
        const viewport = node.querySelector<HTMLElement>('[aria-label="Conversation"]');
        if (viewport && scrollTops.has(activeId)) {
          if (unmeasured.delete(activeId)) viewport.dispatchEvent(new Event(TRANSCRIPT_SHOWN_EVENT));
          viewport.scrollTop = viewport.scrollHeight;
          viewport.dispatchEvent(new Event("scroll"));
        }
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new callback per slot is what makes React run it again
    [activeId],
  );
  // Parked transcripts past the limit leave after the switch has painted, so a burst of switches pays for it once.
  useEffect(() => {
    if (trimSlots(next, activeKey) === next) return;
    const timer = window.setTimeout(() => setSlots((current) => trimSlots(current, activeKey)), 500);
    return () => window.clearTimeout(timer);
  }, [next, activeKey]);
  useEffect(() => {
    for (const id of Array.from(nodes.keys()))
      if (!next.some((slot) => slot.id === id)) {
        nodes.get(id)?.remove();
        nodes.delete(id);
        scrollTops.delete(id);
        unmeasured.delete(id);
      }
  }, [next, nodes, scrollTops, unmeasured]);
  // The switch is measured once the Chat's messages are on screen (lib/chat-switch-timing.ts).
  useLayoutEffect(() => {
    if (activeKey && messageCount > 0) commitChatSwitch(activeKey);
    else transcriptShown(null);
    return () => transcriptShown(null);
  }, [activeKey, messageCount]);
  if (!activeKey) {
    if (element) return element;
    if (!next.length) return null;
  }
  return (
    <>
      {element && <div ref={host} className="relative flex min-h-0 flex-1 flex-col" />}
      {next.map((slot) => createPortal(slot.element, nodeFor(slot.id), String(slot.id)))}
    </>
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
