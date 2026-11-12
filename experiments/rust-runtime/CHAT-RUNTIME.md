# Restartable Rust Chat runtime

`chat-runtime` runs one dedicated Project and one explicitly selected Claude account/model. The Rust owner handles open, send, streamed events, permission answers, queues, SQLite messages and shutdown. It starts no Milagre Node daemon. Each launch creates a fresh private wire profile, socket and publication epoch; the separate marked data root and saved native session ID persist.

Build the executable explicitly:

```sh
cargo build --manifest-path experiments/rust-runtime/Cargo.toml --locked --offline --features chat-runtime --bin chat-runtime
```

Create a private launch JSON file with exactly these fields. Paths are explicit absolute paths; no executable, account, credential, bundle or production profile is discovered. `accountId` is the selected account UUID, or the explicitly selected `default` identity. The label is saved metadata. `agent:cli-status` refuses with `CLI_STATUS_UNAVAILABLE` because this runtime does not inspect CLI/authentication readiness; it never reports an invented ready state.

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

### Launcher loss

The process holding the launcher's stdin pipe owns that lifetime grant. Closing
the pipe (including a controller crash) uses an explicit out-of-band owner-loss
shutdown path, separate from ordinary `daemon:stop` and viewer disconnects. The
owner interrupts, ends and saves unfinished turns, then closes providers. No RPC
selects this policy. A disconnected/reconnected viewer leaves the run intact
while the launcher pipe stays open.

Shutdown is acknowledged only after actual provider/PTY/worker drainage. A
`QUIT_PENDING` result keeps the owner and native handles retained and is retried;
after one second the driver reports that cleanup remains pending once. Closed
stderr readers cannot panic the cleanup worker. A real nonpending save/ownership
failure is preserved and reported, without a successful stop or automatic replay;
authority/socket remain retained for repair and explicit stop retry. A stuck
native cleanup may therefore retain the runtime indefinitely, rather than release
its writer or claim the child exited.

Launcher loss also retries the server's `SHUTDOWN_TIMEOUT` while an already
accepted operation is still draining. Every attempt retains its configured
timeout and closing admission, with a 20 ms retry backoff and one original
code/message diagnostic. The owner teardown is not acknowledged or called ahead
of the accepted operation. A deterministic wire test holds a real accepted call,
observes the first short timeout and `CLOSING` refusal, then releases it and proves
that the driver calls owner teardown once and completes. Ordinary wire stop does
not gain this retry policy; actual save/ownership failures still stop the driver
without being masked or automatically retried.

`tests/launcher-loss.cjs` kills only its spawned controller handle with SIGKILL.
The runtime inherits that controller's stdout as its lifetime stdin, while the
outer harness retains the exact runtime Child handle for exit/reap evidence.
The fixed native Claude child emits session-started and waits on stdin EOF.
The test proves viewer reconnect preserves the active turn, controller loss leads
to runtime exit 0 and native-child absence, private profile/socket/Project-lock
cleanup, retained dedicated data, and a new runtime reading the saved failed turn
without another send. It repeats with the runtime stderr reader closed. These are
synthetic native-process tests, not a real-provider or actual GPUI crash claim.
The original executable timed out at six seconds with the ordinary active-turn
quit refusal; the repaired two-variant test passes. Logs:
`/tmp/milagre-launcher-loss-{before,after,runtime-tests,wire-tests}.log`.

The provider receives only the captured executable, explicit `HOME`, `CLAUDE_CONFIG_DIR`, `PATH`, `USER` and `LOGNAME`, the dedicated Project cwd and snapshotted TLDR/QA bundle. Both identity variables come from the required nonsecret `userName` field (nonempty, at most 256 bytes, no NUL); they are never inherited. This supplies the OS identity needed by native Claude's account lookup. Native session persistence is enabled. The runtime exposes only its configured Claude model and saved account metadata. It does not discover installed models, inspect credentials, provide account management, or claim authentication readiness. The content MCP tools below are attached to this same captured session. Other Milagre host tools, mobile adoption, arbitrary existing Projects and other providers remain outside this entrypoint.

