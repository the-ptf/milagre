# Fixed synthetic service/native composition

Status: root validation and independent source review passed; no P1/P2 found. Baseline `ea5e57fe` provided the private reservation, registered workspace, exact
worker join and non-Clone cleanup acknowledgment. This checkpoint connects that core to the
real copied services accepted in `3ab4a9e7`, solely in the standalone integration target
`fixtures/synthetic-host/service_native_composition.rs`.

## What executes

The private actor owns fresh actual registry, account and ChatHost services. Real ChatHost.send
allocates the Chat and TurnId; the capture provider supplies the original bounded callback
prompt. The service owner validates exact selection, account incarnation/generation (including
zero), readiness epoch, registry snapshot and descriptor identity. It duplicates its registered
Project/home/tmp descriptors once. Native preparation copies only the fixed sibling artifact;
its scratch is separate from those service directories.

One private core is source-included in this process. The standalone package has no milagre-acp
dependency, so it cannot accidentally compile a second ACTIVE gate through the ordinary feature.
The public wrapper/default dependency graph and production refusal gates remain unchanged.
No arbitrary executable, cwd, environment, descriptor, callback or proof boolean enters the
fixture facade. Private test hooks are closed enum failures and bounded pause handles.

The actor retains the reservation before activation and installs its cancellation handle under
the route mutex. After Prepared, it captures the native gate, revalidates actual services outside
locks, then stamps under route -> native-gate ordering. Exclusive mutation invalidates first,
including failed mutation attempts. External cancellation reaches that native gate without
caller Tokio or actor ticks. The worker never calls services or takes the route mutex.

One five-second deadline is captured before service resolution and passed through native
activation, preparation, stamp and commitment. Registered total time is that deadline plus
25 seconds. Receipt validation is limited to five seconds from immediately before spawn;
successful data renews only the ten-second read-idle limit. Both are capped by total time.
Blocking filesystem/spawn operations remain cooperative checks, not hard wall-clock bounds.
Text is at most 64 KiB, frame 512 KiB, receipt 4096 bytes, artifact 64 MiB, hash scratch 32 KiB.
One command/reply, one native observer and one bounded cumulative status serve the single turn.
Fixed provider batches contain at most four events and less than 64 KiB. Actual owner state
retains its own documented bounds.

## Native facts and actual owner behavior

| Native evidence                                                                                 | Actual ProviderEvent handling                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validated compiled marker, exact PID, nonce, registered cwd and input digests                   | Started and Agent turn-started for the captured host identity. This proves the fixed fake parsed the input, not model execution or ACP session initialization. |
| Receipt, EOF, natural zero exit, exact reap, scratch removal and accepted joined acknowledgment | One Agent turn-completed, then Exited. The real owner must end that turn and flush its state before successful terminal delivery is reported.                  |
| Failure before consumption                                                                      | StartFailed for the captured pending turn. No Started or completed result.                                                                                     |
| Cancellation/error after consumption                                                            | Cancelled/failed terminal; Exited only after exact reap. The first failure remains fixed if native cleanup later recovers.                                     |

The native fake produces no assistant reply. The unchanged real owner stores a user message
and its existing assistant fallback `The agent finished without a reply.`, with outcome
`completed`. The Ready test pins both exact messages and the stored outcome. No adapter-created
model text, fake host identity or seeded transcript is involved.

Terminal choice is recorded once under the same route mutex as cancellation. Cancel returns
false after that decision. A test pauses between the decision and actual host fold to prove
that a late cancel cannot claim it won while completion is emitted. No service call or I/O runs
under the route mutex. Delivery errors distinguish refused enqueue from an accepted event
whose fold/save remains retained. Delivery flags advance only after enqueue; a refused enqueue
can retry. Owner tick success alone does not prove the terminal state was saved.

## Cleanup ownership

Public Report/finished/reaped/resources_removed fields never release service ownership. The
actor retains the exact worker handle and obtains the private non-Clone acknowledgment only
after actual join. It consumes that acknowledgment against the original reservation identity.
Before returning, the worker destroys all native and registered descriptor resources. Registered
ACTIVE stays held through that tail. A no-worker reservation disposes its own reserved inputs
before issuing its exact NoChild acknowledgment.

