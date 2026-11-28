import { useContext, useState } from "react";
import { alwaysAllowLabel, approvalKind } from "@milagre/shared/approval-copy";
import type { CanvasLive } from "@milagre/shared/canvas";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { PermissionDecision } from "../../model";
import { LIVE, quickApproval, quickQuestion } from "../../lib/canvas-open";
import { Button } from "../primitives/Button";
import Tooltip from "../primitives/Tooltip";
import { CanvasChatContext } from "./CanvasChat";

const MARGIN = 8;
const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

/**
 * Under a Chat's row on a closed card: the step it is on, or the approval or question it waits on, answered in place.
 * Each renders at exactly `liveHeight(live)` (lib/canvas-open.ts). Anything the card can't answer in one click opens the
 * Chat's window. Answered, the request leaves the run and the card goes back to the step line.
 */
export function CardLive({ chatKey, live, onOpen }: { chatKey: string; live: CanvasLive | undefined; onOpen: () => void }) {
  const context = useContext(CanvasChatContext);
  const actions = context?.actions;
  const [busy, setBusy] = useState<string | null>(null);
  const pending = live?.pending;
  if (!pending || !actions) {
    if (!live?.step) return null;
    return (
      <div data-canvas-step className="mt-1 flex h-4 min-w-0 items-center pl-5 text-12 text-ink-3">
        <span className="min-w-0 truncate">{live.step}</span>
      </div>
    );
  }
  const requestId = pending.request.requestId;
  const sending = busy === requestId;
  const act = (send: () => Promise<unknown>) => {
    setBusy(requestId);
    send().catch((error: unknown) => {
      setBusy(null);
      context.onError?.(ipcErrorMessage(error));
    });
  };
  const count = pending.more > 0 ? <span className="shrink-0 text-11 text-ink-3 tabular-nums">1 of {pending.more + 1}</span> : null;
  if (pending.kind === "approval") {
    const request = pending.request;
    const answer = (decision: PermissionDecision) => act(() => actions.respond(chatKey, requestId, decision));
    const what = request.command ?? request.description ?? request.title;
    return (
      <div
        data-canvas-approval={requestId}
        className="nodrag nopan mt-2 ml-5 flex flex-col rounded-control border border-orange bg-field p-[7px]"
        style={{ height: LIVE.approval - MARGIN }}
      >
        <div className="flex h-4 min-w-0 items-center gap-1.5 text-12">
          <span className="shrink-0 font-medium text-orange-ink">{approvalKind(request)}</span>
          <span className={`min-w-0 flex-1 truncate text-ink ${request.command ? "font-mono text-11" : "text-12"}`} title={what}>
            {what}
          </span>
          {count}
        </div>
        <div className="mt-1.5 flex h-6 items-center gap-1.5">
          {quickApproval(request) ? (
            <>
              <Button size={24} disabled={sending} data-canvas-allow onClick={() => answer("allow")}>
                Allow
              </Button>
              {request.allowForChat && (
                <Tooltip label={alwaysAllowLabel(request)}>
                  <Button variant="secondary" size={24} disabled={sending} data-canvas-allow-chat onClick={() => answer("allow-for-chat")}>
                    Always allow
                  </Button>
                </Tooltip>
              )}
              <Button variant="danger-ghost" size={24} disabled={sending} data-canvas-deny onClick={() => answer("deny")}>
                Deny
              </Button>
            </>
          ) : (
            <Button variant="secondary" size={24} data-canvas-review onClick={onOpen}>
              Review…
            </Button>
          )}
        </div>
      </div>
    );
  }
  const question = quickQuestion(pending.request);
  const heading = question?.question ?? pending.request.questions[0]?.question ?? "The agent asks you something.";
  const options = question ? [...question.options.map((option) => option.label), ...(question.allowOther ? [null] : [])] : [];
  const height = question ? LIVE.questionBase + options.length * LIVE.questionOption : LIVE.questionForm;
  return (
    <div
      data-canvas-question={requestId}
      className="nodrag nopan mt-2 ml-5 flex flex-col rounded-control border border-accent bg-field p-[7px]"
      style={{ height: height - MARGIN }}
    >
      <div className="flex h-8 min-w-0 items-start gap-1.5 text-12 leading-4">
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-ink">{heading}</span>
        {count}
      </div>
      {question ? (
        options.map((label) => (
          <button
            key={label ?? "other"}
            type="button"
            disabled={sending}
            data-canvas-option={label ?? "other"}
            onClick={() => (label === null ? onOpen() : act(() => actions.answerQuestion(chatKey, requestId, { [question.id]: [label] })))}
            className="mt-1 flex h-7 w-full min-w-0 items-center rounded-control border border-line bg-surface px-2 text-left text-12 text-ink-2 transition-colors enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-40"
          >
            <span className="min-w-0 truncate">{label === null ? "Other…" : label.replace(RECOMMENDED, "")}</span>
          </button>
        ))
      ) : (
        <div className="mt-1.5 flex h-6 items-center">
          <Button variant="secondary" size={24} data-canvas-answer onClick={onOpen}>
            Answer…
          </Button>
        </div>
      )}
    </div>
  );
}
