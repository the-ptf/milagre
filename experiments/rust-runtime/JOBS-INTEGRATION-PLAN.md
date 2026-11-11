# Isolated transcript job integration

The isolated actor now consumes ChatHost::take_jobs and observes QuitState. Job execution and pending shutdown are implemented; automatic restore staging, BriefModel and production provider handoff remain gated. Tests stage work only through the owner's test-fixtures feature in a dev-dependency. The normal/build dependency graph excludes that feature.

`milagre_owner_store::transcripts` reserves at most four non-clone TranscriptJob capabilities. job.run consumes the capability and reports to the private owner inbox. A completion guard reports Unknown on drop or panic. Runtime never calls take_outcomes, finish, commit or discard; ChatHost owns generation and ownership checks.

## Ownership and execution

1. Keep ChatHost, ProjectStates, provider admission and publication on the existing owner actor. Consume take_jobs once; do not put jobs in notices or clone them. The owner reserves at most four transcript jobs when staging a restore.
2. Hand each non-clone job capability to a bounded worker outside the actor/publication critical section. File work never calls back into the actor synchronously. If worker admission fails, drop the job through its completion guard so the owner's shared inbox receives the agreed failure/unknown outcome; do not silently lose its reservation.
3. Keep the private profile, job permit and worker alive until the job's completion/cleanup is observed. Run, drop and panic must report exactly once through the job-owned guard. Pinned-descriptor temporary writes, rename and cleanup remain owner implementations, never reconstructed from caller paths in runtime.
4. Drive completion intake and owner ticks while admission is closed. A timed-out or interrupted write remains potentially committed. Never replay the job; retry only cleanup or persistence of the same computed divider when the owner explicitly allows it.

No worker-pool constructor or executable/profile input is exposed to a renderer. The actor has at most four worker threads and four pending owner capabilities. A just-completed thread can briefly coexist with its replacement reservation. Finished threads are joined before reuse; the actor never waits for a running job inside the publication transaction. Spawn refusal drops the capability and its completion guard reports Unknown. This failure branch is implemented but OS thread-spawn failure is not injected in tests.

## Quit and server acknowledgement

The negotiated owner states are Running, ClosePending and JobsPending { jobs, cleanups }, followed by Done. shutdown returns QUIT_PENDING while work remains. The current wire server correctly retains its socket and withholds daemon:stopping when its handler returns an error, so the runtime must preserve that behavior.

A quit request closes new admission while ticks and worker completion intake continue. Normal shutdown(false) still refuses active or preparing work. Only the private forced fixture path cancels staged handoffs. The final shutdown call drains owner notices even when close fails and is retried. Done plus joined workers is required before the handler returns success and the wire server announces stopping.

shutdown_pending runs outside the actor and retries only QUIT_PENDING, returning it after the caller's bounded wait expires. The actor, Claude and ACP fixture executables use this driver on stdin EOF; a pending result retains the server and retries another bounded interval, with one diagnostic. Busy refusal and save errors are surfaced rather than silently forced or retried. A per-attempt typed ShutdownError distinguishes Refused from Incomplete. The actor reopens only after its actual busy gate leaves the owner Running, the attempt began with open admission, and final publication succeeds; the wire reopens on that same Refused result. Pending jobs, failed saves and publication faults keep admission closed. On EOF refusal the driver exits its retry loop, emits one bounded reason and the operator instruction to resolve the condition and retry daemon:stop; the executable remains reachable on its fixture socket. No refusal busy-loop or automatic force occurs. Repeated daemon:stop requests remain retryable.

Forced forget retains its Project and lock until jobs report and cleanup finishes. No separate runtime finish callback exists. State owns an opaque ProfileLease acquired before Server::bind. State Drop joins workers before destroying the host and releases that lease last, so forced Server Drop cannot remove the profile underneath a retained actor or its workers. SavedCopies and OwnedCopies retain their own leases, including when content or terminal callbacks retain backend Arcs. Forced drop remains a crash boundary: retaining files until teardown does not imply saved state, consumed job outcomes, graceful cleanup or survival after process termination.

## Verified fixture evidence

- Four paused jobs fill the owner's reservations; a fifth is refused before staging. Actor ticks and Stop remain responsive.
- A handshake holds each worker before run. Repeated bounded shutdown attempts and three production Node-client daemon:stop calls report QUIT_PENDING with no stopping event; socket, profile and Project lock remain present. Releasing jobs allows Done, joined workers and successful shutdown.
- Forced forget stays pending for normal completion, worker panic and dropped-unrun jobs. After the owner consumes each outcome and cleanup, forget releases the lock. No job is replayed.
- A forced Server Drop with an actual paused transcript job and retained Actor preserves the profile and Project lock. Actor destruction blocks until worker release/join, then the final lease removes the profile. Separate tests check retained saved/owned backends after server teardown.
- A prepared handoff refuses normal quit, then accepts another command through both actor and production Node client. Explicit interrupt cancels preparation, pending quit remains closed, and releasing the job permits a successful retry. Existing failed-save tests still assert CLOSING until the save can be retried.
- A real restore send, with HandoffMode::Restore enabled only in cfg(test), is driven by the production Node client. It creates a preparing run and saved divider. Fixture quit interrupts that run and returns QUIT_PENDING while its actual transcript job is paused; one cancellation is emitted, retry sends are refused, and the mock provider never starts before or after job completion. Final saved state has one user message and a failed divider. After late-job completion and joining, the test directly observes QuitState::Done, no stranded-lock notice, and no temporary or committed session transcript anywhere in the private handover store. This verifies cancellation, not successful restore execution.
- The full existing runtime compatibility suites still exercise ordinary refusal, failed-close retry, provider answers and Node clients.

