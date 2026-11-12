# PR-details review (2026-11-12, parked)

Independent review of this uncommitted Codex-era work before parking. No P1 (no wrong-result
bug, no safety hole): without the `githubRead` grant the method isn't advertised; query, host,
repo, gh binary and environment come from the trusted launch manifest; GH_TOKEN/GITHUB_TOKEN are
cleared; every page must show the selected viewer login; children are bounded and reaped.

Parked because the current plan (GPUI on the Node daemon) reads PR details through the daemon's
own `pr:detail`; this service matters only when the Rust owner replaces the daemon.

Fix before adopting:
1. P2: one read slot, no queue, no server-side cancel (`rust-runtime/src/configured_pr_details.rs:48`,
   `rust-pr-details/src/lib.rs:183`): concurrent desktop/phone reads get `PR_READ_BUSY`; a dropped
   client future holds the slot up to 30 s. Join in-flight reads per number or queue by number.
2. P2: error shapes differ from Node (`lib.rs:170-171, 261-315`): Node returns `{ok:false,message}`
   for a non-numeric number and "not logged in"; Rust throws RPC errors. `deny_account` revokes for
   good, so `gh auth login` doesn't recover without a runtime restart (also after a refused
   non-forced quit, `rust-owner-wire/src/server.rs:430,451`).
3. P2: `localCommits` never reported (`rust-runtime/src/chat_runtime.rs:567` passes `None`); the
   parity test injects 2 and hides it. Wire `rev-list --count` or document the divergence.
4. P2: tests: fake gh exits 0 with `pullRequest:null`; real gh exits 1 with `errors` and stderr.
   Test the non-zero path and stderr-only auth detection against Node. No run against real gh with
   the cleared environment and custom HOME.
5. P3: 2 ms polling re-hashes config files ~500/s (`process.rs:190-227`); 8 KB per pipe per pass.
6. P3: >3000 files errors the panel where Node shows a partial list; a null later page truncates
   silently while the README says "never truncated" (`lib.rs:363-369`).
7. P3: stricter request checks than Node (extra keys, exact `cwd` string); document.
8. P3: connection's open Project not rechecked after the read (`actor.rs`).
9. P3: drop can block forever if a child's cleanup is retained (same as terminals).
