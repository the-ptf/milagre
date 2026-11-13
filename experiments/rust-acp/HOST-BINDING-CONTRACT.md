# Synthetic Kiro host binding: proposed agreement

Next concrete design: [exclusive synthetic coordinator checkpoint](SYNTHETIC-COORDINATOR-CHECKPOINT.md),
based on the committed B06-Mac backend. It proposes a standalone manifest and one empty native
fixture host turn; the optional feature and full-session portions below remain broader future
requirements, not newly implemented or accepted coverage.

Status: host composition remains a proposal. The separately approved, default-off
[MacOsPrivateCopyFixture backend](PRIVATE-COPY-FIXTURE.md) implements a cooperative same-UID
native execution checkpoint only. It does not implement this host composition or strong B06. The first binding would exercise the real Rust owner, accounts
and registry implementations against newly created synthetic copies and one fixed native fake.
It would remove Node from this test's orchestration path. Production providers stay disabled.
The pure `launch-planning` module remains unable to issue launch authority.

## Reviewed source baseline

Read-only root worktree: `/Users/victor/.milagre/worktrees/milagre-ade/i-have-some-spare-tokens-t6vn`.
HEAD during inspection: `6195a0519b9f278129adf5976ee5d69f61a7547a`. The three inspected crate
directories were clean and every recorded source blob matched this commit.
[HOST-BINDING-SOURCES.json](HOST-BINDING-SOURCES.json) records individual blob IDs for reproducibility.

| Directory                   | Git tree                                   |
| --------------------------- | ------------------------------------------ |
| `experiments/rust-accounts` | `9aa49548bf3b832afa983415f4dc661b95bf6aec` |
| `experiments/rust-registry` | `83b2330d8da076d720de410feb8443d33170f64d` |
| `experiments/rust-owner`    | `988f679eb37432ec90b1c63e26a6d0c6746a4250` |

These are source inventories, not copies or observations of the user's accounts, profile or CLI.
No readiness probe, registry discovery or owner constructor was run for this document.

## Existing APIs and their exact limits

