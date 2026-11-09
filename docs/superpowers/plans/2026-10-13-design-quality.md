# Design Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Milagre Designs comparable to Pencil by fixing the image placeholder, bundling Inter, adding Lucide icons and returning a rendered PNG plus layout warnings to the agent.

**Architecture:**
- Everything visual lives in `packages/shared` (schema, layout, HTML and SVG renderers). The desktop editor, the host and the public share page all import it; the phone shows host-rendered HTML.
- The daemon (`packages/core`) rasterizes the shared SVG with `@resvg/resvg-wasm` and attaches the PNG to the design tool results. `runTool` and the three MCP transports learn to carry images.

**Tech Stack:**
- Node 24 ESM/CJS with `node:test` and zod 4.
- `@resvg/resvg-wasm@2.6.2` (runtime, core).
- Generator-only devDependencies: `inter-font@3.19.0`, `subset-font@2.9.0`, `lucide-static@1.56.0`.
- Electron checks under `scripts/test-*.cjs`.

**Spec:** `docs/superpowers/specs/2026-10-13-design-quality-design.md`

## Global Constraints

- Four PRs, stacked in order. PR 1 is the current branch `milagre/users-complaied-that-the-current-x4ex`, which already carries the spec commit. PR 2 is `milagre/design-inter`, branched from PR 1. PR 3 is `milagre/design-icons`, branched from PR 2. PR 4 is `milagre/design-feedback`, branched from PR 3.
- Before each PR: `npm run typecheck`, `npm run lint`, `npm test -- --unit`, and the Electron checks named in its tasks (`npm test -- --only <name>`).
- No Claude or Anthropic attribution in commits or PR bodies. Screenshots go on the `screenshots` branch, never in PR commits (AGENTS.md).
- Desktop and mobile stay in sync. The phone renders host HTML (`apps/mobile/src/artifact.tsx:748-798`) and imports nothing from `@milagre/shared/design`, so it needs no code change and no OTA. Verify every PR on the phone anyway: open the design card and the full-screen viewer.
- No new native dependency anywhere. `@resvg/resvg-wasm` is WASM. `apps/mobile` is untouched, so the runtime fingerprint is unchanged.
- Every check that runs Milagre uses its own Vite/Electron ports and profiles. Never kill Milagre processes by name.
- Font: Inter 3.19, SIL OFL 1.1. Weights 400, 500, 600 and 700, subset to U+0020-007E, U+00A0-00FF and `‘’“”–—…•·→←↑↓€™`. The licence ships beside the data file.
- Icons: Lucide via `lucide-static@1.56.0` `icon-nodes.json` (1879 icons, ISC). The licence ships beside the data file.
- Default font family string: `Inter, Arial, sans-serif`.
- The PNG for the agent is at most 1568 px on its long edge, 1x otherwise.
- At most 20 warnings, then one line: `…and N more`.

## Review Focus

1. **Design tool results with an image must still produce the Chat card.** `artifactRef` in `packages/core/src/agents/steps.cjs:65` parses the whole result text as JSON. An extra `[image]` line would silently drop every design card on desktop and phone. Task 11 pins this with a test.
2. **A rasterizer failure must never fail `design_show` / `design_apply`.** The version is already saved; an error would make the agent retry and create duplicates. Task 12 tests it with a throwing renderer.
3. **Old documents keep validating and rendering.** Documents saved with `fontFamily: "Arial"` keep Arial metrics and markup. Documents without a family move to Inter. Image layers with an explicit `fill` keep painting it. Tasks 1 and 4 test both.
4. **Unknown or misspelled icon names fail with suggestions,** not a blank box. This covers `insert`, `update` patches and `replace`. Task 6 tests all three paths.
5. **The 8 MiB render budget and the 1,000,000-character document cap still hold with embedded fonts.** Fonts count toward the render budget (about 330 KB for four weights), not toward the document cap. Task 4 tests a document using all four weights with a large text layer.

---

## PR 1: image placeholder fix

### Task 1: Paint the image placeholder only when there is no source

**Files:**
- Modify: `packages/shared/src/design.mjs:299-300` (`nodeStyles`)
- Modify: `packages/shared/src/design-svg.mjs:132-133` (image branch of `renderChildren`)
- Test: `packages/shared/src/design.test.mjs`, `packages/shared/src/design-svg.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: in both renderers, an image layer with `src` and no `fill` paints no background.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/design.test.mjs`:

```js
const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

test("an image with a source paints no placeholder behind its transparent pixels", () => {
  const document = validateDesignDocument({
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [
      { id: "icon", type: "image", width: 24, height: 24, src: PIXEL },
      { id: "empty", type: "image", y: 40, width: 24, height: 24 },
      { id: "tinted", type: "image", y: 80, width: 24, height: 24, src: PIXEL, fill: "#ff0000" },
    ],
  });
  const html = designHtml(document);
  const style = (id) => new RegExp(`data-design-node="${id}"[^>]*style="([^"]*)"`).exec(html)[1];
  assert.match(style("icon"), /background:transparent/);
  assert.match(style("empty"), /background:#d8ded8/);
  assert.match(style("tinted"), /background:#ff0000/);
});
```

Append to `packages/shared/src/design-svg.test.mjs`:

```js
test("an image with a source paints no placeholder shape; one without keeps it", () => {
  const document = screen([
    { id: "icon", type: "image", x: 0, y: 0, width: 24, height: 24, src: "data:image/png;base64,iVBORw0KGgo=" },
    { id: "empty", type: "image", x: 0, y: 40, width: 24, height: 24 },
    { id: "tinted", type: "image", x: 0, y: 80, width: 24, height: 24, src: "data:image/png;base64,iVBORw0KGgo=", fill: "#ff0000" },
  ]);
  const svg = render(document);
  const layer = (id) => new RegExp(`<g id="layer-${id}"[\\s\\S]*?</g>`).exec(svg)[0];
  assert.doesNotMatch(layer("icon"), /<rect[^>]*fill=/);
  assert.match(layer("icon"), /<image /);
  assert.match(layer("empty"), /<rect[^>]*fill="#d8ded8"/);
  assert.match(layer("tinted"), /<rect[^>]*fill="#ff0000"/);
});
```

(`render` uses `color = (value, fallback = "transparent") => value ?? fallback`, so `#d8ded8` comes through as the fallback.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test packages/shared/src/design.test.mjs packages/shared/src/design-svg.test.mjs`
Expected: the two new tests FAIL. The icon gets `background:#d8ded8` in HTML and a `<rect … fill="#d8ded8">` in SVG.

- [ ] **Step 3: Implement**

In `nodeStyles` (`design.mjs:300`), replace the `background` line:

```js
  // Transparent images (icons, cut-outs) show what is behind them; the grey placeholder marks an image still to add.
  const placeholder = node.type === "frame" || (node.type === "image" && node.src) ? "transparent" : "#d8ded8";
  const background = node.type === "text" ? "transparent" : designColor(document, node.fill, placeholder);
```

In `design-svg.mjs`, the image branch:

```js
        } else if (node.type === "image") {
          // Only a missing image gets the placeholder; a transparent one shows what is behind it.
          contents = node.fill || !node.src ? take(`<${shape(node, box)} ${colorAttributes("fill", node.fill, "#d8ded8")}/>`, node) : "";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test packages/shared/src/*.test.mjs`
Expected: PASS, including every existing design test.

- [ ] **Step 5: Verify, commit and open PR 1**

```bash
npm run typecheck && npm run lint && npm test -- --unit && npm test -- --only design-editor && npm test -- --only design-page-viewer
git add packages/shared/src/design.mjs packages/shared/src/design-svg.mjs packages/shared/src/design.test.mjs packages/shared/src/design-svg.test.mjs
git commit -m "fix(designs): paint the image placeholder only when an image has no source"
git push -u origin HEAD
```

