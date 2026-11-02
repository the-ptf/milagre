---
name: design
description: Create editable screen designs in a Milagre Chat with named layers, layout and color tokens. Offer variants, edit with the user, act on their comments and build the chosen design.
---

# Designing in a Chat

Use this tool for UI screens, mockups and visual designs. For a page explaining a topic, a report or an interactive explainer, use `artifact_show` and the artifacts skill. Each Chat has one live HTML artifact page, separate from its editable designs.

If the user named another design tool (Pencil, Figma, Paper or any other MCP or app), use that tool. Their choice wins over Milagre designs.

1. **Ground it.** Read `design_kit_read` first when available: all Chats in this Project share that kit. Reuse its pinned snapshot in `document.kit`. On takeover or after user edits, call `design_inspect` to see the current saved screen without making a version. In a project with an app, read its screens, colors, type and components first, and design in that style. Ask one question only if the platform or screen is unclear.
2. **Show it.** Call `design_show` with a title and one document per screen. Set its width and height (390 by 844 for a phone). Give layers stable, meaningful ids and names. Use real content: the dates, names, badges and chips a real screen would show, not a simplified placeholder. When the Chat covers more than one part of the app (onboarding, settings, a workout screen), give each design a `group` naming its part, the same name for every screen and variant of it; the canvas lays out one block per group.
3. **Look before you reply.** `design_show` and `design_apply` return the saved design as an image, plus warnings for clipped text, layers outside their parent or the screen, and low contrast. Look at the image. Fix every warning unless the overflow is deliberate (an edge bleed or a scroll peek), and fix anything that looks off (alignment, uneven spacing, icons, crowding), with `design_apply`. Do at most two fix rounds, then reply. Remote `https:` images show as placeholders in your image only; the user sees them. If no image comes back, the design is still saved; work from the warnings and don't call the tool again just to get one. If your image shows a family that is not bundled (see Fonts) in Inter, that is expected; don't change the font for it. Characters your image can't draw (a note names their layers) are blank there only; keep them.
4. **Offer variants when the direction is open.** Show two or three designs, each with its own id and a title that names the idea ("Alt B, dark timeline"), in the group of the screen they are variants of. When the user was specific, show one.
5. **Act on feedback.** Read the latest document with `design_read`, then call `design_apply` with that version as `expectedVersion` and one batch of operations. The user can edit layers on desktop. On phone they review and choose designs, and request changes through Chat. If a version conflict occurs, read again and adapt your changes to the latest document. After addressing a comment, call `artifact_resolve_comment` with its id and a one-line note. Resolve only what you addressed.
6. **Build when asked.** Read the chosen design with `design_read` and implement it in the project's own code and components. A choice means continue from that design only. `design_export` returns JSON or SVG when the user needs a file.

## Craft

- **Icons.** Use an `icon` layer for every icon, with a Lucide name from lucide.dev/icons. Never use a Unicode glyph or an image of an icon. `fill` is its color and `strokeWidth` its line weight (2 by default; 1.5 reads closer to SF Symbols). Common names: `chevron-left`, `chevron-right`, `x`, `check`, `chevrons-up-down`, `sliders-horizontal`, `search`, `plus`, `ellipsis`, `signal`, `wifi`, `battery-full`.
- **Type.** Inter is the default and is measured. Keep one scale per screen; for iOS: 34 large title, 22 title, 17 body and row labels, 15 secondary, 13 captions and section headers. The large title uses weight 700, other titles 600, body 400. Set secondary text apart with a lighter color as well as the smaller step, not with size alone.
- **Spacing.** Work on a 4 px grid. Use 16 to 20 px screen margins on a phone, 44 px minimum touch targets, 12 to 16 px inside grouped rows, and the same gap between siblings of the same kind.
- **Phone chrome.** Use a 54 px status bar with the time at 17/600 on the left and `signal`, `wifi` and `battery-full` icons at 17 px on the right. Navigation buttons are 44 px circles with a 20 px icon centred inside.
- **Density.** Match the app you are designing for. A list row in a booking app shows its date, title, time and status; don't drop columns to make the layout easier.

