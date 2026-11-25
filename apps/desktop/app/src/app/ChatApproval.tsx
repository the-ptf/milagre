import type { ComponentProps } from "react";
import { asksInComposer } from "@milagre/shared/question-composer";
import type { ComposerQuestionProps } from "../components/agents/ComposerQuestion";
import { RemoteDelegationCard } from "../components/agents/RemoteDelegationCard";
import { SubchatWaitingNote } from "../components/agents/SubchatMessages";
import { QuestionCard } from "../components/lazy-views";
import { sentDecision, sentReply, type AgentRun } from "../lib/agent-runs";
import { useRuns, type RunShell } from "../lib/agent-runs-store";
import { lazyView } from "../lib/lazy-view";
import { pendingWaitingNote } from "../lib/subchat-transcript";
import type { ChatMessage, OpenDelegation, PermissionDecision, QuestionAnswers, QuestionImages, QuestionRequest } from "../model";
import type { useAgentRuns } from "../components/useAgentRuns";
import { ipcErrorMessage } from "@milagre/shared/result";

type AgentRuns = ReturnType<typeof useAgentRuns>;

export const PermissionCard = lazyView(() => import("../components/agents/PermissionCard").then((module) => module.PermissionCard));

type PermissionRequest = ComponentProps<typeof PermissionCard>["request"];
type QuestionProps = ComponentProps<typeof QuestionCard>;

export type ChatApprovalProps = {
  /** The open Chat's key, which keys the cards so another Chat's never reuses them. */
  chatId: string;
  run: RunShell | undefined;
  messages: ChatMessage[];
  pendingApproval: PermissionRequest | undefined;
  approvalCard: PermissionRequest | undefined;
  pendingQuestion: QuestionProps["request"] | undefined;
  questionSent: boolean;
  remoteDelegations: OpenDelegation[];
  dictationChat: QuestionProps["dictationChat"];
  onAnswerApproval: (decision: PermissionDecision) => void;
  onAnswerQuestion: QuestionProps["onAnswer"];
  onRespond: (chatKey: string, requestId: string, decision: PermissionDecision) => Promise<unknown>;
  onInterrupt: (chatKey: string) => Promise<unknown>;
  onOpenChat: (chatKey: string) => void;
};

/** Whether the composer's approval slot has anything to show. A question the composer asks shows in the composer. */
function approvalShown({ approvalCard, pendingQuestion, remoteDelegations, pendingApproval, messages }: ChatApprovalProps) {
  return Boolean(
    approvalCard || cardQuestion(pendingQuestion) || remoteDelegations.length || (pendingApproval && pendingWaitingNote(messages)?.ask === "approval"),
  );
}

type QuestionRun = Pick<AgentRun, "answered" | "questions"> | undefined;
type AnswerQuestion = ComposerQuestionProps["onAnswer"];

/** The question the composer asks, until its answer is on the way. */
export function composerQuestionFor(run: QuestionRun, request: QuestionRequest | undefined, onAnswer: AnswerQuestion): ComposerQuestionProps | undefined {
  if (!request || !asksInComposer(request) || sentReply(run, request.requestId)) return undefined;
  return { request, waiting: (run?.questions.length ?? 1) - 1, onAnswer };
}

/** A question that keeps its own card: a Milagre secret, a bug report, a masked question. */
export function cardQuestion(request: QuestionRequest | undefined): QuestionRequest | undefined {
  return request && !asksInComposer(request) ? request : undefined;
}

export function questionCardProps(run: QuestionRun, request: QuestionRequest, onAnswer: AnswerQuestion) {
  return { request, waiting: (run?.questions.length ?? 1) - 1, answering: sentReply(run, request.requestId), onAnswer };
}

export function questionAnswerer(
  agents: AgentRuns,
  chatId: string | null | undefined,
  request: QuestionRequest | undefined,
  onError: (message: string) => void,
) {
  return (answers: QuestionAnswers | null, images?: QuestionImages) => {
    if (chatId && request) void agents.answerQuestion(chatId, request.requestId, answers, images).catch((failure) => onError(ipcErrorMessage(failure)));
  };
}

export function chatApprovalSlots(props: ChatApprovalProps) {
  return {
    approval: approvalShown(props) ? <ChatApproval {...props} /> : undefined,
    question: composerQuestionFor(props.run, props.pendingQuestion, props.onAnswerQuestion),
  };
}

function ChatApproval(props: ChatApprovalProps) {
  const { chatId, run, pendingApproval, approvalCard, pendingQuestion, questionSent } = props;
  const runs = useRuns(props.remoteDelegations.length > 0);
  const card = cardQuestion(pendingQuestion);
  return (
    <div className="flex w-full flex-col gap-2">
      <SubchatWaitingNote messages={props.messages} ask={pendingApproval ? "approval" : "question"} />
      {pendingApproval ? (
        approvalCard && (
          <PermissionCard
            key={`${chatId}:${approvalCard.requestId}`}
            request={approvalCard}
            waiting={(run?.approvals.length ?? 1) - 1}
            answering={sentDecision(run, approvalCard.requestId)}
            onAnswer={props.onAnswerApproval}
          />
        )
      ) : card ? (
        <div className={questionSent ? "hidden" : "contents"}>
          <QuestionCard
            key={`${chatId}:${card.requestId}`}
            {...questionCardProps(run, card, props.onAnswerQuestion)}
            startedAt={run?.startedAt}
            dictationChat={props.dictationChat}
          />
        </div>
      ) : null}
      {props.remoteDelegations.map((delegation) => (
        <RemoteDelegationCard
          key={delegation.id}
          delegation={delegation}
          run={delegation.to_chat ? runs[delegation.to_chat] : undefined}
          onAnswer={(requestId, decision) => {
            if (delegation.to_chat) void props.onRespond(delegation.to_chat, requestId, decision).catch(() => {});
          }}
          onOpenChat={props.onOpenChat}
          onStop={(key) => void props.onInterrupt(key).catch(() => {})}
        />
      ))}
    </div>
  );
}