| Source                                                                                         | Usable API                                                                                                                                                                                                               | What it does not provide                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [accounts/service.rs](../rust-accounts/src/service.rs)                                         | `AccountService::pin(Some(scope))`, `owner_id()`, `generation()`, `accounts()` validate the active copy writer. `Selection::account_id("kiro")` reads the captured choice.                                               | `Selection` has no generation, scope or liveness attached. It remains readable after close. An ID of `default` alone says nothing about readiness.                                                                                                |
| [accounts/service.rs](../rust-accounts/src/service.rs)                                         | `begin_observation(provider,id)` then `observed(observation,state)` rejects another owner, stale generation or superseded observation sequence. `Readiness` has private fields, is non-cloneable and has redacted Debug. | `IdentityState` is a trusted caller input, not a probe. Public `Readiness` consumption exists only in `select`/`assign`; `ready` is private. No public launch lease, proof inspection, validation or revocation subscription exists.              |
| [accounts/service.rs](../rust-accounts/src/service.rs)                                         | `select`, `assign`, `remove`, `close`; metadata commits advance generation. Reopening creates a different owner UUID.                                                                                                    | Generation starts at **zero**, which is valid. New observations/readiness changes need not change generation or emit `AccountEvent`. Events alone cannot invalidate a launch. `snapshot`/`scope_snapshot` are UI data, not readiness proofs.      |
| [accounts/store.rs](../rust-accounts/src/store.rs)                                             | `AccountSandbox::create(seed)` creates a fresh private copy under fixed `/tmp` (including the `/private/tmp` alias). `open()` obtains an exclusive descriptor-backed writer.                                             | No existing-profile adoption or live login. Sandbox clones do not preserve a closed service's authority. Cleanup is deliberately not an arbitrary recursive destructor.                                                                           |
| [registry/lib.rs](../rust-registry/src/lib.rs)                                                 | `Registry::open(Isolation,profile,Active)`, `snapshot()`, `Snapshot::project(path).await`, `ProjectGrant::contains_folder(path).await`. `Snapshot::check()` rejects changed registry bytes.                              | `Identity`/`Probe` and scope strings are not grants. A `ProjectGrant` covers exact active roots, not descendants. It is not an open workspace descriptor. `Active` is caller supplied; a closure that always returns `Ok` would erase revocation. |
| [registry/writer/storage.rs](../rust-registry/src/writer/storage.rs)                           | `RegistryCopy::create(isolation, Seeds)` makes a new descriptor-backed registry copy from bytes; `path()` identifies that copy.                                                                                          | No authority to inspect or adopt an ambient profile. No public monotonic project generation. Snapshot fingerprints detect current byte differences, not a change-and-restore history.                                                             |
| [owner/chat_host.rs](../rust-owner/src/chat_host.rs)                                           | `open_project`, `require_project_ready`, `active_turn`, `send`, `interrupt`, `tick(now)`, `forget(project,force)`, `shutdown(force)`. `Provider::start_turn(turn,&RawJson)` receives the host's allocated TurnId.        | `TurnId(pub u64)` is constructible; provenance comes from the callback, not the type. No public lease combining project/account/turn. `is_project_ready` is only a lookup. No public project-open epoch or provider cleanup acknowledgment.       |
| [owner/states.rs](../rust-owner/src/states.rs), [ownership.rs](../rust-owner/src/ownership.rs) | `ProjectStates::assert_owned` verifies a retained owner. `RootPin::check` verifies path/device/inode and canonical identity.                                                                                             | `RootPin` stores path and identity, not an open descriptor. A later `Command::current_dir(path)` is a separate lookup.                                                                                                                            |
| [owner Provider contract](../rust-owner/PROVIDER-CONTRACT.md)                                  | Nonblocking `Provider` callbacks; Agent/Exited/Started/StartFailed carry chat and TurnId. Owner validates outbound fields and settles answers asynchronously.                                                            | `Provider::shutdown()` has no force argument or receipt. `ChatHost::shutdown(force)` and `forget` wait for transcript jobs, not arbitrary provider reapers. They must not be treated as process cleanup receipts.                                 |

The current `Accounts::selected` deliberately resolves a missing scope override through the saved
computer selection. Capture that explicit saved result once; never turn an error, missing named
account, revoked pin or failed readiness into a second attempt with `default`. The first binding
requires the captured Kiro choice to equal `default`, then independently requires fresh readiness.
The account planner's environment map is not used: its Kiro default branch can retain caller env.
The launch planner's nonzero synthetic generation and restricted identifier syntax are also not
suitable for real account generation zero or an absolute project scope. Do not coerce values to
fit that planner, strip path separators, add one to generations or use planner success as a grant.

## First checkpoint and dependency layout

Proposed feature: `synthetic-kiro-binding`, off by default, Unix code gated further by a proven
execution backend. All implementation edits would remain under `experiments/rust-acp`.

```text
rust-acp / synthetic_binding (optional composition layer)
  -> milagre-owner-store (../rust-owner, normal API, no test-fixtures feature)
  -> milagre-accounts    (../rust-accounts)
  -> milagre-registry    (../rust-registry -> milagre-owner-store)
  -> private ACP transport/client/mapper internals

launch-planning     independent pure review data
fake-session        unchanged fixed Node fixture API
synthetic_binding   fixed native fake only; no production constructor
```

Use optional path dependencies, not source copies, reverse dependencies from owner, runtime
changes or a generic trait whose callers can return `Ready`/`Allow`. The root integration must
supply the recorded source versions. The implementation cannot validate against older sibling
crates silently; report missing APIs without editing those crates or switching to mocks.

