# Explicit GitHub PR detail reads

Source checkpoint pending independent review. Existing/default launch manifests
do not advertise or run `pr:detail`. A dedicated root can opt in with one private
persisted `githubRead` field alongside its existing provider launch:

```json
{"githubRead":{"program":"/explicit/canonical/gh","home":"/explicit/home","configDirectory":"/explicit/private/gh-config","path":"/explicit/tool/path","accountLogin":"selected-login","owner":"repository-owner","repository":"repository-name"}}
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
failure, wrong/missing viewer, credential/config changes or replacement revoke
the generation. There is no partial result, retry or caller-provided readiness
Boolean. Explicit runtime restart is required after revocation; Project reopen
does not silently refresh the account.

## Bounded read lane

The connection must open the exact Project. Private actor checks bracket the
operation. Network waiting runs outside the serial actor/publication lock on the
wire server's retained handler, following the existing terminal-read pattern.
One operation is admitted, with no queue; concurrent reads get `PR_READ_BUSY`.
The reader has a 30-second deadline, bounded output/pages and owned child credits.

The generic wire handler's new default-no-op `begin_shutdown` hook runs after
admission closes, before accepted requests drain. This optional lane revokes its
selection there without blocking or releasing owner authority. Previously, a held
read could not be revoked until shutdown had waited for that same read. Successful
stop still requires ordinary active-request drainage, actual child reap and
profile/socket cleanup. Unknown cleanup retains the child, root lifetime and
credit. Default handlers/provider behavior are unchanged. A stop attempt closes
this selection even if a later owner shutdown refuses; restart is required.

This is read-only PR metadata, not Git fetch, review writes, merge, OAuth/login,
credential management or Project adoption. The existing Git reader stays offline.
Local ahead-commit counts are not bound here and are omitted, as Node does for an
unavailable local count.

## Typed shared client

`guard.pr_details(&client)` returns weak, connection-bound `PrDetailsReads`.
Its only method is `detail(number).await`; no cwd, host, account, query or raw RPC
selector is exposed. Open the view, apply/accept the runtime snapshot, then read.
The API does not require caller-thread Tokio. Use a second explicit connection for
controls while reading, since each client's I/O worker serializes calls. Dropping
the future only cancels its local wait, with no retry/replay. Absent grants refuse
capability; account failures preserve typed `PR_ACCOUNT_NOT_READY` or
`PR_SELECTION_REVOKED` codes.

## Evidence

Own-crate tests compare actual Node detail normalization and run private fake gh
children: full metadata/paging, viewer proof, account generation, wrong later-page
viewer, file-byte changes, root replacement, late revocation, timeout and actual
reaping. Normal CLI/Node-client wire evidence covers absent/default no network,
pre-open/foreign refusal, a held read with responsive second-connection Chat calls,
stop cancellation/reap, restart, revocation and no provider execution. Public
OwnedChatGuard staging also proves typed reads, observed viewer, explicit snapshot
barrier, restart and Complete cleanup. All data/accounts/executables are synthetic.

Validation on the final source: service 13 tests; normal runtime 135 tests;
`routine-runtime-fixture` runtime 161 tests; owner-wire 34 tests; owned-chat client
89 tests plus 7 doctests. Strict Clippy and format checks pass. Public SDK staging
runs five real owned-child cases, with nine Complete cleanup records and the
private stage removed. These totals are synthetic evidence, not real GitHub use.

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
