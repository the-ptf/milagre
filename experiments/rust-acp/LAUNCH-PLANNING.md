# Synthetic ACP launch planning

Opt-in feature: `launch-planning`. Default builds do not export `planning`.

```text
planning::plan_vendor_launch(&LaunchObservation) -> Result<LaunchPlan, Refusal>
planning::classify_failure(Vendor, &FailureObservation) -> Result<FailureClass, Refusal>
```

These functions only inspect caller-supplied synthetic data. They never read an environment,
account, profile, installation, filesystem, network or process. There is no call into raw spawn,
`FakeSession`, account services or owner/runtime code. The plan has private fields, no constructor,
no Deserialize implementation and no conversion to `SpawnOptions`. It can be serialized for
fixture/review assertions; `authorized` is always false. It is not an executable capability or
proof that an account, executable, workspace or enforcement mechanism exists.

## Inputs and limits

`LaunchObservation` contains typed vendor/OS, expected account scope/generation, optional account
observation, a vendor-specific install observation, explicit resource paths, a closed environment
list, ambient-presence markers, policy requirements, model observations and MCP IDs. No credentials,
URLs, headers, arbitrary arguments, hooks or arbitrary JSON maps are accepted. Do not supply real
credential material in synthetic string fields. All data-bearing types implement opaque Debug;
refusal messages contain only fixed text and failure classification never returns raw errors.
Serialization intentionally contains review data and is not a redaction mechanism.

| Resource                          | Fixed cap / accepted shape                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Aggregate input / serialized plan | 64 KiB of variable UTF-8 string payload / 32 KiB JSON output                                                             |
| Paths / environment               | 4,096 bytes per path/value; at most 12 entries from 10 fixed keys, no duplicate keys; at most 4 distinct ambient markers |
| Account/model/MCP IDs             | 128 bytes each; nonempty ASCII letters, digits, `.`, `_`, `:`, `-`; generation is a nonzero matching u64 observation     |
| Model options / efforts           | 32 options, names at most 256 ASCII bytes; 8 effort strings per option and 32 bytes per effort/requested effort          |
| MCP / executable candidates       | 16 MCP IDs; four fixed Kiro candidate slots or one Antigravity agent plus optional harness                               |

Counts and all string-byte limits are checked before copies into a plan. Count checks precede
iteration over variable lists, and accumulation uses checked arithmetic. Caller allocation and
JSON decoding of `LaunchObservation` remain caller-owned: this is a borrowed typed API, not a
bounded JSON reader. Unknown serialized fields and unknown enum values are rejected by serde;
callers that decode external input must cap their frame before decoding. Temporary serialization
is bounded by the validated input structure; an over-limit output returns `OutputLimit`.

Paths must be absolute for the observed OS, contain no control characters or `.`/`..` components.
Windows accepts drive-absolute paths only; UNC/device paths are deliberately unsupported. POSIX
paths reject backslashes. No canonicalization, symlink resolution or executable-bit check occurs.
Even a nonexistent path can produce a plan when its synthetic observation says it is executable.
That behavior is tested and is why a plan cannot authorize launch.

## Planning behavior and refusals

Account vendor, ID, scope and generation must match the expected account; missing, stale,
not-ready and mismatched observations return distinct refusals. Kiro accepts only `default`.
The supported policy is an ordinary Ask planning request with neither host-guard nor MCP-guard
requirements. Auto, Full and all constrained roles refuse. There is no guard implementation input
or boolean that can claim policy has been enforced. Ask planning is not authorization to run Ask.

Kiro chooses the first executable observation in override, real-launcher sibling, launcher sibling,
then macOS app order; the final slot is only eligible on macOS. These are pre-derived candidate
observations, not validated relationships to an actual launcher. Arguments are fixed to
`acp --agent-engine v3`. The plan records `autopilot=on`; this is not a permission shortcut.

