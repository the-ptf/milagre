# milagre-ports (experiment)

Rust port watcher for the backend migration: a port of `packages/core/src/agents/ports.cjs` and of the
`agent:ports` / `chat:ports` / `agent:stop-port` handling in `packages/core/src/runtime.cjs`. Standalone crate (own
`[workspace]`), library only. **Not wired**: the Node daemon still runs the port watcher.

## API

```rust
use milagre_ports::{wire, with_terminal_shells, PortWatcher, PortWatcherOptions, Root, Roots};

// Inside a Tokio runtime (its handle runs the polls; wake() may be called from any thread).
let roots = Arc::new(move || with_terminal_shells(agent_roots(), terminals.shells()));   // milagre-terminals
let publish = Arc::new(move |ports: &ChatPorts| { let (name, payload) = wire::event(ports); emit(name, payload) });
let mut options = PortWatcherOptions::new(roots, publish);
options.is_running = Arc::new(move || terminals.size() > 0 || any_turn_active() || advisors_running());
let ports = PortWatcher::new(options);

// Terminals: TerminalEvent::ShellsChanged => ports.wake(); agent turn started => ports.wake().
let reply = wire::handle(&ports, "agent:stop-port", &[json!(chat_id), json!(pid)]).await;   // Ok(Value)
ports.close();                                                                                // host shutdown
```

- `Root { pid, cwd, agents, shells }` per Chat: the agent CLI's pid, execution agents (advisors) working for the Chat,
  Terminal shell pids. `with_terminal_shells` merges `Terminals::shells()` as runtime.cjs does (`{ ...root, shells }`).
- `PortWatcher`: `poll(fresh)`, `wake()`, `close()`, `snapshot()`, `chat_ports(chat)`, `stop_port(chat, pid)`,
  `groups()`, `scheduled()`, `supports_stop()`. `PortWatcherOptions` injects `exec`, `identity`, `kill`,
  `stop_windows_tree: Option<StopWindowsTree>`, `now`, intervals. A Windows stopper returns `bool` and must verify the
  supplied birth time immediately before signalling; false propagates to the caller.
- Pure layer: `parse_ps`, `parse_lsof`, `parse_task_outputs`, `chat_processes`, `chat_ports`; `exec::{windows_script,
  windows_invocation, powershell_environment, system_exec}`.
- Event `agent:ports` payload and `Port { port, pid, command, address, taskId? }` serialize to the Node shapes.

## Contract and deliberate safety corrections to Node

- **Ownership**: a Chat owns what its agent's command shells (children that are a shell or lead their own group)
  and its Terminal shells started, not the agent's same-group children (MCP servers). Groups seen are remembered, so
  a server that outlived its shell, agent or Terminal stays listed while a previously observed member with the same
  PID, birth time and PGID anchors that group. An identity read failure or complete member turnover drops remembered
  ownership, even if the numeric PGID persists. Agent/advisor groups are never remembered as command groups. Shared
  Worktrees do not grant ownership. The pure `chat_processes` traversal retains Node fixture parity; the watcher
  validates remembered groups before passing them in.
- **Sampling**: `ps -axo pid=,ppid=,pgid=,comm=` every poll; `lsof -nP -a -p <pids> -iTCP -sTCP:LISTEN -F pcn` only
  when the sorted pid set changed, on a fresh poll or when 10 s old; `lsof ... -d 1 -F pn` for background task outputs
  (`.../tasks/<id>.output`, on the listener or its group leader). Every 3 s while running, 15 s idle, nothing once no
  roots or groups remain. Unix rows also require a matching kernel parent/group snapshot and birth time: macOS
  `proc_pidinfo(PROC_PIDTBSDINFO)` (microseconds), Linux `/proc/<pid>/stat` (clock ticks). Missing identities fail
  closed. One poll at a time; a fresh poll waits for the running one and reads again; `wake` starts one
  now unless one runs. Publishes only on change. Closed watchers neither publish nor reschedule.
