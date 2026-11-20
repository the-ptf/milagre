---
name: design
description: Create screen designs in a Milagre Chat, as named layers with layout and color tokens or as interactive HTML prototypes. Offer variants, act on the user's comments and build the chosen design.
---

# Designing in a Chat

Use this for UI screens, mockups, prototypes and visual designs. For an explainer, report or topic page, use `artifact_show` and the artifacts skill instead. If the user named another design tool (Pencil, Figma, Paper or any other MCP or app), use that tool.

Only agents change designs. The user views them on the Designs canvas on desktop and phone, tries interactive ones, pins comments, chooses one and asks for changes through Chat. A design is one of two kinds, fixed for all its versions:

- **Layers** (`document`): a static screen drawn from named layers. Best for quick exploration, many variants, and work held to the Project's kit.
- **Interactive** (`html` with `width` and `height`): your own HTML page, run live. Best when the screen has behaviour worth trying (navigation, tabs, toggles, forms, menus, animation) or the user asks for a prototype.

## Process

1. **Ground it.** If the Project has a `DESIGN.md` (at the root, or in the folder of the app you are designing for), read it before anything else: its colors, type, spacing, components and rules win over your own taste. Then call `design_kit_read` when available (all Chats in the Project share the kit) and reuse its snapshot as `document.kit`. On takeover, `design_inspect` shows the saved screen. In a project with an app, read its screens, colors, type and components and design in that style. Ask one question only if the platform or screen is unclear.
2. **Show it.** `design_show` with a title and one design per screen (390 by 844 for a phone). Give layers stable, meaningful ids and names. Use real content (dates, names, badges, chips), not placeholders. When the Chat covers several parts of the app, set `group` to the part (the same for every screen and variant of it); the canvas lays out one block per group.
3. **Look before you reply.** The result is the saved design as an image, plus warnings (clipped text, layers outside their parent or screen, low contrast) or, for interactive designs, the first screen and console messages. Fix every warning and console error unless the overflow is deliberate (edge bleed, scroll peek), and anything that looks off, with `design_apply`. At most two fix rounds. In your image only: remote `https:` images are placeholders, unbundled fonts draw in Inter, and characters it can't draw are blank; leave all three. If no image comes back, the design is still saved; don't call again just for one.
4. **Offer variants when the direction is open.** Two or three designs, each with its own id and a title naming the idea ("Alt B, dark timeline"), in the same group. One when the user was specific. A variant that keeps most of a saved design: `design_show` with a new `id`, `title`, `from: { "id": "<saved id>" }` and only the `operations` or `edits` that differ. Draw a new document only when the layout changes.
5. **Act on feedback.** `design_read` the latest version, then `design_apply` with it as `expectedVersion` and one batch. A version conflict means another agent changed it: read again and adapt. After addressing a comment, `artifact_resolve_comment` with its id and a one-line note; resolve only what you addressed.
6. **Build when asked.** `design_read` the chosen design and implement it in the project's own code and components. An interactive design's HTML is a reference to rebuild, not code to copy. `design_export` returns JSON, SVG or HTML when the user needs a file.

Keep replies short: say what differs between variants or what changed. The card shows the design.

## Craft

- **Icons.** An `icon` layer with a Lucide name (lucide.dev/icons) for every icon, never a Unicode glyph or image. `fill` is its color, `strokeWidth` its weight (2 default, 1.5 reads like SF Symbols). Common: `chevron-left`, `chevron-right`, `x`, `check`, `search`, `plus`, `ellipsis`, `sliders-horizontal`, `signal`, `wifi`, `battery-full`.
- **Type.** Inter by default. For a native Apple app use Apple's families (`SF Pro`, `SF Pro Rounded`, `SF Compact` on watchOS, `SF Mono`, `New York`) and call `design_font_info` first for the weights the font really has (SF Pro Semibold is 590, Medium 510). One scale per screen; for iOS: 34 large title (700), 22 title (600), 17 body and row labels (400), 15 secondary, 13 captions and section headers. Set secondary text apart with a lighter color too, not size alone.
- **Spacing.** A 4 px grid, 16 to 20 px phone margins, 44 px touch targets, 12 to 16 px inside grouped rows, equal gaps between siblings of a kind.
- **Phone chrome.** A 54 px status bar: time at 17/600 left, `signal`, `wifi`, `battery-full` at 17 px right. Nav buttons are 44 px circles with a 20 px icon.
- **Density.** Match the app. A booking row shows date, title, time and status; don't drop columns to ease the layout.