Before and after screenshots:
1. Render a 390 by 844 document with a transparent PNG icon over a white card to PNG, using `designSvg` on main and on this branch. Use `scripts/live-design-harness.cjs` or a scratch script in `$TMPDIR`, never in the repo.
2. Push both images to the `screenshots` branch under `design-image-placeholder/`.
3. Open the PR with `gh pr create`. The body says what changed and why (the grey squares in Victor's comparison), and links the two images by commit SHA.
4. Phone check: open a design containing an image icon on the phone (dev build or the Designs QA sim, see memory `design-artifacts`). Confirm there is no grey square.

---

## PR 2: Inter

Create the branch: `git switch -c milagre/design-inter`

### Task 2: Generate the Inter font data module

**Files:**
- Create: `scripts/generate-design-fonts.cjs`
- Create (generated): `packages/shared/src/design-font-data.mjs`
- Create (copied): `packages/shared/src/design-font-data.LICENSE.txt`
- Modify: root `package.json` devDependencies (`inter-font`, `subset-font`)
- Test: `packages/shared/src/design-font-data.test.mjs`

**Interfaces:**
- Produces: `export const designInterFonts: Record<400|500|600|700, string>` (base64 TrueType) and `export const DESIGN_INTER_WEIGHTS = [400, 500, 600, 700]` from `design-font-data.mjs`.

- [ ] **Step 1: Add the generator devDependencies**

Run: `npm i -D -w . inter-font@3.19.0 subset-font@2.9.0`
Expected: the root `package.json` devDependencies list both, and `package-lock.json` changes.

- [ ] **Step 2: Write the failing test**

`packages/shared/src/design-font-data.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";

test("Inter ships as four small TrueType subsets", () => {
  assert.deepEqual(DESIGN_INTER_WEIGHTS, [400, 500, 600, 700]);
  for (const weight of DESIGN_INTER_WEIGHTS) {
    const bytes = Buffer.from(designInterFonts[weight], "base64");
    assert.equal(bytes.readUInt32BE(0), 0x00010000, `${weight} is TrueType`);
    assert.ok(bytes.length > 30_000 && bytes.length < 100_000, `${weight} is a Latin subset (${bytes.length} bytes)`);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test packages/shared/src/design-font-data.test.mjs`
Expected: FAIL with `Cannot find module './design-font-data.mjs'`.

- [ ] **Step 4: Write the generator**

`scripts/generate-design-fonts.cjs`:

```js
// Regenerate the Inter subsets embedded in design previews, SVG exports and the agent's PNG.
// Run: node scripts/generate-design-fonts.cjs
const fs = require("node:fs");
const path = require("node:path");
const subsetFont = require("subset-font");

const WEIGHTS = { 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold" };
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String.fromCharCode(from + index)).join("");
const CHARACTERS = range(0x20, 0x7e) + range(0xa0, 0xff) + "‘’“”–—…•·→←↑↓€™";

async function main() {
  const source = path.dirname(require.resolve("inter-font/package.json"));
  const out = path.resolve(__dirname, "../packages/shared/src");
  const fonts = {};
  for (const [weight, style] of Object.entries(WEIGHTS)) {
    const font = await subsetFont(fs.readFileSync(path.join(source, "ttf", `Inter-${style}.ttf`)), CHARACTERS, { targetFormat: "truetype" });
    fonts[weight] = font.toString("base64");
  }
  fs.writeFileSync(
    path.join(out, "design-font-data.mjs"),
    `// Inter 3.19 (SIL OFL 1.1, see design-font-data.LICENSE.txt), Latin subsets as TrueType. Regenerate: node scripts/generate-design-fonts.cjs\n` +
      `export const DESIGN_INTER_WEIGHTS = [400, 500, 600, 700];\n` +
      `export const designInterFonts = ${JSON.stringify(fonts)};\n`,
  );
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(out, "design-font-data.LICENSE.txt"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 5: Generate and run the test**

Run: `node scripts/generate-design-fonts.cjs && node --test packages/shared/src/design-font-data.test.mjs`
Expected: PASS. The prototype measured each subset at about 61 KB.

- [ ] **Step 6: Exclude the generated file from formatting and lint**

Add `packages/shared/src/design-font-data.mjs` to the ignore lists in `.oxfmtrc.json` and `.oxlintrc.json`, next to how `design-font-metrics.mjs` or `design-controller-script.mjs` are treated. If neither is ignored, add a new `ignorePatterns` entry. Run `npm run lint`; expected PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-design-fonts.cjs packages/shared/src/design-font-data.mjs packages/shared/src/design-font-data.LICENSE.txt packages/shared/src/design-font-data.test.mjs package.json package-lock.json .oxfmtrc.json .oxlintrc.json
git commit -m "feat(designs): bundle Inter subsets for design rendering"
```

### Task 3: Measure Inter and pick the nearest measured weight

**Files:**
- Modify: `scripts/generate-design-font-metrics.cjs`
- Modify (generated): `packages/shared/src/design-font-metrics.mjs`
- Modify: `packages/shared/src/design-layout.mjs:11-15` (`designTextLayout`)
- Test: `packages/shared/src/design-layout.test.mjs`

**Interfaces:**
- Consumes: `designInterFonts` from Task 2.
- Produces:
  - `designFontMetrics.inter[400|500|600|700]`: 95 advances each, for U+0020-007E at 1 px.
  - `designTextLayout` maps any family containing `inter` to Inter and defaults to Inter.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/design-layout.test.mjs`. Import `designTextLayout` from `./design-layout.mjs` if the file does not already.

```js
test("Inter is measured at four weights and is the default family", () => {
  const text = { id: "t", type: "text", width: 1000, height: 40, text: "Filter and sort", fontSize: 20 };
  const regular = designTextLayout({ ...text, fontFamily: "Inter" });
  const semibold = designTextLayout({ ...text, fontFamily: "Inter", fontWeight: 600 });
  const bold = designTextLayout({ ...text, fontFamily: "Inter", fontWeight: 700 });
  assert.ok(regular.width < semibold.width && semibold.width < bold.width, "each weight has its own advances");
  assert.equal(designTextLayout(text).width, regular.width, "no family means Inter");
  assert.notEqual(designTextLayout({ ...text, fontFamily: "Arial" }).width, regular.width, "Arial keeps its own metrics");
});

test("a weight between measured ones uses the nearest, ties going lighter", () => {
  const text = { id: "t", type: "text", width: 1000, height: 40, text: "Reservations", fontSize: 20, fontFamily: "Arial" };
  const at = (fontWeight) => designTextLayout({ ...text, fontWeight }).width;
  assert.equal(at(500), at(400));
  assert.equal(at(550), at(400));
  assert.equal(at(600), at(700));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/shared/src/design-layout.test.mjs`
Expected: the first test FAILS because the weights are equal (Inter currently maps to Arial's 400/700 split).

- [ ] **Step 3: Teach the metrics generator to load Inter**

Replace `measureFonts` and the `executeJavaScript` call in `scripts/generate-design-font-metrics.cjs`:

```js
async function measureFonts(inter) {
  for (const [weight, base64] of Object.entries(inter)) {
    const face = new FontFace("Milagre Inter", Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)), { weight });
    document.fonts.add(await face.load());
  }
  const context = document.createElement("canvas").getContext("2d");
  context.fontKerning = "none";
  const families = { sans: ["Arial", [400, 700]], serif: ["Georgia", [400, 700]], times: ["Times New Roman", [400, 700]], mono: ["Courier New", [400, 700]], inter: ["Milagre Inter", [400, 500, 600, 700]] };
  const result = {};
  for (const [name, [family, weights]] of Object.entries(families)) {
    result[name] = {};
    for (const weight of weights) {
      context.font = `${weight} 1000px "${family}"`;
      result[name][weight] = Array.from({ length: 95 }, (_, index) => Math.round(context.measureText(String.fromCharCode(32 + index)).width) / 1000);
    }
  }
  return result;
}
```

```js
    const { designInterFonts } = await import("../packages/shared/src/design-font-data.mjs");
    const metrics = await window.webContents.executeJavaScript(`(${measureFonts.toString()})(${JSON.stringify(designInterFonts)})`);
```

Run: `node scripts/generate-design-font-metrics.cjs`
Expected: `design-font-metrics.mjs` gains an `inter` key with four weights. The other families' numbers are unchanged; check with `git diff --stat`, which should show additions only.

- [ ] **Step 4: Use Inter metrics and the nearest weight**

In `design-layout.mjs`, replace the first three lines of `designTextLayout`:

```js
  const family = (node.fontFamily ?? "Inter").toLowerCase();
  const kind = /inter/.test(family)
    ? "inter"
    : /courier|mono/.test(family)
      ? "mono"
      : /times/.test(family)
        ? "times"
        : /georgia|(?<!sans-)serif/.test(family)
          ? "serif"
          : "sans";
  const measured = designFontMetrics[kind];
  const requested = node.fontWeight ?? 400;
  const weight = Object.keys(measured)
    .map(Number)
    .reduce((best, candidate) => (Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best));
  const metrics = measured[weight];
```

Update the doc comment above the function to: `Shared line breaking deliberately has no browser dependency. Inter, Arial, Georgia, Times New Roman and Courier New are measured; other fonts use the closest generic metrics.`

- [ ] **Step 5: Run the tests**

Run: `node --test packages/shared/src/*.test.mjs`
Expected: the new tests PASS. Existing tests that assert exact wrapped widths for documents without `fontFamily` may now FAIL because those documents moved to Inter. For each such failure:
1. Read the test's intent.
2. If it is about layout mechanics, not Arial specifically, pin `fontFamily: "Arial"` in that test's fixture so it keeps checking what it checked.
3. Never change an expected number to whatever the code now outputs without understanding why.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-design-font-metrics.cjs packages/shared/src/design-font-metrics.mjs packages/shared/src/design-layout.mjs packages/shared/src/*.test.mjs
git commit -m "feat(designs): measure Inter at four weights and default text layout to it"
```

### Task 4: Default to Inter and embed it in HTML and SVG

**Files:**
- Modify: `packages/shared/src/design-fonts.mjs`
- Modify: `packages/shared/src/design.mjs` (`nodeStyles`, `designHtml`, `designSvg`)
- Modify: `packages/shared/src/design-svg.mjs` (`renderDesignSvg` signature, text style)
- Modify: `packages/shared/src/design.d.mts` (export the `designFontFaces` type)
- Test: `packages/shared/src/design-fonts.test.mjs`
- Create: `scripts/test-design-fonts.cjs` (Electron check)

**Interfaces:**
- Consumes: `designInterFonts`, `DESIGN_INTER_WEIGHTS` (Task 2), `designFontMetrics.inter` (Task 3).
- Produces:
  - `designFontFaces(document): string` returns CSS `@font-face` rules for the Inter weights the document's visible text uses, or `""`.
  - `designInterWeight(fontWeight?: number): 400|500|600|700`.
  - `renderDesignSvg(document, bounds, textLayout, resolveColor, fontFaces = "")`.
  - `designFontFamily()` defaults to `"Inter", "Arial", sans-serif`.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/design-fonts.test.mjs`, change the first assertion of the existing quoting test to `assert.equal(designFontFamily(), '"Inter", "Arial", sans-serif');`. Then append:

```js
import { designFontFaces } from "./design-fonts.mjs";

const textNode = (id, extra = {}) => ({ id, type: "text", width: 300, height: 40, text: id, ...extra });
const doc = (nodes) => validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, nodes });

test("only the Inter weights a document's visible text uses are embedded", () => {
  const faces = designFontFaces(doc([textNode("a"), textNode("b", { fontWeight: 600 }), textNode("c", { fontWeight: 650 }), textNode("d", { fontFamily: "Arial", fontWeight: 700 }), textNode("e", { fontWeight: 500, hidden: true })]));
  assert.equal((faces.match(/@font-face/g) ?? []).length, 2);
  assert.match(faces, /font-family:"Inter";font-weight:400;src:url\(data:font\/ttf;base64,/);
  assert.match(faces, /font-weight:600;/);
  assert.doesNotMatch(faces, /font-weight:(500|700);/);
  assert.equal(designFontFaces(doc([textNode("x", { fontFamily: "Georgia" })])), "");
});

test("HTML and SVG carry the embedded faces; Inter text disables contextual alternates", () => {
  const document = doc([textNode("title", { fontWeight: 600 })]);
  const html = designHtml(document);
  assert.match(html, /<style>@font-face\{font-family:"Inter";font-weight:600;/);
  assert.match(html, /font-feature-settings:&quot;calt&quot; 0/);
  const svg = designSvg(document);
  assert.match(svg, /<defs><style>@font-face\{font-family:"Inter";font-weight:600;/);
  assert.match(svg, /font-family="&quot;Inter&quot;, &quot;Arial&quot;, sans-serif"/);
});

test("all four weights plus heavy text stay within the 8 MiB render budget", () => {
  const big = "Lorem ipsum dolor sit amet ".repeat(4000);
  const document = doc([400, 500, 600, 700].map((fontWeight) => textNode(`w${fontWeight}`, { fontWeight, text: big.slice(0, 20000), height: 4000 })));
  assert.doesNotThrow(() => designHtml(document));
  assert.doesNotThrow(() => designSvg(document));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/shared/src/design-fonts.test.mjs`
Expected: FAIL. `designFontFaces` is not exported, and the default is still `"Arial", sans-serif`.

- [ ] **Step 3: Implement `designFontFaces` and the default**

In `design-fonts.mjs`:

```js
import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";

export const DESIGN_DEFAULT_FONT_FAMILY = "Inter, Arial, sans-serif";
```

Change the `designFontFamily` signature to `export function designFontFamily(value = DESIGN_DEFAULT_FONT_FAMILY) {`. Then append:

```js
/** The measured Inter weight a requested weight renders with; ties go lighter, as in designTextLayout. */
export function designInterWeight(fontWeight = 400) {
  return DESIGN_INTER_WEIGHTS.reduce((best, weight) => (Math.abs(weight - fontWeight) < Math.abs(best - fontWeight) ? weight : best));
}

const usesInter = (node) => node.type === "text" && !node.hidden && /inter/i.test(node.fontFamily ?? DESIGN_DEFAULT_FONT_FAMILY);

/** Data-URI faces for the Inter weights a document's visible text uses, so every viewer renders the measured font. */
export function designFontFaces(document) {
  const weights = new Set(document.nodes.filter(usesInter).map((node) => designInterWeight(node.fontWeight)));
  return DESIGN_INTER_WEIGHTS.filter((weight) => weights.has(weight))
    .map((weight) => `@font-face{font-family:"Inter";font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${designInterFonts[weight]}) format("truetype")}`)
    .join("");
}
```

In `design-layout.mjs`, replace the inline nearest-weight `reduce` from Task 3. Inter weights use `designInterWeight`; the other families keep the generic reduce over their measured weights. A nearest-weight helper in `design-layout.mjs` that both use is fine, but `designInterWeight` must stay the exported name.

- [ ] **Step 4: Embed the faces in the HTML**

In `nodeStyles`, inside the `node.type === "text"` array, after `"font-variant-ligatures:none"`, add `'font-feature-settings:"calt" 0'`.

In `designHtml`, after the existing `<style>…</style>` in the head literal, insert `${fontFaces ? `<style>${fontFaces}</style>` : ""}`, where `const fontFaces = designFontFaces(document);` is computed at the top of the function. The string already passes through `take(...)`, so the faces count toward the 8 MiB budget. Import `designFontFaces` from `./design-fonts.mjs` and re-export it next to `designFontFamily`:

```js
export { designFontFamily, designFontFaces, designInterWeight } from "./design-fonts.mjs";
```

- [ ] **Step 5: Embed the faces in the SVG**

In `design-svg.mjs`, change the signature to `renderDesignSvg(document, bounds, textLayout, resolveColor, fontFaces = "")`. In the `<text …>` style attribute, add `;font-feature-settings:&quot;calt&quot; 0`. In the final assembly, make the defs block emit the faces first:

```js
    (definitions.length || fontFaces
      ? take("<defs>") + (fontFaces ? take(`<style>${fontFaces}</style>`) : "") + definitions.join("") + take("</defs>")
      : "") +
```

In `design.mjs`, `designSvg` passes `designFontFaces(document)` as the fifth argument. Update the doc comment above `renderDesignSvg`: font names stay references, and the caller may pass `fontFaces` CSS to embed.

Add the types to `design.d.mts`:

```ts
export function designFontFaces(document: DesignDocument): string;
export function designInterWeight(fontWeight?: number): 400 | 500 | 600 | 700;
```

- [ ] **Step 6: Run the unit tests**

Run: `node --test packages/shared/src/*.test.mjs`
Expected: PASS. Fix existing tests that match the old default family string the way Task 3 Step 5 describes: pin `fontFamily: "Arial"` when the test is about something else.

- [ ] **Step 7: Write the Electron font check**

`scripts/test-design-fonts.cjs` checks that the browser renders the embedded Inter at the width the layout engine measured:

```js
// Inter renders from the embedded faces, with the advances designTextLayout assumes.
const assert = require("node:assert/strict");
const path = require("node:path");

async function check() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", path.join(require("node:os").tmpdir(), `milagre-design-fonts-${process.pid}`));
  await app.whenReady();
  const { designHtml, designTextLayout, validateDesignDocument } = await import("../packages/shared/src/design.mjs");
  const sample = "The quick brown fox jumps over the lazy dog. Reservations 0123456789 · Filter and sort";
  const nodes = [400, 500, 600, 700].map((fontWeight, index) => ({ id: `w${fontWeight}`, type: "text", y: index * 40, width: 2000, height: 40, text: sample, fontSize: 16, fontWeight }));
  const document = validateDesignDocument({ schemaVersion: 1, width: 2200, height: 400, nodes });
  const window = new BrowserWindow({ show: false, width: 2200, height: 400, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadURL(`data:text/html;base64,${Buffer.from(designHtml(document)).toString("base64")}`);
    await window.webContents.executeJavaScript("document.fonts.ready");
    for (const node of nodes) {
      assert.equal(await window.webContents.executeJavaScript(`document.fonts.check('${node.fontWeight} 16px "Inter"')`), true, `Inter ${node.fontWeight} is loaded`);
      const rendered = await window.webContents.executeJavaScript(
        `(() => { const span = document.querySelector('[data-design-node="${node.id}"] span'); const range = document.createRange(); range.selectNodeContents(span); return range.getBoundingClientRect().width; })()`,
      );
      const measured = designTextLayout(node).width;
      assert.ok(Math.abs(rendered - measured) / measured < 0.005, `Inter ${node.fontWeight}: rendered ${rendered}px vs measured ${measured}px`);
    }
    console.log("PASS: embedded Inter renders at the measured widths");
  } finally {
    window.destroy();
    app.quit();
  }
}

function run() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
  process.exitCode = child.status ?? 1;
}

if (process.versions.electron || require.main === module)
  (process.versions.electron ? check() : Promise.resolve(run())).catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

Run: `npm test -- --only design-fonts`
Expected: PASS. If one weight differs by more than 0.5%, Task 3's metrics were measured without the face actually loaded. Re-run the metrics generator and inspect it before loosening anything.

- [ ] **Step 8: Run the existing design checks**

Run: `npm test -- --only design-editor && npm test -- --only design-csp && npm test -- --only design-page-viewer && npm test -- --only artifacts`
Expected: PASS. `design-csp` builds the renderer, so run `npm run build` first if it says so.

- [ ] **Step 9: Update the skill's font paragraph**

In `packages/core/src/bundled-skills/design/SKILL.md`, replace the last two sentences of the "Content sizing" section ("Metrics cover Arial…" and "The default is Arial…") with:

`Text is set in Inter by default, embedded in every preview and measured at weights 400, 500, 600 and 700. Arial, Georgia, Times New Roman and Courier New are also measured; other fonts and non-Latin scripts use approximate metrics and render only where the viewer has them installed.`

- [ ] **Step 10: Commit and open PR 2**

```bash
git add packages/shared/src scripts/test-design-fonts.cjs packages/core/src/bundled-skills/design/SKILL.md
git commit -m "feat(designs): default to Inter and embed it in previews and SVG"
npm run typecheck && npm run lint && npm test -- --unit
git push -u origin HEAD
gh pr create --base milagre/users-complaied-that-the-current-x4ex --title "feat(designs): render designs in Inter" --body-file <body file in $TMPDIR>
```

PR body:
- before/after PNGs of the same document rendered from `designSvg` on PR 1 and on this branch, uploaded to `screenshots/design-inter/`;
- the size note (about 82 KB of base64 per weight used);
- the phone check: open a design on the phone and confirm the text is Inter, not SF or Arial.

---

## PR 3: Lucide icons

Create the branch: `git switch -c milagre/design-icons`

### Task 5: Generate the Lucide icon module

**Files:**
- Create: `scripts/generate-design-icons.cjs`
- Create (generated): `packages/shared/src/design-icons.mjs`
- Create (copied): `packages/shared/src/design-icons.LICENSE.txt`
- Modify: root `package.json` devDependencies (`lucide-static`)
- Test: `packages/shared/src/design-icons.test.mjs`

**Interfaces:**
- Produces from `design-icons.mjs`:
  - `export const designIcons: Record<string, string>`: kebab name to inner SVG markup in a 24 by 24 viewBox, for example `'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'`.
  - `export function designIconSuggestions(name: string, count = 3): string[]`.

- [ ] **Step 1: Add the devDependency**

Run: `npm i -D -w . lucide-static@1.56.0`

- [ ] **Step 2: Write the failing test**

`packages/shared/src/design-icons.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { designIcons, designIconSuggestions } from "./design-icons.mjs";

test("the Lucide set covers the icons phone mockups need", () => {
  assert.ok(Object.keys(designIcons).length > 1800);
  for (const name of ["x", "check", "chevron-left", "chevrons-up-down", "sliders-horizontal", "signal", "wifi", "battery-full", "search", "plus"]) {
    assert.match(designIcons[name], /^<(path|rect|circle|line|polyline|polygon|ellipse) /, name);
  }
  assert.doesNotMatch(Object.values(designIcons).join(""), /<script|on[a-z]+=|href=/i, "markup is geometry only");
});

test("suggestions rank close names first", () => {
  assert.deepEqual(designIconSuggestions("chevron-up-down").slice(0, 1), ["chevrons-up-down"]);
  assert.ok(designIconSuggestions("close").includes("x") || designIconSuggestions("close").length === 3);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test packages/shared/src/design-icons.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the generator**

`scripts/generate-design-icons.cjs`:

```js
// Regenerate the Lucide icon geometry used by design icon layers. Run: node scripts/generate-design-icons.cjs
const fs = require("node:fs");
const path = require("node:path");

const ELEMENTS = new Set(["path", "rect", "circle", "line", "polyline", "polygon", "ellipse"]);
const ATTRIBUTE = /^(d|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|points)$/;
const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

const root = path.dirname(require.resolve("lucide-static/package.json"));
const nodes = JSON.parse(fs.readFileSync(path.join(root, "icon-nodes.json"), "utf8"));
const icons = {};
for (const [name, children] of Object.entries(nodes)) {
  icons[name] = children
    .map(([tag, attributes]) => {
      if (!ELEMENTS.has(tag)) throw new Error(`${name}: unexpected <${tag}>`);
      const pairs = Object.entries(attributes).filter(([key]) => ATTRIBUTE.test(key));
      return `<${tag} ${pairs.map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}/>`;
    })
    .join("");
}
const out = path.resolve(__dirname, "../packages/shared/src");
fs.writeFileSync(
  path.join(out, "design-icons.mjs"),
  `// Lucide ${require("lucide-static/package.json").version} (ISC, see design-icons.LICENSE.txt). Regenerate: node scripts/generate-design-icons.cjs\n` +
    `export const designIcons = ${JSON.stringify(icons)};\n\n` +
    `const distance = (a, b) => {\n` +
    `  const row = Array.from({ length: b.length + 1 }, (_, index) => index);\n` +
    `  for (let i = 1; i <= a.length; i++) {\n` +
    `    let previous = row[0];\n` +
    `    row[0] = i;\n` +
    `    for (let j = 1; j <= b.length; j++) {\n` +
    `      const current = row[j];\n` +
    `      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));\n` +
    `      previous = current;\n` +
    `    }\n` +
    `  }\n` +
    `  return row[b.length];\n` +
    `};\n\n` +
    `/** The closest Lucide names to a misspelled one, for validation errors. */\n` +
    `export function designIconSuggestions(name, count = 3) {\n` +
    `  return Object.keys(designIcons)\n` +
    `    .map((candidate) => [candidate, distance(name, candidate)])\n` +
    `    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))\n` +
    `    .slice(0, count)\n` +
    `    .map(([candidate]) => candidate);\n` +
    `}\n`,
);
fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "design-icons.LICENSE.txt"));
```

