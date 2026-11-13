# Offline HTTP allocation and ownership checkpoint

Status: standalone offline prerequisite after accepted audit `fa23ed5f`.
This binary drives real Hyper HTTP/1 parsing over generated, bounded memory IO.
It opens no socket or listener, starts no async runtime, imports no remote crate,
and owns no production authority, budget grant, Begin or MaySend capability.
Normal 64 MiB limits, the proposed private 128 MiB target, and the original
256 MiB global pool are unchanged.

**The closed scripted subset passes. A complete transport heap charge and HTTP
Begin remain uncertified.** Measurements are requested allocator layouts on this
compiler/target, not an allocator-RSS bound or a general HTTP worst-case proof.

## Reproduce

From this directory:

```sh
cargo run --offline --locked
cargo test --offline --locked -- --nocapture
cargo clippy --offline --locked --all-targets -- -D warnings
cargo tree --offline --locked -e features
shasum -a 256 -c source-pins.sha256
```

The equivalent root invocation uses
`--manifest-path experiments/rust-remote/fixtures/http-transport-check/Cargo.toml`.
The crate has its own `[workspace]`, manifest, lockfile and ignored `target/`.
There are no command-line, environment, URL, profile or credential inputs.
`cargo run` and the single test run the same deterministic suite sequentially.

Final validation on 2026-11-11: all commands above passed, including the hash
check for the accompanying final source freeze.
The run has 30 parser rows and nine ownership/cancellation rows, all with zero
remaining captured allocations after disposal and no census-table overflow.
`evidence-output.txt` is the complete final `cargo run` stdout. The test passed
in 1.28 seconds; that duration is an observation, not a latency guarantee.

Compiler: `rustc 1.99.1`, commit
`58cf8f9c35b355199727627d07ae34a4e2846d67`, `aarch64-apple-darwin`, debug profile.
`Cargo.lock` contains exactly the 13-package sync-only graph in
[the accepted audit](../../HTTP-TRANSPORT-AUDIT.md). Every locked checksum was
checked against its local `.crate` archive and the audit. The feature tree has
Hyper `client,http1` and Tokio `sync`; Tokio's default feature is empty. No
Tokio `rt`, `net`, `time`, Hyper server, TLS, connector or HTTP/2 feature appears.

## What the source and tests establish

1. Response storage owns exactly 1,024 boxed 65,536-byte arrays and an 8,192-byte
   pointer slice. Full 64 MiB succeeds. The next data byte cannot enter storage;
   the whole offending frame is refused, so the oversize case retains a
   67,108,800-byte prefix rather than pretending to have accepted 64 MiB. Generated
   input uses a repeat descriptor, without a second whole-response wire buffer.
   Frame data is copied once into the fixed blocks and dropped before another
   connection poll. The additive byte sum checks the fixture pattern; it is not
   a cryptographic digest.
2. The original boxed upload is retained by the owner and borrowed through
   Arc-backed `Buf` descriptors of at most 64 KiB. The 8 MiB upload is never
   collected into a second body. The fixed synthetic POST has three explicit
   headers, one generated Content-Length and the literal `/offline` path.
   Request encoding is consumed into a bounded 96 KiB head buffer and a byte
   counter, not an in-memory full wire request.
3. The httparse head gate accepts at most 100 fields and 65,536 raw final-head
   bytes. It refuses upgrade, a ninth informational head and informational raw
   bytes above 65,536 before releasing that offending head to Hyper. Each turn
   permits one raw read, one adapter read, one write, one request-body frame and
   one response-body poll/copy, each byte operation at most 65,536. Further IO
   polls return Pending. The gate performs at most two parses of a fixed 64 KiB
   prefix and one bounded shift per call. A one-byte fragmented head can require
   quadratic total prefix-parsing work; it cannot evade the per-turn cap.
4. Hyper itself handles body framing and trailer parsing. Tests exercise
   100/101 final fields, duplicate fields, noncanonical reason text, 65,536/65,537
   final-head bytes, 65,535/65,536 trailer bytes, 100/101 trailer fields,
   16,383/16,384 chunk-extension bytes, malformed chunks, data followed by EOF
   error, eight/nine informational heads, exact/excess aggregate informational
   bytes, and one-byte input fragmentation. The source accepts at most 72 MiB
   of raw wire data, with one extra byte permitted only to detect and refuse
   overflow, and caps driver turns at 200,000. Exact wire-cap exhaustion is not
   one of the recorded parser cases.
5. The owner retains request, response, control and the actual JoinHandle through
   worker completion, panic and join. Tests hold a ready worker at an exit gate,
   then observe real thread exit before join without releasing its backing.
   They cover cancellation before start, between waker registration and recheck,
   while genuinely Pending, and after partial body receipt; worker panic, owner
   drop/unwind and post-spawn startup unwind all join. Permanent scripted Pending
   uses an untimed real thread park, with a park-attempt barrier and a recorded
   cancellation wake. No timer or self-wake masks a lost cancellation wake.
   A stale waker retains only its small WakeState after join clears the Thread
   registration. Request/response weak handles no longer upgrade after disposal.

