# Explicit GitHub PR detail reader

Source checkpoint only. The runtime/client binding exists in source behind an explicit private
`githubRead` launch grant; it remains pending root review and adoption. No
production/default GitHub authority is created by this crate. This is not
live-account or real-GitHub interoperability evidence.

The actual Milagre contract is `pr:detail({cwd,number})`, implemented in
`packages/core/src/pull-request-review.cjs`. Its fixed detail query supplies
number, base/head OIDs, checks, reviews, comments, files and panel metadata.
Additional file pages use the same fixed Node query. A caller never supplies a
GraphQL query, host, repository, executable, environment or account through the
request.

## Trusted launch boundary

`GithubSelectionOwner::capture(CapturedContext)` accepts trusted backend inputs
only, then `owner.reader()` issues an opaque owner/generation-bound reader:

- Canonical exact dedicated Project, executable, HOME and GH_CONFIG_DIR.
- Explicit GitHub owner/repository and selected `account_login`. The host is fixed
  to github.com. Unknown readiness becomes Ready only after every accepted page
  actually returns the matching `viewer { login }`.
- A retained owner lifetime and live authority callback. The parent must bind
  actual selected-GitHub-account readiness/generation and Project authority here,
  not a caller-provided Boolean or an arbitrary always-successful callback.
- Optional already-confined local Git count callback. Without one, `localCommits`
  is omitted, as Node does when the local count is unavailable or zero.

No account credentials, environment variables or installed profiles are discovered
or read by capture. The explicitly selected CLI will read its selected config only
when invoked. Exact replacement environment omits ambient tokens, loader variables,
SSH agents and startup files. Host/owner/repository are explicit query inputs,
so gh never needs to discover the repository from a remote or parent checkout.
The existing private local Git reader is unchanged and receives no network or
authentication authority.

The reader pins Project/HOME/config directory identities and executable metadata.
It checks owner authority before spawn, during pipe draining, between pages and
before accepting results. A replaced root/config/executable or revocation refuses
the result. The selection owner also pins metadata and content hashes of hosts.yml/config.yml
and revokes when either changes. Their content is never parsed/logged. Directory
identity alone is insufficient, and a manifest login alone never proves readiness. The
executable/account checks are cooperative path checks, not descriptor-exec or a
same-user sandbox.

## Limits and ownership

Each reader admits one active request; concurrent calls refuse rather than queue.
The entire detail operation shares a 30-second deadline, 32 MiB aggregate output
budget and at most 30 file pages. Each subprocess caps stdout and stderr at 16 MiB.
A file list still marked incomplete at the page limit refuses; Node currently
silently returns that partial list. Invalid page cursors and malformed PR objects
also refuse rather than creating a success-shaped empty panel.

The subprocess supervisor follows the existing Milagre owner runner's NOWAIT
ownership approach: nonblocking pipes with no detached reader threads, a held
unreaped child before signalling only its own process group, then confirmed reap.
Timeout, overflow and authority loss terminate and reap that exact owned child.
An unconfirmed/lost wait retains the actual Child, owner lifetime and admission
credit, never signals an unknown identity and never claims successful cleanup.
There are at most eight subprocess credits globally, including parked ones.
Poisoned parked storage leaks the retained value deliberately instead of dropping
its ownership. Cleanup polling can add up to two bounded three-second attempts
after the request deadline. Lost-wait/poison recovery is not tested or claimed.
`monitor()` exposes actual active-child count and sticky retained-cleanup status,
including after the reader is dropped. Retained cleanup fences later reads. The
parent must revoke admission before shutdown and require zero active children
with no retained cleanup; an error response alone is not a cleanup receipt.

This synchronous reader must run on a separately bounded backend read lane. Do
not block the serial actor/UI thread for a network timeout. A future frontend
drop must cancel only its local wait unless the backend independently confirms
the request's cancellation and child cleanup. No automatic retry, replay, fetch,
PR mutation or credential adoption exists here.

## Evidence and reproduction

```sh
NODE_PATH=/explicit/main-checkout/node_modules \
  cargo test --manifest-path experiments/rust-pr-details/Cargo.toml \
    --locked --offline --target-dir /tmp/milagre-pr-details-target
cargo clippy --manifest-path experiments/rust-pr-details/Cargo.toml \
  --locked --offline --all-targets --target-dir /tmp/milagre-pr-details-target \
  -- -D warnings
cargo fmt --manifest-path experiments/rust-pr-details/Cargo.toml --check
```

Tests launch only a freshly written private fake gh executable. It checks actual
argv and selected synthetic environment. The real Node `createPullRequestReview`
is called with an injected executor/private Git count to compare complete detail,
pagination, check ordering, review requests/stale reviews, comments, Unicode,
invalid PR numbers, errors and missing PRs. Fixed query assets are compared with
actual Node source so query drift fails. Separate tests prove pre-launch refusal,
mid-read config replacement and actual child reaping on timeout/overflow/revocation.
No real GitHub request, account access, provider turn or installed app is involved.

Logs: `/tmp/milagre-pr-details-{check,tests,clippy}.log`. Initial compile/test
attempts required a larger test JSON-macro recursion limit and canonical temporary
paths; final tests use the corrected source. No MonoCode code was copied for this
Milagre-specific detail contract; upstream notices elsewhere remain unchanged.

## Binding and remaining acceptance

Runtime source now accepts optional private `githubRead` grants, invokes this
reader off the serial actor with final actor authority checks, and revokes before
wire request drainage on stop. The shared client exposes separate weak
`PrDetailsReads`. Actual synthetic CLI/wire and public owned-child staging tests
pass. See `../rust-runtime/PR-DETAILS.md` for exact routing and limits.

Independent parent review, installation and GPUI adoption remain separate. No real
selected GitHub account or real network response has been tested. A grant is not
added to the installed/default Preview by this checkpoint.
