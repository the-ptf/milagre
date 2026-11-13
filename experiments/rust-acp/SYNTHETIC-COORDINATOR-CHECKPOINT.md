# Exclusive synthetic coordinator: next checkpoint proposal

Status: root agreed this scope. The private-core checkpoint was accepted as `bccf6b69`.
The [copied-service admission checkpoint](SERVICE-ADMISSION-CHECKPOINT.md) is implemented for
review. Native connection remains deferred; standalone execution is not host-binding evidence.
See [native core checkpoint](NATIVE-CORE-CHECKPOINT.md) for its exact implementation boundary.
The source baseline is `9366daa27e5ad14579d2853756b348e2cf01ce52`; the native backend
was committed as `0d9e0a26`. [Source inventory](SYNTHETIC-COORDINATOR-SOURCES.json)
records the inspected files. No account, registry or owner instance was opened to write this proposal.

This narrows the next step in [HOST-BINDING-CONTRACT.md](HOST-BINDING-CONTRACT.md).
Its standalone layout, empty native fixture turn and exact-child cleanup replace the earlier
optional composition feature/full-session proposal **for this checkpoint only**. Existing
production, descendant-cleanup and strong B06 gates remain closed. The accepted execution
boundary is [B06-Mac](PRIVATE-COPY-FIXTURE.md): cooperative same-UID private pathname execution,
with malicious same-UID mutation after final validation explicitly outside the contract.

## Deliverable and dependency boundary

Use a separate `fixtures/synthetic-host/Cargo.toml` with its own workspace and lockfile, a fixed
native fixture check and local tests. Depend on the actual sibling `milagre-owner-store`,
`milagre-accounts` and `milagre-registry` crates by path. Do not enable owner `test-fixtures`.
Leave the base ACP manifest, default dependencies, features and existing refusal gates unchanged.
No runtime, daemon, GPUI, accounts, registry or owner source edits belong to this step.

The standalone crate compiles one shared private native core from this directory by source path;
it does **not** depend on a second compiled `milagre-acp` private-copy backend. Extract only the
private control/driver boundary needed to reuse files/process/wire/worker implementation. The
base `MacOsPrivateCopyFixture` remains its existing feature-gated wrapper around that core.
There must be exactly one `ACTIVE`/cleanup owner implementation in each fixture process. The
native child includes only the closed wire definitions, not another supervisor. A dependency
tree/source assertion and a simultaneous-start Busy test pin this arrangement.

The initial surface is crate-private fixture commands and tests, not a published library:
create a closed scenario, send bounded text once, stop, begin Project/all close, and collect
owner notices plus separate consumption/cleanup receipts. The runner takes no executable,
profile, cwd, environment map, service callback, proof boolean or raw RPC argument. Fault hooks
stay test-only. A standard-library coordinator thread owns the services and its private runtime;
callers need no Tokio runtime. Its bounded command interface does not expose mutable services.

## Real copied services and one real host turn

1. Create a fresh owned 0700 fixture arena under the fixed temporary parent. Create an empty
   isolation child and call the actual `Isolation::create` with a private synthetic policy.
   Do not call `Policy::system`, which reads ambient profiles/registries. The constructor takes
   no caller path; its generated arena and retained directory identities are the scope boundary.
   Inside the isolation create a plain `project`, `home` and `tmp`. The Project has no Git metadata.
   Pin all three directories; their layout preserves the native child's existing environment check.
2. Create `AccountSandbox::create` from fixed synthetic account bytes and open its real writer.
   Create `RegistryCopy::create` in the isolation from bytes naming exactly that Project. Keep
   the sandbox, service, registry copy, reader and arena descriptors. The registry `Active`
   closure checks the private coordinator incarnation/revocation cell; it never returns an
   unconditional grant. No seed is read from a user profile or registered live Project.
3. Construct real `ProjectStates` and `ChatHost`, register the private `Provider`, and call
   `open_project`. The facade calls real `ChatHost::send` with an ordinary Ask request,
   `permissionMode: "ask"`, provider `kiro`, fixed `kiro:auto`, bounded text, and the generated
   Project. The owner creates the Chat and TurnId. No MockProvider, fabricated TurnId, direct
   deliver call, seed transcript or Restore feature substitutes for this path.
4. `Provider::start_turn` only validates the closed request shape and enqueues the bounded
   captured callback. It does no I/O and does not wait on the coordinator. Drain it after the
   host call returns, then check the original chat/turn with `active_turn` and
   `require_project_ready` (which already checks `states.assert_owned`). Admit at most this one
   turn. A second send is refused before reaching the host, even after this turn finishes.