Antigravity requires an observed executable agent/harness pair and a matching-pair observation,
plus explicit profile and scratch paths. It plans Linux `--uid=` and no arguments on macOS/Windows.
It emits account `GEMINI_HOME`, harness path, forced file storage, unbuffered output and private
scratch variables (`TEMP`/`TMP` too on Windows). Installation pins, architecture, ACLs, ownership
and actual agent/harness identity remain unverified; the pair flag is only fixture data.

Environment entries are `PATH`, `LANG`, `TERM`, `GEMINI_HOME`, `TMPDIR`, `TEMP`, `TMP`,
`ANTIGRAVITY_HARNESS_PATH`, `AGY_ACP_FORCE_FILE_STORAGE`, `PYTHONUNBUFFERED`. Managed values must
match their explicit resource/fixed value; conflicts refuse instead of being silently overwritten.
Kiro accepts only the first three keys and no profile/scratch override. Antigravity ignores the
four value-free ambient groups (`GoogleCredentials`, `GoogleProject`, `Browser`, `ElectronRunAsNode`);
Kiro refuses their presence. No credential/browser value can be supplied through those markers.
Windows environment matching is case-sensitive through enums, so alternate-case keys cannot bypass
checks. PATH/locale strings are synthetic content, not validation of executable resolution.

MCP entries contain only ID, enabled and required. Disabled entries remain in the plan in order;
there is no filtering/retry that could re-enable them. Duplicate IDs and disabled-but-required
entries refuse. Endpoints, credentials, dispatcher guards and server startup are not implemented.

Model selection strips Kiro's prefix and sets effort only when its first matching offered option
allows it. Antigravity groups levelled model names, preserves first variants, selects requested or
default effort, handles partner-family prefixes, then uses the recorded fallback catalog or raw ID.
Unicode/control-bearing model names and prototype-reserved levels are refused explicitly; this
checkpoint does not claim general JavaScript string/prototype parity. Empty model IDs also refuse.

Failure classification accepts a bounded message and optional bounded string RPC data (4 KiB each).
It reports Transport, Authentication, Subscription or Server, with subscription precedence for
Antigravity. It does not schedule retries, open a browser, inspect tokens or choose another account.
Structured RPC data is outside this typed observation and needs a separate bounded adapter.

## Node evidence and host-read guard

`node scripts/record-planning.cjs --check` (from this crate) executes the full repository Kiro,
Antigravity and installation helper modules in VM contexts. The real shared model functions are
also evaluated from source; only ESM export syntax is adapted. No model-resolution algorithm is
stubbed. Five source hashes and all results are stored in `tests/fixtures/node-planning.json`.
There are 111 launch/model cases and 360 failure cases. Kiro candidate precedence uses explicit
synthetic exists/realpath probes; OS/path APIs are fixed per case. Antigravity exercises the actual
ambient-key list and environment helpers with synthetic presence values.

Unexpected requires, filesystem/install/profile operations and subagent construction are denied.
Denied probes are counted: a helper catching the injected exception still fails the recorder.
Self-checks prove that token-file inspection and Kiro executable probing cannot reach the host.
The recorder's own reads are allowlisted to the five regular repository source files and its
fixture file, with a 2 MiB file cap and canonical-path check. An attempted outside-profile read is
rejected before I/O. Source modules receive no ambient process environment, spawn implementation,
network client or live account. This is a guard against accidental host operations by trusted
repository code, not a security sandbox for arbitrary hostile JavaScript.

Refusal tests cover account/generation/policy/harness/platform mismatches, closed environment
keys/conflicts, disabled MCP preservation, individual/count/aggregate/output caps and Debug
sentinels in every data-bearing observation category. Deliberate stricter behavior above is Rust
planner policy, not falsely attributed to Node parity. The existing three ACP recorders and
fake-session tests remain separate and unchanged.

## Production gate

[PRODUCTION-CONTRACT.md](PRODUCTION-CONTRACT.md) still governs future work. The next agreement must
bind real account/project generations, verified installation identity, workspace authority,
independent tool guards and process-tree/resource cleanup to a private authorized launch type.
Nothing here issues that type or connects this planner to a launch path. Receipt framing P3s
remain a separate queue; this checkpoint does not change their evidence boundary.
