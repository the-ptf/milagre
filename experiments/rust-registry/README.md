# Isolated Project registry and Link scope foundation

Read-only Rust service for synthetic or copied registry files inside an existing `milagre_owner_store::Isolation`. It never creates, refreshes, prunes, renames or writes a registry, Project, Chats home, Link store or Worktree. Node remains the sole production owner. This crate is not wired into the runtime or installed app.

## Runtime-facing API

- `Registry::open(isolation, profile_relative_path, active)` requires an existing non-symlink directory inside the marked isolation. It pins Unix device/inode identities of both the isolation root and profile. `active` is an owner-provided, thread-safe nonblocking snapshot check; it must not perform actor RPC. No default profile discovery exists.
- `registry.snapshot()` implements `createProjectRegistry(...).snapshot()` filtering and preserves saved ordering/unknown fields. Missing/corrupt JSON produces the same empty snapshot as Node. `recent()` implements the recent menu's normalization, first-duplicate retention, existing-folder filtering and ten-item cap. Neither is authorization by itself.
- `registry.identify(path).await` returns Node-shaped `{id,path,name,git}` identity and active Worktrees. Git Projects use the canonical common Git directory and main checkout; linked Worktrees and subfolders resolve to that same identity. Plain folders use their real path. Folder-only Chats homes honor `.milagre-folder-chats` and enumerate valid `.chat-folders/chat-...` directories. Identity discovery alone admits nothing.
- `snapshot.project(path).await` mints an opaque `ProjectGrant` only when the discovered identity's id and canonical main path match a saved registry entry. `contains_folder(path).await` rechecks identity and admits only exact active roots, never arbitrary descendants. A real path alias of an admitted root works. A plain subfolder is its own identity and needs its own registry entry.
- `snapshot.link(id).await` mints a `LinkGrant` only for a saved valid named ProjectGroup with every member freshly resolved. `link.check().await` checks the saved generation and each current member. `snapshot.reachable(&project_grant, worktree).await` resolves one-hop canvas Links using fresh registered identities and active Worktrees, returns `LinkedGrant`s carrying the reaching Link IDs, and never uses arbitrary caller-supplied paths as grants. `LinkedGrant::check().await` revalidates the exact target. Any registry byte change or owner revocation invalidates retained grants; callers reacquire rather than silently widening a stale scope.

Metadata accessors return previously observed records, not permanent authorization. Use the checks immediately before the runtime's operation and retain the runtime's own transactional owner checks; this library cannot make a later filesystem operation atomic with discovery. No `ProjectGrant` is constructed from a raw string, arbitrary JSON or a caller-provided active map.

`links` contains pure Node ports of group validity, endpoint compatibility, prune previews, named-Link member lookup and one-hop reachability. `scopes` ports shared Project/Link/computer/Chat key parsing. These functions intentionally accept evidence values and return metadata. They do not mint filesystem capabilities. Remote-computer scope strings can be parsed, but this local reader never executes a remote request.

## Bounds and containment

Native capability access currently targets Unix file identities and `/usr/bin/git`; tested on macOS arm64. Scope-key parsing includes the production Windows path syntax, but native Windows identity discovery is not ported.

Registry JSON files are at most 4 MiB and 4,096 saved Projects/Links; recent input has the same entry bound. Files must be regular, singly linked, opened with `O_NOFOLLOW`, and unchanged during the read. Profiles and isolation roots cannot be replaced or aliased after opening. An input path is canonicalized and refused outside the isolation before its contents are read. Project/grant identity is checked against the saved registry, not just containment.

Git identity probes use fixed read-only commands, a cleared environment, no global/system config, `GIT_OPTIONAL_LOCKS=0`, no hooks/fsmonitor, a discovery ceiling at the isolation, a 3-second timeout per command and 1 MiB per output pipe. Git directories and `commondir` pointers must remain inside the isolation. Metadata traversal is capped at 4,096 entries and refuses symlinks, hard links and config includes. These restrictions deliberately reject large or complex copied repositories instead of treating unreadable Git as a plain folder. Up to eight probes per Registry can run; synchronous filesystem work stays on blocking workers. `snapshot()` and `recent()` are synchronous and should run on the owner's blocking worker. Cancelling a probe does not write or replay anything; its bounded read worker finishes and releases its permit.

