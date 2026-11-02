// The line a Chat shows when a Link on the canvas reaches its Worktree (context kind "worktree-linked"). Types: worktree-link.d.mts.

export function isWorktreeLinked(message) {
  return message?.context?.kind === "worktree-linked";
}

/**
 * What the line says after "Linked to": another Project by name with its branch (or how many Worktrees a whole-Project
 * Link reached), or, in the Chat's own Project, the other Worktree's branch.
 */
export function worktreeLinkLabel(context) {
  const [first, ...rest] = context.branches;
  if (context.sameProject)
    return { lead: rest.length ? `${context.branches.length} Worktrees` : "Worktree", project: null, detail: rest.length ? null : first };
  return { lead: null, project: context.project.name, detail: rest.length ? `· ${context.branches.length} Worktrees` : first };
}

/** The line as text: the message body, and the label screen readers and the transcript use. */
export function worktreeLinkText(context) {
  const label = worktreeLinkLabel(context);
  const name = [label.lead, label.project, label.detail].filter(Boolean).join(" ");
  return `Linked to ${name}${context.sameProject ? " in this Project" : ""}`;
}

/** The linked summary as the line opens it: without the tags that wrap it for the agent. */
export function linkedSummaryText(summary) {
  return summary
    .replace(/^\s*<linked_worktrees>\s*/, "")
    .replace(/\s*<\/linked_worktrees>\s*$/, "")
    .trim();
}

// A shared Link Chat gives a Project its Worktree only when the Chat changes that Project (link_worktree_create).

/** How a shared Link Chat's row counts its Worktrees. */
export function linkChatWorktreesLabel(count) {
  if (count === 0) return "No Worktree yet";
  return count === 1 ? "1 Worktree" : `${count} Worktrees`;
}

/** What a new shared Link Chat gets, as the Link dialog and an empty Chat say it. */
export const LINK_CHAT_WORKTREES_TEXT = "One Chat across the linked Projects. A Project gets a Worktree only when the Chat changes it.";

/** The same, for a Link being edited. */
export const LINK_UPDATE_WORKTREES_TEXT = "New Chats get a Worktree in a Project only when they change it. Chats already started keep theirs.";

/** A Link Project the Chat hasn't changed, in its Changes list. */
export const LINK_PENDING_WORKTREE_TEXT = "No Worktree yet. The Chat creates one when it changes this Project.";

const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** Why a Link can't be deleted yet: its Chats whose turn is running, by title. The daemon refuses with the same words. */
export function linkRunningText(titles) {
  const many = titles.length > 1;
  return `${listed(titles)} ${many ? "are" : "is"} running. Stop ${many ? "them" : "it"} before deleting the Link.`;
}

/**
 * The confirmation before a Named Link is deleted, on desktop and phone. `chats` counts its Chats not archived yet.
 * What it says is what link:delete does: Chats archived with their transcripts kept, untouched Worktrees removed.
 */
export function deleteLinkText(name, chats) {
  const closing =
    chats === 0
      ? "It has no Chats."
      : chats === 1
        ? "Its Chat is archived, and its transcript stays on disk."
        : `Its ${chats} Chats are archived, and their transcripts stay on disk.`;
  return {
    title: `Delete ${name}?`,
    message: `${closing} Worktrees without changes are removed. Ones with changes or unpushed commits stay, as Chats in their Projects. The Projects themselves don't change.`,
    action: "Delete Link",
  };
}

/** After a delete: the Worktrees it kept, now Chats in their Projects. Null when it kept none. */
export function deletedLinkText(name, kept) {
  if (!kept.length) return null;
  const count = kept.length === 1 ? "1 Worktree with changes stays in its Project" : `${kept.length} Worktrees with changes stay in their Projects`;
  return `Deleted ${name}. ${count}: ${kept.join(", ")}`;
}