5. Resolve the exact registry snapshot/Project grant and await its exact-root
   `contains_folder` check on the coordinator's private runtime. No host/service borrow crosses
   that await. Return bounded completion data to the coordinator and revalidate before advancing.
   Mint a private descriptor-bearing workspace input only from this owned arena and grant.
   The worker may use `fchdir` on that retained Project descriptor or refuse a changed path;
   it must never switch to the replacement path or its own unrelated workspace.

The private native executable storage stays separate from the owner Project lifetime. The
coordinator owns Project/home/tmp; the native resource guard owns executable scratch and a
retained reference to the descriptor input. Native cleanup does not delete the Project. Owner
state and copied service files are retained until phase-two close below.

## Captured selection and readiness

Capture one `AccountService::pin(Some(exact_scope))`; resolve its existing fallback semantics
once and retain the `Selection`. Require its Kiro account to be `default`. A missing, named,
signed-out or subsequently changed selection refuses. Never retry with a different scope or
account. Retain the service owner UUID and exact generation, including valid generation zero.

Only this coordinator calls `begin_observation` and `observed`. Its fixed internal scenario
produces Ready or SignedOut without probing a CLI/profile. A successful `observed` call returns
the real opaque `Readiness`; retain it together with the internally recorded Ready completion
epoch. This is synthetic readiness evidence, not real Kiro authentication.

Before starting **any** new observation, invalidate the previous private readiness epoch and
revoke its pending launch, even if the new observation fails. Do the same before every metadata
mutation, removal, selection/assignment, reopen or close attempt, including failed writes.
Never infer readiness from AccountEvent, generation alone, Debug, UI snapshots or a caller flag.
`Readiness` has no public revalidation method; this workaround requires exclusive service ownership.
Do not consume it through `select`/`assign` merely to validate a launch.

The private launch capture contains coordinator incarnation, Project-open epoch, exact scope,
chat/host TurnId, cancellation epoch, account owner/generation, Selection, retained Readiness and
completion epoch, registry snapshot/grant, owned workspace identity and preparation identity.
It has no public constructor, Clone/serde conversion or raw descriptor export. Final coordinator
validation uses active service accessors, re-pins the same scope and compares the selected ID,
checks snapshot bytes, and requires the original ready Project and active host turn. Epochs use
checked increments; exhaustion revokes admission. Snapshot hashes remain point-in-time checks,
not protection against external change-and-restore history.

## Final commitment and exclusive mutation ordering

The existing worker-owned CAS is insufficient for this composition. Introduce one private
admission gate shared by the exclusive coordinator and its one native worker. A gate entry holds
the captured epochs, a coordinator-issued validated stamp, and one-shot Pending/Committed/Revoked
state. It is not a public authorization callback or a second account service.

1. The worker prepares the fixed source/copy and reports Prepared without spawning. The
   coordinator revalidates the actual service/host/registry capture after that completion and
   issues the private validated stamp for those exact epochs. No future is polled while a
   gate lock or service borrow is held.
2. Before each relevant service or owner mutation, the exclusive coordinator takes this same
   short gate lock, invalidates the corresponding epoch and revokes Pending (or requests
   cancellation of Committed), then releases it and performs the mutation. Validation failure
   also revokes. Closing/stop commands use this path. Failed mutations never restore an old stamp.
3. The worker performs its final bounded native identity/digest checks, closes writable handles,
   then takes the gate, checks the validated stamp/current epochs and atomically changes Pending
   to Committed. There is no await or queued authorization message between this transition and
   the single spawn attempt. Native filesystem checks remain on the worker, outside the short
   gate lock. No coordinator mutation can leave an old stamp admissible.
4. Revocation winning before commitment proves no spawn. Commitment winning permits at most
   one child even if revocation arrives before its PID is returned. The retained supervisor
   cancels that exact child. Check revocation before every prompt write; a write already admitted
   may reach the child, including a partial frame. Never promise zero execution after commitment,
   retract bytes, replay a prompt, or infer parsing from a successful write.
5. Drop of the facade requests revocation through a separate cancel capability while the
   coordinator/supervisor still own all resources. Every async preparation completion and
   receipt is tagged with the private incarnation/turn; stale completions cannot authorize or
   affect another instance. No second turn or retry consumes a committed ticket.

