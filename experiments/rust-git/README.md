# Rust Git/Changes reads

This standalone library ports the production renderer's four local Git read channels. It is a building block for the isolated Rust runtime; it does not replace the production Node owner, own a Project, watch files, or advertise Git mutations as working.

The separate [`isolated` mutation capability](ISOLATED-WRITES.md) ports commit and Worktree operations only in fresh disposable repositories it creates itself. It cannot adopt an existing Project, and it does not change the `GitReader` contract below.

```rust,no_run
use milagre_git_read::GitReader;
use serde_json::json;
use std::path::PathBuf;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let git = GitReader::new(vec![PathBuf::from("/explicitly/admitted/worktree")])?;
let files = git.call("git:diff-files", json!({
    "cwd": "/explicitly/admitted/worktree",
    "mode": "uncommitted"
})).await?;
# Ok(())
# }
```

The owner adapter must authorize the requesting Project/client before calling this library. Construct one reader with that owner's explicitly admitted Worktree roots and reuse it for caches. The request is the object in the renderer's first IPC argument, not the entire daemon argument array. Admission canonicalizes existing absolute directories. Each additional Worktree requires its own admission. A symlink alias of an admitted directory works; an unadmitted sibling, child directory, or another Project fails with `GIT_SCOPE` before Git starts. Creating a reader with zero roots permits no reads. Admission does not enumerate or create Worktrees.

## Contract