The owner and provider preserve their existing refusal and save semantics. A failed save or ownership check can refuse shutdown. Captured provider workers retain the data-root lease through cleanup, including dropped/error teardown. Immediate/queued image sends keep the prior existing-Chat restrictions and the adapter's 1 MiB request/native-frame budgets. Queued state may exceed the 32 KiB launch-manifest cap and uses the owner's JavaScript-compatible JSON decoder.

Desktop bootstrap reads expose the configured Project: `canvas:snapshot` includes current state supplied by the owning actor, `canvas:links` and `link:list` return empty arrays because this runtime has no Link/group writers, and `accounts:scopes` lists only that Project. These four reads take no caller scope or state. They remain behind the same live Project/root checks; unsupported mutations and account refresh remain refused. Their shapes follow the existing actual Node bootstrap oracle, with the dedicated Project's own identity/name and no invented opening timestamp. No transcript is seeded for display. The restart client compares canvas state before and after a real owner turn and on reopen; fixed-child evidence remains separate from real Claude validation.

Opening a Chat can mark it read through `chat:patch(projectPath, sessionId, {unread: boolean})`. This configured-runtime subset requires the connection to have opened the explicit Project, a ready owner, an existing positive safe-integer Chat ID, and exactly that one boolean field. Other patches, including mixed fields, are refused. It follows Node `patchSession`: true sets `unread`, false removes it, and unchanged marks do not publish a new version. The owning state store flushes before publication and the null RPC result. A failed save returns an error and retains the owner's dirty state/persistence warning; retrying the same mark still flushes that pending save. Focused fault tests and the fixed-child restart client cover this boundary, with the client comparing results directly to the actual shared Node reducer and checking both mark values across daemon restarts.

## Retained configured content

The configured runtime opens one `SharedContent` / `ContentOwner` in its durable Isolation. Native Claude receives the existing in-process `milagre` MCP registration; renderer Artifact reads and Design edits use that same writer. HTML, Design versions/assets and Design kits live under the dedicated data root's `artifacts` and `design-kits` directories and survive clean stop/reopen. Startup creates no reports, Designs, assets or transcript entries. It captures the manifest's bundled skill directory for content tool instructions. No raster helper is configured: Design tool feedback reports unavailable PNG rendering, while saved source and generated HTML remain available.

The actor admits actual positive safe-integer Chat IDs from its current owned state, up to 1,024 Chats. A newly created Chat is admitted synchronously at the private provider boundary, after the owner has committed it and constructed its own outbound `chatId`/cwd, before its worker can attach MCP. Renderer send requests cannot supply that outbound `chatId`. Every worker captures the exact Chat token and ready Project generation at dispatch; removal/re-addition or forget/reopen cannot revive that token. Publication reconciles membership with owner state. Unknown/foreign Chats, invalid membership snapshots and closed generations refuse. The configured root/manifest is checked on content operations and a failure permanently revokes that content owner. Project owner/storage loss uses the existing actor readiness check, sampled every 250 ms plus command checks, rather than a new per-call Project lock API. No public grant constructor, arbitrary scope resolver or second writer is introduced.

The configured actor exposes `artifact:list`, `artifact:get`, `artifact:asset`, `artifact:comments`, `artifact:apply` and the permanently enabled Designs reads/save compatibility route. These require the connection's Project view and ready owner. `artifact:delete` and `artifact:add-comments` remain unsupported. Native tools can create/read/update content through the existing Dispatcher policy and store checks. This checkpoint does not add unrelated host tools or claim real-provider content evidence until separately validated.

Shutdown revokes native/session grants first. It returns `QUIT_PENDING` while captured native workers remain and retains the shared content writer. Retry only that typed pending result with a deadline; successful `daemon:stop` follows native drain and content-store shutdown. Worker teardown releases content before its durable root lease. Fixed-child tests cover native MCP HTML/Design creation and reads, renderer Design edit and version conflict, saved history across three launches, empty startup, scope/readiness refusals, stale retained grants, a new Chat attaching before actor publication, and the native-drain writer barrier. These are deterministic transport/store tests, not live model or desktop rendering evidence.

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

