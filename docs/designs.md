# Designs

How agents' designs are stored, where interactive ones run, and how the Artifact workspace is published.

## Two kinds

A design is one kind for all its versions:

- **Layers** (`design_show` with `document`): named layers Milagre draws. Static.
- **Interactive** (`design_show` with `html`, `width`, `height`): the agent's own HTML page, usually React compiled in the page by Babel, run live at that size.

Users don't edit designs. They view them, try interactive ones, pin comments, choose one and ask for changes in Chat. Only agents change designs, through the design tools.

An interactive version is `v<N>.html` beside `meta.json`, with `interactive: true` on its entry and no `v<N>.design.json`. `design_apply` takes `edits` (exact text and replacement, in order); `design_show` with the same id and `expectedVersion` replaces it; a variant is `design_show` with `from` and `edits`.

## Where designs live

A design belongs to the Chat that showed it: `<data dir>/artifacts/<hash of the Chat key>/<id>/` holds `meta.json` (every kept version's entry, 50 at most) beside `v<N>.html` and `v<N>.design.json`, with the Chat's comments in `comments`. Deleting the Chat deletes them (`removeChat`); archiving keeps them.

The **Project library** keeps the designs a Project wants past its Chats, on named pages ("iPhone", "Watch", "Kit"). It is `design-library.cjs`:

- **Storage.** Per Project key (`projectOfKey`, as the design kit; a Named Link's Chats share their Link's, project-less Chats share the Chats home's), under `<data dir>/design-library/`. `designs/<hash>/` is an ordinary Chat design store keyed by the Project, so versions, kinds, kits, fonts and exports behave exactly as in a Chat. `index/<sha256>.json` holds `{pages: [{id, name}], designs: {<id>: {page, edits, from}}}`: each design's page, and per kept version the Chat key, its title then and its agent's provider (`edits`, 50 at most). A page exists while a design is on it. Nothing in it belongs to a Chat, so deleting or archiving Chats leaves it.
- **In.** "Add to Project library" on a design's ⋯ menu or the page's ⋯ actions (desktop), the design's or page's actions (phone), or `design_library_add` copies the Chat's latest version onto a page, existing or new by name. The Chat's design stays as it is. The HTML page goes in as an interactive design, one tab at a time, refused while it shows files (`assets/`). Ids keep the source's id when free; a removed id is never reused.
- **Addressing.** A library design is `library:<id>`. `withDesignLibrary` routes `get`, `showDesign`, `apply`, `exportDesign` and `deleteDesign` on such ids to the library, so `design_read`, `design_inspect`, `design_apply`, `design_show` (revise with `expectedVersion`, or a variant `from` a library design onto its page), `design_export`, `design_delete`, `artifact:get` and `artifact:delete` all take them, from any Chat of the Project. A conflicting `expectedVersion` fails as in a Chat. Each save is a new library version recorded with the saving Chat. `design_show` never creates a library design from nothing, and a Chat design can't start `from` a library one.
- **Agents.** `design_library_list`, `design_library_add`, `design_library_update` (rename, which saves a version, or move to a page) and `design_library_rename_page`. Local MCP connections granted an explicit design list never reach the library; a `"*"` grant does, for its Chat's Project.
- **Clients.** `design-library:list` `{chatId}` → `{pages: [{id, name, designs}]}` and `design-library:add` `{chatId, designId, page, tab?}`. Every change emits `design-library:changed` `{projectPath}`; desktop reads the library again on it (paired computers qualify the key), and the phone bridge turns it into the `library` live signal for that Project. The Artifact panel's page menu lists the library's pages after the Chat's Canvas and HTML page; a page shows on the same canvas, with each frame saying who saved its version, and Delete there removes it from the library for every Chat. Confined demo phones may list, not add.
- **Not yet.** Comments stay per Chat: library designs take no comments or choices. A library page can't be shared as a link, a library is never shared across Projects, and the phone opens the library from a Chat that already has a design or a page.

## Live drafts

Users watch an agent design. Claude streams a tool call's input with `includePartialMessages`, and `design-drafts.cjs` turns the input of `design_show` and `design_apply` into `step-draft` events (offset, text, `done`) about every 120 ms. The desktop parses the partial JSON (`createDesignDraft`, `design-draft.mjs`) and builds the draft over the design's frame, or on a placeholder frame for a new design, under the agent's named cursor (`design-live.ts`).

Some calls arrive only whole, when they are saved, so the canvas replays them instead:

- **Claude subagents.** Claude Code streams `stream_event`s for the main agent only: it writes `parent_tool_use_id: null` on every one (checked through 2.1.329). A subagent's call shows up only once its input is complete, and saving takes about 0.1 s after 20 to 80 s of writing, so a placeholder from the call's start would show nothing.
- **Codex.** The app-server (checked on 0.170) sends `item/started` for an MCP call with its arguments already whole, and no argument deltas.
- **Antigravity and Kiro.** ACP tool calls carry their input whole.

The desktop replays a saved version layer by layer (`designReplay`) under the caller's cursor, a subagent's persona included: over the frame holding the old version for an edit, and from a blank screen for a new design saved within the last 10 s. The phone gets no agent events, only signals and saved versions, so it doesn't show drafts. A version that lands while its canvas is open fades its new and changed layers in, one after another (`designBuildHtml`, `design-build.mjs`). Reduced motion turns replays off on both.

## Script policy

`DESIGN_CODE_CSP` (`packages/shared/src/artifact-document.mjs`) is `ARTIFACT_CSP` plus scripts from `DESIGN_CODE_HOSTS` (unpkg, jsDelivr, cdnjs, esm.sh) and `'unsafe-eval'` for Babel. A design still makes no requests of its own: no `connect-src`, no forms. `checkDesignCode` refuses a `<script src>` off those hosts or without an exact version. The design skill gives agents the React, ReactDOM and Babel tags with integrity hashes.

| Viewer        | How it runs                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop       | A `milagre-artifact://` preview with `DESIGN_CODE_CSP` as its response header. Not a srcdoc frame: that would inherit the renderer's hash-only policy.                                                                    |
| Phone         | The canvas page's policy is `DESIGN_CODE_CSP` and its frames inherit it: `sandbox="allow-scripts"` for interactive, `sandbox=""` for layers. Try hands the design the touches; flying away or commenting takes them back. |
| Public page   | A sandboxed `srcdoc` frame per design; the Worker serves pages with interactive designs under a policy that allows the CDNs. The read-time viewer keeps the pointer until a design is clicked (see the Worker README).    |
| Agent preview | `screenshotDesign` (`html-render.cjs`): headless Chrome at the design's size returns the first screen, console messages and content size. Without Chrome the design still saves.                                          |

Deploy `apps/design-share` before a desktop release that changes what a design may contain, or publishing fails validation on the old Worker.

## Screen sizes

A design's sides run from `DESIGN_MIN_SCREEN` (16) to 3840 px, for layer and interactive designs and on shared pages, so watch faces, complications and Dynamic Island pieces are drawn at 1x. HTML artifact pages keep their 240 px minimum. The agent's image enlarges a small screen up to 4x (512 px on the long edge) so it stays readable; the desktop canvas zooms to 800% and the phone canvas fits a small design to the screen.

## Path layers

`type: "path"` draws vector paths: `path` (SVG path data, in the layer's pixels or `viewBox` units) or `arc` (a ring stroke, `design-path.mjs`), with fill, stroke, caps, joins and dashes. `validDesignPath` accepts path commands, numbers and separators only, so no markup, quotes, URLs or entities reach a renderer; both renderers write the path into their own `<svg><path>`. Layout treats a path as a leaf box; contrast checks report text over a path as unsupported.

## SF Symbols

An icon layer names an SF Symbol as `sf:<name>` with an optional `fontWeight`. On a Mac host, `design-host-symbols.cjs` has AppKit draw each symbol (`NSImage(systemSymbolName:)` at its weight) through `osascript -l JavaScript`, so no native module ships: the result is a white mask PNG the renderers tint with the layer's color (CSS `mask` in the saved page, an SVG `<mask>` in previews and exports). AppKit hands back symbols as bitmaps, not paths, so masks are drawn at 96 pt and stay crisp at the canvas's zoom. Without a host source (other platforms, the desktop's live drafts) and on shared pages, `designSymbolLucide` maps the symbol to the closest Lucide icon (`DESIGN_SF_SYMBOL_LUCIDE`, then the base name with variants dropped, then `circle-dashed`); `publicPageContent` writes that Lucide name before upload, under the same license rule as Apple's fonts. `MILAGRE_DESIGN_SYSTEM_FONTS=0` turns host symbols off too.

## Color modes

A color token is one color or `{light, dark?, contrast?}`; a plain value is every mode, so older documents are unchanged. Color fields add `$token/alpha` and `color-mix(in srgb, …)`, resolved by `resolveDesignColor` (`design-tokens.mjs`) to one CSS color per mode, so no renderer depends on `color-mix` support. `designHtml` writes every token-based color as a CSS variable with one value per mode under `:root[data-design-mode]`, so one saved page serves every mode: the desktop canvas and the phone add the attribute with `designHtmlForMode` when the user picks a mode (desktop: the frame's More menu; phone: the design's actions menu, on a Chat's canvas or a Project library page), and the desktop's preview images draw `designDocumentForMode`. Agents preview and contrast-check a mode with `mode` on `design_show` and `design_inspect`. Shared pages draw light: `publicPageContent` writes literal colors. Kits add `tracking` and `opacity` tokens, bound like spacing.

## Fonts

Layer designs draw Inter and the catalog families from `packages/shared` everywhere. Fonts installed on the host computer also draw in its local previews: `design-host-fonts.cjs` indexes the system and user font folders (on a Mac, Apple's hidden `SFNS*.ttf`, `SFCompact*.ttf` and `NewYork*.ttf` under their public names), and `loadDesignFonts` asks it for each text layer's face. A face is the font instanced by HarfBuzz (`subset-font`) at the layer's weight and, for an optical-size axis, its font size, cut to the bundled character set and renamed so resvg finds it. Its advances feed `designTextLayout`, so hug text measures with the real font, and the saved HTML embeds it, so the desktop canvas and the phone draw it. `design_font_info` reads the same index for agents: named weights, axes and OS/2 metrics.

License rule: Apple's families (SF Pro, SF Compact, SF Mono, New York and their variants) render only in local previews. `publicPageContent` renames them to their substitute (`designFontSubstitute`: Inter, Courier New, Source Serif 4) before upload, the share notice says so, and a host without them measures and draws the substitute. No installed font data ever leaves in a published page: the Worker renders with the bundled faces only. `MILAGRE_DESIGN_SYSTEM_FONTS=0` turns installed fonts off (tests use it for stable layouts).

## Publishing

Designs and the Chat's HTML Artifact page form one Artifact workspace, and Share publishes it as one read-only page. A share has a scope, and each scope keeps its own link per Chat:

| Scope       | Request                               | Holds                                                                     |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `workspace` | the panel's Share                     | every saved design, plus the HTML page when the Chat has one, drawn first |
| `design`    | `kind: "design"`, `designId`          | one design, published as a one-design page named after it                 |
| `artifacts` | `kind: "artifacts"`                   | the HTML page alone                                                       |
| `designs`   | no `kind` (clients before workspaces) | every design, no page. Never created by current clients                   |

- **Live and frozen links.** A link created now is `live`: every agent save in its Chat (`design_show`, `design_apply`, `design_delete`, `artifact_show`) arms a per-Chat timer, and about 3 s after the last save the host republishes each un-paused live link of that Chat under the same capability and URL, in the same queue as Share. A link whose snapshot did not change sends nothing. Links saved without `live` (every link from before workspaces, and any `designs` link) are frozen: only Share replaces them, and only under their own scope. Sharing a scope again reuses its live link; when the scope only has a frozen link, Share creates a new live link and leaves the frozen one published as it was. Old clients sharing `designs` keep replacing their frozen link.
- **Pause and resume.** `artifact:set-page-share-paused` (`{chatId, id, paused}`, owner-only) stops a live link following saves; resuming publishes the current state at once and returns the entry.
- **Failures.** An automatic update that can't reach the service (offline, Worker down, 5xx, 429) marks the entry `stale` with `lastError` and retries with backoff, 15 s doubling to 10 min; any success clears both. Other failures (validation, 413) stay stale until the next save. A 410 marks the link revoked and it stops. A `design` link whose design was deleted is marked stale with "This design was deleted." and is never retried: design ids aren't reused. At host start, stale un-paused live links are retried once in the background.
- **Notice first.** The dialog states that anyone with the link can copy the page, and that copies may stay online, before any upload. Frame clipping is not redaction: the viewer uses vectors, and a page publishes its whole HTML, hidden parts included.
- **What leaves.** The latest saved version of each design and the current HTML page with its files, captured together in the artifacts queue (`chat-artifacts-snapshot.cjs`). No comments, Chat history or Project files. `design-page-content.cjs` strips hidden subtrees, layer ids, names and token names; `design-page-images.cjs` embeds remote images with pinned public DNS answers.
- **HTML pages** render in a `sandbox="allow-scripts"` iframe with an opaque origin: no parent DOM, storage, requests, forms, popups or navigation. They must be self-contained; external images, fonts and scripts are not fetched. In a workspace with an interactive design, the page frame inherits the Worker's design-code policy (CDN scripts, `https:` images and fonts), still with no `connect-src`.
- **Capabilities.** `design-page-sharing.cjs` keeps the private capability secrets in per-Chat histories (`design-page-history.cjs`); live entries also keep their Chat id so the host can retry them after a restart. Clients only get public metadata (`DesignPageShare` in `packages/shared/src/artifact.ts`). A capability is saved before upload so a retry reuses the id, and a lost acknowledgement shows "Publication not confirmed". Revoke deletes the page and refuses that id forever, delayed uploads included.
- **Hosting.** `apps/design-share` stores pages in Durable Objects with a global content cap and an expiry 30 days after the last publication, which live updates renew. Clients show neither. See its README before deploying: the Worker must understand `workspace` snapshots before a desktop release that publishes them.
- **Commands.** `artifact:share-page` requires the literal `acknowledgePublic: true`; `artifact:page-shares`, `artifact:share-page` and `artifact:revoke-page-share` take the scope (`kind`, `designId`). Settings › Milagre › Published pages uses owner-only commands that work after the Chat is deleted. Confined demo phones can't publish, pause, revoke or read history.

## Local MCP adapter

`design-mcp-tools.cjs` exposes the design and comment tools to the [local MCP service](local-mcp.md) for one Chat and an explicit design list or `"*"`. An explicit list refuses creating new designs and anything outside it. Every call rechecks that the connection is active and Designs are enabled, reads recheck before returning, and queued writes recheck before committing. Inputs refuse unknown keys, so a caller can't name another Chat. Publishing, Projects, Worktrees, Chat management and HTML Artifacts are out of scope.
