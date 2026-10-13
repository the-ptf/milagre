# Design quality: icons, Inter and a feedback loop

Users say Milagre Designs look much worse than the same screen made in Pencil (pen.dev). Victor's comparison, the Reservations "Filter and sort" sheet, shows four problems:

- Icons are Unicode glyphs or transparent images in grey boxes (the X, the check, the sort chevrons, the "•••▮" status bar).
- Everything is set in Arial, so nothing looks like a modern app.
- The layout is sparser than Pencil's: no date column, no filter pills, no nav icons.
- Small mistakes (the checkbox, the grey boxes) were shipped without anyone looking at them.

## Causes in the code

1. **No icon primitive.** Node types are `frame`, `text`, `rectangle`, `ellipse` and `image` (`packages/shared/src/design.mjs:30`). Agents draw icons with glyphs or tiny images.
2. **Grey placeholder behind every image.** An image with no `fill` paints `#d8ded8` even when `src` is set, in the HTML (`design.mjs:300`) and the SVG (`design-svg.mjs:133`). A transparent icon PNG shows as a grey square. One agent worked around it by setting `fill: transparent` on every icon layer; the bug stays for everyone else.
3. **Arial only.** Line breaking uses hard-coded metrics for Arial, Georgia, Times New Roman and Courier New (`design-font-metrics.mjs`), and no font is embedded in the HTML or SVG. Any other family renders only if the viewer has it and wraps with the wrong metrics.
4. **The agent never sees its result.** `design_show` and `design_apply` return a JSON summary (`packages/core/src/chat-artifacts.cjs:440`, `463-466`). All three MCP transports return text only (`agents/claude-provider.cjs:74-77`, `linked-mcp-server.cjs:104-108`, `local-mcp-server.cjs:123-126`). Clipped text is dropped silently (`visibleDesignTextLines`). Pencil's agent screenshots its canvas and fixes what it sees.
5. **The skill has no quality guidance.** `packages/core/src/bundled-skills/design/SKILL.md` covers the format and process only.

## Decisions

| Question | Decision |
| --- | --- |
| Scope of this round | Image placeholder fix, Lucide icons, bundled Inter, rendered PNG plus warnings returned to the agent, skill rewrite. Shadows, per-side padding, per-corner radius, letter spacing and gradients wait for a later round. |
| How the agent sees the result | A PNG attached to the `design_show` / `design_apply` result as image content, plus text warnings. |
| Rasterizer | `@resvg/resvg-wasm` in the daemon, rendering the existing SVG renderer's output. Works on headless Macs; no browser, no native module. |
| Icon set | Lucide (ISC), the same set Pencil uses. |
| Done when | A side-by-side benchmark: the same 3 prompts in Pencil and in Milagre, screenshots in the PR, ours comparable on icons, type and density. |

## PR 1: image placeholder fix

Paint the `#d8ded8` placeholder only when an image has no `src`. An explicit `fill` still paints behind the image, as today.

- `nodeStyles` in `design.mjs`: the image default becomes `transparent` when `node.src` is set.
- `design-svg.mjs`: skip the placeholder shape when `node.src` is set and `node.fill` is not.
- Unit tests in `design.test.mjs` and `design-svg.test.mjs` for: src without fill (no placeholder), no src (placeholder), src with fill (fill painted).

Mobile shows host HTML, so it picks this up from the host with no OTA.

## PR 2: Inter

**Font files.** Add Inter static TTFs at 400, 500, 600 and 700, subset to Latin and Latin-1 Supplement, under `packages/shared/assets/fonts/` with the OFL licence beside them. Both renderers and resvg consume TTF, so one set of files serves all three. Each subset is roughly 60 to 80 KB.

**Metrics.** Extend `scripts/generate-design-font-metrics.cjs`:

- Load the bundled TTFs with `FontFace` before measuring.
- Add an `inter` entry with all four weights.
- Pick the nearest measured weight in `designTextLayout` instead of the current 400/700 split. The existing families keep 400/700.
- `designTextLayout` maps any family containing `inter` to the `inter` metrics.

**Default family.** `designFontFamily()` defaults to `Inter, Arial, sans-serif`. Documents that name Arial keep Arial. Documents with no `fontFamily` change look, which is the point; their line breaks are recomputed by the same layout engine, so hug frames still fit.

