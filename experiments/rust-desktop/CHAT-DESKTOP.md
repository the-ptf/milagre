# Dedicated Rust Chat desktop

`milagre-rust-chat` is an off-default native binary. It loads the existing production React renderer and starts one fixed sibling `chat-runtime` for an explicitly selected dedicated root. It neither installs itself nor discovers or falls back to the production Milagre socket. The ordinary `milagre-rust` and scripted fixture entrypoints retain their existing behavior.

```sh
node experiments/rust-desktop/build-renderer.mjs
cargo build --manifest-path experiments/rust-desktop/Cargo.toml --locked --offline --features chat-desktop --bin milagre-rust-chat
```

Stage the built binary beside the separately built normal `chat-runtime`. The launch arguments match the runtime:

```sh
MILAGRE_BACKGROUND=1 /explicit/staging/milagre-rust-chat create /explicit/new-data-root /explicit/launch.json
MILAGRE_BACKGROUND=1 /explicit/staging/milagre-rust-chat open /explicit/dedicated-data-root
```

The runtime's [launch manifest](../rust-runtime/CHAT-RUNTIME.md) selects the executable, account/config directory, OS user identity, model and bundled instructions. The shell does not inspect credentials. `open` requires the previous writer to have stopped. `create` refuses an existing root.

The shell retains the exact child and its stdin, consumes the child's bounded receipt, checks its PID and socket peer PID/UID, and pins the fresh profile/socket plus expected persistent root/Project identities. A changed or exited child closes this route. The existing multiplexed transport supplies paging, event ordering and state hydration without requiring the limited owner to advertise computer management.

Native preferences, window state and WebKit storage are isolated from the installed applications. WebKit explicitly uses a nonpersistent store and the shell checks that choice before showing the window. The production UI and preload are unchanged. Unsupported native/account/content operations fail explicitly; this entrypoint currently covers the configured Chat path rather than every app service.

Close and Quit request `daemon:stop`, require its matching acknowledgement and a successful exit of the retained child, then remove only the temporary shell directory. Each Chat wait budget is 10 seconds; pending/refused cleanup keeps the window/context alive and supports retry. The persistent data root is never a cleanup target. Crash cleanup remains distinct from successful save/shutdown and signals only the retained child when its live identity is known. No normal cleanup depends on code after Tauri's event loop returning.

## Native probe

Build only the explicit probe binary after rebuilding the renderer:

```sh
cargo build --manifest-path experiments/rust-desktop/Cargo.toml --locked --offline --features chat-native-smoke --bin milagre-rust-chat
```

Set `MILAGRE_CHAT_SMOKE_CONFIG` to an owned, single-link, mode-0600 JSON file of at most 32 KiB. Example read-only plan:

```json
{"mode":"observe","sessionId":1,"expectedText":"previous saved reply"}
```

An explicit send plan supplies `mode:"send"`, `sessionId:1`, and `body` (1 through 16384 bytes). Optional `expectedText` checks the saved and visibly rendered reply. Optional `permission` requires exactly `{ "tool":"Write", "path":"/absolute/dedicated/project/file", "decision":"allow" }` or `decision:"deny"`. The path must be inside this Project. Observe plans cannot send or answer. No permission is answered implicitly; an unmatched or additional request fails the probe.

The probe opens the existing Chat, selects the configured model using production controls, enters text into the production composer, clicks Send once, and answers through the visible permission card after matching the owner's exact Write/path request. It verifies streaming, terminal/save results and no replay on renderer reload. It does not rewrite a request or change TLDR/preferences to fit the backend.

Stdout identifies the owned child and then a new private evidence directory. `report.json` contains `identity`, `mode`, `isPersistent`, `passed`, two `stages`, and `exit`. Successful stages contain native `before-reload.png` and `after-reload.png` captures. Capture failure fails the probe. A 180-second watchdog writes a timeout and requests owned Quit without resending. The external observer must still require successful shell exit, `cleanOwnerExit`, shell/profile removal and preservation of the persistent root before accepting the run.

