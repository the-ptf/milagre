# Explicit GitHub PR detail reads

Source checkpoint pending independent review. Existing/default launch manifests
do not advertise or run `pr:detail`. A dedicated root can opt in with one private
persisted `githubRead` field alongside its existing provider launch:

```json
{
  "githubRead": {
    "program": "/explicit/canonical/gh",
    "home": "/explicit/home",
    "configDirectory": "/explicit/private/gh-config",
    "path": "/explicit/tool/path",
    "accountLogin": "selected-login",
    "owner": "repository-owner",
    "repository": "repository-name"
  }
}
```

These are exactly seven fields, not a complete launch manifest. The host is fixed
to github.com. No account, token, credential copy or real grant is created by this
checkpoint. The issuer chooses the intended Project/repository binding explicitly;
the service does not infer one from a remote or ambient profile.

## Actual selection and readiness

Model-provider AccountService has no GitHub selection. The separate backend-owned
`GithubSelectionOwner` starts Unknown without a startup probe. Private grants bind
the exact owner/generation, executable, HOME/config directory identities and known
hosts.yml/config.yml metadata plus bounded content hashes. Present files must be
owned, single-link mode 0600 and at most 128 KiB each. Credential bytes are never
parsed or logged. The actual DataRoot callback revalidates the private manifest.

Both fixed read-only GraphQL queries include `viewer { login }`. Every page must
observe the selected login before any PR data can be accepted. Authentication
failure, wrong/missing viewer or a credential/config change refuse that read; a
replaced root or executable and a closed owner end the selection for good. There is
no partial result, retry or caller-provided readiness Boolean. Account trouble
recovers: gh sign-in failure is Node's `{ok:false,message}` result, and after
`gh auth login` rewrites the account files a later read re-checks them, adopts their
new metadata and again requires the selected viewer login. No runtime restart. Project
reopen does not refresh the account by itself.

## Bounded read lane

The connection must open the exact Project. Private actor checks bracket the
operation. Network waiting runs outside the serial actor/publication lock on the
wire server's retained handler, following the existing terminal-read pattern.
Reads of one PR number join a single gh read; other numbers queue (one running, three
queued, then `PR_READ_BUSY`). The wire handler passes the connection's liveness: a client
that disconnects stops waiting, and when nobody else waits the child is killed and reaped.
The reader has a 30-second deadline, bounded output/pages and owned child credits.

The generic wire handler's new default-no-op `begin_shutdown` hook runs after
admission closes, before accepted requests drain. This optional lane pauses reads there
(cancelling the running child) without blocking, closing the selection or releasing owner
authority. Previously, a held
read could not be revoked until shutdown had waited for that same read. Successful
stop still requires ordinary active-request drainage, actual child reap and
profile/socket cleanup. Unknown cleanup retains the child, root lifetime and
credit. Default handlers/provider behavior are unchanged. A shutdown that is refused
(a non-forced quit with a running Chat) resumes GitHub reads, since the selection was only
paused; a shutdown that is not refused leaves them paused, and the selection closes for good
when the owner is dropped.

This is read-only PR metadata, not Git fetch, review writes, merge, OAuth/login,
credential management or Project adoption. The existing Git reader stays offline.
`localCommits` is Node's `git rev-list --count <head>..HEAD`, read by the Project's existing bounded
private Git reader (`GitReader::local_commits`, no network or credentials) with the same root and
repository pins as the other Git reads. Like Node it is only reported for an OPEN PR whose head is a
full lowercase SHA-1 and only when positive; a Project without a local repository, a head this
checkout lacks or any failed count leaves it out.

## Typed shared client

`guard.pr_details(&client)` returns weak, connection-bound `PrDetailsReads`.
Its only method is `detail(number).await`; no cwd, host, account, query or raw RPC
selector is exposed. Open the view, apply/accept the runtime snapshot, then read.
The API does not require caller-thread Tokio. Use a second explicit connection for
controls while reading, since each client's I/O worker serializes calls. Dropping
the future only cancels its local wait, with no retry/replay (the protocol has no cancel
message: the server stops a read only when the connection closes and nobody else waits for it).
Absent grants refuse capability; a wrong viewer or changed account files preserve typed
`PR_ACCOUNT_NOT_READY` or `PR_SELECTION_REVOKED` codes, `PR_READ_BUSY` means the small queue is
full, and gh's own sign-in failure, a non-numeric number and GraphQL errors arrive as Node's
`{ok:false,message}` results.

## Evidence

Own-crate tests compare actual Node detail normalization and run private fake gh
children: full metadata/paging, viewer proof, account generation, wrong later-page
viewer, file-byte changes, root replacement, late revocation, timeout and actual
reaping. Normal CLI/Node-client wire evidence covers absent/default no network,
pre-open/foreign refusal, a held read with responsive second-connection Chat calls,
stop cancellation/reap, restart, revocation and no provider execution. Public
OwnedChatGuard staging also proves typed reads, observed viewer, explicit snapshot
barrier, restart and Complete cleanup. All data/accounts/executables are synthetic.

Validation after the review fixes (see `PR-DETAILS-REVIEW.md`, Fixes): service 26 integration
tests plus 1 unit test; default runtime 95 tests; `chat-runtime` 136 tests; fixture
`routine-execution-fixture` 162 tests; the wire test covers joined and queued reads, a
disconnecting client's child being reaped, sign-in and wrong-viewer recovery, rewritten account
files and `localCommits` from a real repository. Strict Clippy and format checks pass. These totals
are synthetic evidence, not real GitHub use. The earlier counts (service 13, runtime 135/161,
owned-chat client 89 plus 7 doctests, five staged cases with nine Complete cleanup records) predate the
fixes. These totals are synthetic evidence, not real GitHub use.

Logs: `/tmp/milagre-pr-selection-tests.log`,
`/tmp/milagre-pr-runtime-{wire,full,feature-full}.log`,
`/tmp/milagre-pr-owner-wire-tests.log`, `/tmp/milagre-pr-client-full.log` and
`/tmp/milagre-pr-client-wire-final.log`. The staged runtime SHA-256 is
`07660e9957af368bfa21e42a97df121a538159c005a2d630fd044163686aae47`.
The stage manifest labels its checkout HEAD as context, with
`sourceAttestation: false`; these edits were uncommitted during the run.
Initial missing NODE_PATH, wrong expected absent-method code and the real
pre-drain cancellation failure remain separate failed-attempt logs. No real
GitHub/account interoperability or installed-app adoption is claimed.
