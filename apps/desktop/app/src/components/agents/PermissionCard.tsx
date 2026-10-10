import { NEGOTIATION_ROUNDS } from "@milagre/shared/limits";
import type { PermissionDecision, PermissionRequest } from "../../model";
import { ToolApproval, ToolApprovalCode } from "./tool-approval";
import type { ToolApprovalParameter } from "./tool-approval";

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
  const parameters: ToolApprovalParameter[] = [];
  // A Delegation's card: where it goes and what it says, as the receiving agent will read it.
  if (request.delegation) {
    parameters.push({ id: "target", label: "To", value: request.delegation.target });
    parameters.push({ id: "message", label: "Message", value: <span className="whitespace-pre-wrap">{request.delegation.message}</span> });
  }
  if (request.command)
    parameters.push({ id: "command", label: "Command", value: <ToolApprovalCode code={request.command} language="bash" plain={variant === "inline"} /> });
  if (request.cwd) parameters.push({ id: "cwd", label: "Folder", value: <span className="font-mono">{request.cwd}</span> });
  if (request.files?.length)
    parameters.push({
      id: "files",
      label: request.files.length === 1 ? "File" : "Files",
      value: <span className="whitespace-pre-wrap font-mono">{request.files.join("\n")}</span>,
    });
  if (request.diff)
    parameters.push({ id: "diff", label: "Changes", value: <ToolApprovalCode code={request.diff} language="diff" plain={variant === "inline"} /> });
  if (request.detail)
    parameters.push({ id: "detail", label: "Details", value: <ToolApprovalCode code={request.detail} language="json" plain={variant === "inline"} /> });
  if (request.reason) parameters.push({ id: "reason", label: "Reason", value: request.reason });
  const queued = waiting > 0 ? `${waiting} more ${waiting === 1 ? "request is" : "requests are"} waiting after this one.` : "";
  const negotiation = request.delegation?.negotiation ? `Negotiation, up to ${NEGOTIATION_ROUNDS} rounds.` : "";
  const description = [request.description, negotiation, queued].filter(Boolean).join(" ");
  return (
    <ToolApproval
      variant={variant}
      tool={request.tool}
      title={request.title}
      description={description || undefined}
      status={answering === null ? "pending" : answering === "deny" ? "denied" : "approving"}
      defaultOpen
      parameters={parameters}
      onApprove={() => onAnswer("allow")}
      onAlwaysAllow={request.allowForChat ? () => onAnswer("allow-for-chat") : undefined}
      alwaysAllowLabel={request.kind === "delegation" ? "Always allow for this Link in this chat" : "Always allow in this chat"}
      onDeny={() => onAnswer("deny")}
    />
  );
}
