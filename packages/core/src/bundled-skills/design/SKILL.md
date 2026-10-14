---
name: design
description: Create editable screen designs in a Milagre Chat with named layers, layout and color tokens. Offer variants, edit with the user, act on their comments and build the chosen design.
---

# Designing in a Chat

Use this tool for UI screens, mockups and visual designs. For a page explaining a topic, a report or an interactive explainer, use `artifact_show` and the artifacts skill. Each Chat has one live HTML artifact page, separate from its editable designs.

If the user named another design tool (Pencil, Figma, Paper or any other MCP or app), use that tool. Their choice wins over Milagre designs.

1. **Ground it.** In a project with an app, read its screens, colors, type and components first, and design in that style. Ask one question only if the platform or screen is unclear.
2. **Show it.** Call `design_show` with a title and one document per screen. Set its width and height (390 by 844 for a phone). Give layers stable, meaningful ids and names. Use real content: the dates, names, badges and chips a real screen would show, not a simplified placeholder. When the Chat covers more than one part of the app (onboarding, settings, a workout screen), give each design a `group` naming its part, the same name for every screen and variant of it; the canvas lays out one block per group.
3. **Look before you reply.** `design_show` and `design_apply` return the saved design as an image, plus warnings for clipped text, layers outside their parent or the screen, and low contrast. Look at the image. Fix every warning unless the overflow is deliberate (an edge bleed or a scroll peek), and fix anything that looks off (alignment, uneven spacing, icons, crowding), with `design_apply`. Do at most two fix rounds, then reply. Remote `https:` images show as placeholders in your image only; the user sees them. If no image comes back, the design is still saved; work from the warnings and don't call the tool again just to get one. If your image shows a font in Inter that the document names differently, that is expected; don't change the font for it. Characters your image can't draw (a note names their layers) are blank there only; keep them.
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

For a vertical card, use `heightMode: "hug"` on the frame and `widthMode: "fill", heightMode: "hug"` on its text. Changing the copy then moves the content below it. Text, selection bounds and SVG export share the same line breaks. Text is set in Inter by default, embedded in every preview and measured at weights 400, 500, 600 and 700, including its Latin punctuation (curly quotes, dashes, the middle dot, accented letters). Inter is recognised only as the first family in a list. Arial, Georgia, Times New Roman and Courier New are also measured; other fonts and non-Latin scripts use approximate metrics and render only where the viewer has them installed. Your preview image draws every family other than Inter, including those four, in Inter.

## Reusable components

Mark a frame with `component: true` to make it a main component. Insert another frame with `componentId` set to that main frame's id, plus its own stable id, position and numeric size fallbacks. Milagre expands the instance's children and keeps their ids stable as the main changes. Change the main to update every linked instance. Nested components are not supported.

An instance can change its position, parent, name, visibility and lock state. Its size, appearance and descendants follow the main. In `design_read`, generated children carry `componentSourceId`; edit that source layer in the main. To make an independent copy, replace the document with `componentId` removed from the instance root and `componentSourceId` removed from its descendants. Keep their ids. Detach instances before deleting their main component.

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

Use `insert` with a `node` and optional `index` to add a layer, `delete` with an `id` to remove a layer and its descendants, or `replace` with a `document` to replace the whole screen. Reusing an id with `design_show` also requires the latest `expectedVersion`. Keep ids stable across edits so the user can keep working with the same layers.

## Export

`design_export` returns lossless JSON or SVG with native shapes, editable text and images. SVG keeps external image URLs and font names as references. The desktop editor also downloads PNG; remote images must allow cross-origin access or be embedded data URLs. A failed image export shows an error and produces no partial download.

## Availability

Designs is enabled by default under Settings > Experimental. Turning it off removes the Designs interface and tools on this host. If a cached call reports that Designs is off, stop design work and continue other requested work; there is no HTML fallback. HTML Artifacts remain available as the Chat's single explanatory page through `artifact_read` and `artifact_show`. Use the artifacts skill for that purpose; do not use it to bypass a disabled Designs setting.

Keep replies short: say what differs between variants or what changed. The card shows the design.
