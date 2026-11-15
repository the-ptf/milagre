import { memo, useCallback, useLayoutEffect, useRef, type ComponentProps } from "react";
import { ChatReply } from "./chat-reply";
import { useRun } from "./session";
import { router } from "expo-router";
import type { ChatMessage, ChatStep, RoutineRunContext } from "@milagre/shared/model";
import type { Client } from "./client";
import { showBrief } from "./handoff-brief-store";
import { exchangeText, linkedContext, linkedLine, type LinkedExchange } from "@milagre/shared/linked-message";
import { LinkedMessageLine } from "./linked-message-line";
import { RoutineRunDivider } from "./routine-run-divider";
import { isRoutineRun, routineRunOf } from "@milagre/shared/routines";
import { Approval } from "./questions";
import { subchatNote, subchatNotes, suggestionArguments } from "./subchat-notes";
import { SubchatNoteView } from "./subchat-note";

import type { AgentRun } from "@milagre/shared/agent-runs";

export function issueRunDivider(message: ChatMessage, merged?: { count: number; last: RoutineRunContext }) {
  const run = isRoutineRun(message) ? null : routineRunOf(message);
  return run ? <RoutineRunDivider context={run} merged={merged} /> : null;
}

export function transcriptRows({
  outcomes,
  client,
  chatId,
  actionBusy,
  action,
  openFamilyChat,
  onOpenFamilyChat,
}: {
  outcomes: ReturnType<typeof subchatNotes>["outcomes"];
  client: Client;
  chatId: string;
  actionBusy: boolean;
  action: (work: () => Promise<unknown>, allowPending?: boolean) => Promise<unknown>;
  openFamilyChat: (key: string) => void;
  onOpenFamilyChat: (key: string) => void;
}) {
  const renderSubchatNote = (message: ChatMessage) => {
    const note = subchatNote(message);
    return note ? (
      <SubchatNoteView
        note={note}
        outcomes={outcomes}
        onOpenChat={onOpenFamilyChat}
        onSend={(suggestion) => client.call("agent:answer-question", [suggestionArguments(suggestion)])}
        onDismiss={(id) => client.call("agent:dismiss-suggestion", [{ chatId, id }])}
      />
    ) : null;
  };
  const renderLinkedLine = (message: ChatMessage, exchange?: LinkedExchange) => {
    const line = exchange?.line ?? (message.role === "user" ? linkedLine(linkedContext(message)) : null);
    if (!line) return null;
    const chat = line.chat;
    return (
      <LinkedMessageLine
        line={line}
        count={exchange?.count}
        attachments={exchange ? 0 : (message.images?.length ?? 0) + (message.files?.length ?? 0)}
        onOpen={() => {
          showBrief(exchange ? exchangeText(exchange) : message.body, exchange ? `Messages with ${line.name}` : `${line.verb} ${line.name}`, {
            ...(line.label !== line.name ? { subtitle: line.label } : {}),
            ...(chat ? { openChat: () => openFamilyChat(chat) } : {}),
          });
          router.push("/handoff-brief");
        }}
      />
    );
  };
  const renderToolApproval = (approval: AgentRun["approvals"][number]) => (
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
  return { renderSubchatNote, renderLinkedLine, renderToolApproval };
}

/** The streaming reply, reading its turn itself, so a streamed batch renders it alone. It hands its steps to `onSteps`. */
export const LiveReply = memo(function LiveReply({
  chatKey,
  onSteps,
  ...reply
}: { chatKey: string; onSteps: (steps: readonly ChatStep[] | undefined) => void } & Omit<ComponentProps<typeof ChatReply>, "run" | "message">) {
  const run = useRun(chatKey);
  const steps = run?.steps;
  useLayoutEffect(() => {
    onSteps(steps);
  }, [onSteps, steps]);
  useLayoutEffect(() => () => onSteps(undefined), [onSteps]);
  return run ? <ChatReply run={run} {...reply} /> : null;
});

/** The running turn's steps, kept by LiveReply as they stream, for the Chat's links to read when a file is tapped. */
export function useLiveSteps() {
  const liveSteps = useRef<readonly ChatStep[] | undefined>(undefined);
  const onLiveSteps = useCallback((steps: readonly ChatStep[] | undefined) => {
    liveSteps.current = steps;
  }, []);
  return { liveSteps, onLiveSteps };
}
