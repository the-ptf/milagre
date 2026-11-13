# Isolated Git writes

`milagre_git_read::isolated` ports the existing commit and Worktree domain operations into a separate temporary-repository capability. It is Unix-only and is **not wired to the production app or the isolated runtime's copied Project store**. The existing `GitReader` remains read-only and still rejects mutation methods.

## Owner API

```rust,no_run
use milagre_git_read::isolated::{CreateWorktree, IsolatedGit, RemoveOptions};

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let owner = IsolatedGit::create().await?;
// Only this newly-created, disposable repository is eligible for commit.
std::fs::write(owner.project_path().join("README.md"), "Fixture\n")?;
let committed = owner.commit(owner.project_path(), "Initial").await?;
assert_eq!(committed["ok"], true);

let worktree = owner.create_worktree(CreateWorktree {
    project_path: owner.project_path().into(),
    base_branch: "main".into(),
    prompt: "Try a feature".into(),
    branch: None,
    suffix: None,
    folder_slug: None,
    track_base: false,
}).await?;
let response = worktree.info(); // {branch,path,base}, matching createWorktree's domain result
let lease = owner.lease(&worktree).await?; // retain while a provider/setup uses the folder
// stop the provider/setup, then release its lease before attempting removal
drop(lease);
let status = owner.worktree_status(&worktree).await?;
let removed = owner.remove_worktree(&worktree, RemoveOptions::default()).await?;
# Ok(())
# }
```

`owner.reader().await?` returns `IsolatedGitReader`, admitting only its main checkout and serving the same four `call(method,args)` queries. This read view retains the owner lifetime, revalidates ownership on each request and holds the repository lane across the query. It uses the private empty environment with hooks forced to `/dev/null`; host HOME/global Git config and credential environment never enter its queries. Unsupported redirecting local metadata/configuration is refused. Ordinary `GitReader::new` behavior is unchanged.

`root_path()` is the temporary container, `project_path()` its main checkout, and `worktree_root()` its sibling Worktree directory. `list_worktrees()` returns the existing `{path,name}` list. `OwnedWorktree` has private owner/instance identity fields and exposes `path()`, `branch()`, `base()` and `info()`. It cannot be deserialized from an untrusted client request. The owner adapter retains handles in its registry and maps client IDs to those handles. An arbitrary path, a handle from another owner, or an old handle for a recreated path cannot authorize removal. Symlink aliases for a registered checkout still resolve to the same stored directory identity.

`CreateWorktree` uses camelCase JSON field names and rejects unknown fields. `projectPath`, `baseBranch`, `prompt`, `branch`, `suffix`, `folderSlug` and `trackBase` correspond to the production domain function. The adapter owns naming policy and supplies the branch/folder slug when applicable. Suffixes and folder slugs receive additional path-component validation. There is no destination-root parameter. Every new directory stays under the capability's private Worktree root.

`RemoveOptions` has `force` and optional `seen: WorktreeStatus`. Safe removal requires an attached branch with no uncommitted or unpushed work. Forced removal requires the observed HEAD to match and the uncommitted/unpushed counts not to grow. Removal always compares against the base recorded at creation, as production `removeOwnWorktree` does; the client cannot substitute `HEAD` as its base. The result is `{removed,branch,branchDeleted}`. A repeated successful removal returns the existing runtime-style `{removed:false,alreadyRemoved:true,branch,branchDeleted:false}`. Only a `milagre/` branch is eligible for deletion; Git's safe `-d` remains the default.

## Isolation and lifetime

`IsolatedGit::create()` makes a fresh directory under canonical `/tmp`, independent of `TMPDIR`. There is no constructor from an existing path, marker import, live-profile path, or existing repository. The container has mode 0700 and a mode-0600 ownership marker. Main-checkout and Worktree directory identities, the marker, canonical common Git directory, and exact created-Worktree registry are checked before writes. Creation checks the destination root's identity before making any directory. Symlinked or hard-linked Git metadata and unsupported redirecting local configuration are refused.

A clone shares the same repository state, mutex and active-use leases. The mutex covers each complete check-and-write operation across all Worktrees, not just individual Git commands. The runtime must still perform Chat/Link ownership checks and stop providers/setup before releasing their leases. A lease blocks removal and keeps the repository alive if the original owner value is dropped. When the last owner/lease disappears, the owned temporary directory is removed. If root identity or its marker changed, teardown retains it instead of recursively deleting an unverified path.

