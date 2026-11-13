# Retained-parent routine writer crash checkpoint

Status: accepted as an isolated retained-parent checkpoint after root validation and
independent source review. No production recovery gate is lifted.
This is slice 3 of [WRITER-PLAN.md](WRITER-PLAN.md), based on accepted copied writer
`e5c34652`. It adds exec-only tests and a private test recovery seam. The public cron library,
normal dependency graph, copied fixture command API, Node source pins and state semantics
are unchanged. No production storage owner, live path, scheduler or dispatch is admitted.

## Exact parent and child ownership

The parent creates a fresh copied store with one synthetic schedule, closes its writer and
retains the original Copy capability. An admission guard owns that copy through channel,
inheritance and spawn setup failures. The same Rust test executable receives five pinned
file descriptors and one connected Unix socket at fixed descriptor numbers. It receives
only the already generated child basename, copy token, bounded clock and a closed test
scenario. No normal target contains this inheritance decoder or accepts an arbitrary path.
The child has its own single-copy slot and opens fresh independent directory and lock-file
flock descriptions. Neither parent writer locks nor a writable-owner assertion are inherited.

At the first acknowledged barrier, the child has written the complete candidate but cannot
rename it. The parent checks the original copy, the generated staging-name grammar and the
single staging entry, then retains that exact stage FD and bytes. It compares those bytes
with a separately prepared candidate from the same bounded seed/clock. Only after retaining
this evidence can it let the child proceed. Neither the child's barrier label nor a digest
is accepted as publication, durability, exit or cleanup proof.

The parent owns the exact `Child`. It kills only an unreaped child and polls that handle for
reaping, caches its terminal status and never signals it again. Tests require actual SIGKILL
at each selected barrier and call stop again to prove no second signal follows reaping.
A wait error latches lost status and forbids further signaling or reconciliation. An unresolved
kill/reap retains the handle and all copy/candidate resources. There is no process-group or
descendant cleanup claim; the fixed child launches no descendants.

The native sequence is stopped after complete staging write, after file sync, immediately
before rename, immediately after successful rename, after directory sync, and after final
verification but before Model installation/result handoff. The renamed bit is still the first
operation after successful rename. The final barrier remains inside the caught publication
boundary, so an IPC error cannot turn a renamed operation into an ordinary retryable refusal.

## Recovery and cleanup authority

The test parent can reconcile only after it has observed the exact child's reap. It acquires
fresh independent directory and lock-file flocks, verifies the retained parent/child linkage,
marker, token, lock identity, staging bounds and canonical entry, then accepts either:

- The original canonical inode and exact bytes.
- The pre-rename captured stage inode, now at the canonical name, with the exact expected
  candidate bytes and no remaining entry at its former staging name. The parent syncs the
  directory before replacing its retained canonical pin.

An equal-byte replacement inode refuses. There is no pathname adoption, caller proof flag,
replay of the interrupted transition or installation of the child's withheld result/effects.
An unrelated valid-looking orphan never becomes the canonical state. A reopened writer reads
only the verified canonical image. A saved running Run is not claimed again; explicit
`recoverInterrupted` fails it, advances the schedule, and has no second effect when repeated.
Before-rename crashes leave the old due state claimable because no claim was delivered.

Crash staging files stay present through reopening and normal mutation. Only the test cleanup
owner may remove its pre-captured matching staging inode after the child is reaped. A
replacement sentinel survives failed close and cleanup. There is no directory sweep.

An unresolved cleanup parks the entire boxed Flight state in one test-only retained slot:
exact Child/status, copy, captured stage FD/bytes, expected image and transport. The existing
copy resource slot stays occupied. Checked retry takes no path or success assertion. Final
copy destruction is a separate recorded phase bound to the exact copy identity; if it parks
Data in the existing owner slot, retry checks that identity and invokes only its checked
cleanup. It cannot return to canonical reconciliation with a missing copy. Tests exercise
both retained stage mismatch and final destruction failure, restore only their own exact
entries, then confirm cleanup and fresh-copy admission.

A poisoned writer in the child refuses open, claim and close repeatedly. After writer Drop,
retained cleanup also repeatedly refuses while both kernel locks and the child copy slot stay
held. The parent then kills/reaps that process and reopens through its own unpoisoned retained
capability. No mutex is unpoisoned; this adds no in-process poison recovery.

## Bounds and remaining limitations

All accepted state/file/staging bounds remain: 4 MiB input/image, 131072 JSON value nodes,
32 nesting levels, 16 KiB encoded metadata strings/keys, 64 Routines, 4096 Runs/tombstones,
one pending operation and eight total staging entries. These are not heap bounds. Test IPC
frames are at most 64 KiB with five-second socket operation timeouts. Kill/reap polling has a
five-second budget. Native filesystem calls and process spawning remain synchronous; these
checks are not a hard end-to-end wall-clock limit.

