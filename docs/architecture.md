# Architecture notes

How some subsystems work, for agents changing them. Decisions live in [docs/adr](adr/).

## Task checkpoints

Undo a task's file changes from the Chat itself. Desktop and paired phones use the same checkpoints, stored locally on the owning Computer. Milagre saves one before a task starts; messages steering a running task share its checkpoint. It does not create Git commits or change the staging area.

Open **Undo changes**:

- **Desktop:** press **Esc Esc** in an idle Chat with an empty prompt, type `/undo`, or hover one of your messages and press its undo button.
- **Phone:** **⋯ › Undo changes**, or send `/undo`.

The composer turns into a list of the Chat's tasks that changed files, newest first. Pick one to see its files and what undoing does to each: **Revert** an edited file, **Delete** a file the task created, **Restore** a file it deleted. Open a file to see its diff.

1. A file edited after the task, or a task that ended without its final capture, is marked **Edited after this task**. Choose **Keep current** or **Undo** for it. Every other file in the list is undone.
2. Press **Undo N files**. This explicit confirmation is required in Ask, Auto and Full modes; neither Esc Esc nor `/undo` writes anything. If a file, exclusion rule or Worktree changed since the preview, nothing is written: the preview refreshes and asks again.
3. The Chat shows **Undid N files · Redo**. Redo previews the files the undo replaced, with the same confirmation.

Restoring waits until all Chats and subagents in the affected Worktrees finish. Only files changed during that task are candidates; unrelated later files stay in place. Shared Link Chats cover their owned Worktrees. Checkpoints survive app and daemon restarts. Interrupted checkpoints are recoverable with conservative conflict review.

Before writing, Milagre saves a recovery checkpoint, the one **Redo** previews. Use it to recover from a mistaken or partially completed restore. If a restore fails partway through, a file may be partially written. The error reports its recovery checkpoint and the number of fully restored files. External editors do not share Milagre's locks: keep them idle during the confirmed write. Milagre rechecks each target immediately before writing it, but cannot make a group of filesystem writes atomic against external programs.

### Exclusions and limits

Milagre captures regular Git-tracked files and nonignored untracked files. It excludes symlinks, hard links, Git/Milagre metadata, generated directories (`node_modules`, `dist`, `build`, `coverage`, `.next`, `.expo`, `.cache`), common secret filenames (`.env*`, credentials, private keys and package-manager credentials), and recognized private-key/token content. Filename and token checks cannot recognize every possible secret: configure Project-specific exclusions before a task.

Create `.milagre/checkpoint-ignore` in each Worktree with one relative glob per line, for example:

```
private/**
**/*.cache
config/production.json
```

Blank lines and lines starting with `#` are ignored. Rules are exclusion-only, with no negation or Git-ignore directory shorthand. Use `path/**` for directories. The checkpoint data records exclusion counts. An excluded file is never restored, including when new rules exclude a file saved by an older checkpoint.

A file over 5 MiB is excluded. One checkpoint saves at most 100 MiB across a Chat's Worktrees; past that, the largest files are excluded first, so source files stay covered. Add exclusions for large generated files to keep that room for files an agent edits. A checkpoint never blocks a task: if one can't be captured, the task runs without it. `/compact` changes no files and takes none. Checkpoints and deduplicated file contents are private to the daemon's data directory; there is currently no automatic retention limit. They are local recovery data, not a backup outside the Computer.

## Interactive designs

Agents make designs on a Chat's Designs canvas in one of two kinds, fixed for all of a design's versions:

- **Layers** (`design_show` with `document`): named layers Milagre draws. Static.
- **Interactive** (`design_show` with `html`, `width` and `height`): the agent's own HTML page, usually React compiled
  in the page by Babel, run live at that screen size.

Users don't edit designs. They view them, try interactive ones, pin comments, choose one and ask for changes through
Chat. Only agents change designs, through the design tools.

### Storage