Use a dedicated fixed native Rust fake target under this crate. The existing Rust transport fake
accepts fault-injection RPCs/environment settings and retains received frames without the proposed
bounds; it is not the binding's trusted executable unchanged. The Node `FakeSession` and its receipt
inspector are not used. The new fake has only a closed scenario enum, bounded ACP framing, no shell,
file/network/tool execution, login, subprocess choice or arbitrary script/RPC injection. It accepts
Kiro's fixed `acp --agent-engine v3` arguments. Production executable paths are unrepresentable.

Scope: one locally owned plain synthetic Project, its exact workspace root, one ordinary Ask chat,
one admitted host turn/process, new session only, text only, fixed `kiro:auto`, no effort override,
no model switch, instructions, images, resume, Restore, steering, linked scope or MCP endpoints.
Initial owner sends set `permissionMode: "ask"` explicitly and use the real `ChatHost::send` path.
No `MockProvider`, manual `deliver` of a fabricated turn, `TurnId(1)` shortcut or test switch bypasses admission. Registry fixtures contain
only the generated plain folder, so registry identity does not need Git or any other executable.

## Proposed API and private authority

The following is an API sketch to agree, not compilable code or newly available methods:

```rust
// Feature-only fixture surface. No paths, env maps, leases or Ready booleans accepted.
pub struct SyntheticKiroHost { /* owns the real services and private coordinator */ }
pub enum FixtureCase { Ready, SignedOut, HoldPreparation, HangInitialize, IgnoreCancel }
pub enum CloseTarget { Project, All }
impl SyntheticKiroHost {
    pub async fn create(case: FixtureCase) -> Result<Self, BindingError>;
    pub fn send(&mut self, text: &str) -> Result<Sent, BindingError>;
    pub fn stop(&mut self) -> Result<(), BindingError>;
    pub fn tick(&mut self, now_ms: i64) -> Result<(), BindingError>;
    pub fn begin_close(&mut self, target: CloseTarget, force: bool)
        -> Result<CloseTicket, BindingError>;
    pub fn take_notices(&mut self) -> Vec<Notice>;
    pub fn take_cleanup(&mut self) -> Vec<CleanupReceipt>;
}

// All private to synthetic_binding; no public constructor, Clone, serde or raw fd export.
struct AuthorizedLaunch { /* service identities/epochs, readiness, pins, one-shot state */ }
struct PreparedLaunch { /* descriptors/resources, still no right to start */ }
impl Coordinator {
    fn begin_prepare(&mut self, start: CapturedStart) -> Result<PrepareJob, BindingError>;
    fn complete_prepare(&mut self, result: PreparedResult) -> Result<PreparedLaunch, BindingError>;
    fn authorize(&mut self, start: CapturedStart, prepared: PreparedLaunch)
        -> Result<AuthorizedLaunch, BindingError>;
    fn admit_spawn(&mut self, launch: AuthorizedLaunch) -> Result<SpawnTicket, BindingError>;
}
// Private workers never borrow the host or account service across an await.
async fn run_prepare(job: PrepareJob) -> PreparedResult;
// Called once through the coordinator's bounded queue.
async fn run_fixed_fake(ticket: SpawnTicket) -> CleanupReceipt;
```

`Sent` and `Notice` are the actual owner types, not invented replacement owner events.
`CloseTicket` is an opaque binding-local receipt ID; completion is reported by `take_cleanup` and
subsequent ticks. `CleanupReceipt` contains only opaque local IDs, status and fixed error codes.
It is separate from `ProviderEvent`; no new owner variant is required in this checkpoint.
Existing owner Notices retain their normal user content; do not claim those types are redacted.
Map service/OS errors to fixed binding codes rather than logging raw source error strings.
`tick` drains ready binding completions and calls the existing `ChatHost::tick(now_ms)`; it never
waits for a provider job. Workers use bounded validation messages back to the coordinator at
await boundaries, then recheck the shared revocation stamp before acting. No worker holds a
service or host borrow across an await. Real monotonic worker deadlines still fire if a
test caller stops ticking; the caller-supplied owner clock is not process cleanup authority.

