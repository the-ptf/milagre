# UI rules

Type, ink levels, radius, sizes, spacing, depth and states follow [the interface system](../../.interface-design/system.md). Values outside it are drift.

## Scrolling

Every scrolling list or panel is a `ScrollArea` (`apps/desktop/app/src/components/primitives/ScrollArea.tsx`). It brings vertical scroll that stays inside the container, the shared thin scrollbar and edge fades that show only while there's more to scroll that way. Pass `as="ul"` for lists, and `chainScroll` when it sits inside another scroller (tool output in the transcript, a list inside a scrolling dialog) so the wheel moves on to the outer one at the end.

- Don't add `overflow-y-auto` plus `useScrollFade` by hand, and don't restyle the scrollbar in a component. The one scrollbar look is the `::-webkit-scrollbar` block in `apps/desktop/app/src/styles.css`. Hiding a scrollbar where a custom rail replaces it (the message scroller) is fine.
- Give a scroll area a height limit. Popovers anchored above the composer get one from `useAnchoredPopover` (`height`, 360px by default); put the `ScrollArea` inside the popover's `flex flex-col overflow-hidden` panel so it takes the leftover space.
- The Tasks pill is the exception: it morphs in place into its panel instead of opening a `useAnchoredPopover`, like the update pill (`UpdateNotice`). Both share `components/motion/morph.ts` (`useSize`, `morphFace`, `HIDDEN_FACE`, `MORPH_SURFACE`): one surface sized to the face on show, both faces mounted and crossfading, the hidden one inert. Its height cap is the room above the pill (at most 520px and 70vh), with the tree and phase graph in one `ScrollArea` under a fixed header.

`apps/desktop/app/src/components/primitives/scroll-area-only.test.ts` fails when a component scrolls vertically without `ScrollArea`, wires fades or restyles the scrollbar itself. The only exceptions are `<pre>` code blocks, which scroll both ways, and the message scroller.

## Choices

Switch controls are banned on desktop and mobile. Use the shared Checkbox for independent boolean settings and checked lists or radio groups for mutually exclusive choices. Never add a sliding track/thumb, a native Switch, or a switch accessibility role. Native menu items that render checkmarks are allowed. Dictation languages live behind a labeled picker or submenu, not a long list on the Chat settings page.

Every dropdown goes through `primitives/Select`; a native `<select>` opens macOS's own menu. `no-native-select.test.ts` enforces it.

## Popovers and menus

Every transient surface (picker, menu, anchored popover) closes through `useDismiss` (`apps/desktop/app/src/lib/use-dismiss.ts`): a pointer press anywhere outside it or the window losing focus closes it, unless focus moved into an iframe inside it (the simulator and browser viewers); Escape stays with the component, which also returns focus. Don't add a `pointerdown` or `blur` listener of your own.

- Pass `inside` so the panel and its trigger count as the surface; the trigger's own click still toggles.
- A surface anchored to a trigger passes `follow`, its positioning function, and stays put through scrolls and resizes. A surface anchored to a point (the chat row's context menu) omits it and closes instead.
- While anything is open, `<html>` carries `data-popover-open` and the title bar's `.title-drag` strip stops dragging the window, so a press there closes the surface. Drag strips use that class, not an inline `app-region`.

Modal dialogs are different: they use `<dialog>` with `showModal` or a full-window scrim, and the scrim press closes them.

## Sliders

Every slider is a `RangeSlider` (`apps/desktop/app/src/components/primitives/RangeSlider.tsx`): tick dots per step, a bar handle that bounces as it lands, drag anywhere on the track or use the arrow keys, and no springs under reduced motion. Its value plumbing is `lib/use-slider.ts`; a native `<input type="range">` draws macOS's own control.

## Backdrop blur

Three blur strengths, all theme tokens in `apps/desktop/app/src/styles.css`:

- `backdrop-blur-overlay` (3px) on the scrim behind a dialog, palette or viewer. It softens the app behind without hiding it; pair it with a dark tint for contrast.
- `backdrop-blur-chip` (8px) on a floating control, such as the chat composer or the copy and download buttons on a generated image.
- `backdrop-blur-edge` (4px) where content scrolls under a window edge. Build it as a progressive blur, never one masked blur: a single blur under a fading mask shows a crisp copy through its half-on part. `.progressive-blur` stacks four layers at 0.25x to 2x the token; chat edges override it to 0.5px for a gentler fade. Mobile's `EdgeFade` uses a native variable blur (`ProgressiveBlurView` from `@sbaiahmed1/react-native-blur`).

Don't use Tailwind's own sizes (`backdrop-blur-sm` to `-3xl`) or a hand-written `backdrop-filter: blur(...)`; a stronger blur behind a full-window scrim also costs frames while something animates over it. CSS that needs the value uses the variable, e.g. `blur(var(--blur-overlay))`. `primitives/backdrop-blur.test.ts` enforces it.

## Mobile activity and subagents

Use `apps/mobile/src/activity-item.tsx` for an inline item with expandable activity output. `ToolRow` and `SubagentItem` adapt domain data to `ActivityItem`; keep their icon, title, shimmer, disclosure, status spacing, accessibility and output surface in the shared component. Do not recreate those styles in an adapter.

- Pass the item icon and `state` (`idle`, `running`, `waiting`, `failed`). Running titles use the existing `ShimmerText`, which respects reduced motion and screen focus; waiting and terminal states stop it. Failures use the shared warning icon and color.
- Pass `status` when a label is needed beside the arrow. Use `disclosureOnly` for subagents so the title stays selectable and the status/arrow control expands the details. Tool activity uses the whole row; `onPress` opens its sheet from the Chat.
- Supply the output as children. The component owns its bounded, nested `PageScroll`, background, corners and padding; adapters only format content. `loading` keeps a disclosure available while tool output is fetched.
- Reuse `ActivityTitle` for activity summaries that need the same code chips and running shimmer.

Check both Activity and Subagents when changing this component: collapsed, expanded, running, waiting, failed and late-arriving output.
