# Smallest service-to-native composition checkpoint

Status: root agreed the private reservation, registered-workspace and joined cleanup-acknowledgment
seam for implementation. Native success-event wiring waits for review of that seam. This file is
documentation only. Baseline is copied-service admission
`3ab4a9e7`, with native terminal-control revocation accepted as `2a5ea049`. Neither baseline
connects a host-created turn to the native worker. This plan implements that connection for one
fixed synthetic empty turn, then proves cancellation and retained close. It does not complete a
production ACP session or authorize a real provider.

## Exact deliverable

Add one composed integration target to the existing standalone `fixtures/synthetic-host`
manifest. It compiles the shared private native core exactly once and owns one actual copied
service bundle. It has no `milagre-acp` dependency and enables no owner test-fixture feature.
Keep the existing admission-only and native-context targets, wrapper API, base manifest,
default dependencies and refusal gates. No runtime, daemon, GUI, accounts, registry or owner
source changes belong to this checkpoint.

The composed facade accepts only a closed Ready/IgnoreCancel scenario and one bounded text
send. The actor calls the real ChatHost send, captures the callback's original chat/TurnId and
actual prompt, validates real copied-service authority, and sends that exact captured prompt
once to the fixed native sibling. Native receipt validation must identify the registered
Project inode. The owner receives an empty fixture turn through actual ProviderEvent handling.
No fabricated TurnId, direct state delivery, seeded transcript, parent-written assistant text,
initialize/session negotiation, tool operation or credential/profile probe substitutes for it.

Execution remains B06-Mac: fixed native artifact, private copy, cooperative same-UID pathname
boundary, exact child only. Malicious same-UID mutation after final validation remains excluded.
The native fake has no descendants. Copied owner services retain their existing `ps` helper;
the staged test parent also starts its exact test binary. None of these facts widens provider
launch authority or adopts the ACP RPC supervisor's reap-then-group-signal behavior.

## Five private implementation seams

| Seam                                         | Smallest required change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reservation before worker activation         | Factor the existing private start into a one-shot reservation exposing Control, the sole Observer, CancelHandle and a worker-start token before creating its thread. The actor installs all of them in its retained flight first. Activation consumes that token; abandonment revokes and settles the no-worker reservation. Public automatic/prepare behavior delegates through the same implementation and ACTIVE slot.                                                                                                                                                         |
| Registered workspace input                   | Add a private descriptor-owning workspace input, minted only by the exclusive service owner after its actual registry grant and directory checks. It duplicates the retained Project/home/tmp descriptors and original expected identities/paths. The closed facade accepts no path or descriptor. Native final checks recheck this input, and pre_exec uses only async-signal-safe fchdir/setpgid.                                                                                                                                                                               |
| Separate native scratch lifetime             | Prepared chooses its existing generated workspace for the public wrapper or the registered workspace for composition. Native Storage owns only its executable scratch in composition. It never recursively removes Project/home/tmp. HOME/TMPDIR come from the retained synthetic service layout; environment remains cleared with fixed locale. Source pin/hash/copy limits, 0700 parent and 0500 executable stay unchanged.                                                                                                                                                     |
| Typed cleanup acknowledgment and worker join | Add an opaque non-Clone acknowledgment with immutable exact reservation identity, carrying a worker-established NoChild or Reaped disposition and removed native scratch. Worker activation returns its exact JoinHandle. A clean worker returns this acknowledgment only after all registered workspace/native resource handles are destroyed or returned. The actor consumes it after successful join, independently of observer progress. Preserve the wrapper's public Progress/Report surface. Only the native owner can mint it; no actor-supplied boolean or PID is proof. |
| Composed flight guard and event adapter      | A private actor owns the existing ServiceOwner plus one flight containing Control/Observer, bound callback, cancellation routing, terminal flags and cleanup state. Add only the private service methods needed to move the captured start/workspace and fold actual provider events. Service mutation and close remain actor-exclusive. The admission-only target retains its current behavior.                                                                                                                                                                                  |