`SyntheticKiroHost` owns `ChatHost`, `AccountService`, the sandbox and registry copies exclusively.
It exposes no `&mut ChatHost`, `&mut AccountService`, arbitrary registration or callback injection.
The private `KiroProvider` implements existing `Provider`: it validates bounded request shape and
queues `CapturedStart` inside `start_turn`; it never waits, reads files or queries an actor there.
The coordinator drains that queue after the host call returns. Request `chatId`/cwd must match
the known project/session stored by the real owner. It rechecks `active_turn(chat) == Some(turn)`
and project readiness before proceeding. The original host turn is attached to every event;
provider native IDs and `_meta` cannot select an owner chat or turn.

Retained identity in `AuthorizedLaunch`: coordinator incarnation; project-open epoch; canonical
project/account scope; chat and host TurnId; per-turn cancellation epoch; account service owner UUID
and **exact** generation; immutable captured `Selection`; private readiness completion epoch;
retained `Readiness`; registry snapshot/grant; workspace descriptor identity; fixed-executable
identity/digest; immutable Ordinary/Ask setting; owned scratch/cleanup slot. Raw account labels,
paths, request text and error bodies never appear in Debug. A plan, serialized fixture, renderer
claim, public TurnId or another coordinator's opaque ticket cannot manufacture this value.

### Readiness without pretending there is an account launch-lease API

For the first synthetic checkpoint, the private coordinator calls `begin_observation("kiro", id)`
only for the captured saved selection. A fixed internal fixture probe returns `Ready` or
`SignedOut`, without CLI/profile inspection. The coordinator calls `observed` with that exact
request and result. A successful result **and** the internal Ready completion allow it to retain
the opaque `Readiness`. No public caller can inject the result. Do not call `select`/`assign` merely
to validate a launch: they consume the proof and write metadata/change generation.

Because `Readiness` has no revalidation API, exclusivity is mandatory. This coordinator owns every
observation, service mutation and close. Before starting any new observation, it invalidates its
previous readiness epoch, including when the new observation later fails. Any metadata operation
invalidates launch tickets before it is attempted, even if persistence fails. Reopening changes
both service identity and coordinator tracking. Final checks call active service accessors, compare
owner/generation, repin the exact scope, compare the Kiro ID, and require the retained private epoch.
Never parse `Readiness::Debug` or a decorated UI snapshot. AccountEvent is supplementary only.

This does not claim a reusable production account lease. If accounts remain owned by a different
actor, production needs an account-owner-issued opaque launch lease with current selection,
readiness sequence, generation and revocation validation. Its API belongs to that owner and must
be agreed separately. Do not replace it with a forgeable `ready: bool` trait result.

## Admission, revocation and retained resources

1. **Capture.** A bounded `Provider::start_turn` queue entry preserves the exact owner request and
   TurnId. The coordinator refuses unsupported features, wrong chat, closed project or old turn;
   calls `require_project_ready` and `states.assert_owned`; captures account owner/generation and
   `pin(Some(exact_scope))`. Errors propagate without loading, reopening or selecting an account.
2. **Prepare.** Create only fixture-owned resources and retain descriptors. Obtain the registry
   snapshot, `project(...).await` and exact `contains_folder(cwd).await`. `Registry::Active` reads
   a revocable coordinator cell, never an always-true callback or actor RPC. After **every await**,
   recheck cancellation/coordinator/project/readiness epochs, account active state and captured
   selection, project readiness and the snapshot. A changed check discards preparation and cleans
   only owned resources. No grant crosses into another project or newly current turn.
3. **Authorize/admit.** Revalidate all checks above, workspace/executable descriptors and bounded
   request. Transfer the private launch once to the reserved worker. A revocation-aware one-shot
   permit arbitrates `Pending -> Committed` versus `Pending -> Revoked` immediately before the
   fixed spawn operation. A revocation that wins Pending proves no child start. No await occurs
   between this final check/commit and the spawn call; no later retry can reuse the ticket.
