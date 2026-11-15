import type { ComponentProps } from "react";
import { RemoteDelegationCard } from "../components/agents/RemoteDelegationCard";
import { SubchatWaitingNote } from "../components/agents/SubchatMessages";
import { QuestionCard } from "../components/lazy-views";
import { sentDecision, sentReply, type AgentRun } from "../lib/agent-runs";
import { lazyView } from "../lib/lazy-view";
import { pendingWaitingNote } from "../lib/subchat-transcript";
import type { ChatMessage, OpenDelegation, PermissionDecision } from "../model";

export const PermissionCard = lazyView(() => import("../components/agents/PermissionCard").then((module) => module.PermissionCard));

type PermissionRequest = ComponentProps<typeof PermissionCard>["request"];
type QuestionProps = ComponentProps<typeof QuestionCard>;

export type ChatApprovalProps = {
  /** The open Chat's key, which keys the cards so another Chat's never reuses them. */
  chatId: string;
  run: AgentRun | undefined;
  runs: Record<string, AgentRun>;
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

/** Whether the composer's approval slot has anything to show. */
export function approvalShown({ approvalCard, pendingQuestion, remoteDelegations, pendingApproval, messages }: ChatApprovalProps) {
  return Boolean(approvalCard || pendingQuestion || remoteDelegations.length || (pendingApproval && pendingWaitingNote(messages)?.ask === "approval"));
}

export function ChatApproval(props: ChatApprovalProps) {
  const { chatId, run, pendingApproval, approvalCard, pendingQuestion, questionSent } = props;
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
      ) : pendingQuestion ? (
        <div className={questionSent ? "hidden" : "contents"}>
          <QuestionCard
            key={`${chatId}:${pendingQuestion.requestId}`}
            request={pendingQuestion}
            waiting={(run?.questions.length ?? 1) - 1}
            answering={sentReply(run, pendingQuestion.requestId)}
            onAnswer={props.onAnswerQuestion}
            startedAt={run?.startedAt}
            dictationChat={props.dictationChat}
          />
        </div>
      ) : null}
      {props.remoteDelegations.map((delegation) => (
        <RemoteDelegationCard
          key={delegation.id}
          delegation={delegation}
          run={delegation.to_chat ? props.runs[delegation.to_chat] : undefined}
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
