# Interactive designs

Agents make designs on a Chat's Designs canvas in one of two kinds, fixed for all of a design's versions:

- **Layers** (`design_show` with `document`): named layers Milagre draws. Static.
- **Interactive** (`design_show` with `html`, `width` and `height`): the agent's own HTML page, usually React compiled
  in the page by Babel, run live at that screen size.

Users don't edit designs. They view them, try interactive ones, pin comments, choose one and ask for changes through
Chat. Only agents change designs, through the design tools.

## Storage

An interactive version is `v<N>.html` beside `meta.json`, with `interactive: true` on its entry and no
`v<N>.design.json`. `design_read` returns its `html`; `design_apply` changes it with `edits` (exact text and its
replacement, in order); `design_show` with the same id and `expectedVersion` replaces it. A variant is `design_show`
with `from` and `edits`.

## Libraries and policy

`DESIGN_CODE_CSP` (packages/shared/src/artifact-document.mjs) is `ARTIFACT_CSP` plus scripts from `DESIGN_CODE_HOSTS`
(unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com, esm.sh) and `'unsafe-eval'` for Babel. The design still can't make
requests of its own (no `connect-src`, no forms). `checkDesignCode` refuses a design whose `<script src>` is off those
hosts or has no exact version (`react@18.3.1`, `/ajax/libs/gsap/3.12.5/`). The design skill gives agents the React,
ReactDOM and Babel tags with integrity hashes.

## Where it runs

| Viewer                        | How                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop canvas and chat cards | `milagre-artifact://` preview with `DESIGN_CODE_CSP` as its response header (a srcdoc frame would inherit the renderer's hash-only policy). Click the frame to use it.                                                                                                   |
| Phone Designs viewer          | The canvas page's policy is `DESIGN_CODE_CSP` (its frames inherit it); an interactive design's frame is `sandbox="allow-scripts"`, a layer design's `sandbox=""`. The Try button (`play`) hands the shown design the touches; flying away or commenting takes them back. |
| Public page                   | A sandboxed `srcdoc` frame per design; the Worker serves pages with interactive designs under a policy that allows the CDNs (`meta.code`).                                                                                                                               |
| Agent preview                 | `screenshotDesign` (packages/core/src/html-render.cjs): headless Chrome at the design's size, waits for the DOM to settle, returns the first screen, console messages and content size. Needs Chrome or Chromium; without it the design still saves.                     |

## Releasing

Deploy `apps/design-share` before a desktop release that includes this, or publishing a page with an interactive
design fails validation on the old Worker.
