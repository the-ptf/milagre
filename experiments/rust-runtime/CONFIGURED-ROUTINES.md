# Dedicated paused routine storage

The default-disabled `chat-runtime` feature installs persistent routine CRUD for
the one explicitly owned dedicated Project. It uses `rust-routines`' descriptor
writer with the actual dedicated data-root lease and manifest check. There is no
Node backend, timer, due-work claim, trigger polling or automatic agent execution.

## Installed subset

- `routines:list` returns `{routines:[...rowsWithRuns]}`.
- `routines:create` requires explicit `enabled:false`, forces
  `createdBy:{kind:"user"}`, and returns `{routine}`. The atomic `CreatePaused`
  storage command equals Node create then disable at one clock value. No enabled
  file is published between those operations.
- `routines:update` returns the updated row. `routines:delete` returns
  `{removed:boolean}`. Their `routines:changed` events follow successful durable
  acceptance, matching Node's outer notification policy.
- `routines:enabled:read|save` return `{enabled:true,executionSupported:false}`.
  This is feature visibility, not scheduling support. Enabling a row refuses with
  `ROUTINE_EXECUTION_UNAVAILABLE`. Execution commands, including `routines:run-now`,
  are unadvertised and receive the wire's normal unknown-command refusal.

The unchanged React creation flow defaults to enabled and therefore refuses until
it explicitly requests a paused draft. This is stored-draft evidence, not a claim
that the production routine UI or execution workflow works.

CRUD requires explicit `project:open` on the connection plus a currently ready
owned Project. A supplied target must be either an existing, unarchived plain
Project Chat (`kind:chat`, canonical `<Project>#<numericId>`) or a new plain Chat
with the exact Project path and `workspace:project`. Worktrees, Links, computers,
foreign roots and extra authority fields in new-Chat requests refuse before
saving. Existing-Chat validation rejects `workspacePath`, `formerWorktree` and
archived sessions. A referenced `worktree_id` must resolve in actual owned state
to the same Worktree identity and exact dedicated Project path, without a shared
Chat grant. Foreign, missing and mismatched Worktrees refuse before saving.
Unknown Chats also refuse before saving.
An update without a new target preserves the saved target like Node. Disabled
rows whose targets later become unavailable remain listable and may be deleted
or retargeted; nothing executes them. A saved enabled row causes list to refuse
explicitly; a caller knowing its ID may disable or delete it.

## Ownership and shutdown

The actor serializes target checks with Project transitions and checks ownership
again after the durable reply. A failed final check withholds success/events and
revokes that captured service; the error warns that bytes may already be saved.
No uncertain mutation is retried. Project loss/forget revokes the service.

Shutdown drains terminals and closes the routine writer before releasing the
Project lock. A failed routine close retains the writer and data-root authority.
If the owner's busy gate refuses shutdown before closing starts, the actor may
resume but the routine store remains closed until explicit `project:open`, which
verifies and reopens it. A real owner save failure keeps shutdown pending; opening
does not bypass it, and explicit stop retry finishes after the fault is repaired.

## Evidence

`tests/configured-routines.cjs` drives the actual production Node wire client
through two fresh dedicated runtime lifetimes. It checks pre-open refusals,
paused create/update/list/delete, exact production Node target/store results and
file bytes, no change after refused enabling/foreign targets, notifications,
restart persistence, and exit/profile/socket/Project-lock cleanup. No provider
turn runs. Module tests cover archived/unknown/extra-authority targets and a late
owner refusal after rename. Actor tests cover both busy shutdown recovery and
actual failed-save retention before retry.

Checks use isolated Cargo targets; no installed app, live provider, production
profile, mobile fingerprint or network is touched by these tests. Full routine
execution remains required migration work.
