# Policy checkpoint: owner integration contract

Implemented in `codex::guard` and `codex::session`. No owner crate changes or live Codex turns
were used to validate this checkpoint. Fake-server tests exercise enforcement; recorded Node
fixtures check decision/config parity. The owner must complete the trusted inputs below before
using constrained sessions in production.

## Session roles and lifetime

`SessionOptions.role: SessionRole` is immutable for the session, including all subsequent turns,
steering, user answers and permission-mode changes. Create a separate session when a babysit Run
or wake starts, or when returning to an ordinary human turn. This is deliberately stricter than
Node's per-turn mutable guards. It avoids introducing a guard replacement race in this checkpoint.
Do not reuse a wake session's request IDs for another wake.

| Role                                 | Startup and approval behavior                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ordinary`                           | Existing Ask/Auto/Full behavior. Validated config fallback is allowed.                                                                                                                                                                                                                                            |
| `AnalysisAdvisor`                    | Read-only/no network, `approvalPolicy: never`, inherited MCP servers disabled, native execution features disabled, only a validated read-only host endpoint may be enabled. Approval requests are denied; questions dismissed.                                                                                    |
| `Babysit { level, resolve_threads }` | Levels 1 through 5; requires `CommandClassifier`. Every mode uses `untrusted` command approvals. Native shell remains available, but subagents, code mode, plugins, hooks, external MCP and other advisor-disabled tools are disabled. No linked MCP endpoint is supported; all MCP approval requests are denied. |
| `Escalation { requests }`            | Read-only/no network with `untrusted` approvals. Native execution features and inherited MCP servers disabled. Host tools may be reads or `chat_respond` for the exact authorized Chat/request pairs. All shell/file approvals are denied; questions dismissed.                                                   |
| `ExecutionAdvisor`                   | Explicit `SessionError::UnsupportedPolicy` before spawning. Not implemented.                                                                                                                                                                                                                                      |

`analysis_only = true` is a compatibility alias for `AnalysisAdvisor`, now including startup
restrictions. Conflicting roles are refused. Constrained sessions enable the experimental API,
clear thread/turn environments and build their config internally. User-supplied custom config
for those roles is refused. Read-only roles replace the supplied sandbox/approval policy even
when the caller requests Full. Other unsupported sandbox/approval shapes are refused.

`ThreadSettings.extra` and `TurnSettings.extra` are reserved: nonempty maps now return
`UnsupportedPolicy`, including on a send that would steer. This closes policy/config override
paths. Trusted owner code still has raw `client()` access; never expose that handle or arbitrary
request methods to a renderer, agent, plugin or other untrusted caller.

## Required owner inputs

```rust
pub trait CommandClassifier: std::fmt::Debug + Send + Sync {
    fn actions(&self, command: &str) -> Result<Vec<RemoteAction>, String>;
}
```

The owner supplies `SessionOptions.command_classifier: Option<Arc<dyn CommandClassifier>>`.
`RemoteAction` is one of `Push`, `Reply`, `Rerequest`, `Resolve`, `Merge`, `Close`, `GraphqlFile`,
`BodyFile`. Rust applies the Node babysit level rules and denial ordering to these facts. Merge,
close/reopen, opaque GraphQL and opaque REST-body operations are always refused. Refusal details
are attached to the corresponding completed command step.

This trait is the shell classification boundary, not a shell parser implementation. The Node
parser handles wrappers, quoting, aliases, command substitutions and nested scripts. An owner
implementation must meet that contract and reject syntax it cannot classify. An empty vector
means a positively classified command without remote writes. It must not mean unknown syntax.
The callback runs synchronously: no blocking I/O or panics, and no secrets in errors or Debug.
The adapter catches unwinding classifier panics as classification failure, without forwarding
the panic payload into events. Babysit refuses the command even in Full; ordinary mode retains
its normal one-time approval behavior but cannot offer persistent approval. A subsequent
request and terminal event still run. This does not catch process aborts or bound an arbitrary
callback's runtime. Rust's process panic hook is unchanged, so the host must keep panic messages
free of secrets too. A missing classifier refuses Babysit startup; failed classification refuses
that Babysit command.

The separate `milagre-command-policy::ShellClassifier` checkpoint `0927a695` implements this
trait directly. Source review confirms per-call state, whole-command failure on unsupported
syntax, static error messages and bounded parsing/traversal. Its 218 Node traces, 60 adversarial
cases and 1,000 malformed cases belong to that crate's checkpoint, not provider integration
coverage. No dependency or runtime wiring was added here. The provider's Node decision oracle
remains explicitly test-only, and the new panic regressions use a deliberately broken test
classifier.

Before runtime wiring, the owner must establish the classifier README's execution preconditions:
known noninteractive Bash, controlled PATH/environment with no inherited functions/startup
scripts, trusted Git/gh binaries and trusted Git configuration/hooks/helpers. The classifier is
source analysis, not a sandbox; its supported static subset deliberately refuses ordinary opaque
workflows such as package/test scripts. Owner tests still need to exercise the real classifier
through the provider boundary. Constrained roles also require independently guarded MCP dispatch,
including manifest membership, exact wake targets and the escalation budget with the adapter
bypassed. Parser availability alone does not authorize enabling those roles.

For ordinary sessions the classifier is optional, but without it no shell approval offers
`allowForChat`. Remote-writing commands never offer persistent approval, even if the current
babysit level allows them. An explicit `AllowForChat` answer is downgraded to one-time `Allow`.
Classification and immutable guard decisions precede insertion into pending permissions, so
mode switches and direct user answers cannot revive a refused command.

`SessionOptions.linked_tools: Option<LinkedTools>` holds a trusted endpoint URL and a complete
`HostTool { name, read_only }` manifest. Analysis accepts only read-only tools. Escalation also
accepts non-read-only `chat_respond`, gated by `WakeRequest { chat_id, request_id }`. Other tools,
empty/duplicate names and invalid wake IDs are refused. Ordinary sessions continue to pass
linked MCP definitions in `ThreadSettings.config`; Babysit rejects linked tools explicitly.
The owner must supply role-appropriate developer instructions through `developer_instructions`.

Host MCP dispatch must enforce the same manifest and wake scope independently. An MCP server
can execute a tool without asking the provider for an approval; the adapter's response to an
elicitation alone does not protect host tools. For coordination with the Claude adapter, its
`PreToolUseGuard` can wrap the same owner policy service, but Codex needs remote-action facts
for persistence and level checks, not just an optional denial. Its `McpHandler` remains a host
transport concern. No shared owner trait or owner code has been changed here.

## Escalation budget

Matches Node's 6 tool calls plus 2 grace calls. After call 6, further host requests are denied;
call 9 seals approvals and interrupts the turn, with the existing kill grace if Codex stalls.
Counts distinct `item/started` tool IDs tagged with the current thread and turn. Duplicate,
foreign and stale notifications do not consume the budget. The counter resets at a new turn,
not on steering. The owner must enforce the same limit/scope at host dispatch too.

## Startup and retries

Every constrained role calls `config/read` before thread start/resume. Missing or malformed
config and RPC failure terminate startup. Every inherited MCP server is disabled; only the
validated analysis/escalation host endpoint may replace `milagre`. A constrained request gets
one config attempt. Resume may still unarchive then retry the same config; it never reduces it.

Ordinary fallback stages are: original config; remove `everywhere_servers`; retain linked
Milagre plus disabled entries; retain disabled entries only; bare config only when there are
no disabled entries. Identical stages are deduplicated. An `enabled: false` server survives
every attempted config, even if its name is in `everywhere_servers` or is `milagre`. Malformed
server definitions/flags are refused before spawn. Only server RPC errors advance stages;
transport failures and timeouts do not. The same helper serves thread start and resume.

`session.linked_tools_available()` reports whether the successful configuration retained an
enabled `milagre` entry. The owner should report tool unavailability when fallback drops it.
Settings/account-specific extras discovery and endpoint lifecycle remain owner work.

## Remaining unsupported integration

Execution advisors, per-turn role transitions, `WorkspaceAccess` read-only/dynamic roots,
`canStart` after host preparation, full instruction assembly, and image storage/lifecycle are
not implemented by this checkpoint. Do not represent these as an ordinary session and assume
that supplied instructions enforce them. Babysit with MCP writes is explicitly unsupported.

No installed Codex startup was exercised. Config/feature behavior still needs the parent's
approved integration validation; unknown Codex feature names can be ignored by Codex. The
existing path check is point-in-time, not protection from filesystem changes after approval.

## Validation

`tests/guards.rs` checks Full/steering bypasses, unknown commands, persistence, inherited server
disabling, startup failures, wake target restrictions, tool budgets, config retries and explicit
unsupported-policy errors. `scripts/record-guard-fixtures.cjs` records 160 babysit decisions,
4 advisor configs/policies and 25 escalation decisions from this checkout's Node code. Its
private `actionsOf` export is test-only; no Node source is modified. The test classifier is a
fixture lookup that rejects all other commands, not a production implementation.
