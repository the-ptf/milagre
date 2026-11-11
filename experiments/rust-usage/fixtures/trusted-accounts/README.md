# Trusted quota fixture adapter

Unix, synthetic, default disabled. This nested crate tests the real committed registry, account and
owner APIs without adding dependencies to ordinary rust-usage builds. Enable `fixture-adapter` only
in the disposable export below. `fixture-admission` on rust-usage supplies the narrow check/commit
hook; it installs no adapter by itself and does not change default Node compatibility behavior.

## Reproduce

From the repository root, with the pinned commit and Cargo dependencies already available locally:

```sh
python3 experiments/rust-usage/scripts/check-trusted-fixture.py
```

The script verifies the archive, exports committed dependencies into a fresh `/tmp` workspace,
copies this rust-usage source, reproduces the nine Node command traces, runs all 79 base tests with
and without admission enabled, runs the 11 adapter tests, and checks clippy and fmt. Cargo uses
`--offline --locked`; the workspace is removed on success or failure. No fetch or install occurs.
The Node VM executes the existing runtime usage commands with synthetic account/read callbacks;
filesystem persistence, credential access and transport attempts throw.

Dependency revision: `33a183a66f2c99ed5c8f5b7f9ccf481afd4b6765`.

| Exported directory          | Git tree                                   |
| --------------------------- | ------------------------------------------ |
| `experiments/rust-registry` | `83b2330d8da076d720de410feb8443d33170f64d` |
| `experiments/rust-accounts` | `9aa49548bf3b832afa983415f4dc661b95bf6aec` |
| `experiments/rust-owner`    | `56d987b52fdd099c99bcdbbfc14d442d3b2d816a` |

Exact archive command:

```sh
git archive --format=tar 33a183a66f2c99ed5c8f5b7f9ccf481afd4b6765 experiments/rust-registry experiments/rust-accounts experiments/rust-owner
```

Sole archive SHA256: `c91196b45273ceba99999a5efb1c1f6a4cba70226e2396cfa05d100165eaafcb`.
Cargo resolves optional path dependencies even when disabled, so this nested manifest requires the
exported siblings. The ordinary `experiments/rust-usage/Cargo.toml` remains independently buildable.

## Owner API

```rust
FixtureOwner::create(SyntheticSeed) -> Result<Arc<FixtureOwner>, String> // async
FixtureOwner::capture(&Arc<Self>, FixtureScope) -> Result<FixtureSession, String> // async
FixtureSession::handle(QuotaCommand) -> Result<Value, String> // async
FixtureOwner::mutate(FixtureMutation) -> Result<(), String> // async, trusted fixtures only
FixtureOwner::close(&self) -> Result<(), String> // async, concurrent/cancelled waits supported
```

`SyntheticSeed` supplies bounded metadata JSON, Project names, Link memberships, quota result
values, explicit identity observations and a fixed timestamp. It cannot accept a profile path.
The owner creates new disposable registry/account copies and writes only the supplied synthetic
quota values to its own `EnvironmentContext.directory(provider, captured_id)` paths. The context
contains explicit home/data/cwd directories and an empty environment. It never uses HOME discovery,
`Policy::system`, credential discovery, preparation as readiness, provider processes or a network.

`FixtureScope` is `Computer`, `Project(fixture_name)` or `Link(id)`.
`QuotaCommand` is `Read`, `Cached`, `AccountsRead` or `AccountsCached`, preserving the four Node
command envelopes, accountKey, account decorations, scope events, checkedAt and ordering.
`FixtureMutation` supports explicit `Observe`, `Select`, `Assign`, `Remove`, Project `Position`,
`DeleteLink` and `CloseAccounts`. These invoke the actual account service or registry writer.
They are trusted fixture control methods, never renderer commands. Select/assign require the account
service's explicit ready state; they cannot turn unknown, signed-out or preparation state into ready.

## Authority and commit boundary

One actor exclusively owns AccountService, RegistryCopy and Writer. Capture retains the real
`milagre_accounts::Selection`, owner UUID, metadata generation, registry Snapshot plus ProjectGrant
or LinkGrant, and a private readiness epoch. No caller supplies those fields. Real account metadata
mutations advance generation. Every successful `observed()` advances the private epoch, including
ready to signed-out to ready, because readiness alone does not advance account generation.
Invalidation is conservative across all captures owned by the actor. All-account commands require
every listed account to be ready and bound to a synthetic fixture. The actor rechecks the real
selection, active owner, generation, epoch, registry bytes/grants,
account existence/readiness and retained descriptors before read admission and final acceptance.

Final validation and cache update/event/response acceptance execute in one actor turn with no await
between the validation result and apply. All adapter metadata mutations use that actor. A denied
closure is dropped before `UsageState::complete`, last-good staging or changed-event delivery.
Read failures remain ordinary usage errors; authority failures reject the command. Revoked scopes
cannot serve retained cached values and late results cannot replace history. A fresh authorized
capture can reuse last-good history. Removal never deletes that history. The cache merges only the
provider committed by that operation, so stale reader copies cannot replace other providers' history.

Every synthetic directory retains its complete ancestor descriptor chain. File access uses
`openat(O_NOFOLLOW)`, a retained regular-file descriptor, inode/device and link-count checks, a 64 KiB
limit and comparison with the originally supplied bytes. File or ancestor replacement rejects access;
symlinks/hard links and changed fixture contents are refused. Descriptor checks also guard cached
commands and acceptance. This is a cooperative owner boundary, not a sandbox against arbitrary
same-user processes racing every filesystem operation.

Limits: 32 accounts, quota files and captures; 16 Projects and Links; 1 MiB metadata seed; 64 KiB per
quota file; channel capacity 32; four blocking readers; 128 retained event records. Captures remain retained until owner close.
Close revokes admission first, cancels supervised callbacks, waits for admitted blocking readers,
then shuts down the cache writer. Cancelling a close waiter does not cancel cleanup or release its
cache lease. Close has no forced timeout; an OS-stalled read retains ownership until it exits.
Successful provider values survive cache staging failure, with a CacheOwner diagnostic. CacheOwner
retains failed writes; this fixture does not add a separate periodic retry scheduler.

## Tests and gates

Tests use real account remove/select/assign/observed/close calls and actual registry writer commits.
They cover old cached captures, paused late responses, readiness ABA, Project/Link revocation,
replacement ancestors/files, last-good cache reopen, concurrent close and cancellation while an
actual blocking reader is paused. The removal test starts with 1% retained usage and a late 22%
fixture result, so accepting the stale result would visibly destroy the asserted history.
Nine Node traces compare exact response bodies, provider calls and changed events through this
adapter. Node's permissive stale-account behavior is deliberately tightened by admission; the
ordinary base API and its original 19 command traces retain compatibility.

Production adoption, runtime routing, scanner/pricing integration, live transport, arbitrary copied
profile adoption, installation discovery and Windows support remain gated. Only macOS arm64 has
been executed here. No account/registry/runtime source changes or new cross-crate APIs are required.
