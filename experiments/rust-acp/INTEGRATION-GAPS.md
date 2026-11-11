# ACP integration inventory

Source review: 2026-11-11. This crate implements process/protocol transport only. Codex runtime
bridge ownership stays with its existing agent. No owner/runtime/provider crate was edited.
No proprietary SDK implementation was copied; only repository-owned Node and Rust code was used.

## Session and event checkpoint still required

Node [acp-session.cjs](../../packages/core/src/agents/acp-session.cjs) owns lazy startup, session
identity, prompt queueing, instruction injection, resume/load fallback, history suppression,
model/effort/mode selection, pending permission/question lifetimes, turn terminal events, restart
and throwaway-session deletion. The new Rust client supplies explicit wire calls only. Loaded
history is forwarded raw, not suppressed. Native session IDs are not owner logical `TurnId`s.

Port [acp-events.cjs](../../packages/core/src/agents/acp-events.cjs) separately: text/thinking,
tool-call merging and failure details, edits, plans, token usage, model/config options, context
resets, tool images, refusal annotations and provider-specific schemas. Preserve unknown updates
at the protocol boundary. Current Node traces verify raw data; they do not claim Milagre event
parity or a complete session state machine.

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

Port permission extraction/question mapping and merge tool-call state before decisions. Require
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

1. Port pure `acp-events.cjs` mapping with Node state-in/events-out fixtures.
2. Build a fake-only session state machine for load replay, prompt queueing and cancellation,
   with explicit immutable policy inputs and fail-closed unsupported roles.
3. Finish vendor process-tree/profile isolation and host guard contracts before proposing any
   real provider or owner-runtime integration.
