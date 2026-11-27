import { TranscriptDivider } from "../primitives/TranscriptDivider";
import { quoteKeys, splitQuotes } from "@milagre/shared/prompt-parts";
import { SentQuote } from "../QuoteChips";
import { providerForId } from "../../lib/models";
import { providerName } from "@milagre/shared/providers";
import { DelegationReportLine } from "../DelegationReportLine";
import { isPageCommentImage, PageCommentsCard } from "../agents/BrowserComments";
import { parsePageComments } from "@milagre/shared/page-comments";
import { ArtifactCards, DesignFeedbackCard } from "../agents/ArtifactCard";
import { AnswerCard } from "../agents/AnswerCard";
import { PullRequestActionCard } from "../agents/PullRequestActionCard";
import { IssueCard } from "../agents/IssueCard";
import { AdvisorResultCard } from "../agents/AdvisorResultCard";
import { UsageLimitCard } from "../agents/UsageLimitCard";
import { isAccountSwitch, isLimitReset, limitResetText, usageLimitOf } from "@milagre/shared/usage-limit";
import { isPullRequestAction } from "@milagre/shared/pr-action";
import { issueCard } from "@milagre/shared/issue-start";
import { parseDesignFeedback } from "@milagre/shared/artifact";
import type { LimitResume, ImageAttachment } from "../../model";
import { reportMarker } from "@milagre/shared/subchat-states";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { GitForkIcon, PencilEdit02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { RoutineRunContext } from "@milagre/shared/model";
import type { AgentCliStatus, ChatMessage as AppChatMessage, ChatStep, ModelOption, ModelProvider } from "../../model";
import { Attachments } from "../Attachments";
import { MessageSettleButtons } from "./MessageSettleButtons";
import { lazyView } from "../../lib/lazy-view";
import { PromptText } from "../PromptText";
import { onlyImageMentions } from "@milagre/shared/prompt-parts";
import { useFilesRoot } from "../editor-links";
import { useSentSkills } from "../useSentSkills";
import { isRemoteKey, useScope } from "../../lib/computer-bridge";
import { isMentionOfFile, mentionedFile, mentionedFiles } from "../../lib/prompt-mentions";
import { mediaUrl } from "../../lib/media";
import { useRemoteMedia } from "../../lib/remote-media";
import { MediaLightbox } from "../motion/LazyMediaLightbox";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { SpinnerRing } from "../primitives/SpinnerRing";
import type { LightboxItem } from "../motion/MediaLightbox";
import { ComputerUseCard } from "../agents/ComputerUseCard";
import { HeartbeatCard } from "../routines/HeartbeatCard";
import Tooltip from "../primitives/Tooltip";
import { CopyButton } from "../primitives/CopyButton";
import { HandoffDivider } from "../Handover";
import { WorktreeLinkDivider } from "../WorktreeLinkDivider";
import { AccountSwitchDivider } from "../AccountSwitchDivider";
import { ChatReloadDivider } from "../ChatReloadDivider";
import { BabysitStoppedDivider } from "../BabysitStoppedDivider";
import { isBabysitStopped } from "@milagre/shared/babysit";
import { isOrchestratorAnswer } from "@milagre/shared/orchestrator";
import { OrchestratorAnswerLine } from "../orchestrator/OrchestratorAnswerLine";
import { isChatReload } from "@milagre/shared/chat-reload";
import { isRoutineRun } from "@milagre/shared/routines";
import { RoutineRunDivider } from "../RoutineRunDivider";
import { CompactionDivider } from "../CompactionDivider";
import { CheckpointRestoreDivider } from "../CheckpointRestoreDivider";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { canEditMessage, isMessageEdit } from "@milagre/shared/message-edit";
import { MessageEditDivider } from "../MessageEditDivider";
import { type UndoIntent } from "../checkpoints/UndoPanel";
import { messageSender } from "@milagre/shared/advisor-result";
import { LinkedExchangeLine, LinkedMessageHeader, LinkedMessageLine, linkedContext, linkedLine } from "../LinkedMessage";
import { type LinkedExchange } from "@milagre/shared/linked-message";
import { linkedHeading } from "@milagre/shared/linked-message";
import { isHandoff } from "@milagre/shared/handoff";
import { isCompaction } from "@milagre/shared/compaction";
import { isWorktreeLinked } from "@milagre/shared/worktree-link";
import { RecommendationCard } from "../agents/recommendation-card";
import { parseRecommendation } from "../../lib/recommendation";
import { StepRow } from "../agents/StepRow";
import { StepDetailsMessage } from "../agents/step-details";
import { ActivityBlock } from "../agents/ActivityBlock";
import { GeneratedImage } from "../agents/GeneratedImage";
import { ViewedImages } from "../agents/ViewedImages";
import { Markdown, StreamingMarkdown } from "../markdown/Markdown";
import { loaderActivity, replyActivity, unspokenThought, type ActivityEntry } from "../../lib/reply-parts";
import { useSettings } from "../../lib/settings";
import { extractOutdatedProvider } from "../../lib/cli-status";
import { splitFences } from "../../lib/message-fences";
import { CodeBlock } from "../markdown/CodeBlock";

const NO_WAITING_STEPS: string[] = [];

const AttachmentPreview = lazyView(() => import("../AttachmentPreview").then((module) => module.AttachmentPreview));

const NO_FILES: readonly string[] = [];

const NO_IMAGES: NonNullable<AppChatMessage["images"]> = [];

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
  const quoted = useMemo(() => splitQuotes(body), [body]);
  const parts = useMemo(() => splitFences(quoted.text), [quoted.text]);
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
      {quoted.quotes.length > 0 && (
        <div className={`flex flex-col gap-1 ${quoted.text.trim() ? "mt-0.5 mb-1.5" : "my-0.5"}`}>
          {quoteKeys(quoted.quotes).map(({ key, text }) => (
            <SentQuote key={key} text={text} />
          ))}
        </div>
      )}
      {quoted.text.trim() && (
        <div data-quotable="typed">
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
        </div>
      )}
      {opened && <AttachmentPreview path={opened} name={opened.split("/").at(-1) || opened} close={() => setOpened(null)} />}
      {openedImage !== null && media[openedImage] && (
        <MediaLightbox items={media} start={openedImage} thumbFor={noThumb} onIndexChange={setOpenedImage} close={closeImage} />
      )}
    </div>
  );
}

