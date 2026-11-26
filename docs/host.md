# Host

The daemon owns every Project's state and every process Milagre starts: agents, Terminals, Git, and which browsers a Chat may use.

## One writer per Project

`@milagre/core` runs in a persistent Node daemon, and that runtime is the only writer of its data directory and of every Project it opens. Desktop and phones are clients. Electron keeps native OS actions (windows, dialogs, notifications, updates) and the renderer only displays state.

The reason is Delegation: a Delegation can start or steer a turn in a Chat whose Project isn't open on any screen. So the host, not a window, owns agent sessions and writes transcripts. Switching the viewed Project never stops a turn.

Rejected: keeping the renderer as the writer and opening several Projects at once. A Delegation would still fail whenever its target Project wasn't loaded in a window.

### Locks

- Each runtime takes an atomic directory lock on its data directory and on each Project it opens. Real paths decide ownership, so a symlink can't bypass it, and the lock lives in the common Git directory so linked checkouts are covered too.
- Worktree mutations take ownership before running git.
- A lock survives an unclean exit. Recovery is explicit and checks that the recorded owner has exited (PID plus process start time on Windows); the host never guesses whether another process is alive and never steals a lock. There is no live state transfer between hosts.
- Releases older than the daemon don't honor these locks. Close a Project there before the daemon opens it.

### Connections

