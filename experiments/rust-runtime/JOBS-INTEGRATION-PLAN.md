# Pending owner job integration

This is an implementation plan against the negotiated contract, not an implemented API. The current owner source still has no take_jobs or quit_state interface. Wait for its tested checkpoint before matching types or removing restore gates. All planned execution remains inside fresh isolated fixture copies with fixed fake providers.

The transcript foundation is now available in `milagre_owner_store::transcripts`: `TranscriptJobs` reserves at most four non-clone `TranscriptJob` values; `job.run()` consumes its capability and reports to the private owner inbox. A completion guard reports Unknown on drop or panic. Runtime must not call `take_outcomes`, `finish`, commit or discard: those belong to ChatHost's generation and ownership checks. The host-facing job and quit methods remain pending.

## Ownership and execution

1. Keep ChatHost, ProjectStates, provider admission and publication on the existing owner actor. Consume take_jobs once; do not put jobs in notices or clone them. The owner reserves at most four transcript jobs when staging a restore.
2. Hand each non-clone job capability to a bounded worker outside the actor/publication critical section. File work never calls back into the actor synchronously. If worker admission fails, drop the job through its completion guard so the owner's shared inbox receives the agreed failure/unknown outcome; do not silently lose its reservation.
3. Keep the private profile, job permit and worker alive until the job's completion/cleanup is observed. Run, drop and panic must report exactly once through the job-owned guard. Pinned-descriptor temporary writes, rename and cleanup remain owner implementations, never reconstructed from caller paths in runtime.
4. Drive completion intake and owner ticks while admission is closed. A timed-out or interrupted write remains potentially committed. Never replay the job; retry only cleanup or persistence of the same computed divider when the owner explicitly allows it.

No worker-pool constructor or executable/profile input is exposed to a renderer. Queue capacities must be checked against the owner's four reservations rather than adding a second unbounded queue.

## Quit and server acknowledgement

The negotiated owner states are Running, ClosePending and JobsPending { jobs, cleanups }, followed by Done. shutdown returns QUIT_PENDING while work remains. The current wire server correctly retains its socket and withholds daemon:stopping when its handler returns an error, so the runtime must preserve that behavior.

A quit request closes new admission, but keeps the actor, host locks, workers and profile alive. A non-actor shutdown driver must continue ticks and retry shutdown until Done. It cannot run server.shutdown on the actor thread because that calls back into the actor. The executable must not call Server::finish or treat an EOF shutdown attempt as success while QUIT_PENDING remains. Whether the final owner API offers a notification or requires polling determines the driver's concrete implementation.

Only Done may produce the existing stopping acknowledgement and allow profile teardown. Unknown cleanup remains visibly pending; elapsed time is not evidence of success. Forced object drop remains a crash boundary, not a substitute for the agreed quit protocol.

Before wiring the host API, verify that take_jobs remains usable while closing, ticks continue draining completions and cleanup under QUIT_PENDING, and forced forget refuses new sends while retaining its Project until the jobs return. Done must include completed cleanup and consumed outcomes, rather than only a zero worker count. No separate runtime finish callback is needed because each job reports itself.

## Brief generation and restore

The brief model remains separate from a Chat's provider session. The agreed fixed fake boundary has eight slots, a 256 KiB request limit, a 64 KiB reply limit and a 30-second deadline. Bind job/brief identities strictly; apply the existing single text-decoding boundary only to free text. Cancellation and late completion must not reach another restore generation.

Implement restore only at first. Keep switch, provider capability changes and any bypass of native-context continuity gated. ACP's second send remains refused/held until the owner actually stages and completes its transcript-and-brief restore.

## Required fixture evidence

- Actual Node client restore after a completed nonresumable ACP turn, with the exact next native prompt asserted when the fixed fake supports it.
- Four reserved jobs saturate without blocking owner ticks or Stop; admission failure/drop/panic each returns one outcome and releases the reservation through the owner inbox.
- Delayed transcript commit, Stop and late completion preserve Unknown/no-replay and cannot start a replacement turn incorrectly.
- QUIT_PENDING keeps the socket, host lock and private profile alive with no stopping acknowledgement. Releasing the job/cleanup permits Done and one acknowledgement.
- Brief deadline, cancellation, malformed identity, oversize request/reply and stale result all fail closed without a live model or account.
