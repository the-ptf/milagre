# Chats stay available until the user deletes them

Chat menus on desktop and mobile offer Delete instead of Archive. Delete acts immediately without a confirmation step or explanatory callout and permanently removes the conversation, its saved SQLite messages and local Designs. The daemon stops its agent, Terminals, advisors and Heartbeats before deleting it.

An exclusively owned Milagre Worktree can be removed through the existing checked cleanup flow. Dirty, unpushed, shared, external and unchecked Worktrees stay; deleting one conversation never removes another Chat from a shared Worktree. A failed cleanup restores the Chat.

This supersedes ADR-0011's user-facing archive behavior. The Done/Reopen flow, scheduled archival, existing archived records and hidden Routine Run cleanup retain their saved format and restore support.

A Chat's menu actions belong to its own Project or Named Link. Starting a new Chat or switching Projects does not disable actions on existing Chats. Delete remains available while its Worktree check is pending; choosing Delete before that check returns keeps its files, and a late check cannot change the deletion mode.
