# macOS private-copy native fixture

`macos-private-copy-fixture` is off by default. It adds `private_copy::MacOsPrivateCopyFixture`
and one dedicated `native-acp-copy-fixture` binary. This is the standalone execution backend
checkpoint, **B06-Mac**, under a cooperative same-UID fixture contract. It is not the strong
immutable-descriptor B06, production authority, a fallback, an account lease, an owner adapter
or a complete ACP session. Existing `AcpRpc`, fake-session and launch-planning behavior is unchanged.
No account, registry, owner, runtime or installed app imports this backend.

The [private-core checkpoint](NATIVE-CORE-CHECKPOINT.md) extracts the same implementation for
a standalone compile-context test. It adds cancellation/progress observation and a private
stamped admission boundary; it does not compose the account, registry or ChatHost services yet.

## Fixed authority and preparation

The public entry is `start(FixtureCase::Ready|IgnoreCancel, text)`. It accepts at most 64 KiB of
UTF-8 text. There is no executable/profile/cwd/path/environment/callback parameter, raw RPC,
write authority or public constructor from a plan. The only source executable is the exact
`native-acp-copy-fixture` sibling of the running test executable. The staging script builds that
fixed target offline and copies it beside the exact library test runner. It records both hashes;
checkout HEAD is explicitly not source-to-binary attestation. It never consults PATH, a vendor
installation, a credential, Node, a production profile or an environment override.

The worker opens and pins the source parent and executable with no-follow/CLOEXEC descriptors.
Source and private executable must be regular, current-UID, single-link files. The source must
be executable, have no group/other write bit, be at most 64 MiB and begin with a native 64-bit
Mach-O header. This header is format validation, not authenticity or execution evidence.

Preparation creates a fresh mode-0700 directory below canonical `/tmp`, with private `home`,
`tmp` and `workspace` directories. A SHA-256 pass over the retained source precedes the copy.
Copying and hashing use a 32 KiB scratch buffer and reject growth, truncation or identity changes.
The copy is synchronized, made mode 0500, its writable descriptor is closed, and a read-only
pin is retained. A final serialized check verifies source/path identities, private parent/entry
identities, exact workspace identity and both full digests under the five-second preparation
budget. These deadline checks surround blocking filesystem calls; they are not a hard
wall-clock bound on a stalled filesystem. Scratch ownership is installed in the resource guard
before directory creation/copy; failed preparation cannot release its slot if cleanup is uncertain.
A one-shot Pending-to-Committed transition under the private gate follows that check; cancellation before it refuses
spawn, while cancellation after commitment permits at most that one child and requires cleanup.
No prompt is admitted after the worker observes revocation.

The native program is executed by its checked private pathname. **A malicious same-UID actor
mutating the private path or bytes after final validation is excluded.** Mode 0500 and descriptor
pins do not create immutable bytes. There is no claim of `fexecve`, executable memfd seals,
`/dev/fd` execution, code signing or sandbox isolation. Unsupported platforms refuse this backend;
they do not switch to another execution method.

## Native execution and consumed-input evidence

`Command` gets only `acp --agent-engine v3`, `env_clear`, synthetic HOME/TMPDIR, `LANG=C`, `LC_ALL=C`
and one closed fixture case. Its pre-exec hook performs only async-signal-safe `fchdir` and
`setpgid` syscalls. The workspace descriptor selects cwd; a replaced workspace pathname before
commit is refused, and pathname lookup is never used for child cwd.

This backend exercise sends one closed, bounded JSON `session/prompt` fixture frame. Its nonce
field belongs to this private fixture protocol, not a proposed production ACP extension. There
is no initialize/session/model negotiation yet. The dedicated native fake has no descendant,
shell, tool, network, login or file-write behavior. It checks argv, environment keys and synthetic
HOME/TMPDIR, bounds input before parsing, and accepts exactly one text block and one request.

Only after parsing the whole prompt does the native child report its compiled fixture identity,
actual PID, cwd device/inode, nonce, exact frame byte count/SHA-256 and decoded UTF-8 text byte
count/SHA-256. The parent validates those against its own held descriptors, exact retained Child
and encoded input. The parent-computed artifact digest stays separate: the child is never sent
an executable digest to echo as purported execution proof. Receipts retain no prompt text,
paths or environment values. They prove this cooperative native fake consumed that input,
not production provider interpretation or execution of immutable artifact bytes.

## Lifetime, cancellation and cleanup

