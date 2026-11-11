# Isolated Rust content store

This crate implements saved HTML Artifacts and structured Design source revisions from `packages/core/src/chat-artifacts.cjs`. It is backend migration work, not a replacement registered with the running daemon. The production Node owner remains the only live writer, as required by ADR-0003.

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

| Rust method                                   | Production store method                     | Behavior                                                                                                                                |
| --------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                        | `list`                                      | Summaries, format filtering, latest live HTML page, existing Design summaries, inline exclusion                                         |
| `get`                                         | `get`                                       | Current HTML for old IDs/version references; immutable inline replies; saved Design source/preview reads and hashed font-cache transfer |
| `artifact_read`                               | `artifact_read` tool projection             | All tabs or one selected tab; no duplicate first-tab HTML                                                                               |
| `show`                                        | `show`                                      | One live page, expectedVersion conflicts, title/dimension rules, tabs that retain existing HTML, current revision pruning               |
| `render`                                      | `render`                                    | New immutable inline HTML reply with validated title/height                                                                             |
| `asset`                                       | `asset`                                     | Current reachable named asset, at most 256 KiB per base64 reply, offset and length checks                                               |
| `asset_path`                                  | `assetPath`                                 | Validated current asset path inside the isolated store                                                                                  |
| `add_comments`, `comments`, `resolve_comment` | `addComments`, `comments`, `resolveComment` | Atomic batches, caller-provided ID deduplication, pins/tabs/layers, retained old feedback, resolution note                              |

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

## Structured Design source engine

`design::validate_document(&Value)` checks the saved schema, tree references, colors, image URLs, fonts and icon names. It resolves pinned-kit colors, spacing, radii and text styles, then expands reusable component instances into the same ordinary saved layers as Node. `design::apply_operations(document, operations, intent)` implements document patches, insert, update, delete, duplicate, unset, detach and replacement. It validates the whole batch before applying it to a clone, preserves layer order, protects generated instance children and detaches only the bindings affected by explicit inspector edits. `design::validate_consistency` enforces strict kit policy, exact exceptions, palette matching and typography rules.

The structural schema and icon/color catalogs are a generated snapshot of production sources in `src/design/contract.json`. Tests compare both that snapshot and source hashes with the current Node modules. The Rust interpreter fails on unsupported schema keywords. Custom refinements are implemented separately. Unknown saved fields are retained by `get` for recovery; edits reject them exactly as Node's strict saved schema does. Structural errors carry field paths but use concise Rust wording rather than reproducing Zod's entire diagnostic envelope. Domain errors and strict kit diagnostics are compared with Node. The installed Zod string limits count Unicode code points; document JSON limits and saved title/group truncation use JavaScript UTF-16 semantics.

Design persistence requires two phases:

1. `prepare_design_show(request, read_kit)` validates a new document, an expected-version replacement, or a variant from a retained saved revision. `prepare_design_apply(request, read_kit)` applies an expected-version batch. Both return an immutable `PreparedDesign`; `document()`, `id()` and `version()` expose its render input and identity.
2. `commit_design(prepared, read_kit, renderer)` checks the current version, active owner and authoritative kit snapshot again. The mandatory renderer receives that exact document and must return fresh HTML with its required fonts. Only then are `vN.html` and `vN.design.json` written, followed by the atomic `meta.json` commit. Failures remove the uncommitted pair. The latest 50 source/preview revisions remain; older pairs are pruned only after a successful commit.

`read_kit` has type `Fn(&Value) -> Result<Value>` and receives `{chatId, id, version}`. It must read the Project's authoritative saved kit snapshot. It is mandatory even when a particular document has no kit; documents without kits do not invoke it. `renderer` has type `Fn(&Value) -> Result<String>` and is a trusted integration boundary, not a client-supplied HTML field. `design::render_html` is the native Rust implementation for this callback. There is no placeholder renderer; a different renderer that is unavailable must return an error. Returned HTML is bounded to 64 MiB; source is bounded by the production 1,000,000-character rule. All reads and commits use the same descriptor and ownership protections as HTML Artifacts.

The Design tests generate 78 source/operation cases with production `validateDesignDocument`, `applyDesignOperations` and `validateDesignConsistency`. Another 69 store actions use the actual Node store and `loadDesignFonts`/`designHtml`, including variants, optimistic conflicts, pinned-kit mismatch, policy inheritance, archived source/preview reads and the 50-revision cap. Rust results and every saved source/HTML file are compared. Additional tests cover stale prepared revisions, renderer failure, kit changes, ownership loss immediately before metadata commit, unknown future fields and symlink refusal. These fixtures use disposable Isolations only.

```sh
cargo test --manifest-path experiments/rust-content-store/Cargo.toml --test design
node experiments/rust-content-store/fixtures/design.mjs contract > /tmp/current-design-contract.json
node_modules/.bin/oxlint experiments/rust-content-store/fixtures/design.mjs
```

## Native kit service and HTML renderer

