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
import type { Subagent } from "../model";
import { PortTrack } from "./agents/PortTrack";
import { TaskTrack } from "./agents/TaskTrack";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { loopbackOnlyPorts } from "@milagre/shared/loopback-url";
import { runStatusLabel } from "@milagre/shared/tool-activity";
import { LoopbackPortsContext } from "../lib/ports";
import { ArrowDown01Icon, BubbleChatIcon, GitMergeIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { FirstChatStarters } from "./Onboarding";
import { FindBar } from "./FindBar";
import { Notice } from "./Notice";
import { EMPTY_CHAT_MENTIONS } from "./ChatMentions";
import { insertImageMentions } from "../lib/file-mentions";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { DraftPromptComposer } from "./DraftPromptComposer";
import { QueuedMessages } from "./QueuedMessages";
import { NextCheck } from "./routines/NextCheck";
import { NewChatHeading } from "./NewChatHeading";
import Tooltip from "./primitives/Tooltip";
import { PillSlot, StatusPill } from "./primitives/StatusPill";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { BackgroundWork } from "./agents/BackgroundWork";
import { backgroundItems } from "@milagre/shared/chat-activity";
import { ChatMarkDotInline } from "./sidebar/ChatMarks";
import { UndoPanel } from "./checkpoints/UndoPanel";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { STORAGE_COMMAND } from "@milagre/shared/storage";
import { openStorage } from "../lib/storage-open";
import { headingLayer, newChatLook } from "../lib/new-chat-look";
import { WelcomeSky } from "./WelcomeSky";
import { NewChatGlance } from "./NewChatGlance";
import type { ChatsHome } from "@milagre/shared/chats-home";
import { MessageScroller } from "./agents/message-scroller";
import { StepDetailsScope } from "./agents/step-details";
import { useSettings } from "../lib/settings";
import { LoadingMark } from "./StartupSplash";
import { MessageTranscript } from "./transcript/MessageTranscript";
import { useComposerLayout, useNewChatSetup, useUndoFlow } from "./composer/composer-hooks";
import { ReplyProviders, TranscriptContexts, TranscriptSlots } from "./transcript/ChatTranscript";
import { NO_WORKTREES, NO_BRANCHES, NewChatHeader } from "./NewChatHeader";
import type { ChatComposerProps } from "./composer/chat-composer-props";
import { useRunSteps } from "../lib/agent-runs-store";

const EMPTY_SUBAGENTS: Subagent[] = [];

function useLiveSteps(given: ChatComposerProps["streamingSteps"], streamingKey: string | undefined, statusLabel: string | undefined) {
  const live = useRunSteps(given ? undefined : streamingKey);
  const steps = given ?? live;
  return { steps, phase: statusLabel ?? runStatusLabel(steps) };
}

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
  streamingSteps: givenSteps,
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
  const isNewChat = messages.length === 0 && !loading && !loadError;
  const { topBandRef, dockRef } = useComposerLayout(isNewChat, root);
  const reviewPill = !isNewChat && !!pullRequestReview && pullRequestReview.count > 0 && pullRequestReview;
  const {
    headingOpen,
    setHeadingOpen,
    projectNewChat,
    linkNewChat,
    newChatProjectKey,
    newChatProjectName,
    projectGroups,
    chatsDraft,
    noProjectGroup,
    projectCopies,
    newChatChange,
    changeComputer,
  } = useNewChatSetup({ isNewChat, scopeKind, offlineName, linearActive, onStartFromIssue, newChatProject, projectPath });
  const workingModelName = runModelName ?? selectedModel.name;
  const { steps: streamingSteps, phase } = useLiveSteps(givenSteps, streamingKey, statusLabel);
  const [jumpToBottom, setJumpToBottom] = useState<{ key: string | null | undefined; jump: () => void } | null>(null);
  const [transcriptAtEnd, setTranscriptAtEnd] = useState(true);
  const runtimeChat = typeof chatId === "number" && chatId > 0 && projectPath ? (agentChatId ?? `${messageScope ?? projectPath}#${chatId}`) : null;
  const draftKey = scrollKey === undefined ? null : `view:${scrollKey}`;
  const transcriptKey = isNewChat ? null : (agentChatId ?? runtimeChat ?? draftKey);
  const browserChat = !isNewChat ? runtimeChat : null;
  const browserShown = browserChat && !offScreen ? browserChat : null;
  const { review, undoIntent, setUndoIntent, highlightId, setHighlightId, undoable, openUndo, undoTask, previewRecovery } = useUndoFlow({
    runtimeChat,
    isSending,
    readOnlyHistory,
    offlineName,
    store,
    root,
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
  const moveDraft = useEvent((key: string, home?: Pick<ChatsHome, "exists">) => {
    root.current?.querySelector<HTMLElement>("[data-prompt-editor]")?.focus();
    newChatChange?.(key, home);
  });
  const send = useEvent((delivery?: MessageDelivery) => {
    const draft = store.text();
    if (runtimeChat && draft.trim() === "/undo") {
      store.setText("");
      openUndo();
      return;
    }
    if (draft.trim() === `/${STORAGE_COMMAND}`) {
      store.setText("");
      const computer = computerOfKey(runtimeChat ?? "");
      openStorage(computer === LOCAL_COMPUTER ? null : computer);
      return;
    }
    onSend(delivery);
  });
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
        {!isNewChat && <MessageSelection container={root} provider={sessionProvider ?? selectedModel.provider} onQuote={(quote) => addQuotes([quote])} />}
        <TranscriptSlots
          activeKey={transcriptKey}
          view={scrollKey}
          messageCount={messages.length}
          element={
            isNewChat ? null : messages.length === 0 && !loadError ? (
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
                  viewportClassName={`${findOpen ? "pt-12" : "pt-7"} pb-[calc(var(--composer-dock,0px)+16px)] chat-edge-fade`}
                  contentClassName="min-h-full"
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

                    {approval && (
                      <div data-slot="transcript-card" className={`w-full ${approvalHidden ? "hidden" : ""}`}>
                        {approval}
                      </div>
                    )}
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
        <div
          ref={dockRef}
          data-composer-dock
          data-at-end={(!isNewChat && transcriptAtEnd) || undefined}
          className={isNewChat ? "contents" : "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col pb-[var(--chat-edge-pad,0px)]"}
        >
          <div
            data-chat-width={chatWidth}
            className={`chat-gutter mx-auto flex w-full max-w-[var(--chat-width)] shrink-0 items-center justify-end gap-2 px-3 transition-[opacity,visibility] duration-fast empty:hidden [&:has(+[data-composer-wrap]_[data-picker-panel])]:invisible [&:has(+[data-composer-wrap]_[data-picker-panel])]:opacity-0 ${isNewChat ? "mb-2" : "pointer-events-none relative z-20 mb-3 has-[[data-expanded]]:z-[70] [&>*]:pointer-events-auto"}`}
          >
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
            <UpdatePillSlot className={`bottom-full ${isNewChat ? "mb-2" : "mb-1.5"}`} />
            {isNewChat && starters && starters.length > 0 && <FirstChatStarters starters={starters} />}
            {saveNotice}
            {notice && <Notice onDismiss={onDismissNotice}>{notice}</Notice>}
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
        {projectNewChat && !offScreen && (
          <ScrollArea className={`-mx-2.5 w-[calc(100%+20px)] basis-0 [scrollbar-gutter:stable_both-edges] ${newChatGlance ? "flex-[2]" : "flex-1"}`}>
            {newChatGlance && <NewChatGlance projectKey={chatsDraft ? null : newChatProjectKey} scopeKey={messageScope ?? projectPath} chatWidth={chatWidth} />}
          </ScrollArea>
        )}
      </div>
    </ReplyProviders>
  );
}