Reservation is needed for the short activation interval as well as cancellation. If worker
creation fails or the actor unwinds around activation, it must already own the reservation and
observer needed to establish cleanup. No services move into a background native worker, no
service callback runs there, and no callback trait/object is introduced to authorize launch.
The native core remains independent of account/registry/owner types.

The existing worker always calls its cancellation-oriented finish path after execution. A
composed success also needs observed natural exit code zero. Add a bounded normal-exit path
using WNOWAIT followed by one owned reap; cancellation/error uses the existing signal-before-reap
path. Retain that exit status so cleanup never probes, waits or signals an already reaped child.
EOF, a validated receipt, or Report::result being Ok alone must not complete the host turn.

## Commitment and lock ordering

The native core Gate remains the sole launch serialization point with Pending, Committed and
Revoked states. A small coordinator cancellation-route mutex latches cancellation before native
reservation exists and holds the installed CancelHandle afterward. It is not a second launch
grant. The actor alone owns service mutation/readiness/Project epochs.

1. Before activation, allocate the flight, install its reservation and cancel handle under the
   route mutex, and apply any already-latched cancellation. A stop between reservation and
   installation cannot be lost. No stamp exists yet, so preparation cannot spawn the child.
2. After Prepared, take a native Control capture, then revalidate the actual service capture
   outside all locks: exact owner/generation including zero, same-scope selection, retained
   readiness epoch, registry snapshot, registered directories and original active host turn.
   The callback prompt and workspace remain bound to this capture, not a fresh caller request.
3. Reenter the route mutex briefly. Require unchanged cancellation/actor epochs and a live
   facade, then consume the native capture in Control::stamp. There is no intervening actor
   mutation between validation and this check. Cancellation either invalidates the native
   capture first or arrives after the stamp and can still revoke before commitment.
4. Before every actor-owned observation, metadata attempt, close or stop, invalidate native
   Control while holding the route mutex, advance the private epoch, then release the mutex
   before calling the service. Failed attempts do not restore admission. External cancel also
   latches its epoch and calls the installed native CancelHandle under this same route mutex.
5. Native final filesystem/hash checks run outside both locks. The worker then uses the native
   Gate to commit once and makes its one spawn attempt without an await or actor round trip.
   Invalidation winning first proves no child. Commitment winning permits one child even if
   cancellation occurs before its PID is returned; the retained worker cancels that exact child.

Lock order is route mutex, then native Gate. The worker never takes the route mutex or touches
a service. No code takes the route mutex while holding the native Gate or progress mutex.
Progress publication releases its mutex before waking. Provider mailbox locks are released
before host calls or event folding. No filesystem operation, service call, channel send/join,
future poll or await occurs while route/Gate/progress locks are held. Validation may do I/O
outside those locks; its final stamp can still fail. Returned service Evidence stays
observational and is never itself a launch credential.

The actor handles at most one queued command and one cumulative native update per iteration,
then waits at most 20 ms for work. It must not block on native Observer::wait and starve stop or
close. Direct cancellation reaches the native Gate independently of actor ticks. The existing
single mutable observer rule remains; cumulative consumption/cleanup data cannot be lost by
coalescing. No new multi-waiter channel or per-update task is necessary.

## Native facts, host results and two-phase close

Each flight binds one native reservation identity to the actual host chat/TurnId and private
service incarnation. Child receipt fields never select a Chat. Reject mismatched/stale update
identities and revisions. Track start, terminal and exit delivery once per flight, including
the case where receipt and final cleanup arrive in the same cumulative update.

