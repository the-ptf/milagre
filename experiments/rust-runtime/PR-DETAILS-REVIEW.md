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

## Fixes (2026-11-12, branch `cp2-pr-details`)

Node stays the reference (`pull-request-review.cjs` `detail()` through `pr:detail`). Each
finding, what changed, and the test that covers it. Counts and commands are in the checkpoint
report; test names are in `rust-pr-details/tests/details.rs` unless a path is given.

1. P2 one read slot, no queue, no server-side cancel: fixed.
   - `DetailsReader` now has a small board of jobs keyed by PR number. Requests for a number
     already queued or running join it and all get that one result. Other numbers queue behind
     the running read (one running + three queued, 64 waiters; beyond that `PR_READ_BUSY`).
     The first queued waiter runs the read on its own thread.
   - `invoke_cancellable(args, gone)` takes a client-liveness probe (the runtime passes
     `!context.is_connected()`). A waiter whose client left stops waiting at once; when the last
     waiter of a queued job leaves it never starts; when the last waiter of the running job
     leaves, the child is killed and reaped and the slot frees after the reap. The runner's own
     client leaving counts as a waiter leaving.
   - Runtime: `ConfiguredPrDetails` no longer has the single-slot compare-and-swap; it counts
     active invocations only for drainage.
   - Tests: `concurrent_reads_of_one_pr_join_a_single_gh_read`,
     `different_numbers_queue_one_at_a_time_in_order`, `the_queue_is_small_and_refuses_beyond_its_bound`,
     `a_lone_waiter_whose_client_went_away_cancels_and_reaps_the_child`,
     `a_shared_read_survives_one_waiter_leaving_but_not_all_of_them`,
     `a_queued_waiter_that_leaves_never_starts_its_read`; over the wire
     (`rust-runtime/tests/configured-pr-details.cjs`): a joined read returns the same result, a
     different PR queues behind a held read without a second child, a disconnected client's gh
     child is reaped while gh is still held.
   - Gap: the wire protocol has no cancel message, so dropping a client future on a live
     connection still cancels nothing server-side; only closing the connection does. A caller can
     wait behind up to three 30 s reads in the queue.

2. P2 error shapes and recoverable revocation: fixed.
   - A `number` that is not a positive safe integer, of any JSON type (string, missing, boolean,
     container), is `{ok:false,message:"That isn't a PR number."}` like Node's `number()`. Wrong
     argument shape and a foreign `cwd` stay RPC errors, as Node's `folder()` throws there.
   - gh failures are classified exactly as Node's `graphql()` + `ghMessage()`: exit code 4 or
     stderr with `gh auth login` / `not logged in` / `authentication required` on a failed exit is
     `{ok:false,message:"Sign in to GitHub on <this Mac|this computer> with \`gh auth login\`, then
     try again."}`(the runtime passes Node's`thisComputer`); otherwise stdout `errors[0].message`,
     else the first stderr (or stdout) line without `gh: `/`GraphQL: `, cut at 400 UTF-16 units; a
     zero exit is never classified from stderr, GraphQL `errors` win. The old extra revoking
     patterns (`http 401`, `bad credentials`, GraphQL message matching) are gone; those are now
     GitHub's own text, as in Node. GraphQL `errors` are checked before the viewer proof, so an
     errors-only answer is the GraphQL message, not "different account".
   - Recovery without a restart: only a closed owner, a replaced Project/HOME/config directory or
     a changed gh executable are permanent. Sign-in failure is only a result. A wrong/missing viewer
     or a changed/non-private `hosts.yml`/`config.yml` refuses that read (`PR_ACCOUNT_NOT_READY` /
     `PR_SELECTION_REVOKED`, readiness `Revoked`, generation unchanged) and the next read re-pins
     the files (same owned/0600/single-link/128 KiB rules, hashes only) and needs the selected
     viewer on every page again. With no read in flight the first request does this before its
     check (`admit`), so the read right after `gh auth login` works; a change during a read still
     refuses that read. The viewer-login proof and never-read-credentials rules are unchanged.
   - Refused quit: `begin_shutdown` now `pause()`s reads (cancels the child, refuses admission)
     instead of closing the selection; `shutdown_attempt` calls `resume()` on a `Refused` result.
     `drain_before_owner_drop` and Project loss still close for good.
   - Tests: `invalid_numeric_pr_numbers_match_node_without_starting_a_child`,
     `authentication_failure_is_node_s_sign_in_result_and_a_later_read_recovers`,
     `wrong_missing_and_changed_page_viewer_refuse_without_partial_data_and_recover_on_a_later_read`,
     `an_account_file_edit_between_reads_is_adopted_by_the_next_read`,
     `account_file_edit_during_a_read_refuses_that_read_and_the_next_one_recovers`,
     `a_non_private_account_file_is_refused_until_it_is_private_again`,
     `close_expires_the_grant_for_good`, `dropping_the_owner_expires_the_grant_for_good`,
     `pause_cancels_reads_and_resume_restores_them_without_closing_the_selection`; runtime unit test
     `configured_pr_details::tests::a_refused_quit_resumes_reads_but_a_closed_service_stays_closed`;
     wire test: non-numeric number result, wrong viewer then recovery, sign-in result then recovery,
     hosts.yml rewrite adopted by the next read.
   - Gap: the refused-quit path is covered at the service level (`stop` then `resume`, owner not
     closed) but not end to end (a real non-forced quit refused by a running Chat over the wire).
     A missing gh binary is not mapped to Node's install message (the executable is pinned and
     checked before spawn, so ENOENT does not reach it).

