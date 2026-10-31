import { prepareImageUploads } from "../../lib/attachment-uploads";
import { useCallback, useLayoutEffect, useMemo, useState, type ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PauseIcon, PlayIcon, SidebarRight01Icon } from "@hugeicons/core-free-icons";
import type { BotSummary, BotsSnapshot, GateMeta } from "@milagre/shared/bots";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { ChatMessage } from "@milagre/shared/model";
import { capabilityFor, type ModelOption } from "../../model";
import { bridgeFor, ScopeContext } from "../../lib/computer-bridge";
import { createDraftStore, draftKey } from "../../lib/draft-store";
import { useChatMessages } from "../../lib/chat-messages";
import { useComposerPreferences } from "../../lib/use-composer-preferences";
import { useControlsClearance } from "../../lib/window-chrome";
import { attachmentPrompt } from "../../lib/media";
import { sentDecision, sentReply } from "../../lib/agent-runs";
import { usePastedImages } from "../usePastedImages";
import type { useAgentRuns } from "../useAgentRuns";
import { DraftChatComposer } from "../DraftChatComposer";
import { MessageCardContext } from "../ChatComposer";
import { PermissionCard } from "../agents/PermissionCard";
import { QuestionCard } from "../agents/QuestionCard";
import { BotChatCard } from "./BotChatCard";
import { GateCard, type GateChoice } from "./GateCard";

export type BotThreadPreferences = Pick<ComponentProps<typeof DraftChatComposer>, "models" | "cliStatus" | "onModelPickerOpen" | "onUpdateCli" | "updatingCli">;

const HEADER_BUTTON =
  "flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink [-webkit-app-region:no-drag]";
const NO_OP = () => {};

// A sign-off is a request in one Chat: request ids repeat across Chats.
const gateKey = (chatKey: string, requestId: string) => `${chatKey}\n${requestId}`;

/**
 * A bot's one thread: the ordinary Chat in its home, hosted the way LinkWorkspace hosts its composer, always in Bot
 * rules. Sign-offs for anything the bot or a Chat it opened wants to run wait above the composer; the Chats it opened
 * show as cards in the transcript.
 */