`design::DesignKits::open(Isolation, relative_path, ProjectForChat, ActiveCheck)` opens the separate Project kit store. `ProjectForChat` must resolve only admitted Chats to their authoritative Project identity. `read` and `save` use the production `{chatId, id?, version?}` and `{chatId, id?, expectedVersion, kit}` requests. Missing kits return `null`; missing pinned versions and optimistic conflicts fail. The files remain `sha256(project)/<id>.json`, each an array of at most 100 immutable snapshots. Saving a newer kit never rewrites an existing Design's pinned snapshot. Kit schemas, template roots and the 250,000-character cap match the shared engine. Reads and writes reject symlinks, multiply-linked or nonregular files. An active-owner check runs before each atomic commit.

The native renderer is `design::render_html(&document)`, usable directly as the `commit_design` callback. It validates and expands the source, computes free/horizontal/vertical layout, hug/fill sizing, minimum constraints, alignment and justification, and wraps text using the same measured advances. It embeds the used Inter/catalog font faces, emits escaped HTML layers and inline SVG icons, and enforces the production 8 MiB output budget. It performs no network or filesystem access. `render_html_with_options` retains the existing selected-layer outline and sandboxed iframe controller; it preserves paint order in the controller's bounds. `layout` exposes computed geometry.

The font tables, 36 catalog families, icon paths and existing iframe controller are a roughly 4.8 MiB generated data snapshot in `render-data.json`. Runtime code parses it once; it never starts Node or executes JavaScript to produce HTML. The generator is a development tool, and tests check it against production sources. Unicode normalization and grapheme segmentation use Rust libraries; the conformance set includes combining marks, emoji sequences and several scripts. The caller still wraps the output with the existing Artifact CSP and uses an opaque-origin iframe. This renderer does not grant native bridge access.

Verification now includes 114 Node kit-store actions, a complete native kit-reader/renderer/Design-commit path, and 71 render cases covering all catalog families, layout modes, the interactive controller and output-budget rejection. The successful renderer cases match production HTML bytes and geometry. Two read-only copies of actual saved Designs (720 by 720, 83 layers each) also matched their saved HTML byte for byte. Background Chromium captures of those two pairs had zero differing pixels, loaded all three Inter faces and had no broken images or console errors. Those captures are private test evidence outside Git; this is same-engine preview parity, not a new cross-engine WebKit comparison.

```sh
cargo test --manifest-path experiments/rust-content-store/Cargo.toml --test kits --test render
cargo run --manifest-path experiments/rust-content-store/Cargo.toml --example design-preview < design.json > preview.html
```

Stored faults expose `UNSAFE_FILE`, `INVALID_CONTENT_STORAGE` or `IO_ERROR`; ordinary missing assets and invalid caller offsets remain domain errors. Runtime owners can stop after a genuine storage failure without treating a stale asset name as an ownership fault.

## SVG exports, diagnostics and font transfer

`design::render_svg(document, options)` produces the existing SVG geometry, escaped text, icons, image placeholders, clipping and optional embedded fonts. It accepts `embedFonts`, `onCanvasOnly` and `renderByteLimit`; the caller may lower the byte limit but cannot raise it beyond the production default of 8 MiB. `ArtifactStore::export_design` matches agent JSON/SVG export names, MIME types and content, including nonembedded SVG fonts. The desktop may use `render_svg` directly with embedded fonts.

`design::diagnostics` reports clipped text, overflow, off-canvas layers, remote images, contrast checks and kit drift with their measured bounds and suggested changes. `warning_text` formats the existing readable warning summary. `document_diff` returns compatible source operations and falls back to a whole-document replacement when a smaller batch cannot preserve the document exactly. These are pure functions; they neither save changes nor claim a raster inspection result.

Saved Design reads accept `fonts.have`. Only the known generated HTML head is optimized: it is returned without the font style block, with its SHA-256 `fontKey`, plus `fontCss` on a cache miss. Custom or legacy HTML remains self-contained. Stored kit schema violations are classified as `INVALID_CONTENT_STORAGE`, preserving their issue paths; invalid requested versions remain ordinary domain errors.

The SVG suite compares 144 generated outputs byte for byte with production, including all catalog font families and both embedded-font modes. Diagnostics and diff fixtures compare warnings, measurements, suggestions, contrast checks and operation arrays with the shared Node modules; floating-point contrast ratios allow a 1e-12 tolerance. Store tests compare font-cache hit/miss responses and JSON/SVG exports with Node. The full crate has 22 passing tests.

## Remaining boundaries

Layout-aware edit intent still explicitly returns `UNSUPPORTED_DESIGN_INTENT`; its before/after diagnostics and fit-text policy checks are not ported. Native raster previews and image resizing remain unimplemented. Public `pageSnapshot`/publishing, Mermaid/Pele injection, Design deletion, Chat removal, UI/remote event dispatch and daemon command registration are also outside this crate. Integration must preserve the single live owner, provide authoritative kit access and call only implemented operations. There is no live-data writer switch here.
