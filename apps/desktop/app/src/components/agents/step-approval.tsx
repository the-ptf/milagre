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

export interface StepApproval {
  stepId: string;
  request: PermissionRequest;
  waiting: number;
  answering: PermissionDecision | null;
  onAnswer: (decision: PermissionDecision) => void;
  claim: (requestId: string) => () => void;
}

const StepApprovalContext = createContext<StepApproval | null>(null);
export const StepApprovalProvider = StepApprovalContext.Provider;

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

export function useStepApproval(stepId: string | undefined): StepApproval | null {
  const value = useContext(StepApprovalContext);
  const match = value && stepId && value.stepId === stepId ? value : null;
  const requestId = match?.request.requestId;
  const claim = match?.claim;
  useLayoutEffect(() => (requestId && claim ? claim(requestId) : undefined), [requestId, claim]);
  return match;
}

export function useStepApprovalId(): string | undefined {
  return useContext(StepApprovalContext)?.stepId;
}

export function WaitingForApproval({ label = "Waiting for approval", className = "text-11" }: { label?: string; className?: string }) {
  return (
    <span aria-hidden data-waiting-approval className={`flex shrink-0 items-center gap-1.5 text-orange-ink ${className}`}>
      <span className="size-1.5 rounded-full bg-orange" />
      {label}
    </span>
  );
}

export function InlineApproval({
  approval,
  title,
  className = "",
  children,
}: {
  approval: StepApproval;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const { request, waiting, answering, onAnswer } = approval;
  const parameters = approvalParameters(request, { title });
  const [open, setOpen] = useState(() => parameters.some((parameter) => parameter.id !== "cwd" && parameter.id !== "files"));
  // The row already names a command or an edit ("Run `npm test`", "Edited `a.ts`"); another tool's own title ("Create
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
      className={`flex min-w-0 flex-col rounded-card border border-line-strong bg-surface pt-1.5 pb-3 [--row-bleed:0px] [--row-inset:12px] ${className}`}
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
