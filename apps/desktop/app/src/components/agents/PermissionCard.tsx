import { NEGOTIATION_ROUNDS } from "@milagre/shared/limits";
import type { PermissionDecision, PermissionRequest } from "../../model";
import { SETUP_APPROVAL_COPY } from "@milagre/shared/model-copy";
import { alwaysAllowLabel, approvalKind, commandInTitle } from "@milagre/shared/approval-copy";
import { ToolApproval, ToolApprovalCode } from "./tool-approval";
import type { ToolApprovalParameter } from "./tool-approval";

/**
 * What an approval is about, as labelled rows: where a Delegation goes, the command (unless `title` already shows
 * all of it), its folder, the files and diff, the tool's raw input. `plain` drops the code blocks' frames.
 */
export function approvalParameters(request: PermissionRequest, { title, plain = false }: { title: string; plain?: boolean }): ToolApprovalParameter[] {
  const parameters: ToolApprovalParameter[] = [];
  // A Delegation's card: where it goes and what it says, as the receiving agent will read it.
  if (request.delegation) {
    parameters.push({ id: "target", label: "To", value: request.delegation.target });
    parameters.push({ id: "message", label: "Message", value: <span className="whitespace-pre-wrap">{request.delegation.message}</span> });
  }
  if (request.setup) {
    parameters.push({ id: "project", label: "Project", value: <span className="font-mono">{request.setup.projectPath}</span> });
    parameters.push({ id: "source", label: "Source", value: request.setup.source });
    parameters.push({ id: "computer", label: "Computer", value: request.setup.computer });
  }
  if (request.command && !commandInTitle(request, title))
    parameters.push({ id: "command", label: "Command", value: <ToolApprovalCode code={request.command} language="bash" plain={plain} /> });
  if (request.cwd) parameters.push({ id: "cwd", label: "Folder", value: <span className="font-mono">{request.cwd}</span> });
  if (request.files?.length)
    parameters.push({
      id: "files",
      label: request.files.length === 1 ? "File" : "Files",
      value: <span className="whitespace-pre-wrap font-mono">{request.files.join("\n")}</span>,
    });
  if (request.diff) parameters.push({ id: "diff", label: "Changes", value: <ToolApprovalCode code={request.diff} language="diff" plain={plain} /> });
  if (request.detail) parameters.push({ id: "detail", label: "Details", value: <ToolApprovalCode code={request.detail} language="json" plain={plain} /> });
  if (request.reason) parameters.push({ id: "reason", label: "Reason", value: request.reason });
  return parameters;
}

/** One line under the title: the agent's own description, a Negotiation's rounds, and how many more wait. */
export function approvalNote(request: PermissionRequest, waiting: number): string {
  const queued = waiting > 0 ? `${waiting} more ${waiting === 1 ? "request is" : "requests are"} waiting after this one.` : "";
  const negotiation = request.delegation?.negotiation ? `Negotiation, up to ${NEGOTIATION_ROUNDS} rounds.` : "";
  return [request.description, negotiation, queued].filter(Boolean).join(" ");
}

/** The open chat's oldest pending approval, with the exact command or change the agent wants to make. */
export function PermissionCard({
  request,
  waiting,
  answering,
  onAnswer,
  variant = "card",
}: {
  request: PermissionRequest;
  /** How many more requests are queued behind this one. */
  waiting: number;
  /** The answer already sent for this request, while the agent takes it. */
  answering: PermissionDecision | null;
  onAnswer: (decision: PermissionDecision) => void;
  variant?: "card" | "inline";
}) {
  const description = approvalNote(request, waiting);
  return (
    <ToolApproval
      variant={variant}
      tool={approvalKind(request)}
      title={request.title}
      description={description || undefined}
      status={answering === null ? "pending" : answering === "deny" ? "denied" : "approving"}
      defaultOpen
      parameters={approvalParameters(request, { title: request.title, plain: variant === "inline" })}
      onApprove={() => onAnswer("allow")}
      onAlwaysAllow={request.allowForChat ? () => onAnswer("allow-for-chat") : undefined}
      alwaysAllowLabel={alwaysAllowLabel(request)}
      onDeny={() => onAnswer("deny")}
      {...(request.kind === "setup" ? { approveLabel: SETUP_APPROVAL_COPY.allow, denyLabel: SETUP_APPROVAL_COPY.deny } : {})}
    />
  );
}