## Brief generation and restore

The brief model remains separate from a Chat's provider session. The agreed fixed fake boundary has eight slots, a 256 KiB request limit, a 64 KiB reply limit and a 30-second deadline. Bind job/brief identities strictly; apply the existing single text-decoding boundary only to free text. Cancellation and late completion must not reach another restore generation.

Implement restore only at first. Keep switch, provider capability changes and any bypass of native-context continuity gated. ACP's second send remains refused/held until the owner actually stages and completes its transcript-and-brief restore.

## Remaining fixture evidence

- The exact restored prompt at the native ACP process boundary. The successful fixture below currently observes the Provider admission request; the fixed FakeSession has no received-prompt accessor yet.
- Delayed transcript commit, Stop and late completion preserve Unknown/no-replay and cannot start a replacement turn incorrectly.
- Brief deadline, cancellation, malformed identity, oversize request/reply and stale result all fail closed without a live model or account.

## Pending Git admission

Production and executable runtime constructors do not call ChatHost::admit_worktree. One cfg(test) successful-restore fixture now admits a newly created own-.git repository under its ACP provider Isolation. A saved worktree path does not grant authority. The existing GitService owns a separate IsolatedGit temporary root and cannot be admitted to an actor's different isolation. The test creates its repository through trusted setup, admits that exact canonical path explicitly, and keeps production Restore gated. Direct TranscriptSource helpers still use changed: None; the successful send obtains its changed-files plan from the owner.

## Successful restore fixture

The acp-fixture unit test successful_restore_is_saved_before_the_second_acp_process_and_never_replayed drives the actual Node client through two turns in one Chat. Only that test calls enable_restore_for_tests. Every executable still uses Gated.

1. The first fixed ACP process replies Hello and is reaped. The Node client changes edited.txt and creates fresh.txt in the new private repository, then sends the second message.
2. A handshake pauses the owner-issued transcript job on its worker thread. The actor remains responsive. Saved storage contains exactly one second user message and a preparing divider; no transcript is committed and the second provider has not started.
3. Releasing the worker lets the owner commit its transcript and use its no-model minimal brief. A test-only Provider wrapper reads saved storage before forwarding admission to AcpFixture. It observes a done divider and a framed prompt with both exact changed filenames. The transcript worker and provider-admission actor have different thread IDs.
4. The second fixed ACP process completes once. The Node client sees one second user message, one assistant reply after it, and one done divider. Resending the same clientMessageId starts no third process. A second handshake keeps the owner alive while Rust inspects the committed transcript and confirms no temporary file remains.
5. Node then requests daemon:stop. The test checks QuitState::Done, no stranded-lock notices, two distinct reaped child PIDs, no cleanup failure, and deletion of the private profile after joined teardown.

This proves adapter-boundary prompt framing, durable ordering, no-model changed files, transcript-worker separation and two-process lifecycle. It does not yet prove the exact bytes consumed by the native fake, successful model-generated briefs, restart/resume, arbitrary repository admission or production handoff. The first full run exposed a test race reading the transcript after successful shutdown had deleted the profile; the explicit restored/stop handshake fixes that ordering without delaying teardown.

## Explicit Project readiness

The actor now uses ChatHost::open_project before sends, queue operations, answers and provider events. Trusted fixture startup explicitly opens its exact generated Project before binding the socket. This may make that Project visible in the initial fixture snapshot sooner than the former lazy open; it is a fixture compatibility change, not production migration wiring.

Only project:open and project:switch retry opening, after the exact admitted path check. project:current, project:snapshot, state:read, other Project reads and renderer content operations use the non-recovering require_project_ready guard. They never reopen after forget or retry failed recovery. The four direct Codex owner fixtures and job fixtures also explicitly open. The Restore test uses enable_restore_for_tests; no release constructor enables it.

Publication checks is_project_ready rather than assuming loaded state is ready. ProjectReady is handled only for the actor's exact Project, mapped to existing project:state publication. Partial loading/recovery emits no Project snapshot, runs or state broadcast. Readiness loss clears visibility and revokes the content generation. A successful explicit retry allows new grants; old grants remain revoked. OWNER_CLOSING, PROJECT_NOT_READY and HANDOVER_STORE_BUSY retain the owner's distinct wire codes. Other storage failures retain the existing error mapping.

Verified through production Node clients and private fixture guards:

- A competing handover-store lease refuses open, retains the Project lock, emits no ready/state publication, and blocks reads/sends. Releasing the lease does not reopen; explicit open recovers and produces one ProjectReady. Repeated ready open is silent.
- A forced coordination rename failure after recovery leaves no visible partially recovered Project or content scope. Repairing that private file still requires explicit open; the retry durably recovers before publication.
- Replacing the ready handover directory invalidates its identity check, hides Project state and revokes retained content grants. Restoring the directory alone does not reopen. Explicit open restores readiness but never revives the old grant generation.
- Forget followed by current/snapshot/state:read stays refused; late provider events and reads do not recreate its lock.

Only the cfg(test) successful-restore fixture admits its own fresh Git repository. Release constructors still expose no Git admission or successful Restore.
