import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import { sentDecision } from "../../lib/agent-runs";
import type { AgentRun } from "../../lib/agent-runs";
import { remoteRunStatus, replyTail } from "../../lib/remote-delegation";
import type { RemoteRunStatus } from "../../lib/remote-delegation";
import type { OpenDelegation, PermissionDecision } from "../../model";
import { PermissionCard } from "./PermissionCard";

const STATUS: Record<RemoteRunStatus, string> = {
  sending: "Sending",
  starting: "Starting",
  approval: "Waiting for approval",
  question: "Waiting on a question",
  working: "Working",
};

/**
 * A Delegation this Chat sent to another computer, mirrored live (spec 2026-10-23): the turn runs there, in its own Chat,
 * and this card follows that computer's events. Its approvals can be answered here or there; the first answer wins and
 * the other card clears. Open goes to that Chat; Stop stops its turn.
 */
export function RemoteDelegationCard({
  delegation,
  run,
  onAnswer,
  onOpenChat,
  onStop,
}: {
  delegation: OpenDelegation;
  /** The other computer's live run of that Chat, while its turn runs. */
  run: AgentRun | undefined;
  onAnswer: (requestId: string, decision: PermissionDecision) => void;
  onOpenChat: (chatKey: string) => void;
  onStop: (chatKey: string) => void;
}) {
  const status = remoteRunStatus(delegation, run);
  const step = run?.steps.findLast((item) => item.status === "running") ?? run?.steps.at(-1);
  const tail = run ? replyTail(run.text) : "";
  const approval = run?.approvals[0];
  const chat = delegation.to_chat;
  return (
    <div
      data-slot="remote-delegation"
      data-status={status}
      className="flex w-full flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]"
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon icon={LaptopIcon} size={16} className="mt-px shrink-0 text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">Running on {delegation.computer?.name}</p>
          <p className="truncate text-[12px] text-ink-3">
            {STATUS[status]} · {delegation.to_label}
          </p>
        </div>
        {chat && (
          <div className="flex shrink-0 gap-1.5">
            <button type="button" className="rounded-[8px] border border-line px-2 py-1 text-[12px] hover:bg-hover" onClick={() => onOpenChat(chat)}>
              Open
            </button>
            {run && (
              <button type="button" className="rounded-[8px] border border-line px-2 py-1 text-[12px] hover:bg-hover" onClick={() => onStop(chat)}>
                Stop
              </button>
            )}
          </div>
        )}
      </div>
      {step && <p className="truncate text-[12px] text-ink-2">{step.title}</p>}
      {tail && <p className="max-h-32 overflow-hidden whitespace-pre-wrap text-[12px] text-ink-3">{tail}</p>}
      {approval && (
        <PermissionCard
          key={approval.requestId}
          variant="inline"
          request={approval}
          waiting={(run?.approvals.length ?? 1) - 1}
          answering={sentDecision(run, approval.requestId)}
          onAnswer={(decision) => onAnswer(approval.requestId, decision)}
        />
      )}
    </div>
  );
}