**Embedding.** The new `designFontFaces(document)` in `design-fonts.mjs` returns `@font-face` rules as data URIs for only the Inter weights the document's text layers use (nearest weight). `designHtml` puts them in a `<style>` in the head; `renderDesignSvg` puts them in `<defs><style>`. The artifact CSP already allows `font-src data:` (`artifact-document.mjs`).

Size budget: a document using three weights adds about 300 KB of base64 to each stored `v{n}.html`. With 50 kept versions that is up to 15 MB per design on disk. That is acceptable for now. If it is not, a later change can serve the fonts from the host instead of inlining them.

**Rendering details.**

- HTML text already disables kerning and ligatures, which the metrics assume.
- Add `font-feature-settings: "calt" 0` so Inter's contextual alternates don't change advance widths.
- Non-Latin text falls back to system fonts with the existing approximate metrics.

**Tests.**

- Metrics: a 1000-character Latin sample measured in Electron with the bundled Inter must match `designTextLayout` within 0.5%.
- `designFontFaces` emits only the weights a document uses.
- `scripts/test-design-editor.cjs` checks that a text layer renders with Inter, not a fallback (`document.fonts.check`).

## PR 3: Lucide icons

**Data.**

- `scripts/generate-design-icons.cjs` reads the `lucide` package's icon nodes and writes `packages/shared/src/design-icons.mjs`: `{ name: "<path d=… />…" }` for every icon, about 400 KB raw and about 100 KB gzipped.
- `lucide` is a devDependency of the script only, so nothing native is added.
- The licence notice goes beside the generated file.

**Schema.**

- `type` gains `"icon"`, and nodes gain an optional `icon` string that must name a Lucide icon.
- For icons, `fill` is the line colour (default `#202720`, like text) and `strokeWidth` is the line weight (default 2). Width and height set the box. The 24-unit glyph scales to fit, centred and never cropped.
- `stroke`, `radius`, `text` and `src` are rejected on icons. Icons cannot have children.
- An unknown name is a validation error that lists the three closest names, for example: `Unknown icon "chevron-up-down". Did you mean chevrons-up-down, chevron-up, chevron-down?`
- `design.d.mts` and the `design_apply` patch schema get the same fields.

**Renderers.**

- HTML: an inline `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` inside the node's div, with `stroke` set to the resolved colour.
- SVG: a nested `<svg>` at the node's box with the same attributes.
- Tokens (`$ink`) work for icon colour.

**Desktop editor.**

- `DesignTools.tsx` gets an icon type glyph in the layers panel, wherever `rectangle` and `ellipse` appear.
- The `DesignEditor.tsx` inspector gets an icon-name field for icon layers: a searchable list through the shared choice-menu primitive (`docs/agents/ui.md`), plus colour and line weight.
- An icon layer can't be turned into another type in the inspector. The agent or the user deletes and inserts instead.

**Mobile.** Mobile has no design editor and no layer-type list (checked: no `"ellipse"` in `apps/mobile/src`). It renders the host HTML, so icons appear with no mobile code change and no OTA. Verify on the phone anyway: the design card and the full-screen viewer, with icons in a design.

**Tests.**

- Unit tests:
  - validation (known name, unknown name with suggestions, rejected properties);
  - HTML and SVG output;
  - a token colour on an icon.
- `scripts/test-design-editor.cjs`: select an icon layer, change its name in the inspector, and see the new path render.

## PR 4: the agent sees its design

### Rendering in the daemon

