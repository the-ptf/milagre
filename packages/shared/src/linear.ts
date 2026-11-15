export type LinearViewer = { name: string; email: string };
export type LinearOrganization = { name: string; urlKey: string };
/** One connected workspace; `id` is its URL key in lower case. `canWrite` is false for a sign-in that can only read issues. */
export type LinearWorkspace = { id: string; viewer: LinearViewer; organization: LinearOrganization; canWrite?: boolean };
/** `viewer` and `organization` repeat the first workspace; a Mac that predates workspaces sends no `workspaces`. */
export type LinearStatus =
  | { connected: false; workspaces?: LinearWorkspace[] }
  | { connected: true; viewer: LinearViewer; organization: LinearOrganization; workspaces?: LinearWorkspace[] };

export const LINEAR_TITLE = "Linear";
export const LINEAR_HINT = "Start chats from Linear issues and see each Worktree's issue.";
export const LINEAR_CONNECTING = "Finish signing in to Linear in your browser.";

export const LINEAR_MOVE_TO_STARTED_TITLE = "Move issues to In Progress";
export const LINEAR_MOVE_TO_STARTED_HINT = "When a chat starts from an issue that hasn't started yet, move it to its team's first started status.";
/** A sign-in made before Milagre asked to change issues; signing in to it again (on the Mac) grants that. */
export function linearReadOnlyHint(where: "mac" | "phone"): string {
  return `Can't move issues yet. Sign in to this workspace again ${where === "mac" ? "with Add workspace" : "from Settings on your Mac"} to allow it.`;
}

export const LINEAR_ADD_WORKSPACE = "Add workspace";
export const LINEAR_ADD_WORKSPACE_HINT =
  "Opens a Linear sign-in of its own, so you can use another account. Signing in to a workspace already here signs it in again.";
export const LINEAR_CONNECTING_WINDOW = "Finish signing in in the Linear window, or use your browser instead.";
export const LINEAR_USE_BROWSER = "Use my browser instead";
/** What a sign-in that was replaced or whose window was closed rejects with: nothing to show. */
export const LINEAR_SIGN_IN_REPLACED = "Replaced by a newer Linear sign-in.";

/** The connected workspaces, oldest first, also from a Mac that predates workspaces. */
export function linearWorkspaces(status: LinearStatus | null | undefined): LinearWorkspace[] {
  if (!status) return [];
  if (status.workspaces) return status.workspaces;
  return status.connected ? [{ id: status.organization.urlKey.toLowerCase(), viewer: status.viewer, organization: status.organization }] : [];
}

export function linearWorkspaceLine(workspace: LinearWorkspace): string {
  return `${workspace.organization.name}, as ${workspace.viewer.name}`;
}

export function linearStatusLine(status: LinearStatus, where: "mac" | "phone"): string {
  const [only, ...more] = linearWorkspaces(status);
  if (only && !more.length) return `Connected as ${only.viewer.name} to ${only.organization.name}`;
  if (only) return `Connected to ${more.length + 1} workspaces`;
  return where === "mac" ? "Not connected" : "Connect Linear from Settings on your Mac";
}

export type LinearIssueState = { name: string; type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"; color: string };
/** `workspace` is the workspace the issue was read from; a Mac that predates workspaces sends none. */
export type LinearIssue = { key: string; title: string; url: string; branchName: string; description?: string; state: LinearIssueState; workspace?: string };
/** `workspace` is the one listed and `workspaces` every connected one, for the picker's tabs. */
export type LinearIssuesResult =
  | { issues: LinearIssue[]; workspace?: string; workspaces?: { id: string; name: string }[] }
  | { error: string; notConnected?: boolean };

export { issueFirstMessage } from "./linear-issue.mjs";

/** Shown when a linked Worktree's branch doesn't name its issue, so Linear can't see the work until the PR says so. */
export const LINK_PR_HINT = (key: string) => `Add "Fixes ${key}" to the PR description so Linear tracks it.`;

export function issueChipLabel(issue: LinearIssue): string {
  return `${issue.key} · ${issue.state.name}`;
}

/** The composer text a failed send gives back: an issue's message is never restored, only what the user typed. */
export function restoredDraft(body: string, typed: string, fromIssue: boolean): string {
  return fromIssue ? typed : typed || body;
}
