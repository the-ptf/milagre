# Isolated Rust read runtime

This crate connects `milagre-owner-wire` to `milagre-owner-store`. The unchanged production Node daemon client and desktop runtime client read real saved Project files through a Rust server. It is a tested integration boundary, not the installed app's backend or a completed owner migration.

The executable accepts **no arguments and no existing profile path**. Each run creates a private fresh profile under canonical `/tmp`, copies embedded repository fixtures into its hidden `.projects` directory, and binds a distinct Unix socket. It ignores `TMPDIR` when choosing the profile. It never binds the production profile, takes a Project owner lock, starts providers, runs Git, or writes existing Project data. EOF on stdin or `daemon:stop` tears down its own temporary profile and socket.

```sh
cargo test --manifest-path experiments/rust-runtime/Cargo.toml
cargo clippy --manifest-path experiments/rust-runtime/Cargo.toml --all-targets -- -D warnings
```

`cargo run --manifest-path experiments/rust-runtime/Cargo.toml` starts the isolated executable, prints its temporary profile/socket metadata, and waits on stdin. Its 4 KiB frame limit intentionally forces the production client to page ordinary Project reads. Do not use this configuration for performance comparisons.

## Implemented read surface

| Method                                           | Current behavior                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project:open`, `project:switch`, `project:read` | Read an embedded fixture copy, register it as opened, return path/name/git/state. No Git discovery, registry mutation or resume work.                |
| `project:current`                                | Return this connection's selected Project; the first embedded Project is the isolated launch default.                                                |
| `project:snapshot`                               | Read an opened Project's saved state with sidecar hydration and in-memory detail compaction.                                                         |
| `state:read`                                     | Same state with a process-specific epoch and version 1. Copies are sealed; external changes fail instead of silently retaining version 1.            |
| `chat:messages`                                  | Production Chat paging. Unopened database-backed copies read raw rows; opened copies use compacted state. Legacy inline copies must first be opened. |
| `chat:message`                                   | Find a saved message and hydrate its tool-detail sidecar.                                                                                            |
| `chat:send-status`                               | Return a saved-message or queued-entry receipt, or null. No send is performed.                                                                       |
| `chat:inbox`                                     | Saved idle-Chat completion/failure projection, using the shared contract for titles, unread filtering, UTF-16 previews and ordering.                 |

`ReadBackend` is the adapter boundary for future `ProjectStates` integration. `SavedCopies` implements it through `ProjectReader` and `ProjectRepository`. Paths must exactly match this run's copied fixture catalog. Symlinks, hard-linked files, changed fixture bytes and replaced ancestor symlinks are refused. No stored Worktree path is followed. This is experimental isolation, not protection against a hostile process running as the same OS user and racing filesystem operations.

Known mutation/service names return `UNSUPPORTED_MUTATION` with the message `The isolated Rust read runtime does not execute mutations or start services`. Unknown names return `COMMAND_FAILED` with `Unknown command: <method>`. Registered unsupported methods are intentional failures, not advertised functional services. Only result/snapshot paging capabilities are advertised; there is no `desktop-v1` or state-patch capability.

## Evidence and limits

The Node conformance suite launches the Rust binary and connects the actual `apps/daemon/src/client.cjs` and `runtime-client.cjs`. It compares results with actual Node `readProjectState`, `chatPage`, `withDetails` and shared `inboxSnapshot` on **separate disposable oracle copies**. Node's readers can write/compact sidecars or initialize SQLite, so they never read the server copies or source fixtures directly.

Coverage includes four copied Projects (`alpha`, `legacy`, `surrogates`, and a >100 KiB paging variant derived from the legacy fixture), database and inline messages, message details, queued/saved receipts, per-client Project selection, numeric page manifests, ordinary and snapshot pages, stored lone UTF-16 surrogates, inbox parity, external-path rejection, explicit mutation errors, byte-identical server files after reads, file-change refusal and symlink refusal. The wire suite separately proves UTF-16-aware ordinary replies, event payloads and snapshot serialization without reinterpreting page fragments.

This integration does not yet run `ProjectStates`, lazy loaded/unloaded Chat management, versioned mutations, debounced saves, provider runs, active approvals/questions, Project registries, Links, terminals, accounts, mobile/peer transports, or shutdown ownership handoff. Inbox scopes containing saved background/advisor work return `UNSUPPORTED_LIVE_INBOX`, because this runtime cannot establish live activity. Empty runs/ports snapshots describe this fixture process, which starts neither service. It does not claim production background-work parity.

The wire parser still rejects **incoming** lone-surrogate JSON escapes; reading saved text preserves them on output. Incoming identities with such strings need a lossless request-decoder boundary before migration. Arbitrary locale collation of tied inbox keys is also deferred; admitted fixture paths and numeric Chat identities are ASCII. Files are rehashed before reads, and full state is loaded for several queries: this is correctness scaffolding, not a performance result.

Direct dependencies are the two Rust path crates, `serde_json` with ordered objects, `sha2` and `hex`; exact resolved versions are in `Cargo.lock`. Neither the desktop nor production Node runtime is changed by this crate.