- Unix uses a private socket guarded by directory permissions; any client running as the same OS user may connect. Windows uses a named pipe whose first frame runs mutual HMAC authentication with fresh nonces, so the profile token is never sent to a pipe another process could have created. A pipe name is an endpoint, never a path to delete or chmod.
- Each connection has its own viewed Project, Chat and focus. One client can't change another's selection.
- On reconnect a client takes a snapshot with an event watermark and applies only later events. A client never replays a command whose acknowledgement it lost. The one exception is the [device outbox](computers.md#offline-outbox), which reads a durable send receipt first and resends with the same ids.
- Remote transport and managed startup are layered on this owner; they can't create a second writer.

### Startup and shutdown

Desktop attaches to a host advertising `desktop-v1`, or starts the bundled daemon detached, run by the packaged Electron binary in Node mode.

Both read the login shell's environment at start, because an app opened from Finder gets only launchd's `PATH`. Only the host also asks `npm prefix -g` for npm's global folder: it runs the agent CLIs npm installs there, while the desktop's main process only looks for editors, and npm's start costs it about 0.15 s of CPU on every launch.

- Desktop quit flushes accepted changes and disconnects. The host and its agents keep running. A failed flush keeps the window open for retry.
- An explicit daemon stop is the full shutdown: refuse new commands, wait for accepted ones and background work, save resumable turns, stop agent and setup processes (the whole descendant tree on Windows), drain writes, release locks.
- Installing an update saves and stops the host before replacing its code. A normal quit never installs an update under a running host.

## Terminals

A Terminal's shell runs under the daemon's PTY, so it survives desktop quit and a paired phone can view and type in it. Terminals end when their shell exits, their Chat is archived or deleted, or the daemon stops. Nothing restores them after a restart.

- Output is kept only in the daemon's memory, a bounded tail per Terminal for viewers that reopen it. It is never written to disk: passwords and tokens pass through terminals.
- There is no control lease. Every viewer can type at once, like a shared tmux session, and the PTY takes the size of the viewer that typed or focused last. The common case is moving from computer to phone mid-command, and a shell has no held keys a lease would need to release.

Rejected: running the shell in the Electron main process (dies on quit, unreachable from the phone); persisting scrollback (secrets); reusing the Browser page lease (see above).

## Git

`packages/core/src/git/client.cjs` runs every Git command. It sets noninteractive credentials, named deadlines and output limits, normalizes results and validates refs. `GitError` carries the normalized fields for callers that want exceptions.

- Read helpers refuse mutating commands; commit, push, fetch and Worktree changes go through `write`. These are internal APIs, not a sandbox. A read-only tool for remote callers must expose specific queries, never raw Git arguments.
- Changes, sidebar totals and the commit/PR dialog pick the same comparison branch: the recorded branch, then the remote default, then main or master. A Changes panel override applies to that panel only.
- Known Worktree paths come from Project state after reconciliation; diff and file search don't re-enumerate Git. Removing a Worktree still rechecks Git and ownership right before deleting.
- Every registry write checks that each registered Project still has the Git identity it was saved with. A confirmed identity is kept until the folder's real path changes, the folder or its `.git` directory is replaced, or the repository's `config` or `config.worktree` changes, so a host with many Projects doesn't run three Git calls per Project on each write. Only a confirmed answer is kept, never a failure or a mismatch, and nothing is kept where the answer depends on more than those files: plain folders (a folder above can become a repository), a `.git` that isn't a directory in the folder, a config with `[include]`, and a folder or `.git` owned by another user (Git's `safe.directory`).
- Project images ask GitHub once per endpoint at a time: Projects opening together share an owner's lookup and the signed-in user's lookup in flight. Nothing is kept once it is answered, so the next window asks again.

## Browser pages

A Browser page belongs to a Chat on evidence, never on a name, title or URL.

- **Process lineage.** A Chromium process descending from a Chat's agent process belongs to that Chat. The host checks the process table every few seconds while an agent runs and whenever a client lists browsers. `lsof` runs only for browser processes not yet seen listening on loopback: a process keeps its DevTools port for life, and a PID with other arguments is a new process. Lineage is remembered once seen, because the MCP server or shell that launched a browser can exit while it keeps running. A browser is keyed by the GUID in its DevTools endpoint plus its PID, so a relaunch or reused port never inherits an old owner. Chats in one Worktree have separate agent processes, so they never see each other's browsers.
- **Attachment.** A browser no Chat started (the user's own, or one that left the agent's tree, such as a background daemon or `open -a`) is listed under "Other browsers on this computer". Attaching adds its pages to that one Chat, until the browser exits, the Chat detaches, or the daemon restarts. A browser another Chat's agent started is never offered.
- **Agent tools.** `browser_list`, `browser_attach` and `browser_detach` are bound to the agent's own Chat. They attach existing browsers; they never register a page by URL or name. Lineage stays first because it needs no prompt changes and a tool argument can't spoof it.
- Only browsers with a loopback DevTools port qualify. `--remote-debugging-pipe` (Playwright MCP's default) has no endpoint to attach to.
- Opening a page in a device's Browser panel loads its address in that device's own WebView. Each device has its own navigation, inputs and sign-ins; ownership decides which addresses a Chat offers, not page state. Remote Chats' pages are covered in [computers.md](computers.md#browser-pages-on-another-computer).
- On macOS a release signed with the provisioning profile ([release.md](agents/release.md)) lets desktop Browser panel pages create and use Touch ID passkeys. They stay on that Mac, in that session (one per computer a page belongs to), and are not iCloud Keychain passkeys: Electron can't reach those for arbitrary sites. The phone's WebView has none: iOS gives a WebView passkeys only for the app's own associated domains or in a browser Apple entitles.
- Phones reach a page over a LAN or Tailscale address, else an authenticated Cloudflare Quick Tunnel to a per-origin proxy.

## Window decoration

macOS draws traffic lights inside the content; Linux and Windows use an external native frame by default. The sidebar reserves space only when controls sit in the content. A Linux window manager that hides the frame doesn't move controls into the content, so no reservation is needed there.

`--window-decoration=overlay` hides the native title bar on Linux and Windows and turns on Electron's Window Controls Overlay. The renderer reads its geometry, on resize and fullscreen too, to keep the sidebar, panels and diff actions clear of controls on either edge.

The preload exposes the local window's decoration apart from the Project bridge, so a Project on another computer can't change the window's layout.