Run: `node scripts/generate-design-icons.cjs && node --test packages/shared/src/design-icons.test.mjs`
Expected: PASS. If the `close` assertion is too loose to be meaningful, delete it. Keep the `chevron-up-down` assertion, which is the realistic misspelling.

- [ ] **Step 5: Ignore the generated file in format and lint** (the same lists as Task 2 Step 6). Run `npm run lint`; expected PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-design-icons.cjs packages/shared/src/design-icons.mjs packages/shared/src/design-icons.LICENSE.txt packages/shared/src/design-icons.test.mjs package.json package-lock.json .oxfmtrc.json .oxlintrc.json
git commit -m "feat(designs): bundle Lucide icon geometry"
```

### Task 6: Add the `icon` layer type to the schema

**Files:**
- Modify: `packages/shared/src/design.mjs:26-78` (`nodeSchema`) and `checkedDesignDocument`
- Modify: `packages/shared/src/design.d.mts` (`DesignNode`)
- Test: `packages/shared/src/design.test.mjs`

**Interfaces:**
- Consumes: `designIcons`, `designIconSuggestions` (Task 5).
- Produces:
  - `DesignNode.type` includes `"icon"`, and `DesignNode.icon?: string`.
  - Icon rules, enforced in `checkedDesignDocument` so `insert`, `update` and `replace` all hit them:
    - `icon` must name a Lucide icon;
    - `stroke`, `radius`, `text` and `src` are rejected;
    - an icon can't be a parent.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/design.test.mjs`:

