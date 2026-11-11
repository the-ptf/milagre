# Native content MCP dispatcher

This isolated library runs the retained Design and Artifact tool definitions without Milagre's Node MCP server or Node SDK. It is not registered with a provider or runtime, starts no listener, and cannot open a live profile. The production host remains the sole live writer.

## API and owner contract

`Dispatcher::open(isolation, artifact_relative_path, kit_relative_path, caller, runtime, raster)` owns the existing native `ArtifactStore` and `DesignKits` implementations. `Caller` is a trusted owner-supplied value: explicit Chat id, Project identity, admitted Worktree roots, read/write permissions, separate HTML/Design/kit grants, Design id scope, bundled skill directory and `assert_active`. No MCP argument can replace these values. The grants remain fixed for that dispatcher; `assert_active` must check both owner identity and any connection revocation on every call. It is also installed in the underlying stores, which recheck it before commits.

- `list()` returns the implemented and granted descriptions, input schemas and `readOnlyHint` annotations.
- `call(name, arguments).await` returns MCP `{content, isError}`, including native PNG image blocks.
- `dispatch(frame).await` accepts one complete JSON-RPC frame and returns response bytes, or `None` for a valid notification.
- `storage_fault()` exposes the latched cause after unsafe files, corrupt storage or I/O failures. Subsequent calls stop. Ordinary missing ids and version conflicts do not latch.

The full grant advertises 14 tools: `design_show`, `design_read`, `design_inspect`, `design_validate`, `design_apply`, `design_export`, `design_list`, `design_kit_read`, `design_kit_save`, `artifact_show`, `artifact_read`, `artifact_list`, `artifact_comments`, `artifact_resolve_comment`. `design_delete` is excluded because the native content store has not implemented it. Browser, voice, publishing and unrelated tools are absent.

`Dispatcher` owns exclusive store handles and currently binds them to one Chat. Do not open it alongside the runtime's existing ArtifactStore on the same directory. Multi-Chat/provider integration must move these dispatch methods onto the runtime's shared serialized content owner and preserve per-call authorization at every commit. That integration is intentionally still pending. The dispatcher and its futures are `Send`, but synchronous layout, schema and storage operations should execute on the owner's dedicated worker, not a shared async I/O executor. There is no cross-Chat concurrency scheduler here.

## Existing behavior preserved

`src/contract.json` is generated from actual `artifactToolDefinitions`, `htmlArtifactToolDefinitions`, `designKitToolDefinitions` and the local Designs group's `design_list`. Descriptions replace only the installation-dependent bundled-skill directory. The advertised schemas remain exactly Node's JSON Schema; a separate generated parsing snapshot records Zod's strict/strip/passthrough behavior. The Rust interpreter rejects unsupported schema keywords, enforces strict top-level arguments, handles record keys, discriminated alternatives, integer bounds and installed Zod's Unicode code-point string limits. Unknown fields in open layer inputs still reach the stricter native Design engine, as in production.

Show/apply commit fresh native HTML before computing feedback. Feedback preserves summary JSON on the first line, warning limits, intent-specific guidance, font/glyph limitations, remote-image notes and PNG blocks. A failed or unavailable preview adds the existing warning and does not undo an already saved version. Inspection includes bounds, crop, diagnostics and preview limitations. JSON/SVG exports, validation, pinned kits, tab selection and comments use the native store, with the existing version/conflict rules. PNG compression bytes may differ; decoded pixels match the Node WASM renderer in tests.

The helper binary is `milagre-design-raster`, built from the content-store helper entry point. Pass a trusted absolute executable path in one shared `RasterRenderer`; never accept a helper path from a tool argument. A `None` renderer deliberately exercises production's saved-version/failed-preview behavior, with an explicit unavailable-helper message. Packaging the helper and connecting tool images to the provider remain integration work.

Scoped Designs filter discovery, saved ids and comments. This implementation also checks `from.id` when copying a variant; current Node checks only the target id, so Rust deliberately prevents copying an out-of-scope source. Worktree roots must resolve to directories inside the Isolation. Their canonical location is rechecked with the caller's guard, so replacing a root with an outside symlink stops later requests. This is not protection from arbitrary external filesystem changes between individual syscalls.

## Protocol and limits

The dispatcher implements `initialize`, `ping`, `tools/list` and `tools/call`, with production protocol versions `2025-03-26` and `2025-06-18` and serverInfo `{name:"milagre",version:"1"}`. Unsupported requested versions negotiate to `2025-06-18`. Unknown tools return the existing tool-error content; unknown methods return `-32601`. No resources or prompt capability is advertised.

Frames are limited to 1 MiB, except Design show/apply at 6,000,000 + 64 KiB. Replies are capped at 32 MiB. Input parsing retains lone UTF-16 surrogates through the existing `jsjson` representation. Nested schema interpretation stops at depth 80; JSON parsing has its existing recursion limit. Calls are serialized through `&mut Dispatcher`; the native raster helper separately bounds its queue and process lifetime.

There is no HTTP, stdio, bearer-token, grant registry or Claude/Codex transport adapter. Thus malformed frames produce ordinary JSON-RPC parse/invalid-request errors instead of the Node HTTP server's empty 400 response; oversize requests produce `-32000` without an HTTP status. The future transport must enforce authentication, framing, connection revision, HTTP headers or provider-specific routing before calling this library. It must not replay a call after cancellation: a write may already have committed before PNG feedback finishes.

## Verification and gaps

```sh
cargo test --manifest-path experiments/rust-tools/Cargo.toml
cargo clippy --manifest-path experiments/rust-tools/Cargo.toml --all-targets -- -D warnings
node_modules/.bin/oxlint experiments/rust-tools/fixtures/*.cjs
```

Seven tests currently pass. The conformance fixture executes 63 calls through Node's actual command dispatcher and actual content/kit stores in a temporary Isolation. It compares tool success/error shapes, text lines, parsed JSON values and decoded PNG pixels, including create/edit/variant/inspect/export/validate, kit conflicts, HTML tabs, comment resolution, field errors and supplementary Unicode. One comment snapshot is seeded from Node's real `addComments` output to represent a user-authored comment. Generated schemas, descriptions, annotations and source hashes are checked against current Node every run. No network server, provider turn or production data is involved.

Boundary tests cover protocol negotiation, notifications, unknown tools/methods, malformed and oversized frames, UTF-16 request ids, unsupported-tool discovery, read-only grants, allowed/forbidden Design ids and comments, cross-Chat argument rejection, variant-source containment, grant revocation, swapped Worktree roots, corrupt-storage latching and `Send` compatibility for an owner actor.

Remaining limits: the 63-call fixture is not exhaustive; native Design-engine structural error wording can still differ from Zod's complete diagnostic envelope (the content-store README documents this). HTTP and SDK-adapter interoperability, shared owner integration, multi-Chat scheduling, desktop/mobile events and installed WebKit behavior are not verified by these tests. No user-facing service is advertised as migrated because this library passes.
