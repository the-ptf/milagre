# Native core boundary checkpoint

Implemented for source review under the agreed
[synthetic coordinator scope](SYNTHETIC-COORDINATOR-CHECKPOINT.md). This checkpoint contains no
account/registry/ChatHost composition, registered Project descriptor input, production provider
authority, full ACP session, assistant text or general descendant cleanup.

## One implementation and two compile contexts

`src/private_copy/core.rs` is the single owner of ACTIVE, admission and progress. The existing
public feature wrapper delegates to it and keeps `start`, `cancel` and `wait`. The separate
`fixtures/synthetic-host/Cargo.toml` compiles the same private source once as an integration test.
It has no `milagre-acp` dependency, no host/account/registry dependencies yet, no library facade
and no selectable executable. The root ACP manifest, features and lockfile are unchanged.
The checker verifies the standalone dependency graph and proves automatic/coordinated starts
share one Busy slot in a process. Separate test processes naturally own separate fixture slots.

## Private admission boundary

Private `prepare` returns one Control and one Observer. The worker owns the slot/resources,
prepares the fixed artifact and publishes Prepared, then waits within the original cooperative
five-second budget. Prepared does not authorize spawn. Control captures an opaque instance/epoch
before its owner's validation, then consumes that capture in `stamp`. Foreign, revoked,
unprepared and already-stamped captures refuse. This method implements no account validation;
the future exclusive coordinator must perform the agreed real service checks before stamping.
These types are unavailable from the public feature wrapper.

The worker completes final identity/digest checks, then commits once under the same gate used
by invalidation. Invalidation clears the stamp and permanently revokes this launch; checked
identity/epoch comparison rejects stale capture, and epoch saturation can never reopen a
revoked gate. Control drop also revokes. There is no await after commitment before the single
spawn attempt. Revocation after commitment can race that spawn; prompt writes still check it
before each admitted write. No replay or zero-execution-after-commit claim is added.

The public standalone execution wrapper retains its approved automatic fixed-fake behavior:
its private worker holds the Control and stamps after native preparation. The coordinated
compile context holds Control outside that worker. Neither entry accepts a proof boolean,
arbitrary path/environment, custom callback or public launch plan.

## Cancellation, evidence and revisions

A cloneable CancelHandle permits cancellation during an exclusive observer wait. Observer and
Control drop revoke independently. `wait` preserves its current-report compatibility behavior;
`next_progress` returns a cumulative bounded snapshot for each changed revision and then None
after the final snapshot. Both require the same mutable observer, so two tasks cannot replace
each other's waker while waiting concurrently.

The snapshot retains Prepared and child-validated Consumed evidence alongside the latest
cleanup Report. Consumed publishes immediately after receipt validation, before EOF or cleanup;
it proves parsing only. Coalescing does not lose that evidence. Repeated identical uncertainty
does not create revisions. The first terminal error remains fixed, and known reap/removal flags
only advance. Final means no further observation updates, including sticky Lost or unremovable
scratch; it is not a successful-cleanup flag. No caller Tokio runtime is required.

The process ownership code is unchanged: WNOWAIT observation, exact-child signal before reap,
no post-reap signal, and sticky Lost. Resource guards keep ownership and capacity on uncertain
cleanup. The fixed fake has no descendants. Shared source extraction does not reopen the
separate ACP supervisor's descendant/authority gates.

## Validation and remaining work

The staged checker executes five separate fixed tests: public progress/cancellation, original
native/lifetime coverage, coordinated admission/consumption, partial-preparation retention, and
standalone progress without caller Tokio. The partial-preparation test replaces the private copy
after writer close but before final reader admission. Its full worker reports CleanupUncertain,
no PID, no removal and Busy on the next start. It intentionally retains resources until its own
test process exits. The parent validates a fixed two-entry identity manifest before test teardown;
neither backend nor test resets ACTIVE or claims that retention was successful cleanup.

Run:

```sh
cargo test --offline --locked --manifest-path experiments/rust-acp/Cargo.toml
cargo test --offline --locked --manifest-path experiments/rust-acp/Cargo.toml --all-features
cargo test --offline --locked --manifest-path experiments/rust-acp/fixtures/synthetic-host/Cargo.toml
python3 experiments/rust-acp/scripts/check-private-copy-fixture.py
```

Strict Clippy and formatting apply to both manifests. Logs from the current implementation are
`/tmp/milagre-acp-core-default.log`, `/tmp/milagre-acp-core-all.log`,
`/tmp/milagre-acp-core-context.log` and `/tmp/milagre-acp-core-final-real.log`.
The final log records native and runner digests, exact test names, observed evidence and staging
removal. Checkout HEAD is explicitly not source-to-binary attestation.

Next, after source review, the separate coordinator checkpoint can add actual copied services,
their exclusive validation epochs, registered Project descriptor ownership and retained two-phase
host close. None of those properties is inferred from this native-core evidence.
