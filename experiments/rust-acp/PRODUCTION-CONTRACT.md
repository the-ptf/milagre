# ACP production launch contract proposal

Status: inventory and proposal only. No production session constructor, account authority, runtime
adapter or launch permission is implemented by this document. Scope is `experiments/rust-acp`.
The parent reports native receipt integration at `69f13ed0` and runtime fixture `63d0f96b`; that
proves fixed-child prompt consumption, not production launch or Restore instruction interpretation.
This worktree's repository-owned Node sources were reviewed; no account/profile/install was read
and no vendor process was started. Owner components may already implement parts of this contract;
the missing work here is their explicit binding to ACP, not a claim they are absent elsewhere.

Removing Node means removing Milagre's Node orchestration from the shipped provider path. Vendor
executables/harnesses remain external programs; it does not mean rewriting their proprietary code
or eliminating their own runtime dependencies. Node conformance recorders can remain development
checks. The fake receipt inspector and barrier must never become production APIs.

## Source authority and missing bindings

| Area                        | Repository authority                                                                                                                                                                                                  | What this crate still needs                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kiro executable/account     | [kiro-acp.cjs](../../packages/core/src/agents/kiro-acp.cjs), [kiro-account.cjs](../../packages/core/src/kiro-account.cjs), [accounts.cjs](../../packages/core/src/accounts.cjs)                                       | Resolve and validate `kiro-cli-chat`, including explicit override, launcher realpath/directory and macOS fallback; bind the connected CLI identity. Kiro uses the default connected account; adding a named Kiro profile is refused by Node. `whoami` and terminal login remain separate account operations. |
| Antigravity install/account | [antigravity-install.cjs](../../packages/core/src/agents/antigravity-install.cjs), [antigravity-account.cjs](../../packages/core/src/antigravity-account.cjs), [accounts.cjs](../../packages/core/src/accounts.cjs)   | Verified pinned agent/harness pair; account-specific `GEMINI_HOME`, private file token storage, explicit shared-history/skill links, owned scratch lifetime and account readiness. The existing environment shaper does not verify any of these facts.                                                       |
| Session behavior            | [acp-session.cjs](../../packages/core/src/agents/acp-session.cjs)                                                                                                                                                     | Production startup, instructions/images, model/effort/mode ordering, permission/question cards, policy and MCP retry constraints. Raw client RPC calls and fake Ask behavior do not implement those contracts.                                                                                               |
| Process and child lifetime  | [acp-rpc.cjs](../../packages/core/src/agents/acp-rpc.cjs), [process-tree.cjs](../../packages/core/src/agents/process-tree.cjs), [antigravity-subagents.cjs](../../packages/core/src/agents/antigravity-subagents.cjs) | Detached descendant supervision and Windows Jobs, cleanup receipts and child attribution. Rust currently supervises Unix process groups; Antigravity commands can leave that group. Profile transcript polling requires separate owner-approved read authority.                                              |
| Owner identity and queue    | [session-manager.cjs](../../packages/core/src/agents/session-manager.cjs), [accounts.cjs](../../packages/core/src/accounts.cjs)                                                                                       | Bind the authoritative project/chat/host TurnId, selected account and account generation to each process. Define tick, shutdown and forget semantics with the parent; do not substitute a current-turn lookup or mutable account selection after startup.                                                    |

The public `AcpRpc::spawn(SpawnOptions)` and `AcpClient::connect` are low-level transport APIs.
They already accept a command/environment. They provide no account authorization or policy and
must not be exposed as the future owner-facing provider constructor. `FakeSession::launch` is
separate, accepts only fixed fake scenarios and remains feature-gated.

## Required inputs to a future constructor

Conceptual signature only, not a new trait or callable API:

```text
open(AuthorizedLaunch, TurnContext, HostServices) -> SessionHandle + bounded events
```

`AuthorizedLaunch` must be issued by trusted host services after validation, with private fields
and a lifetime tied to the launch. An arbitrary deserialized request or a public struct literal
must not mint it. A pure launch plan is data to review, not that authority.

| Input                 | Required evidence and ownership                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TurnContext           | Authoritative project/chat/host TurnId, provider, account ID/generation, current project ownership and cancellation generation. The adapter supplies these; provider `_meta` and native session IDs cannot supply them.                                                                                                                                                |
| Executable grant      | Absolute resolved executable and, for Antigravity, matching harness; platform/architecture/version, install identity and verification result. Revalidate identity at launch or pin a suitable handle. Decide trusted PATH/environment and wrappers explicitly. Never interpret a model string, profile file or provider output as executable authority.                |
| Account grant         | An account service lease for the selected scope and generation, readiness state and environment/profile ownership. Credentials remain opaque to events, Debug output, fixtures and UI. Recheck lease validity after awaited preparation and immediately before spawn; stale/removed/switched accounts refuse rather than falling back to the ambient/default identity. |
| Workspace and policy  | Canonical/raw-path checked cwd and roots, immutable role, permissions mode, original command classifier, linked-tool manifest/wake scope and independent MCP dispatch guard. Absence of required guards refuses the requested role, including Full shortcuts; a parser is not a sandbox.                                                                               |
| Resources and history | Owned private scratch/profile handles, explicit history-sharing authorization and saved session identity bound to provider/account/history scope. Cleanup may delete only owned ephemeral artifacts. Forgetting a chat does not revoke tokens or delete a shared profile.                                                                                              |

