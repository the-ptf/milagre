// What an approval says, the same on desktop and phone: a plain-words kind above the title, the command once, and the
// label of its Always allow choice.
import type { PermissionRequest } from "./model.ts";
import { SETUP_APPROVAL_COPY } from "./model-copy.ts";

/** A command this long reads better in full under the title than as a chip inside it. */
const LONG_COMMAND = 80;

/**
 * The line above an approval's title: what kind of action it is, in words. The agent's own tool names (Bash, Shell,
 * Edit, Write) never show; other tools keep the name the request gives them (MCP: Linear, Send Message).
 */
export function approvalKind(request: Pick<PermissionRequest, "kind" | "tool">): string {
  if (request.kind === "command") return "Command";
  if (request.kind === "edit") return "File change";
  return request.tool;
}

/** Whether the title already shows the whole command, so the details don't repeat it. */
export function commandInTitle(request: Pick<PermissionRequest, "command">, title: string): boolean {
  const command = request.command?.trim();
  return Boolean(command && !command.includes("\n") && command.length <= LONG_COMMAND && title.includes(command));
}

/** The label of the request's Always allow choice. */
export function alwaysAllowLabel(request: Pick<PermissionRequest, "kind" | "delegation">): string {
  if (request.kind === "setup") return SETUP_APPROVAL_COPY.always;
  if (request.delegation?.computer) return `Always allow for ${request.delegation.computer} in this Chat`;
  if (request.kind === "delegation") return "Always allow for this Link in this Chat";
  return "Always allow in this Chat";
}
