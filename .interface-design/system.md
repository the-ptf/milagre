# Milagre interface system

The scales and rules every UI change on desktop (`apps/desktop/app/src`) and phone (`apps/mobile/src`) follows. Values not
listed here are drift. Where code disagrees, this file wins and the code moves toward it, surface by surface. The review
behind it: the "Milagre design review" artifact (2026-10-28) and its round 2 (2026-10-29, decisions at the end).

## Direction

A calm, dense workbench for people running coding agents all day. Neutral structure; colour only where it means
something (one accent for focus and links, green/orange/red for state, purple for Ultracode and merged PRs, provider
and file-kind colours for identity: an image is `IMAGE_COLOR` violet everywhere). Hierarchy comes from weight and ink level before size. Desktop reads like a macOS tool, the phone like iOS.

## Type

Two weights: 500 (medium) and 600 (semibold). 700 only for the phone's 34pt large title. No half-pixel sizes.

| Desktop | Role                     | Phone   | Role                        |
| ------- | ------------------------ | ------- | --------------------------- |
| 26      | Display (Onboarding)     | 34      | Large title                 |
| 22      | Page title, `-0.02em`    | 22      | Title 2                     |
| 17      | Dialog title             | 20      | Title 3 (PR title)          |
| 15      | Section and card title   | 17      | Body, headline, sheet title |
| 13      | Body UI, rows, buttons   | 16      | Two-line row title          |
| 12      | Secondary, small buttons | 15      | Subheadline, chat titles    |
| 11      | Caption, meta, time      | 13      | Footnote, secondary         |
| 10      | Badges only              | 12 / 11 | Caption 1 / 2               |

- Chat text is user-scaled (`--chat-size`, phone `textPx`); markdown headings are `em`-relative to it.
- A group heading above a card is `SectionLabel`: 12 medium ink-3 (11 in menus), phone 13 footnote ink3, 16pt in from
  the card edge. 15 semibold is only for a title inside a card. Routines' groups use `SectionLabel` too.
- Sentence case everywhere; no tracked uppercase labels. Product nouns stay capitalised: Project, Chat, Routine, Run,
  Link, Heartbeat, Worktree ("Rename Chat", "New Worktree"). Shared words live in `UI_COPY` (`@milagre/shared/model-copy`).
- Button labels: desktop 500, phone 600 (platform style, not drift).
- Letter-spacing 0 everywhere (the desktop `body` included), except `-0.02em` on 22px titles.

## Tokens and enforcement

- Desktop sizes are Tailwind utilities `text-10` … `text-26` (each with its line height), radii `rounded-inline`,
  `rounded-chip`, `rounded-control`, `rounded-card`, `rounded-window`, `rounded-full`, easing `ease-enter` and
  `ease-slide`, durations `duration-fast` / `duration-base` / `duration-slow`, press `active:scale-press`
  (`apps/desktop/app/src/styles.css`; in CSS `var(--duration-fast)`, `var(--press-scale)`).
- Desktop colour tokens beyond the ink levels: `on-ink`, `on-accent`, `on-green`, `on-orange`, `on-red` (labels on the
  accent or -ink fills), `scrim` (behind a modal), `media` / `on-media` / `on-media-2` / `on-media-tint` (lightbox),
  `paper` (a page that stays white), `purple` / `purple-ink` / `purple-tint` (`ULTRACODE_PURPLE`, which themes don't
  override), `shadow-pin`. Never a Tailwind palette colour (`purple-500`, `black/40`) or a hex in a component.
- A bare `transition` runs at `duration-fast` on `ease-enter` (the `@theme` default). JS motion: `EASE_OUT`,
  `EASE_SLIDE`, `DURATION` (`lib/ease.ts`).
- Phone sizes, radii and motion come from `apps/mobile/src/design-tokens.ts` (`type.footnote`, `radius.card`,
  `duration.base`, `Easing.bezier(...easing.enter)`, `chrome.header`), colours from `theme.ts` (`inkFor(colors, tone)`
  for a status tone as text).