const isRunning = (entry: ActivityEntry) => entry.type === "step" && entry.step.status === "running";

function ReplyContent({
  body,
  steps,
  attachments,
  streaming,
  asking = false,
  waitingStepIds,
  credits,
  copyable = true,
  onFork,
  onSettle,
}: {
  body: string;
  copyable?: boolean;
  steps: ChatStep[];
  attachments?: ImageAttachment[];
  streaming: boolean;
  asking?: boolean;
  waitingStepIds: string[];
  credits?: number;
  onFork?: () => void;
  onSettle?: (snoozeUntil?: number) => void;
}) {
  const { setup, activity, images, viewedImages, artifacts, heartbeats, desktop, answer, answerAt } = replyActivity(body, steps);
  const thought = !streaming || asking ? unspokenThought(body, steps) : "";
  const before = answer.trim() ? activity.slice(0, answerAt) : activity;
  const after = answer.trim() ? activity.slice(answerAt) : [];
  const { toolCallDisplay } = useSettings();
  const loaderHolds = streaming && !asking && toolCallDisplay !== "full" && loaderActivity(body, steps, waitingStepIds).length > 0;
  return (
    <>
      {setup.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      {!(loaderHolds && !answer.trim()) && (
        <ActivityBlock
          entries={before}
          streaming={streaming && after.length === 0 && (toolCallDisplay === "full" || !answer.trim() || before.some(isRunning))}
          waitingStepIds={waitingStepIds}
          credits={after.length ? undefined : credits}
        />
      )}
      <ViewedImages steps={viewedImages} attachments={attachments} />
      {images.map((step) => (
        <GeneratedImage key={step.id} step={step} />
      ))}
      {desktop.length > 0 && <ComputerUseCard steps={desktop} />}
      <ArtifactCards steps={artifacts} />
      {heartbeats.map((step) => (
        <HeartbeatCard key={step.id} step={step} />
      ))}
      {answer.trim() && (
        <div data-slot="message-content" data-quotable>
          {streaming && after.length === 0 ? <StreamingMarkdown text={answer} /> : <Markdown text={answer} />}
        </div>
      )}
      {after.length > 0 && !loaderHolds && <ActivityBlock entries={after} streaming={streaming} waitingStepIds={waitingStepIds} credits={credits} />}
      {copyable && (answer.trim() || onFork || onSettle) && (
        <div className="h-7" data-message-copy-footer>
          {!streaming && (
            <div className="flex w-fit items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
              {answer.trim() && <CopyButton text={answer} />}
              {onFork && (
                <Tooltip label="Fork Chat from here">
                  <button
                    type="button"
                    data-fork-message
                    aria-label="Fork Chat from here"
                    onClick={onFork}
                    className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                  >
                    <Icon icon={GitForkIcon} size={14} />
                  </button>
                </Tooltip>
              )}
              {onSettle && <MessageSettleButtons onSettle={onSettle} />}
            </div>
          )}
        </div>
      )}
      {thought && (
        <div data-slot="message-thought" data-quotable className="text-ink-2">
          <Markdown text={thought} />
        </div>
      )}
    </>
  );
}

type MessageSectionProps = {
  message: AppChatMessage;
  merged?: { count: number; last: RoutineRunContext };
  exchange?: LinkedExchange;
  isUser: boolean;
  models: ModelOption[];
  undoId?: string;
  undoLatest?: boolean;
  undoDisabled?: boolean;
  onUndo?: (checkpointId: string) => void;
  onFork?: (messageId: number) => void;
  onEdit?: (messageId: number) => void;
  onSettle?: (snoozeUntil?: number) => void;
  highlighted?: boolean;
  /** Editing this message: the next send replaces it. */
  editing?: boolean;
  /** After the message being edited: removed when the edit is sent. */
  dimmed?: boolean;
  onCheckpointPreview?: (recoveryId: string, action: UndoIntent) => void;
  onRecommendationSelect: (option: string) => void;
  onUpdateCli?: (provider: ModelProvider) => void;
  updatingCli?: ModelProvider | null;
  cliStatus?: AgentCliStatus | null;
  streaming?: boolean;
  asking?: boolean;
  waitingStepIds?: string[];
  animate?: boolean;
  onOpenChat?: (chatKey: string) => void;
  limitInteractive?: boolean;
  limitPending?: LimitResume;
  limitSourceMessageId?: number;
  limitResumeBlocked?: boolean;
  onOpenAccounts?: () => void;
};

function messageDivider(
  message: AppChatMessage,
  { models, merged, onCheckpointPreview, onOpenChat }: Pick<MessageSectionProps, "models" | "merged" | "onCheckpointPreview" | "onOpenChat">,
): ReactNode {
  if (typeof message.context === "object" && message.context?.kind === "chat-fork") {
    const context = message.context;
    const label = `Forked from ${context.title}`;
    return (
      <TranscriptDivider icon={GitForkIcon} label={label}>
        <button type="button" onClick={() => onOpenChat?.(context.from)} className="text-ink-3 hover:text-ink">
          {label}
        </button>
      </TranscriptDivider>
    );
  }
  if (isHandoff(message)) return <HandoffDivider context={message.context} models={models} />;
  if (isWorktreeLinked(message)) return <WorktreeLinkDivider context={message.context} />;
  if (isCompaction(message)) return <CompactionDivider context={message.context} />;
  if (isAccountSwitch(message)) return <AccountSwitchDivider context={message.context} />;
  if (isLimitReset(message))
    return (
      <div data-limit-reset-divider role="group" aria-label={limitResetText()} className="flex w-full items-center gap-3 py-1 text-12 text-ink-3">
        <span className="h-px flex-1 bg-line" />
        {limitResetText()}
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  if (isChatReload(message)) return <ChatReloadDivider />;
  if (isBabysitStopped(message)) return <BabysitStoppedDivider context={message.context} />;
  if (isOrchestratorAnswer(message)) return <OrchestratorAnswerLine summaries={message.context.summaries ?? [message.context.summary]} />;
  if (isRoutineRun(message)) return <RoutineRunDivider context={message.context} merged={merged} />;
  if (isCheckpointRestore(message)) return <CheckpointRestoreDivider context={message.context} onPreview={onCheckpointPreview} />;
  if (isMessageEdit(message)) return <MessageEditDivider context={message.context} onPreview={onCheckpointPreview} />;
  return null;
}

type Linked = ReturnType<typeof linkedContext>;

function linkedLineArticle(
  message: AppChatMessage,
  isUser: boolean,
  linked: Linked,
  { exchange, onOpenChat }: Pick<MessageSectionProps, "exchange" | "onOpenChat">,
): ReactNode {
  const marker = linked ? reportMarker(linked) : null;
  if (marker && linked)
    return (
      <article id={`message-${message.id}`} data-slot="message" data-linked={linked.kind} className="flex min-w-0 w-full flex-col">
        <DelegationReportLine marker={marker} body={message.body} chat={linkedHeading(linked).chat} onOpenChat={onOpenChat} />
      </article>
    );
  if (exchange)
    return (
      <article id={`message-${message.id}`} data-slot="message" data-linked={linked?.kind} className="flex min-w-0 w-full flex-col">
        <LinkedExchangeLine exchange={exchange} onOpenChat={onOpenChat} />
      </article>
    );
  const line = isUser ? linkedLine(linked) : null;
  if (line)
    return (
      <article id={`message-${message.id}`} data-slot="message" data-linked={linked?.kind} className="flex min-w-0 w-full flex-col">
        <LinkedMessageLine message={message} line={line} onOpenChat={onOpenChat} />
      </article>
    );
  return null;
}

function userCards(message: AppChatMessage, isUser: boolean, linked: Linked) {
  const advisor = typeof message.context === "object" && message.context?.kind === "advisor-result" ? message.context : null;
  const prAction = isUser && isPullRequestAction(message.context) ? message.context : null;
  const issue = isUser ? issueCard(message.context) : null;
  const feedback = isUser && !linked && !advisor && !prAction && !issue ? parseDesignFeedback(message.body) : null;
  const pageFeedback = isUser && !linked && !advisor && !prAction && !issue && !feedback ? parsePageComments(message.body) : null;
  const answered = isUser && !linked && !advisor && !feedback && !pageFeedback && message.answered?.length ? message.answered : null;
  const bubble = isUser && !linked && !advisor && !feedback && !pageFeedback && !answered && !prAction && !issue;
  const card = Boolean(feedback || pageFeedback || answered || prAction || issue);
  return { advisor, prAction, issue, feedback, pageFeedback, answered, bubble, card };
}

type UserCards = ReturnType<typeof userCards>;

function bodyClass(cards: UserCards, isUser: boolean, highlighted: boolean, editing: boolean) {
  const shape = cards.advisor
    ? "w-full rounded-window"
    : cards.bubble
      ? "relative rounded-card bg-field px-3 py-1.5"
      : cards.card
        ? "w-full max-w-md"
        : isUser
          ? "relative rounded-card border border-line px-3 py-2"
          : "";
  return `min-w-0 max-w-full text-[length:var(--chat-size)] leading-[1.6] text-ink ${shape} ${highlighted || editing ? "outline outline-[1.5px] -outline-offset-[1.5px] outline-accent" : ""}`;
}

function BubbleActions({
  message,
  copyUser,
  undoId,
  undoLatest,
  undoDisabled,
  onUndo,
  onFork,
  onEdit,
}: {
  message: AppChatMessage;
  copyUser: boolean;
  undoId?: string;
  undoLatest: boolean;
  undoDisabled: boolean;
  onUndo?: (checkpointId: string) => void;
  onFork?: (messageId: number) => void;
  onEdit?: () => void;
}) {
  return (
    <div className="absolute top-[3px] right-full mr-1.5 flex opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
      {onEdit && (
        <Tooltip label="Edit message" align="end">
          <button
            type="button"
            data-edit-message={message.id}
            aria-label="Edit message"
            onClick={onEdit}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <Icon icon={PencilEdit02Icon} size={14} />
          </button>
        </Tooltip>
      )}
      {undoId && onUndo && (
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
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
          >
            <Icon icon={Undo02Icon} size={16} />
          </button>
        </Tooltip>
      )}
      {onFork && message.id > 0 && (
        <Tooltip label="Fork Chat from here" align="end">
          <button
            type="button"
            data-fork-message={message.id}
            aria-label="Fork Chat from here"
            onClick={() => onFork(message.id)}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <Icon icon={GitForkIcon} size={14} />
          </button>
        </Tooltip>
      )}
      {copyUser && <CopyButton text={message.body} />}
    </div>
  );
}

function MessageBody({
  message,
  isUser,
  cards,
  mentions,
  streaming,
  asking,
  waitingStepIds,
  onRecommendationSelect,
  onFork,
  onSettle,
}: {
  message: AppChatMessage;
  isUser: boolean;
  cards: UserCards;
  mentions: ReturnType<typeof usePromptMentions>;
  streaming: boolean;
  asking: boolean;
  waitingStepIds: string[];
  onRecommendationSelect: (option: string) => void;
  onFork?: () => void;
  onSettle?: (snoozeUntil?: number) => void;
}) {
  const { advisor, prAction, issue, feedback, pageFeedback, answered } = cards;
  const recommendation = !isUser && !streaming ? parseRecommendation(message.body) : null;
  const steps = message.steps ?? [];
  if (advisor) return <AdvisorResultCard context={advisor} body={message.body} />;
  if (prAction) return <PullRequestActionCard action={prAction} />;
  if (issue) return <IssueCard issue={issue} />;
  if (feedback) return <DesignFeedbackCard feedback={feedback} messageId={message.id} images={message.images} />;
  if (pageFeedback) return <PageCommentsCard comments={pageFeedback} images={message.images} />;
  if (answered) return <AnswerCard answered={answered} />;
  if (isUser)
    return message.body.trim() && !onlyImageMentions(message.body, message.images?.length ?? 0) ? (
      <UserBody
        body={message.body}
        skills={mentions.described}
        files={mentions.isFile}
        root={mentions.root}
        attached={mentions.files ?? NO_FILES}
        images={mentions.images ?? NO_IMAGES}
      />
    ) : null;
  if (recommendation)
    return (
      <>
        <StepDetailsMessage id={message.id}>
          <ReplyContent
            body={recommendation.intro}
            steps={steps}
            attachments={message.images}
            streaming={false}
            waitingStepIds={waitingStepIds}
            copyable={false}
          />
        </StepDetailsMessage>
        <div className={recommendation.intro ? "mt-2" : undefined}>
          <RecommendationCard question={recommendation.question} options={recommendation.options} onSelect={(option) => onRecommendationSelect(option.label)} />
        </div>
        <div className="h-7" data-message-copy-footer>
          <div className="flex w-fit items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
            <CopyButton text={message.body} />
            {onFork && (
              <Tooltip label="Fork Chat from here">
                <button
                  type="button"
                  data-fork-message={message.id}
                  aria-label="Fork Chat from here"
                  onClick={onFork}
                  className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  <Icon icon={GitForkIcon} size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </>
    );
  return (
    <StepDetailsMessage id={message.id}>
      <ReplyContent
        body={message.body}
        steps={steps}
        attachments={message.images}
        streaming={streaming}
        asking={asking}
        waitingStepIds={waitingStepIds}
        credits={message.credits}
        onFork={onFork}
        onSettle={onSettle}
      />
    </StepDetailsMessage>
  );
}

function ReplyFooter({
  message,
  isUser,
  streaming,
  onUpdateCli,
  updatingCli,
  cliStatus,
  limitInteractive,
  limitPending,
  limitSourceMessageId,
  limitResumeBlocked,
  onOpenAccounts,
}: Pick<
  MessageSectionProps,
  "message" | "isUser" | "onUpdateCli" | "updatingCli" | "cliStatus" | "limitPending" | "limitSourceMessageId" | "limitResumeBlocked" | "onOpenAccounts"
> & { streaming: boolean; limitInteractive: boolean }) {
  const outdatedProvider = !isUser && !streaming ? extractOutdatedProvider(message.body) : null;
  const isCurrentlyOutdated = outdatedProvider ? (cliStatus ? cliStatus[outdatedProvider]?.state === "outdated" : true) : false;
  const showUpdateButton = Boolean(outdatedProvider && onUpdateCli && (isCurrentlyOutdated || updatingCli === outdatedProvider));
  const limit = !isUser && !streaming ? usageLimitOf(message) : null;
  return (
    <>
      {!isUser && !streaming && message.outcome === "cancelled" && <p className="mt-2 text-12 text-ink-3">Turn stopped</p>}
      {limit && (
        <UsageLimitCard
          limit={limit}
          sessionId={message.session_id}
          interactive={limitInteractive}
          pending={limitPending?.sourceMessageId === message.id ? limitPending : undefined}
          sourceMessageId={message.id}
          resumeAvailable={message.id === limitSourceMessageId}
          resumeBlocked={limitResumeBlocked}
          onOpenAccounts={onOpenAccounts}
        />
      )}
      {showUpdateButton && outdatedProvider && onUpdateCli && (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="secondary" size={28} disabled={updatingCli === outdatedProvider} onClick={() => onUpdateCli(outdatedProvider)}>
            {updatingCli === outdatedProvider ? (
              <>
                <SpinnerRing size={12} />
                <span>Updating {providerName(outdatedProvider)}…</span>
              </>
            ) : (
              <span>Update {providerName(outdatedProvider)} now</span>
            )}
          </Button>
        </div>
      )}
    </>
  );
}

export const MessageSection = memo(function MessageSection({
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
  limitPending,
  limitSourceMessageId,
  limitResumeBlocked,
  onOpenAccounts,
  models,
  merged,
  exchange,
  undoId,
  undoLatest = false,
  undoDisabled = false,
  onUndo,
  onFork,
  onEdit,
  onSettle,
  highlighted = false,
  editing = false,
  dimmed = false,
  onCheckpointPreview,
}: MessageSectionProps) {
  const mentions = usePromptMentions(message, isUser);
  const divider = messageDivider(message, { models, merged, onCheckpointPreview, onOpenChat });
  if (divider) return dimmed ? <div className="opacity-40">{divider}</div> : divider;
  const linked = linkedContext(message);
  const linkedArticle = linkedLineArticle(message, isUser, linked, { exchange, onOpenChat });
  if (linkedArticle) return linkedArticle;
  const cards = userCards(message, isUser, linked);
  const { advisor, bubble, pageFeedback, feedback } = cards;
  const copyUser = (bubble || (isUser && linked)) && !advisor && Boolean(message.body.trim()) && !onlyImageMentions(message.body, message.images?.length ?? 0);
  const forkThis = forkAction(onFork, message.id, streaming);
  const editThis = editAction(onEdit, message, bubble, streaming);
  return (
    <article
      id={`message-${message.id}`}
      data-slot="message"
      data-from={messageSender(message)}
      data-provider={!isUser && message.model ? providerForId(message.model) : undefined}
      data-linked={linked?.kind}
      data-streaming={streaming || undefined}
      {...editState(editing, dimmed)}
      className={`group/message flex min-w-0 w-full flex-col gap-1.5 transition-[opacity,transform] duration-slow ${articleLayout(cards, dimmed, [copyUser, undoId && onUndo, forkThis, editThis])}`}
      style={animate ? { animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" } : undefined}
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
      <div data-user-bubble={bubble || undefined} className={bodyClass(cards, isUser, highlighted, editing)}>
        {bubbleActionsShown(cards, editing, [copyUser, undoId && onUndo, forkThis, editThis]) && (
          <BubbleActions
            message={message}
            copyUser={Boolean(copyUser)}
            undoId={undoId}
            undoLatest={undoLatest}
            undoDisabled={undoDisabled}
            onUndo={onUndo}
            onFork={onFork}
            onEdit={editThis}
          />
        )}
        <Attachments
          images={
            pageFeedback
              ? message.images?.filter((image) => !isPageCommentImage(image))
              : feedback
                ? message.images?.filter((_, index) => !feedback.comments.some((comment) => comment.images?.includes(index + 1)))
                : isUser
                  ? message.images
                  : message.images?.filter((image) => !image.sourcePath)
          }
          files={mentions.inline ? message.files?.filter((file) => !mentions.inline!.has(file)) : message.files}
        />
        <MessageBody
          message={message}
          isUser={isUser}
          cards={cards}
          mentions={mentions}
          streaming={streaming}
          asking={asking}
          waitingStepIds={waitingStepIds}
          onRecommendationSelect={onRecommendationSelect}
          onFork={forkThis}
          onSettle={streaming ? undefined : onSettle}
        />
        <ReplyFooter
          message={message}
          isUser={isUser}
          streaming={streaming}
          onUpdateCli={onUpdateCli}
          updatingCli={updatingCli}
          cliStatus={cliStatus}
          limitInteractive={limitInteractive}
          limitPending={limitPending}
          limitSourceMessageId={limitSourceMessageId}
          limitResumeBlocked={limitResumeBlocked}
          onOpenAccounts={onOpenAccounts}
        />
      </div>
    </article>
  );
});

function forkAction(onFork: MessageSectionProps["onFork"], id: number, streaming: boolean) {
  return onFork && !streaming && id > 0 ? () => onFork(id) : undefined;
}
function editAction(onEdit: MessageSectionProps["onEdit"], message: AppChatMessage, bubble: boolean, streaming: boolean) {
  return bubble && onEdit && !streaming && canEditMessage(message) ? () => onEdit(message.id) : undefined;
}
function editState(editing: boolean, dimmed: boolean) {
  return { "data-editing": editing || undefined, "data-dimmed": dimmed || undefined };
}
function bubbleActionsShown(cards: UserCards, editing: boolean, actions: unknown[]) {
  return cards.bubble && !editing && actions.some(Boolean);
}

// The bubble's gutter leaves room for its hover actions: Edit, Undo changes, Fork and Copy.
function articleLayout(cards: UserCards, dimmed: boolean, actions: unknown[]) {
  const count = actions.filter(Boolean).length;
  const gutter = count >= 4 ? "pl-30" : count >= 3 ? "pl-24" : count >= 2 ? "pl-18" : "pl-12";
  return `${dimmed ? "opacity-40" : ""} ${cards.bubble ? `items-end ${gutter}` : cards.card ? "items-end pl-12" : ""}`;
}
