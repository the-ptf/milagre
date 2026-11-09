# Named Links own shared Chats across isolated Worktrees

A named Link in the desktop selector is an ordered set of at least two Projects. Its Chats have one canonical transcript and provider session, saved in the runtime profile. A Chat's first message fixes its member Projects and reserves its own folder, but creates no Worktree. The agent reads each member in its main checkout, and calls Milagre's `link_worktree` tool before it changes one: that creates and owns the Chat's Worktree in that Project only, so Projects the Chat never changes get none. Sending again, restarting or handing over reuses the Worktrees already made. The user can rename a Link and add or remove member Projects at any time; only Chats started afterwards use the new membership, and a Chat's own member Projects never change. A member whose folder is unavailable can still be removed.

A Chat from before Worktrees were made on demand keeps the full set it made on its first message.

This extends the one-Worktree Chat rule. A shared Chat can edit all of its own isolated Worktrees under its selected permission mode, including one made during the running turn. It reads the member main checkouts without asking, and never edits them: they are outside its owned set. It cannot edit unrelated canvas-linked Worktrees; ADR-0002's read-only context and Delegation rules still apply there. Project reconciliation must not create another independent editable Chat in a shared Chat's Worktree.

The daemon is still the sole writer, takes ownership of a member repository and records that member's preparation before Git mutation. A member that fails to be made fails only the tool call that asked for it. Missing members block new turns without deleting the transcript or silently shrinking membership.

Named Link metadata is stored separately from canvas edges. Existing canvas edges are not converted or created implicitly. A shared Chat uses explicit Link scope identity, not an arbitrarily selected member Project as its canonical owner. Git operations always target an explicitly selected member Worktree.