- `design-tokens.test.ts` on both platforms counts off-scale font sizes and radii per file against
  `design-tokens.baseline.json`. A file may only go down; after moving one onto the scale, lower the baseline with
  `UPDATE_DESIGN_TOKENS=1` (the command is in each test's header).

## Ink levels

| Token                                              | Use                                                                                 | Floor                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `ink`                                              | Primary text                                                                        |                                        |
| `ink-2` / `ink2`                                   | Secondary text: values, descriptions, chip labels                                   | 4.5:1 on page, surface, field, hover-2 |
| `ink-3` / `ink3`                                   | Tertiary text, section labels, group footers; control glyphs at rest (phone `ink2`) | 4.5:1 on page, surface, field, hover-2 |
| `ink-4` / `ink4`                                   | Decorative icons, dots, disabled. Never text                                        |                                        |
| `green-ink`, `orange-ink`, `red-ink`, `accent-ink` | Status colours as text                                                              | 4.5:1 on page, surface and their tint  |
| `green`, `orange`, `red`                           | Fills, dots, icons, borders                                                         |                                        |

`ink-2` is `mix(ink, page, 0.25)`, a clear step above `ink-3`. The shared theme builder
(`packages/shared/src/themes/build.ts`) solves the floors per theme, and `themes/index.test.ts` checks every theme.
Don't stack opacity on a text colour.

## Radius

Desktop: **4** inline (code, kbd, menu items) · **6** chip, tooltip · **8** control (buttons, inputs, menus) ·
**10** card, popover · **14** dialog, composer, panel · **20** the new-Chat tray (14 + its 6 padding) · **full** pills,
person avatars. (Card and window were drawn at 10 / 14 across the app; the scale follows the code.)

Phone: **6** chip · **10** row, control · **14** card · **20** sheet, hero card, iPad side panel · **24** composer
(`radius.composer`; its tray is composer + 4) · **full** pills, person avatars. Every phone radius sets
`borderCurve: "continuous"`.

Project tiles are rounded squares on both, `projectAvatarRadius(size)`: 16 → 4, 20 and 24 → 6, 32 and 40 → 10, 72 →
20; without an image, an ink fill with an on-ink initial at 600 (`@milagre/shared/project-list`).

Nested: inner radius = outer radius − padding.

## Sizes

- Desktop controls: 24 icon/xs, 28 small (composer chips, tabs), 32 default (buttons, selects, rows), 36 inputs.
  Two-line list rows 48. Fixed heights, never padding-derived.
- Phone: 44pt minimum target (`hitSlop` when the visual is smaller), 52 one-line and 56 two-line rows; `PillButton` 32, 44, 52, set
  with `minHeight` so Dynamic Type can grow it.
- Desktop hit area floor is 24px; extend a smaller visual with `before:absolute before:-inset-*`, never overlapping a
  neighbour's target.

## Spacing

4px grid; 2 and 6 allowed inside dense rows. No 3, 5, 7 or 14. 10 only as the horizontal inset of 28px controls and
bordered fields (1px border + 10 = 11 to the text, lining up with an unbordered 32 button's 12). Phone screen gutter 16
on every screen, header and body alike; section gap 24; overlays under the chat header at `chrome.header` + 8.

## Depth

- Elevated surfaces use a shadow token (`shadow-card`, `shadow-raised`, `shadow-overlay`) and no border: each token
  already paints its 1px ring. Borders are for inputs and flat panels.
- Menus and pickers: `shadow-raised`. Dialogs, command palette: `shadow-overlay`. Inline transcript cards: flat or
  `shadow-card`.
- Phone shadows come from elevation tokens with dark variants, not hard-coded black. Phone grouped cards are flat
  panels with a hairline.
- A numbered pin over content: 20px, `shadow-pin` (a surface ring), its number 10 semibold.

## States

- Focus: one accent ring from `@layer base` in `styles.css`; components may restyle it with `focus-visible:` utilities
  but never recolour it (no ink, ink-3, green or tone outlines). Fields show focus with `focus:border-accent` (plus a
  ring where the field has no border). Menu and picker rows, inside a clipped panel, keep their fill and add the
  accent ring inset (`focus-visible:-outline-offset-2`), never a fill alone. Never a focus style under 3:1.
- Press: `active:scale-press` (0.97) on filled buttons (primary, danger), pills and icon buttons; `active:bg-hover-2`
  on rows. Phone: opacity 0.6, plus scale 0.97 on filled buttons.
- Disabled: 40% on controls, 60% on list rows (an offline Project too).
- Hover: `hover` and `hover-2` are translucent ink (4% / 8% light, 5% / 9% dark), so they show on page, card and field
  alike. Hover is `bg-hover` everywhere, the sidebar included; `bg-hover-2` is the open or selected row, a pressed
  toggle and the menu highlight, so a hovered row never looks like the open one. (`hover-sidebar` is a deprecated alias
  of `hover`.)
- Menus and pickers: one moving highlight, `bg-hover-2`, for pointer and keyboard, plus the inset accent ring on
  keyboard focus. A checked row shows only a 14px tick, no fill.
- Selection is ink on both platforms: a tick, a fill or a dot. Accent never marks a selection.
- Toggles: a pressed or open toggle is `bg-hover-2` with an ink glyph (phone: `hover2` fill, ink icon). `accent-tint`
  with `accent-ink` only for an armed mode that changes what a click does (comment mode).
- Switches are ink when on. The off track stays the pale macOS one, plus `contrast-more:bg-ink-4` (3:1) for Increase
  Contrast.
- A number or word on a coloured fill uses the -ink fill and its label: `bg-red-ink text-on-red`, `bg-green-ink
  text-on-green`. Badges like Recommended are neutral: field fill, ink-2 label.
- Toasts are an ink capsule on both: `bg-ink`, `on-ink` 13/18, `rounded-card`, `shadow-raised`, an optional on-ink
  Undo. A message that stays is a `Notice` card.
- Chrome doesn't select: `button`, `[role=button|menuitem|tab|option]`, `label`, `nav` and `header` are
  `user-select: none` (base layer). Transcript, markdown, code, diffs, errors and paths stay selectable.
- Every hover has `transition-colors`; durations `duration-fast` 120 / `duration-base` 180 / `duration-slow` 280ms on
  `ease-enter`, slides on `ease-slide`.
- Cursor: every enabled button, `role="button"`, link and input label shows the pointer (`styles.css`). That is a
  deliberate departure from macOS; keep it.
- Reduced motion keeps a loading cue (a stepped opacity fade), never a frozen spinner.
- Empty, loading and error states go through shared components (EmptyState, SpinnerRing, InlineError), with "…" (U+2026).

## Primary action

One primary style per platform: ink fill, `on-ink` label. Desktop `Button` (`h-8 rounded-control`,
`hover:opacity-90`), phone `PillButton`. Neither green nor accent fills a primary button: accent is for focus and
links. Green stays a state colour everywhere else (an open PR, online, enabled). A destructive confirm is
`Button variant="danger"` (`red-ink` fill, `on-red` label, 4.5:1), phone `PillButton` destructive (`redInk`,
`onRedInk`).

## Icons

Hugeicons. Desktop sizes 12 / 14 / 16 / 18, stroke 1.8 (1.6 at 12, 2 at 18); 16 in window chrome, 14 inside 28px chips.
Phone 12 / 16 / 18 / 20 / 24. One size per row. Control glyphs at rest are ink-3 on desktop, ink2 on phone; ink-4 only
for decorative icons, dots and disabled.

Shared looks (each app maps the palette keys and icon names to its own): `chatMarkPresentation` (`@milagre/shared/chats`),
`PR_TONE` and `pullRequestStatePill` (icon in the fill, label in -ink, number ink-2; `pr-blockers`),
`permissionPresentation` (Full is the only orange mode; `model-copy`), `presenceTone` (green, orange, red, ink-4 offline;
`chat-scopes`), `projectAvatarRadius` / `PROJECT_AVATAR` (`project-list`), `IMAGE_COLOR` (`file-kinds`).

## Decided, not built yet

Victor picked these on 2026-10-28; each lands in its own PR, desktop and phone together:

- Chat text default 14px with 1.6 line height (today 13 / 1.55).
- Desktop approvals inline on their tool row ("Waiting for approval · Decline · Approve · More"); the phone keeps the
  card for 44pt buttons.
- Two-row composer: prompt on top, attach bottom-left, model · effort · send bottom-right, no collapsed state.
  Needs its own design pass first.
- Diagonal stripes at about 4% under the transcript column, and every uppercase label in sentence case.
- Desktop body text 13/18 (today `body` is 14 / 1.5, so unsized text renders at 14): its own commit, after a screenshot
  sweep (decision 7, deferred).

## Desktop primitives

In `apps/desktop/app/src/components/primitives/`. New UI uses them; hand-written copies move onto them.

- `Button` (`primary` = `ink`, `secondary`, `ghost`, `danger`; sizes 24 / 28 / 32) and `buttonClass()` for a link or
  trigger that must look like one. `IconButton` (20 / 24 / 28 / 32, a 20 reaches 24px through `::before`; `label` is
  its name).
- `Dialog` (native `<dialog>` + `showModal`, `rounded-window shadow-overlay`, `backdrop:bg-scrim`, 17 semibold title,
  actions bottom right). `Notice` (`components/Notice.tsx`) for a dismissable card over a view.
- `Input` / `FIELD` / `FIELD_AREA` (36px, `focus:border-accent`), `Checkbox`, `RadioGroup`, `Switch`, `Segmented`,
  `Select`, `PickerPanel` / `PickerRow`.
- `Icon` (12 / 14 / 16 / 18 with strokes 1.6 / 1.8 / 1.8 / 2), `ProjectAvatar` (16 / 20 / 24 / 40), `SectionLabel`
  (12, or 11 in menus), `TranscriptDivider`, `EmptyState`, `InlineError`, `SpinnerRing` (a stepped fade under reduced
  motion), `Tooltip`, `ShortcutKeys`.
- `.no-drag` on a control inside a drag region, not an inline `[-webkit-app-region:no-drag]`.

## Phone primitives

In `apps/mobile/src/primitives/`, each with its desktop counterpart: `PillButton` (Button), `IconButton` /
`CircleButton` / `GlassIconButton` / `HeaderButton` (IconButton), `Field` (Input), `Checkbox`, `CheckRow` (PickerRow,
RadioGroup), `Chip` and `Segmented` (Segmented), `Toggle` / `RowSwitch` (Switch), `ListRow` and `Group` (settings rows
and cards), `SectionLabel`, `TranscriptDivider`, `ErrorNotice` (InlineError), `Sheet` (Dialog), `PullDown` and
`NativeMenuSection` (menus), `Toast`, `pressStyle` (`active:scale-press`), `announce`.

## Missing primitives

Desktop: Popover/MenuRow, Skeleton. Phone: Tag, ThreadCard. Until one exists, copy the closest existing one exactly
rather than inventing values.

## Round 2 decisions (2026-10-29)

1. Hover and hover-2 are translucent ink; `hover-sidebar` goes; sidebar rows hover `bg-hover`, the open row `bg-hover-2`.
2. Selection is ink on both platforms; accent is for focus and links.
3. A pressed or open toggle is `bg-hover-2` with an ink glyph; accent-tint only for an armed mode.
4. Menu highlight is `bg-hover-2` plus the inset ring on keyboard focus; checked rows show a 14px tick, no fill.
5. Group headings are `SectionLabel` (12 medium, phone 13); 15 semibold only inside cards.
6. `ink-2` = `mix(ink, page, 0.25)`; section labels and group footers are ink-3 on both.
7. Desktop body text 13/18: deferred to round 3, its own commit with a screenshot sweep.
8. 10px is the horizontal inset of 28px controls and bordered fields, nowhere else.
9. Press scale on filled buttons, pills and icon buttons only.
10. Toasts are an ink capsule on both platforms.
11. Desktop new-Chat tray 20; phone `radius.composer` 24, tray composer + 4.
12. iPad side panels `radius.sheet` 20.
13. A pasted image uses the file-kind image colour on both.
14. Prompt chip labels are 0.875em on both.
15. The floating inbox follows the theme (no hard-coded palette).
16. Switch off track: pale, plus `contrast-more:bg-ink-4`.
17. Product nouns capitalised; everything else sentence case.
18. The Recommended badge is neutral (field, ink-2).
19. Babysit switches are ink; Switch has no accent tone.
20. Button label weight: desktop 500, phone 600.
21. Control glyphs at rest ink-3 (phone ink2); ink-4 for decorative icons, dots, disabled.
22. Chrome labels are `user-select: none`; content stays selectable.