```js
const iconScreen = (icon = {}) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [{ id: "close", type: "icon", icon: "x", x: 20, y: 20, width: 24, height: 24, fill: "#111111", strokeWidth: 2, ...icon }],
});

test("icon layers name a Lucide icon and reject properties they can't draw", () => {
  assert.equal(validateDesignDocument(iconScreen()).nodes[0].icon, "x");
  assert.throws(() => validateDesignDocument(iconScreen({ icon: "chevron-up-down" })), /Unknown icon "chevron-up-down"\. Did you mean chevrons-up-down/);
  assert.throws(() => validateDesignDocument(iconScreen({ icon: undefined })), /needs an icon name/);
  for (const extra of [{ stroke: "#000" }, { radius: 4 }, { text: "x" }, { src: "https://example.com/x.png" }]) {
    assert.throws(() => validateDesignDocument(iconScreen(extra)), /Icon layer "close" can't use/, JSON.stringify(extra));
  }
  assert.throws(() => validateDesignDocument({ ...iconScreen(), nodes: [...iconScreen().nodes, { id: "inside", parentId: "close", type: "rectangle", width: 4, height: 4 }] }), /must be a frame/);
  assert.throws(() => validateDesignDocument({ ...iconScreen(), nodes: [{ id: "label", type: "text", width: 10, height: 10, icon: "x" }] }), /Only icon layers use "icon"/);
});

test("insert, update and replace all validate icon names", () => {
  const base = validateDesignDocument(iconScreen());
  assert.throws(() => applyDesignOperations(base, [{ op: "update", id: "close", patch: { icon: "crosss" } }]), /Unknown icon "crosss"/);
  assert.throws(() => applyDesignOperations(base, [{ op: "insert", node: { id: "n", type: "icon", icon: "nope", width: 24, height: 24 } }]), /Unknown icon "nope"/);
  assert.throws(() => applyDesignOperations(base, [{ op: "replace", document: iconScreen({ icon: "nope" }) }]), /Unknown icon "nope"/);
  assert.equal(applyDesignOperations(base, [{ op: "update", id: "close", patch: { icon: "check" } }]).nodes[0].icon, "check");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/shared/src/design.test.mjs`
Expected: FAIL, because zod rejects `type: "icon"` and the unknown key `icon`.

- [ ] **Step 3: Extend the schema**

In `nodeSchema`, change `type` to `z.enum(["frame", "text", "rectangle", "ellipse", "image", "icon"])`. After `src`, add:

```js
    icon: z
      .string()
      .max(64)
      .optional()
      .describe("Lucide icon name for an icon layer, such as x, check, chevron-left or battery-full. fill is its line color, strokeWidth its line weight (default 2)."),
```

In `checkedDesignDocument`, inside the `for (const node of document.nodes)` loop, after the `checkColor` calls, add:

```js
    if (node.type === "icon") {
      if (!node.icon) throw new Error(`Icon layer "${node.id}" needs an icon name.`);
      if (!Object.hasOwn(designIcons, node.icon))
        throw new Error(`Unknown icon "${node.icon}". Did you mean ${designIconSuggestions(node.icon).join(", ")}?`);
      const unsupported = ["stroke", "radius", "text", "src"].filter((field) => node[field] !== undefined);
      if (unsupported.length) throw new Error(`Icon layer "${node.id}" can't use ${unsupported.join(", ")}. Use fill for its color and strokeWidth for its line weight.`);
    } else if (node.icon !== undefined) throw new Error(`Only icon layers use "icon"; "${node.id}" is a ${node.type}.`);
```

Import at the top: `import { designIcons, designIconSuggestions } from "./design-icons.mjs";`. The existing parent check (`Parent layer … must be a frame`) already stops icons from having children.

In `design.d.mts`, add `"icon"` to the `type` union and `icon?: string;` after `src?: string;`.

- [ ] **Step 4: Run the tests**

Run: `node --test packages/shared/src/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/design.mjs packages/shared/src/design.d.mts packages/shared/src/design.test.mjs
git commit -m "feat(designs): add Lucide icon layers to the design schema"
```

### Task 7: Render icon layers in HTML and SVG

**Files:**
- Modify: `packages/shared/src/design.mjs` (`nodeStyles`, `designMarkup`)
- Modify: `packages/shared/src/design-svg.mjs` (`renderChildren`)
- Test: `packages/shared/src/design.test.mjs`, `packages/shared/src/design-svg.test.mjs`

**Interfaces:**
- Consumes: `designIcons` (Task 5) and validated icon nodes (Task 6).
- Produces: icons as a 24-unit Lucide glyph scaled to fit the layer box, centred, never cropped. The line colour is `fill` (default `#202720`, tokens resolved) and the line weight is `strokeWidth` (default 2).

- [ ] **Step 1: Write the failing tests**

Append to `design.test.mjs`:

```js
test("icon layers render Lucide geometry with their color and weight", () => {
  const document = validateDesignDocument({ ...iconScreen({ fill: "$ink", strokeWidth: 1.5, width: 32, height: 24 }), tokens: { ink: "#123456" } });
  const html = designHtml(document);
  assert.match(html, /data-design-node="close"[^>]*style="[^"]*background:transparent/);
  assert.match(html, /<svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="none" stroke="#123456" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"\/><path d="m6 6 12 12"\/><\/svg>/);
  const svg = designSvg(document);
  assert.match(svg, /<svg x="20" y="20" width="32" height="24" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="#123456" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"\/>/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test packages/shared/src/design.test.mjs`