The checked staging observer takes only an existing dedicated root and explicit plan:

```sh
node experiments/rust-desktop/native-chat-smoke.mjs /absolute/dedicated-root /absolute/native-plan.json
```

It stages/signs the two fixed binaries privately, records their post-signing hashes, validates both PNGs as nonblank, compares message counts/IDs and native session ID across reload, requires zero replay, and checks shell/profile cleanup. Its 215-second deadline is after the shell's graceful Quit deadline; a remaining retained shell is signalled with SIGTERM and the run fails. It never signals by process name. Evidence and persistent data are retained.

## Real native acceptance (2026-11-11)

Both current runs use real Claude Code 2.1.322 with the explicitly selected account and the production React sidebar, model picker, composer and permission buttons. Input is synthetic DOM input through those components, not physical keyboard/mouse input. No request is rewritten, and default TLDR settings are retained.

| Run | Actual result | Evidence |
| --- | --- | --- |
| Allow | One Send and one Allow once; exact Write request/path; permission resolution, streamed reply and terminal completion; messages 6 to 8; exact requested file bytes | `/private/tmp/milagre-native-chat-observer-dXjCEY/observer.json`, PNGs `/private/tmp/milagre-chat-evidence-cQyaBg/` |
| Deny | One Send and one Deny; permission resolution and streamed completed reply; messages 8 to 10; requested file absent | `/private/tmp/milagre-native-chat-observer-QYYFNl/observer.json`, PNGs `/private/tmp/milagre-chat-evidence-nRzEuO/` |

Both renderer reloads preserve saved message IDs/counts, native session ID and the current daemon epoch, with zero sends or permission answers after reload. Both report nonpersistent WebKit, exit 0, empty shell stderr and private shell/profile removal at observed delays 0/250/1000 ms, with the data root retained. Root separately checked exact allowed-file bytes, denied-file absence, both owned process exits, derived socket removal and Project owner-lock removal in `/tmp/milagre-chat-desktop-root-independent-evidence.json`. These runs share one persistent Project and are sequential; no second writer was started.

Post-signing binaries for both runs: shell `65481c3ab0162d9345ddeeb6be39587866adf48df960b6063ec289b9bdba6f2c`, runtime `cfaac75dbf0d6b689c7498697741c7ee8a272e15d9faafe920c1b1c1fee8dd1c`.

Earlier observe/send runs `QoBrKl` and `7T5NjQ` proved saved rendering and a real composer turn, but their screenshots showed `Could not update Chat: Unknown command: chat:patch`. They passed the older, weaker assertion. The runtime now implements only the persisted `{unread:boolean}` patch subset through the existing owner, with actual Node reducer comparison and restart checks. The observer now refuses that error, and current captures show no such banner or unread dot. Other patch fields remain refused.

Root validation: 100 runtime tests, strict all-target feature Clippy and formatting; default shell 41 tests with one installed-host test ignored, scripted fixture 37 with one ignored, and 15 JS helper tests. The implementation agent passes 34 dedicated-bin tests with one installed-host test ignored, dedicated-bin strict Clippy and lint. Source review closes the custom-profile exclusion and unread-state findings. Logs are `/tmp/milagre-chat-unread-root-*`, `/tmp/milagre-chat-desktop-root-*` and `/tmp/milagre-chat-desktop-{tests,clippy,lint,build}.log`.

This is a working dedicated Chat path, not full app parity or production adoption. Each current run still records 36 distinct unsupported/unavailable method names covering other services, including content, usage, terminal, Git, routines and integrations. They are not successful empty stubs. No real Design/Artifact authoring, other-provider or phone claim follows from this checkpoint. The ordinary installed `Milagre Rust.app` remains current and signed on its existing Node route; this development binary is not installed. No production host restart, mobile change or push occurred.
