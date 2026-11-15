# Designs

How agents' designs are stored, where interactive ones run, and how Designs pages and Artifacts are published.

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
| Public page   | A sandboxed `srcdoc` frame per design; the Worker serves pages with interactive designs under a policy that allows the CDNs.                                                                                              |
| Agent preview | `screenshotDesign` (`html-render.cjs`): headless Chrome at the design's size returns the first screen, console messages and content size. Without Chrome the design still saves.                                          |

Deploy `apps/design-share` before a desktop release that changes what a design may contain, or publishing fails validation on the old Worker.

## Publishing

Share publishes every saved structured design in the Chat as one read-only page, or for Artifacts (`kind: "artifacts"`) the Chat's one current HTML page. There is no per-design selection. Each publication is a new immutable URL; later edits never change an old link. Share histories are kept per kind.

- **Notice first.** The dialog asks for a public title and states that anyone with the link can copy the page and copies may stay online, before any upload. Frame clipping is not redaction: the viewer uses vectors, and an Artifact publishes its whole HTML, hidden parts included.
- **What leaves.** The latest saved version of each design, captured together. No comments, Chat history or Project files. `design-page-content.cjs` strips hidden subtrees, layer ids, names and token names; `design-page-images.cjs` embeds remote images with pinned public DNS answers.
- **Artifacts** render in a `sandbox="allow-scripts"` iframe with an opaque origin: no parent DOM, storage, requests, forms, popups or navigation. They must be self-contained; external images, fonts and scripts are not fetched.
- **Capabilities.** `design-page-sharing.cjs` keeps the private capability secrets; clients only get public metadata. A capability is saved before upload so a retry reuses the id, and a lost acknowledgement shows "Publication not confirmed". Revoke deletes the page and refuses that id forever, delayed uploads included.
- **Hosting.** `apps/design-share` stores pages in Durable Objects with a global content cap and an expiry after the last publication. Clients show neither. See its README before deploying.
- **Commands.** `artifact:share-page` requires the literal `acknowledgePublic: true`. Settings › Milagre › Published pages uses owner-only commands that work after the Chat is deleted. Confined demo phones can't publish, revoke or read history.

## Local MCP adapter

`design-mcp-tools.cjs` exposes the design and comment tools to the [local MCP service](local-mcp.md) for one Chat and an explicit design list or `"*"`. An explicit list refuses creating new designs and anything outside it. Every call rechecks that the connection is active and Designs are enabled, reads recheck before returning, and queued writes recheck before committing. Inputs refuse unknown keys, so a caller can't name another Chat. Publishing, Projects, Worktrees, Chat management and HTML Artifacts are out of scope.
