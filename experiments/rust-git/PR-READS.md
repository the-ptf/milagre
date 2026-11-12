# Local PR diff capability

`PR_READ_METHODS` adds the existing production `pr:diff-files` and `pr:diff-file`
contracts to `GitReader::call`, separately from the unchanged four-item `METHODS`.
The dedicated runtime's `ConfiguredGit` admits the same methods through its
existing pre/post actor, Project, root and local `.git` identity checks. The configured actor advertises/routes this separate capability. The shared
client exposes typed `GitReads.pr_diff_files` and `pr_diff_file` with fixed cwd,
weak connection lifetime, explicit view and no raw RPC.

Both methods take `{cwd,base,head}` with full lowercase 40-character SHA-1 commit
IDs; the file read also takes `{path,oldPath?}`. The comparison is
`merge-base(base,head)..head`, independent of dirty index/worktree content. The
existing bounded diff parser, literal pathspecs, caps and private runner are
reused. Callers cannot turn the normal Git diff facade into a raw range API.
Unknown extra request fields cannot change the fixed PR query.

No GitHub command, credentials, remote lookup or fetch is admitted. Production
Node `haveCommits` attempts a fetch when objects are missing; this narrower local
capability returns its existing fetch-needed result immediately. File reads
return the existing empty patch result for absent objects. A dedicated Project
without a local `.git` returns `isRepo:false` (or an empty file patch), without
letting Git discover the parent repository. A complete PR detail/authentication
service and user-authorized fetch remain missing.

`src/pr.rs::pr_commit` adapts MonoCode's commit peeling helper at upstream
`09d04436babb39ad72198cdf22f735067027fc04`. Milagre retains its stricter full
lowercase SHA contract and its stronger existing bounded/private runner. This
is a small direct reuse, not importation of MonoCode's complete Git service.
Copyright and MIT text are retained in `THIRD_PARTY_NOTICES.md`.

`tests/pr-fixtures.cjs` uses actual Node `createPullRequestReview` and
`createGitDiff`, over a fresh temporary Git repository. Its network-write stub
rejects/counts missing-object fetch attempts; it never performs them. Rust's
private query profile matches 22 response cases: rename, binary, Unicode,
newline, literal option/pathspec names, dirty working-tree exclusion, malformed
refs/paths, missing objects and unrelated histories. The index is unchanged.
Existing Git conformance/process/cap tests continue to exercise the shared
implementation. The configured runtime test separately proves both new reads and
pre/post authority callbacks on an actual isolated owner directory.

No normal app or runtime binary is packaged, launched, installed or re-signed by
this checkpoint. Nothing touches production data or performs a Git mutation in a
user repository. Logs use `/tmp/milagre-monocode-{git-*,pr-reads*,configured-git*}`.

The public owned-child staging suite also exercises both PR methods through the
actual runtime/socket/client, requires explicit view and accepted snapshot,
checks missing local objects, keeps the dirty working file/index unchanged, then
restarts and reads identical immutable PR results. Actual Node wire checks cover
pre-open and foreign-root refusals. Source/contract unit tests verify strict
commit/path validation before enqueue and absent-method capability refusal.
Logs: `/tmp/milagre-monocode-client-pr-wire-final.log`,
`/tmp/milagre-monocode-pr-node-wire.log` and `/tmp/milagre-monocode-client-git.log`.
