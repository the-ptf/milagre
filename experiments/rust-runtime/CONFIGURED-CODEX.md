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
refuses before dispatch. Ask text sends are supported, including the ordinary
React composer's typed `replies:"concise"|"normal"` preference and captured TLDR
true. Node Codex does not consume `replies`; its actual `beginTurn` oracle proves
both styles produce identical native frames. This is contract parity, not a
Codex reply-style feature. Effort remains exact on native `turn/start` (null is
omitted; an explicit string is retained). Full/Auto, image sends, fast mode,
user MCP extras and dynamic instruction/TLDR switching remain refused.
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

## Ordinary composer payload checkpoint

The dedicated entrypoint test now sends the same ordinary option shape as
`App.tsx`'s captured `executeSend` options: explicit model/provider/Ask, client
message ID, worktree/session, body/prompt, empty images/files, effort, disabled
ultracode/fast mode, the global Claude reply preference and TLDR true. The first
turn uses concise and null effort; the resumed turn uses normal and high effort.
The fake child's actual `turn/start` frames deep-equal calls through the real
Node `CodexSession.beginTurn`. Each oracle also compares concise, normal, null
and absent reply preferences. Existing thread instructions still match actual
Node assembly; saved transcript, streaming, reopen and native resume checks stay
in the same test. Unsupported/mistyped reply preferences refuse before any worker
starts; empty arrays are not accepted as a configured reply style.

No MonoCode source was needed for this increment: it closes a Milagre-specific
provider-independent composer contract using Milagre's Node behavior. Existing
upstream notices are unchanged. This remains fake-native evidence, not a real
Codex/account run or app refresh. Dynamic TLDR changes and enabled fast mode
remain separate work.

Logs: `/tmp/milagre-codex-composer-{entry,full,clippy,mutant}.log`.
The initial compile attempt inserted validation in the wrong function; its error
is retained in `entry-initial-compile.log` separately from successful checks.

Final validation passes 131 runtime checks with `chat-runtime`, all-target strict
Clippy, Rust formatting, JS formatting/lint and whitespace checks. Restoring the
old configured reply refusal fails the new entrypoint test cleanly in 0.5 seconds;
source was restored byte-for-byte and the final entrypoint rerun passes
(`entry-final.log`). The failed mutant's disposable evidence is retained and no
process was signalled. The full-suite result precedes the temporary mutant and
uses the same final source bytes.
