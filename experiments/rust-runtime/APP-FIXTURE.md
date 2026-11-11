# Fresh Rust app bootstrap service

`app_fixture::start()` and the `app-fixture` binary exist only with Cargo feature `app-fixture`. They take no profile, path, executable, environment, account or provider arguments. Every launch creates a fresh private `IsolatedProfile`, one marked Isolation and one generated plain Project. The existing actor alone owns its `ProjectStates` and `ChatHost`. A fresh `RegistryCopy` retains its exclusive metadata writer; its reader and pinned snapshot grant no additional Project authority. Accounts are pure saved metadata with no disk/profile discovery.

This is a daemon service checkpoint. The desktop still connects to the installed Node owner. No fixture launch context, WebKit run, installation or production migration is included.

## Added commands

The feature adds these commands only to this new actor instance. Existing actor/Claude/ACP executables retain their method sets even when compiled with the feature.

| Commands                                              | Behavior                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project:read`                                        | Exact generated Project only; ordinary state or `{state:false}` envelope. Version is assigned after publication/cache update and epoch matches this actor's `state:read`. Reading never opens or retries a Project |
| `chat:runs`                                           | Current owner runs and the successfully published agent-event sequence, from the same actor as the snapshot                                                                                                        |
| `project:registry`, `project:recent`, `project:known` | Reads from the fresh registry copy. Exactly one seeded plain Project, fixed initial openedAt, no Git-origin lookup, home directory scan or arbitrary saved-path adoption                                           |
| `canvas:snapshot`, `canvas:links`, `link:list`        | Real owned metadata shapes with an empty Link set; canvas state comes from this actor's Project, never a second reader owner                                                                                       |
| `agent:models`, `agent:cli-status`                    | Fixed in-process scripted model, explicitly described as simulation with no vendor CLI/account/network. Other providers report unavailable. Scope is absent or this exact Project                                  |
| `accounts:list`, `accounts:scope`, `accounts:scopes`  | Saved default-account metadata with `state:unknown`, no installed/login claims, and this Project's exact scope. Refresh requests fail with `FIXTURE_UNSUPPORTED`                                                   |

All thirteen added command names require live Project readiness before reading any metadata, including globally shaped catalog/list calls. Forgotten or not-ready Projects refuse them; explicit `project:open`/`project:switch` is the retry path. Restoring a replaced root does not reopen it. The registry copy's directory/lock identity and snapshot bytes are checked; recent metadata must still match the seeded copy. There is no registry mutation endpoint, cleanup scan or adoption of a changed registry file.

Account list/scope semantics deliberately differ from production's discovery-refresh path: the Node oracle calls real `createAccounts().snapshot()` and `assign(scope, provider, null)` to obtain the saved-metadata scope shape without discovering a CLI. The Rust route uses the existing pure `Accounts` implementation. It does not claim to replace production `accounts.list()` login inspection. Catalog values are fixed inputs passed through the real Node runtime's `agentModels`/`agentCliStatus` injection points, not vendor-discovered models.

Only the advertised `kiro`/`scripted` text model is admitted on this route. Ordinary Ask mode, absent effort/replies, empty image/file arrays and disabled optional flags are accepted. Real model IDs, non-Ask modes, nonempty attachments, effort/reply assembly, fast/ultracode/TLDR, unknown configuration, cwd or environment fields fail explicitly. The Scripted provider runs no executable. Normal send/Stop/queue and receipt behavior remains the existing owner implementation. Handover and steering stay Gated; the binary does not enable `test-fixtures` or Restore.

Usage, Chats home, inbox, Design enablement/content, terminals, Git/Worktree mutations, account mutation/login, remote services and other startup calls remain unavailable in this composition. They are not successful empty stubs. Empty Links are supported because this registry genuinely owns an empty Link set. The production model picker still needs fixture-scoped initial preferences/model selection in the future launch context; this daemon does not modify them or claim UI startup parity.

## Evidence

`fixtures/app-bootstrap-node.cjs --check` creates a fresh Node runtime with a private profile/home, empty registry scan roots, no CLI discovery and fixed catalog callbacks. It reads actual runtime Project/catalog/registry/Link/account-scope command results, and records metadata-only Accounts results. Fifteen calls are compared with committed fixtures. The Rust Project seed is Node's prepared normalized state, so this check covers bootstrap response composition rather than re-proving Node's Project normalization. No network/provider turn is requested by the oracle. The usual Rust Project-store conformance remains the storage evidence.

`tests/app_bootstrap.rs` regenerates/checks that oracle and drives the compiled Rust binary through the actual Node daemon client. It compares all fifteen responses, verifies read-state/version/epoch consistency, confirms a Node ownership attempt fails without modifying owner bytes, and tests the exclusive registry writer. Every added read is refused after forget and root replacement; restoring the root still needs explicit open. It also tests foreign scopes, unsupported refresh/model/mutation commands, pinned registry tampering, live run snapshot equivalence, Stop and final profile cleanup. No UI was launched.

Validation commands:

```sh
cargo test --manifest-path experiments/rust-runtime/Cargo.toml --features app-fixture,acp-fixture
cargo clippy --manifest-path experiments/rust-runtime/Cargo.toml --features app-fixture,acp-fixture --all-targets -- -D warnings
cargo check --manifest-path experiments/rust-runtime/Cargo.toml --no-default-features --all-targets
node experiments/rust-runtime/fixtures/app-bootstrap-node.cjs --check
```

The combined suite has 77 tests including two receipt identity/bounds tests. Default dependency-tree inspection excludes `milagre-registry` and `milagre-accounts`; the app binary's `required-features` prevents a default build from selecting it. The original intermittent paging disconnect remains unproven; this checkpoint does not add stress runs or change wire policies.

## Bootstrap receipt and proposed desktop handoff

The binary accepts zero arguments and emits one JSON line to stdout before serving, bounded to 4096 UTF-8 bytes including the newline. Existing fields are preserved. Current fields are:

```json
{
  "bootstrapVersion": 1,
  "protocolVersion": 1,
  "pid": "number: this daemon process",
  "uid": "number: OS user ID",
  "profile": "absolute path: freshly generated private profile",
  "socket": "absolute path: this server's private Unix socket",
  "fixture": true,
  "appFixture": true,
  "scriptedOwner": true,
  "ownedCopies": true,
  "identities": {
    "profile": { "dev": "decimal u64 string", "ino": "decimal u64 string", "mode": 448, "uid": "number", "kind": "directory" },
    "project": { "dev": "decimal u64 string", "ino": "decimal u64 string", "mode": "number: permission bits", "uid": "number", "kind": "directory" },
    "socketDirectory": { "dev": "decimal u64 string", "ino": "decimal u64 string", "mode": 448, "uid": "number", "kind": "directory" },
    "socket": { "dev": "decimal u64 string", "ino": "decimal u64 string", "mode": 384, "uid": "number", "kind": "socket" }
  },
  "actor": {
    "project": "absolute path: profile/fixture",
    "appFixture": true,
    "scriptedProvider": true,
    "provider": "kiro",
    "handoff": "gated",
    "steering": "gated",
    "tickMs": 20,
    "debounceMs": 100,
    "idleMs": 350,
    "interruptGraceMs": 250
  }
}
```

The explanatory strings above are schema descriptions; actual pid/uid/mode are numeric and paths are strings. `mode` holds Unix permission/special bits (`metadata.mode() & 07777`), so 448 is 0700 and 384 is 0600. Device and inode remain decimal strings because JavaScript cannot represent every u64 exactly. These identities are captured and rechecked before returning the line, using lstat to reject final symlinks. The identity checker is private and cannot construct an endpoint from supplied paths. A future launcher must independently verify the fixed child's PID/UID, local filesystem identity and peer credentials. A receipt is not atomic path-use protection or authentication by itself.

The receipt contains no account secrets. Timing values are fixture settings, not production defaults or performance measurements. The listener uses the existing 4 KiB frame/128 KiB outgoing-byte limits and advertises paging only. It does not advertise computer management or state patches.

**Agreed parent/desktop contract, shell not implemented:** the feature-gated shell spawns a fixed sibling `app-fixture`, owns its `Child` and stdin, and consumes the receipt only from that child's inherited stdout pipe. It bounds the line, verifies both versions/flags/PID/UID, canonical profile/Project containment, directory/socket identity and peer credentials, then mints a private `FixtureLaunchContext`. It never accepts receipt JSON as a renderer request, arbitrary command-line profile, saved preference or general environment override. The shell owns separate fresh preferences, localStorage/outbox/WebKit data, window-state, instance lock and smoke-output storage. The daemon exclusively owns its own profile; no content grants are derived from that profile path. No fallback to the production socket or preference files is permitted.

The future fixed-child launch should use `env_clear` and an explicit minimal environment, with private HOME/config roots and no inherited account/provider settings. This is configuration isolation, not an OS sandbox. No production HOME/config replacement is implemented or authorized by this checkpoint. A separate developer bundle ID also needs real macOS evidence that WKWebsiteDataStore cookies/localStorage/directories remain separate; no Tauri path assumption establishes that.

No arbitrary shell launch or desktop API is added here. The next contract must settle who retains the cross-process profile lifetime, how the shell identifies a deliberately limited fixture host without fake `computer-management-v1`, and how pending quit is exposed. Current stdin EOF requests the existing normal shutdown path, not an unconditional kill. A successful `daemon:stop` and `Server::finish` drain/join before cleanup; refused/pending shutdown does not mean stopped. This receipt is an input to that future trusted launcher, not a production profile-adoption capability.

Process teardown remains explicit: EOF during a refused busy shutdown leaves the daemon reachable for Stop and a later `daemon:stop`; it does not force-cancel work. A launcher that kills the process cannot claim joined workers, durable graceful completion or private-profile removal. SIGKILL bypasses Rust destructors and may leave that fresh profile on disk. The future launcher needs a bounded pending/refused status path and a separate crash-cleanup policy before app integration.
