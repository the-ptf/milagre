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
- A real restore send, with HandoffMode::Restore enabled only in cfg(test), is driven by the production Node client. It creates a preparing run and saved divider. Fixture quit interrupts that run and returns QUIT_PENDING while its actual transcript job is paused; one cancellation is emitted, retry sends are refused, and the mock provider never starts before or after job completion. Final saved state has one user message and a failed divider. This verifies cancellation, not successful restore execution.
- The full existing runtime compatibility suites still exercise ordinary refusal, failed-close retry, provider answers and Node clients.

## Brief generation and restore

The brief model remains separate from a Chat's provider session. The agreed fixed fake boundary has eight slots, a 256 KiB request limit, a 64 KiB reply limit and a 30-second deadline. Bind job/brief identities strictly; apply the existing single text-decoding boundary only to free text. Cancellation and late completion must not reach another restore generation.

Implement restore only at first. Keep switch, provider capability changes and any bypass of native-context continuity gated. ACP's second send remains refused/held until the owner actually stages and completes its transcript-and-brief restore.

## Remaining fixture evidence

- Actual Node client restore after a completed nonresumable ACP turn, with the exact next native prompt asserted when the fixed fake supports it.
- Delayed transcript commit, Stop and late completion preserve Unknown/no-replay and cannot start a replacement turn incorrectly.
- Brief deadline, cancellation, malformed identity, oversize request/reply and stale result all fail closed without a live model or account.