4. **After commitment.** Stop/revocation racing after Committed may find a child starting, even
   if the OS has not returned a PID yet. It is not proof of no execution. The worker retains the
   ticket/resources, finishes collecting the child handle, kills/reaps on cancellation and checks
   again before initialize, session creation, config or prompt admission and after each await.
   A post-commit race never becomes an automatic replacement process or replay. Checks before
   protocol admission have the same explicit race boundary; already written data may have arrived.
5. **Finish.** At most one terminal for an admitted host turn; a separate cleanup state outlives
   it. The worker owns child, pipes, tasks and descriptors until cleanup is proven or retained as
   uncertain. No subsequent same-chat process starts while this cleanup slot remains occupied.

A point-in-time check cannot detect an unobserved external change-and-restore between checks.
Binding-mediated account, registry and project operations increment local epochs before mutation,
so their ABA changes are rejected. Arbitrary same-UID hostile filesystem writers are not made safe
by this fixture coordinator; descriptor/immutable-byte execution and exact workspace checks prevent
path substitution within the stated boundary. Production needs its own approved authority model.

Stop, a newer turn, failed readiness, account close/reopen, project loss, registry revocation,
forget and shutdown invalidate Pending tickets immediately. Project-open epoch is coordinator-owned
and changes on every successful open and any invalidation; never infer it from a path string or
reuse the previous epoch after reopening. Counters use checked increments; exhaustion closes the
coordinator. Monotonic cancellation is not cleared when paths, registry bytes or selections revert.

### Fixed executable and workspace pins

A held `File` plus `Command::new(path)` is not descriptor execution. Existing `AcpRpc::spawn` uses
pathname command/cwd lookup, so it cannot consume this grant unchanged. Propose a private transport
entry accepting an already owned child/pipes from the fixed backend, or a private spawn abstraction
whose sole binding constructor requires `AuthorizedLaunch`. It must preserve the existing single
writer, bounded parser/events, cancellation and process cleanup. Do not expose generic attached
children, commands or spawn callbacks as part of the feature's public API.

Workspace: create a new private plain folder below an explicitly created Isolation. Open directory
components relative to its retained root with no-follow checks. Refuse ParentDir, links, alternate
roots and arbitrary descendants. Compare the descriptor's identity with the exact registry-granted
root and owner-root checks. Start the child with descriptor-relative cwd (`fchdir` or a proven
spawn equivalent). Canonicalize the known `/tmp` alias before creating descendants, not by folding
untrusted `..`. Recheck the path/descriptor association after awaits; never follow a replacement.

Executable: obtain only the compile-time known native fake build artifact through a test-internal
loader, never PATH, an environment override or a public path parameter. Bound the file at 64 MiB;
verify regular/no-follow, identity, size and digest while copying into private executable storage.
The expected bytes/digest come from the test build fixture, not a request. Retain provenance and
exclude scripts/interpreters, environment-driven loader overrides and arbitrary argv.

Proposed first strong backend: Linux native executable copied into a sealed executable memfd,
verified against the fixture digest, then descriptor execution with `execveat(AT_EMPTY_PATH)` (or
a verified equivalent), descriptor cwd, explicit pipes and process group. Required seals prevent
write/grow/shrink and seal removal. A filesystem inode pin alone does not prevent in-place writes.
No fallback to pathname execution on unsupported kernels or failed sealing. Only async-signal-safe
operations are allowed between fork and exec, or use an independently reviewed spawn primitive.

**Platform agreement required:** the reviewed code offers no descriptor-execution backend. Local
macOS SDK headers expose descriptor cwd actions but no `fexecve` declaration; that is not evidence
that `/dev/fd/N` exec works securely. macOS/Windows must return `UnsupportedDescriptorExecution`
until a fixed-native-fake test proves a reviewed backend on that OS. The proposed Linux-first
success path needs actual supported-target validation before the binding milestone can be called
implemented; macOS-only refusal tests are insufficient. No platform implementation was run here.
Parent approved a separately named B06-Mac cooperative same-UID fixture backend first;
see [PRIVATE-COPY-FIXTURE.md](PRIVATE-COPY-FIXTURE.md). It uses verified private-path execution,
explicitly excludes malicious same-UID mutation after final validation, and makes no immutable
execution or general descendant-cleanup claim. That approval does not satisfy strong B06 or
authorize production fallback.