- `packages/core/src/design-raster.cjs` loads `@resvg/resvg-wasm` once per process and passes the bundled Inter TTFs as font buffers.
- `renderDesignPng(document)` returns `{ mime: "image/png", base64, width, height }`.
- Scale: 1x, with the long edge capped at 1568 px (Claude's image limit). A 390 by 844 phone renders at 1x; a 1440 by 900 desktop renders at 1x; anything larger is scaled down.
- Remote `https:` images are not fetched; they render as their placeholder. The warning list says so, so the agent isn't misled.
- Rendering failures never fail the tool call. The result carries the summary, the warnings and a line saying the preview couldn't be rendered.
- Packaging: the `.wasm` file has to ship with the packaged daemon. The Electron check and a packaged-build smoke test (`packaged-requires.test.cjs`) must load it.

### Warnings

`packages/shared/src/design-lint.mjs` exports `designWarnings(document)`, a pure function over the document and `designLayout`, so the desktop editor can reuse it later. Each warning names the layer id. The list is capped at 20 with a "and N more" line.

| Warning | Rule |
| --- | --- |
| Clipped text | A text layer's laid-out lines exceed its box (what `visibleDesignTextLines` drops today). |
| Overflowing child | A visible child's box extends past its parent's box by more than 1 px. |
| Off canvas | A visible top-level layer lies partly outside the document. |
| Low contrast | Text colour against the nearest opaque ancestor fill (or the document background) is below 4.5:1, or 3:1 for text 24 px and up. Skipped when an image is behind it. |
| Remote image | An `https:` image the preview could not show. |

### Tool results with images

- `runTool` in `linked-tools.cjs` accepts a run result of either a string or `{ text, images: [{ mime, base64 }] }`, and returns `{ text, images, isError }`.
- The three transports map `images` to MCP image content: `{ type: "image", data, mimeType }` after the text block.
- `design_show` and `design_apply` return the summary text, the warnings as text, and one image of the saved version.
- `design_read` stays text only.
- Providers:
  - Claude: the in-process SDK server passes image content through.
  - Codex: reads MCP image content from the local MCP server; verify on the current Codex CLI version.
  - Antigravity: if ACP drops image content, the warnings still arrive as text. Check this once and note the result in the skill.
- The Chat step card for these tools must not try to show the base64. `steps.cjs` keeps using the summary.

### Skill rewrite

Rewrite `SKILL.md` around the loop the image enables, keeping the existing format reference:

1. Ground it (unchanged).
2. Show it.
3. **Look at the returned image and the warnings, fix every warning and anything that looks wrong, then reply.** At most two fix rounds before replying.
4. Variants, feedback and build (unchanged).

New sections:

- **Icons:** always an `icon` layer, never a Unicode glyph or an image of an icon. Common names for iOS chrome: `chevron-left`, `x`, `check`, `chevrons-up-down`, `sliders-horizontal`, `signal`, `wifi`, `battery-full`, `search`, `plus`.
- **Type:** Inter by default. Use one size scale per screen (for example 34/22/17/15/13 for iOS). Weight 600 for titles, 400 for body. Secondary text uses a lighter colour, not a smaller size.
- **Spacing:** a 4 px grid, 16 to 20 px screen margins on phone, 44 px minimum touch targets.
- **Phone chrome recipe:** a 54 px status bar with time, `signal`, `wifi` and `battery-full`; nav bar buttons as 44 px circles with an icon inside.
- **Density:** match the real app's density. Show the content a real screen would have (dates, chips, badges), not a simplified placeholder.

Remove the "Metrics cover Arial…" caveat and state that Inter is measured.

### Benchmark

These are the same three prompts, run in Pencil by hand and in Milagre through `scripts/live-design-workflow.cjs --live` with Claude:

1. The Reservations "Filter and sort" sheet from Victor's comparison (iOS, 390 by 844).
2. An iOS settings screen with grouped rows, toggles and icons.
3. A desktop dashboard at 1440 by 900 with a sidebar, stat cards and a table.

PR 4's description shows each pair side by side, before and after. Done means ours is comparable on icons, type and density. If the gap is still mostly shadows or corner shapes, that becomes the next round's scope.

## Platform sync

Every change is in `packages/shared` or `packages/core`, plus the desktop editor for icons. The phone displays host-rendered HTML, so it gets the placeholder fix, Inter and icons without code changes and without an OTA. Verify each PR on the phone through the design card and the full-screen viewer. The phone has no design editor, so the icon inspector has no mobile counterpart.

## Out of scope

- Shadows, gradients, per-side padding, per-corner radius, letter spacing, italic and text decoration.
- Fonts other than Inter, and an SF Pro look-alike.
- Material Symbols or SF Symbols.
- Rendering the PNG in a browser for pixel parity with the HTML.
- Showing warnings in the desktop editor (the lint is reusable, but no UI this round).

## Risks

- **SVG and HTML paint differ slightly.** Both use `designLayout`, so boxes and line breaks match, and only anti-aliasing and stroke details can differ.
- **Font bytes in every version.** About 300 KB per stored version. See the budget above.
- **The icon module adds about 100 KB gzipped** to the desktop editor bundle. Lazy-load it if the bundle check complains.
- **Codex or Antigravity may ignore MCP image content.** The warnings still help; note the gap in the skill.
