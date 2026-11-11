# Isolated Claude owner bridge

`ClaudeFixture::create(Scenario)` implements the nonblocking owner Provider contract over `milagre_claude::ClaudeSession`. It creates a fresh private Project/profile and launches only the fixed Cargo sibling `runtime-fake-claude`, compiled directly from the checked-in rust-claude fixture source. It accepts no executable, external path, credentials, environment, role or MCP endpoint. `claude-runtime` exposes this fixture through the existing owner actor and a separate private wire profile. It cannot connect to the installed app or production daemon.

Each Chat has a private executor and one Claude session, bounded to 16 workers, one queued start, eight queued answers and at most eight retained answer tasks per worker, 32 outstanding answer receipts globally and 256 ordinary events/4 MiB serialized payload plus bounded terminal/answer reserves. Completed slots are removed on subsequent admission. Provider methods only enqueue; synchronous Claude answer callbacks run on the worker. Close is bound to the captured slot and current host TurnId. Close detaches the captured slot immediately; its worker retains resources while reaping, and a later turn creates a fresh session and registration. A stale close cannot stop its replacement. Overlapping starts and implicit extra turns are refused; production steering is still gated.

Each admitted turn receives Started or StartFailed. A running turn emits one host terminal, then one generation-bound Exited when its session closes. Compact subagent settlement deltas from close are forwarded before the terminal/exit without replacing transcript history. The owner merges transcript rows by id. Normal shutdown and cancelled startup retain the executor, profile and worker permit until all supervisors finish reaping. A three-second deadline latches cleanup failure and closes admission; it never releases an unreaped child. The fixture executable reports `CLAUDE_CLEANUP_INCOMPLETE`, waits for cleanup, and exits with failure if that deadline was exceeded.

Permission/question replies use the owner's asynchronous AnswerId contract. Accepted means the Claude callback resolved, not that its transport write or tool execution completed. NotWaiting means no callback waited. A queued answer dropped before entry may fail; cancellation after callback entry is Uncertain. The delayed-receipt fixture proves the CLI received the answer before cancellation, and requires Uncertain rather than rollback. Actor replies wait for the matching owner notice and publication. Normal turn completion releases active answer slots into bounded historical reconciliation records. A late definitive receipt updates that history without a second RPC reply. Idle answers return false; this adapter never replays an answer.

RawJson provider events enter the owner codec once. The owner supplies native RawJson requests and answers; the adapter does not decode them again. Outbound prompt/answer text preserves literal noncharacters and private-use characters, replacing lone UTF-16 units with U+FFFD only in the native CLI copy. Stored originals remain lossless. Request/question identities, keys and model/resume metadata stay strict. Ordinary Ask, Auto and Full turns with typed model, effort, `ultracode`, `fastMode`, `replies` (`concise`/`normal`), `tldrEnabled` and initial resume are admitted (see Ordinary launch below). Mistyped values, unknown modes (Node coerces them to Ask), a missing model, images, roles, account routing, arbitrary launch configuration, user MCP extras and caller-selected MCP are refused. Initial resume is checked on the actual fake process argv; a reused session refuses a different native identity until closed.

## Live permission changes

The Claude fixture alone advertises `agent:set-permission-mode`. It requires an explicit
Project open on that connection and a Chat in the generated Project. Scripted/Kiro, Codex,
ACP, the app fixture and the shared client's public capabilities are unchanged.

The actor retains the RPC reply while the owner waits for a generation-bound mode receipt.
The adapter queues bounded work and checks its captured generation again after the session's
operation/delivery waits. A completed native rejection is an error, never a successful RPC.
After completion, the owner notes the Chat preference even on a live error, following Node's
error priority. A success is `null`, published after the kept preference; it does not claim a
direct disk read or an independently observed durable flush. Missing Chats are not created.
Queued sends keep their original settings. A late old-generation receipt can note the saved
preference but cannot rewrite a newer turn's active settings.