Environment is built from scratch: no inherited PATH/auth/HOME/loader variables. If the fake needs
HOME/TMPDIR, both name retained empty fixture-owned directories; neither points to account storage.
LC_ALL may be fixed to `C`. No other entries, real profile discovery, `whoami`, authenticate RPC,
login/browser, installation, MCP process or fallback is permitted. The native fixture must not
spawn descendants in normal operation; a separately fixed same-group child scenario tests reaping.
Detached descendants and Windows Jobs remain production gaps, not proven by a process-group test.

## Protocol and policy boundary

Use the existing ACP protocol builders/mapper for initialize with host fs/terminal capabilities
disabled, protocol version check, new session with exact cwd and empty MCP list, supported fixed
Kiro config, one text prompt, updates, cancel and terminal. Pin exact configuration ordering to
an actual Node helper/session fixture when implementing; reject missing advertised capabilities
instead of silently omitting requested configuration. No auth, resume or MCP retry ladder.
The existing Node recorders remain development evidence; the binding success test uses no Node.

Ordinary Ask here describes the owner selection and inert fake only. Kiro `autopilot=on` cannot
prove that a real CLI always requests permission. No constrained role, Auto/Full, Routine wake,
advisor, babysit, escalation, shell execution, read/write service or linked/MCP dispatch is enabled.
Missing independent PreToolUse/access/command/dispatcher/wake guards are explicit refusals.
No boolean can claim a guard exists; a shell classifier is not a sandbox.

For this first binding, reject even permission/tool requests rather than auto-answering them:
unowned server requests receive bounded `-32601`; a deliberately owned but unsupported permission
request is cancelled through the exact ACP cancellation result and ends the turn with a fixed
UnsupportedToolRequest error. There are no executable tools behind the fake. Provider answer
callbacks settle `NotWaiting` for no owned request; they cannot report Accepted for a fake tool
execution. Existing answer-delivery tests remain separate; adding tool dispatch requires another
agreement. Optional disabled MCP observations may stay in planning evidence but cannot activate a
server. The binding accepts no MCP endpoint/config collection, enabled or disabled.

## Cleanup and owner lifecycle composition

The provider worker's cleanup registry retains the process handle/group, reaper task, stdout/stderr
readers, session task, pending receipts, executable/workspace/scratch descriptors and their capacity
slot. Drop/cancel never abandons a child because the observer disappeared. The registry exists
outside the provider's return future and remains owned until reaping is confirmed.

Dropping the public fixture facade revokes admission and transfers the retained service/resource
bundle to a pre-reserved cleanup supervisor; it cannot drop ChatHost/account locks ahead of reap.
A bounded dedicated reaper thread or equivalent executor-independent owner must survive Tokio task
cancellation/shutdown. Reserve that ownership path before spawning, including during constructor
failure. If the service bundle cannot be retained safely, refuse before spawn. Whole-host process
death is outside this in-process guarantee and still needs a production orphan-recovery contract.

`begin_close(Project|All, force)` is a binding-local two-phase operation. Nonforce while busy refuses
without revocation. Accepted close stops new admission and revokes tickets before enqueueing cancel.
Force drains Pending starts without spawning; Committed/Running children receive cancellation then
kill on deadline. Only after cleanup receipts confirm reaping/draining may the coordinator call
`ChatHost::forget(project,force)` or `shutdown(force)` and close the account service. If the owner
returns its own pending/save failure, retain all service handles and retry that close, never reopen.
This order avoids treating existing owner close methods as a provider-cleanup barrier.

