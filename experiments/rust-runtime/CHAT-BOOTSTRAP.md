# Dedicated Project metadata

The default-disabled `chat-runtime` bootstrap supplies actual coordination-state
metadata required by both frontends. The starter has `agent_name:"main"` and
`status:"Created"`; its Worktree has `project_id:1`. The state also has Node's
local `projects:{1:{id:1,name:"Rust Chat"}}` and `tasks:{}` containers.

Names come from explicit dedicated configuration: Project `Rust Chat`, primary
Worktree `main`. No folder scanning, installed registry or account discovery is
used. Dedicated Worktree 1, Chat 1 and `next_id:10` reservations remain unchanged.
The Node oracle reconciles that explicit scaffold, rather than claiming the same
allocation as Node's empty-state discovery (which would allocate Chat 2).

## Existing marked dedicated roots

After the actual ChatHost opens its Project and proves readiness, the runtime
fills only absent `project_id` on the pinned primary Worktree, `agent_name` on its
plain Chats, and missing top-level `projects`/`tasks` containers. It uses the
acquired `host.states` writer, flushes, and verifies readiness again before the
wire server binds. The captured dedicated data-root authority is checked on both
sides. A failed update/flush is an error, not an accepted repair.

Existing fields, even explicit null/empty fields, are preserved. Missing legacy
`status` stays absent, as Node's `reconcileState` also preserves its absence;
`Created` is supplied only when constructing the new starter. Existing partial
`projects`/`tasks` containers are not replaced. Shared/Link/foreign Worktrees and
their sessions are not reconciled, removed or imported by this repair. Messages,
summary activity times, ids, names, provider preferences and native sessions are
not rewritten. Broader existing-profile adoption remains unavailable.

## Evidence

`fixtures/chat-bootstrap-node.cjs` invokes the real `project-state.cjs`
`reconcileState` with explicit synthetic discoveries. The Rust tests compare
complete fresh and legacy results, preserve existing fields and message identity,
and use a real isolated Project writer for saved-byte/restart/activity checks.
They also require a competing owner and a not-ready writer to refuse, and an
injected update failure to leave the disk unchanged. No provider runs.
