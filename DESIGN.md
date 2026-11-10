# Milagre design system

The rules every Milagre screen follows: the desktop app (`apps/desktop/app/src`), the phone and iPad app
(`apps/mobile/src`) and the looks they share (`packages/shared`). Read it before you change UI, and review UI against it.

- Values not listed here are drift. Where code disagrees with a rule, the rule wins and the code moves toward it, one
  surface at a time.
- The token tables are checked against the code by `apps/site/src/design-system.test.ts`. Change a token in the code
  and in its table in the same PR.
- [milagre.cloud/design](https://milagre.cloud/design) publishes this file with live specimens drawn from the same
  tokens.
- How-tos for scroll areas, menus, sliders and blur live in [docs/agents/ui.md](docs/agents/ui.md).

## Principles

Milagre is a calm, dense workbench for people who run coding agents all day.

1. **Neutral structure, colour with meaning.** Surfaces and text are neutral. Colour shows up only where it says
   something: one accent for focus and links, green, orange and red for state, purple for Ultracode and merged PRs, and
   identity colours for providers, file kinds and PR labels.
2. **Hierarchy from ink and weight first.** Reach for an ink level or a weight before a bigger size. Two weights, one
   short size scale.
3. **Native on each platform.** Desktop reads like a macOS tool, the phone like iOS. Features, behaviour and copy match;
   controls and layout follow each platform.
4. **Dense, never cramped.** Fixed control heights, a 4px grid, one icon size per row.
5. **One way to do each thing.** New UI uses the shared primitives. When one is missing, copy the closest existing one
   exactly instead of inventing values.

## Colour

Every theme comes from one builder, `packages/shared/src/themes/build.ts`: a theme names a few official colours (page,
surface, ink, accent, the status colours) and the builder derives every other token, solving the contrast floors below
for that theme. Twelve themes ship (Milagre Blue, the default, plus Gray, three Catppuccins and seven popular editor
themes), and a custom theme is built the same way. The tables list Milagre Blue.

Desktop reads each token as a CSS variable and a Tailwind colour (`bg-surface`, `text-ink-2`). The phone reads the same
key in camelCase from `theme.ts` (`colors.ink2`, `colors.greenInk`).

- Never put a Tailwind palette colour (`purple-500`, `black/40`) or a hex in a component. Never stack opacity on a text
  colour.
- Accent is for focus rings, links and the unread dot. It never fills a button and never marks a selection.
- Each status colour has three shades: the plain one for fills, dots, icons and borders, `-ink` for text, `-tint`
  behind it.
- A number or word on a coloured fill uses the `-ink` fill and its `on-` label: `bg-red-ink text-on-red`.
- `on-ink` (the surface) labels an ink fill. `scrim` sits behind a modal: black at 20% in light, 40% in dark. `media`,
  `on-media`, `on-media-2` and `on-media-tint` are the lightbox and the camera, black and white in every theme. `paper`
  is a page that stays white (HTML artifacts, QR codes, design thumbnails).
- Identity colours keep their meaning everywhere: each provider's logo colour, `IMAGE_COLOR` violet for an image
  (`@milagre/shared/file-kinds`), a PR label in its GitHub colour.

### Surfaces

<!-- specimen: color-surfaces -->

| Token         | Light       | Dark        | Use                                                            |
| ------------- | ----------- | ----------- | -------------------------------------------------------------- |
| `page`        | `#f4f9fe`   | `#0d1624`   | The window, the transcript, the sidebar                        |
| `canvas`      | `#e9f1fa`   | `#111b29`   | The canvas and recessed areas                                  |
| `surface`     | `#ffffff`   | `#172232`   | Cards, popovers, dialogs, the composer                         |
| `inset`       | `#f9fcff`   | `#121c2b`   | A well inside a card, a picked option row                      |
| `field`       | `#e8edf2`   | `#212c3c`   | Inputs, chips, neutral badges                                  |
| `hover`       | `#1c222b0f` | `#e9eff70d` | Pointer hover on anything: translucent ink                     |
| `hover-2`     | `#1c222b1a` | `#e9eff717` | The open or selected row, a pressed toggle, the menu highlight |
| `line`        | `#edeeee`   | `#273242`   | Hairlines and the rings inside shadow tokens                   |
| `line-strong` | `#e0e1e3`   | `#303b4a`   | Input borders, bordered cards, button rings                    |

### Ink

<!-- specimen: color-ink -->

| Token   | Light     | Dark      | Use                                                                                   |
| ------- | --------- | --------- | ------------------------------------------------------------------------------------- |
| `ink`   | `#1c222b` | `#e9eff7` | Primary text, the primary button's fill                                               |
| `ink-2` | `#4b515a` | `#abb2bd` | Secondary text: values, descriptions, chip labels                                     |
| `ink-3` | `#60656d` | `#939ca9` | Tertiary text: section labels, metadata, placeholders; desktop control glyphs at rest |
| `ink-4` | `#8c929a` | `#646c79` | Decorative icons, dots, disabled controls. Never text                                 |

`ink-2` is `mix(ink, page, 0.25)`, a clear step above `ink-3`.

### Accent

<!-- specimen: color-accent -->

| Token         | Light     | Dark        | Use                                                         |
| ------------- | --------- | ----------- | ----------------------------------------------------------- |
| `accent`      | `#007df3` | `#3e9afd`   | The focus ring, the unread dot                              |
| `accent-ink`  | `#0068cd` | `#80b9fd`   | Links and inline actions that read as links                 |
| `accent-tint` | `#e3f0fe` | `#3e9afd29` | Behind `accent-ink`, for an armed mode such as comment mode |
| `on-accent`   | `#ffffff` | `#0d1624`   | A label on an accent fill                                   |

### Status

<!-- specimen: color-status -->

| Token         | Light     | Dark        | Use                                                      |
| ------------- | --------- | ----------- | -------------------------------------------------------- |
| `green`       | `#199a4d` | `#3cbb72`   | An open PR, online, enabled: fills, dots, icons          |
| `green-ink`   | `#00792e` | `#3cbb72`   | Green as text                                            |
| `green-tint`  | `#e5f2ef` | `#3cbb7224` | Behind green text                                        |
| `on-green`    | `#ffffff` | `#0d1624`   | A label on a `green-ink` fill                            |
| `orange`      | `#ef720d` | `#f68f3c`   | Needs you: an approval, a question; Full mode, Fast mode |
| `orange-ink`  | `#ba4100` | `#f68f3c`   | Orange as text                                           |
| `orange-tint` | `#f5efee` | `#f68f3c24` | Behind orange text                                       |
| `on-orange`   | `#ffffff` | `#0d1624`   | A label on an `orange-ink` fill                          |
| `red`         | `#e3474c` | `#ee5c61`   | Failed, destructive, recording                           |
| `red-ink`     | `#c62935` | `#fd696d`   | Red as text; the danger button's fill                    |
| `red-tint`    | `#f5ecef` | `#ee5c6124` | Behind red text; a danger-ghost button's hover           |
| `on-red`      | `#ffffff` | `#0d1624`   | A label on a `red-ink` fill                              |

### Ultracode

<!-- specimen: color-purple -->

| Token         | Light     | Dark        | Use                                                       |
| ------------- | --------- | ----------- | --------------------------------------------------------- |
| `purple`      | `#ad46ff` | `#ad46ff`   | Ultracode and merged PRs: fills, icons, the composer glow |
| `purple-ink`  | `#8e2bdc` | `#d0a3ff`   | Purple as text                                            |
| `purple-tint` | `#f6edff` | `#ad46ff2e` | Behind purple text, the Ultracode tile when on            |

Purple is `ULTRACODE_PURPLE` (`@milagre/shared/themes`), a brand colour themes don't override.

### Diff

<!-- specimen: color-diff -->

| Token              | Light     | Dark        | Use                  |
| ------------------ | --------- | ----------- | -------------------- |
| `diff-add`         | `#ddeee8` | `#3cbb721f` | An added line's row  |
| `diff-add-word`    | `#bbddc8` | `#3cbb724d` | An added word        |
| `diff-remove`      | `#f6e9ec` | `#ee5c611f` | A removed line's row |
| `diff-remove-word` | `#f7cecf` | `#ee5c614d` | A removed word       |

Settings › Appearance › Diff colors can swap the pair; the theme's own green and red stay for status and errors.

### Contrast floors

The builder solves these for every theme, and `packages/shared/src/themes/index.test.ts` checks every theme in both
schemes. A ground behind translucent fills (`field`, `hover-2`, a tint) is measured over both the page and the surface.

<!-- specimen: contrast -->

| Text                                 | Ratio | On                            |
| ------------------------------------ | ----- | ----------------------------- |
| `ink-2`, `ink-3`                     | 4.5   | page, surface, field, hover-2 |
| `green-ink`, `orange-ink`, `red-ink` | 4.5   | page, surface                 |
| `green-ink`, `orange-ink`, `red-ink` | 4.8   | own tint                      |
| `accent-ink`                         | 4.5   | accent-tint                   |
| `on-green`, `on-orange`, `on-red`    | 3     | own ink                       |

The status inks reach 4.8:1 on their tints because they letter 10px badges there (A, M and D in Changes). A focus
style never drops under 3:1 against what it sits on.

## Type

- Two weights: 500 (medium) and 600 (semibold). 700 only for the phone's 34pt large title.
- No half-pixel sizes. Letter-spacing 0 everywhere, the desktop `body` included, except `-0.02em` on 22px titles.
- Desktop text uses the system UI font (SF Pro on macOS) unless Settings › Appearance picks another, and code uses
  `ui-monospace` (SF Mono). The phone uses the iOS system font and Menlo for code.

### Desktop

<!-- specimen: type-desktop -->

| Token     | Size | Line height | Role                          |
| --------- | ---- | ----------- | ----------------------------- |
| `text-26` | 26   | 32          | Display (Onboarding)          |
| `text-22` | 22   | 28          | Page title, `-0.02em`         |
| `text-17` | 17   | 24          | Dialog title                  |
| `text-15` | 15   | 20          | Section and card title        |
| `text-13` | 13   | 18          | Body UI, rows, buttons        |
| `text-12` | 12   | 16          | Secondary text, small buttons |
| `text-11` | 11   | 16          | Caption, metadata, time       |
| `text-10` | 10   | 14          | Badges only                   |

### Phone

<!-- specimen: type-phone -->

| Style         | Size | Line height | Role                            |
| ------------- | ---- | ----------- | ------------------------------- |
| `largeTitle`  | 34   | 41          | Large title, the one 700 weight |
| `title1`      | 28   | 34          | Title 1                         |
| `title2`      | 22   | 28          | Title 2                         |
| `title3`      | 20   | 25          | Title 3 (a PR title)            |
| `body`        | 17   | 22          | Body, headline, sheet title     |
| `callout`     | 16   | 21          | A two-line row's title          |
| `subheadline` | 15   | 20          | Subheadline, Chat titles        |
| `footnote`    | 13   | 18          | Footnote, secondary text        |
| `caption1`    | 12   | 16          | Caption 1                       |
| `caption2`    | 11   | 13          | Caption 2                       |

The phone sizes are the iOS Dynamic Type defaults (`type` and `lineHeight` in `apps/mobile/src/design-tokens.ts`).

- Chat text is user-scaled: desktop `--chat-size` (14px at 1.6 by default), phone `textPx` (15 at 22). Markdown
  headings are `em`-relative to it.
- Desktop `body` is 13px on a unitless `18 / 13` line, so unsized text follows the 13 step. New prose sets
  `text-13 leading-5` (13/20).
- A group heading above a card is `SectionLabel`: 12 medium `ink-3` (11 in menus), phone 13 footnote `ink3`. 15
  semibold is only for a title inside a card.
- Button labels are 500 on desktop and 600 on the phone (each platform's own style, not drift).
- Prompt chip labels are 0.875em on both platforms.

## Spacing

- A 4px grid. 2 and 6 only inside dense rows. Never 3, 5, 7 or 14.
- 10 only as the horizontal inset of 28px controls and bordered fields: the 1px border plus 10 puts the text 11 in,
  lined up with an unbordered 32 button's 12.
- Desktop uses Tailwind's spacing utilities on the same grid (`gap-1` is 4, `p-3` is 12).
- Phone: a 16 gutter on every screen, header and body alike; 24 between sections; overlays under the Chat header sit at
  `chrome.header` (52) plus 8.

<!-- specimen: space-phone -->

| Token           | Value | Use                         |
| --------------- | ----- | --------------------------- |
| `space.xxs`     | 2     | Inside dense rows only      |
| `space.xs`      | 4     | Icon to label in a chip     |
| `space.sm`      | 6     | Inside dense rows only      |
| `space.md`      | 8     | Between controls            |
| `space.lg`      | 12    | Inside cards and rows       |
| `space.xl`      | 16    | Card padding                |
| `space.xxl`     | 24    | Between groups              |
| `space.xxxl`    | 32    | Between large blocks        |
| `space.gutter`  | 16    | Every screen's side padding |
| `space.section` | 24    | The gap between sections    |

## Radius

<!-- specimen: radius-desktop -->

| Token             | Value | Use                                     |
| ----------------- | ----- | --------------------------------------- |
| `rounded-inline`  | 4     | Code, kbd, menu items                   |
| `rounded-chip`    | 6     | Chips, tooltips                         |
| `rounded-control` | 8     | Buttons, inputs, menus, option rows     |
| `rounded-card`    | 10    | Cards, popovers, toasts                 |
| `rounded-window`  | 14    | Dialogs, the composer, panels, Settings |
| `rounded-full`    | full  | Pills, person avatars                   |

The desktop new-Chat tray is 20: the composer's 14 plus its 6 padding.

<!-- specimen: radius-phone -->

| Token             | Value | Use                                        |
| ----------------- | ----- | ------------------------------------------ |
| `radius.chip`     | 6     | Chips                                      |
| `radius.control`  | 10    | Rows, controls                             |
| `radius.card`     | 14    | Cards                                      |
| `radius.sheet`    | 20    | Sheets, hero cards, iPad side panels       |
| `radius.composer` | 24    | The composer; its tray is the composer + 4 |
| `radius.full`     | 999   | Pills, person avatars                      |

- Every phone radius sets `borderCurve: "continuous"`.
- Nested corners: the inner radius is the outer radius minus the padding between them.
- Project tiles are rounded squares on both platforms, `projectAvatarRadius(size)`: 16 → 4, 20 and 24 → 6, 32 and 40
  → 10, 72 → 20. Without an image, a tile is an ink fill with its on-ink initial at 600 (`@milagre/shared/project-list`).

## Sizes

- Desktop controls: 24 for icon and extra-small buttons, 28 small (composer chips, tabs, approval buttons), 32 default
  (buttons, selects, rows), 36 inputs. Two-line list rows are 48. Heights are fixed, never derived from padding.
- The desktop hit area floor is 24px. Extend a smaller visual with `before:absolute before:-inset-*`, never over a
  neighbour's target.
- Phone: a 44pt minimum target (`hitSlop={hitSlopFor(size)}` when the visual is smaller); rows are 52 for one line and
  56 for two; `PillButton` is 32, 44 or 52, set with `minHeight` so Dynamic Type can grow it.
- A numbered pin over content is 20px with `shadow-pin` and its number at 10 semibold.

## Elevation

- An elevated surface takes a shadow token and no border: each token paints its own 1px ring. Borders are for inputs,
  flat panels and bordered cards (the approval row, the question card).
- Dark mode has its own, deeper shadows in `styles.css`, never the light ones on a dark page.
- Phone elevation comes from `shadowCard`, `shadowRaised` and `shadowOverlay` in `theme.ts`, each with a hairline ring
  and a dark variant; never hard-coded black. Phone grouped cards are flat panels with a hairline.

<!-- specimen: elevation -->

| Token             | Use                                                  |
| ----------------- | ---------------------------------------------------- |
| `shadow-hairline` | A flat panel's 1px ring                              |
| `shadow-btn`      | Secondary buttons                                    |
| `shadow-card`     | Inline transcript cards                              |
| `shadow-raised`   | Menus, pickers, toasts                               |
| `shadow-overlay`  | Dialogs, the command palette                         |
| `shadow-pin`      | A numbered pin over content: a surface-coloured ring |

### Blur

<!-- specimen: blur -->

| Token                   | Value | Use                                                                |
| ----------------------- | ----- | ------------------------------------------------------------------ |
| `backdrop-blur-overlay` | 3     | The scrim behind a dialog, the palette or a viewer                 |
| `backdrop-blur-chip`    | 8     | A floating control: the composer, the buttons on a generated image |
| `backdrop-blur-edge`    | 4     | Content scrolling under a window edge, as a progressive blur       |

Never use Tailwind's own blur sizes or a hand-written `backdrop-filter`. The phone's `EdgeFade` uses a native variable
blur.

## Motion

<!-- specimen: motion -->

| Token   | Value                            | Desktop              | Phone           | Use                                         |
| ------- | -------------------------------- | -------------------- | --------------- | ------------------------------------------- |
| `fast`  | 120                              | `duration-fast`      | `duration.fast` | Hover, press, colour changes                |
| `base`  | 180                              | `duration-base`      | `duration.base` | Things appearing                            |
| `slow`  | 280                              | `duration-slow`      | `duration.slow` | Panels and sheets                           |
| `enter` | `cubic-bezier(0.23, 1, 0.32, 1)` | `ease-enter`         | `easing.enter`  | Everything that appears or settles          |
| `slide` | `cubic-bezier(0.32, 0.72, 0, 1)` | `ease-slide`         | `easing.slide`  | Panels and sheets travelling a long way     |
| `press` | 0.97                             | `active:scale-press` | `pressStyle`    | Filled buttons, pills and icon buttons only |

- A bare `transition` runs at `duration-fast` on `ease-enter`. Every hover has `transition-colors`.
- JS motion uses `EASE_OUT` and `DURATION` (`lib/ease.ts`) on desktop and `scaledTiming` / `springTo` (`motion.ts`) on
  the phone, so Settings › Appearance › Animations scales it.
- Reduced motion keeps a loading cue (a stepped opacity fade), never a frozen spinner. Springs and slides stop.
- Motion explains a change of state. The only loops are running marks: the running Milagre logo, a spinner ring,
  Ultracode's breathing composer.

## Icons

Hugeicons everywhere (`@hugeicons/core-free-icons`), drawn in the text colour.

<!-- specimen: icons -->

| Size | Stroke | Desktop use                                |
| ---- | ------ | ------------------------------------------ |
| 12   | 1.6    | Inside 20px marks and inline with captions |
| 14   | 1.8    | Inside 28px chips, menu rows               |
| 16   | 1.8    | Window chrome, buttons, rows               |
| 18   | 2      | Large controls, the provider rail          |

- Phone sizes are 12, 16, 18, 20 and 24.
- One icon size per row.
- Control glyphs at rest are `ink-3` on desktop and `ink2` on the phone. `ink-4` only for decorative icons, dots and
  disabled controls.
- Shared looks live in `packages/shared` and each app maps the palette keys and icon names to its own:
  `chatMarkPresentation` (`chats`), `PR_TONE` and `pullRequestStatePill` (`pr-blockers`), `permissionPresentation`
  (`model-copy`; Full is the only orange mode), `presenceTone` (`chat-scopes`: green, orange, red, `ink-4` offline),
  `projectAvatarRadius` and `PROJECT_AVATAR` (`project-list`), `IMAGE_COLOR` (`file-kinds`).

## States

- **No switches.** Use a checkbox for an independent on/off setting and a checked list or radio group for one choice
  out of several. No sliding track and thumb, no native Switch, no `switch` role, on either platform. Native menu items
  that draw a checkmark are fine.
- **Focus** is one accent ring from `@layer base` in `styles.css`. A component may restyle it with `focus-visible:`
  utilities but never recolour it. Text fields, the composer and comment boxes show no focus mark: the caret is
  enough. Menu and picker rows inside a clipped panel keep their fill and add the ring inset
  (`focus-visible:-outline-offset-2`), never a fill alone.
- **Press**: `active:scale-press` (0.97) on filled buttons (primary, danger), pills and icon buttons; `active:bg-hover-2`
  on rows. Phone: opacity 0.6, plus scale 0.97 on filled buttons.
- **Disabled**: 40% on controls, 60% on list rows (an offline Project too).
- **Hover** is `bg-hover` everywhere, the sidebar included. `bg-hover-2` is the open or selected row, a pressed toggle
  and the menu highlight, so a hovered row never looks like the open one.
- **Menus and pickers** have one moving highlight, `bg-hover-2`, for pointer and keyboard, plus the inset ring on
  keyboard focus. A checked row shows only a 14px tick, no fill.
- **Selection** is ink on both platforms: a tick, a fill or a dot. Accent never marks a selection.
- **Toggles**: a pressed or open toggle is `bg-hover-2` with an ink glyph (phone: `hover2` fill, ink icon).
  `accent-tint` with `accent-ink` only for an armed mode that changes what a click does (comment mode).
- **Chat status marks**: orange means the Chat needs you (an approval's shield, a question's bubble, the top bar's
  waiting dot); work in progress is quiet `ink-3` (the running spinner, the background ring); failed is red. Unread is
  the one accent status mark, an 8px accent dot, kept on purpose from macOS Mail and Slack. Nothing else uses accent as
  a status.
- **Scrollbars** are overlays: the thumb is transparent at rest and shows while its scroller is hovered or scrolling
  (`data-scrolling`, 800ms after the last scroll event), as on macOS.
- **Empty, loading and error** states go through `EmptyState`, `SpinnerRing` and `InlineError` (phone `ErrorNotice`),
  with "…" (U+2026).

## Components

### Buttons

<!-- specimen: buttons -->

- One primary style per platform: an ink fill with an `on-ink` label. Desktop `Button` (`rounded-control`, hover
  opacity 0.9), phone `PillButton`. Neither green nor accent ever fills a primary button.
- Desktop sizes: 32 by default, 28 in compact rows and composer chips, 24 inline.
- Variants: `primary`; `secondary` (surface with `shadow-btn`); `ghost`; `quiet` (`ink-2`, ink on hover); `link`
  (`accent-ink`, an inline action); `danger` (a `red-ink` fill with an `on-red` label, the confirm of a destructive
  action); `danger-ghost` (`red-ink` text with a `red-tint` hover, the first step: Remove, Delete, Deny, Revoke, Stop).
  Phone `PillButton` has the same primary and destructive pair (`redInk`, `onRedInk`).
- `IconButton` is 20, 24, 28 or 32; a 20 reaches the 24px hit area through `::before`. Its `label` is its name.

### Chips and badges

<!-- specimen: chips -->

- Chips are 28 high, fully round, 12 medium (`Chip`). A composer trigger chip (Run on, Isolation, model, permission)
  is transparent `ink-2`, `hover` on hover and `hover-2` while open; a field chip sits on `field`; a filter chip is a
  surface with `shadow-btn`, and checked, an ink fill with an on-ink semibold label.
- A PR label is a chip in its GitHub colour (`.pr-label`): the label's hue at a fixed lightness per theme, so its text
  clears 4.5:1 on the chip.
- A PR state pill is a tint with its label in the `-ink` shade (`pullRequestStatePill`): Merged purple, Closed red,
  Draft neutral (`hover` fill, `ink-2` label). An open PR shows no state pill.
- Badges such as Recommended are neutral: a `field` fill with an `ink-2` label. 10px text is for badges only.

### Rows and lists

<!-- specimen: rows -->

- Desktop rows are 32 high, two-line rows 48. Hover `bg-hover`, open or selected `bg-hover-2`, disabled 60%.
- Unread is an 8px accent dot. Running is a quiet `ink-3` ring; needs you is orange.

### Approvals

<!-- specimen: approval -->

- Desktop approvals sit inline on their tool row (`agents/step-approval.tsx`): "Waiting for approval" in `orange-ink`
  beside an orange dot, then Deny (`danger-ghost`), Always allow (`secondary`) and Allow once (`primary`), all 28 high,
  with what the tool would run beneath.
- The phone keeps the approval card for its 44pt buttons.

### Question card

<!-- specimen: question -->

- A bordered card (`line-strong`, `rounded-card`, `surface`): "Waiting for answer", the question at 15 semibold, then
  each option as a bordered row (`rounded-control`) with a radio or checkbox, its label at 13 medium and its
  description at 12 `ink-2`. A picked row turns `inset` with a `line-strong` border.
- "Other…" is the last option row: a text field with the mic and image buttons inside it.
- Its footer is Dismiss (`ghost`) and Send answer (`primary`), both 28 high, bottom right.

### Toasts and notices

<!-- specimen: toast -->

- A toast is an ink capsule on both platforms: `bg-ink`, `on-ink` text at 13/18, `rounded-card`, `shadow-raised`, an
  optional on-ink Undo.
- A message that stays is a `Notice` card.

### Model picker

<!-- specimen: picker -->

- Fast and Ultracode are bordered tiles with a checkbox role. At rest: a `line` border, an `ink-2` icon, an ink title.
  On: the tile takes its tint (`orange-tint` for Fast, `purple-tint` for Ultracode), the icon its fill colour and the
  title its `-ink` shade.
- The effort slider (`RangeSlider`) is a 32 high `field` track that fills with ink at 15% up to its value, a tick dot
  per step and an ink bar handle.
- The picked provider in the rail is a `hover-2` tile with an ink mark; the others rest in `ink-3`.

### Activity and running

<!-- specimen: activity -->

- A folded reply's activity summary shows at most four stacked circular marks, one per kind of work: 20px `field`
  circles overlapping by 6px, each ringed in the page colour, with a 12px `ink-2` glyph.
- A running turn shows the animated Milagre logo beside the turn timer (12px `ink-3`, tabular figures).

### Dialogs and Settings

- A dialog is a native `<dialog>` opened with `showModal`: `rounded-window`, `shadow-overlay`, a `scrim` backdrop with
  `backdrop-blur-overlay`, a 17 semibold title, actions bottom right.
- Settings is an in-window dialog, not a second window: Milagre is a one-window app, so Settings opens over the Chat it
  was opened from (`rounded-window`, scrim behind, ⌘, and Esc), keeps its own search and nav, and closes back to where
  you were. Its group labels keep their position, and the selected radio card keeps its 2px ink frame. The phone shows
  Settings as its own stack of screens.

### Composer

- The composer is a floating control: the surface at 76% with `backdrop-blur-chip` and a low shadow, never a raised
  card.
- With Ultracode on, its border and glow take purple and breathe slowly.

## Copy

- Sentence case everywhere. No tracked uppercase labels.
- Product nouns stay capitalised: Project, Chat, Routine, Run, Link, Heartbeat, Worktree, and Done, the named Chat
  state ("Rename Chat", "New Worktree", "Archive Done Chats after").
- Shared words live in `UI_COPY` (`@milagre/shared/model-copy`), so desktop and phone say the same thing.
- An ellipsis is "…" (U+2026): loading text, and a label that opens more input ("Other…", "Compare with…").

## Platforms

### Desktop

- One window. Settings, dialogs and the command palette open over it.
- Every enabled button, `role="button"`, link and input label shows the pointer cursor. That is a deliberate departure
  from macOS; keep it.
- Chrome doesn't select: `button`, `[role=button|menuitem|tab|option]`, `label`, `nav` and `header` are
  `user-select: none`. The transcript, markdown, code, diffs, errors and paths stay selectable.
- Window drag strips use `.title-drag`; a control inside one takes `.no-drag`, not an inline `app-region`.
- The window background is faint diagonal stripes (`--stripe` over `--stripe-bg`). Bordered transcript blocks sit on
  the column edges, and tool glyphs start on the reply text's edge (their hover fill reaches 13px past it). The
  transcript has no fade above the composer: text runs crisp to it, under the glass pills.

### Phone and iPad

- 44pt targets, Dynamic Type (`minHeight`, never a fixed height on text controls), continuous corners.
- Dialogs are sheets; Settings is a stack of screens.
- iPad side panels use `radius.sheet` (20).

### Desktop and phone stay in sync

Every change lands on both platforms in the same task, unless the owner says to keep it on one (`AGENTS.md`). Keep
features, behaviour, copy, states and fixes the same; use each platform's native controls and layout. Shared logic,
looks and copy live in `packages/shared`.

## Do and don't

<!-- specimen: dos -->

| Do                                                  | Don't                                          |
| --------------------------------------------------- | ---------------------------------------------- |
| Fill the primary button with ink                    | Fill a primary button with green or accent     |
| Mark a selection with ink: a tick, a fill or a dot  | Mark a selection with accent                   |
| Use a checkbox for on/off, a radio group for one-of | Use a switch                                   |
| Write status text in its `-ink` shade               | Write text in a plain status colour or `ink-4` |
| Write labels in sentence case                       | Write tracked uppercase labels                 |
| Let the shadow token paint an elevated edge         | Add a border to a shadowed surface             |
| Keep the accent focus ring                          | Recolour or remove a control's focus ring      |
| Show unread as the one accent dot                   | Use accent for any other status                |

## Decided calls

The owner's decisions. Don't re-propose a rejected option; changing any of these needs Victor's say-so.

### Kept after the desktop council (2026-11-09)

- The Unified / Split diff toggle stays two icon buttons, not a labelled segmented control.
- PR labels stay GitHub-coloured chips, not neutral chips with a dot.
- Fast and Ultracode stay bordered tiles, not checkbox rows.
- The effort slider keeps its fill.
- Settings group labels keep their position (no 16px inset); the selected Settings radio card keeps its 2px ink frame.
- The activity summary keeps its stacked circular tool marks.
- The running turn keeps the animated Milagre logo beside the timer.
- Files / Commits and PR Summary / Files are segmented controls.
- The question card's "Other…" is the last option row, with the mic and image buttons inside it.
- Unread stays a blue accent dot, the one accent status. Settings stays an in-window dialog. Done is a product noun.

### Routines page (2026-11-10)

- The header is the title and New Routine only, on both platforms; the lid note shows in the empty state.
- Filters are two chip dropdowns, Show and Computer, with counts in their menus; no chip rows.
- Rows have no on/off tick: Pause and Resume are the first action in the ⋯ menu (phone: the long press), and each
  Routine's own page keeps its checkbox. A row's glyph is bare (no tile), rows are 56 high, and the status sits in a
  72px column ("Next 16:00" today, "Fri 16:00", "Nov 18 10:00", "Paused").
- Group labels have no glyph and sit on the column edge. The Flow badge is a neutral badge. Schedules read in words
  ("Fridays 16:00", "every 30 min from :15"); only other shapes show their cron.

### Phone pass verdict (2026-11-10)

- Kept: the phone Chat list rows (56pt, a trailing status slot, no state words, no Project tile in a one-Project list,
  last activity on line two) and the phone model sheet (bordered tiles in both themes, one surface, a compact glass
  Cancel and Done, no repeated logos).
- Rejected: an "N waiting" chip; a waiting line in place of the timer; SF Mono and light chips; a send arrow with a stop
  square; the card restyle; the Settings close and search changes; the New Chat layout; a "Compare with…" collapsed
  chip; the diff layout; darker diff `-ink` colours; an orange question tone; "1 other waiting"; a stronger effort
  fill; dropping Project tiles on desktop.

### Review rounds (2026-10-28 and 2026-10-29)

- Hover and hover-2 are translucent ink; the sidebar hovers like everything else (`hover-sidebar` is a deprecated alias).
- Selection is ink; accent is for focus and links. A pressed or open toggle is `hover-2` with an ink glyph.
- The menu highlight is `hover-2` plus the inset ring on keyboard focus; a checked row shows a 14px tick.
- Group headings are `SectionLabel`; 15 semibold only inside cards. `ink-2` is `mix(ink, page, 0.25)`.
- Desktop body text is 13/18; chat text 14 at 1.6; the 10 inset only on 28px controls and bordered fields.
- Press scale only on filled buttons, pills and icon buttons. Toasts are an ink capsule on both platforms.
- The desktop new-Chat tray is 20; the phone composer 24, its tray composer + 4; iPad side panels 20.
- A pasted image uses the image file-kind colour on both. The floating inbox follows the theme.
- Product nouns are capitalised, everything else sentence case. The Recommended badge is neutral.
- Button labels are 500 on desktop, 600 on the phone. Control glyphs at rest are `ink-3` (phone `ink2`).
- Chrome labels don't select. Desktop approvals are inline on their tool row; the phone keeps the card.
- Text fields, the composer and comment boxes show no focus mark (2026-11-02).

### Decided, not built yet

Each lands in its own PR, desktop and phone together:

- The two-row composer: the prompt on top, attach bottom left, model · effort · send bottom right, no collapsed state.
  It needs its own design pass first.
- The phone Chat list rows and model sheet kept on 2026-11-10.
- The running Milagre logo on main: the restore (commit `9099b01b`) missed the #985 merge.

## Primitives

New UI uses these; hand-written copies move onto them.

**Desktop** (`apps/desktop/app/src/components/primitives/`): `Button` and `buttonClass()`, `IconButton`, `Dialog`,
`Popover` with `MenuRow`, `Input` / `FIELD` / `FIELD_AREA` (36px, no focus edge), `Checkbox`, `RadioGroup`,
`Segmented`, `Tabs`, `Select`, `PickerPanel` / `PickerRow`, `RangeSlider`, `Chip`, `StatusPill`, `Icon`,
`ProjectAvatar`, `SectionLabel`, `TranscriptDivider`, `EmptyState`, `InlineError`, `SpinnerRing`, `Skeleton`,
`ProgressBar`, `ScrollArea`, `Tooltip`, `ShortcutKeys`, and `Notice` (`components/Notice.tsx`) for a dismissable card
over a view.

**Phone** (`apps/mobile/src/primitives/`): `PillButton` (Button); `IconButton`, `CircleButton`, `GlassIconButton` and
`HeaderButton` (IconButton); `Field` (Input); `Checkbox`, `CheckRow` and `ChoiceRow` (PickerRow, RadioGroup); `Chip`,
`Tag` and `Segmented`; `ListRow` and `Group` (settings rows and cards); `SectionLabel`; `TranscriptDivider`;
`ErrorNotice` and `InlineError`; `Sheet` (Dialog); `PullDown` and `NativeMenuSection` (menus); `Toast`;
`ProgressBar`; `PageScroll` (ScrollArea); `pressStyle`; `announce`.

## Enforcement

- `apps/site/src/design-system.test.ts`: every token table in this file matches the code (the theme builder,
  `styles.css`, `Icon.tsx` and the phone's `design-tokens.ts`), and `styles.css`'s fallback colours match the default
  theme.
- `design-tokens.test.ts` on desktop and phone: counts off-scale font sizes and radii per file against
  `design-tokens.baseline.json`. A file's count may only go down; after moving a file onto the scale, lower it with
  `UPDATE_DESIGN_TOKENS=1` (the command is in each test's header).
- `packages/shared/src/themes/index.test.ts`: the contrast floors, every theme, both schemes.
- `scripts/no-switch-controls.test.cjs`: no switch controls or roles.
- `scroll-area-only.test.ts`, `no-native-select.test.ts` and `backdrop-blur.test.ts`: the scroll, select and blur rules
  in `docs/agents/ui.md`.

## The site

milagre.cloud (`apps/site`) lives in the day the desktop app's first-launch intro, Dawn, ends on: a cream page, warm
ink and a gold-brown accent, with Geist for text and Instrument Serif italic for the headline's accent words. Live copies
of the app on it (the Designs panel, the canvas, a terminal, the recordings) keep dark Milagre Blue. It follows the
colour roles, radii and motion above, except where it borrows from Dawn: the download button is a dark pill in warm
light, like the intro's Begin, and the hero plays the intro.

- The landing hero is Dawn's sky. A first visit plays the intro once (night, the falling star landing on the logo, dawn
  into day); later visits and reduced motion open on its last frame. The headline, the apps and the download button are
  there from the first frame.
- Clouds and light stay in the hero. Sections below it sit on the plain page.
- Its Lighthouse scores never drop below `apps/site/lighthouse-budget.json`.
