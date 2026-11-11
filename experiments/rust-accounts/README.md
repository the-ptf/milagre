# Account selection and environment planning

This crate ports the saved metadata, Project/Link selection and environment filtering from `packages/core/src/accounts.cjs`, plus the captured account selection from `account-routing.cjs`. It is not a complete account manager or connected to the installed application. It never reads a real profile, starts a CLI, reads credentials or writes a file.

## API

- `Accounts::parse(Some(json))` validates saved metadata, keeps the existing account IDs, ignores unknown account fields and fills newly added providers with `default`. `None` means a genuinely missing file, never a failed read. Invalid saved data fails instead of dropping account selections.
- `selected`, `snapshot` and `scope_snapshot` keep computer defaults and Project/Link overrides separate. A removed scope-pinned account stays selected and gets the same missing-account message; it never silently falls back to another credential.
- `pin(scope)` produces an owned `Selection` for a session or service. Later changes to the account model cannot change those captured IDs. It does not implement status/model service caches yet.
- `environment_plan(provider, &Selection, context)` requires an explicitly captured session selection. `environment_for_account(provider, id, context)` handles explicit Settings row operations with no default fallback. Both preserve the default CLI environment, clears provider authentication overrides for added accounts, clears Antigravity's ambient variables and chooses the existing account directory layout. Both environment-bearing types redact their Debug output.
- `EnvironmentPlan::prepare` exposes its environment only after an owner callback handles all explicit preparations. Antigravity default-profile creation and MCP inheritance are listed as `Preparation` values. Their filesystem implementations are **not ported**. Production treats MCP inheritance as best effort, so a future owner callback must make that decision explicitly. The plan itself performs nothing.

`EnvironmentContext` is supplied by the owner; it never reads this process's environment. Directory resolution targets POSIX hosts. Scope keys include the production Windows-drive and remote-computer forms because those can be present on paired clients.

## Evidence

```sh
node experiments/rust-accounts/scripts/generate-conformance.cjs --check
cargo test --manifest-path experiments/rust-accounts/Cargo.toml
cargo clippy --manifest-path experiments/rust-accounts/Cargo.toml --all-targets -- -D warnings
```

Five tests pass. The conformance test replays **300 calls from 15 profiles** through recorded production Node outputs: missing/valid/invalid metadata, defaults, captured selections, Project/Link/remote scopes, removed accounts, environment filtering and relative CLI config directories. A separate test proves failed preparation does not return credentials and Debug is redacted; another proves removed pinned accounts cannot switch implicitly. Two regression tests reject duplicate IDs across or within providers and verify that environment planning uses the Project pin and refuses removed accounts. Fixtures contain only synthetic values. Their generator uses disposable private directories, synthetic environments and injected CLI inspection; any attempt to spawn a process throws. Fixture regeneration compares the actual current Node implementation, not a second hand-written oracle.

## Unported and deliberate restrictions

- Login/logout, account add/remove/assign/select persistence, installation/identity refresh, status/model cache invalidation, account switching during turns and usage routing.
- MCP configuration inheritance, shared history links, default Antigravity preparation, account CLI inspection, OAuth and credential storage.
- Native Windows directory resolution; existing Windows and remote scope identifiers are preserved.
- Lone-surrogate JSON text is refused by serde_json. The owner has a lossless JSON module, but this crate has not adopted that representation.
- Duplicate IDs are refused across all providers because the profile directory is keyed by ID alone; Node currently accepts them. Antigravity preparation includes its accounts root and home, with memoization left to the owner.
- Malformed `selected` primitives are refused, although JavaScript can coerce some into an object with no choices. Invalid `directory` provider/ID arguments are also refused rather than becoming a path. No legitimate saved account is affected.

All snapshots are saved metadata with `state: unknown`; they do not imply that an account is installed or signed in. The Node owner still provides the running app's account service.