The coordinator retains the real ProjectStates/ChatHost and account service until cleanup.
`ProjectStates::unload_idle` unloads idle chat messages, not the owner lock; `Timing::lazy` is not
a process-lifetime switch. Explicit two-phase close and no mutable host escape prevent premature
release through forget/shutdown. `tick` continues to drive owner events, but
admission stays blocked for closing/reaping slots. Forced owner terminals never imply reaping.
On cleanup timeout, retain resources/locks and a bounded CleanupUncertain status; refuse new work.
Do not drop handles or delete a potentially replaced path to make the close appear successful.
After actual process exit, emit generation-tagged Exited as needed; it must not create a second
terminal or close a newer session. Cleanup receipts never masquerade as provider Agent events.

Delete only descriptor-owned ephemeral entries after reaping; never delete account metadata,
profiles or the project as a side effect of forget. The fixture teardown may remove its own known
copies only after every service/descriptor is closed and identities still match. Path replacement
leaves a retained cleanup error, not a recursive deletion through the replacement.

## Fixed bounds proposed for this checkpoint

| Resource        | Limit / failure behavior                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent work | One project/chat/process; one preparation worker; at most one queued start, no provider-side turn queue. New work at capacity refuses before resource allocation.                                                                                     |
| Requests        | Text at most 64 KiB UTF-8; complete encoded prompt/frame at most 512 KiB; identifiers at most 256 bytes, owned canonical paths at most 4 KiB. No arbitrary JSON maps or extra fields in the fixture API.                                              |
| Transport/state | 65,536 JSON tokens; 64 transport events / 4 MiB charged parsed heap; writer 8 frames / 1 MiB; 8 pending RPCs; 1 unsupported permission slot. Mapper 1 MiB, 64 calls and 64 diff paths, 256 KiB thinking; clear on terminal.                           |
| Coordinator     | 32 work/completion messages / 256 KiB charged data; 128 provider events / 2 MiB. Reserve terminal/cleanup control capacity outside ordinary payload quota. One unresolved cleanup slot is never evicted; at most 32 completed receipts, oldest first. |
| Deadlines       | 5 s total preparation; 5 s startup; 30 s turn; 10 s idle; 250 ms cancel grace; 2 s reaping/drain. Bound each await by remaining total budget; never reset the overall budget on a step or retry.                                                      |

These are proposed caps, not existing defaults. Reuse existing heap accounting rather than counting
wire bytes alone. Validate both lower and upper bounds, checked arithmetic and exact encoded prompt
admission. Ordinary output overflow closes and retains cleanup control capacity. Coordinator loss,
worker panic or executor shutdown must request kill and keep reaping ownership; a future drop is
not evidence that the child stopped. A minimal synchronous emergency kill path may be needed when
no executor remains, but unconfirmed reap remains CleanupUncertain.

## Acceptance tests required before parent integration

These are a test specification, not tests claimed to have run. Implement under this crate against
the recorded real service APIs, fresh synthetic files and fixed native binaries only. Use explicit
barriers around await/admission/reap boundaries, not sleep-based timing or manually asserted flags.