| Method           | Input beyond `cwd`                                            | Result                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git:changes`    | `base?`                                                       | Local branch/base, files and line counts, secret-name flags, local ahead/unpushed counts, remotes count, and in-progress merge/rebase/cherry-pick/revert or unresolved-index message. GitHub fields are described below. |
| `git:diff-files` | `base?`, `mode?`, `commit?`                                   | Production file-list shape, renames with `oldPath`, binary flags, untracked flags, optional truncation, and immutable commit/first-parent inspection.                                                                    |
| `git:diff-file`  | `base?`, `mode?`, `commit?`, `path`, `oldPath?`, `untracked?` | `{patch, binary, tooLarge}`. File arguments are relative literal pathspecs. An untracked request must occur in Git's unignored list and resolve inside the admitted root.                                                |
| `git:history`    | `base?`, `recordedBase?`, `branchesVersion?`, `limit?`        | Production comparison metadata, automatic/default/source base, branch catalog hash, commit author/message/date/stats, total and `hasMore`. Matching `branchesVersion` omits the catalog.                                 |

`METHODS` exports these channels. Every other method returns `UNSUPPORTED_METHOD`; `UNSUPPORTED_MUTATIONS` lists the principal known mutation channels for adapters that want to advertise explicit failures. There is no public raw-command, executable, shell, Git config, or arbitrary argument API. Internal PR `range` requests are not exposed by production `git-ipc.cjs`; this adapter likewise does not accept their range data.

References and comparison behavior follow `packages/core/src/git/client.cjs`: recorded base, creation reflog, then origin's symbolic HEAD or main/master; prefer an upstream base when the local base is behind or diverged, but keep a local base that is ahead. Commit inspection accepts the existing lowercase 40-character SHA contract. It compares merges against the first parent and root commits against the existing SHA-1 empty tree. This retains the current SHA-1 limitation rather than adding different SHA-256 repository semantics.

`GitError` implements `std::error::Error` and serializes `ok`, numeric process `code` or null, `missing`, `timedOut`, `overflow`, partial `stdout`/`stderr`, and `message`. `kind` adds the adapter classification (`GIT_PROCESS`, `GIT_SCOPE`, `INVALID_ARGUMENT`, `UNSUPPORTED_METHOD`) without changing the numeric process code. Preserve these fields when translating to daemon errors. As in Node, selected optional probes return null/zero, a failed repository probe produces `isRepo:false`, and failed patch reads return an empty patch; checked file-list/history commands propagate errors. History retains a commit with unavailable stats on a stats timeout/overflow, then retries after 30 seconds.

## Bounds and process behavior

- Git is executed directly with argv, stdin closed, no terminal prompt, a 10-second deadline and a 16 MiB cap on each output pipe. Partial output is retained. Eight process slots bound parallel work across readers; untracked counts use at most eight jobs and history stats four. On Unix, timeout, overflow and cancellation terminate the query's process group and stop pipe readers. Windows process-tree cleanup is not implemented or validated.
- Diff lists retain at most 1,000 files and report omitted entries with `truncated:true`. The Changes dialog retains the existing 300-file cap without adding a response field. Patches retain the existing 1,048,576 UTF-16-code-unit limit, not a UTF-8 byte limit. Untracked status line counts read only regular files up to 1 MiB.
- History defaults to 30 commits, clamps integer requests to 1 through 300, and treats zero as metadata-only. Catalogs are bounded at 64 entries for 30 seconds, keyed by canonical folder and current branch. Commit stats are bounded at 600 entries; failed expensive stats have a 30-second retry delay.
- The queries exclude `.milagre` where the production query does. Rename detection, binary detection, ignored/untracked checks, merge bases and diffs still come from the installed Git CLI. Filenames with spaces, newlines and Unicode are tested. The existing Node numstat limitation for TAB-containing filenames is intentionally preserved.

The read boundary uses the existing Node client's `analysisOnly` approach: clear inherited `GIT_*` redirects, disable fsmonitor, hooks, external diff, textconv and configured clean/smudge/process filters. It also sets `GIT_OPTIONAL_LOCKS=0` so status does not refresh the index, and `GIT_NO_LAZY_FETCH=1` so a partial clone cannot fetch objects during a read. No fetch, push, checkout, commit, staging, remote update or configuration write is available. Worktree common Git directories and configured object stores remain Git's own repository storage; admission is not a sandbox for a malicious concurrently changing filesystem.

The separate [local PR diff read capability](PR-READS.md) adds `pr:diff-files`
and `pr:diff-file` without GitHub/authentication/fetch authority. `METHODS` stays
the four local Git channels; `PR_READ_METHODS` advertises this separate subset.

## Deliberate gaps

1. GitHub PR lookup and default GitHub repository selection remain in the unported GitHub adapter. When Node would query GitHub, this reader returns `ghReady:false`, an explicit unavailable `ghMessage`, `pr:null`, and `prRepo:null`. It does not claim that the user's installed `gh` is missing and omits `ghCode`. Other local fields match Node.
2. `GitReader` exposes no mutations. Commit and Worktree domain writes exist only in the separate temporary-repository capability. Commit message generation, push, PR create/review/merge, live Worktree management, file watching, sidebar diff-stat polling, owner lifecycle and background-lane priority remain unported. The owner must schedule reads and refresh UI state. The eight-slot pool does not yet reserve an interactive slot as Node's process-lanes scheduler does.
3. Repository-configured helper execution is intentionally disabled. Repositories that require clean filters, text conversion, submodule recursion or lazy object fetching can therefore differ from the normal desktop Node client. Tests compare those cases with Node's existing `analysisOnly` profile. No performance claim follows from these narrower services.

This work follows `GLOSSARY.md`, ADR 0003 (runtime ownership) and ADR 0004 (shared Git client). It does not acquire or bypass a production owner lock.

## Verification

```sh
cargo test --manifest-path experiments/rust-git/Cargo.toml
cargo clippy --manifest-path experiments/rust-git/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-git/Cargo.toml --check
node_modules/.bin/oxlint experiments/rust-git/tests
```

The conformance test calls the unchanged production `createGitDiff` and `createGitActions` in Node to generate expectations, then compares Rust against the same disposable repositories. It covers 99 response cases: staged/unstaged/untracked changes, secrets, renamed/deleted/binary files, literal option/pathspec filenames, Unicode and newlines, linked Worktrees and aliases, out-of-scope paths, unborn/detached/unrelated branches, recorded/automatic/remote bases, merge first parents, immutable commits, full history metadata, catalog omission, pagination, file/patch caps, and conflict indicators. It verifies all observed indexes remain byte-identical and configured helpers never run. GitHub-only fields are explicitly substituted with the documented unavailable response; the test never contacts GitHub.

Separate process tests execute only temporary scripts to exercise partial output, timeout, overflow, missing executable, exit code and process-tree cancellation. Their outcomes are checked against the production Node `createGit` normalizer. Fixture setup mutates only newly-created temporary repositories and local fixture config. It performs no production Git mutation, remote fetch, push or global configuration edit. macOS was the validation platform; startup/UI responsiveness and full-owner performance are outside this crate's evidence.