Service validation is preserved across the short native final-check interval by exclusive
coordinator mutation ordering. This is not a new cross-process account launch lease. The private
arena has the same cooperative same-UID boundary as B06-Mac; arbitrary external mutation is not
made atomic with spawn by these epochs.

## Native facts, owner events and consumption receipts

Keep the fixed native protocol minimal: one bounded text prompt, a validated child-consumption
receipt, then EOF and a successful natural exit in Ready. IgnoreCancel emits the receipt and
stalls. There is no initialize/session/new/model negotiation, assistant reply or tool execution.
This checkpoint exercises a real **empty fixture host turn**, not a full ACP session or model
response. It does not synthesize parent-origin assistant text.

Expose the validated consumption fact before waiting for EOF. It retains the child's compiled
identity, actual PID/cwd identity, nonce and digests computed over parsed input. Parent artifact
digest remains separate. Delivery of this fact is bounded and loss cannot be treated as success.
The native receipt proves parsing; it does not prove authorization, cleanup or immutable execution.

| Observed fact                                                                          | Private adapter mapping                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Captured start refuses/fails before validated consumption                              | One StartFailed for the captured chat/turn, with a fixed bounded error. No Started, reply or success terminal.                                                                                                                                                     |
| Validated child-consumption receipt                                                    | Separate consumption receipt; Started with an opaque fixture turn ID and `steered: false`, then Agent `turn-started`. These are explicitly fixture protocol admission semantics, not ACP initialize/session evidence.                                              |
| Ready receipt, EOF, natural exit code zero, confirmed reap and removed native scratch  | Agent `turn-completed` for the empty fixture turn, then Exited to close that captured session generation. The conjunction is required; receipt or EOF alone never completes the turn.                                                                              |
| Cancellation after consumption                                                         | Stop/cancel drives exact-child cleanup. Agent `turn-cancelled` once the owned child is confirmed reaped; if cleanup becomes uncertain first, emit a failure terminal with fixed cleanup-uncertain cause and retain resources. Never emit a later success terminal. |
| Protocol error, nonzero exit, deadline, panic or cleanup uncertainty after consumption | One failure terminal for the captured turn. Exited is sent only after actual reap is known; unknown ownership never becomes a claimed exit.                                                                                                                        |

Use real `ProviderEvent` and `RawJson` once at the owner boundary; no double encoding. Every
event carries the host callback's original chat and TurnId, never an ID chosen by child metadata.
The adapter tracks whether start/terminal/exit have already been sent. Host interrupt grace may
already have force-ended the turn; retain the real host's generation checks and verify a single
observable terminal state without letting late cleanup affect a newer session. Cleanup receipts
are a separate control channel, never ProviderEvent. Existing owner notices keep their normal
content; only binding-owned diagnostics promise redaction.

## Two-phase close and retained uncertainty

Phase one marks the private facade Closing, stops admission, invalidates epochs and drains the
queued start. A non-force close while a turn or preparation is busy refuses **before** changing
these states. Force close and facade drop revoke pending preparation or cancel the committed
child. Continue polling the existing host and native worker; do not call `forget`, `shutdown` or
`AccountService::close` merely because a cancellation request or owner terminal was emitted.

Phase two starts only after the supervisor proves either no child was spawned, or the exact
owned child was reaped, and confirms native scratch removal plus control/event settlement.
Then call actual `host.forget(project, true)` for Project close or `host.shutdown(true)` for all
close. Treat pending/save/release errors as incomplete close and retain whatever ownership those
APIs still hold; retry only closing. For all close, release the account writer last. No external
close receipt reports success before the requested host close succeeds. Project close retains
the copied accounts/registry until all close; this one-turn fixture never reopens for another send.

The coordinator thread owns the service bundle independently of its caller/observer. Its unwind
guard first revokes, then retains the entire bundle through native cleanup. CleanupUncertain
keeps the native slot, exact Child/descriptors, host/account/registry copies and coordinator close
state. A still-owned child may later reap and permit a cleanup status update; a Lost child is
sticky and gets no further probe, signal or wait. Resource-removal uncertainty also prevents
release. Failure during preparation before spawn still retains any unproven partial ownership.

Reuse the existing exact-child WNOWAIT/probe, signal-before-reap and Lost rules. Do not use the
ACP RPC supervisor's reap-then-group-signal path. The fixed native fake creates no descendants;
there is no process-group/descendant cleanup claim and no reuse for an arbitrary provider.
Owner/session closure and SQLite persistence are never evidence that a child stopped.

## Minimal native changes to agree