## Document format

A document has `schemaVersion: 1`, `width`, `height`, an optional `background`, optional color `tokens`, and a flat `nodes` array. Every node has a unique `id`, `type`, `width` and `height`. Use `parentId` to put a layer inside a frame. Coordinates are relative to its parent; top-level coordinates are relative to the screen.

```json
{
  "schemaVersion": 1,
  "width": 390,
  "height": 844,
  "background": "#f6f4ef",
  "tokens": { "ink": "#16261f", "accent": "#27634b" },
  "nodes": [
    {
      "id": "content",
      "name": "Welcome content",
      "type": "frame",
      "x": 24,
      "y": 72,
      "width": 342,
      "height": 272,
      "layout": "vertical",
      "gap": 20
    },
    {
      "id": "heading",
      "parentId": "content",
      "name": "Page title",
      "type": "text",
      "width": 342,
      "height": 80,
      "text": "Make room for your next idea.",
      "fontSize": 32,
      "fontWeight": 700,
      "fill": "$ink"
    },
    {
      "id": "start-button",
      "parentId": "content",
      "name": "Start button",
      "type": "frame",
      "width": 342,
      "height": 52,
      "fill": "$accent",
      "radius": 12,
      "layout": "horizontal",
      "align": "center",
      "justify": "center"
    },
    {
      "id": "start-label",
      "parentId": "start-button",
      "name": "Start label",
      "type": "text",
      "width": 240,
      "height": 24,
      "text": "Start a project",
      "fontSize": 16,
      "fontWeight": 600,
      "textAlign": "center",
      "fill": "#ffffff"
    }
  ]
}
```

Available layer properties:

- **All layers:** `id`, `name`, `type`, `parentId`, `x`, `y`, `width`, `height`, `widthMode`, `heightMode`, `minWidth`, `minHeight`, `fill`, `stroke`, `strokeWidth`, `radius`, `opacity`, `hidden`, `locked`.
- **Text:** `text`, `fontSize`, `fontFamily`, `fontWeight`, `lineHeight`, `textAlign` (`left`, `center` or `right`). `fill` is the text color. `lineHeight` is a unitless multiplier, such as `1.35`, never pixels.
- **Frames:** `layout` (`free`, `horizontal` or `vertical`), `gap`, `padding`, `align` (`start`, `center` or `end`), `justify` (`start`, `center`, `end` or `space-between`). Horizontal and vertical layouts position their children automatically.
- **Shapes:** use `rectangle` or `ellipse` as the type.
- **Images:** use `image` as the type and `src` for its image URL. Colors can reference tokens with `$name`.
- **Icons:** use `icon` as the type and `icon` for its Lucide name. `fill` is the line color and `strokeWidth` the line weight. Icons can't have a stroke, radius, text, src or children, and an unknown name fails with the closest matches.

## Content sizing

`widthMode` and `heightMode` each accept `fixed` (the default), `hug` or `fill`. Keep numeric `width` and `height`: fixed uses those pixel sizes, while dynamic modes use them as fallbacks. `hug` fits text or a frame's children. `fill` uses available parent space; siblings with fill sizing share the remaining row or column space. Use `minWidth` and `minHeight` for explicit minima. A fill child inside a hug parent uses its fallback on that axis to avoid a circular size dependency.

For a vertical card, use `heightMode: "hug"` on the frame and `widthMode: "fill", heightMode: "hug"` on its text. Changing the copy then moves the content below it. Text, selection bounds and SVG export share the same line breaks. Text is set in Inter by default, embedded in every preview and measured at weights 400, 500, 600 and 700, including its Latin punctuation (curly quotes, dashes, the middle dot, accented letters). Arial, Georgia, Times New Roman and Courier New are also measured; other fonts and non-Latin scripts use approximate metrics and render only where the viewer has them installed. Your preview image draws every family that is not bundled, including those four, in Inter.

## Fonts