3. P2 `localCommits`: wired, not documented away.
   - `rust-git` gained `GitReader::local_commits(cwd, head)`: `git rev-list --count <head>..HEAD`
     through the same bounded private runner, `cwd` confined to the admitted roots, 0 for a head
     that is not a full lowercase SHA-1, a failed or non-numeric count, or anything not a positive
     safe integer (Node's `localCommits`). The runtime builds a `ConfiguredGit` on the Project
     (same root and repository pins as the other Git reads) and passes its count as
     `local_commits`; a Project without a repository gives 0.
   - Tests: `rust-git/tests/pr_reads.rs::local_commits_match_node_rev_list_count_semantics`
     compares against Node's own `detail()` on a real checkout (ahead 2, 3, 0, unknown head,
     uppercase, non-SHA); `complete_detail_and_pagination_match_actual_node_...` now uses a real
     `git rev-list` count in a real checkout on both sides (the hidden injected 2 is gone) and asserts
     `localCommits` is 2; the wire test makes a real repository in the dedicated Project and reads
     `localCommits` 2 through the bounded Git reader, and none for a head the checkout lacks.

4. P2 tests: fixed.
   - The fake gh now also models a real failure: non-zero exit with GraphQL `errors` on stdout and
     the message on stderr, stderr-only sign-in, exit 4, raw non-JSON text, and a zero exit with
     stderr text. `failed_gh_runs_match_actual_node_error_classification` runs 17 such shapes through
     both this service and Node's `detail()` (with the same failure thrown as execFile rejects it)
     and requires identical results. `a_silent_failed_exit_says_gh_did_not_answer` documents the one
     deliberate difference (Node's fallback is execFile's "Command failed: gh api ..." with the argv).
   - Still no run against the real `gh` with a custom HOME: this work uses no real credentials.

5. P3 more than 3000 files: fixed to match Node. Paging is Node's loop (first page plus up to 29
   more; stops quietly with no next page or no usable cursor), the refusal is gone and the README no
   longer says "never truncated". Test: `a_file_list_past_the_page_limit_is_the_same_partial_list_as_node`.

Left as documented P3: 5 (2 ms polling re-hashes the config files, now also at each recover), 7
(stricter request checks than Node: extra keys and exact `cwd`), 8 (the connection's open Project is
not rechecked after the read), 9 (drop can block if a child's cleanup is retained). New small limits
to know: a runner's call returns only when the read it started ends, even if its client left; the
queue wait is bounded by three 30 s reads.

Checks run on the final source (all synthetic; fake gh children, throwaway HOME/config dirs):
`rust-git` `cargo test` (pr_reads includes the new Node-parity count test); `rust-pr-details`
`cargo test` 26 integration tests + 1 unit test, clippy `-D warnings`, fmt; `rust-runtime`
`cargo test` (default) 95 passed, `--features chat-runtime` 136 passed (includes
`tests/configured_pr_details.rs` driving `tests/configured-pr-details.cjs`, and the new
service unit test), `--features routine-execution-fixture` 162 passed, clippy `-D warnings` on
each of those three feature sets, fmt. Daemon client (public API unchanged): `cargo test --features owned-chat` 96 passed, 6 ignored;
`--features installed-owner` 121 passed, 8 ignored; clippy `--all-features --all-targets -D warnings`,
fmt; the ignored staged cases through `scripts/check-owned-chat.py` (5 of 5, including the PR-details
case, which now asserts that a rewritten account file is adopted by the next read and a non-private
one is refused without starting gh until it is private again, instead of the old permanent revocation).
