# Private model candidate seam

Status: accepted after independent source review found no P1/P2 and root validation passed.
This implements only slice 1 of `WRITER-PLAN.md`, accepted at `785989a3`,
on the private state baseline `4ff6175e`. There is no filesystem writer or durability claim.

## Implemented behavior

Each private Model has an immutable process-local identity and a checked preparation
generation. Reservation refuses exhaustion before consuming source IDs or changing pending
state. These counters are internal lifecycle checks, not persisted operation IDs, execution
authority or a replay journal. A reload builds a new Model identity while retaining the
source ID counter and successful-save count.

Preparation enters `Preparing`, runs the same validators/transitions and stores one
non-Clone `Candidate` in `Pending`. The candidate contains the exact optional serialized
image, draft, prebuilt indexes/tracking data, maintenance time, result and effects. Only
a private origin/generation stamp and a borrowed image are available to the seam. There
is no API to pass a candidate to another model or supply a durability-success boolean.

While a preparation is outstanding, another prepare, execute or reload refuses before
touching it. Wrong-origin, stale and duplicate stamps cannot inspect, install or discard
the current candidate. Dispatch errors clear the unfinished phase but retain IDs already
consumed in Node order. If dispatch unwinds, `Preparing` stays fenced; there is no generic
panic-reset operation that could later erase a native cleanup obligation.

`Model::observe` remains fixture-only diagnostic inspection of the current published model,
including while preparation is pending. It does not expose the withheld candidate result
or effects and is not an authoritative storage-owner read. Ordinary reads through `execute`
refuse while preparation is outstanding.

Installation verifies the exact pending identity, consumes it once and moves prepared
values into the same Model. It performs no serialization, index construction, cloning or
fallible I/O after that check. The existing synchronous fixture now prepares, applies its
test-only publication failure, and installs. On that failure it discards the pre-I/O
candidate and returns the original Node-shaped error. The mutation checker still compiles
and catches a variant that installs before reporting the failure.

All candidates in this slice are pre-I/O. Discard keeps consumed IDs but publishes no
state, result or effects. No `Staged`, `Renamed`, cleanup acknowledgment or native success
proof has been implemented. A future copied writer must add its retained-resource phases
before any filesystem mutation; this discard function cannot authorize post-rename cleanup.

No-write preparation preserves the distinction between logical maintenance and the last
published image. It advances maintenance only on installation and ignores write-failure
injection when no image exists. Read and no-due fast paths retain their existing behavior.
Load upkeep and reload continue to preserve exact supplied file bytes until a later write.

## Bounds and scope

The accepted state bounds remain unchanged: 4 MiB input/image, 131072 aggregate JSON value
nodes including unknown metadata, depth 32, 16 KiB encoded metadata strings/keys, 64
Routines, 4096 Runs and 4096 tombstones. Candidate/results/effects are checked before
publication. These limits are not a heap/RSS bound; parsed state, a draft, prebuilt indexes,
tracking data and result/effect values coexist during preparation.

The public cron library, normal build graph, Cargo manifests/lockfile and production oracle
hashes are unchanged. Store compilation remains private to tests and the explicit fixture.
The `src/store/mod.rs` hash in the accepted writer plan is a historical pre-seam baseline,
not an assertion that the changed implementation still has those bytes. Production Node,
shared validator, cron, timezone and private codec drift checks remain unchanged.

## Validation

The 13 added tests cover identity exhaustion, checked generation exhaustion, invisible
preparation, wrong origin, stale/duplicate stamps, second preparation and reload refusal,
fresh identity on reload, pre-I/O discard, no-write maintenance, no-due/read paths,
prebuilt removal indexes/effects, atomic batch refusal and early create-ID consumption.
Two private branches are supported by source inspection but lack dedicated regression
evidence here: a caught dispatch panic retaining `Preparing`, and successful-save counter
exhaustion. No panic-injection or overflow-test result is claimed for those branches.

| Check | Result | Local implementation-agent log |
| --- | --- | --- |
| Offline locked Rust tests | 61 tests plus one doctest pass | `/tmp/milagre-routines-candidate-tests.log` |
| Strict Clippy and fmt | All targets pass with warnings denied; formatter passes | `/tmp/milagre-routines-candidate-clippy.log`, `/tmp/milagre-routines-candidate-fmt.log` |
| Actual Node store/cron tests | 157 pass | `/tmp/milagre-routines-candidate-node.log` |
| Store differential/source gate | 25 traces, 841 observations match actual Node | `/tmp/milagre-routines-candidate-parity.log` |
| Deliberate store refusals | Eight seed and 90 ID observations, excluded from parity count | `/tmp/milagre-routines-candidate-parity.log` |
| Compiled store mutants | All six compiled and were killed by actual Node observations | `/tmp/milagre-routines-candidate-mutants.log` |
| Existing cron gate | 4168 parity vectors; six separate domain refusals | `/tmp/milagre-routines-candidate-cron-parity.log` |
| Compiled cron mutants | All six killed by actual Node observations | `/tmp/milagre-routines-candidate-cron-mutants.log` |

The worktree had no `@milagre/shared` package link during this run. Node checks used a fresh
private temporary `NODE_PATH` directory with a symlink to this exact worktree's
`packages/shared`. The oracle still verified resolved module paths and source hashes.
No repository dependency directory was changed. Node v24.13.0, ICU 77.1 and TZDB 2025b
remain the pinned oracle environment.

Root independently passed the 61 Rust tests and doctest, strict all-target Clippy/fmt,
157 actual Node tests, all 841 store observations and 98 separate refusals, and six
compiled store mutants. Logs use `/tmp/milagre-routines-candidate-root-` followed by
`tests.log`, `clippy.log`, `fmt.log`, `node.log`, `parity.log` or `mutations.log`.
Root used its own temporary `NODE_PATH` link and verified its removal. The unchanged
cron gates above were run by the implementation agent, not rerun by root. Independent
review read the frozen source and logs without running tests; the two documented P3
branch-coverage gaps remain.

Changed implementation files are `src/store/mod.rs`, `mutations.rs`, `transitions.rs`,
new `preparation.rs` and `preparation_tests.rs`, and the existing publication-order mutant
in `scripts/check-store-mutations.py`. This document is the only evidence-file addition.
No storage owner, scheduler, dispatcher, host, provider or production registration exists
in this checkpoint.
