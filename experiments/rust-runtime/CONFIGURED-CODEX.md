# Captured Codex bridge (source checkpoint)

The dedicated owner can construct `CodexFixture::configured(CodexLaunchContext)`.
This reuses Milagre's existing bounded Codex worker/session transport, not a second
transport implementation. It creates no Project files and starts no process until
an owner-admitted send. Only the owner crate can construct this context. The
shared public fixture constructor stays fake-only.

The context captures the explicit program, HOME, selected CODEX_HOME, PATH,
OS user, model and developer instructions, plus an actual owner lifetime lease
and live authority callback. Each worker retains that lease through native close
and executor drainage. Constructor/start/answer admission, native spawn, turn
entry, send-result acceptance and event handling recheck captured authority.
No account discovery, credential reads, account-directory creation, ambient
API-token inheritance or provider process runs during construction.

Configured launches use the native `app-server` argument, an exact six-variable
replacement environment, normal transport/start timeouts and three-second
interrupt grace. They inject the captured developerInstructions in thread start.
The configured model and TLDR instruction selection are fixed; a mismatched turn
refuses before dispatch. Ask text sends are supported; Full/Auto, image sends,
fast mode, user MCP extras and dynamic instruction/TLDR switching remain refused.
The context's instructions must come from the parent's actual Node-compatible
assembly. A supplied text is not proof that packing or production account adoption
is complete.

Selected-account environment setup is adapted from MonoCode at
`09d04436babb39ad72198cdf22f735067027fc04`, with its MIT copyright/license in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Existing Milagre framing,
TurnId/AnswerId, queue budgets, permissions and cleanup contracts are retained.
No upstream ambient profile lookup or automatic missing-resume fallback is copied.

Tests use only synthetic directories and a native shell wrapper executing the
repository Node fake. The child asserts app-server argv; a preload records its
actual thread/start frame and selected nonsecret synthetic environment. Tests
require exact developerInstructions/cwd/account/HOME/user, streamed reply,
revocation refusal and real cleanup. Selection/policy refusals start no workers
and leave Project coordination storage empty. This is fixed-child evidence,
not a real Codex turn or installed application/provider adoption.

Logs: `/tmp/milagre-configured-codex-{tests,bridge,runtime-full,clippy-final}.log`.
The normal entrypoint now accepts optional `provider:"codex"`, advertises only its
selected model/account and preserves legacy omitted-provider Claude manifests.
The actual production Node client wire test uses normal create/open, checks scope
and provider refusal, streams/saves two turns across two native processes, first
reopens history with zero sends, then proves exact native thread/resume. Captured
native developer instructions equal actual Node sessionInstructions byte for byte.
SharedContent still serves renderer data; no Milagre content MCP endpoint is
registered with Codex. Native account configuration may still enable the CLI's
own MCP servers, which are not owned or managed by this entrypoint.

Entrypoint evidence: `/tmp/milagre-configured-codex-entry-{wire,full,clippy,normal-clippy}.log`.
The initial missing NODE_PATH attempt is retained separately. Independent root
review remains required. No app is installed by this checkpoint.
