# ACP integration inventory

Source review: 2026-11-11. This crate implements process/protocol transport, pure event mapping and an opt-in fake-only lifecycle. Codex runtime
bridge ownership stays with its existing agent. No owner/runtime/provider crate was edited.
No proprietary SDK implementation was copied; only repository-owned Node and Rust code was used.

## Fake lifecycle implemented; real session integration still blocked

Node [acp-session.cjs](../../packages/core/src/agents/acp-session.cjs) owns lazy startup, session
identity, prompt queueing, instruction injection, resume/load fallback, history suppression,
model/effort/mode selection, pending permission/question lifetimes, turn terminal events, restart
and throwaway-session deletion. The raw Rust client supplies explicit wire calls only. Its loaded
history remains raw. The opt-in fake session suppresses replay through an ordered response boundary. Native session IDs are not owner logical `TurnId`s.

The pure [acp-events.cjs](../../packages/core/src/agents/acp-events.cjs) mapper is now ported in
`events`: text/thinking, ordered tool-call merging, edits/approval diff reuse, plans, usage,
model/config updates, Kiro credits, heartbeat references and stop reasons. It has 921 deterministic
Node parity traces plus three explicit surrogate-boundary deviation fixtures. The recorder calls
actual Node functions and checks source hashes. See README for schema/Unicode/POSIX boundaries.

The fake session now handles bounded turn admission/settlement, replay suppression, session ID
filtering, raw permission lifecycle, deadlines and process exit. Subagent routing, tool images,
refusal overlays and attribution of untagged same-session late updates remain gaps. A pure
`stop_reason_event` is not owner terminal attribution. The mapper retains tool metadata and raw
call inputs; owner policy must consume the original request, not presentation/redacted output.
The pure mapper remains caller-owned. The fake session enforces retained call/diff/thinking
budgets, accounts for indexes and clears turn state. These bounds are not yet owner runtime wiring.
See [SESSION-CONTRACT.md](SESSION-CONTRACT.md) for the proposed API and integration decisions.

Owner adapters must bind every Agent/Exited event to a logical `TurnId` before consuming updates,
respect `tick(now)`, `shutdown(force)` and `forget(project, force)`, and coordinate prompt/cancel
boundaries. ACP updates do not provide a universal turn ID; stale/replayed/native-session updates
need explicit filtering. Do not attach these raw events to whichever owner turn happens to be
current. No new owner traits are proposed by this checkpoint.

## Kiro bootstrap and policy

[kiro-acp.cjs](../../packages/core/src/agents/kiro-acp.cjs) finds `kiro-cli-chat` from the override,
launcher's real path, launcher directory and macOS app fallback. Rust ports only the explicit
`acp --agent-engine v3` arguments. Executable discovery and validation remain host work.
[kiro-account.cjs](../../packages/core/src/kiro-account.cjs) uses a `whoami` probe and terminal
`kiro-cli login`; neither is implemented or executed here.

Kiro's `autopilot` config remains `on` in Ask/Auto/Full; its `mode` selects an agent (Default/Spec/
Plan), not Milagre approval policy. Model IDs, offered efforts and `effortLevel` defaults require
a catalog/config port. Throwaway session deletion and useful crash/login diagnostics are gaps.
The Node Auto command-risk filter and actual permission guards must precede any mode shortcut.
A raw config setter is not a policy implementation.

## Antigravity bootstrap and cleanup

[antigravity-acp.cjs](../../packages/core/src/agents/antigravity-acp.cjs) and
[antigravity-install.cjs](../../packages/core/src/agents/antigravity-install.cjs) are the authority.
Rust ports the ambient credential/environment scrub, explicit GEMINI_HOME restoration, file token
storage, unbuffered output, private-temp variable shaping and Linux `--uid=` argument. Harness
and scratch paths must be supplied explicitly; no install or adjacent-file guessing is performed.