| Private change                                                               | Reason and compatibility condition                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extract one shared private core with existing wrapper                        | Standalone composition needs private access without a public path/callback API or duplicate ACTIVE supervisor. Preserve base default/feature behavior and tests.                                  |
| Prepared notification and coordinator-issued stamped gate                    | Move final commitment under the exclusive mutation contract. Preparation alone cannot spawn; no public proof boolean.                                                                             |
| Private owned workspace layout input                                         | The real registered Project descriptor, plus generated sibling home/tmp, replaces only the coordinator mode's cwd. The existing public fixture continues making its own workspace.                |
| Separate cancel capability and single-consumer versioned progress/completion | Allow cancellation while waiting; report Consumed before EOF and later cleanup status changes without repeatedly returning one stale CleanupUncertain report or replacing another waiter's waker. |
| Retained coordinator bundle / worker guard handoff                           | Caller drop, worker/coordinator panic and partial preparation keep service locks and capacity until positively established cleanup. The core does not depend on owner/accounts types.             |

No native fake response extension is needed for this empty-turn checkpoint. Keep its fixed sibling
artifact selection, 64 MiB cap, 32 KiB hash scratch, 0700/0500 modes, closed environment,
async-signal-safe `fchdir`/`setpgid`, compiled identity and actual input digest checks unchanged.

## Bounds and implementation checkpoints

One coordinator, one preparation/native worker, one Project/Chat/turn and one active cleanup slot.
Keep the existing 64 KiB text, 512 KiB encoded frame and 4096-byte receipt caps. Bound commands
to 32 messages/256 KiB charged retained data and provider events to 128/2 MiB; the one pending
prompt counts wherever ownership moves. Reserve fixed terminal/cleanup control capacity outside
ordinary payload quota. Keep one unresolved cleanup record and at most 32 completed records.
Use checked accounting before allocation/admission. Overflow revokes and closes visibly.

Retain 5 s total cooperative preparation, 5 s startup, 30 s total turn, 10 s read idle and
2 s bounded cleanup reporting. A deadline bounds cooperative checks around blocking filesystem
calls, not their wall-clock completion. The no-descendant fixed fake can be killed immediately
on cancellation; do not claim a graceful ACP cancel exchange. Native cleanup continues without
caller ticks. Bound each coordinator poll batch so control commands cannot starve.

1. **First regression:** run a test-only full-worker partial-preparation failure in a separate
   test process. Inject replacement after private file creation/closing its writer, before final
   copy admission. Assert Report CleanupUncertain, no spawned PID, resources_removed false and
   a second start Busy. Retain the slot; never reset ACTIVE to make the test proceed. The parent
   fixture checker verifies the child test exits and handles only its known scratch afterward.
   This closes the earlier unit-only Prepared retention coverage gap.
2. Extract the private backend control boundary and validate both compile contexts, one ACTIVE
   slot, exact Project-descriptor cwd, pre/postcommit revocation, single waiter plus separate
   cancel, consumed-progress ordering and cleanup revision delivery. Re-run the staged native
   check, source/path/copy/mode mutations, stalled child, drop/panic/spawn failures and no
   post-reap/lost-PID signals. No host success claim yet.
3. Add real copied service setup, private provider callback capture and one actual host send.
   Prove generation zero succeeds; changed owner/selection/readiness epoch, failed observations,
   failed mutations, registry changes and moved/replaced Project refuse before commitment.
   Verify normal Ready and SignedOut through actual service APIs, not injected proof types.
4. Test every prepare/validation/commit/prompt barrier with stop and close, including invalidation
   during native final checks, postcommit cancellation before PID return, parsed-before-stall,
   nonzero exit, unknown cleanup, facade/coordinator panic and stale receipt. Hold copied owner
   and account locks through cleanup, then verify reopen only after successful all close. A
   refused non-force busy close must leave the active turn runnable.
5. Run offline default/all-feature ACP suites, strict Clippy/fmt, standalone fixture suites and
   staged native coordinator tests against the final source. Record package features, source
   blobs and artifact/input digests. Report empty fixture host-turn coverage separately from
   full ACP session, descendant cleanup, production authority and strong B06, all still gated.

Root agreed the standalone layout, exclusive epoch/gate contract, empty native fixture turn
mapping and retained two-phase close. Implementation is staged: the accepted private core and
current service admission layer remain disconnected pending review. Shared account
lease or owner cleanup API work, arbitrary providers and real ACP session negotiation require
separate scope decisions.
