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
  is omitted, as Node does when the local count is unavailable or zero. The runtime
  wires it to `rust-git`'s `GitReader::local_commits`, which is Node's
  `git rev-list --count <head>..HEAD` (open PRs with a full lowercase SHA-1 head;
  anything unavailable or not a positive safe integer is 0).

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
and refuse a read when either changes mid-read. Their content is never parsed/logged. Directory
identity alone is insufficient, and a manifest login alone never proves readiness. The
executable/account checks are cooperative path checks, not descriptor-exec or a
same-user sandbox.

## Limits and ownership

One gh read runs at a time per reader. Concurrent requests for the same PR number
join that read (queued or running) and all get its result. Other numbers queue behind
it, at most four distinct reads outstanding (one running, three queued) and 64 waiting
callers in all; beyond that a request gets `PR_READ_BUSY`. A queued read starts only
after the previous one finishes, so a caller can wait behind up to three 30-second
reads. `invoke_cancellable` takes a "client is gone" probe: a waiter whose client left
stops waiting at once, and when the last waiter of a queued job leaves it never starts,
when the last waiter of the running job leaves its child is killed and reaped (the slot
frees only after the reap). The thread that runs a read is the first waiter's own thread,
so that caller's call returns when the read it started ends, even if its client already
left and others still wait. The protocol has no cancel message: dropping a client future
on a live connection does not stop anything server-side; closing the connection does.
The entire detail operation shares a 30-second deadline, 32 MiB aggregate output
budget and at most 30 file pages. Each subprocess caps stdout and stderr at 16 MiB.
A file list still marked incomplete at the page limit is Node's partial list: Node
reads the first page plus up to 29 more (`FILE_PAGES` is 30) and returns what it has,
and so does this (a test compares the two). Paging also ends quietly, as in Node, at
a page with no usable cursor (this additionally treats a cursor over 8 KiB as unusable).
A malformed PR object (wrong number, not an object) still refuses rather than creating
a success-shaped empty panel.

## Results and errors

The request's `cwd` is checked first and mismatches are RPC errors (Node's `folder()`
throws there). After that every outcome Node returns as `{ok:false,message}` is that same
result: a `number` that is not a positive safe integer of any JSON type ("That isn't a PR
number."), missing PR, GraphQL errors, and sign-in failures. Sign-in is gh exit code 4, or
stderr containing `gh auth login`, `not logged in` or `authentication required` on a
failed exit, with Node's message `Sign in to GitHub on <computer_label> with \`gh auth
login\`, then try again.`; other failed exits show the GraphQL `errors[0].message`from
stdout, else the first line of stderr (else stdout) without a`gh: `/`GraphQL: `prefix,
cut to 400 UTF-16 units, else "GitHub didn't answer." A zero exit is never classified
from stderr. Node's last-resort text for a silent failed exit is execFile's
"Command failed: gh api ..." (the whole argv with the query); this says
"GitHub didn't answer." instead. A missing or non-executable gh is not mapped to Node's
install message (the executable is pinned and checked before spawn). RPC errors remain
for: wrong shape or foreign`cwd`, `PR_READ_BUSY`, `PR_READ_CANCELLED` (the caller's own
client went away), a wrong/missing viewer (`PR_ACCOUNT_NOT_READY`) and a revoked or
paused selection (`PR_SELECTION_REVOKED`).

## Recovery

Only a closed owner, a replaced Project/HOME/config directory or a changed gh executable
end the selection for good. Account trouble recovers on a later read, with no runtime
restart: a gh sign-in failure is only a result; a wrong or missing viewer, a changed or
non-private hosts.yml/config.yml refuse that read (`PR_ACCOUNT_NOT_READY` /
`PR_SELECTION_REVOKED`, readiness `Revoked`) and the next one starts by re-checking the
files (owned, mode 0600, single link, at most 128 KiB), adopting their new metadata and
hash, and requires the selected viewer login on every page again. When no read is in
flight, the first request of a new read does this before anything else (`admit`); a file
that changes while a read runs refuses that read. `pause`/`resume` stop and restart reads
without closing the selection, for a shutdown that may be refused.

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
invalid PR numbers (strings, a missing number, booleans, containers), errors and missing
PRs, failed gh runs (exit 1 with GraphQL errors plus stderr, stderr-only sign-in in three
phrasings, exit 4, raw text, 400-unit cut, zero exit with stderr), the real local commit
count from a real checkout, and a file list past the page limit. Fixed query assets are compared with
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
