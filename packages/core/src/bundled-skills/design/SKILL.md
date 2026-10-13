---
name: design
description: Create editable screen designs in a Milagre Chat with named layers, layout and color tokens. Offer variants, edit with the user, act on their comments and build the chosen design.
---

# Designing in a Chat

Use this tool for UI screens, mockups and visual designs. For a page explaining a topic, a report or an interactive explainer, use `artifact_show` and the artifacts skill. Each Chat has one live HTML artifact page, separate from its editable designs.

If the user named another design tool (Pencil, Figma, Paper or any other MCP or app), use that tool. Their choice wins over Milagre designs.

1. **Ground it.** In a project with an app, read its screens, colors, type and components first, and design in that style. Ask one question only if the platform or screen is unclear.
2. **Show it.** Call `design_show` with a title and one document per screen. Set its width and height (390 by 844 for a phone). Give layers stable, meaningful ids and names. Use real content.
3. **Offer variants when the direction is open.** Show two or three designs, each with its own id and a title that names the idea ("Alt B, dark timeline"). When the user was specific, show one.
4. **Act on feedback.** Read the latest document with `design_read`, then call `design_apply` with that version as `expectedVersion` and one batch of operations. The user can edit layers on desktop. On phone they review and choose designs, and request changes through Chat. If a version conflict occurs, read again and adapt your changes to the latest document. After addressing a comment, call `artifact_resolve_comment` with its id and a one-line note. Resolve only what you addressed.
5. **Build when asked.** Read the chosen design with `design_read` and implement it in the project's own code and components. A choice means continue from that design only. `design_export` returns JSON or SVG when the user needs a file.

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

## Content sizing

`widthMode` and `heightMode` each accept `fixed` (the default), `hug` or `fill`. Keep numeric `width` and `height`: fixed uses those pixel sizes, while dynamic modes use them as fallbacks. `hug` fits text or a frame's children. `fill` uses available parent space; siblings with fill sizing share the remaining row or column space. Use `minWidth` and `minHeight` for explicit minima. A fill child inside a hug parent uses its fallback on that axis to avoid a circular size dependency.

For a vertical card, use `heightMode: "hug"` on the frame and `widthMode: "fill", heightMode: "hug"` on its text. Changing the copy then moves the content below it. Text, selection bounds and SVG export share the same line breaks. Text is set in Inter by default, embedded in every preview and measured at weights 400, 500, 600 and 700. Arial, Georgia, Times New Roman and Courier New are also measured; other fonts and non-Latin scripts use approximate metrics and render only where the viewer has them installed.

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