Besides Inter, these families are bundled: measured, embedded in every preview, export and your image. Name one first in `fontFamily`, followed by a fallback of the same kind (`Bebas Neue, Arial, sans-serif`); a bundled family counts only as the first in the list. Each is drawn at 400 and a few other weights; other weights render with the nearest drawn one.

Albert Sans, Anton, Archivo, Barlow, Barlow Condensed, Bebas Neue, Besley, Big Shoulders, Bodoni Moda, Bricolage Grotesque, Chivo, EB Garamond, Epilogue, Figtree, Hanken Grotesk, Imbue, Jost, League Spartan, Libre Franklin, Literata, Newsreader, Onest, Public Sans, Red Hat Display, Red Hat Text, Rokkitt, Schibsted Grotesk, Source Serif 4, Stack Sans Headline, Stack Sans Text, STIX Two Text, TikTok Sans, Unbounded, Work Sans, Young Serif, Zilla Slab.

## Project visual kit

`design_kit_read` returns the Project's latest kit (default id `project`), or a specific version. `null` means no kit exists. Establish one from the app's existing style and confirmed choices with `design_kit_save`: send `expectedVersion: 0` for a new kit or the latest version for a revision. Never invent a new identity for an existing app without the user's direction.

### Consistency rules

Composition may vary: positions, dimensions, content and hierarchy are not kit rules. Colors (including defaults and instance property overrides), complete typography, padding/gap and corner radii must use kit values. Zero spacing/radius and transparent paint are allowed. Minimum dimensions are layout constraints unless bound to a kit token. Existing component links and typed property options must remain intact unless the user requests a detach/change.

Documents default to advisory consistency. Opt in with `consistency: {mode: "strict"}` (also through a `document` patch). Omitting `consistency` in a full replacement preserves the existing policy; changing it requires an explicit mode. Strict saves and `design_validate` reject kit drift, including in the desktop editor. Reads and draft previews remain possible. A strict document needs a pinned kit with at least one color, text style, spacing and radius. Never switch off strict mode, change the kit or add exceptions to evade an error.

When the user deliberately requests a variation, record `consistency.exceptions`: `{nodeId, field, value, reason}`. Copy `id`, `field` and `actual` from the diagnostic into `nodeId`, `field` and `value`; explain the user's intent in `reason`. The exception applies only to that layer/field and exact effective value. It stays visible as `kit-exception`; changing a token's resolved color invalidates the old exception. Typography values contain the normalized full font family, size, weight and line height. An exception documents intent, not independent proof of user approval. Hidden source layers are skipped, but their visible component instances are checked. Public pages omit consistency metadata and private reasons.

### Content changes

For "change only the text", preserve every other field. Inspect the resulting image and explicitly report any clipping or overflow; do not claim the layout is fixed. For a request to accommodate the text, use Hug and auto layout or adjust only the needed geometry; preserve content, kit, component links and user edits. Preflight, save and inspect again. Prefer Hug text in new screens so longer copy can flow. Strict kit consistency does not block content overflow: layout diagnostics are a separate criterion.

The kit has `title`, `colors`, `textStyles`, `spacing`, `radii`, optional `components` and `references`. All four maps are required, but can be empty. A text style has `fontSize` and optional `fontFamily`, `fontWeight`, `lineHeight`. Component templates are arrays of ordinary layers, with one root main component whose id matches the map key. References are `{title, source}` records for approved examples or source files.

Pass the returned snapshot, including `id` and `version`, as `document.kit`. Colors are available as `$name`. Use `textStyle: "body"` on text, or `bindings: {padding: "md", gap: "sm", radius: "card"}` on a frame. Radius names come from `radii`; the other supported bindings (`padding`, `gap`, `minWidth`, `minHeight`) come from `spacing`. Bound values follow the kit and override their numeric fallbacks. An explicit numeric property edit removes the corresponding spacing/radius binding; editing a typography property removes `textStyle`, preserving its other resolved values. A binding supplied in the same patch remains authoritative. You can also remove bindings explicitly with `unset`. Text-only edits keep their text style.

