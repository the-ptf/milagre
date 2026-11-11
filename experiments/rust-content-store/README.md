# Isolated Rust Artifact store

This crate implements the saved HTML Artifact portion of `packages/core/src/chat-artifacts.cjs`. It is backend migration work, not a replacement registered with the running daemon. The production Node owner remains the only live writer, as required by ADR-0003.

Every constructor requires `milagre_owner_store::Isolation`. It cannot open a production profile by path. The store directory is a relative descendant of that Isolation; asset sources must belong to copied Worktrees inside it. A mandatory caller-provided Chat validator rejects unknown Chats, and a mandatory active-owner callback runs before commits. `&mut self` serializes public operations; an exclusive file lock rejects a second Rust store instance.

```rust,no_run
use milagre_content_store::{ArtifactStore, SystemRuntime};
use milagre_owner_store::{Isolation, Policy};
use std::{path::Path, sync::Arc};

# fn example() -> Result<(), Box<dyn std::error::Error>> {
let isolated = Isolation::create(Path::new("/tmp/new-disposable-content-copy"), &Policy::system())?;
let mut artifacts = ArtifactStore::open(
    isolated,
    Path::new("artifacts"),
    Arc::new(|chat| {
        // The owner must supply its authoritative existing-Chat validation here.
        if chat == "/copied-project#1" { Ok(()) }
        else { Err(milagre_content_store::Error::new("Unknown Chat")) }
    }),
    Arc::new(|| Ok(())), // Replace with the isolated owner's live ownership check.
    Arc::new(SystemRuntime),
)?;
let page = artifacts.show(&serde_json::json!({
    "chatId": "/copied-project#1", "title": "Report", "html": "<p>Saved in the isolated copy.</p>"
}), &[])?;
assert_eq!(page["format"], "html");
# Ok(())
# }
```

## Implemented contract

| Rust method                                   | Production store method                     | Behavior                                                                                                                  |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list`                                        | `list`                                      | Summaries, format filtering, latest live HTML page, existing Design summaries, inline exclusion                           |
| `get`                                         | `get`                                       | Current HTML for old IDs/version references; immutable inline replies; plain saved Design source/preview reads            |
| `artifact_read`                               | `artifact_read` tool projection             | All tabs or one selected tab; no duplicate first-tab HTML                                                                 |
| `show`                                        | `show`                                      | One live page, expectedVersion conflicts, title/dimension rules, tabs that retain existing HTML, current revision pruning |
| `render`                                      | `render`                                    | New immutable inline HTML reply with validated title/height                                                               |
| `asset`                                       | `asset`                                     | Current reachable named asset, at most 256 KiB per base64 reply, offset and length checks                                 |
| `asset_path`                                  | `assetPath`                                 | Validated current asset path inside the isolated store                                                                    |
| `add_comments`, `comments`, `resolve_comment` | `addComments`, `comments`, `resolveComment` | Atomic batches, caller-provided ID deduplication, pins/tabs/layers, retained old feedback, resolution note                |

The directory layout is unchanged: `sha256(chatId)[0..32]/<id>/meta.json`, `vN.html`, optional `vN.tabs.json`, content-addressed `assets/<sha256>`, and the Chat's `comments` file. Original `<id>.json` HTML is migrated only after its version files are written. Metadata commits each revision. Old legacy HTML files remain recoverable, while previous live-page revisions and unused asset hashes are removed after a successful commit. Staging and failed temporary files are cleaned. As in Node, bytes moved into the hash directory before a failed metadata commit can remain unreferenced until the next successful prune.

The limits match the production Artifact contract: 1,000,000 UTF-16 HTML units, 20 tabs, 100 files, 95 MiB per file, 1 GiB aggregate assets, 50 comments per batch and 2,000 retained comments. Text truncation and JSON use the owner's lossless JavaScript UTF-16 representation, including unpaired surrogates. Parse requests and serialize results with `milagre_owner_store::jsjson` when exact JavaScript string semantics are required.

## Filesystem and ownership boundary

This crate never calls `Isolation::project`. It validates every relative path before creating anything, then uses retained directory descriptors with `openat(O_NOFOLLOW)`, `mkdirat`, `renameat` and `unlinkat`. Directory traversal cannot follow a replaced symlink into another location. Files are checked again after nonblocking open, so directories and FIFOs cannot masquerade as assets. Asset imports copy in 1 MiB buffers and hash the exact copied bytes. Metadata and small documents use bounded reads; exceptional oversized existing metadata/legacy JSON is rejected explicitly instead of allocating without a limit.

The lock coordinates Rust instances only. It does not make a simultaneous Node writer safe. An owner integration must preserve ADR-0003 ownership, hold its own authoritative lock, and provide the active-owner callback. This crate has no daemon listener, no profile discovery, no production writer switch, no shutdown/restart logic and no live-data migration command.

## Validation and remaining work

Run:

```sh
cargo test --manifest-path experiments/rust-content-store/Cargo.toml
cargo clippy --manifest-path experiments/rust-content-store/Cargo.toml --all-targets -- -D warnings
node_modules/.bin/oxlint experiments/rust-content-store/fixtures/generate.cjs
```

The conformance test creates a disposable Isolation, runs the actual Node `createChatArtifacts` against generated files there, and compares 39 operations plus final saved metadata, HTML bytes, asset hashes and comments against Rust. No provider mock or production data is involved. Safety tests exercise traversal/symlink refusal, FIFO and oversized input rejection, UTF-16 boundaries, exclusive writers, all-or-nothing comment batches and ownership loss before metadata commit. Each test removes its temporary copy.

Structured Design creation/editing/validation/rendering and font-transfer optimization are not ported. Public `pageSnapshot`/publishing, Mermaid/Pele injection, Design export/deletion, Chat removal, UI/remote event dispatch and daemon command registration are outside this crate. The existing application continues using Node for them. Integration should call these Rust methods only for the implemented subset; it must not report these remaining operations as successful or route live production writes here.