These bounds describe this private binary's fixed scenarios and adapter. A future
service must still check its own cancellation/clock before and after polling and
at its authority fence. This fixture has no shared service clock or deadline.

## Allocation evidence

The global allocator forwards to `System`. Its fixed 8,192-slot lifetime table
tracks addresses through cross-thread free, join and owner disposal. Captured
System allocations, frees and reallocations are serialized with bookkeeping.
`peak` is the highest live sum of requested layouts. `realloc_overlap` separately
models old backing plus the full new request at every successful realloc, even
when System could grow in place. Use the larger value for that trace. Neither
number measures malloc usable size, page commitment or RSS.

The census includes the owned response/upload, wrapper/channel/waker allocations,
thread Rust bookkeeping, IO buffers and lazy Hyper parsing/error allocations.
It excludes prebuilt script descriptors/header bytes, the static census table
(8,192 address/size records), meter mutex initialization, warmed process/thread
infrastructure, native thread-stack/OS overhead and allocator-private metadata.
The requested OS-thread stack is separately 2,097,152 bytes. Instrumentation
serializes allocation and therefore is not a performance benchmark.

The initial stricter meter crashed before main. LLDB stopped in
`std::sys::sync::mutex::pthread::Mutex::get`: Darwin's lazy mutex backing allocated
recursively through the global allocator. The final implementation allows
unmeasured startup allocation, initializes TABLE before enabling capture, and
serializes every captured operation. Earlier passing output predates this fix;
only the accompanying final output is evidence for the frozen code.

| Recorded scenario | Live-layout peak | Conservative realloc overlap | Retained after join |
| --- | ---: | ---: | ---: |
| Full 64 MiB response, empty upload | 67,488,441 | 67,545,785 | 67,117,768 |
| 8 MiB upload, one-byte response | 75,771,689 | 75,506,097 | 75,506,376 |
| 8 MiB upload + 64 MiB body + 65,535-byte trailer | 76,009,090 | 75,975,641 | 75,506,376 |
| 100 distinct final fields, noncanonical reason | 67,403,744 | 67,117,489 | 67,117,768 |
| 100 duplicate final fields | 67,412,573 | 67,408,492 | 67,117,768 |

The combined full case made 1,087 captured allocation/reallocation requests,
including 667,288 cumulative requested bytes after the start gate. Cumulative
requests are not simultaneous live bytes. Its largest allocation was the
original 8,388,608-byte upload. Several empty-upload traces requested a 122,880-byte
allocation: a 65,536-byte builder setting plainly does not cap all backing.
Hyper's private BytesMut/HeaderMap capacities are not public APIs; this census
observes their allocation requests without pretending to inspect each capacity.

The ownership case retained 67,118,106 bytes while ready, 67,117,974 after actual
worker exit but before join, and 67,117,785 after join. After owner disposal only
472 captured bytes remained in deliberately held weak handles/stale waker; those
also returned to zero when released. Report metrics do not assert that a logical
result or zero active IO permits a budget refund.

## Source-backed limits and remaining prerequisite

Source pins for the parser/dependencies are the lock checksums and the accepted
audit's archive census. Relevant Hyper 1.12.0 sources are
`proto/h1/io.rs` (read reserve, queue/write thresholds), `proto/h1/role.rs`
(header/reason parsing), `proto/h1/decode.rs` (trailer and extension limits),
`proto/h1/dispatch.rs` (outer poll loop), `body/chan.rs` (data/error/trailer
coexistence), and `client/dispatch.rs` (one-request channels). Local files were
read from `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`. Implementation
and lock hashes are in `source-pins.sha256`.

1. The largest observed non-payload excess is 511,618 bytes in the combined full
   trace, after subtracting the response and upload. It is **not** a certified
   T/D allowance. General request metadata, retained forwarded headers,
   collision/growth combinations, body-channel error/trailer overlap and all
   allocator schedules are not exhausted by these 30 scripts. The original
   request assembler's actual capacity still needs reconciliation with its lease.
2. The accepted F/R reference remains 83,689,816 bytes per full claim and
   169,690,784 for two plus reference owner/server backing, leaving 98,744,672
   from the original global pool before missing terms. This probe supplies
   measurements for part of those terms, not a replacement pool or admission
   proof. Fixed buffers already counted in F must not be counted twice when a
   future certified layout is composed. No two-claim or original-counter test
   was run here.
3. There is no pre-Begin allocator reservation enforcement. `executing` is only
   a measurement label on a private start gate; substantial lazy allocation
   occurs afterwards. Prepaid output/status grants, the bounded one-part codec,
   forwarded-header conversion and retained budget owners remain prerequisites.
   Response headers here are counted then dropped; they are not forwarded.
4. Socket connect/read/write, manual clock deadlines, rejected/accepted server
   slots and their device/generation occupancy, socket closure and server joins
   remain absent. No production content-coding, redirect, ByteString/Node parity
   or arbitrary-header compatibility is claimed. Deliberately forgetting the
   owning handle is outside the tested drop contract.
5. Review this frozen checkpoint before selecting the next prerequisite. No
   listener, HTTP Begin, MaySend, dependency adoption into the base crate,
   authority registration or budget expansion follows from these measurements.
