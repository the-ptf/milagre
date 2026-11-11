# Codex owner integration gaps

Inventory checked against this Worktree's Node provider and Rust adapter on 2026-11-11.
Implemented checkpoints and outstanding owner contracts are separated below.
No owner files were changed. The event replay fixtures cover mapper behavior, not the missing
host services or owner dispatch enforcement below.

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

Implemented: validated private input files, Node inline ordering, turn/steer retention and
terminal cleanup; opt-in generated/MCP/dynamic output persistence, accepted-turn filtering,
internal-render suppression and bounded worker/budget handling. See [IMAGE-CONTRACT.md](IMAGE-CONTRACT.md)
for the Claude-compatible `ToolImageStore` signature, owner-controlled paths, limits, lifetime
rules, deliberate Node deviations and fixture evidence.

Remaining owner work: implement one host media-store wrapper for both provider traits; choose
private absolute scratch/output directories; wire attachments before sending; authorize serving
paths; manage output retention/orphans; render unavailable media. Raw notifications may contain
base64 and must not become persisted transcript events. MCP host media lifecycle and path access
controls remain owner responsibilities.

Sources: [Rust input construction](src/codex/session.rs), [Rust image steps](src/codex/steps.rs),
[Node image lifecycle](../../packages/core/src/agents/codex-provider.cjs),
[attachment validation](../../packages/core/src/image-input.cjs),
[tool image storage](../../packages/core/src/agents/tool-image.cjs),
[inline image ordering](../../packages/shared/src/prompt-parts.mjs).

## Suggested next task

Agree on the owner `CommandClassifier` and host MCP guard service using the policy contract,
then integrate extras discovery and linked endpoint lifetime. Execution advisors and dynamic
workspace access need another bounded policy checkpoint. Image host wiring can proceed
independently using the completed contract. Windows Job-object tree termination and command shims remain separate
gaps. Current validation is fake-server/fixture testing on macOS, without live provider turns.
