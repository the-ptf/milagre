# Designs

How agents' designs are stored, where interactive ones run, and how the Artifact workspace is published.

## Two kinds

A design is one kind for all its versions:

- **Layers** (`design_show` with `document`): named layers Milagre draws. Static.
- **Interactive** (`design_show` with `html`, `width`, `height`): the agent's own HTML page, usually React compiled in the page by Babel, run live at that size.

Users don't edit designs. They view them, try interactive ones, pin comments, choose one and ask for changes in Chat. Only agents change designs, through the design tools.

An interactive version is `v<N>.html` beside `meta.json`, with `interactive: true` on its entry and no `v<N>.design.json`. `design_apply` takes `edits` (exact text and replacement, in order); `design_show` with the same id and `expectedVersion` replaces it; a variant is `design_show` with `from` and `edits`.

## Script policy

`DESIGN_CODE_CSP` (`packages/shared/src/artifact-document.mjs`) is `ARTIFACT_CSP` plus scripts from `DESIGN_CODE_HOSTS` (unpkg, jsDelivr, cdnjs, esm.sh) and `'unsafe-eval'` for Babel. A design still makes no requests of its own: no `connect-src`, no forms. `checkDesignCode` refuses a `<script src>` off those hosts or without an exact version. The design skill gives agents the React, ReactDOM and Babel tags with integrity hashes.

| Viewer        | How it runs                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop       | A `milagre-artifact://` preview with `DESIGN_CODE_CSP` as its response header. Not a srcdoc frame: that would inherit the renderer's hash-only policy.                                                                    |
| Phone         | The canvas page's policy is `DESIGN_CODE_CSP` and its frames inherit it: `sandbox="allow-scripts"` for interactive, `sandbox=""` for layers. Try hands the design the touches; flying away or commenting takes them back. |
| Public page   | A sandboxed `srcdoc` frame per design; the Worker serves pages with interactive designs under a policy that allows the CDNs. The read-time viewer keeps the pointer until a design is clicked (see the Worker README).    |
| Agent preview | `screenshotDesign` (`html-render.cjs`): headless Chrome at the design's size returns the first screen, console messages and content size. Without Chrome the design still saves.                                          |

Deploy `apps/design-share` before a desktop release that changes what a design may contain, or publishing fails validation on the old Worker.

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