Only one pending mode change per Chat is admitted. Timeout or cancellation after entry reports
`MODE_DELIVERY_UNKNOWN` once and retains admission. A close request is not cleanup evidence.
The adapter's captured-worker identity distinguishes a replacement session from an older
session still closing. After its mode tasks finish and its session closes/reaps, exact operation
receipts settle remaining uncertainty; a failure receipt means the operation ended with an
error, not proof that it had no earlier effects. Late settlement produces no second RPC reply.
Two reserved events per mode cover uncertainty followed by cleanup. Forget/quit revoke writes.
The owner contract and deliberate deviations are in
[PROVIDER-CONTRACT.md](../rust-owner/PROVIDER-CONTRACT.md#permission-mode-asynchronous-generation-bound-update).

`claude-live-modes.json` records the actual Node ClaudeSession behavior. The native fake checks
its control frames and answers during one Ask turn: Full resolves the first Bash card, Ask
restores prompting for the second, and an explicit denial finishes the turn. Auto then Ask
changes the retained idle session. `tests/claude-compat.cjs` drives this as the fourteenth
production Node-client fixture scenario and compares cards/events, saved preferences and
transcript. It also refuses missing-view, foreign-scope and invalid-mode requests. The separate
receipt tests exercise native rejection, delayed admission, close and captured-worker cleanup.

Root validation: 154 Claude tests pass (one live test ignored), 74 default runtime tests pass,
and all fourteen Node-client scenarios pass. Root also passes nineteen owner lifecycle tests
plus the actual Node owner oracle; the implementation agent's full owner run passes 211 tests
with two ignored. Strict Clippy/fmt pass for the affected Rust crates, and runtime all-feature/
all-target compilation passes. Fresh non-writing Node recorders match the instruction, ordinary,
initial-mode and live-mode cases. Targeted JS lint has zero errors and six existing recorder
shadow warnings; formatting passes. Independent source review closes the premature-release,
replacement-session and discarded-receipt P2s. The last fix consumes exact terminal cleanup
proof during forget/quit and buffer overflow without state writes, reopening or replay.

Root logs: `/tmp/milagre-live-modes-root-claude-{tests,clippy,fmt}.log`,
`/tmp/milagre-live-modes-root-runtime-{accepted,allfeatures-final,clippy-final,fmt-final}.log`,
`/tmp/milagre-live-modes-root-owner-{accepted,clippy-final,fmt-final}.log`,
`/tmp/milagre-live-modes-root-node-accepted.log`, and
`/tmp/milagre-live-modes-root-{instructions,oracle-final,jslint-final,jsfmt}.log`.
The initial full runtime attempt omitted `NODE_PATH` and failed five Node-dependent tests with
`MODULE_NOT_FOUND`; the configured rerun passed. An initial lint invocation looked for ESLint,
which this repository does not use; final JS checks use its Oxlint/Oxfmt. These setup failures
are retained in the earlier logs. No external process signals or cleanup scans were used.

These checks use a fixed fake CLI. Real `acceptEdits`/`bypassPermissions`, the SDK-initialize
versus private-file prompt difference, steering-carried mode changes, broader workspace grants,
account routing, images and background-aware restart remain unverified or unported. The checked
Rust API reports native errors where Node's session method swallows the control rejection.
Existing void session callers keep their prior behavior. No provider or production host is enabled.

## Evidence

Ordinary-turn root acceptance: 137 rust-claude tests pass (one live test remains
ignored), 93 runtime tests pass with both fixture features, and all twelve production
Node-client scenarios pass against the fixed native fake. Strict all-target Clippy and
formatting pass for both crates. Root reran both non-writing Node recorder checks:
81 instruction texts, eight existing session traces, two ordinary launch queries and
40 prompt-suggestion cases match fresh actual Node output. These recorder checks are
explicit commands, not an automatic Cargo gate. Independent source review found no
P1/P2 within the admitted fake-provider scope; the real-CLI transport and background-work
limits in Ordinary launch remain open.

Root logs: `/tmp/milagre-claude-ordinary-root-{tests,clippy,fmt}.log`,
`/tmp/milagre-runtime-ordinary-root-{tests-configured,clippy,fmt,build,node}.log`,
`/tmp/milagre-instructions-oracle-root-check.log` and
`/tmp/milagre-claude-oracle-root-check.log`. The first combined runtime attempt omitted
`NODE_PATH` and failed ten Node-dependent tests with `MODULE_NOT_FOUND`; the corrected
full run passed without Rust changes. The Node-client run observed PIDs 15689, 15689
and 15712, including the old process still exiting when turn three completed. That
overlap is recorded by this script; the bridge test separately asserts late Exited ordering.

Twelve `claude_bridge` integration tests use the fixed native fake process. They cover sequential turns/process reuse, permission/question receipts, Stop, crash, cancelled initialization, refused policy/image configuration, cancellation after callback delivery, stale close, initial resume and conflicting identity refusal, drop/reaping, and compact subagent transcript retention through the real owner reducer.

The production Node daemon client and desktop runtime client run twelve fresh fixture scenarios: reply/text, permission, question, Stop, crash, Unicode, shared native MCP content, queued turns, native Designs, native content write Allow/Deny and ordinary three-turn settings. Both prompt and question-answer Unicode frames are asserted inside the fake CLI. Marker/PUA output survives the provider-to-owner boundary once; saved prompt text retains its original lone surrogate. Every fixture verifies both temporary profiles disappear after successful shutdown.

This checkpoint does not replace the shared Node runtime, prove real-provider compatibility, wire account/tool policy, or install any app. Broader session/resume lifecycle coverage remains follow-up work.

## Shared native MCP content scenario

The fixed `Content` scenario creates one ContentOwner in the same private isolation and Project as its ChatHost. The actor's renderer Artifact routes and Claude's InProcessMcp registration share that owner and its serialized stores. The registration receives the exact Dispatcher manifest; only its read-only tools enter the CLI's allowed-tools list. It cannot select another Project, directory, profile or arbitrary MCP server.

Authority callbacks read only immutable fixture Chat-to-Project mappings and atomic admission/generation flags. They never call back into the actor or read the filesystem. Opening a scope succeeds before authority is granted. Forgetting revokes its generation; reopening cannot revive a retained old grant. Shutdown closes the shared stores even if revoked sessions remain retained. This static fixture authority does not prove production Project lock replacement or dynamic registry authorization.

The native fake sends a real `mcp_message` for artifact_show and checks its control response. Production Node desktop-runtime RPCs then list/read that exact saved HTML, see an empty sibling Chat, refuse an unknown Chat and refuse a forgotten scope. A separate guard test verifies duplicate-writer refusal, immutable Chat grants, retained-grant revocation after reopen, exact read-only launch manifest, and lock release with retained dispatcher handles. No new daemon MCP endpoint exists.

Content dispatch uses its existing bounded asynchronous executor. Dropped queued work is cancelled; a lost reply after execution begins remains conservatively uncertain. This first bridge supplies no per-call receipt to InProcessMcp and never automatically replays a mutation. Whole-host advisor/babysit policy is not yet covered through this Claude route. Existing separate renderer/MCP Design tests still run unchanged.

The queued-turn Node-client scenario records the second message in Project state while the first turn runs. It then observes two terminal events, two persisted assistant replies, one copy of the queued input and one native session initialization. The wire send response keeps Node's `{sessionId}` shape; queue state is verified from the Project snapshot.

A 1,024-attempt answer-burst regression consumes settlements during admission, checks every accepted AnswerId settles exactly once, and observes that retained answer tasks never exceed eight. This cap includes completed JoinSet entries waiting to be consumed.

## Native Design and PNG checkpoint

The fixed `Design` scenario uses the existing compiled `milagre-design-raster` sibling. Its path is derived by the trusted fixture constructor, never supplied by a caller. One RasterRenderer is attached to the same shared ContentOwner. The native fake issues design_show and design_apply over `mcp_message`, checks successful PNG feedback responses, then emits ordinary native tool completion frames.

The production Node-client test decodes both actual MCP-output PNGs with the existing pngjs dependency. They are 240 by 240 pixels with exactly red and blue center pixels; their saved metadata reports versions 1 and 2. Renderer RPCs read the same blue version 2, edit it to green version 3 and read that saved result. The real owner reducer persists both artifact tool steps and their native-screen references.

Feedback observation is fixture-only: at most eight replies of at most 512 KiB each are retained, and the fixed Design executable prints them after successful provider cleanup. No daemon command, live profile capture or new provider constructor is added. The CLI fake verifies the actual response envelope and image block; decoded pixels come from the corresponding native MCP output bytes.

Automatic MCP PNG-to-transcript image persistence remains unsupported here. Claude's image persistence path handles matched successful Read results and requires an owner image store; this fixture does not install that store. The test asserts no image step is invented. The PNG is model tool feedback, while the transcript records ordinary artifact steps. No real Claude account or application UI was used for this evidence.

Scope admission and generation now share one AtomicU64. Closing changes both in one update, so an issuing worker cannot capture a new generation while admission still appears open. A barrier-coordinated 64-cycle test proves guards captured before close and while closed stay revoked after reopen. Skills resolve only inside a dedicated empty private bundled-skills directory. The production Node content scenario forgets and reopens its Project, verifies the old fake PID is reaped and the replacement PID differs, then observes a successful second MCP artifact revision.

Queued-turn timing uses a private release-file handshake, not a fixed delay. The fake blocks turn 1 until the production Node client observes the queued message in Project state and releases that fixture barrier. The fake separately asserts the exact native text of turn 1 and turn 2, so re-sending the first prompt cannot pass.

The saturated-answer Stop test holds eight accepted callback receipts, queues eight more answers and refuses the seventeenth. The native fake confirms receipt of all eight replies plus Interrupt. Stop admission remains nonblocking; process cleanup emits exactly one terminal, settles entered receipts as Uncertain and queued receipts as Failed exactly once, and reaps the fake PID. This proves callback delivery uncertainty is retained even when the process has stopped.

Native content write permission is now covered through the production Node client: a can_use_tool request names mcp__milagre__artifact_show, the fake checks the exact Allow or Deny control response, and only Allow issues the MCP call. Renderer reads find one revision after Allow and no artifact after Deny. Separately, a read-only content grant refuses a direct artifact_show call without relying on the CLI permission gate; a different admitted writer remains usable afterward. These are isolated fake protocol tests, not proof that a live provider always requests permission before calling MCP.

Each native slot now owns a revocable content lease created before its worker starts. close_chat revokes that lease and its MCP registration synchronously before detaching the slot; shutdown and worker teardown revoke it too. A late attach cannot revive the closed lease. Each dispatcher write guard checks the lease as well as the existing Project generation, and a replacement slot receives a new lease over the same ContentOwner. Weak capture avoids retaining the lease through its own registration callback.

The slow-write regression pauses artifact_show before its commit checks, closes the old slot without forgetting the Project, admits a replacement, and releases the old call. The revoked operation fails its remaining guard; the replacement writes exactly version 1, with one content writer and no replay. A retained MCP registration cannot attach after revocation. This does not retract a mutation already past its final authority check: such a lost response remains potentially committed and uncertain. The runtime cannot promise a universal zero-write-after-close boundary without a stronger content-store commit lease.

The per-session registration mutex is recovered after poison. Both ordinary revocation and refused installation remove/reject the handle under that mutex, then invoke registration revocation outside the critical section. An injected-poison test retains the actual registration and verifies revocation, later attach refusal and safe lease teardown.

## Ordinary launch and TLDR restart

> **Unverified on a real CLI:** SDK 0.3.288 sends the appended instructions inside `initialize`; Rust sends the same bytes through a private `--append-system-prompt-file`. Every check here uses the fake CLI, so whether a real Claude Code CLI treats the two identically is still open and blocks treating this as production-equivalent.

Every fixture session now gets Node's ordinary Chat launch. `src/instructions.rs` ports `milagreInstructions`, `hostNetworkInstructions`, the SubagentStart sections, SessionManager's workspace/host composition, `bundledWritingInstructions`, `personaAgent`/`bundledAgents` and `promptSuggestionsEnabled`. Its inputs are explicit: a synthetic bundled-skills path string, TLDR text, QA rules/personas and host `{name, addresses}` taken from the recorded Node trace; nothing is read from the install, environment or network. Only absolute normalized POSIX skill paths are accepted. Owner-encoded strings with an unpaired surrogate are refused (`decode_exact`), never replaced; a real U+10FFFE stays exact. The prompt-suggestion setting is read only from the private profile's `home/settings.json` with the lossless JS JSON parser. Advisor and execution-advisor prompts are not ported and stay refused.

`milagre_claude::ordinary::OrdinaryLaunch` installs the appended instructions (private `--append-system-prompt-file`), Node's `settingSources` `user,project,local`, QA agents and SubagentStart context (design section only when the attached manifest has `design_show`) and prompt suggestions. The session keeps adding the TODO-tools env flag, `{fastMode, ultracode}` settings file, effort, skip-permissions, partial messages, subagent text, PreToolUse hook, summarized thinking and reply style in Node's order. The fixture still adds `--no-session-persistence` and `--strict-mcp-config` as isolation-only restrictions that Node does not pass. SDK 0.3.288 sends the appended prompt in `initialize`; Rust sends the same bytes by file. A real CLI has not verified that equivalence.

SessionManager fixes instructions per session. When a foreground-idle Chat's `tldrEnabled` changes, `start_turn` detaches that slot exactly like `close_chat` (content lease revoked, worker reaps on its own) and starts a fresh session resuming the old native id. A request naming a different resume id is refused before anything is closed. A running turn is never restarted; steering stays refused. The detached worker reports `Exited` only for its own last turn, which the owner ignores for the newer turn. Scope limit: Node's `currentEntry` also keeps the existing session (no restart) while it has active subagent children or background tasks (`busyWithoutTurn`, `backgroundCount`), and refuses a provider/folder switch with background work. This fixture does not track children or background tasks for that decision: the TLDR restart is tested only for foreground-idle sessions with no background work, and a session with background work would be restarted here where Node would keep it.

### Regenerating and checking the Node oracles

```
NODE_PATH=<checkout>/node_modules node experiments/rust-runtime/fixtures/instructions-node.cjs --check
NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-session.cjs --check
```

`--check` rebuilds fresh output from the actual Node sources, writes nothing, and fails on any difference from the committed JSON in structure, values or key order (formatting is ignored, so the formatter-laid-out legacy `claude-session.json` is left as committed). The informational `node` version field is excluded and both values are printed. Each run asserts its fixed `/tmp/milagre-*-oracle` root is removed. Without `--check` the scripts rewrite the files.

### Evidence

- `tests/instructions_node.rs`: 81 instruction texts across three synthetic bundles (real TLDR/personas, BOM/U+3000/U+0085/CRLF edges, empty), five hosts and three workspace values match `fixtures/instructions-node.cjs` (actual `events.cjs`, unchanged `bundled-skills.cjs` compiled over the synthetic directory, actual `SessionManager.currentEntry`) byte for byte, plus agents, four persona refusals and 40 prompt-suggestion cases. Four source mutants (TLDR-off text, JS trim, shared-Link section, env check) fail it.
- `rust-claude/tests/ordinary.rs`: the actual Node SessionManager/ClaudeSession three-turn trace replayed through the Rust session. The fake child asserts argv, TODO env flag, 0600/0700 private prompt and settings bytes, `initialize` agents/hooks/suggestions/subagent text, both hook answers, `set_max_thinking_tokens` summarized before the Concise style, Normal's `outputStyle: null`, and no style call after the restart. Changed prompt byte, settings, env flag and control order each fail inside the child.
- `tests/claude_bridge.rs`: Ordinary scenario turn 1 (defaults), turn 2 (Normal, same PID), refused foreign resume, turn 3 (TLDR off: new PID with `--resume=fixture-session`, old PID reaped, old `Exited { turn 2 }` after `Started { turn 3 }`, one terminal per turn, no failure); typed fast/ultracode/effort/TLDR admission with instructions absent from argv; 12 mistyped/unsupported refusals.
- `tests/claude-compat.cjs` `ordinary`: production Node client sends the desktop composer's `agentRuns.send` shape (images/files empty, effort, `ultracode`/`fastMode` false, `replies`, `tldrEnabled`). It observes three completed turns matching Node's event sequence, the same PID for turns 1-2, a new PID with resume for turn 3, its reaping (it also logs whether the old process was still exiting when turn 3 completed: true in the recorded run, not asserted), no `turn-failed` after the late Exited, and the saved prompts/replies.

Remaining after the ordinary checkpoint: broader workspace authority and real-provider validation, images, advisor/execution roles, account `CLAUDE_CONFIG_DIR` routing, user MCP extras/off toggles, linked host tools beyond the content scope, shared-Link scope instructions and real install/host discovery. The isolated Auto/Full increment is described below.

## Auto/Full and Project workspace access

Root acceptance after callback fixes: 151 Claude tests pass (one live test ignored),
69 default runtime tests and all thirteen production Node-client fixture scenarios pass.
The eleven lifecycle tests include eight entered callbacks plus one queued request at
withdrawal, close, Drop and turn end. Strict Clippy/fmt and all-feature/all-target runtime
compilation pass. Both non-writing recorders match fresh Node output, including the
three-mode trace and 61 workspace cases. Independent source rereview closes all prior
P2 findings with no remaining P1/P2 in this scope. Root used no external test-process
signals or timeout cleanup. Earlier author pattern-kill runs are not the acceptance
evidence; their cross-test impact is unknown.

Logs: `/tmp/milagre-claude-access-root-final-{tests,clippy,fmt}.log`,
`/tmp/milagre-runtime-access-root-final-{tests,allfeatures,clippy,fmt,build,node}.log`,
`/tmp/milagre-access-root-final-{instructions,session}.log`.

> **No workspace confinement.** Full launches Claude Code with `bypassPermissions` and uses the allow fallback after guard and access-policy decisions; nothing in Rust confines what the CLI then does. Auto is Claude Code's own `acceptEdits` rule. The access check below decides only whether a request skips Milagre's card; resolving symlinks there is not a sandbox. All evidence uses the fake CLI.

Admitted: `permissionMode` `ask`, `auto`, `full` (absent or null is Ask). For an ungated start (no eligibility check, as every fixture start), the session follows Node's `beginTurn`: the mode is the session's at once, a new CLI launches in it (`--permission-mode bypassPermissions` for Full), and a running CLI switches right after `set_model`, before effort/ultracode, fast mode and reply style. A gated start (`can_start` set) keeps the existing stricter rule: the mode applies only after the eligibility recheck, so an obsolete turn never raises it. That ordering differs from Node and is not used by this fixture.

`milagre_claude::ordinary::ProjectAccess` ports `WorkspaceAccess` for a Project Chat (no Link roots, no read-only roots): a Read/Grep/Glob inside the explicitly supplied bundled-skills directory is allowed without a card in every mode, using Node's `insideWorkspace` (lexical `path.resolve(cwd, file)`, realpath, a missing or dangling tail joined to its resolved parent, any other error refusing). `file_path: null` falls through to `path` as `??` does. The check runs on the blocking pool outside the session lock under one of eight session permits, held by the blocking work itself until it ends. A check is admitted only at actual policy entry (after the permit wait and blocking-pool queueing), under an admission gate serialized against `close` and drop: only while the session still exists and is open, its turn is the one it was asked in, and it was not withdrawn. Stop first marks session state closed, which the entry check observes. After child cleanup, `close` shuts the gate and semaphore and waits for admitted callbacks; final Inner drop also shuts them. A queued check cannot enter after revocation, including when a close future is dropped. Close returning proves admitted policies have left, not that all client handler tasks have finished their reply bookkeeping. Its result counts only for the turn it was asked in (turn epoch; otherwise the request gets the cancelled denial and no card). A Deny always stands, whatever mode the user switched to. Any mode change since the check, including Ask -> Full -> Ask (mode epoch), re-evaluates it under the new mode, at most three times, then refuses. A panic or lost check refuses in every mode, Full included. The client now counts running handlers, withdrawn ones included, against `max_inbound_requests`, so a withdrawn request frees its slot only when its handler actually ends. The fixture supplies the instructions' own synthetic skills path, which does not exist, so as in Node it grants nothing there; the allowance itself is proven over real temporary directories.

### Evidence

- `rust-claude/tests/modes.rs`: actual Node SessionManager/ClaudeSession trace (`claude-modes.json`, `generate-session.cjs`): Full first turn, Auto with a new effort, Ask, one process. The fake child asserts launch mode/flags, `set_permission_mode` before the effort change, Ask's switch back to `default`, and each Bash `can_use_tool` answer (Full allow without a card, Auto allow and Ask deny through the card); cards and resolutions equal Node's. 61 `WorkspaceAccess.answer` cases over the same real layout (symlinks into and out of the skills directory, dangling link, `..`, ENOTDIR, NUL, missing skills root, every kind and mode) match. A handler test shows a skills Read and a `file_path: null` Grep skip the card in Ask while an outside Read asks.
- Mutants (`/tmp/milagre-claude-modes-mutants.log`): root-itself allowed, any kind allowed, never allowing, old mode order, launching in the previous mode and dropping `??` all fail. Turning any access decision into Allow survives because `ProjectAccess` never denies; it is equivalent for this port.
- `rust-claude/tests/access_lifecycle.rs` (gated test policy, file barriers, no timing races; passed 25 consecutive runs): turn rollover (cancelled, no card in the next turn), Deny then switch to Full (Deny stands), Ask -> Full -> Ask (re-evaluated, Ask card), upgrade Ask -> Auto and downgrade Full -> Ask (re-evaluated), two withdrawn blocked checks still refusing a third request with two slots and a slot reused only after both finish, close blocked until the check finishes (process already reaped, answer discarded), and a panicking policy refusing in Full. Four more hold eight checks inside the policy with a ninth (r9, sent only after the eight entered) waiting for a permit, then withdraw it, close, drop the session or end its turn before releasing the eight: the ninth never enters, and close returns once the eight drain. Restoring unconditional entry fails all four cleanly (`/tmp/milagre-claude-access-p2b-mutants.log`). Each reintroduced original defect fails its test (`/tmp/milagre-claude-access-p2-mutants.log`).
- `tests/claude_bridge.rs`: the Modes scenario through the owner Provider contract (same PID, two accepted answers, Node cards, Full argv), plus revocation: a pending Auto card's session is closed, a late answer is refused before enqueue, the card resolves `cancelled`, the turn is cancelled, Exited follows and the process is reaped.
- `tests/claude-compat.cjs` `modes`: production Node client sends Full, Auto and Ask in the composer shape, answers the two cards with `agent:respond-permission`, sees three completed turns, Node's card sequence, one native PID with `bypassPermissions` argv, and the owner's saved `permissionMode`.

### Remaining gates

- Direct mid-turn mode changes are covered by the Live permission changes section above. Mode changes carried by steering remain unreachable here. The Rust session's own Auto card resolution uses a canonical, `..`-refusing check where Node's `insideRoot` is lexical (stricter, unchanged).
- Shared-Link and Worktree roots: read-only main checkouts (deny edits with the Worktree message), Link roots, late-root learning and `addDirectories` grants need registry authority the fixture lacks; such Chats stay refused.
- Real CLI behavior of `acceptEdits`/`bypassPermissions`, images, roles, account routing, user MCP extras and background-aware retention remain open.