Still missing: pinned archive/hash verification, native binary/harness resolution, private profile
and scratch directory creation/ACLs, ownership-aware stale scratch sweeping, settings/token-store
lifetime and account isolation. Sign-in is a separate host flow: authenticate `oauth-personal`,
validate the emitted URL before browser opening, cancellation and cleanup. The Rust authenticate
method only carries the wire request. No browser/account/profile work was performed here.

Modes map Ask/Auto/Full to `default`/`auto_edit`/`yolo`. Family/effort resolution from offered models,
login-versus-subscription classification, crash prefix handling and profile-backed subagent
transcript polling remain gaps. Native harness commands can leave the agent's process group;
port Node `killTree({descendants:true})` or an equivalent supervised process-tree strategy before
real use. Windows Job objects and command-wrapper safety are missing for both vendors.

## Guard and MCP boundary is not implemented

There are no runtime roles, Auto workspace answers, read-only guarantees, babysit/advisor/escalation
guards, persistent approval policy, command-risk parser or linked-tool dispatcher in this crate.
Do not enable constrained roles by assigning a provider mode. Do not treat Kiro autopilot or
Antigravity Auto mode as isolation. The parent classifier's existence proves none of these
execution preconditions or dispatch checks.

The fake session merges tool-call context and requires explicit once-only answers. Port permission
card/question UI mapping and host policy before real decisions. Require
raw/canonical path checks, exact host manifest and wake scope, command classification before Full
mode and shortcut answers, and independent MCP dispatch enforcement. Once-only remote writes
must never select `allow_always` when the provider omits an `allow_once` option.

Node session creation retries without Everywhere servers, then without linked tools; resume may
fall back to load. The Rust client deliberately retries nothing. A future layer must distinguish
server rejection from transport errors/login/subscription failures, preserve disabled servers
and policy constraints across attempts, report lost linked tools and suppress load replay.
Model/mode config failures cannot silently retain a more permissive mode in a constrained turn.
MCP discovery, endpoint ownership, linked-tool lifetime, host file I/O/media stores and session
instructions all remain owner or later-checkpoint responsibilities.

## Next bounded work

1. Review `SESSION-CONTRACT.md` with parent/owner10960: owner TurnId, tick/shutdown/forget,
   event backpressure, permission lifecycle and same-session late-update attribution.
2. Finish vendor process-tree/profile isolation and host guard contracts before proposing any
   real provider or owner-runtime integration.

## Transport compatibility and watchdog gaps

The 65,536-token parser cap is intentionally stricter than Node. Dense valid updates or large
inline media may exceed it even below the 8 MiB frame cap. Validate real vendor payload shapes
before adjusting the cap; retain the parsed-allocation queue budget and dense-frame regression.
The raw RPC/client still have only request timeouts and cancellation grace. The fake lifecycle
adds startup, absolute turn, idle progress, permission-age and cleanup deadlines. The owner must
choose production watchdog policy and integrate its clock/turn attribution before runtime use.

Server methods default to unowned and receive `-32601`. A future permission/question/filesystem/
terminal dispatcher must explicitly claim methods it implements. Claimed requests have count
bounds at the raw layer. The fake session adds answer-age deadlines and closed-request cleanup;
real host dispatch and policy remain owner integration gaps. Permission
reply cancellation or failure has uncertain delivery: even process kill cannot prove a completed
reply was not delivered or a tool did not run. No automatic retry or definitive non-execution claim.

Provider `_meta` and mapper Routine/heartbeat references remain untrusted display data. The owner
must validate identity/ownership before associating records; these fields never authorize actions.
Raw transport's 8 MiB frame ceiling and 16 MiB parsed-event budget are independent. Near-ceiling
inline images exceed the latter because raw+params are both retained. The fake session caps frames
at 512 KiB and accepts text-only input; real image transport still needs a compatible limit/copy
design. Unowned methods now emit a bounded rejection diagnostic as well as a queued `-32601`.