| ID                     | Required evidence                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 real admission     | Fresh AccountSandbox + RegistryCopy + Isolation + ChatHost open/send produce the captured callback/TurnId and a Ready proof through begin_observation/observed. The fixed native child receives the exact admitted prompt and cwd identity; its bounded count/length/digest receipt comes after reading. No Node or MockProvider participates.                                    |
| B02 account identity   | Unknown/SignedOut/SigningIn/Error, wrong provider/scope, saved non-default Kiro, missing selected account, corrupt copied metadata and writer loss all refuse without spawn. Capture uses saved scope fallback once; a later error never falls back. Generation zero works; another service with the same generation cannot reuse the proof.                                      |
| B03 readiness epochs   | Hold probe/preparation, begin a newer observation, change Ready to SignedOut at unchanged account generation, mutate unrelated metadata, close/reopen service and restore the original selection. Every old completion/ticket refuses. No fabricated snapshot/readiness bool or arbitrary callback is accepted.                                                                   |
| B04 owner identity     | Pending start followed by Stop, newer host turn, forget, shutdown, project root/lock replacement, readiness failure or close/reopen cannot spawn. Host restart with numerically repeated TurnId still refuses the previous coordinator ticket. No fallback open_project on event or validation failure.                                                                           |
| B05 registry/workspace | Replace registry bytes/root/profile, revoke Active, remove registration, substitute workspace with symlink/renamed directory or request descendant/ParentDir. Recheck after project/contains_folder awaits; refuse each. `/tmp` alias of a freshly created root succeeds. Outside sentinel content is never read or deleted.                                                      |
| B06 native pin         | Swap artifact pathname after pin and verify the exact sealed bytes execute, or refuse; mutate/truncate during bounded copy and refuse. Replace cwd pathname after descriptor admission and verify original descriptor identity or refusal, never replacement. Unsupported platforms/kernels refuse without path-exec fallback. A real supported-target success test is mandatory. |
| B07 commit race        | Pause before Pending-to-Committed and revoke: zero child starts. Revoke after commitment/before PID return: at most one child, no prompt admission after observed revocation, mandatory reap. No claim of zero execution after commitment. Reusing a consumed ticket fails.                                                                                                       |
| B08 await races        | Barrier after each prepare/startup await and before each protocol admission. Revocation closes without the next RPC. An already admitted/written RPC is classified as possibly received; no retry/replay. Environment probe sees only fixed fixture env, even with poisonous parent PATH/HOME/auth/loader variables.                                                              |
| B09 policy refusal     | Auto/Full, constrained role, wake, linked/MCP, image/instruction/resume/Restore/model/effort requirements fail before spawn. Provider metadata cannot claim scope/role. Unsupported tools receive explicit rejection/cancellation with bounded diagnostic and never a file/command action.                                                                                        |
| B10 lifecycle          | Natural terminal, startup error, transport loss, idle/turn timeout, ignored cancel, dropped observer, worker panic, output stall and shutdown retain cleanup ownership. Exactly one terminal per admitted host turn; old Agent/Exited events cannot affect a newer turn. A fixed same-group child is gone before cleanup success.                                                 |
| B11 retained close     | Block reap or inject uncertain cleanup; begin_close keeps owner/account locks, descriptors and slot, refuses new work and reports CleanupUncertain. Only actual reap/drain allows host forget/shutdown and fixture teardown. Project state save failure remains retryable with handles held.                                                                                      |
| B12 bounds/privacy     | Exact/one-over byte/count/deadline limits, UTF-8/JSON expansion, dense parsed frames, permanently stalled consumer and repeated fresh-host send/close cycles keep bounded retained state. Binding-owned Debug/errors/cleanup receipts contain no account label, path, environment value, prompt or raw RPC error. Child-input digest is test evidence only.                       |

Add compile-fail/API checks: LaunchPlan, LaunchObservation, RawJson, a caller-created TurnId and a
foreign Readiness cannot construct AuthorizedLaunch; no Clone/serde conversion, public spawn path,
custom fixture script or mutable service escape. Re-run existing default/planner/fake/all-feature
suites, four Node recorders and clippy. A passing refusal-only platform run must report the native
success tests as unfulfilled, not silently skipped coverage.

## Parent decisions before implementation

Agree the exclusive synthetic coordinator and private readiness epoch workaround, without claiming
an account production lease. Agree the platform/backend proof step (Linux sealed descriptor exec
first, or a reviewed macOS fixed-fake backend first), the Pending/Committed revocation boundary and
the two-phase close retention contract. Then implement this single binding checkpoint in rust-acp.
Any shared account lease, owner cleanup hook or runtime integration belongs to its owning agent and
needs a separate agreement. Production Kiro auth/install policy and Antigravity remain disabled.
Receipt framing P3s stay on their independent queue and do not replace this milestone.