The recovery seam exists only under `cfg(test)` and requires a live original parent, its
retained descriptors, and a candidate captured before rename. Arbitrary restart discovery,
lost parent capabilities, lost-child-status recovery, untracked staging cleanup, corrupt
backup, quarantine and load repair remain unsupported. A kill/reap failure is fenced, with
no claimed automated recovery. Tests cover successful exact reaping, not an external reaper
or OS permission failure. Process SIGKILL does not model power loss or storage hardware.
Cooperative same-UID limits still apply; malicious mutation after the final check is excluded.

Four fault paths have source-only coverage; no injected native test exercises them here:

1. OS kill or wait errors, including lost status after an external reaper.
2. Expiry of the five-second reap polling budget.
3. Admission setup failure while preparing the channel, inherited descriptors or spawn.
4. IPC failure or timeout at the final pre-install barrier after rename.

The guards and refusal branches for these paths are present, but the successful crash tests
are not execution evidence for them. No new fault hooks or recovery semantics are claimed.

There is no production provider/process authority, profile admission, runtime registration,
GUI work, Node fallback, journal or external exactly-once execution guarantee. No upstream
Monocode code or patches are included.

## Evidence

Root reran the frozen Rust changes: 87 tests plus one doctest pass (the exec-only child
entry is ignored by the outer runner), with strict all-target Clippy and formatter checks.
Root also reran the amended native mutation gate: three controls pass, all six mutants
compile and are killed, and the exact owners remove every generated native copy. Logs:
`/tmp/milagre-routines-crash-root-{tests,clippy,fmt,native-mutants}.log`.
Independent source review found no P1/P2 within the retained-parent scope. Its timeout
inventory finding is fixed with a `finally` observation and three deterministic checks;
the source-only fault-path limitations above remain. The Node oracle and cron totals
below are implementation-agent results for this slice, not new root reruns.

Seven new test cases exercise fourteen actual owned child processes. The existing nineteen
native/source tests remain. One ignored test is the exec-only child entry, invoked explicitly
by its parent tests; it is not a manual test requiring live resources.

| Check | Result | Local implementation log |
| --- | --- | --- |
| Offline locked Rust suite | 87 tests and one doctest pass; one exec-only entry ignored by the outer runner | `/tmp/milagre-routines-writer-crash-final-tests.log` |
| Strict Clippy / formatter | All targets with warnings denied; formatter check passes | `/tmp/milagre-routines-writer-crash-final-clippy.log`, `/tmp/milagre-routines-writer-crash-final-fmt.log` |
| Actual copied-file Node oracle | 25 traces / 841 matching observations | `/tmp/milagre-routines-writer-crash-final-copied-parity.log` |
| Original pure-model Node oracle | 25 traces / 841 matching observations | `/tmp/milagre-routines-writer-crash-final-model-parity.log` |
| Separate deliberate refusals | Eight seed and 90 ID cases per fixture; excluded from parity counts | Same parity logs |
| Compiled native mutants | Three unmutated process controls pass; all six mutants compile and are killed | `/tmp/milagre-routines-writer-crash-final-native-mutants.log` |
| Existing compiled model mutants | All six killed by actual Node observations | `/tmp/milagre-routines-writer-crash-final-model-mutants.log` |
| Actual Node store / cron tests | 157 pass | `/tmp/milagre-routines-writer-crash-final-node.log` |
| Existing cron / source / timezone gates | Existing accepted vectors and explicit refusals pass | `/tmp/milagre-routines-writer-crash-final-cron-parity.log` |
| Normal dependency graph | Unchanged; no new dependencies | `/tmp/milagre-routines-writer-crash-final-normal-graph.log` |

The six native mutations are premature Model/claim installation, post-rename uncertainty
reported as retryable I/O, Model advancement on clean refusal, lock release on uncertain
cleanup, deletion of a replacement staging inode, and adoption of a crash orphan. The gate
`python3 experiments/rust-routines/scripts/check-writer-mutations.py` builds fresh temporary
crates offline/locked and executes the actual retained-parent tests. Compilation failure,
timeout or leftover native copy fails the gate instead of counting as a killed mutant.
The temporary crates/targets are removed; native copies are removed only by their exact
owners. A before/after inventory detects stranded copies without deleting paths it discovers.
Run this inventory gate without another concurrent routine-copy test process.

The post-run inventory executes in `finally`, including when the subprocess times out.
A narrow mocked check confirms timeout propagation, changed-inventory failure with the
timeout retained as context, and the normal successful control. It starts no native child
and deletes no discovered path. Log: `/tmp/milagre-routines-writer-crash-timeout-inventory.log`.

The initial mutation-gate attempt refused at compilation because its temporary crate lacked
seven compile-time source-pin inputs. No mutant ran and no native copy was created. The
corrected gate copies those exact reviewed input bytes as siblings without compiling or
editing them; existing source hashes remain unchanged. The failed log is retained at
`/tmp/milagre-routines-writer-crash-mutants.log`. Final logs above come from the corrected gate.
