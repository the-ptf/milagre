# Current-state publication cache

The actor still ticks every 20 ms. It still checks Project ownership on every
publication read and retains the ordinary configured-root, terminal membership,
content membership and local Git checks. Provider, PTY, save and routine deadlines
have not moved.

One hydrated JSON value is cached per open Project, keyed by exact immutable
metadata, message-list and unloaded-set Arc identities. Holding the source state
forces subsequent `Arc::make_mut` writes to make a new identity. Owner writes
invalidate the cache before saving, and failed ownership checks discard it.
Forget/confirmed close removes the slot and its cache. A failed close retains the
same authority and the ordinary read/error rules. Reads do not touch the idle
clock or load idle Chats back into owner state.

The actor consumes a shared Arc. If its source identity, visible Project/open
state, publication stamp, observed Git state and current runs are unchanged, it
keeps the existing snapshot instead of cloning/deep-comparing the transcript.
Successful event watermark updates continue through the separate existing path.
Streaming run changes still replace the snapshot even when Project state did not
change. This is one-writer, cooperative filesystem caching, not detection of an
external process editing a held SQLite database or sidecars behind its owner.

The tradeoff is one additional hydrated JSON value retained per open Project,
plus shared source-state identities. This is not a lower-memory claim and the
cache is not an unbounded history or a cache of past generations. A changed or
revoked value can remain in a caller's retained Arc, just as an earlier owned
value could remain with a caller; current reads still recheck authority.

## Measurements

Debug build, same process, fresh temporary Project, no installed app or provider.
`getrusage(RUSAGE_SELF)` measures user plus system CPU. Each result alternates the
legacy `current_whole_state` API with the shared API; values are checked equal.
These measure the publication-read operation, not whole-app idle CPU or UI FPS.

| Workload | Legacy CPU, three runs | Shared CPU, three runs |
| --- | --- | --- |
| 200 reads, 200 idle-unloaded messages with 8,192-character bodies | 8,906 / 9,111 / 9,029 ms | 51.5 / 6.39 / 6.73 ms |
| 2,000 reads, empty message list | 84.65 / 85.24 / 88.88 ms | 73.28 / 74.19 / 77.95 ms |

The first shared large-history run includes the initial cache fill. These results
establish the cost avoided for unchanged unloaded history. The empty-state saving
is small; they do **not** establish that the benchmark's approximately 1% idle
runtime CPU is fixed. Filesystem checks and timer wakeups remain, and WebKit's
rendering cost is outside this change. No installed benchmark was rerun.

Reproduce with the ignored tests in `rust-owner/tests/current_whole_state.rs`:

```sh
cargo test --manifest-path experiments/rust-owner/Cargo.toml --locked --offline \
  --test current_whole_state measure_shared_publication_read_cpu -- --ignored --nocapture
cargo test --manifest-path experiments/rust-owner/Cargo.toml --locked --offline \
  --test current_whole_state measure_empty_shared_publication_read_cpu -- --ignored --nocapture
```

Logs: `/tmp/milagre-idle-cache-measure.log`, `/tmp/milagre-idle-empty-measure.log`.
Focused behavior covers unchanged identity, unload without idle touch, mutation,
flush invalidation, root replacement/refusal/recovery, forget, and actor open,
epoch and metadata publication. Final full checks are reported separately.

Validation logs:

- `/tmp/milagre-idle-owner-full.log`: 237 checks pass.
- `/tmp/milagre-idle-runtime-full.log`: 160 checks pass, including all four actor timer cases.
- `/tmp/milagre-idle-owner-focused-final.log`: five checks pass, two measurement checks ignored.
- `/tmp/milagre-idle-runtime-focused.log`: snapshot reuse/open/epoch/metadata case passes.
- `/tmp/milagre-idle-{owner-clippy-final,runtime-clippy,runtime-feature-clippy}.log`: strict checks pass.

The final focused owner test additionally changes only a reply body before
checking cached publication, then unloads it without touching the idle clock.
The full-suite count precedes that added assertion and second ignored measurement
helper; production source bytes are unchanged by those test-only additions.
