# Codex owner integration gaps

Inventory checked against this Worktree's Node provider and Rust adapter on 2026-11-10.
These are outstanding contracts and proposed task boundaries, not implemented features.
No owner files were changed. The event replay fixtures cover mapper behavior, not the missing
host services or guard enforcement below.

## 1. Policy and turn guards: implement before constrained runs

Present: `codex_policy` emits Ask/Auto/Full, guarded Full and read-only sandbox shapes;
`analysis_only` rejects approval requests and dismisses questions. Ordinary permission cards,
mode switches, cancellation and canonical workspace checks are implemented.

Missing: babysit command refusal and refusal details; remote-write classification for
`allowForChat`; escalation request allowlists, tool-call budgets and interruption; execution
advisor restrictions; `WorkspaceAccess` read-only roots and dynamically acquired roots;
`canStart` immediately before the actual turn start.

The distinction matters: `guarded` and `read_only` currently affect the supplied Codex policy
only. The session has no corresponding turn guard, and Full can still auto-answer server
requests. The ungated Milagre MCP shortcut also has no escalation check. Passing
`analysis_only = true` does not install a read-only sandbox, disable inherited MCP servers or
execution features, validate host tools as read-only, or clear environments. Those controls
must be established before `thread/start` and `turn/start`; denial of later approval requests
cannot replace them.

Proposed boundary: owner supplies trusted turn purpose, guard inputs, authorized wake request
IDs, tool metadata, current writable/read-only roots and instruction context. Adapter enforces
guards before shortcuts, automatic answers, permission cards and mode-switch resolution;
guards persist across steering until the owning turn ends. Host MCP dispatch must independently
enforce the same wake restrictions. Neither guard data nor broad JSON `extra` maps should be
accepted from an untrusted caller as authorization.

Acceptance checks: guarded Full remote writes stay denied; `allow-for-chat` cannot persist a
remote-write permission; escalation rejects unapproved `chat_respond` targets even though the
tool is normally ungated; tool budget stops the turn; mode switches and steering do not lift
guards; read-only main checkouts cannot become writable through Full; advisor config discovery
failure stops startup. Test `canStart` after delayed startup and before a turn reaches Codex.

Sources: [Rust session](src/codex/session.rs), [Rust policy](src/codex/protocol.rs),
[Node provider](../../packages/core/src/agents/codex-provider.cjs),
[workspace access](../../packages/core/src/agents/permissions.cjs),
[babysit guard](../../packages/core/src/babysit-guard.cjs),
[escalation guard](../../packages/core/src/escalation-guard.cjs),
[advisor policy](../../packages/core/src/agents/advisor-policy.cjs).

## 2. MCP bootstrap, instructions and config fallback

Present: caller-supplied `ThreadSettings.config`, `developer_instructions` and top-level extras;
base question-tool features; `CodexClient::read_config`; thread start/resume without a timeout;
resume/unarchive retry; MCP approval translation and the ungated Milagre tool list.

Missing: linked MCP endpoint startup and availability reporting; Everywhere server definitions
and per-account disabled entries; config merge and fallback; advisor inherited-config discovery;
execution advisor feature overrides; assembly of normal, analysis and execution instructions.
`CodexSession::start` opens the thread internally, so a complete constrained bootstrap needs a
pre-thread configuration stage, not a config read after the session has started.

Proposed boundary: owner owns linked endpoint lifetime, account-specific MCP settings and the
instruction inputs. Adapter consumes a resolved configuration plan, or a trusted bootstrap
callback, and applies it before opening the thread. Preserve stdio command/args/env and HTTP
headers without exposing credentials in diagnostics. Report whether linked tools survived a
fallback to the owner.

Node's ordinary-session fallback order is: full config; remove Everywhere servers; linked
Milagre only; no MCP servers; no config. Deduplicate identical attempts and retry only on server
RPC errors, never on transport failure or timeout. Analysis and execution advisors never use
this fallback. Review disabled-server handling explicitly: Node keeps off entries in the first
reduction but drops them in later stages, which may re-enable inherited tools. Do not silently
copy that downgrade into a stricter owner contract.

Acceptance checks: linked availability follows the successful attempt; extras read failure is
reported once; HTTP/stdio definitions and account-off entries map correctly; duplicate stages
are skipped; transport failures retain saved thread IDs; constrained config cannot downgrade;
session instructions reflect the selected turn/session role.

Sources: [Rust bootstrap](src/codex/session.rs), [Rust client](src/codex/client.rs),
[Node bootstrap and retry ladder](../../packages/core/src/agents/codex-provider.cjs),
[MCP extras](../../packages/core/src/mcp/extras.cjs),
[MCP definitions](../../packages/core/src/mcp/definitions.cjs),
[instruction assembly](../../packages/core/src/agents/events.cjs).

## 3. Images: bounded host storage and lifecycle

Present: `local_image_input`, caller-supplied turn input blocks, `prompt_input` for one text block
followed by image paths, and mapper image steps when Codex supplies a usable `savedPath`.

Missing: attachment decoding and private temporary files; inline text/image ordering; cleanup
across start, steer, cancellation, failure and close; generated image base64 persistence;
MCP/dynamic-tool image extraction and extra image steps. A generated image can currently finish
without a displayable file when only `result` base64 is returned.

Proposed boundary: owner supplies validated attachment bytes or a media-store service. Adapter
owns references for each turn and all steered messages until that turn finishes, and transforms
provider image results through the store before publishing image events. Persistent output
files belong to the host's media retention policy, not turn-input cleanup. Apply bounded decode,
MIME/signature validation and private writes; the transport frame cap is not an image-storage
budget. Keep base64 out of persisted transcripts.

Match `promptImageBlocks` reading order, including repeated references and unreferenced images.
Only accepted current-thread/turn completions should produce tool image steps. Suppress internal
Milagre `design_show`, `design_apply` and `html_preview` renders, including nested calls with
preserved MCP provenance. Unsupported media must not discard the tool's text result. Decide how
generated-image validation should differ from Node's less strict base64 writer.

Acceptance checks: repeated/inline image positions; 0600 input files and terminal-path cleanup;
steered inputs survive until their turn ends; malformed, oversized and unsupported payloads;
stale/foreign completions; internal-render suppression; generated images with and without an
existing saved path; failed writes preserve text and terminal events.

Sources: [Rust input construction](src/codex/session.rs), [Rust image steps](src/codex/steps.rs),
[Node image lifecycle](../../packages/core/src/agents/codex-provider.cjs),
[attachment validation](../../packages/core/src/image-input.cjs),
[tool image storage](../../packages/core/src/agents/tool-image.cjs),
[inline image ordering](../../packages/shared/src/prompt-parts.mjs).

## Suggested next task

Implement policy guards and constrained bootstrap first, with fake-server tests and explicit
owner inputs. Then add ordinary MCP bootstrap/fallback, then media storage and image lifecycle.
Existing owner-facing settings permit plumbing, but they do not certify constrained runs as
safe. Windows Job-object tree termination and command shims remain separate integration gaps;
the cwd/root tests in this follow-up were executed on macOS only.