Expected: FAIL. The icon renders as an empty div with the `#d8ded8` background.

- [ ] **Step 3: Implement HTML**

In `nodeStyles`, make icons transparent like text. `fill` is the line colour, not a background:

```js
  const background = node.type === "text" || node.type === "icon" ? "transparent" : designColor(document, node.fill, placeholder);
```

In `designMarkup`, after the `image` branch:

```js
      } else if (node.type === "icon") {
        append(
          `<svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="none" stroke="${escape(designColor(document, node.fill, "#202720"))}" stroke-width="${node.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${designIcons[node.icon]}</svg>`,
          node,
        );
```

Also stop `nodeStyles` from emitting a border for icons. Change the `border:` entry to:

```js
    `border:${node.stroke && node.type !== "icon" ? (node.strokeWidth ?? 1) : 0}px solid ${designColor(document, node.stroke)}`,
```

Icons never have `stroke` after validation; this guard keeps `strokeWidth` from doubling as a border width.

- [ ] **Step 4: Implement SVG**

In `design-svg.mjs` `renderChildren`, before `const strokeWidth = …`, branch on icons. They need no clip shape and no stroke geometry:

```js
        if (node.type === "icon") {
          const { color, opacity } = paint(resolveColor(node.fill, "#202720"));
          return take(
            `<g id="layer-${xml(node.id)}" opacity="${number((node.opacity ?? 1) * opacity)}"><title>${xml(node.name ?? node.id)}</title><svg x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="${xml(color)}" stroke-width="${number(node.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round">${designIcons[node.icon]}</svg></g>`,
            node,
          );
        }
```

Move the `const clip = …` and `definitions.push(…clipPath…)` lines below this branch so icons emit no unused clip path. Import `designIcons` from `./design-icons.mjs`.

- [ ] **Step 5: Run the tests**

Run: `node --test packages/shared/src/*.test.mjs`
Expected: PASS. If the SVG test fails on attribute order, fix the implementation to emit the order the test states. The test is the contract.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/design.mjs packages/shared/src/design-svg.mjs packages/shared/src/design.test.mjs
git commit -m "feat(designs): render icon layers in previews and SVG"
```

### Task 8: Icon layers in the desktop editor

**Files:**
- Modify: `apps/desktop/app/src/components/agents/DesignTools.tsx:3-24` (tool rail) and `:106-118` (layer glyph)
- Modify: `apps/desktop/app/src/components/agents/DesignEditor.tsx:552-565` (`add`) and the inspector around `:1090-1120`
- Modify: `scripts/test-design-editor.cjs` (tool rail count `6` → `7`, plus an icon flow)
- Test: `scripts/test-design-editor.cjs`

**Interfaces:**
- Consumes: the icon schema (Task 6) and `designIcons` exported from `@milagre/shared/design`. Add `export { designIcons } from "./design-icons.mjs";` to `design.mjs` and `export const designIcons: Record<string, string>;` to `design.d.mts`.
- Produces: users can add an icon layer, change its name, colour and line weight, and see it in Layers.

- [ ] **Step 1: Write the failing Electron check**

In `scripts/test-design-editor.cjs`:
1. Change `assert.equal(await evaluate('document.querySelector("[data-slot=design-tool-rail]").querySelectorAll("button").length'), 6);` to `7`.
2. After the layers-panel block that ends with `"the toolbar toggles Layers closed"`, add an icon flow that reuses the file's `click`, `evaluate`, `waitFor`, `status` and `screenshot` helpers:

```js
    // Icon layers: add, rename to another Lucide icon, and see the new geometry in the preview.
    await click('[aria-label="Add icon"]');
    await waitFor(`${status}.textContent.includes("Saved")`);
    const iconField = 'document.querySelector("input[aria-label=Icon]")';
    assert.equal(await evaluate(`${iconField}.value`), "star", "a new icon layer starts as a star");
    await evaluate(`(() => { const input = ${iconField}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "chevron-left"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await waitFor(`new DOMParser().parseFromString(${editor}.querySelector("iframe").srcdoc, "text/html").querySelector('[data-design-node^="icon-"] svg path')?.getAttribute("d") === "m15 18-6-6 6-6"`);
    assert.equal(await evaluate('!!document.querySelector("input[aria-label=Stroke]")'), false, "icons have no border stroke field");
    assert.equal(await evaluate('!!document.querySelector("input[aria-label=\\"Line weight\\"]")'), true);
    await screenshot("icon-layer");
```

Check how the file commits other `Field` edits (look for the existing `Image URL` or `Radius` flow) and copy that exact commit mechanism if it differs from Enter.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --only design-editor`
Expected: FAIL. There are 6 buttons, not 7.

- [ ] **Step 3: Implement the tool rail and layer glyph**

In `DesignTools.tsx`, import `StarIcon` from `@hugeicons/core-free-icons` and add `{ type: "icon", label: "Add icon", icon: StarIcon },` after the image entry. In the glyph chain, add `: node.type === "icon" ? "✦"` before the `ellipse` case.

- [ ] **Step 4: Implement `add` defaults**

In `DesignEditor.tsx` `add`:
- the name map gains `type === "icon" ? "Icon"`;
- size: `width: type === "text" ? 240 : type === "icon" ? 24 : 160`, and `height: type === "text" ? 44 : type === "icon" ? 24 : 120`;
- the spread becomes:

```tsx
      ...(type === "text"
        ? { text: "New text", fontSize: 24, fill: "#1f2937" }
        : type === "icon"
          ? { icon: "star", fill: "#1f2937", strokeWidth: 2 }
          : { fill: "#dce6df", radius: 12 }),
```

- [ ] **Step 5: Implement the inspector**

In the inspector:
1. Wrap the `Radius` field, the `Stroke` field and the `Stroke width` field each in `selectedNode.type !== "icon" &&`. Keep the `grid-cols-2` layout intact: when Radius is hidden, Opacity sits alone in the row.
2. After the image `Field`, add:

```tsx
                    {selectedNode.type === "icon" && (
                      <>
                        <Field
                          label="Icon"
                          value={selectedNode.icon ?? ""}
                          disabled={saving}
                          onCommit={(icon) => {
                            const name = icon.trim().toLowerCase();
                            if (designIcons[name]) patch({ icon: name });
                            else setNotice(`No Lucide icon named "${name}". Try a name from lucide.dev/icons.`);
                          }}
                        />
                        <Field
                          label="Line weight"
                          value={selectedNode.strokeWidth ?? 2}
                          number
                          min={0.5}
                          max={4}
                          disabled={saving}
                          onCommit={(strokeWidth) => patch({ strokeWidth: Number(strokeWidth) })}
                        />
                      </>
                    )}
```

Check that `setNotice` exists in this scope; it is used at `:540`. If the inspector lives in a child component without it, use that component's error mechanism instead. The Fill field already exists for all layers and is the icon colour; leave it.

This is a free-text field, not a choice menu, so `docs/agents/ui.md`'s choice-menu primitive rule does not apply. A searchable picker is a later improvement.

- [ ] **Step 6: Run the checks**

Run: `npm run typecheck && npm test -- --only design-editor && npm test -- --only design-csp`
Expected: PASS. Save the screenshot with `MILAGRE_SCREENSHOT_DIR=$TMPDIR/design-icons npm test -- --only design-editor`.

- [ ] **Step 7: Commit and open PR 3**

```bash
git add apps/desktop/app/src/components/agents/DesignTools.tsx apps/desktop/app/src/components/agents/DesignEditor.tsx packages/shared/src/design.mjs packages/shared/src/design.d.mts scripts/test-design-editor.cjs
git commit -m "feat(designs): add, edit and list icon layers in the desktop editor"
npm run lint && npm test -- --unit
git push -u origin HEAD
```

Open the PR with `gh pr create --base milagre/design-inter`. The body shows the editor screenshot with an icon layer, and a rendered phone mock with `x`, `check` and `chevrons-up-down` icons, both on `screenshots/design-icons/`.

Phone check: open that design on the phone. Icons render in the card and the full-screen viewer with no grey boxes.

---

## PR 4: the agent sees its design

Create the branch: `git switch -c milagre/design-feedback`

### Task 9: Layout warnings

**Files:**
- Create: `packages/shared/src/design-lint.mjs`
- Modify: `packages/shared/src/design.mjs` (re-export), `packages/shared/src/design.d.mts` (types)
- Test: `packages/shared/src/design-lint.test.mjs`

**Interfaces:**
- Consumes: `designLayout`, `designTextLayout`, `designColor`, `validateDesignDocument`.
- Produces:
  - `designWarnings(document): Array<{ id: string, kind: "clipped-text" | "overflow" | "off-canvas" | "low-contrast" | "remote-image", message: string }>`;
  - `designWarningText(warnings): string`, at most 20 lines plus `…and N more`, or `""`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/design-lint.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { designWarnings, designWarningText, validateDesignDocument } from "./design.mjs";

const doc = (nodes, extra = {}) => validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, background: "#ffffff", nodes, ...extra });
const kinds = (document) => designWarnings(document).map((warning) => `${warning.kind}:${warning.id}`);

test("clipped text, overflowing children and off-canvas layers are reported", () => {
  const document = doc([
    { id: "card", type: "frame", x: 20, y: 20, width: 200, height: 100, fill: "#ffffff" },
    { id: "long", parentId: "card", type: "text", width: 180, height: 20, text: "This sentence is far too long to fit on one twenty pixel line", fill: "#111111" },
    { id: "wide", parentId: "card", type: "rectangle", x: 150, y: 10, width: 100, height: 20, fill: "#eeeeee" },
    { id: "outside", type: "rectangle", x: 350, y: 800, width: 100, height: 100, fill: "#eeeeee" },
  ]);
  assert.deepEqual(kinds(document).sort(), ["clipped-text:long", "off-canvas:outside", "overflow:wide"]);
});

test("low contrast text is reported against the nearest filled ancestor, scaled for large text", () => {
  const document = doc([
    { id: "dark", type: "frame", x: 0, y: 0, width: 390, height: 200, fill: "#111111" },
    { id: "muted", parentId: "dark", type: "text", width: 300, height: 30, text: "Muted", fill: "#333333", fontSize: 14 },
    { id: "big", parentId: "dark", type: "text", y: 40, width: 300, height: 40, text: "Big", fill: "#777777", fontSize: 28 },
    { id: "fine", type: "text", y: 300, width: 300, height: 30, text: "Fine", fill: "#111111" },
  ]);
  assert.deepEqual(kinds(document), ["low-contrast:muted"]);
});

test("remote images are named; hidden layers and tight but fitting text are not", () => {
  const document = doc([
    { id: "photo", type: "image", width: 100, height: 100, src: "https://example.com/a.png" },
    { id: "ghost", type: "rectangle", x: 380, width: 100, height: 10, hidden: true },
    { id: "fits", type: "text", y: 200, width: 300, height: 22, text: "Fits", fill: "#111111", fontSize: 16 },
  ]);
  assert.deepEqual(kinds(document), ["remote-image:photo"]);
});

test("the warning text is capped at 20 lines", () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({ id: `o${index}`, type: "rectangle", x: 380, y: index * 20, width: 50, height: 10 }));
  const text = designWarningText(designWarnings(doc(nodes)));
  assert.equal(text.split("\n").length, 21);
  assert.match(text, /…and 5 more$/);
  assert.equal(designWarningText([]), "");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/shared/src/design-lint.test.mjs`
Expected: FAIL, because `designWarnings` is not exported.

- [ ] **Step 3: Implement**

`packages/shared/src/design-lint.mjs`:

```js
import { designLayout, designTextLayout } from "./design-layout.mjs";
import { visibleDesignTextLines } from "./design-render-limits.mjs";

const MAX_WARNINGS = 20;

// sRGB relative luminance of a 3/6-digit hex or rgb() color; null for anything we can't resolve confidently.
function luminance(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? "");
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*1(?:\.0+)?\s*)?\)$/i.exec(color ?? "");
  const channels = hex
    ? (hex[1].length === 3 ? hex[1].split("").map((c) => c + c) : hex[1].match(/../g)).map((pair) => parseInt(pair, 16))
    : rgb
      ? rgb.slice(1, 4).map(Number)
      : null;
  if (!channels) return null;
  const [r, g, b] = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Problems an agent can't see in JSON: text cut off, layers spilling out, unreadable text. Pure; layer ids included. */
