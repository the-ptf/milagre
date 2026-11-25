# Links

Who may edit which Worktree when Projects are linked: Delegation across canvas Links, shared Chats in Named Links, and existing Worktrees adopted into one shared Chat.

## One agent edits a Worktree

When a Chat in X wants changes in a linked Worktree Y, it sends a Delegation that Y's own agent carries out. X's agent can read Y but never writes to it. So two agents never edit the same files at once, approvals and history stay in Y's Chat, and the agent that already knows Y does the work.

- Changes in Y are asynchronous. X learns the outcome from a Delegation report, or from a Negotiation when both sides must agree.
- Reads of the other side go through Milagre's read-only query tools, not the agent's own file permissions, which Codex's sandbox limits.
- A Delegation inside one Project makes the target a Subchat of the sender.

Rejected: giving X's agent write access to Y (two agents in one Worktree, and Y's Chats keep no record of the change); allowing both case by case (every request reopens "who edits?").

The shared Chats below are the only exception, and each owns its Worktrees outright.

## Named Links

A Named Link is an ordered set of two or more Projects. Its Chats have one transcript and one provider session, saved in the runtime profile. Each Chat works in one folder that holds a link per member Project, named after the Project (with its position added only when two members share a name). A member starts as its main checkout, read-only; the agent's first change there goes through `link_worktree_create`, which makes the Chat's Worktree in that Project and points the link at it. Every member Worktree of one Chat gets the same branch name, so one change across repositories reads as one branch. Sending again, restarting or handing over reuses that set.

- Opening a folder that holds repositories, or one with a `.code-workspace` file (its listed folders count even outside the folder), offers to add them as Projects in one Named Link, named after the workspace file or the folder. Desktop and phone share the rule and copy in `@milagre/shared/project-list`.
- The Chat may edit all of its own Worktrees under its permission mode. Canvas-linked Worktrees outside its set keep the read-only and Delegation rules.
- Renaming or changing members affects only Chats started afterwards; a Chat's own set never changes. An unavailable member can still be removed.
- The daemon owns every member repository and records preparation before any Git change. Partial preparation never starts a provider. A missing member blocks new turns without deleting the transcript or shrinking membership.
- Named Link metadata is stored apart from canvas edges, and neither creates the other. A shared Chat uses an explicit Link scope, never an arbitrary member as owner. Git operations always target an explicitly chosen member Worktree.
- Project reconciliation must never create a second editable Chat in a shared Chat's Worktree.

## Shared Chat on existing Worktrees

On a Worktree-to-Worktree canvas Link, the user can pick Shared Chat (desktop or phone, or when desktop creates the Link). Separate Chats stay the default.

- The shared Chat adopts the two existing isolated Worktrees, one per Project, through the same Link scope, store, aliases and access roots. It creates no branches, moves no files, reruns no setup and merges no transcripts. Main checkouts, whole-Project Links and two Worktrees of one Project have no sharing action.
- Earlier Chats in either Worktree stay readable under their own identity and become permanently read-only: no new turns, no Heartbeats, no Undo or Redo (the host refuses restores, even from previews taken before). Both canvas cards open the shared Chat, which has a new provider session and task list.
- One permission mode covers both Worktrees, Ask at first, saved on the host. A stale or arbitrary `permissionMode` on a send can't raise it.
- Transfer refuses while there are active turns, background tasks, queued messages, pending resumptions or an active Heartbeat (Babysit PR included); it never stops work implicitly. Shared Chats can't create Heartbeats.
- Ownership changes are saved before Project reconciliation, in both directions, so an interrupted switch is finished by retrying (the canvas shows Finish switching). An interrupted adoption blocks provider start meanwhile.
- Switching back keeps the shared conversation read-only and starts new separate Chats; old provider sessions never reactivate. A Link returns to separate Chats before it can be removed.
- Adopted groups are not Named Links: their Worktrees aren't disposable, even when clean, so they can't be deleted as one.
- Read-only governs the Chat and its agent. A user's Terminal in that Worktree is still a manual editing surface, not a sandbox.
