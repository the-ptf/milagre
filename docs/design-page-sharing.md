# Share a Designs page or Artifact

The Share action publishes every saved structured design in the current Chat as one read-only page. It has no selection of individual designs or elements. The snapshot uses the latest saved version of each design, captured together under the store queue. Unsaved editor changes, comments, Chat history and Project files are excluded.

Publishing asks for a public title and shows this notice before any upload:

> This publishes every saved design on this page. Anyone with the link can view, copy or redistribute it. Copies may remain online permanently.

Both Designs publish dialogs also explain that shared files can include content clipped by frames. The viewer uses vectors, so clipping is not a way to redact content.

Every deliberate publication creates a new immutable URL. Later local edits do not update old links. Share history can copy, open and revoke each hosted snapshot. A lost upload acknowledgement leaves a visible "Publication not confirmed" entry that can be retried or revoked. Revocation removes the hosted page and permanently refuses that ID, including delayed uploads; it cannot remove downloaded copies.

## Artifact snapshots

Artifacts publish the Chat's one current HTML page. Updating that page in place never changes an existing share URL. `kind: "artifacts"` selects this path; omitted `kind` means Designs. The host and Worker require exactly one HTML page, without an additional sharing size quota. Share histories stay separate by kind.

The public Artifact is a responsive iframe with `sandbox="allow-scripts"`. Inline interaction works in an opaque origin. Parent DOM, cookies, storage, host APIs, remote requests, forms, popups and navigation are blocked. Shared Artifacts must be self-contained; external images, fonts and scripts are not fetched or embedded. The share dialog and viewer disclose this restriction. The complete HTML is published, including any hidden content in the source, so the notice applies to the entire page.

## Implementation

- `chat-artifacts.cjs` captures the entire page without preview HTML or private envelope fields.
- `design-page-content.cjs` removes hidden subtrees before fetching images, replaces private layer IDs, removes layer names and component metadata, and resolves private token names to colors.
- `design-page-images.cjs` embeds remote raster images, checks and pins public DNS answers, validates redirects and bounds image downloads. The original saved designs stay unchanged.
- `design-page-sharing.cjs` owns private capability secrets and persistent publication history. Renderers and phones receive only public share metadata. A health check must succeed before image fetching or capability creation. It saves a capability before upload so retries can use the same ID after a restart. Publication requires a matching service acknowledgement; revocation requires HTTP 204. Upload deadlines scale with payload size, up to five minutes. Revokes bypass uploads, with only history-file mutations serialized per file.
- `@milagre/shared/design-page` validates snapshots and generates a standalone SVG canvas viewer with pan, zoom and fit. No source JSON or comments appear in public HTML. There are no per-page count, layer, text or byte quotas. The host still validates the authoring schema and embedded image formats. Validated snapshots are immutable and reuse validation during rendering.
- `apps/design-share` hosts pages on Cloudflare Durable Objects. Its 20 GiB global active-content cap counts canonical JSON plus rendered HTML. Replacements settle to the new size; revocation and expiry return the allocation. Pages expire 30 days after the last successful publication, with background alarms for deletion and refund retries. No quota or expiry counters appear in the clients. See its README for the legacy-page inventory required at deployment.

Desktop and mobile use `artifact:page-shares`, `artifact:share-page` and `artifact:revoke-page-share`. Publishing requires the literal `acknowledgePublic: true`. Each command validates its Chat and page kind. The Designs flag applies only to structured pages. `artifact:sharing-status` checks the requested kind; both UIs hide Share while publication is unavailable.

Settings > Milagre > Published pages uses owner-only `artifact:all-page-shares` and `artifact:revoke-saved-page-share`. These work after the original Chat is deleted and while Designs is off. Unreadable history files are skipped with a host warning so other pages remain manageable. Confined demo phones cannot publish, revoke, inspect global history or query sharing status. Mobile remains review-only for design editing.

The production origin is `https://share.milagre.cloud`. Isolated runtimes can inject `designSharing.origin` and a fetch implementation for local checks. This change does not deploy the Worker or publish an app update.

## Local design MCP adapter

`packages/core/src/design-mcp-tools.cjs` exports `createDesignToolGroup({ artifacts })` for the separate local MCP service. The group has `id`, `enabled()` and `tools({ scope, assertActive })`. A scope is `{ chatId, designIds: "*" | string[], capabilities: ("read" | "write")[] }`.

The adapter exposes `design_list` and the existing structured design/comment tools. An explicit ID list rejects implicit creation and all access outside that list. Comment resolution checks the comment's owning design. Every execution rechecks connection activity and Designs enabled; reads recheck after completion before returning data. Read-only grants omit writes. Inputs reject unknown keys, so a caller cannot substitute another Chat.

Public publication is not an MCP write capability. The adapter has no publish tool, Project tool, Worktree tool or Chat management tool. The integrated local MCP service owns transport, persisted grants and client configuration. HTML Artifacts and their comments are excluded from its Designs-only scope. Queued writes recheck the grant immediately before committing.