Canvas capability discovery inspects at most 64 relevant Projects. Missing targets are excluded; a missing member of a named Link is an error. Malformed saved edges never create a capability. Replacing filesystem objects between checks is outside this snapshot foundation's guarantees; a production owner still needs guarded file operations and authoritative opened-state/Chat ownership.

## Node conformance and failure tests

`fixtures/node.cjs` invokes the real production modules on freshly generated folders, a Git repository and linked Worktree, a folder-only Chats home, symlink aliases and saved JSON variants. It writes setup files only inside the test's new Isolation. Tests compare **332 actual Node results** for registry/recent reads, identity/Worktrees, named membership, capability reachability, endpoint rules, pruning, one-hop Link aggregation, Unicode group validity and shared scope/computer keys. A recursive before/after snapshot verifies every fixture file byte, directory and symlink target stays unchanged during Rust reads.

Five boundary tests cover wrong saved identities, nonregistered folders, exact-root versus descendant scope, unavailable Link members, revocation and registry generation changes, retained Linked grants after edge removal, registry file symlinks/hard links, escaping Git-directory pointers, copied-file size bounds and profile directory replacement. All six tests pass; clippy with warnings denied, rustfmt, oxlint and oxfmt pass.

```sh
cargo test --manifest-path experiments/rust-registry/Cargo.toml
cargo clippy --manifest-path experiments/rust-registry/Cargo.toml --all-targets -- -D warnings
node_modules/.bin/oxlint experiments/rust-registry/fixtures/node.cjs
```

## Inventory and remaining migration work

The existing Node services have distinct responsibilities that must stay separate:

| Production source                          | This checkpoint                                                     | Still Node / not implemented                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-registry.cjs`                     | Saved `snapshot` filtering and generation-bound lookup              | `list` first scan and stale-entry cleanup write, add/reorder, positions, Link/group mutation, write queue and atomic rename recovery                                    |
| `project-identity.cjs`, `git/client.cjs`   | Native plain/Git/folder-home identity and active Worktree discovery | Missing-Git fallback nuances, old Git without `worktree list -z`, Windows paths, bare repos, large metadata and include-config repositories                             |
| `recent-projects.cjs`                      | Saved menu list                                                     | add/forget, remember/open/launch/switch policy and save failure handling                                                                                                |
| `chats-home.cjs`, `chats-home-folders.cjs` | Existing folder-home identity and Worktree listing                  | Home `ensure`, Git init/empty commit, folder creation, launch fallback and ownership                                                                                    |
| `project-links.cjs`, `project-groups.cjs`  | Pure saved validation, membership and one-hop reads                 | UUID-producing mutation, restoration/undo, active-state pruning persistence and group edits                                                                             |
| `linked-worktrees.cjs`                     | Registered one-hop scope foundation                                 | Chat-owned bindings, grants to extra Projects, shared-Chat restrictions, transcript reads, delegation/negotiation, hosted/remote targets, cached active-state lifecycle |
| `link-workspaces.cjs`                      | Existing named-member availability semantics                        | Preparation/session store, reservation, branch policy, setup review, alias manifests, restart recovery, release/removal and ownership                                   |
| `runtime.cjs:knownFolder`                  | Exact registered-root capability primitives                         | Full rule combining opened scopes, Chat Worktrees, Link workspaces and recent entries. The registry alone does not reproduce that runtime authorization rule.           |

`Registry::snapshot` intentionally does not emulate Node's mutating `list()`. No writer has been added because one-owner copied-store acquisition, atomic failure recovery and runtime capability invalidation need their own contract and tests. This checkpoint does not claim Project/Link migration completion, live profile compatibility or installed WebKit coverage. JSON/I/O/Git failure text and strict containment refusals can differ from Node outside the tested successful read contracts.