export function designWarnings(document) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const bounds = designLayout(document, designTextLayout);
  const resolve = (value) => (value?.startsWith("$") ? document.tokens?.[value.slice(1)] : value);
  const warnings = [];
  for (const node of document.nodes) {
    const box = bounds.get(node.id);
    if (!box) continue;
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    const parentBox = parent ? bounds.get(parent.id) : { x: 0, y: 0, width: document.width, height: document.height };
    if (node.type === "text") {
      const border = node.stroke ? (node.strokeWidth ?? 1) : 0;
      const layout = designTextLayout(node, Math.max(1, box.width - 2 * border));
      if (visibleDesignTextLines(node, box, layout).length < layout.lines.length || layout.height > box.height - 2 * border + 1)
        warnings.push({ id: node.id, kind: "clipped-text", message: `Text "${node.id}" needs ${Math.ceil(layout.height)}px but has ${Math.floor(box.height)}px; it is cut off. Use heightMode "hug" or shorten it.` });
    }
    const outside = box.x < parentBox.x - 1 || box.y < parentBox.y - 1 || box.x + box.width > parentBox.x + parentBox.width + 1 || box.y + box.height > parentBox.y + parentBox.height + 1;
    if (outside)
      warnings.push(
        parent
          ? { id: node.id, kind: "overflow", message: `"${node.id}" extends outside its parent "${parent.id}" and is clipped.` }
          : { id: node.id, kind: "off-canvas", message: `"${node.id}" extends past the ${document.width}×${document.height} screen.` },
      );
    if (node.type === "image" && node.src?.startsWith("https:"))
      warnings.push({ id: node.id, kind: "remote-image", message: `Image "${node.id}" is a remote URL, shown as a placeholder in your preview; the user sees the real image.` });
    if (node.type === "text") {
      let backdrop = null;
      for (let ancestor = parent; ancestor && backdrop === null; ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : null) {
        if (ancestor.type === "image") break;
        if (ancestor.fill) backdrop = resolve(ancestor.fill);
      }
      const foreground = luminance(resolve(node.fill ?? "#202720"));
      const background = luminance(backdrop ?? resolve(document.background ?? "#ffffff"));
      const minimum = (node.fontSize ?? 16) >= 24 ? 3 : 4.5;
      if (foreground !== null && background !== null && contrast(foreground, background) < minimum)
        warnings.push({ id: node.id, kind: "low-contrast", message: `Text "${node.id}" has ${contrast(foreground, background).toFixed(1)}:1 contrast; it needs ${minimum}:1.` });
    }
  }
  return warnings;
}

export function designWarningText(warnings) {
  const lines = warnings.slice(0, MAX_WARNINGS).map((warning) => `- ${warning.message}`);
  if (warnings.length > MAX_WARNINGS) lines.push(`…and ${warnings.length - MAX_WARNINGS} more`);
  return lines.join("\n");
}
```

In `design.mjs`, re-export: `export { designWarnings, designWarningText } from "./design-lint.mjs";`. In `design.d.mts`:

```ts
export interface DesignWarning { id: string; kind: "clipped-text" | "overflow" | "off-canvas" | "low-contrast" | "remote-image"; message: string }
export function designWarnings(document: DesignDocument): DesignWarning[];
export function designWarningText(warnings: DesignWarning[]): string;
```

Hidden layers have no box (`designLayout` skips them), so they are not reported.

- [ ] **Step 4: Run the tests**

Run: `node --test packages/shared/src/design-lint.test.mjs packages/shared/src/design.test.mjs`
Expected: PASS. If the "fits" text reports `clipped-text`, the `+ 1` tolerance is wrong for `lineHeight` 1.35 at 16 px (21.6 px in a 22 px box). Fix the comparison, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/design-lint.mjs packages/shared/src/design-lint.test.mjs packages/shared/src/design.mjs packages/shared/src/design.d.mts
git commit -m "feat(designs): report clipped text, overflow, off-canvas layers and low contrast"
```

### Task 10: Rasterize designs in the daemon

**Files:**
- Create: `packages/core/src/design-raster.cjs`
- Modify: `packages/core/package.json` (dependency `@resvg/resvg-wasm`)
- Modify: root `package.json` `build.asarUnpack` (add `node_modules/@resvg/resvg-wasm/**/*`)
- Test: `packages/core/src/design-raster.test.cjs`

**Interfaces:**
- Consumes: `designSvg` from `@milagre/shared/design` and `designInterFonts` re-exported from it. Add `export { designInterFonts } from "./design-font-data.mjs";` to `design.mjs` and a matching declaration to `design.d.mts`.
- Produces: `renderDesignPng(document): Promise<{ mime: "image/png", base64: string, width: number, height: number }>`, capped at 1568 px on the long edge.

- [ ] **Step 1: Add the dependency**

Run: `npm i -w @milagre/core @resvg/resvg-wasm@2.6.2`

- [ ] **Step 2: Write the failing test**

`packages/core/src/design-raster.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { renderDesignPng } = require("./design-raster.cjs");

const phone = (nodes) => ({ schemaVersion: 1, width: 390, height: 844, background: "#ffffff", nodes });

test("a phone design renders to a 1x PNG with Inter text and icons", async () => {
  const png = await renderDesignPng(
    phone([
      { id: "title", type: "text", x: 16, y: 60, width: 300, height: 40, text: "Filter and sort", fontSize: 24, fontWeight: 600, fill: "#111111" },
      { id: "close", type: "icon", icon: "x", x: 340, y: 64, width: 24, height: 24, fill: "#111111" },
    ]),
  );
  assert.equal(png.mime, "image/png");
  assert.deepEqual([png.width, png.height], [390, 844]);
  const bytes = Buffer.from(png.base64, "base64");
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(bytes.length > 2000, "text and icon pixels were drawn");
});

test("large canvases are scaled to 1568px on the long edge", async () => {
  const png = await renderDesignPng({ schemaVersion: 1, width: 3840, height: 2160, nodes: [] });
  assert.deepEqual([png.width, png.height], [1568, 882]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test packages/core/src/design-raster.test.cjs`
Expected: FAIL, `Cannot find module './design-raster.cjs'`.

- [ ] **Step 4: Implement**

`packages/core/src/design-raster.cjs`:

```js
const fs = require("node:fs");

// The agent's view of a design: the shared SVG, drawn by resvg in WebAssembly so it works on any daemon, headless too.
// resvg reads fonts from buffers, not @font-face; remote https images are not fetched and keep their placeholder.
const MAX_EDGE = 1568;
let ready;

async function load() {
  const [{ initWasm, Resvg }, { designSvg, designInterFonts }] = await Promise.all([import("@resvg/resvg-wasm"), import("@milagre/shared/design")]);
  await initWasm(fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  const fontBuffers = Object.values(designInterFonts).map((base64) => new Uint8Array(Buffer.from(base64, "base64")));
  return { Resvg, designSvg, fontBuffers };
}

async function renderDesignPng(document) {
  ready ??= load().catch((error) => {
    ready = undefined;
    throw error;
  });
  const { Resvg, designSvg, fontBuffers } = await ready;
  const scale = Math.min(1, MAX_EDGE / Math.max(document.width, document.height));
  const rendered = new Resvg(designSvg(document), {
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
    fitTo: { mode: "zoom", value: scale },
  }).render();
  const result = { mime: "image/png", base64: Buffer.from(rendered.asPng()).toString("base64"), width: rendered.width, height: rendered.height };
  rendered.free?.();
  return result;
}

module.exports = { renderDesignPng };
```