One global capacity slot admits one preparation/child/cleanup at a time. A dedicated standard
thread owns all resources, with no caller Tokio requirement. `cancel` and observer drop set
monotonic revocation without waiting for the worker. `cancel_handle()` can be held independently
while `wait(&mut self)` or `next_progress(&mut self)` borrows the sole observer. Dropping a wait
future abandons only that local wait. Successful cleanup publishes after capacity release;
CleanupUncertain is observable while capacity remains held.

`next_progress` returns bounded cumulative snapshots with increasing revisions: Prepared,
validated Consumed evidence and cleanup Report. Slow observers retain the consumption fact
even if terminal cleanup arrives first. Unchanged reports do not advance revisions; the first
terminal failure remains a failure when later cleanup becomes known. `finished` ends this
observer stream and does not imply reap/removal: a final uncertain result can retain resources
for process lifetime. `wait` keeps its compatibility snapshot behavior; progress consumes later
cleanup changes once per revision. The mutable observer admits one waiter, and cancellation
capabilities are separately cloneable.

Cleanup is **exact-child-only** because this fixed native program cannot spawn descendants.
It must not be reused for a vendor CLI, generic ACP process or descendant-capable fixture.
The original ACP supervisor, which can reap before later group signaling, is not reused or changed.
A process group is created at spawn, but this backend makes no process-group cleanup claim.

The new owner observes its retained Child with `waitid(WNOWAIT|WNOHANG|WEXITED)`. A natural exit
is reaped without a signal. A live canceled/stalled child is rechecked for ownership, signaled
by exact PID, then observed and reaped. EINTR retries; any other wait error latches Lost and
forbids all later probes, signals, waits and cleanup. There is no post-reap signal. This requires
that the embedding process keep children waitable: no SIGCHLD ignore, SA_NOCLDWAIT or foreign
wait-any reaper. In-process worker panic is caught and follows the same cleanup path.

After a two-second cleanup deadline, a visible `CleanupUncertain` report retains descriptors,
Child and capacity; the dedicated worker continues observing a still-owned child. Lost ownership
is retained for process lifetime without further operations. An independent resource guard
retains child, scratch and capacity across unexpected cleanup unwinding too. Whole-process death,
OOM abort and an externally stolen child are not claimed as successful cleanup.

Only confirmed reap permits scratch removal. Pre-spawn refusal can clean its prepared scratch
without a child. Removal checks held identities and unlinks only the fixed entries relative to
retained directory descriptors, then removes empty directories. It never recursively follows or
deletes unknown/replaced entries. An identity/removal failure remains `CleanupUncertain` and
retains the prepared resources and capacity. Report fields distinguish `reaped`, `exit_code` and
`resources_removed`; no partial failure becomes a clean receipt.

## Validation

Ordinary feature tests cover copied bytes and descriptor access mode, source pathname swaps and
in-place truncation during the copy, script/empty/over-64-MiB refusal, private executable symlink,
mode and byte changes, private parent symlink/rename/mode changes, workspace replacement, exact
child signal-before-reap ordering, natural exit without signal, EINTR, sticky Lost and refusal of
post-reap operations. These use only newly generated synthetic artifacts and do not execute them.

Run actual supported-target evidence explicitly:

```sh
python3 experiments/rust-acp/scripts/check-private-copy-fixture.py
```

That command stages the exact built native target and library test runner in a fresh 0700 parent.
It observes native PID/cwd/nonce/consumed-input evidence, natural exit 0, synthetic environment
isolation despite poisoned parent variables, live stalled-child cancellation, dropped observer,
worker panic, spawn failure, and barriers before/after commit. Revocation before commit produces
zero child; after commit produces one reaped child and no consumed prompt. Every successful
cleanup removes scratch; the runner's synthetic ambient-HOME canary and staging removal are checked.
The default suite marks this native test ignored; ignored/refusal-only runs are not native proof.

The same checker also runs the public progress API, private stamped admission and a standalone
compile context with no ACP dependency or caller Tokio runtime. A separate test process forces
partial preparation failure after writable-copy close: no child spawns, CleanupUncertain retains
the slot, and a second start returns Busy. Only after that test process exits does its parent
remove the two exact retained test-file identities. This is test teardown, not backend cleanup
success. Ordinary checks never reset ACTIVE to escape retained uncertainty.

The existing default/all-feature suites, strict Clippy, formatting and four Node recorders remain
regression checks for the crate's other code. They are not dependencies of this native backend.
Host admission (B01-B05, B07-B12 with real services), full ACP protocol composition, owner close
barriers, account readiness leases, production authentication and general descendant cleanup
remain separate gates. Strong immutable-execution B06 remains unfulfilled by design.