Git starts from an empty environment with only PATH, C locale and its explicit private home/config/cache/GPG/temp locations plus Git controls. Hooks cannot inherit provider credentials, shell startup configuration, SSH agents or dynamic-loader overrides. Apple's Git shim may add its SDK search variables. Global/system Git configuration, prompts and lazy fetching are disabled. No Git fetch, push, remote update, live lock recovery, arbitrary shell or public raw Git API exists. The temporary repository uses its own fixture author identity. Reads retain the 10-second deadline; commit, Worktree creation and removal use the production five-minute deadline, with 16 MiB per output pipe. Process-group timeout/cancellation cleanup also covers commit stdin and hooks.

## Commit parity and helper limits

`commit(cwd, message)` returns the existing `git:commit` domain shapes. It stages all changes except `.milagre`, removes previously staged `.milagre` entries, blocks detached HEAD and merge/rebase/cherry-pick/revert/unmerged states, restores the previous index tree on secret refusal, and sends the trimmed message through stdin. Nothing-to-commit, hook failure, signing failure and successful SHA/short-SHA responses are retained. A failed safety-list read, index snapshot or `.milagre` exclusion fails closed instead of permitting a commit. Checked safety errors use the existing typed `GitError` plus `ISOLATED_GIT_SCOPE` or `ISOLATED_GIT_IO` for the new capability guards.

Ordinary executable hooks inside this new repository's `.git/hooks` run, so the commit's hook behavior can be checked against Node. Existing system/user hooks are never copied or inherited. Custom hook paths, configured clean/smudge filters, config includes, `core.worktree`, and per-Worktree configuration are explicitly unsupported in this boundary. These are errors rather than silent successful commits with skipped project behavior. Signing checks Git's effective format-specific helper (`gpg.openpgp.program` before `gpg.program`) and requires it physically inside the temporary container, uses its private GPG home, and refuses system GPG/SSH/keychain signing. Tests use a private failing fixture signer; no real signing credentials are requested or loaded.

This capability prevents its API from adopting or mutating an unrelated repository. It is not an OS sandbox against trusted fixture hook code deliberately written to access unrelated files, nor a race-proof filesystem sandbox against another process with the same user's access. Do not import untrusted live repositories into it by rewriting its metadata or calling fixture setup commands on live paths.

## Remaining integration

The production `worktree:create` daemon handler also applies branch/Linear policy, performs optional source sync, copies selected ignored files, prepares setup commands, reconciles ProjectStates, persists the Worktree's metadata, and returns `{project,worktreeId}`. The library only returns the existing lower-level `{branch,path,base}` through its handle. It can choose an already-present tracking ref using Node's ancestry rule, but never fetches. Copy/setup/Linear policy, automatic branch renaming, Chat/Design cleanup, event publication and persisted ownership remain the runtime adapter's work. Do not advertise this domain result as the full daemon response.

There are no standalone stage, unstage or discard production IPC commands, so this port adds none. It performs no live migration or mutation. The adapter must keep mutation admission separate from ordinary `GitReader` root admission and must never blindly replay commit or Worktree creation after losing an acknowledgement.

## Evidence

`cargo test --manifest-path experiments/rust-git/Cargo.toml` includes 15 isolated capability tests in addition to the existing 99 Node read comparisons and five focused parser/process tests. The mutation tests compare unchanged Node domain functions with Rust on separately created temporary repositories and inspect actual Git index/file/branch results. Commit object IDs and temporary root prefixes are normalized only when comparing the two independent repositories; each returned SHA is separately checked against its own repository's HEAD.

Coverage includes literal messages/filenames, binary/renamed/deleted files, staged `.milagre`, secret refusal and index restoration, unborn/detached/in-progress states, private hooks/signing failures, Unicode folder names, Worktree list/status/safe and forced removal, stale observations, detached/custom branches, offline tracking refs, destination/metadata symlinks, marker and foreign-handle refusal, active leases, and concurrent commits across Worktrees. Only fixture setup commands modify local fixture config or refs. A child-process test supplies a synthetic HOME/global-ignore configuration and proves ordinary reads retain their behavior while the private reader ignores it, keeps the owner alive and refuses changed ownership. No test fetches, pushes, opens a live profile, mutates production Git, or removes a real user directory.
