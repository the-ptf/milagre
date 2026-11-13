# Copied-service admission checkpoint

Implemented for source review under the agreed
[synthetic coordinator scope](SYNTHETIC-COORDINATOR-CHECKPOINT.md). This step owns actual copied
accounts, registry and ChatHost services. Native execution remains disconnected. It proves
service admission and revocation only, with no consumption receipt, model execution, assistant
text, completed native host turn, production authority or descendant-cleanup claim.

## Standalone ownership

The separate `fixtures/synthetic-host/Cargo.toml` has two integration test targets.
`native_core_context` compiles the shared private native core once. `service_admission` imports
only the copied-service owner and has no native core/prepare/stamp/spawn call. Neither target
depends on `milagre-acp`, so this step cannot compile a second ACTIVE backend into either
process. The base ACP manifest, lockfile, default dependencies and features remain unchanged.
The standalone dev dependencies use actual sibling crates, without owner `test-fixtures`.

One private facade owns one coordinator thread and a one-entry command queue. Request methods
require mutable access, so there is one outstanding command/reply. The thread owns its private
Tokio runtime and every mutable service. No caller Tokio, mutable service, arbitrary path,
executable, environment, callback or caller-provided authorization boolean is accepted.
Cancellation is a separate private capability. Each instance has an unforgeable retained scope
allocation, checked epochs and at most one host send. The read-only admission ID cannot affect
another instance, and a refused second send leaves the original capture valid.

Construction creates a fresh 0700 arena under `/private/tmp`, an actual `Isolation` with
`Policy::default`, and plain Project/home/tmp children. It does not call `Policy::system` or
inspect user profiles. The actual `AccountSandbox::create` receives fixed synthetic bytes and
opens its real writer. Its independent generated root is retained for teardown. The actual
`RegistryCopy::create` names only this Project; the reader Active closure checks the private
coordinator revocation cell. The Project is checked for absent Git metadata before admission.

The copied owner requires existing Project metadata. The constructor seeds an empty
`coordination.json`, then registers the sole worktree through actual `ProjectStates::try_update`.
No Chat, transcript, message or TurnId is seeded. Actual `ChatHost::send` creates the Chat/turn.
The provider callback only validates and captures the owner's bounded request. The fixture
checks its exact cwd/chat/TurnId and fixed Ask/Kiro/model settings after the host call returns.
It emits no Started or Agent success events. Revocation settles a pending start with the real
ProviderEvent::StartFailed and host tick, including failures after host send but before capture.

## Capture and revocation

The coordinator pins selection at the exact Project scope once and requires Kiro `default`.
Missing selection and SignedOut refuse without fallback. Ready is a fixed internal scenario
observed through actual `begin_observation`/`observed`; it is synthetic readiness, not provider
authentication. The capture retains opaque Readiness, its private completion epoch, Selection,
account owner UUID and exact generation, including valid zero, and the original host turn.

Actual Snapshot/ProjectGrant resolution and exact-root `contains_folder` run on the private
runtime, with no host/account borrow crossing the await. The coordinator opens and retains the
registered Project directory with O_NOFOLLOW/O_DIRECTORY/O_CLOEXEC, along with arena/home/tmp
identities. This descriptor is private service authority; it is not yet passed to the native
core. A replaced Project refuses while the held descriptor still identifies the original inode.

Validation checks active service owner/generation, same-scope selection, readiness/cancellation
epochs, registry snapshot bytes, directory identities and the original ready host turn. Every
exclusive observation or metadata attempt invalidates the epoch before the operation, including
failed operations and account reopen. Foreign IDs refuse without revoking the current capture.
A detected capture failure permanently revokes that capture, so restoring a moved path cannot
revive it. External byte/path test faults deliberately bypass the mutation epoch to exercise
the actual snapshot/descriptor checks. Changes that occur and are restored between checks are
outside this point-in-time, cooperative same-UID boundary.