export function BotThread({
  bot,
  snapshot,
  agents,
  preferences,
  onOpenChat,
  profileOpen,
  onToggleProfile,
}: {
  bot: BotSummary;
  snapshot: BotsSnapshot;
  agents: Pick<ReturnType<typeof useAgentRuns>, "runs" | "send" | "interrupt" | "respond" | "answerQuestion">;
  preferences: BotThreadPreferences;
  onOpenChat: (chatKey: string) => void;
  profileOpen: boolean;
  onToggleProfile: () => void;
}) {
  const bridge = bridgeFor(null);
  const chatId = `${bot.homePath}#${bot.threadSessionId}`;
  const run = agents.runs[chatId];
  const chat = useChatMessages(bot.homePath, bot.threadSessionId);
  const earlier = useMemo(
    () => (chat.hasMore ? { count: chat.total - chat.messages.length, load: chat.loadEarlier, loadAll: chat.loadAll } : undefined),
    [chat.hasMore, chat.total, chat.messages.length, chat.loadEarlier, chat.loadAll],
  );
  // oxlint-disable-next-line react/use-memo -- useMemo is given a factory function reference so the instance is created once
  const draftStore = useMemo(createDraftStore, []);
  useLayoutEffect(() => draftStore.select(draftKey(bot.homePath, bot.threadSessionId)), [draftStore, bot.homePath, bot.threadSessionId]);
  const imageDraft = usePastedImages(chatId);
  const composerPrefs = useComposerPreferences(chatId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<Record<string, GateChoice>>({});
  const { bar: headerBar, inset: headerInset } = useControlsClearance<HTMLElement>(true);
  const model: ModelOption = preferences.models.find((option) => option.provider === bot.provider && option.id === bot.model) ?? {
    id: bot.model,
    name: bot.model,
    provider: bot.provider as ModelOption["provider"],
    description: "",
  };
  const capability = capabilityFor(model, null);

  async function send() {
    const body = draftStore.get().trim();
    if (bot.paused || sending || imageDraft.loading || (!body && !imageDraft.images.length && !imageDraft.files.length)) return;
    setSending(true);
    setError(null);
    try {
      // The runtime runs every message to a bot's thread in Bot rules, whatever is sent here.
      await agents.send({
        projectPath: bot.homePath,
        sessionId: bot.threadSessionId,
        worktreeId: bot.homeWorktreeId,
        body,
        prompt: attachmentPrompt(body, imageDraft.files),
        images: await prepareImageUploads(bot.homePath, imageDraft.images),
        files: imageDraft.files,
        provider: model.provider,
        model: model.id,
        permissionMode: "bot",
        effort: composerPrefs.effort,
      });
      if (draftStore.get().trim() === body) draftStore.set("");
      imageDraft.clear();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  function answerGate(chatKey: string, requestId: string, choice: GateChoice) {
    const key = gateKey(chatKey, requestId);
    setAnswering((current) => ({ ...current, [key]: choice }));
    bridge.answerBotGate(chatKey, requestId, choice).catch((cause) => {
      setError(ipcErrorMessage(cause));
      setAnswering(({ [key]: _answer, ...rest }) => rest);
    });
  }
  async function togglePause() {
    try {
      await bridge.updateBot(bot.id, { paused: !bot.paused });
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  }

  // What waits on the user: this bot's sign-offs, from its thread or from a Chat it opened, oldest first. A card the
  // runtime hasn't recorded yet still shows from the thread's run.
  const recorded = new Set(snapshot.gates.map((gate) => gateKey(gate.chatKey, gate.requestId)));
  const pendingGates: Array<{ chatKey: string; requestId: string; meta: GateMeta }> = [
    ...snapshot.gates.filter((gate) => gate.botId === bot.id && gate.status === "pending").sort((a, b) => a.createdAt - b.createdAt),
    ...(run?.approvals ?? []).flatMap((request) =>
      request.gate && !recorded.has(gateKey(chatId, request.requestId)) && !run?.answered[request.requestId]
        ? [{ chatKey: chatId, requestId: request.requestId, meta: request.gate }]
        : [],
    ),
  ];
  const approval = run?.approvals.find((request) => !request.gate && !run.answered[request.requestId]);
  const question = approval ? undefined : run?.questions.find((request) => !run.answered[request.requestId]);

  const card = useCallback(
    (message: ChatMessage) => {
      const context = typeof message.context === "object" ? message.context : null;
      if (context?.kind === "bot-chat-finished") {
        const record = snapshot.chats.find((item) => item.chatKey === context.chatKey);
        return (
          <BotChatCard
            chat={record ?? { chatKey: context.chatKey, title: context.chatKey, projectPath: projectOfKey(context.chatKey), status: context.status }}
            onOpen={onOpenChat}
          />
        );
      }
      if (context?.kind === "bot-gate-expired") {
        const gate = snapshot.gates.find((item) => item.requestId === context.requestId && item.chatKey === context.chatKey);
        return gate ? (
          <GateCard gate={gate.meta} status="expired" botName={bot.name} />
        ) : (
          <p data-gate-status="expired" className="text-[12px] text-ink-3">
            Expired
          </p>
        );
      }
      if (context?.kind === "bot-chat-taken-over")
        return (
          <p data-bot-taken-over className="text-[12px] text-ink-3">
            You took over this Chat.
          </p>
        );
      return null;
    },
    [snapshot.chats, snapshot.gates, bot.name, onOpenChat],
  );

  const cards =
    pendingGates.length > 0 ? (
      <div className="flex flex-col gap-2">
        {pendingGates.map((gate) => (
          <GateCard
            key={gateKey(gate.chatKey, gate.requestId)}
            gate={gate.meta}
            botName={bot.name}
            answering={answering[gateKey(gate.chatKey, gate.requestId)] ?? null}
            onAnswer={(choice) => answerGate(gate.chatKey, gate.requestId, choice)}
          />
        ))}
      </div>
    ) : approval ? (
      <PermissionCard
        request={approval}
        waiting={0}
        answering={sentDecision(run, approval.requestId)}
        onAnswer={(decision) => void agents.respond(chatId, approval.requestId, decision).catch((cause) => setError(ipcErrorMessage(cause)))}
      />
    ) : question ? (
      <QuestionCard
        request={question}
        waiting={0}
        answering={sentReply(run, question.requestId)}
        onAnswer={(answer) => void agents.answerQuestion(chatId, question.requestId, answer).catch((cause) => setError(ipcErrorMessage(cause)))}
      />
    ) : undefined;

  return (
    <ScopeContext.Provider value={bot.homePath}>
      <MessageCardContext.Provider value={card}>
        <div data-bot-thread={bot.id} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* With the sidebar collapsed, the window controls and the sidebar toggle sit over the header's left end. */}
          <header
            ref={headerBar}
            className="relative z-30 flex h-[var(--window-chrome-height)] shrink-0 items-center gap-2"
            // The inset stops 12px short of the controls' end for a bar whose buttons bring their own spacing; the title has none.
            style={{ paddingLeft: headerInset.paddingLeft > 0 ? headerInset.paddingLeft + 12 : 8, paddingRight: Math.max(4, headerInset.paddingRight) }}
          >
            <h1 className="shrink-0 text-[14px] font-semibold text-ink">{bot.name}</h1>
            <p className="min-w-0 truncate text-[13px] text-ink-3">
              {bot.role} · {model.name}
            </p>
            {/* Above App's window drag strip (z-50), like the other chrome controls, so clicks reach the buttons. */}
            <span data-bot-thread-actions className="relative z-[60] ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <button
                type="button"
                aria-label={bot.paused ? "Resume" : "Pause"}
                title={bot.paused ? "Resume" : "Pause"}
                onClick={() => void togglePause()}
                className={HEADER_BUTTON}
              >
                <HugeiconsIcon icon={bot.paused ? PlayIcon : PauseIcon} size={16} strokeWidth={1.8} color="currentColor" />
              </button>
              <button
                type="button"
                aria-label="Profile"
                aria-pressed={profileOpen}
                onClick={onToggleProfile}
                className={`${HEADER_BUTTON} ${profileOpen ? "bg-hover-2 text-ink" : ""}`}
              >
                <HugeiconsIcon icon={SidebarRight01Icon} size={16} strokeWidth={1.8} color="currentColor" />
              </button>
            </span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DraftChatComposer
              {...preferences}
              selectedModel={model}
              onModelChange={NO_OP}
              capability={capability}
              effort={composerPrefs.effort}
              onEffortChange={composerPrefs.setEffort}
              ultracode={false}
              onUltracodeChange={NO_OP}
              fastMode={false}
              onFastModeChange={NO_OP}
              permissionMode="bot"
              permissionLocked
              onPermissionModeChange={NO_OP}
              scopeKind="bot"
              store={draftStore}
              projectPath={bot.homePath}
              messageScope={bot.homePath}
              agentChatId={chatId}
              earlier={earlier}
              trimHistory={chat.trim}
              messages={chat.messages}
              imageDraft={imageDraft}
              onSend={() => void send()}
              onStop={run ? () => void agents.interrupt(chatId) : undefined}
              isSending={Boolean(run && !pendingGates.length && !approval && !question)}
              sendBlocked={sending || bot.paused}
              streamingText={run?.text}
              streamingSteps={run?.steps}
              runStartedAt={run?.startedAt}
              runModelName={run?.model}
              sessionProvider={bot.provider as ModelOption["provider"]}
              asking={Boolean(question)}
              waitingStepIds={run?.approvals.flatMap((request) => (request.stepId ? [request.stepId] : []))}
              onRecommendationSelect={(option) => {
                draftStore.set(option);
                void send();
              }}
              notice={bot.paused ? `${bot.name} is paused.` : null}
              approval={cards}
              worktrees={[]}
              onWorktreeChange={NO_OP}
              isolation="local"
              onIsolationChange={NO_OP}
              branches={[]}
              baseBranch=""
              onBaseBranchChange={NO_OP}
              newChatError={error}
            />
          </div>
        </div>
      </MessageCardContext.Provider>
    </ScopeContext.Provider>
  );
}
