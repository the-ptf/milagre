import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { alwaysAllowLabel, approvalKind } from "@milagre/shared/approval-copy";
import { SETUP_APPROVAL_COPY } from "@milagre/shared/model-copy";
import type { PermissionDecision, PermissionRequest } from "../../model";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { approvalNote, approvalParameters } from "./PermissionCard";
import { ApprovalTitle } from "./tool-approval";

/** The open Chat's oldest approval, for the transcript row of the tool step it is about. */
export interface StepApproval {
  stepId: string;
  request: PermissionRequest;
  /** How many more requests are queued behind this one. */
  waiting: number;
  /** The answer already sent, while the agent takes it. */
  answering: PermissionDecision | null;
  onAnswer: (decision: PermissionDecision) => void;
  /** The row showing it says so; the release runs when it stops. */
  claim: (requestId: string) => () => void;
}

const StepApprovalContext = createContext<StepApproval | null>(null);
export const StepApprovalProvider = StepApprovalContext.Provider;

/**
 * The approval the transcript shows on its tool row, and whether a row took it. While no row does (the step isn't on
 * screen, or the request names no step), the caller keeps its card above the composer.
 */
export function useStepApprovalScope(
  request: PermissionRequest | undefined,
  waiting: number,
  answering: PermissionDecision | null,
  onAnswer: (decision: PermissionDecision) => void,
): { value: StepApproval | null; inline: boolean } {
  const [claimed, setClaimed] = useState<string | null>(null);
  const holders = useRef(new Map<string, number>());
  const claim = useCallback((requestId: string) => {
    holders.current.set(requestId, (holders.current.get(requestId) ?? 0) + 1);
    setClaimed(requestId);
    return () => {
      const left = (holders.current.get(requestId) ?? 1) - 1;
      if (left > 0) holders.current.set(requestId, left);
      else {
        holders.current.delete(requestId);
        setClaimed((current) => (current === requestId ? null : current));
      }
    };
  }, []);
  // The latest handler, without a new context value (and every row re-rendering) on each parent render.
  const answer = useRef(onAnswer);
  useLayoutEffect(() => {
    answer.current = onAnswer;
  });
  const respond = useCallback((decision: PermissionDecision) => answer.current(decision), []);
  const value = useMemo(
    () => (request?.stepId ? { stepId: request.stepId, request, waiting, answering, onAnswer: respond, claim } : null),
    [request, waiting, answering, respond, claim],
  );
  return { value, inline: Boolean(request && claimed === request.requestId) };
}

/** The step's approval when it is the one waiting, else null. The row that asks shows it, so the card above the composer goes. */
export function useStepApproval(stepId: string | undefined): StepApproval | null {
  const value = useContext(StepApprovalContext);
  const match = value && stepId && value.stepId === stepId ? value : null;
  const requestId = match?.request.requestId;
  const claim = match?.claim;
  useLayoutEffect(() => (requestId && claim ? claim(requestId) : undefined), [requestId, claim]);
  return match;
}

/** The step id of the approval the transcript shows on a row, for a fold that picks which row to put in front. */
export function useStepApprovalId(): string | undefined {
  return useContext(StepApprovalContext)?.stepId;
}

/** The state on a tool row that waits for the user: an orange dot and orange-ink words, as the top bar's waiting chip. */
export function WaitingForApproval({ label = "Waiting for approval", className = "text-11" }: { label?: string; className?: string }) {
  return (
    <span aria-hidden data-waiting-approval className={`flex shrink-0 items-center gap-1.5 text-orange-ink ${className}`}>
      <span className="size-1.5 rounded-full bg-orange" />
      {label}
    </span>
  );
}

/**
 * A tool row waiting for approval: the row as it is, then what the agent says it is for, and Deny, Always allow and
 * Allow once right under it. What it would run or change opens beneath.
 */
export function InlineApproval({
  approval,
  title,
  className = "",
  children,
}: {
  approval: StepApproval;
  title: string;
  /** Layout only: a fold that hangs its rows into the gutter keeps the card on the column's edges. */
  className?: string;
  children: ReactNode;
}) {
  const { request, waiting, answering, onAnswer } = approval;
  const parameters = approvalParameters(request, { title });
  // A diff or a tool's raw input is what gets approved: open at once. A folder alone waits behind Details.
  const [open, setOpen] = useState(() => parameters.some((parameter) => parameter.id !== "cwd" && parameter.id !== "files"));
  // The row already names a command or an edit ("Run `npm test`", "Edited `a.ts`"); another tool's own title ("Create
  // a Linear issue?") shows under it when it says something the row doesn't.
  const plain = (text: string) => text.replace(/`/g, "").replace(/\?$/, "").trim();
  const own =
    request.kind !== "command" && request.kind !== "edit" && plain(request.title) !== plain(title) && plain(request.title) !== "Allow this tool to run"
      ? request.title
      : "";
  const note = approvalNote(request, waiting);
  const setup = request.kind === "setup";
  const detailsId = `approval-details-${request.requestId}`;
  return (
    <section
      role="group"
      aria-label="Tool approval"
      aria-description={`${approvalKind(request)}: ${plain(request.title)}`}
      aria-busy={answering !== null && answering !== "deny"}
      data-slot="step-approval"
      // Flat, like the transcript's other tool blocks: a hairline, no shadow. Allow once (ink) carries the emphasis.
      // Its border sits on the column's edges and its content 12px in, so the row inside (--row-inset 12px) keeps its
      // glyph and time on the same lines as a tool row outside a block.
      className={`flex min-w-0 flex-col rounded-card border border-line-strong bg-surface pt-1.5 pb-3 [--row-inset:12px] ${className}`}
    >
      {children}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 px-3 pt-1">
        <div className="min-w-0 flex-1 basis-56 text-12 text-ink-2">
          {own && (
            <p className="font-medium text-ink">
              <ApprovalTitle title={own} />
            </p>
          )}
          {note && <p>{note}</p>}
          {parameters.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen(!open)}
              className="-ml-1 inline-flex h-6 items-center gap-1 rounded-control px-1 text-12 font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            >
              Details
              <span aria-hidden className={`flex transition-transform duration-base ease-enter ${open ? "rotate-180" : ""}`}>
                <Icon icon={ArrowDown01Icon} size={12} />
              </span>
            </button>
          )}
        </div>
        {answering === null ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="danger-ghost" size={28} onClick={() => onAnswer("deny")}>
              {setup ? SETUP_APPROVAL_COPY.deny : "Deny"}
            </Button>
            {request.allowForChat && (
              <Button variant="secondary" size={28} onClick={() => onAnswer("allow-for-chat")}>
                {alwaysAllowLabel(request)}
              </Button>
            )}
            <Button size={28} onClick={() => onAnswer("allow")}>
              {setup ? SETUP_APPROVAL_COPY.allow : "Allow once"}
            </Button>
          </div>
        ) : (
          <p role="status" className="flex h-7 shrink-0 items-center gap-2 text-12 text-ink-3">
            {answering !== "deny" && <SpinnerRing size={12} stroke={1.6} />}
            {answering === "deny" ? "Denied" : "Allowing…"}
          </p>
        )}
      </div>
      {open && parameters.length > 0 && (
        <div id={detailsId} className="mt-3 grid gap-3 border-t border-line px-3 pt-3">
          {parameters.map((parameter) => (
            <div key={parameter.id} className="grid gap-1 text-12">
              <span className="font-medium text-ink-3">{parameter.label}</span>
              <div className="min-w-0 break-words text-ink-2">{parameter.value}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