## Document format

`schemaVersion: 1`, `width`, `height`, optional `background`, optional color `tokens` (referenced as `$name`), and a flat `nodes` array. Every node has a unique `id`, `type`, `width` and `height`; `parentId` puts it inside a frame, and coordinates are relative to the parent (or the screen).

```json
{ "schemaVersion": 1, "width": 390, "height": 844, "background": "#f6f4ef",
  "tokens": { "ink": "#16261f", "accent": "#27634b" },
  "nodes": [
    { "id": "content", "name": "Welcome content", "type": "frame", "x": 24, "y": 72, "width": 342, "height": 272, "layout": "vertical", "gap": 20 },
    { "id": "heading", "parentId": "content", "name": "Page title", "type": "text", "width": 342, "height": 80,
      "text": "Make room for your next idea.", "fontSize": 32, "fontWeight": 700, "fill": "$ink" },
    { "id": "start-button", "parentId": "content", "name": "Start button", "type": "frame", "width": 342, "height": 52,
      "fill": "$accent", "radius": 12, "layout": "horizontal", "align": "center", "justify": "center" },
    { "id": "start-label", "parentId": "start-button", "name": "Start label", "type": "text", "width": 240, "height": 24,
      "text": "Start a project", "fontSize": 16, "fontWeight": 600, "textAlign": "center", "fill": "#ffffff" }
  ] }
```

- **All layers:** `id`, `name`, `type`, `parentId`, `x`, `y`, `width`, `height`, `widthMode`, `heightMode`, `minWidth`, `minHeight`, `fill`, `stroke`, `strokeWidth`, `radius`, `opacity`, `hidden`, `locked`.
- **Text:** `text`, `fontSize`, `fontFamily`, `fontWeight`, `lineHeight` (unitless, such as `1.35`), `letterSpacing` (px, negative tightens), `textAlign` (`left`, `center`, `right`). `fill` is the text color.
- **Frames:** `layout` (`free`, `horizontal`, `vertical`; the last two place children), `gap`, `padding`, `align` (`start`, `center`, `end`), `justify` (`start`, `center`, `end`, `space-between`).
- **Other types:** `rectangle`, `ellipse`, `image` (`src`), `icon` (`icon` name; no stroke, radius, text, src or children; an unknown name fails with the closest matches).
- **Paths:** `path` layers draw vectors for rings, arcs, charts and custom glyphs: `path` (SVG path data only, in the layer's own pixels, or in `viewBox: [0, 0, 24, 24]` units scaled to fit), `fill`, `stroke`, `strokeWidth`, `strokeCap` (`butt`, `round`, `square`), `strokeJoin` (`miter`, `round`, `bevel`), `strokeDash` (`[4, 2]`). For a progress ring use `arc: {start: 0, sweep: 270}` instead of `path` (degrees clockwise from 12 o'clock; 360 is a full ring): it is a stroke centred in the layer and inset by `strokeWidth` (default 4), colored by `stroke` (or `fill`), with round caps; stack a full-ring track under it. Use icons for icons and paths only for what no icon draws.