| Observed native fact                                                      | Owner action                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refusal/failure before validated consumption                              | One StartFailed for the captured host turn. No Started or success terminal. Native disposal remains separate even if a failed child existed.                                                                                             |
| Validated compiled identity, PID, nonce, registered cwd and input digests | Retain a separate parsing receipt; emit Started and Agent turn-started using the original host identity. These mean fixed fixture protocol admission, not ACP initialization or model execution.                                         |
| Receipt, EOF, natural zero exit, exact reap and native scratch removal    | Emit one Agent turn-completed for the empty turn, then Exited. Check real owner state/notices for the completed turn and absence of assistant content.                                                                                   |
| Cancellation or error after consumption                                   | Emit one cancelled/failed terminal from observed lifecycle facts; Exited requires known reap. The first terminal failure remains fixed even if cleanup later recovers. Never infer native cleanup from an owner terminal or SQLite save. |

Phase-one close revokes admission, latches Closing and cancels the flight. A non-force busy
close refuses before changing either gate or services. Keep host/account/registry owners and
the Project/home/tmp directories alive while the worker retains the native child or scratch.
The actor may report Closing/CleanupUncertain after the bounded cleanup reporting interval,
but it must not call host forget/shutdown or account close then.

Phase two requires the exact reservation's opaque cleanup acknowledgment, obtained by joining
that reservation's retained worker handle after it reports is_finished. No blocking join runs
inside an actor iteration while the worker is still running. The worker drops every registered
Project/home/tmp descriptor, executable/source/storage descriptor and native resource that can
touch service directories before returning the acknowledgment. Join also establishes completion
of the worker's remaining destructors and thread-local state. An escaping worker-thread panic
or retained-resource exit returns no acknowledgment. A caught operation panic can still produce
cleanup acknowledgment after proven disposal, while its turn remains failed. After successful
join, the non-Clone acknowledgment is consumed once;
its private immutable identity must match the flight's exact reservation. It contains no service
descriptor, path, callback, Drop side effect or transferable authority for another reservation.
For a reservation whose worker never activated, its native reservation owner alone can return
the corresponding NoChild acknowledgment after disposing all reserved inputs; there is no worker
handle to join. A worker-spawn failure must use this same core-owned disposition path.

NoChild is an
explicit worker/reservation fact, not an inference from missing receipt, absent PID, reaped=false
or finished=true. Reaped means the retained Child was positively reaped, not merely signalled.
Require native scratch removal and settled native control before releasing service ownership.
Then fold outstanding actual provider events and call the existing checked host close path,
releasing accounts last. Preserve the accepted sticky CleanupUncertain rule for consumed owner
slots and surviving owner locks; native cleanup success cannot erase an owner close failure.

The coordinator thread owns this guard independently of the facade. Facade drop requests
cancel and closes the command sender; it does not drop ServiceOwner or wait indefinitely for
an uncertain child. The actor continues in close-only mode. Catch command/adapter panics at
the actor boundary and enter the same mode. An outer guard revokes on an unexpected unwind
and retains the entire bundle if cleanup cannot be established; it must never fall through to
ServiceOwner's current immediate-close Drop while a native flight is unresolved. The smallest
implementation may permanently retain on that last-resort path rather than add a general
cleanup executor. Such a path reports uncertainty, never successful close.

Still-owned native cleanup may publish uncertainty, continue its existing reap loop, and later
return the acknowledgment for collection through join. Progress or public Report flags never
substitute for that acknowledgment or joined worker ownership. Lost ownership is sticky and
permits no further signal/probe/wait.
Final native scratch uncertainty also withholds acknowledgment. Those paths retain both the
native ACTIVE slot and composed service bundle. Tests run permanently retaining faults in a
separate process; only their fixed parent may remove identity-checked scratch after process exit.

Bounds remain one actor, one native worker/slot, one actual Project/Chat/turn, one pending prompt,
one outstanding command/reply and one cumulative native update. Keep 64 KiB text, 512 KiB encoded
frame, 4096-byte native receipt, 64 MiB artifact and 32 KiB hash scratch limits. The private
provider-event batch holds at most four events/64 KiB, with fixed terminal/cleanup control
capacity reserved before launch. Charge the binding's retained payload wherever it moves,
including the temporary callback-to-worker text copy. Actual owner-store snapshots retain their own
documented limits and are not claimed to fit a 256 KiB whole-process budget.

