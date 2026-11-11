# milagre-terminals (experiment)

Rust Terminal owner for the backend migration: a port of `packages/core/src/terminals.cjs` (node-pty 1.1.0) and of
the `terminal:*` command handling in `packages/core/src/runtime.cjs`. Standalone crate (own `[workspace]`), library
only. **Nothing is wired in yet**: the Node daemon still owns every Terminal. Nothing here binds a socket, reads
Milagre's data directory or touches an installed profile.

## API

```rust
use milagre_terminals::{wire, Terminals, TerminalsOptions, Worktree, TerminalEvent};

let mut options = TerminalsOptions::new(resolve_chat);          // Arc<dyn Fn(chat_id) -> BoxFuture<Result<Vec<Worktree>, String>>>
options.settings_file = Some(data_dir.join("terminal-settings.json"));
options.on_event = Arc::new(move |event| match event.wire() {
    Some((name, payload)) => emit(name, payload),                 // terminal:changed / terminal:preferences-changed
    None if event == TerminalEvent::ShellsChanged => ports.wake(),
    None => {}                                                    // Exited: extra, not on the wire
});
let terminals = Terminals::new(options)?;                         // fails only on an unreadable settings file

// Daemon routing: same commands, validation, errors and response shapes as runtime.cjs.
let reply = wire::handle(&terminals, "terminal:read", &request_json, &CommandContext { client_id }).await;

terminals.close_chat(chat_id);       // Chat archived
terminals.shells();                  // [(chat_id, [shell pids])] for the port watcher
terminals.size();                    // running-work check
terminals.dispose(Duration::from_secs(3)).await;  // host shutdown: ends all, answers reads, waits for cleanup
```

Typed methods mirror the Node object: `profiles`, `set_shell`, `list`, `open(OpenRequest)`, `read(id, after, limit)`,
`input`, `resize`, `close`. Shell discovery and the environment are `shell::{terminal_shell, terminal_shells,
terminal_environment}` over an injectable `ShellProbe`. The PTY layer is the `PtySpawner`/`PtyProcess` trait pair;
`UnixPtySpawner { cleanup, kill_grace, exit_drain }` is the real one.

## Contract kept from Node

- Commands `terminal:list|profiles|setShell|open|read|input|resize|close` (command-contracts.json T49-T55), the
  authenticated-connection rule (all but `list`), every error message, `Number.isSafeInteger` validation, `cwd == null`
  meaning the first Worktree, 80x24 fallback, 12 per Chat / 64 total.
- `info`: `id chatId title cwd label busy cols rows createdAt`; titles from the foreground process (`-zsh` -> `zsh`),
  idle at any shell prompt, busy when unknown. Title poll every 1.5 s emits `terminal:changed`.
- Replay buffer: 1 Mi UTF-16 units (JavaScript string length) and 10 000 lines, oldest chunks dropped, one oversized
  chunk keeps its tail. Offsets, `after`, `limit` (>= 4096) and `MAX_INPUT` (64 Ki) count UTF-16 units, so existing
  viewers' offsets stay valid. Limited reads never split a surrogate pair; `ended` waits until a viewer has read all.
- Long-poll reads wait up to 8 s for output, a title change or the end. Dropping a read future (a viewer going away)
  changes nothing; the owner keeps the shell until `close`, `close_chat`, `dispose` or the last handle drops.
- Output decoding matches node-pty's StringDecoder byte for byte, including chunk-boundary holding.
- Shell choice persists in `terminal-settings.json` (`{"shell":...}`), written temp-then-rename, 0600 in a 0700 folder;
  only installed shells are accepted; `.exe` and `elvish` start without `-l`; `SHELL` is set to the shell.

## Where it differs (deliberately)

| Behavior                            | Node                                   | Rust                                                                                                         |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Close / dispose                     | `pty.kill()`: SIGHUP to the shell only | SIGHUP to the shell's group and the foreground job's group, SIGKILL after `kill_grace` (2 s) if still alive  |
| `Cleanup::Tree` (opt-in)            | n/a in terminals.cjs                   | also stops every descendant found by ppid before signalling (process-tree.cjs `descendants`), nohup jobs too |
| Shell exits, job holds PTY          | exit after node-pty's socket close     | exit reported once output drains, or after `exit_drain` (250 ms)                                             |
| Closing with a half-typed line      | not submitted                          | not submitted (portable-pty's writer, which types `\n` + EOF on drop, is not used)                           |
| Lone surrogate in output            | sent as a lone surrogate               | sent as U+FFFD (same length, offsets unchanged); only after a cap cut through an astral character            |
| Dispose during `open`'s Chat lookup | opens a shell after dispose            | refuses with "Terminals are closed."                                                                         |
| Exit event                          | none (`terminal:changed` only)         | adds `TerminalEvent::Exited { exit_code, signal }`, never on the wire                                        |
| Concurrent opens                    | one thread                             | `openpty` + spawn serialized process-wide (macOS `openpty` fails concurrently with error -6)                 |

## Tests (`cargo test`, 38, macOS arm64, all local targets)

- `tests/conformance.rs`: replays `tests/fixtures/conformance.json`, recorded from the **Node** owner with a fake PTY:
  17 scenarios (every result, error, PTY call and event), 25 shell-discovery cases (darwin, linux, win32, other), 3
  environment cases, 20 StringDecoder cases. Regenerate with
  `node experiments/rust-terminals/scripts/generate-conformance.cjs && npx oxfmt experiments/rust-terminals/tests/fixtures/conformance.json`.
- `tests/owner.rs`: waiting reads, read timeout, exit and close answering waiting viewers, a viewer dropped mid-read,
  title polling, authentication rule, dispose, last-handle drop, settings file modes and bad files.
- `tests/real_pty.rs`: real `/bin/sh` in temporary folders: echo/cwd/env, `stty size` after resize, `exit 3` code and
  final output, Unicode round trip and UTF-16 offsets, buffer caps under a 1500-line flood, 208 ordered inputs, owner
  survival across a viewer disconnect, busy/title for `sleep` and Ctrl-C, foreground child + shell stopped on close,
  SIGKILL after the grace for a shell ignoring SIGHUP, nohup job kept (`Hangup`) vs stopped (`Tree`), exit not held up
  by a background job, no half-typed command run on close, missing shell.
- Unit tests: Node `path` parity, buffer, decoder, safe integers.

## Gaps

- Not wired: no Rust owner calls it yet; daemon/socket routing, `terminal:changed` forwarding and the port watcher
  (`agents/ports.cjs`) remain Node.
- Windows: shell discovery is ported and fixture-checked, but there is no ConPTY spawner (`UnsupportedSpawner`
  answers "Terminals are not available on this platform yet."); Windows foreground detection (node-pty answers the
  terminal type) is only modeled. Linux builds the same Unix code but was not run here.
- No real-PTY comparison against node-pty itself: node-pty is not installed in this Worktree, so Node parity is
  through the fake-PTY fixtures; real-PTY behavior is tested on Rust alone.
- The Node runtime's `loadLoginEnvironment` (which patches `process.env` before Terminals start) is not ported;
  `TerminalsOptions::new` reads this process's environment.
- A shell that exits before `open` returns ends its Terminal but emits no `Exited` event.