This real smoke proves ordinary text streaming, persistence and native resume for that CLI/account. It requests no tools and denies unexpected permission requests. The separate Ask Write checkpoint below adds real approval evidence. Real images, other permission modes, background work, account switching, other providers and Milagre MCP/Designs/Artifacts tools are not established by these runs. The installed Tauri shell and GPUI adapter are not routed to this runtime. Production ownership, existing-data adoption, phone compatibility and upgrade/rollback remain open.

## Accepted real Ask Write checkpoint (2026-11-11)

A separate Claude Code 2.1.322 probe completed two real turns and saved four messages with the explicitly selected account. Each turn produced one actual Write permission card. Both task-owned target files were absent before the corresponding answer. The allow RPC returned true, emitted `permission-resolved` with `allow`, and the target then contained exactly the expected one-line bytes. The deny RPC returned true, emitted `permission-resolved` with `deny`, and its target remained absent. Independent source/evidence review checked the exact written bytes and denied-file absence.

Shutdown exited 0 with empty stderr; the private wire profile, socket and Project `runtime.lock` were removed. Evidence: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-rust-live-permissions-185s_279/report.json` and adjacent `probe.cjs`; root log `/tmp/milagre-chat-runtime-root-live-permissions.log`. This probe did not restart the runtime or use the desktop UI. It establishes the observed Ask Write allow/deny flow for that CLI/account, without a general workspace-confinement claim.

## Accepted configured content, terminal and Git composition

The configured owner now installs persistent shared Designs/Artifacts, seven
terminal routes and four Git read routes. This remains one dedicated Project and
one explicitly selected Claude account/model. It does not adopt production data.

Content uses one retained store for native MCP and renderer calls. Chat membership
is captured before worker dispatch; full 1,024-Chat capacity refuses a new send
before any persisted Chat or next_id change, while existing/duplicate/starter
sends retain owner behavior. Shutdown waits for native content workers. Exact
same-Project post-Done cleanup refusals remain visible as an audit count instead
of an erroneous active-transition failure; other failures remain errors.

Terminals use real /bin/sh under current owned Chat/Worktree membership, an
explicit environment and generation tickets. Long reads run outside publication.
Stop/forget retain the Project lock until the actual shell is reaped, its waiter
callback completes, I/O threads join and kill cleanup finishes. Fallible fd/worker
preparation precedes spawn; failed handoff retains and waits for its exact child.
Unknown cleanup retains ownership. setShell and port-watcher integration remain
unavailable. This completion proof does not join arbitrary descendants.

Git changes/history/diff-files/diff-file use the bounded existing reader, fixed
/usr/bin/git and private HOME/config/cache. Exact root and local repository pins
are checked; parent repository discovery and external Worktree pointers refuse.
Project metadata reflects actual local Git state. No Git write/init/fetch/push
route is installed. The test explicitly initializes its synthetic repo through
its authorized terminal, not as hidden startup data.

Root passes 114 runtime tests, 44 terminal tests and strict feature Clippy.
The actual Node client drives PTY output/input/resize/close/reconnect, proves
state reads progress during a pending long poll, and requires QUIT_PENDING with
the Project lock held for a shell ignoring HUP/TERM. Git reads and metadata pass
on that real local repo. Independent source review closes both PTY cleanup P2s;
mutations reproduce premature completion and missing wait.

Real Claude MCP content creation, Design version conflict/edit and actual daemon
restart pass in `milagre-rust-live-content-uda57kz_/report.json`. The production
React native creation/edit/reload run is recorded in
`/private/tmp/milagre-native-chat-observer-Ywg8gx/verified.json`; its exact permission
label assertion was corrected and existing evidence revalidated without resending.
A separate normal daemon restart confirms four message IDs and edited Design v2:
`milagre-native-content-full-nzmdde58/native-state-readback.json`. Temporary data
paths are under the private system temporary directory. Normal runtime SHA-256:
`846ee97abc1d8ab38d2ea53c3e510fba726c305e1b58f7256fe07cd9805113f2`.
Shared client 90922b6c additionally passes a real selected-account public API turn;
see its OWNED-CHAT.md. Real native terminal UI use and full retained-service,
account, phone, existing-data and upgrade/rollback behavior remain unverified.