Check `require.resolve("@resvg/resvg-wasm/index_bg.wasm")`: if the package's `exports` map blocks the subpath, resolve `@resvg/resvg-wasm/package.json` and join `index_bg.wasm`.

- [ ] **Step 5: Run the test**

Run: `node --test packages/core/src/design-raster.test.cjs`
Expected: PASS. Open the PNG once by hand to look at it: decode `base64` to `$TMPDIR/raster.png` in a scratch script and Read it. Confirm the Inter title and the X are visible.

- [ ] **Step 6: Ship the WASM in packaged builds**

Add `"node_modules/@resvg/resvg-wasm/**/*"` to `build.asarUnpack` in the root `package.json`. Then extend `apps/desktop/electron/packaged-requires.test.cjs` with a test that this path is listed:

```js
test("the design rasterizer's WebAssembly ships outside the asar", () => {
  const unpack = require(path.join(root, "package.json")).build.asarUnpack;
  assert.ok(unpack.includes("node_modules/@resvg/resvg-wasm/**/*"));
});
```

Run: `node --test apps/desktop/electron/packaged-requires.test.cjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/design-raster.cjs packages/core/src/design-raster.test.cjs packages/core/package.json package.json package-lock.json apps/desktop/electron/packaged-requires.test.cjs packages/shared/src/design.mjs packages/shared/src/design.d.mts
git commit -m "feat(designs): rasterize designs to PNG in the daemon with resvg"
```

### Task 11: Tool results can carry images

**Files:**
- Modify: `packages/core/src/linked-tools.cjs:324-335` (`runTool`)
- Modify: `packages/core/src/agents/claude-provider.cjs:74-77`
- Modify: `packages/core/src/linked-mcp-server.cjs:107-108`
- Modify: `packages/core/src/local-mcp-server.cjs:126-127`
- Modify: `packages/core/src/agents/steps.cjs:65-74` (`artifactRef`)
- Test: `packages/core/src/linked-tools.test.cjs`, `packages/core/src/local-mcp-server.test.cjs`, `packages/core/src/agents/steps.test.cjs`