An account reopen attempt revokes admission but refuses while native disposal is unacknowledged;
it cannot consume the retained writer. Non-force busy close refuses before revocation. Force Project-close cancels and waits for the
acknowledgment before real host forget, while keeping accounts open. All-close then performs
checked host shutdown, closes accounts last and removes the generated copies. A failed host
save retains owners for retry after restoration. A consumed owner slot or remaining lock makes
cleanup uncertainty sticky; native success cannot clear it or reopen the account writer.

Facade drop leaves the actor owning cleanup. Caught native-operation panic may yield an
acknowledgment after actual disposal but remains a failed turn. An escaping worker panic or
permanently retained native resources yields no acknowledgment, so the service bundle remains
retained. No child/group/descendant cleanup claim extends beyond this exact fixed child.
The cooperative same-UID pathname boundary still excludes malicious mutation after final
validation. Copied owner services retain their existing ps helper.

## Evidence

Run the fixed checker:

```sh
python3 experiments/rust-acp/scripts/check-private-copy-fixture.py
```

It builds and stages the exact native sibling, records native/test-runner SHA-256 values and
runs each ignored case in a fresh process. It retains the original seven staged core/context
cases and adds composed cases for Ready, IgnoreCancel, both native commitment races, admission
activation/stamp gaps, no deadline reset, report-before-join retention, worker-driven delayed
cleanup recovery, native/actor panic, spawn failure, malformed native input, facade drop,
service save retry, sticky service release failure, partial native preparation retention,
unactivated-reservation panic disposal and
the terminal-decision race. The staged tests assert genuine receipt/PID/cwd/prompt identity,
actual provider notices/state, exact disposal and real service writer locks.

The delayed-cleanup case deliberately pauses the worker with its actual still-owned stalled
child and publishes CleanupUncertain. It does not simulate successful reap. After release,
the real exact-child path reaps/removes/returns, the actor joins, and the original failed turn
remains failed. Permanently retaining cases emit identity manifests; only the fixed staging
parent removes those generated roots after their test process exits.

Offline deterministic checks include timing boundaries, foreign/stale service event refusal
and the distinction between rejected enqueue and retained owner save. Standalone copied-service
admission and native-only targets remain separate evidence. Agent validation passed 58 default tests, 124 all-feature tests plus one doctest, and 53
standalone tests (19 native-context, 12 service-admission, 22 composition/context). Both strict
Clippy contexts and formatter checks passed. All 18 staged cases passed in
`/tmp/milagre-acp-composed-freeze-real.log`, including the escaped-event-budget and host-TurnId
assertions. After the last account-reopen retention guard, all 53 standalone tests and strict
standalone Clippy passed again; the affected actual staged join-barrier case passed in
`/tmp/milagre-acp-composed-writer-guard.log` with `reopenWriterHeld=true`. Its manifest records
the exact runner/native artifact hashes. Root reran the final source, including the account-reopen guard: 58 default tests, 124 all-feature tests plus one doctest, all 53 standalone tests, default/all-feature/standalone strict Clippy and both formatter checks passed. All 18 staged cases passed in `/tmp/milagre-acp-composition-root-real.log`. The final stage `/private/tmp/milagre-acp-copy-stage-cwx3dwod` was removed. Other root logs are `/tmp/milagre-acp-composition-root-{default,all,context,default-clippy,clippy,context-clippy,features}.log`. The feature graph has neither an ACP dependency nor owner test-fixtures.

Final native SHA-256 is `04c6d7312a366abcfec9c5eebcc503f4e71953dde47a9217f2c26279fb9bf4ce`; main runner is `7e0da13ece2e6025d5858570d740443dc70c0c46b0c7336000936a191389198d`; composed runner is `fd20d91f87d1527864e38f12f1323c5d04a61166173392c9fdbf9bfb08ce58fa`. The manifest records `sourceAttestation: false`. Ready observed actual host TurnId 1, account generation 0, PID 33450, registered cwd inode 33232248 on device 16777233, joined cleanup and removed service roots. The prompt digest was `7959714074bba536c866b20f88583ddd71939582269e0080b9b321ede3d75e81`. IgnoreCancel observed PID 33541 and retained owners until joined acknowledgment. These are run-specific observations, not pinned future identities.

Independent source-only review found no P1/P2. One P3 remains: if a terminal event was enqueued but its fold/save failed, `snapshot.terminal` stays unset even after a later successful close. `decision`, error and actual stored state remain available; the later close still requires its real owner save. This fixture does not reconcile that observational field after recovery.

This is an empty fixed synthetic host turn with native parsing evidence, not a complete ACP session or production grant.