- **Stop** (`agent:stop-port`): only a previously listed PID that remains listed with the same birth time and PGID
  after a fresh `ps`/`lsof` poll. Unix checks the listener and original group leader identity immediately before
  **every** SIGTERM, signal-0 probe and SIGKILL. It stops the command group only while that leader survives; otherwise
  an orphan gets a process-only stop. Agent, advisor, Terminal and runtime groups are protected; a shared group gets
  a process-only stop. Root PIDs themselves are protected. PID/PGID <= 1 cannot become signal targets; the syscall
  wrapper also rejects -1, 0 and 1. Group leader or listener disappearance/reuse ends escalation. Windows retains the
  fresh listing and expected-start-time tree contract, and rejects a changed listener identity across that poll.
  These intentionally correct latent Node bugs (stale signals, agent-group kills, numeric-PGID orphan ownership).
- **Limits**: identity validation and POSIX `kill` are separate syscalls, so a final check/use race remains. This is
  not atomic process-handle signalling. A group whose leader exits during grace may leave descendants running; no
  subsequent group signal is sent. This favors Chat isolation over aggressive cleanup.
- **Windows commands**: the same two PowerShell scripts, `-EncodedCommand` UTF-16LE base64, `powershell.exe` under
  `SystemRoot`, `PSModulePath` reset; pid lists that aren't `^\d+(,\d+)*$` never reach PowerShell.

## Cleanup relative to milagre-terminals

The two crates keep the Node split. Stopping a **port** in a Terminal's shell group stops that process only.
Closing a **Terminal** uses milagre-terminals' `Cleanup` (README there): `Hangup` (default) leaves `nohup`/disowned
jobs running, and this watcher keeps listing their ports through the remembered groups, so they can still be stopped
from the port list. `Cleanup::Tree` ends them with the Terminal, and the next poll drops their ports.

## Tests (`cargo test`, 30, macOS arm64)

- `tests/conformance.rs` replays `tests/fixtures/conformance.json`, recorded from the **Node** watcher: 5 `ps` listings
  (macOS, Linux procps, Windows script output, malformed lines), 4 `lsof` listings (IPv6, zone ids, duplicates, Windows),
  3 task-output listings, 7 ownership sequences with groups carried between steps, 12 watcher scenarios (every exec call
  and argument, signal, Windows tree stop, publish, snapshot and group state per step), and 5 Windows invocations
  captured from `run()` itself. Original Node fixtures are unchanged. The replay asserts two explicit Unix stop
  differences: the initial fresh read and no probe after the original identity disappears. Regenerate:
  `node experiments/rust-ports/scripts/generate-conformance.cjs && npx oxfmt experiments/rust-ports/tests/fixtures/conformance.json`.
- `tests/watcher.rs` (paused clock): 15 s idle / 3 s running cadence and immediate wake, close during a poll, a stop
  during a poll waits and re-reads, wake from a non-runtime thread, wire validation, Terminal-shell merge.
- `tests/real_ports.rs` (real `ps`/`lsof`, loopback-only helper `milagre-ports-test-listener` started by the tests):
  command-shell listener owned with its task id while the agent's same-group child is not; the orphan stays listed
  after the agent dies; stop ends the job's group and empties groups; a Terminal shell's server found by periodic
  sampling and stopped without stopping the shell; a listener that dies on its own drops out; a command shell in the
  agent's group stops only its listener and leaves the agent, shell and MCP helper alive. Cleanup verifies helper
  identities before signalling.
- `tests/stop_safety.rs`: mocked PID/PGID reuse before and during stop, fresh listener reads, failed identity reads,
  missing leaders, anchored orphan continuity and cross-Chat PGID reuse, primary/advisor/Terminal group protection,
  root/invalid PID guards, group protection changes during grace, and Windows unsupported/failure results.
  `identity.rs` also tests Linux stat parsing without requiring a Linux host.

## Gaps

- Not wired into any Rust owner; Node still emits `agent:ports`.
- Windows: `stop_windows_tree` defaults to `None`. `supports_stop()` and typed `stop_port()` return false;
  `agent:stop-port` reports an explicit unsupported error. An integration must inject a real process-tree stopper.
  The PowerShell commands are fixture-checked, never run here.
- Linux: same commands and parsers (fixture-checked); not run here, and `lsof` may be missing on Linux hosts (then no
  ports are found, as in Node).
- Other Unix systems have no default identity reader and fail closed.
- `lsof -F c` truncates command names (9 characters on macOS), as in Node.