**Interfaces:**
- Produces:
  - A tool's `run` may return a string or `{ text: string, images?: Array<{ mime: string, base64: string }> }`.
  - `runTool` returns `{ text, images: [], isError }`, with `images` always an array.
  - `mcpContent({ text, images }): Array<{type:"text",text} | {type:"image",data,mimeType}>` is exported from `linked-tools.cjs`.
  - `artifactRef` reads only the first line of the result text.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/linked-tools.test.cjs`:

```js
test("runTool passes images through and mcpContent orders text before images", async () => {
  const { runTool, mcpContent } = require("./linked-tools.cjs");
  const definition = { name: "t", input: {}, run: async () => ({ text: "{\"id\":\"a\"}", images: [{ mime: "image/png", base64: "AAAA" }] }) };
  const result = await runTool(definition, {});
  assert.deepEqual(result, { text: "{\"id\":\"a\"}", images: [{ mime: "image/png", base64: "AAAA" }], isError: false });
  assert.deepEqual(mcpContent(result), [
    { type: "text", text: "{\"id\":\"a\"}" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.deepEqual((await runTool({ name: "s", input: {}, run: async () => "plain" }, {})).images, []);
});
```

Append to `packages/core/src/agents/steps.test.cjs`, following that file's helpers for a Claude `tool_result` block. If none fit, call the exported `claudeStepResult`, or whatever the test file already uses for `design_show`:

```js
test("a design result with an image attached still produces the Chat card", () => {
  // The content block list a Claude tool_result carries when Milagre attaches the rendered design.
  const block = {
    type: "tool_result",
    tool_use_id: "call-1",
    content: [
      { type: "text", text: JSON.stringify({ id: "welcome", title: "Welcome", version: 2, format: "design", warnings: [] }) },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ],
  };
  const step = claudeStepResult({ id: "call-1", name: "mcp__milagre__design_show", input: {} }, block, undefined);
  assert.deepEqual(step.artifact, { id: "welcome", version: 2, title: "Welcome", format: "design" });
});
```

If `claudeStepResult` isn't exported, find how existing `steps.test.cjs` tests reach design tool results (search for `design_show`) and write the test through the same entry point.

Append to `packages/core/src/local-mcp-server.test.cjs` one test that a `tools/call` whose tool returns `{ text, images }` answers with `content` of length 2, the second `{ type: "image", data, mimeType }`. Copy the existing `tools/call` test in that file for the server setup.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/core/src/linked-tools.test.cjs packages/core/src/agents/steps.test.cjs packages/core/src/local-mcp-server.test.cjs`
Expected:
- `runTool` returns `[object Object]` as text;
- `mcpContent` is undefined;
- `artifact` is undefined, because `JSON.parse` fails on the `\n[image]` suffix.

- [ ] **Step 3: Implement `runTool` and `mcpContent`**

```js
/** Runs a definition with arguments checked against its input; failures come back as the tool's error text. */
async function runTool(definition, args) {
  try {
    const parsed = (definition.strict ? z.strictObject(definition.input) : z.object(definition.input)).parse(args ?? {});
    const result = await definition.run(parsed);
    if (result && typeof result === "object") return { text: String(result.text), images: result.images ?? [], isError: false };
    return { text: String(result), images: [], isError: false };
  } catch (error) {
    const text =
      error instanceof z.ZodError
        ? `Invalid arguments: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`
        : error.message;
    return { text, images: [], isError: true };
  }
}

/** MCP content for a tool result: its text, then any images, which Claude and Codex both read. */
const mcpContent = ({ text, images = [] }) => [{ type: "text", text }, ...images.map((image) => ({ type: "image", data: image.base64, mimeType: image.mime }))];
```

Add `mcpContent` to `module.exports`.

- [ ] **Step 4: Use it in the three transports**

- `claude-provider.cjs` `linkedOptions`:

  ```js
          async (args) => {
            const result = await runTool(definition, args);
            return { content: mcpContent(result), isError: result.isError };
          },
  ```

  Import `mcpContent` next to `runTool`.
- `linked-mcp-server.cjs:107-108`: `const result = await runTool(tool, message.params?.arguments); return ok({ content: mcpContent(result), isError: result.isError });`
- `local-mcp-server.cjs:126-127`: `return ok({ content: mcpContent(result), isError: result.isError });`

- [ ] **Step 5: Make `artifactRef` read the first line**

```js
// The artifact a finished design tool made, from the first line of its result: the JSON summary. Attached images follow it.
function artifactRef(text) {
  try {
    const { id, version, title, format } = JSON.parse(String(text).split("\n", 1)[0]);
```

The rest of the function stays as it is.

- [ ] **Step 6: Run the tests**

Run: `node --test packages/core/src/*.test.cjs packages/core/src/agents/*.test.cjs`
Expected: PASS. Existing tests that destructure `{ text, isError }` from `runTool` keep working; the extra `images` key is ignored.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/linked-tools.cjs packages/core/src/agents/claude-provider.cjs packages/core/src/linked-mcp-server.cjs packages/core/src/local-mcp-server.cjs packages/core/src/agents/steps.cjs packages/core/src/*.test.cjs packages/core/src/agents/*.test.cjs
git commit -m "feat(agents): let Milagre tools return images to the agent"
```

### Task 12: `design_show` and `design_apply` return the render and warnings

**Files:**
- Modify: `packages/core/src/chat-artifacts.cjs:426-467` (`artifactToolDefinitions`)
- Test: `packages/core/src/chat-artifacts.test.cjs`, `packages/core/src/design-mcp-tools.test.cjs`

**Interfaces:**
- Consumes: `renderDesignPng` (Task 10), `designWarnings` and `designWarningText` (Task 9), and the `{ text, images }` run result (Task 11).
- Produces: `design_show` and `design_apply` return `{ text, images }`:
  - `text` line 1 is the existing summary JSON with an added `warnings: DesignWarning[]` field;
  - text line 2 onward is a short human note;
  - `images` holds one PNG, or nothing if rendering failed.
- `artifactToolDefinitions(chatId, api, authorization, { renderPng = renderDesignPng } = {})` gains an options argument so tests can inject a failing renderer.

- [ ] **Step 1: Write the failing tests**

In `chat-artifacts.test.cjs`, update the four existing call sites that `JSON.parse` a `design_show` / `design_apply` result (lines 291 and 347, and in `design-mcp-tools.test.cjs` lines 51 and 75) to parse the first line of `.text`:

```js
const firstLine = (result) => JSON.parse(result.text.split("\n", 1)[0]);
```

Then append:

```js
test("design_show and design_apply attach the rendered design and its warnings", async (t) => {
  const { tools } = await fixture(t);
  const shown = await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  assert.equal(firstLine(shown).version, 1);
  assert.deepEqual(firstLine(shown).warnings, []);
  assert.equal(shown.images.length, 1);
  assert.equal(shown.images[0].mime, "image/png");
  assert.match(shown.text, /\nLook at the image/);
  const edited = await tools.design_apply.run({
    id: "welcome",
    expectedVersion: 1,
    operations: [{ op: "update", id: "heading", patch: { text: "A welcome heading long enough to wrap onto several lines inside a short box", heightMode: "fixed", height: 20 } }],
  });
  assert.deepEqual(firstLine(edited).warnings.map((warning) => warning.kind), ["clipped-text"]);
  assert.match(edited.text, /- Text "heading" needs/);
});

test("a render failure still saves the version and returns the summary", async (t) => {
  const { api } = await fixture(t);
  const tools = Object.fromEntries(
    artifactToolDefinitions(CHAT, api, undefined, { renderPng: async () => { throw new Error("wasm missing"); } }).map((tool) => [tool.name, tool]),
  );
  const shown = await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  assert.equal(firstLine(shown).version, 1);
  assert.deepEqual(shown.images, []);
  assert.match(shown.text, /preview could not be rendered: wasm missing/);
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).version, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test packages/core/src/chat-artifacts.test.cjs packages/core/src/design-mcp-tools.test.cjs`
Expected: FAIL. Results are strings, so `.text` is undefined.

- [ ] **Step 3: Implement**

In `chat-artifacts.cjs`:
- extend the shared import with `designWarnings, designWarningText`;
- add `const { renderDesignPng } = require("./design-raster.cjs");`;
- change the signature to `function artifactToolDefinitions(chatId, api, authorization, { renderPng = renderDesignPng } = {})`.

Above it, add:

```js
// What the agent sees after a design call: the summary (first line, which the Chat card parses), the warnings, and
// the saved version drawn as a PNG. Drawing never fails the call; the version is already saved.
async function designFeedback(summary, document, renderPng) {
  const warnings = designWarnings(document);
  const notes = [JSON.stringify({ ...summary, warnings })];
  let images = [];
  try {
    images = [await renderPng(document)];
    notes.push("Look at the image: check icons, spacing, alignment and density against the brief, fix what looks wrong and every warning below with design_apply, then reply.");
  } catch (error) {
    notes.push(`The preview could not be rendered: ${error.message}. Check the warnings below.`);
  }
  const text = designWarningText(warnings);
  if (text) notes.push(`Warnings:\n${text}`);
  return { text: notes.join("\n"), images };
}
```

`design_show.run`:

```js
      run: async (args) => {
        const design = await api.showDesign({ chatId, ...args }, authorization);
        return designFeedback(design, validateDesignDocument(args.document), renderPng);
      },
```

`design_apply.run`:

```js
      run: async (args) => {
        const { html: _html, document, ...design } = await api.apply({ chatId, ...args }, authorization);
        return designFeedback(design, document, renderPng);
      },
```

`design-mcp-tools.cjs` calls `artifactToolDefinitions(chatId, artifacts, …)` with three arguments; the default renderer applies, so it needs no change.

- [ ] **Step 4: Run the tests**

Run: `node --test packages/core/src/*.test.cjs packages/core/src/agents/*.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chat-artifacts.cjs packages/core/src/chat-artifacts.test.cjs packages/core/src/design-mcp-tools.test.cjs
git commit -m "feat(designs): show the agent its rendered design and layout warnings"
```

### Task 13: Rewrite the design skill around the loop

**Files:**
- Modify: `packages/core/src/bundled-skills/design/SKILL.md`
- Modify: `packages/core/src/chat-artifacts.cjs` (`design_show` description, one sentence)
- Test: `packages/core/src/bundled-skills.test.cjs` (only if it asserts skill text; run it either way)

**Interfaces:**
- Consumes: everything above.
- Produces: the skill text agents read before their first design.

- [ ] **Step 1: Edit the process list**

Replace step 2 and insert a new step 3 in the numbered list. Keep steps 1, 4 and 5 (renumbered 1, 5 and 6) word for word:

```markdown
2. **Show it.** Call `design_show` with a title and one document per screen. Set its width and height (390 by 844 for a phone). Give layers stable, meaningful ids and names. Use real content: the dates, names, badges and chips a real screen would show, not a simplified placeholder.
3. **Look before you reply.** `design_show` and `design_apply` return the saved design as an image, plus warnings for clipped text, layers outside their parent or the screen, and low contrast. Look at the image. Fix every warning and anything that looks off (alignment, uneven spacing, icons, crowding) with `design_apply`. Do at most two fix rounds, then reply. Remote `https:` images show as placeholders in your image only; the user sees them.
```

- [ ] **Step 2: Add the craft sections before "## Document format"**

```markdown
## Craft

- **Icons.** Use an `icon` layer for every icon, with a Lucide name from lucide.dev/icons. Never use a Unicode glyph or an image of an icon. `fill` is its color and `strokeWidth` its line weight (2 by default; 1.5 reads closer to SF Symbols). Common names: `chevron-left`, `chevron-right`, `x`, `check`, `chevrons-up-down`, `sliders-horizontal`, `search`, `plus`, `ellipsis`, `signal`, `wifi`, `battery-full`.
- **Type.** Inter is the default and is measured. Keep one scale per screen; for iOS: 34 large title, 22 title, 17 body and row labels, 15 secondary, 13 captions and section headers. Titles use weight 600, body 400. Make secondary text a lighter color rather than a smaller size.
- **Spacing.** Work on a 4 px grid. Use 16 to 20 px screen margins on a phone, 44 px minimum touch targets, 12 to 16 px inside grouped rows, and the same gap between siblings of the same kind.
- **Phone chrome.** Use a 54 px status bar with the time at 17/600 on the left and `signal`, `wifi` and `battery-full` icons at 17 px on the right. Navigation buttons are 44 px circles with a 20 px icon centred inside.
- **Density.** Match the app you are designing for. A list row in a booking app shows its date, title, time and status; don't drop columns to make the layout easier.
```

- [ ] **Step 3: Add icons to the property list**

In "Available layer properties", add after the Images bullet:

```markdown
- **Icons:** use `icon` as the type and `icon` for its Lucide name. `fill` is the line color and `strokeWidth` the line weight. Icons can't have a stroke, radius, text or children, and an unknown name fails with the closest matches.
```

- [ ] **Step 4: Update the tool description**

In `design_show`'s description in `chat-artifacts.cjs`, change "with frames, text, shapes, images, layout and color tokens" to "with frames, text, shapes, icons, images, layout and color tokens", and add at the end: "The result includes the rendered design as an image and layout warnings; check both before replying."

- [ ] **Step 5: Run the skill tests and the full unit suite**

Run: `npm test -- --unit`
Expected: PASS. If a test pins the old description text, update it to the new sentence.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/bundled-skills/design/SKILL.md packages/core/src/chat-artifacts.cjs packages/core/src/*.test.cjs
git commit -m "docs(designs): teach the design skill icons, type, spacing and the look-before-reply loop"
```

### Task 14: Benchmark against Pencil, verify providers and the phone, open PR 4

**Files:**
- Create: `docs/design-quality-benchmark.md` (prompts and results; no images in the repo)
- Images: the `screenshots` branch, folder `design-quality-benchmark/`

**Interfaces:**
- Consumes: the full branch.
- Produces: evidence that the gap closed, or a list of what remains.

- [ ] **Step 1: Write the three prompts into `docs/design-quality-benchmark.md`**

1. "Design the iOS 'Filter and sort' sheet for a fitness studio's Reservations screen: the reservations list (October 2026, Tue 6 Barre Blender! 10:00am Josh Archer HARTLAND No-show; Mon 5 Barre Blender! 12:00pm Canceled; Thu 1 Vinyasa Flow 6:30pm Hannah Liao) dimmed behind a sheet with close and confirm buttons, Sort / Session time / Time booked rows, a 'Show standard cancels' checkbox with the footnote 'Late cancels always show.' and a Reset filters button. 390 by 844."
2. "Design an iOS Settings screen for the same app: profile header, grouped rows with leading icons for Notifications, Payment methods, Membership, Privacy, Help, a toggle for Class reminders, and Sign out. 390 by 844."
3. "Design a desktop studio dashboard at 1440 by 900: left sidebar navigation with icons, four stat cards (bookings today, attendance rate, revenue, waitlist), a table of today's classes with instructor, time, booked/capacity and status."

- [ ] **Step 2: Run them in Milagre with Claude**

Use `scripts/live-design-workflow.cjs --live` (read its header for flags; it runs a real Chat against a throwaway profile). Run each prompt once on `main` and once on this branch. Export each final version to PNG from the desktop editor, or with `renderDesignPng` from a scratch script in `$TMPDIR`.

- [ ] **Step 3: Run them in Pencil**

Use the Pencil app (pen.dev) with the same prompts, the same model and no extra guidance. Screenshot each result at the same size. If Pencil can't be run here, ask Victor for the three screenshots and note that in the doc.

- [ ] **Step 4: Verify providers read the image**

In the live run:
- **Claude:** the transcript shows the agent referring to something only visible in the image (it fixes a misaligned icon, for example) or making a `design_apply` fix round after `design_show`.
- **Codex:** run prompt 1 once with Codex. Record whether the reply shows it saw the image.
- **Antigravity:** run prompt 1 once. Record whether it received the image or only the warnings.

Write the result for each provider into the benchmark doc. If Codex or Antigravity drops images, add one line to SKILL.md step 3: "If your result has no image, rely on the warnings and `design_read`."

- [ ] **Step 5: Phone check**

Open the three Milagre results on the phone (Designs QA sim or a dev build per memory `design-artifacts`): the card and the full-screen viewer. Confirm Inter renders, the icons have no grey boxes, and nothing is clipped. The phone needs no OTA because nothing in `apps/mobile` changed. Say so in the PR.

- [ ] **Step 6: Push the images and finish the doc**

1. Fetch `screenshots` into a temporary worktree outside this one.
2. Add `design-quality-benchmark/{1,2,3}-{main,branch,pencil}.png` and push.
3. In `docs/design-quality-benchmark.md`, link each image by commit SHA in a table: prompt × (main, this branch, Pencil). Add one line per prompt saying where ours is still behind (for example "no shadows on the sheet").

- [ ] **Step 7: Full checks, commit, PR 4**

```bash
npm run typecheck && npm run lint && npm test -- --unit
npm test -- --only design-editor && npm test -- --only design-fonts && npm test -- --only design-csp && npm test -- --only design-page-viewer && npm test -- --only artifacts
git add docs/design-quality-benchmark.md packages/core/src/bundled-skills/design/SKILL.md
git commit -m "docs(designs): benchmark Milagre Designs against Pencil"
git push -u origin HEAD
gh pr create --base milagre/design-icons --title "feat(designs): show the agent its rendered design" --body-file <body file in $TMPDIR>
```

PR body:
- the benchmark table (image links by SHA);
- the provider results;
- the phone check;
- what remains for the next round (from Step 6).

---

## Done when

- All four PRs are merged in order.
- The benchmark table shows icons, type and density comparable to Pencil on all three prompts.
- The phone shows the same designs correctly with no OTA.
- Anything still behind is listed in the benchmark doc as the next round's scope.
