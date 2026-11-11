# Isolated Rust read and terminal runtime

This crate connects `milagre-owner-wire` to `milagre-owner-store` and `milagre-terminals`. The unchanged production Node daemon client and desktop runtime client read real saved Project files through a Rust server. It is a tested integration boundary, not the installed app's backend or a completed owner migration.

Both executables accept **no arguments and no existing profile path**. Each run creates a private fresh profile under canonical `/tmp`, copies embedded repository fixtures into its hidden `.projects` directory, and binds a distinct Unix socket. It ignores `TMPDIR` when choosing the profile. Neither binds the production profile, starts providers, runs Git, or writes existing Project data. The default executable keeps copied Project bytes sealed. The `owned-runtime` executable takes writer locks and may compact sidecars only in its own fresh marked copies. Real PTY shells start only after an explicit `terminal:open` request. EOF on stdin or `daemon:stop` tears down its own temporary profile and socket.

```sh
cargo test --manifest-path experiments/rust-runtime/Cargo.toml
cargo clippy --manifest-path experiments/rust-runtime/Cargo.toml --all-targets -- -D warnings
```

`cargo run --manifest-path experiments/rust-runtime/Cargo.toml` starts the isolated executable, prints its temporary profile/socket metadata, and waits on stdin. `cargo run --manifest-path experiments/rust-runtime/Cargo.toml --bin owned-runtime` starts the separate ProjectStates-backed variant. Its 4 KiB frame limit intentionally forces the production client to page ordinary Project reads. Do not use this configuration for performance comparisons.

## Implemented read surface

| Method                                           | Current behavior                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project:open`, `project:switch`, `project:read` | Read an embedded fixture copy, register it as opened, return path/name/git/state. No Git discovery, registry mutation or resume work.                                           |
| `project:current`                                | Return this connection's selected Project; the first embedded Project is the isolated launch default.                                                                           |
| `project:snapshot`                               | Read an opened Project's saved state with sidecar hydration and in-memory detail compaction.                                                                                    |
| `state:read`                                     | Whole state with a process-specific epoch and content revision. Sealed copies remain version 1; a later different whole state increments it. No state-patch support is implied. |
| `chat:messages`                                  | Production Chat paging. Unopened database-backed copies read raw rows; opened copies use compacted state. Legacy inline copies must first be opened.                            |
| `chat:message`                                   | Find a saved message and hydrate its tool-detail sidecar.                                                                                                                       |
| `chat:send-status`                               | Return a saved-message or queued-entry receipt, or null. No send is performed.                                                                                                  |
| `chat:inbox`                                     | Saved idle-Chat completion/failure projection, using the shared contract for titles, unread filtering, UTF-16 previews and ordering.                                            |

`ReadBackend` has two implementations. `SavedCopies` uses `ProjectReader` and `ProjectRepository`, rejects changed bytes, and proves reads leave its copies unchanged. `OwnedCopies` uses the actual `ProjectStates` manager, initializes `Isolation` before any fixture files exist, and takes owner locks only on those copies. It serves whole states through lazy storage without loading every Chat into the in-memory state. It also exposes `chat:all-messages` (including marks/withState), `chat:search` and `chat:subagent` through `ProjectStates::call`, and uses its bounded inbox previews. Calls advance the storage manager's clock; shutdown closes it and releases its locks. There is no automatic service timer or mutation command yet.

Paths must exactly match this run's copied fixture catalog. Both modes reject symlinks/hard links and external paths through their storage boundary; the sealed mode also verifies immutable bytes. No stored Worktree path is followed. This is experimental isolation, not protection against a hostile process running as the same OS user and racing filesystem operations.

Known mutation/service names return `UNSUPPORTED_MUTATION` with the message `The isolated Rust read runtime does not execute mutations or start services`. Unknown names return `COMMAND_FAILED` with `Unknown command: <method>`. Registered unsupported methods are intentional failures, not advertised functional services. Only result/snapshot paging capabilities are advertised; there is no `desktop-v1` or state-patch capability.

## Real terminal service

The eight production `terminal:list|profiles|setShell|open|read|input|resize|close` methods route through `milagre-terminals::wire::handle`, with a server-generated client identity. `terminal:changed` and `terminal:preferences-changed` events use the shared wire event stream. A viewer disconnect does not close its shell. Host shutdown disposes PTYs before deleting the profile; the fixture chooses process-tree cleanup for its own shell descendants.

The resolver admits only a non-archived Chat in the embedded catalog. It maps that Chat to the copied Project directory, rejects an arbitrary `cwd`, and never follows the original saved Worktree path. This is a fixture mapping, not completed production Worktree resolution. Shells are real `/bin/sh` processes, with a small explicit environment, no inherited credentials, no login startup files, and in-memory shell settings. Shell selection is restricted to `/bin/sh` in this fixture. A terminal still has normal OS filesystem access: these restrictions and tests are not a process sandbox.

## Evidence and limits

Two Node conformance suites launch the separate Rust binaries and connects the actual `apps/daemon/src/client.cjs` and `runtime-client.cjs`. The sealed-reader suite compares results with actual Node `readProjectState`, `chatPage`, `withDetails` and shared `inboxSnapshot` on **separate disposable oracle copies**. Node's readers can write/compact sidecars or initialize SQLite, so they never read the server copies or source fixtures directly.

Coverage includes four copied Projects (`alpha`, `legacy`, `surrogates`, and a >100 KiB paging variant derived from the legacy fixture), database and inline messages, message details, queued/saved receipts, per-client Project selection, numeric page manifests, ordinary and snapshot pages, stored lone UTF-16 surrogates, inbox parity, external-path rejection, explicit mutation errors, byte-identical server files after reads, file-change refusal and symlink refusal. Real terminal coverage includes all eight commands, cwd/archived-Chat refusal, output and UTF-16 offsets, resize checked with `stty`, replay after disconnect, shell identity preserved across viewers, events, and shell cleanup on daemon shutdown. The tested shell commands do not change Project bytes. The wire suite separately proves UTF-16-aware ordinary replies, event payloads and snapshot serialization without reinterpreting page fragments.

The owned-runtime suite constructs actual Node `ProjectStates` on separate oracle copies, observes old Chats unloaded, and compares whole/lazy reads, marks, details, receipts, search, subagents, inbox and large snapshots. It verifies that the Rust process owns only its copied Projects and that refused send commands create no receipt or coordination-file change. Both suites pass with real Unix PTYs. This does not prove any provider execution or a live profile cutover.

The runtime does not yet expose versioned mutations, a periodic write-behind/sweep driver, provider runs, active approvals/questions, Project registries, Links, accounts, mobile/peer transports, or shutdown ownership handoff. Inbox scopes containing saved background/advisor work return `UNSUPPORTED_LIVE_INBOX`, because this runtime cannot establish live activity. Empty runs/ports snapshots describe this fixture process, which starts neither provider runs nor a port watcher. It does not claim production background-work parity.

The wire parser still rejects **incoming** lone-surrogate JSON escapes; reading saved text preserves them on output. Incoming identities with such strings need a lossless request-decoder boundary before migration. Arbitrary locale collation of tied inbox keys is also deferred; admitted fixture paths and numeric Chat identities are ASCII. The sealed mode rehashes files before reads, and several queries still construct whole state: this is correctness scaffolding, not a performance result.

Direct dependencies are the three Rust path crates, `serde_json` with ordered objects, `sha2`, `hex`, and `tokio` for terminal async reads/disposal; exact resolved versions are in `Cargo.lock`. Neither the desktop nor production Node runtime is changed by this crate.