For composed execution, the actor captures one absolute Instant deadline, now plus five seconds,
before registry resolution and before native reservation activation. Pass that same Instant
through service resolution, descriptor preparation, native copy/hash, Prepared validation, stamp
and final commitment. Registry timeout uses only its remaining duration; native activation never
resets it. Stamp/commit refuse expiration, including time spent waiting for the gate. An expired
prelaunch deadline requires zero child spawn. Then use a five-second first-receipt limit and
thirty-second total turn deadline. Retain a ten-second read-idle limit and two-second initial cleanup reporting
budget. These require explicit composed checks; the current core's thirty-second execute
deadline alone does not provide all of them. Blocking filesystem/spawn operations remain
cooperative, not hard wall-clock deadlines. No timeout permits dropping owned resources.

## First evidence and acceptance order

1. **Genuine Ready composition first.** Stage the existing fixed Mach-O sibling and the exact
   composed test runner. Create fresh actual services, use generation zero and actual host send,
   and authorize only after Prepared/service revalidation. Assert exactly one child, native
   cwd equals the registered Project descriptor, and receipt text/frame digests match the
   captured callback and written frame. Observe natural zero exit, reap/removal acknowledgment,
   actual host turn completion and no assistant text. All-close must then release the real
   account/Project writers and remove the known copies. Independent native or service-only
   evidence cannot satisfy this test.
2. **Consumed then stalled.** Use the existing IgnoreCancel fake. Observe genuine parsing before
   stop, prove actual service writer locks remain busy, refuse a non-force close without
   revoking the turn, then force close/cancel. Require exact-child reap and native scratch
   acknowledgment before host/account release. No caller Tokio runtime or repeated caller
   ticks may be required for cleanup.
3. **Commit barriers.** Deterministic private test barriers cover cancellation before reservation
   activation, during validation/before stamp, after stamp/before commitment, and after
   commitment/before PID return. Exercise a real SignedOut/Ready re-observation or failed
   metadata attempt while Pending. Precommit winners must have zero spawn; postcommit winners
   permit at most one spawn and require cleanup. Include Project path replacement with the
   real held descriptor, stale update routing, and second-send refusal. Barriers are fixed
   test-only enum states, not executable/callback inputs on the facade.
   Spend the shared prelaunch deadline before native activation and prove it is not reset.
4. **Failures and retention.** Exercise fixed artifact/preparation failure, spawn failure and
   native/actor panic with the actual retained flight. Add a worker-driven still-owned cleanup
   delay after a real stalled child, publish uncertainty, prove owners remain locked, then
   permit actual reap/removal and observe later cleanup acknowledgment with the original
   failure terminal unchanged. This closes the existing Shared-publication-only coverage gap.
   Hold the worker before its final descriptor destruction/return, even after public report
   flags look clean, and prove service close still waits for the exact joined acknowledgment.
   A bounded fixed malformed-input/nonzero or malformed-receipt fault must never become a
   completed host turn. Permanently lost/uncertain paths and consumed-owner-slot close failure
   must withhold success and retain ownership; no reset of ACTIVE or cleanup state is allowed.
5. **Preserve both accepted layers.** Run offline default/all-feature ACP tests, all standalone
   targets, strict Clippy/fmt, the existing six staged core cases and the new composed cases.
   The checker records actual native/runner digests, captured-input digest, cwd/PID evidence,
   terminal/reap facts and exact teardown. Verify one core/ACTIVE per composed process and
   automatic versus composed Busy behavior. Report this as an empty synthetic host turn with
   native input consumption, never full ACP, real model output or production launch authority.

Review the reservation/workspace/cleanup-ack seam before wiring provider success events. Then
implement the two genuine composed tests before expanding failure coverage. Any need for an
account lease, owner API changes, arbitrary executable support, descendants, real provider
negotiation or a generic cleanup scheduler is a separate checkpoint decision.