An interactive version is `v<N>.html` beside `meta.json`, with `interactive: true` on its entry and no
`v<N>.design.json`. `design_read` returns its `html`; `design_apply` changes it with `edits` (exact text and its
replacement, in order); `design_show` with the same id and `expectedVersion` replaces it. A variant is `design_show`
with `from` and `edits`.

### Libraries and policy

`DESIGN_CODE_CSP` (packages/shared/src/artifact-document.mjs) is `ARTIFACT_CSP` plus scripts from `DESIGN_CODE_HOSTS`
(unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com, esm.sh) and `'unsafe-eval'` for Babel. The design still can't make
requests of its own (no `connect-src`, no forms). `checkDesignCode` refuses a design whose `<script src>` is off those
hosts or has no exact version (`react@18.3.1`, `/ajax/libs/gsap/3.12.5/`). The design skill gives agents the React,
ReactDOM and Babel tags with integrity hashes.

### Where it runs

| Viewer                        | How                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop canvas and chat cards | `milagre-artifact://` preview with `DESIGN_CODE_CSP` as its response header (a srcdoc frame would inherit the renderer's hash-only policy). Click the frame to use it.                                                                                                   |
| Phone Designs viewer          | The canvas page's policy is `DESIGN_CODE_CSP` (its frames inherit it); an interactive design's frame is `sandbox="allow-scripts"`, a layer design's `sandbox=""`. The Try button (`play`) hands the shown design the touches; flying away or commenting takes them back. |
| Public page                   | A sandboxed `srcdoc` frame per design; the Worker serves pages with interactive designs under a policy that allows the CDNs (`meta.code`).                                                                                                                               |
| Agent preview                 | `screenshotDesign` (packages/core/src/html-render.cjs): headless Chrome at the design's size, waits for the DOM to settle, returns the first screen, console messages and content size. Needs Chrome or Chromium; without it the design still saves.                     |

### Releasing

Deploy `apps/design-share` before a desktop release that includes this, or publishing a page with an interactive
design fails validation on the old Worker.

## Share a Designs page or Artifact

The Share action publishes every saved structured design in the current Chat as one read-only page. It has no selection of individual designs or elements. The snapshot uses the latest saved version of each design, captured together under the store queue. Unsaved editor changes, comments, Chat history and Project files are excluded.

Publishing asks for a public title and shows this notice before any upload:

> This publishes every saved design on this page. Anyone with the link can view, copy or redistribute it. Copies may remain online permanently.

Both Designs publish dialogs also explain that shared files can include content clipped by frames. The viewer uses vectors, so clipping is not a way to redact content.

Every deliberate publication creates a new immutable URL. Later local edits do not update old links. Share history can copy, open and revoke each hosted snapshot. A lost upload acknowledgement leaves a visible "Publication not confirmed" entry that can be retried or revoked. Revocation removes the hosted page and permanently refuses that ID, including delayed uploads; it cannot remove downloaded copies.

### Artifact snapshots

Artifacts publish the Chat's one current HTML page. Updating that page in place never changes an existing share URL. `kind: "artifacts"` selects this path; omitted `kind` means Designs. The host and Worker require exactly one HTML page, without an additional sharing size quota. Share histories stay separate by kind.

The public Artifact is a responsive iframe with `sandbox="allow-scripts"`. Inline interaction works in an opaque origin. Parent DOM, cookies, storage, host APIs, remote requests, forms, popups and navigation are blocked. Shared Artifacts must be self-contained; external images, fonts and scripts are not fetched or embedded. The share dialog and viewer disclose this restriction. The complete HTML is published, including any hidden content in the source, so the notice applies to the entire page.

### Implementation

- `chat-artifacts.cjs` captures the entire page without preview HTML or private envelope fields.
- `design-page-content.cjs` removes hidden subtrees before fetching images, replaces private layer IDs, removes layer names and component metadata, and resolves private token names to colors.
- `design-page-images.cjs` embeds remote raster images, checks and pins public DNS answers, validates redirects and bounds image downloads. The original saved designs stay unchanged.
- `design-page-sharing.cjs` owns private capability secrets and persistent publication history. Renderers and phones receive only public share metadata. A health check must succeed before image fetching or capability creation. It saves a capability before upload so retries can use the same ID after a restart. Publication requires a matching service acknowledgement; revocation requires HTTP 204. Upload deadlines scale with payload size, up to five minutes. Revokes bypass uploads, with only history-file mutations serialized per file.
- `@milagre/shared/design-page` validates snapshots and generates a standalone SVG canvas viewer with pan, zoom and fit. No source JSON or comments appear in public HTML. There are no per-page count, layer, text or byte quotas. The host still validates the authoring schema and embedded image formats. Validated snapshots are immutable and reuse validation during rendering.
- `apps/design-share` hosts pages on Cloudflare Durable Objects. Its 20 GiB global active-content cap counts canonical JSON plus rendered HTML. Replacements settle to the new size; revocation and expiry return the allocation. Pages expire 30 days after the last successful publication, with background alarms for deletion and refund retries. No quota or expiry counters appear in the clients. See its README for the legacy-page inventory required at deployment.

Desktop and mobile use `artifact:page-shares`, `artifact:share-page` and `artifact:revoke-page-share`. Publishing requires the literal `acknowledgePublic: true`. Each command validates its Chat and page kind. The Designs flag applies only to structured pages. `artifact:sharing-status` checks the requested kind; both UIs hide Share while publication is unavailable.

Settings > Milagre > Published pages uses owner-only `artifact:all-page-shares` and `artifact:revoke-saved-page-share`. These work after the original Chat is deleted. Unreadable history files are skipped with a host warning so other pages remain manageable. Confined demo phones cannot publish, revoke, inspect global history or query sharing status. Mobile remains review-only for design editing.

The production origin is `https://share.milagre.cloud`. Isolated runtimes can inject `designSharing.origin` and a fetch implementation for local checks. This change does not deploy the Worker or publish an app update.

### Local design MCP adapter

`packages/core/src/design-mcp-tools.cjs` exports `createDesignToolGroup({ artifacts })` for the separate local MCP service. The group has `id`, `enabled()` and `tools({ scope, assertActive })`. A scope is `{ chatId, designIds: "*" | string[], capabilities: ("read" | "write")[] }`.

The adapter exposes `design_list` and the existing structured design/comment tools. An explicit ID list rejects implicit creation and all access outside that list. Comment resolution checks the comment's owning design. Every execution rechecks connection activity and Designs enabled; reads recheck after completion before returning data. Read-only grants omit writes. Inputs reject unknown keys, so a caller cannot substitute another Chat.

Public publication is not an MCP write capability. The adapter has no publish tool, Project tool, Worktree tool or Chat management tool. The integrated local MCP service owns transport, persisted grants and client configuration. HTML Artifacts and their comments are excluded from its Designs-only scope. Queued writes recheck the grant immediately before committing.

## Window decoration

The default desktop window uses macOS traffic lights in its content, or an external native frame on Linux and Windows.
The sidebar reserves horizontal space only when window controls occupy the content. A Linux window manager hiding an
external frame does not move its controls into the content, so it does not need that reservation either.

The top bar is 44px tall. Beside the window controls it holds the sidebar toggle and the sidebar's Canvas, Search,
Routines and Filters; in Settings it holds Back and the Settings title instead. On macOS the traffic lights sit at
x 16, y 16, and the toggle starts one 16px margin after them.

To supply integrated Electron controls on Linux or Windows, launch Milagre with `--window-decoration=overlay`.
For a local checkout, use `node scripts/launch-electron.cjs --window-decoration=overlay` after building the renderer.
This hides the native title bar and enables Electron's Window Controls Overlay. The renderer uses its title-bar geometry
to keep sidebar, Changes, panels, attention and diff actions clear of controls on either edge. Geometry changes, including
fullscreen and resizing, update the layout. The native application menu remains available.

The preload exposes the local window's decoration separately from the Project's bridge. A Project on another computer
cannot change the window's layout. Mobile navigation continues to use the native toolbar and safe-area insets.