**Sizing.** `widthMode`/`heightMode` take `fixed` (default), `hug` (fits text or children) or `fill` (shares the parent's remaining space). Keep numeric `width`/`height` as fallbacks; a fill child in a hug parent uses its fallback. For a vertical card, `heightMode: "hug"` on the frame and `widthMode: "fill", heightMode: "hug"` on its text, so longer copy pushes content down. Prefer hug text in new screens. Inter (400 to 700), the bundled families and the fonts installed on the user's computer are measured with the real font; other fonts and non-Latin scripts use approximate metrics.

## Color modes

One design, one layer tree, every mode: never duplicate a screen or invent `inkDark` tokens for dark mode. A token is one color for all modes or `{"light": "#111", "dark": "#f2f2f2", "contrast": "#000"}` (`light` required; a mode it leaves out uses light). A color field takes a CSS color, `$name`, `$name/0.4` (the token at 40% alpha) or `color-mix(in srgb, $accent 30%, $paper)`; token values may refer to other tokens. The canvas and the phone switch each design between Light, Dark and Increased contrast; shared pages show light. Your image shows light: pass `mode` to `design_show` or `design_inspect` to see and contrast-check another mode, and check every mode the design defines.

## Fonts

Besides Inter, these families are bundled (measured and embedded in previews, exports and your image). Name one first in `fontFamily` with a fallback of the same kind (`Bebas Neue, Arial, sans-serif`); missing weights render with the nearest drawn one.

Albert Sans, Anton, Archivo, Barlow, Barlow Condensed, Bebas Neue, Besley, Big Shoulders, Bodoni Moda, Bricolage Grotesque, Chivo, EB Garamond, Epilogue, Figtree, Hanken Grotesk, Imbue, Jost, League Spartan, Libre Franklin, Literata, Newsreader, Onest, Public Sans, Red Hat Display, Red Hat Text, Rokkitt, Schibsted Grotesk, Source Serif 4, Stack Sans Headline, Stack Sans Text, STIX Two Text, TikTok Sans, Unbounded, Work Sans, Young Serif, Zilla Slab.

**Installed fonts.** A family installed on the computer running Milagre draws and measures with the real font in the canvas, the phone and your image: on a Mac that includes `SF Pro` (optical size follows `fontSize`; `SF Pro Text` and `SF Pro Display` pin it), `SF Pro Rounded`, `SF Compact`, `SF Mono` and `New York`. `design_font_info {family}` returns its source, named weights, axes and metrics, or without `family` lists what is available. Apple's fonts render only in local previews: shared pages, and computers without them, draw a close substitute (Inter for SF, Source Serif 4 for New York), so keep a fallback of the same kind in `fontFamily`.

## Project visual kit

`design_kit_read` returns the latest kit (default id `project`) or a given version; `null` means none. Create or revise one with `design_kit_save` (`expectedVersion: 0` for new, else the latest) from the app's `DESIGN.md` when it has one, its existing style and confirmed choices. Never invent a new identity for an existing app without the user's direction.

A kit has `title`, `colors` (one color or one per mode, as tokens), `textStyles` (`fontSize`, optional `fontFamily`, `fontWeight`, `lineHeight`, `letterSpacing`), `spacing`, `radii` (all four required, may be empty), optional `tracking` (letter-spacing px) and `opacity` (0 to 1) tokens, optional `components` (layer arrays with one main frame whose id is the map key) and `references` (`{title, source}`). Pass the snapshot, with `id` and `version`, as `document.kit`. Use `$color` (or `$color/0.5`), `textStyle: "body"` on text and `bindings: {padding: "md", gap: "sm", radius: "card"}` on frames (`radius` from `radii`; `padding`, `gap`, `minWidth`, `minHeight` from `spacing`; `letterSpacing` from `tracking`; `opacity` from `opacity`). A numeric edit drops that binding; a typography edit drops `textStyle`; `unset` removes them explicitly.

Kit revisions don't change existing screens. To adopt one, `design_apply` `{op: "document", patch: {kit: <snapshot>}}` and review. Copied component trees are not replaced silently.

**Consistency.** Layout and content may vary; colors, full typography, padding/gap and radii must come from the kit (zero and transparent are allowed). Documents are advisory by default; `consistency: {mode: "strict"}` makes saves and `design_validate` reject drift and needs a kit with at least one color, text style, spacing and radius. Never switch strict off, change the kit or add exceptions to evade an error. For a variation the user asked for, add `consistency.exceptions` `{nodeId, field, value, reason}`, copying `id`, `field` and `actual` from the diagnostic and stating the user's intent in `reason`.

**Text edits.** Pass `intent` to `design_validate` and `design_apply` when changing existing copy:

- `{mode: "text-only", textIds: [...]}`: only those texts change; any layout shift rejects the batch. Report remaining clipping.
- `{mode: "fit-text", textIds: [...], layoutIds: [...]}`: geometry may also change inside the named layout subtrees (smallest scope). The result must clear clipping in scope and add no defects elsewhere.

Edit a main component's text to change its copies; instance `componentValues` are outside intents. Diagnostics carry `measurements`, `blockerId`, `suggestions` and candidate `operations` (`requiresValidation: true`): preflight them, apply, then inspect.

## Inspect and preflight

`design_inspect` `{id, version?, nodeId?}` returns the image, layer bounds and warnings without saving; `nodeId` crops to a layer. Contrast marked `unsupported` has not passed; with remote images or unbundled fonts, don't claim full visual verification. `design_validate` checks `{document}` or `{id, expectedVersion, operations}` (or `html` with size) without saving or reserving a version.

## Components

`component: true` makes a frame a main component. An instance is a frame with `componentId` set to it, its own id, position and size fallbacks; Milagre generates its children (with `componentSourceId`, edit that source in the main). No nesting. Expose properties on the main with `componentProperties`, such as `{"label":{"nodeId":"button-label","field":"text"},"disabled":{"nodeId":"button","field":"opacity","options":[1,0.5]}}` (fields `text`, `icon`, `hidden`, `fill`, `opacity`); instances set the full `componentValues` map (`{}` resets). Instances may change properties, position, parent, name, visibility and lock only. Detach instances before deleting their main.

## Editing

`design_apply` `{id, expectedVersion, operations}` saves one version per batch; a rejected batch changes nothing. Send only what changes, and keep ids stable so comments keep pointing at their layers. To replace the whole screen, `design_show` with the same id and latest `expectedVersion`.

- `{op: "update", id: "heading", patch: {text: "Your next idea starts here.", fontSize: 30}}`
- `{op: "insert", node: {...}, index?}` and `{op: "delete", id}` (removes descendants too).
- `{op: "document", patch: {tokens: {accent: "#2563eb"}, background: "$accent"}}`: tokens merge; width, height and kit also change here.
- `{op: "duplicate", id: "card", newId: "second-card", x: 20, y: 300}` copies with new ids, keeping component links.
- `{op: "detach", id}` makes an instance independent; `{op: "unset", id, fields: [...]}` clears `parentId`, `textStyle`, `bindings` or `componentValues`.

`design_export` gives lossless JSON, SVG (image URLs and font names as references) or HTML. The desktop menu also exports PNG.

## Interactive designs

`design_show` with `html`, `width` and `height` (390 by 844 phone, 1280 by 800 desktop). It runs sandboxed: no `fetch`, server forms, `localStorage` or cookies. Keep state in memory with realistic sample data. Start React designs with these exact tags, then write the app in `<script type="text/babel">` rendering into `#root`:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
<style>html,body{margin:0;height:100%}body{font-family:Inter,system-ui,sans-serif}</style>
```

- **Libraries.** Only unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com or esm.sh, at an exact version (`react@18.3.1`, not `latest`). Tailwind: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.17`.
- **Icons.** Lucide from `https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js` (integrity `sha384-ieG+IKD0d/ZPXyCBTMVAbqsQdns8QGJR/e26WMw7M4fkaI/rHcS/YIoi+ah9WGge`, crossorigin `anonymous`); `lucide.createElement(lucide.ChevronLeft)` returns an SVG to append (in React, to a span ref in `useEffect`). Never glyphs, emoji or hand-drawn SVG.
- **Screens.** One design per flow, screens switched with state, each root marked `data-screen-label`. A second design is a variant, not the next screen.
- **Fit.** Exactly `width` by `height`, no sideways scroll, long content scrolling inside. Phones draw the 54 px status bar and home indicator.
- **Feel real.** Every visible control works plausibly; buttons have hover and pressed states, 150 to 250 ms transitions; flex or grid with `gap`. The craft rules above apply; Google Fonts `<link>`s work.
- **Edit** with `design_apply` `{id, expectedVersion, edits: [{find, replace, all?}]}`: exact text from `design_read`, unique, applied in order. For larger changes resend the whole `html`. A blank first screen means the scripts failed. Comments carry `x`/`y` as fractions of the screen the user saw.
