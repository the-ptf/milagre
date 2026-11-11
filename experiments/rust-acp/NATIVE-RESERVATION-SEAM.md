# Native reservation, workspace and joined cleanup seam

Implemented for source review as the first stage of
[SERVICE-NATIVE-COMPOSITION-PLAN.md](SERVICE-NATIVE-COMPOSITION-PLAN.md), based on `c2769427`.
The copied-service actor remains disconnected. No Started/completion adapter events, composed
host success, real provider, production authority or descendant-cleanup support is added.

## Private ownership boundary

`reserve` returns Control, the single Observer and a one-shot Reservation before any worker
thread starts. The reservation already owns ACTIVE, its bounded input and any registered
descriptor copies. The caller can install cancellation/retention ownership before activation.
Explicit abandonment returns core-owned NoChild disposal; dropping an unused token cancels and
disposes it but discards its cleanup acknowledgment. A future service guard must use the explicit
path and retain services whenever it has no accepted acknowledgment.

Activation returns Running with the exact JoinHandle, or an explicit no-worker disposition for
revocation, expiration or worker-creation failure. The existing automatic/prepare entry points
use this same reservation and ACTIVE implementation. The public wrapper still exposes only its
existing start/cancel/wait/progress surface and fixed closed scenarios. Its observer-only
ownership still detaches the native worker, which retains child/resources through cleanup.

`Running::try_join` returns pending until the exact thread is finished, then performs an actual
join. Only a joined native disposal fact creates CleanupAck. A panic escaping the worker thread
or retained cleanup returns no acknowledgment. A caught execution panic may produce an
acknowledgment after proven reap/removal and destruction: its operation remains failed with
WorkerPanic and natural_zero=false. CleanupAck is non-Clone, has private immutable reservation
identity, contains no descriptors/paths/callbacks, and is accepted once by the matching Control.
A foreign acknowledgment is returned intact. Public finished/Report/reaped/removal flags never
substitute for this acknowledgment.

RegisteredWorkspace accepts only owned directory descriptors through the private core API.
The future exclusive service coordinator must supply duplicates of its granted Project/home/tmp
descriptors. Internal F_GETPATH derives expected paths; the input checks close-on-exec, directory
type/owner/mode, exact descriptor/path identity, common parent layout and canonical paths.
It carries no registry or account authority by itself. There is no public raw descriptor,
arbitrary executable, path, environment or proof-boolean input.

The worker separately owns executable scratch and these non-deleting workspace descriptor
copies. Composition-mode preparation creates no unrelated native workspace/home/tmp. Final
checks validate the registered layout; child cwd uses its held Project FD through fchdir.
HOME/TMPDIR use the fixed synthetic sibling layout. Native cleanup removes only native scratch,
then destroys the registered copies before returning. Join also waits for thread destructors.
Registered-flight ACTIVE remains held until those descriptor copies are destroyed, including
the interval where public report flags already look clean. The wrapper's existing publication
after capacity release is preserved for its self-contained workspace.
The original workspace directories remain for their service owner to close and remove later.

## Deadline and process facts

One immutable absolute prelaunch Instant is stored in the reservation's Shared state. A future
service owner must capture it before registry resolution. Activation, preparation, stamp and
commit all use that same deadline; activation does not reset it. Stamp/commit check expiration
after taking the native Gate, so gate wait time counts. Expiration before commitment produces
no child. Checks around filesystem/spawn operations remain cooperative.

After a validated receipt and EOF, the worker now observes natural exit using WNOWAIT and reaps
through its exact retained Child. It never sends a signal on this normal path. Only observed
exit code zero permits successful execution. Retained status prevents cleanup from probing,
waiting or signalling that reaped child again. Cancellation/error uses the existing
signal-before-reap path. Lost ownership remains sticky and withholds cleanup acknowledgment.

Disposal distinguishes NoChild from Reaped with actual PID/status and a natural-zero fact.
Absence of a receipt or PID is never used to infer NoChild. Cleanup uncertainty keeps the native
slot and native resources; any future service bundle must remain held too. The accepted macOS
cooperative private-copy boundary, fixed native sibling, 64 MiB artifact cap, 32 KiB hash scratch,
0700/0500 modes and no-descendant restriction remain unchanged. The five-second startup and
ten-second read-idle composition policies and actual service-side close integration remain later work.

## Evidence and next boundary

Unit tests cover reserved capacity before activation, expired activation without a reset,
preactivation cancellation, explicit abandonment, foreign/one-shot cleanup identity, and
expiration at stamp/commit. The staged registered-workspace test runs a real native child and
checks its compiled receipt, actual cwd inode, input digest and natural zero exit. It holds the
worker before final workspace descriptor destruction while public flags already look clean:
try_join remains pending and all four descriptor copies stay open. After actual join, those
copies are EBADF, matching acknowledgment succeeds, and the original directories remain.

The staged case also covers expiry after stamp before final commitment with zero spawn,
workspace replacement refusal without switching directories, injected worker-creation failure,
actual pre_exec spawn failure, native-worker panic after spawn, and consumed-before-cancellation
cleanup. The worker-creation refusal is an injected error path, not OS resource exhaustion.
Registered workspace inputs in this test come from its fresh owned synthetic directories;
this is not evidence of ServiceOwner registry/account admission or a composed host turn.

The checker retains all six prior staged cases and adds this seventh case. Validation commands
remain offline default/all-feature ACP tests, both standalone targets, strict Clippy/fmt for
both manifests, and `scripts/check-private-copy-fixture.py`. Current logs use the prefix
`/tmp/milagre-acp-reservation-`: `default.log`, `all.log`, `standalone.log`, `clippy.log`,
`standalone-clippy.log` and `final-real.log`. Native logs record artifact/runner/input identities;
checkout HEAD is not source-to-binary attestation.

The next approved step can connect the actual ServiceOwner, bind cancellation/service epochs
to the same gate, and require this exact joined acknowledgment before actual host/account
release. The accepted sticky owner-close uncertainty rules still apply afterward. This seam
does not authorize service cleanup from a public Report or native receipt alone.
