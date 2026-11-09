# Named Links own shared Chats across isolated Worktrees

A named Link in the desktop selector is an ordered set of at least two Projects. Its Chats have one canonical transcript and provider session, saved in the runtime profile. Each Chat creates and owns one Worktree in every member Project on its first message. Sending again, restarting or handing over reuses that set. The user can rename a Link and add or remove member Projects at any time; only Chats started afterwards use the new membership, and a Chat's own Worktree set never changes. A member whose folder is unavailable can still be removed.

This extends the one-Worktree Chat rule. A shared Chat can edit all of its own isolated Worktrees under its selected permission mode. It cannot edit unrelated canvas-linked Worktrees; ADR-0002's read-only context and Delegation rules still apply there. Project reconciliation must not create another independent editable Chat in a shared Chat's Worktree.

The daemon is still the sole writer, takes ownership of every member repository and records preparation before Git mutation. Partial preparation never starts a provider. Missing members block new turns without deleting the transcript or silently shrinking membership.

Named Link metadata is stored separately from canvas edges. Existing canvas edges are not converted or created implicitly. A shared Chat uses explicit Link scope identity, not an arbitrarily selected member Project as its canonical owner. Git operations always target an explicitly selected member Worktree.
