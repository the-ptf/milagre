# Codex owner integration gaps

Inventory checked against this Worktree's Node provider and Rust adapter on 2026-11-10.
These are outstanding contracts and proposed task boundaries, not implemented features.
No owner files were changed. The event replay fixtures cover mapper behavior, not the missing
host services or guard enforcement below.

## 1. Policy checkpoint implemented; host integration required

See [POLICY-CONTRACT.md](POLICY-CONTRACT.md) for the implemented session roles, trusted owner
inputs, stricter compatibility choices and tests. The adapter now enforces immutable Analysis,
Babysit and Escalation roles across Full mode and steering, installs constrained startup config,
and refuses unsupported execution-advisor/custom policy inputs. Babysit requires an owner
`CommandClassifier`; it does not contain a production Rust shell parser. Host MCP dispatch must
independently enforce read-only tools and exact wake targets.

Still missing: per-turn role transitions within an existing session, `WorkspaceAccess` read-only
and dynamically acquired roots, `canStart` after host preparation, execution advisors and full
instruction assembly. Use a separate session for a constrained Run/wake. Do not wire unsupported
roles as ordinary sessions. Babysit MCP writes are explicitly unsupported.

## 2. MCP retry implemented; discovery and endpoint ownership remain

Ordinary start/resume now use deduplicated config fallback and report linked-tool availability.
Disabled server entries survive every attempt, and their presence forbids bare-config fallback.
Constrained startup discovers inherited configuration, disables external servers and never
reduces configuration on errors. Discovery failure is fatal. This intentionally closes Node's
later-stage disabled-server downgrade.

The owner still supplies account-specific Everywhere server definitions, off entries, endpoint
lifetime and instructions. The adapter accepts a resolved ordinary `ThreadSettings.config` plus
`SessionOptions.everywhere_servers`; constrained linked endpoints require validated tool
metadata. See the [policy contract](POLICY-CONTRACT.md) before enabling any constrained session.

Sources: [Rust guards](src/codex/guard.rs), [Rust session](src/codex/session.rs),
[Node provider](../../packages/core/src/agents/codex-provider.cjs),
[Node advisor restrictions](../../packages/core/src/agents/advisor-policy.cjs),
[MCP extras](../../packages/core/src/mcp/extras.cjs),
[MCP definitions](../../packages/core/src/mcp/definitions.cjs).

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

Agree on the owner `CommandClassifier` and host MCP guard service using the policy contract,
then integrate extras discovery and linked endpoint lifetime. Execution advisors and dynamic
workspace access need another bounded policy checkpoint. Media storage/image lifecycle can
proceed independently. Windows Job-object tree termination and command shims remain separate
gaps. Current validation is fake-server/fixture testing on macOS, without live provider turns.
