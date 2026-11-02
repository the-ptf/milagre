# Actionable design diagnostics and edit intents

The shared design engine now returns measured shortages and candidate repair operations. Agents can attach a per-batch intent to both `design_validate` and `design_apply`. The host validates the resolved result, including component propagation and automatic layout, before saving. Rejected batches create no version.

## Diagnostics

Clipped text reports required and available height, missing pixels, content width and line count. Overflow reports its limiting parent (or `$canvas`) and the excess on each edge. Low contrast reports the measured ratio and threshold. Warnings retain their existing kind/id/message and add `measurements`, `blockerId` and `suggestions`.

Suggestions are candidates, not automatic fixes. Where a concrete operation is available, it is returned with `requiresValidation: true`. For example, switching to Hug can fix text clipping while pushing siblings outside a parent. Free-layout overflow may suggest a clamped position; automatic layout instead explains why x/y offsets do not help. Contrast suggestions prefer a readable resolved palette color and require authorization to change style.

## Intent contract

```json
{
  "id": "screen",
  "expectedVersion": 3,
  "intent": { "mode": "text-only", "textIds": ["heading"] },
  "operations": [{ "op": "update", "id": "heading", "patch": { "text": "A quieter day" } }]
}
```

`text-only` permits text changes only on declared targets and their generated component text copies. Other fields and every computed layer bound stay identical. Long copy may remain clipped and is reported. Automatic Hug resizing or movement of siblings rejects the batch rather than silently expanding the user's request.

To accommodate text, use `fit-text` and explicitly authorize the layout scope:

```json
{
  "id": "screen",
  "expectedVersion": 3,
  "intent": { "mode": "fit-text", "textIds": ["heading"], "layoutIds": ["content"] },
  "operations": [{ "op": "update", "id": "heading", "patch": { "text": "A longer heading", "heightMode": "hug" } }]
}
```

This permits geometry changes on the text targets and within each declared layout subtree. Geometry is x/y, width/height, widthMode/heightMode and minWidth/minHeight. It preserves other content, style fields and bindings, layer ids/order, component links, document dimensions, tokens, kit and consistency policy. The agent proposes operations; this is not an automatic layout solver.

Before saving, `fit-text` rejects clipping/overflow in scope or in ancestors of the text targets, new or changed layout defects elsewhere, and increased overlap between sibling text layers. Existing unrelated defects remain diagnostics. The scope is a declaration of intended work, not an independent authorization mechanism.

## Compatibility and limits

- Intent is optional and belongs to the request, not the saved document. Existing batches keep their behavior. New schemas are shared by desktop IPC, mobile transport and the agent tools.
- Preflight and save use the same guard. A successful preflight does not reserve a version; stale saves still reject.
- Targets must be text layers. Main text edits can propagate to linked copies. Instance `componentValues` edits remain outside these modes; use an ordinary authorized batch rather than changing a main component unintentionally.
- No new preview surface or native changes. Live draft rendering remains optimistic; enforcement happens on preflight/save.
- Measurements follow the existing shared font/layout engine. Unknown fonts can use approximate metrics. These checks do not certify aesthetics, arbitrary cross-container overlaps or full accessibility.
- The existing GPT/Claude eval predates this contract. A new live evaluation is deferred until requested; automated tests cover the guarantees and persistence behavior.

## Verification

- Full unit suite: 6,910 passed, 12 skipped, zero failures. After the final scope-aware feedback change, all 45 artifact/kit integration tests passed again.
- Desktop editor Electron check passed; mobile UI harness passed 478 tests. These are automated checks, not a fresh native-device or live-model evaluation.
- Desktop/mobile typechecks, lint, formatting, dead-code and generated-contract checks passed.
