# Milagre interface system

The scales and rules every UI change on desktop (`apps/desktop/app/src`) and phone (`apps/mobile/src`) follows. Values not
listed here are drift. Where code disagrees, this file wins and the code moves toward it, surface by surface. The review
behind it: the "Milagre design review" artifact (2026-10-28).

## Direction

A calm, dense workbench for people running coding agents all day. Neutral structure; colour only where it means
something (one accent for action and focus, green/orange/red for state, provider colours for identity). Hierarchy
comes from weight and ink level before size. Desktop reads like a macOS tool, the phone like iOS.

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
- Letter-spacing 0 at 11px and below; `-0.02em` on 22px titles.

## Tokens and enforcement

- Desktop sizes are Tailwind utilities `text-10` … `text-26` (each with its line height), radii `rounded-inline`,
  `rounded-chip`, `rounded-control`, `rounded-card`, `rounded-window`, `rounded-full`, easing `ease-enter` and
  `ease-slide` (`apps/desktop/app/src/styles.css`).
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
**12** card, popover · **16** dialog, composer, panel · **full** pills, avatars.

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

- Switches are banned. Use checkboxes for independent on/off settings and checked lists or radio groups for mutually exclusive choices. No sliding track/thumb controls or switch accessibility roles on either platform.

- Focus: one accent ring from `@layer base` in `styles.css`; components may restyle it with `focus-visible:` utilities.
  Fields show focus with `focus:border-accent` (plus a ring where the field has no border). Never a focus style under
  3:1.
- Press: `active:scale-[0.97]` on pills and icon buttons, `active:bg-hover-2` on rows. Phone: opacity 0.6, plus scale
  0.97 on filled buttons.
- Disabled: 40% on controls, 60% on list rows.
- Hover `bg-hover`; `bg-hover-2` only for selected or pressed, so a hovered row never looks selected.
- Every hover has `transition-colors`; durations 120 / 180 / 280ms on `cubic-bezier(0.23, 1, 0.32, 1)`, slides on
  `cubic-bezier(0.32, 0.72, 0, 1)`.
- Reduced motion keeps a loading cue (a stepped opacity fade), never a frozen spinner.
- Empty, loading and error states go through shared components (EmptyState, Spinner, InlineError), with "…" (U+2026).

## Primary action

One primary style per platform: ink fill, `on-ink` label. Desktop `h-8 rounded-control`, `hover:opacity-90`. Phone
`PillButton`. Green only for the merge state; accent is for focus, links and selection, not filled buttons.

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

## Missing primitives

Desktop: Button (primary, secondary, ghost, danger; xs/sm/md), Input, Dialog, Popover/MenuRow, Icon, EmptyState,
Spinner, InlineError, TranscriptDivider, SectionLabel, ProjectAvatar. Phone: SheetHeader, Chip, ThreadCard, pressStyle,
PillButton sizes. New UI uses these once they exist; until then, copy the closest existing one exactly rather than
inventing values.