For Kiro, retain the connected-CLI account model and `acp --agent-engine v3`. A successful `whoami`
probe is a readiness observation, not a permanent lease or permission to switch identities.
Kiro `autopilot=on` in Ask/Auto/Full is a vendor setting; all host guards must still run. A host
permission handler cannot constrain operations the agent executes without asking: require proven
vendor/OS enforcement for the requested role, or refuse that role.

For Antigravity, the account service owns token files and profile creation. Node shares selected
history directories across profiles and links user skill folders intended as read-only inputs;
a symlink alone does not enforce that intent. The Rust binding must preserve explicit sharing
and enforce read-only authority while keeping credentials isolated. `GEMINI_HOME`, forced file storage,
credential/browser environment scrubbing, harness path and private temp paths must come from the
same authorized launch. Pinned archive metadata is not proof that a local install still matches.
Auth-required/subscription errors return typed failures. OAuth/browser opening, installation and
account refresh are separate host workflows, never fallback side effects of `open` or `send`.

## Lifecycle contract to settle before production wiring

| Boundary                      | Required behavior and missing decision                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before spawn                  | Validate account/project/cancellation generations, all required guards, request features and budgets. Refuse unsupported images/instructions/model/effort/MCP requirements explicitly; do not silently omit them. Acquire resource leases only after validation, with bounded cleanup on every startup failure.                                            |
| Initialize and open           | Negotiate version/capabilities before create/resume/load, then apply validated configuration in the vendor-required order. Preserve saved identity on transport errors. Node retries broader server-side resume failures than the fake session; explicitly decide accepted error classes with fixtures. Never turn a timeout into automatic prompt replay. |
| Prompt and output             | One terminal per admitted host TurnId, bounded backpressure and ordered updates before terminal. Carry host identity directly through every Agent/Exited event. Instructions belong at the first prompt of each process; image lifetime/order and context framing need their own fixture contract. Native receipts prove bytes only, not model behavior.   |
| Cancel and permission answers | Answers are session-owned after admission. Dropped observers do not cancel writes. Queued decisions drained before transport are NotSent; attempted writes can be Uncertain. No replay after an uncertain result. Stop cancels owned pending requests and enforces a deadline before tree cleanup.                                                         |
| Shutdown and reuse            | Parent runtime currently uses one process per host TurnId. Preserve that boundary until the parent explicitly approves reuse. A terminal is not proof of a reaped process or all descendants stopped. Release account/scratch/linked-server leases only after bounded cleanup; report cleanup uncertainty without issuing a second turn terminal.          |

The parent must supply the exact signatures/semantics of `tick(now)`, `shutdown(force)` and
`forget(project, force)`; this crate must adapt to them rather than edit owner traits. In
particular, settle whether tick drives deadlines or an internal monotonic clock does, what force
permits to be killed, how incomplete reaping is reported and what a refused forget retains.

ACP has no universal native turn ID. Per-host-turn processes limit cross-turn ambiguity but do
not authorize parent/child attribution. Same-session late messages, replayed load history,
Routine metadata and subagent transcripts require explicit validation. Preserve disabled MCP
servers and immutable policy across the retry ladder; reducing MCP servers cannot relax guards.
The 512 KiB fake frame limit, raw 8 MiB frame limit, 16 MiB parsed-event budget and 65,536-token
cap are separate constraints. Production media and dense payload support need measured fixtures,
not a larger unreviewed limit. The 5 ms actor timer and whole-state accounting remain performance
work, not correctness evidence for runtime wiring.

## Pure launch planning checkpoint

Implemented as the opt-in `launch-planning` feature, documented in [LAUNCH-PLANNING.md](LAUNCH-PLANNING.md).
The scope agreed below remains the boundary: synthetic observations only, with no authority or
spawn connection. The host binding and production gate at the end remain outstanding.

Implement only inside this crate, with no real launcher, account lookup or filesystem authority:

1. Add a pure `plan_vendor_launch` module behind an opt-in experimental feature. Inputs are typed
   vendor/platform plus **synthetic observations** of install candidates, account scope/generation,
   explicit environment and resource paths, requested policy and required capabilities. Output is
   a bounded plan or typed refusal. Names are provisional; this module must not accept credentials
   or issue `AuthorizedLaunch`. Plans cannot be passed directly to a production session constructor.
2. Record actual Node helper behavior for Kiro candidate precedence, fixed args, Antigravity
   environment scrubbing/platform args, model/effort selection and login/subscription classification.
   Stub only filesystem/host probes and shared catalog dependencies; hash source inputs and state
   deviations explicitly. Never import or copy the vendor binaries/SDK implementation.
3. Test missing/wrong-generation account observations, Kiro non-default account refusal, absent
   harness, unsupported platform, conflicting environment keys, disabled MCP preservation and
   required-but-unimplemented policy. Verify no secret-bearing values enter Debug output. A fake
   installation observation is fixture data, never sufficient evidence for real execution.
4. Keep the planner disconnected from `FakeSession`, raw spawn and owner/runtime constructors.
   Validate with offline unit/Node fixture tests, default and feature clippy, and current ACP
   regressions. The deliverable is reviewable planning behavior and a list of host evidence still
   required, not enabled accounts, login, downloads, profiles or live turns.

Acceptance gate after that checkpoint: parent and account/process owners agree on how real leases,
install identity, workspace authority, process-tree cleanup and immutable guards supply the
constructor inputs. Then implement one bounded host binding at a time with fake executables and
synthetic directories. Enabling production launch is a later, explicit integration decision.
