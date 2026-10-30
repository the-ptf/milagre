# Milagre interface system

The scales and rules every UI change on desktop (`apps/desktop/app/src`) and phone (`apps/mobile/src`) follows. Values not
listed here are drift. Where code disagrees, this file wins and the code moves toward it, surface by surface. The review
behind it: the "Milagre design review" artifact (2026-10-28).

## Direction

A calm, dense workbench for people running coding agents all day. Neutral structure; colour only where it means
something (one accent for focus, links and selection, green/orange/red for state, purple for Ultracode and merged
PRs, provider colours for identity). Hierarchy comes from weight and ink level before size. Desktop reads like a macOS tool, the phone like iOS.

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
- Section titles are larger and stronger than the rows under them (Settings: 15 semibold over 13 medium rows).
- Sentence case everywhere; no tracked uppercase labels.
- Letter-spacing 0 everywhere (the desktop `body` included), except `-0.02em` on 22px titles.

## Tokens and enforcement

- Desktop sizes are Tailwind utilities `text-10` … `text-26` (each with its line height), radii `rounded-inline`,
  `rounded-chip`, `rounded-control`, `rounded-card`, `rounded-window`, `rounded-full`, easing `ease-enter` and
  `ease-slide`, durations `duration-fast` / `duration-base` / `duration-slow`, press `active:scale-press`
  (`apps/desktop/app/src/styles.css`; in CSS `var(--duration-fast)`, `var(--press-scale)`).
- Desktop colour tokens beyond the ink levels: `on-ink`, `on-accent`, `on-red` (labels on a filled control), `scrim`
  (behind a modal), `hover-sidebar` (the sidebar's row hover), `purple` / `purple-ink` / `purple-tint`. Never a
  Tailwind palette colour (`purple-500`, `black/40`) or a hex in a component.
- Phone sizes and radii come from `apps/mobile/src/design-tokens.ts` (`type.footnote`, `radius.card`, …).
- `design-tokens.test.ts` on both platforms counts off-scale font sizes and radii per file against
  `design-tokens.baseline.json`. A file may only go down; after moving one onto the scale, lower the baseline with
  `UPDATE_DESIGN_TOKENS=1` (the command is in each test's header).

## Ink levels

| Token                                | Use                                                 | Floor                     |
| ------------------------------------ | --------------------------------------------------- | ------------------------- |
| `ink`                                | Primary text                                        |                           |
| `ink-2` / `ink2`                     | Secondary text                                      | 4.5:1 on page and surface |
| `ink-3` / `ink3`                     | Tertiary text: metadata, descriptions, placeholders | 4.5:1 on page and surface |
| `ink-4` / `ink4`                     | Icons at rest, dots, disabled. Never text           |                           |
| `green-ink`, `orange-ink`, `red-ink` | Status colours as text                              | 4.5:1 on page and surface |
| `green`, `orange`, `red`             | Fills, dots, icons, borders                         |                           |

The shared theme builder (`packages/shared/src/themes/build.ts`) solves the floors per theme, and
`themes/index.test.ts` checks every theme. Don't stack opacity on a text colour.

## Radius

Desktop: **4** inline (code, kbd, menu items) · **6** chip, tooltip · **8** control (buttons, inputs, menus) ·
**10** card, popover · **14** dialog, composer, panel · **full** pills, avatars. (Card and window were drawn at 10 / 14
across the app; the scale follows the code.)

Phone: **6** chip · **10** row, control · **14** card · **20** sheet, hero card · **full** pills. Every phone radius sets
`borderCurve: "continuous"`.

Nested: inner radius = outer radius − padding.

## Sizes

- Desktop controls: 24 icon/xs, 28 small (composer chips, tabs), 32 default (buttons, selects, rows), 36 inputs.
  Two-line list rows 48. Fixed heights, never padding-derived.
- Phone: 44pt minimum target (`hitSlop` when the visual is smaller), 56 two-line rows; `PillButton` 32, 44, 52, set
  with `minHeight` so Dynamic Type can grow it.
- Desktop hit area floor is 24px; extend a smaller visual with `before:absolute before:-inset-*`, never overlapping a
  neighbour's target.

## Spacing

4px grid; 2 and 6 allowed inside dense rows. No 3, 5, 7, 10 or 14. Phone screen gutter 16 on every screen, header and
body alike; section gap 24.

## Depth

- Elevated surfaces use a shadow token (`shadow-card`, `shadow-raised`, `shadow-overlay`) and no border: each token
  already paints its 1px ring. Borders are for inputs and flat panels.
- Menus and pickers: `shadow-raised`. Dialogs, command palette: `shadow-overlay`. Inline transcript cards: flat or
  `shadow-card`.
- Phone shadows come from elevation tokens with dark variants, not hard-coded black.

## States

- Focus: one accent ring from `@layer base` in `styles.css`; components may restyle it with `focus-visible:` utilities
  but never recolour it (no ink, ink-3, green or tone outlines). Fields show focus with `focus:border-accent` (plus a
  ring where the field has no border). Menu and picker rows, inside a clipped panel, keep their fill and add the
  accent ring inset (`focus-visible:-outline-offset-2`), never a fill alone. Never a focus style under 3:1.
- Press: `active:scale-press` (0.97) on pills and icon buttons, `active:bg-hover-2` on rows. Phone: opacity 0.6, plus
  scale 0.97 on filled buttons.
- Disabled: 40% on controls, 60% on list rows.
- Hover `bg-hover`; `bg-hover-2` only for selected or pressed, so a hovered row never looks selected. The sidebar is
  the one exception: `--hover` nearly matches `--page` there in Milagre Blue light, so its rows hover with
  `bg-hover-sidebar`. `hover-2` as a hover anywhere else is drift.
- Every hover has `transition-colors`; durations `duration-fast` 120 / `duration-base` 180 / `duration-slow` 280ms on
  `ease-enter`, slides on `ease-slide`.
- Cursor: every enabled button, `role="button"`, link and input label shows the pointer (`styles.css`). That is a
  deliberate departure from macOS; keep it.
- Reduced motion keeps a loading cue (a stepped opacity fade), never a frozen spinner.
- Empty, loading and error states go through shared components (EmptyState, SpinnerRing, InlineError), with "…" (U+2026).

## Primary action

One primary style per platform: ink fill, `on-ink` label. Desktop `Button` (`h-8 rounded-control`,
`hover:opacity-90`), phone `PillButton`. Neither green nor accent fills a primary button: accent is for focus, links
and selection. Green stays a state colour everywhere else (an open PR, online, enabled). A destructive confirm is
`Button variant="danger"` (red fill, `on-red` label).

## Icons

Hugeicons. Desktop sizes 12 / 14 / 16 / 18, stroke 1.8 (1.6 at 12, 2 at 18); 16 in window chrome, 14 inside 28px chips.
Phone 12 / 16 / 18 / 20 / 24. One size per row.

## Decided, not built yet

Victor picked these on 2026-10-28; each lands in its own PR, desktop and phone together:

- Chat text default 14px with 1.6 line height (today 13 / 1.55).
- Desktop approvals inline on their tool row ("Waiting for approval · Decline · Approve · More"); the phone keeps the
  card for 44pt buttons.
- Two-row composer: prompt on top, attach bottom-left, model · effort · send bottom-right, no collapsed state.
  Needs its own design pass first.
- Diagonal stripes at about 4% under the transcript column, and every uppercase label in sentence case.

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

## Missing primitives

Desktop: Popover/MenuRow. Phone: SheetHeader, Chip, ThreadCard, pressStyle, PillButton sizes. Until one exists, copy
the closest existing one exactly rather than inventing values.
