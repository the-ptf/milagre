# Restartable Rust Chat runtime

`chat-runtime` runs one dedicated Project and one explicitly selected Claude account/model. The Rust owner handles open, send, streamed events, permission answers, queues, SQLite messages and shutdown. It starts no Milagre Node daemon. Each launch creates a fresh private wire profile, socket and publication epoch; the separate marked data root and saved native session ID persist.

Build the executable explicitly:

```sh
cargo build --manifest-path experiments/rust-runtime/Cargo.toml --locked --offline --features chat-runtime --bin chat-runtime
```

Create a private launch JSON file with exactly these fields. Paths are explicit absolute paths; no executable, account, credential, bundle or production profile is discovered. `accountId` is the selected account UUID, or the explicitly selected `default` identity. The label is saved metadata, and authentication status remains `unknown`.

```json
{
  "program": "/explicit/path/to/claude",
  "home": "/explicit/home",
  "configDirectory": "/explicit/selected/claude/account",
  "skillsDirectory": "/explicit/milagre/packages/core/src/bundled-skills",
  "model": "sonnet",
  "path": "/usr/bin:/bin",
  "accountId": "11111111-1111-4111-8111-111111111111",
  "accountLabel": "Selected Claude account",
  "userName": "explicit-os-user"
}
```

```sh
chmod 600 /explicit/launch.json
experiments/rust-runtime/target/debug/chat-runtime create /explicit/new-rust-chat-root /explicit/launch.json
experiments/rust-runtime/target/debug/chat-runtime open /explicit/new-rust-chat-root
```

Run `open` after the prior process has stopped. `create` refuses every existing destination, including an empty directory, and seeds only its newly created Project. `open` requires the dedicated markers and unchanged root identity, takes an exclusive root lease, and loads existing owner state without seeding. The manifest is stored with mode 0600 inside a 0700 root. Existing Milagre profile paths are refused. Interrupted creation leaves an unadoptable partial root; it never silently seeds over it.

The first stdout line is a JSON receipt with `profile`, `socket`, `pid`, `dataRoot` and `actor.project`. Connect using the existing daemon wire client with the receipt's `profile`; `daemon:stop` or stdin EOF starts owner shutdown. The fresh receipt is required after every restart. No production socket or daemon-selection pin changes.

The provider receives only the captured executable, explicit `HOME`, `CLAUDE_CONFIG_DIR`, `PATH`, `USER` and `LOGNAME`, the dedicated Project cwd and snapshotted TLDR/QA bundle. Both identity variables come from the required nonsecret `userName` field (nonempty, at most 256 bytes, no NUL); they are never inherited. This supplies the OS identity needed by native Claude's account lookup. Native session persistence is enabled. The runtime exposes only its configured Claude model and saved account metadata. It does not discover installed models, inspect credentials, provide account management, or claim authentication readiness. MCP host tools, desktop/mobile adoption, arbitrary existing Projects and other providers remain outside this entrypoint.

The owner and provider preserve their existing refusal and save semantics. A failed save or ownership check can refuse shutdown. Captured provider workers retain the data-root lease through cleanup, including dropped/error teardown. Immediate/queued image sends keep the prior existing-Chat restrictions and the adapter's 1 MiB request/native-frame budgets. Queued state may exceed the 32 KiB launch-manifest cap and uses the owner's JavaScript-compatible JSON decoder.

Fixed-child acceptance uses a separate feature and the same configured provider/actor:

```sh
cargo build --manifest-path experiments/rust-runtime/Cargo.toml --locked --offline --features chat-runtime-fixture --bin chat-runtime --bin runtime-fake-claude
NODE_PATH=/explicit/main-checkout/node_modules node experiments/rust-runtime/tests/chat-restart.cjs experiments/rust-runtime/target/debug/chat-runtime
```

Only that feature exposes `fixture-create` and `fixture-open`. Its script asserts persistence is enabled and the second process launches with the previously saved `--resume` ID. It proves transport/owner continuity against a fixed native child, not real model inference or authentication.

## Accepted real-Claude checkpoint (2026-11-11)

The normal `chat-runtime` binary completed two real Claude Code 2.1.322 turns using an explicitly selected account, Ask mode and a new dedicated Project. The first turn streamed a random marker and saved two messages. After clean shutdown, a second Rust daemon opened the same data root, read an identical saved transcript, resumed the same native session ID, recalled that marker without receiving it in the second prompt, streamed its reply and saved four messages. Both daemon processes exited 0 with empty stderr. Their profiles, sockets and Project owner locks were removed; the data Project remained. The wire epochs differed. Node drove the external protocol check only; no Milagre Node daemon or SDK sidecar ran for this workflow.

Evidence: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-rust-live-chat-jhwpjdfs/report.json`, with its private `probe.cjs`, plus `/tmp/milagre-chat-runtime-root-live-retry.log`. Tested binary SHA-256: `a522404731f26de5487c522214537053f35eed60109e7a6e2fde66d5ca544527`. The first real attempt failed with a login refusal because the captured environment omitted `USER` and `LOGNAME`; its report remains in sibling `milagre-rust-live-chat-ex5z8gll`. Explicit nonsecret `userName` fixes that launch-context defect. No login was initiated and no credential bytes were read or copied by the probe.

Final root validation passes 96 runtime tests with `chat-runtime-fixture`, strict all-target Clippy and formatting. A deterministic duplicated-file-description regression reproduced the immediate-reopen lock failure before the final-Arc unlock fix. Workers now release captured leases before notifying drain completion; a successful `finish` includes that cleanup. Independent source review found no P1/P2. Logs: `/tmp/milagre-chat-runtime-root-{tests,clippy,fmt}-final.log`, `/tmp/milagre-chat-runtime-root-restart-final.log` and `/tmp/milagre-configured-provider-drain-barrier.log`.

This real smoke proves ordinary text streaming, persistence and native resume for that CLI/account. It requests no tools and denies unexpected permission requests. Tool approvals remain fixed-child evidence. Real images, permission modes, background work, account switching, other providers and Milagre MCP/Designs/Artifacts tools are not established by this run. The installed Tauri shell and GPUI adapter are not routed to this runtime. Production ownership, existing-data adoption, phone compatibility and upgrade/rollback remain open.