Returned Evidence is observational, not a native stamp or atomic launch grant. Cancellation can
race after validation's final sample. Future composition must issue the private native Control
stamp under the agreed shared cancellation/commit gate, with the service epochs revalidated.
This service-only layer does not authorize any native prepare or launch.

## Close, bounds and failure ownership

A non-force busy close refuses before revocation. Force Project close revokes and settles the
pending owner start, then calls actual host forget. All close calls actual host shutdown before
account close. Project close retains the account writer. The service target structurally has
no ACP fixture/provider child, so that child-cleanup prerequisite is true in this checkpoint.
This does not replace the required future native cleanup barrier. A failed owner close retains
the actual account writer and owner state while the Project slot remains owned; restoring the
known Project permits a close-only retry. A release failure that consumed the owner slot latches
CleanupUncertain. Neither retry, finish nor staging Drop can turn it into success. Successful
release also requires the expected lock path to be absent; observed stranded-lock notices latch
uncertainty. Further send admission stays revoked.

Caller drop and caught command panic revoke and close through the retained service owner.
Construction keeps partial ownership in Staging until all fallible pin/runtime setup succeeds.
Incomplete close/removal retains resources rather than reporting successful teardown. Teardown
accepts only generated owned roots, checks identities, and bounds traversal to 2048 entries and
12 levels while rejecting symlinks, hard-linked files, foreign owners and cross-device entries.
Dependency constructors can return errors before exposing a root; this wrapper cannot claim
cleanup of an unreturned dependency resource. This fixture adds no broad temporary-directory
sweep or adoption of old scratch.

Text is bounded to 64 KiB before queueing. There is one pending callback and one fixed provider
failure event. Owner-store state uses the actual owner's existing limits; this step does not
claim a measured 256 KiB aggregate across owner snapshots and serialization. The registry
resolution has a five-second timeout. Synchronous filesystem calls and service/drop joins are
cooperative and are not a hard wall-clock deadline. Native preparation/turn deadlines remain in
the separately tested core. Joined native service scheduling and charged event accounting are
deferred until the next approved composition checkpoint.

## Validation

The service target covers generation zero and owner-allocated turns, real writer locks,
SignedOut/missing selection, successful and failed epoch mutations, foreign captures,
independent cancel, registry changes, Project replacement/restoration, refused busy close,
failed close with retained writer, actor panic, guard-drop cleanup, exact prompt bounds and
post-host/pre-capture refusal settlement. The consuming-release regression puts one fixed extra
file in the actual owned lock directory, forcing rmdir to fail after owner.json removal. It proves
repeated close/finish/staging Drop retain the account writer and scratch even when no stranded
notice remains. The parent runs this retaining case in its exact test binary and removes only
the four identity-checked generated roots after child-process exit. No service test invokes the
ACP native backend; copied owner services retain their existing `ps` helper.

The core additionally tests a retained unstamped worker through its deadline. Final publication
now revokes the control gate, preventing a surviving Control from minting a stamp after its
worker exits. The staged checker runs this regression and proves capacity can be reused after
confirmed cleanup. Delayed worker-driven cleanup uncertainty followed by later recovery remains
an explicit coverage gap; the existing revision test drives Shared publication directly.

Run offline default/all-feature ACP tests, both standalone targets, strict Clippy/fmt for both
manifests, and `scripts/check-private-copy-fixture.py`. Native staged evidence remains evidence
for the core only, never for service-to-native host binding.

At this source checkpoint: 58 default ACP tests, 117 all-feature ACP tests plus one doctest,
12 standalone native-context tests and 12 service tests pass, with strict Clippy/fmt on both
manifests. The service suite's one ignored retaining child is executed by its ordinary parent
test. The core's six staged native cases pass separately. Logs are
`/tmp/milagre-acp-service-default.log`, `/tmp/milagre-acp-service-all.log`,
`/tmp/milagre-acp-service-standalone.log`, `/tmp/milagre-acp-service-clippy.log`,
`/tmp/milagre-acp-service-standalone-clippy.log` and `/tmp/milagre-acp-service-native.log`.
These are local test evidence, not source-to-binary attestation or accepted host binding.