Kit revisions do not change existing screens. To adopt a revision, read it, then send `{op: "document", patch: {kit: <returned snapshot>}}` in `design_apply`. This adopts its colors and updates bound fields. Review the result before continuing. Component templates are copied into the screen when used; changing a kit does not silently replace those component trees. Preserve source layer ids when explicitly updating a copied component.

## Inspect and preflight

`design_inspect` takes `{id, version?, nodeId?}`. It returns an image, calculated layer bounds, warning coverage and rendering limitations without saving. `nodeId` crops to a visible layer. Contrast marked `unsupported` has not passed: images, partial backdrops and translucency may prevent evaluation. Remote pictures and unbundled fonts can differ from the user's view; do not claim a complete visual verification in that case.

`design_validate` checks either `{document}` or `{id, expectedVersion, operations}` without saving. It returns `valid`, errors with field paths, or the resulting document and diagnostics. It does not reserve a version; the subsequent write still needs `expectedVersion` and can conflict.

## Reusable components

Mark a frame with `component: true` to make it a main component. Insert another frame with `componentId` set to that main frame's id, plus its own stable id, position and numeric size fallbacks. Milagre expands the instance's children and keeps their ids stable as the main changes. Change the main to update every linked instance. Nested components are not supported.

Expose content or state properties on a main frame with `componentProperties`, for example `{"label":{"nodeId":"button-label","field":"text"},"disabled":{"nodeId":"button","field":"opacity","options":[1,0.5]}}`. Supported fields are `text`, `icon`, `hidden`, `fill` and `opacity`. The target must be in that main component. An instance sets `componentValues: {label: "Cancel", disabled: 0.5}`. Omitted properties keep the source value; `options` limits allowed states. Update `componentValues` as a complete map; send an empty map to reset overrides.

An instance can change its properties, position, parent, name, visibility and lock state. Its other size, appearance and descendant fields follow the main. In `design_read`, generated children carry `componentSourceId`; edit that source layer in the main. To make an independent copy, send the whole document again with `design_show` (same id, latest `expectedVersion`), with `componentId` removed from the instance root and `componentSourceId` removed from its descendants. Keep their ids. Detach instances before deleting their main component.

## Editing

`design_apply` takes `{ id, expectedVersion, operations }`. A successful batch creates one saved version; a rejected batch changes nothing. Earlier versions stay available. Send only the changes needed, so small revisions avoid generating a full screen again.

```json
{
  "id": "welcome",
  "expectedVersion": 1,
  "operations": [
    { "op": "update", "id": "heading", "patch": { "text": "Your next idea starts here.", "fontSize": 30 } },
    { "op": "update", "id": "start-button", "patch": { "radius": 16 } }
  ]
}
```

Use `insert` with a `node` (the same fields as a `design_show` node) and optional `index` to add a layer, and `delete` with an `id` to remove a layer and its descendants. To replace the whole screen, call `design_show` with the design's id and the latest `expectedVersion`. Keep ids stable across edits so the user can keep working with the same layers.

More atomic operations:

- `{op: "document", patch: {tokens: {accent: "#2563eb"}, background: "$accent"}}` updates document fields without resending layers; token patches merge. Width, height and kit can also change here.
- `{op: "duplicate", id: "card", newId: "second-card", x: 20, y: 300}` copies the subtree with new ids and preserves component links.
- `{op: "detach", id: "button-instance"}` makes an independent copy with the current property values.
- `{op: "unset", id: "heading", fields: ["textStyle"]}` removes optional bindings. Supported fields: `parentId`, `textStyle`, `bindings`, `componentValues`.

## Export

`design_export` returns lossless JSON or SVG with native shapes, editable text and images. SVG keeps external image URLs and font names as references. The desktop editor also downloads PNG; remote images must allow cross-origin access or be embedded data URLs. A failed image export shows an error and produces no partial download.

## Availability

HTML Artifacts are the Chat's single explanatory page, through `artifact_read` and `artifact_show`; use the artifacts skill for that, not for UI screens.

Keep replies short: say what differs between variants or what changed. The card shows the design.
