# Milagre phone design system

The rules the phone and iPad app (`apps/mobile/src`) draws with on iOS and Android. The root
[DESIGN.md](../../DESIGN.md) is the design system for every Milagre screen; this file is its phone chapter: every
token the phone reads, every primitive it draws with, and where iOS and Android part ways. Read both before you change
phone UI.

- Every value here comes from the code: `src/design-tokens.ts` (type, spacing, radius, motion, touch targets),
  `src/theme.ts` (the palette and elevation) and `src/primitives/`. Change a value there and here in the same PR.
- Settings › Design system shows this file live: each section's specimens drawn by the real primitives in the current
  theme, plus the platform notes. Its sections, colour roles and platform rules are data in
  `src/design-system-catalogue.ts`; `design-system-catalogue.test.ts` checks every rule below is named here.
- The `milagre-design` Oxlint plugin (`lint/design-system.mjs`) fails `npm run lint` and the pre-commit hook on any
  drift, with no baseline: a literal font size or line height (`type`, `lineHeight`), radius (`radius`), spacing off
  the 4 pt grid (2 and 6 allowed), a raw colour (`useTheme().colors`; `transparent` is fine), a hand-made shadow
  (`shadowCard`/`shadowRaised`/`shadowOverlay`), an opacity other than 0 or 1 (`pressStyle`), a weight other than 400,
  500 and 600 (700 with `largeTitle`), the blur library outside GlassSurface and EdgeFade, an `accessibilityRole`
  Android doesn't know, "Mac" in copy, and a `Stack.Toolbar.Button` SF Symbol outside an iOS branch. An exception is
  one line, `// oxlint-disable-next-line milagre-design/<rule> -- <why>` (a disable without a reason fails too);
  tokens, theme and press-style files are exempt. Exceptions are for what the tokens can't say: artwork (the
  onboarding scene, the pairing sky, the Ultracode glow and fatality keep their own colours, sizes and glows), mask and
  hit-test fills (a MaskedView's opaque black, SwiftUI's near-clear tap fill), an animated shadow (the Chats list's drag
  lift fades `shadowRadius` with its spring and takes `colors.media` as its colour), the composer's tunable tinted blur
  (`composer-glass.tsx`), and copy that is only true of macOS.
- `design-tokens.test.ts` counts off-scale icon sizes, durations, computed and SwiftUI fonts, uppercase and tracking per
  file against `design-tokens.baseline.json`; a file's count only goes down.

## Principles

1. **The shared principles first.** Neutral structure and colour with meaning, hierarchy from ink and weight, dense never
   cramped, one way to do each thing: root DESIGN.md, Principles and Colour. Accent is focus and links, never a fill or
   a selection; selection is ink.
2. **Native on each platform.** The phone reads like iOS on an iPhone and like Android on an Android phone. Features,
   behaviour and copy match on both; controls, chrome and navigation follow the platform (see iOS and Android
   differences). When a native control has no counterpart, the primitive draws the closest Milagre look instead of a
   broken stand-in (GlassSurface on Android).
3. **Primitives, not copies.** New UI imports from `src/ui.tsx` (the barrel) or `src/primitives/` directly. A primitive
   never imports the barrel (`scripts/mobile-primitives.test.cjs`). When one is missing, copy the closest one exactly.
4. **Dynamic Type everywhere.** Sizes are the iOS Dynamic Type defaults; controls set `minHeight`, never a fixed height
   on text, so larger text grows them.

## Colour

`useTheme().colors` is the `Palette`: the theme builder's `ThemePalette` (`packages/shared/src/themes`) for the theme
and mode in Settings › Appearance, plus the phone's own keys from `theme.ts`. Never write a hex in a component; the
phone's own literals live in `theme.ts` (media, scrim, the shadows).

| Group     | Keys                                                                      | Use                                                                                                                    |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Surfaces  | `page`, `canvas`, `surface`, `inset`, `field`                             | Screens; recessed areas and your message's bubble; cards, sheets, the composer; a well in a card; fields               |
|           | `hover`, `hover2`                                                         | Translucent ink: an iPad pointer over anything; the open or selected row, a pressed toggle                             |
|           | `line`, `lineStrong`, `paper`                                             | Hairlines and shadow rings; field, chip and secondary-pill edges; a page that stays white                              |
| Ink       | `ink`, `ink2`, `ink3`, `ink4`                                             | Primary text and the primary fill; secondary text and glyphs at rest; labels, metadata, values; ink4 marks, never text |
|           | `onInk`, `idleDot`                                                        | A label on an ink fill (the surface); the idle Chat mark (`ink4`)                                                      |
| Accent    | `accent`, `accentInk`, `accentTint`, `onAccent`                           | Focus edges, the caret, the unread dot; links; an armed mode; a label on accent                                        |
| Status    | `green`, `orange`, `red` with `-Ink`, `-Tint` and `on-`                   | Fill, text, the ground behind text, a label on the `-Ink` fill                                                         |
|           | `onRedInk`                                                                | The label on a destructive primary `PillButton` (its fill is `redInk`)                                                 |
| Ultracode | `purple`, `purpleInk`, `purpleTint`                                       | `ULTRACODE_PURPLE`, the same in every theme                                                                            |
| Diff      | `add`, `remove`, `diffAdd`, `diffAddWord`, `diffRemove`, `diffRemoveWord` | Additions and deletions; Settings › Appearance › Diff colors swaps the pair                                            |
| Overlays  | `scrim`                                                                   | Behind a modal: `#00000033` light, `#00000066` dark                                                                    |
| Media     | `media`, `onMedia`, `onMedia2`, `onMediaTint`                             | Full-screen media and the camera: `#000000`, `#ffffff`, `#ffffffcc`, `#ffffff26` in every theme                        |
| Terminal  | `cursor`, `selection`, `ansi` (16), `syntax`                              | The Terminal, and code tokens in files and diffs                                                                       |
| Aliases   | `bg`, `panel`, `text`, `muted`, `error`, `backdrop`                       | Old names for `page`, `surface`, `ink`, `ink2`, `redInk`, `scrim`; new code uses the real key                          |

- `onRed` on the phone is the label on the plain `red` fill (a recording mic, icon only); a label on `redInk` is
  `onRedInk`.
- A status as text goes through `inkFor(colors, tone)`: the `-Ink` shade, 4.5:1 on page, card and its tint.
- `Icon` takes a `tone` (any colour key) and draws in it; control glyphs rest in `ink2`, decorative ones in `ink4`.

## Type

The `type` and `lineHeight` scales in `design-tokens.ts`: the iOS Dynamic Type defaults, used on both platforms. Write
`{ fontSize: type.body, lineHeight: lineHeight.body }`, never a number.

| Style         | Size | Line height | Role                                          |
| ------------- | ---- | ----------- | --------------------------------------------- |
| `largeTitle`  | 34   | 41          | Large title, the one 700 weight               |
| `title1`      | 28   | 34          | Title 1                                       |
| `title2`      | 22   | 28          | Title 2                                       |
| `title3`      | 20   | 25          | Title 3: a PR title, a card's heading (600)   |
| `body`        | 17   | 22          | Body, a row's title, a sheet's title (600)    |
| `callout`     | 16   | 21          | A two-line row's title (500)                  |
| `subheadline` | 15   | 20          | Subheadline, Chat titles, regular pill labels |
| `footnote`    | 13   | 18          | Section labels (500, `ink3`), meta lines      |
| `caption1`    | 12   | 16          | A row's subtitle, `Tag` labels                |
| `caption2`    | 11   | 13          | Badges and counts                             |

- Two weights, 500 and 600; 700 only on `largeTitle`. Button labels are 600 (500 for a `muted` Cancel). Letter-spacing
  0, no uppercase.
- Chat text is user-scaled: `textPx` (15 by default, line height `round(textPx × 1.4667)`, so 22) and code `codeSize`
  (12), both from `useTheme()`. Code is `fonts.mono`.
- `useStyles()` holds the shared text styles: `text` (body), `muted` (15 `ink2`), `label` (13 medium `ink2`), `caption`
  (12 `ink3`), `footnote` (13 `ink3`), `sheetTitle` (17 semibold), `subtitle` (20 semibold), `title` (34 bold), `code`
  (13 mono).

## Spacing

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

- A page is `PageScroll`: its content is `padding: space.gutter`, `gap: space.section`, `paddingBottom: space.xxxl`.
- `chrome.header` (52) is the floating Chat header under the safe area (6 + 44 + 2); an overlay under it sits at its
  bottom plus 8.

## Radius

| Token             | Value | Use                                                   |
| ----------------- | ----- | ----------------------------------------------------- |
| `radius.chip`     | 6     | Checkboxes, square tags                               |
| `radius.control`  | 10    | Rows (iPad hover), fields, controls                   |
| `radius.card`     | 14    | Cards and grouped lists                               |
| `radius.sheet`    | 20    | Sheets, your message's bubble, the iPad Settings card |
| `radius.composer` | 24    | The composer; its tray is composer + 4                |
| `radius.full`     | 999   | Pills, chips, round buttons, dots, avatars            |

Every corner sets `borderCurve: "continuous"`. A nested corner is the outer radius less the padding between them.

## Motion

| Token           | Value              | Use                                     |
| --------------- | ------------------ | --------------------------------------- |
| `duration.fast` | 120                | Hover, press, colour changes            |
| `duration.base` | 180                | Things appearing                        |
| `duration.slow` | 280                | Panels and sheets                       |
| `easing.enter`  | `0.23, 1, 0.32, 1` | Everything that appears or settles      |
| `easing.slide`  | `0.32, 0.72, 0, 1` | Panels and sheets travelling a long way |

- Durations go through `scaledTiming` and `springTo` (`motion.ts`) with `useMotionScale()`, so Settings › Appearance ›
  Animations (1, 0.6, 0) scales them; curves are `Easing.bezier(...easing.enter)`. Navigation transitions stay native.
- Press is `pressStyle`: opacity `PRESSED_OPACITY` (0.6), plus scale 0.97 on a filled button. Disabled is
  `DISABLED_OPACITY`: 0.4 on controls, 0.6 on rows.

## Touch targets

44 pt is the floor. A smaller visual reaches it with `hitSlop={hitSlopFor(size)}` (`(44 − size) / 2` on each side):
`HeaderButton` (36), `CircleButton` (40) and `IconButton` (32 to 48) do it themselves; a small `PillButton` and a
`Chip` take a 6 slop. `PullDown` grows its own target by its `hitSlop` without moving the trigger. Rows are 52 for one
line, 56 with a subtitle, 48 compact (`rowMetrics`).

## Elevation

Elevation is `boxShadow` from `theme.ts`, each token with its own hairline ring in `line`, so an elevated surface takes
no border. Grouped cards are flat: the surface with a hairline (`useStyles().card`), no shadow.

| Token           | Light                  | Dark                   | Use                                                                               |
| --------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `shadowCard`    | `0 1px 3px #0000000f`  | `0 1px 3px #00000040`  | An inline card; Android's raised segment                                          |
| `shadowRaised`  | `0 4px 20px #0000000f` | `0 4px 20px #00000059` | Floating controls: the inbox button, the undo panel, viewer chrome; Android glass |
| `shadowOverlay` | `0 8px 28px #00000017` | `0 8px 28px #00000080` | The iPad Settings card, the question card over the composer                       |

## Surfaces

- `page` under everything; `surface` for cards, sheets and the composer; `canvas` for recessed areas and your message's
  bubble; `inset` for a well inside a card; `field` for inputs.
- **GlassSurface** (`primitives/glass-surface.tsx`) is the surface behind a floating control, absolutely filling its
  parent at `radius` (full by default): the Chat header's action group (`HeaderActionGroup`), the Chats list's filter
  and search, the phone header capsule (radius 20). iOS draws Liquid Glass (`LiquidGlassView`, regular, not
  interactive, the surface as its reduced-transparency fallback). Android draws `surface` with `shadowRaised`. Fade an
  ancestor of iOS glass and its shared glass turns off, so a pressed `HeaderAction` tints itself with `hover` instead.
- `EdgeFade` (`bottom-fade.tsx`) fades content under a floating edge: a native progressive blur over a page tint on
  iOS; on Android a gradient that turns solid page for its last 70%.

## Components

Every primitive is exported from `src/ui.tsx` unless a path is given. Buttons, rows, chips and menu choices run `tap()`
(the selection haptic) before their `onPress`.

**Buttons**

- `PillButton`: the phone's one button, a capsule with a 600 label. `variant` primary (ink fill, onInk label),
  secondary (surface, 1px `lineStrong`), tinted (`field`), plain (none; `muted` for Cancel); `destructive` makes a
  primary a `redInk` fill with `onRedInk` and the others a `redInk` label; `tone="orange"` an orange tint; `size` small
  32, regular 44, large 52 (as `minHeight`); `loading` keeps the width. Not for icon-only actions.
- `Button`: deprecated, an old call site's PillButton. Don't use it.
- `CircleButton`: the 40 pt outlined round button of sheets and panels (close, back, done, viewer tools); `filled` is
  the primary, `selected` an on toggle (`hover2`), `badge` a count, `asTrigger` for a PullDown's child. Not in a header
  (HeaderButton) or a dense row (IconButton).
- `IconButton`: round, no edge, 32/36/40/44/48 with 16, 20 or 24 glyphs in `ink2`; `filled` (ink, or `fill` such as
  Ultracode's purple), `selected`, `loading`. Not for a sheet's close (CircleButton).
- `GlassIconButton`: a floating round button over content (the Chat's sidebar and close buttons); `prominent` is ink.
  Needs an SF Symbol name and a Hugeicons glyph, one per platform.
- `HeaderButton`: a 36 pt bar button for a native header, in a `Stack.Toolbar.View` on Android. Not outside a header.
- `HeaderActionGroup` and `HeaderAction` (`primitives/header-action-group.tsx`): one GlassSurface holding the Chat
  header's 44 pt actions.

**Rows and lists**

- `ListRow` (also `Row` from `settings-list`): icon, title, subtitle or `value` (ink3), chevron; `toggle` makes the whole
  row a checkbox; `compact`, `destructive`, `disabled` (60%), `selected` (the iPad sidebar's `hover2`), `trailing`
  replaces value and chevron. Lights up when Settings search opens its page on it (`Findable`).
- `Group`: a `SectionLabel`, the rows in one flat card with separators (`inset` 32 past an icon, 0, or "full"), a
  footnote under it; `role="radiogroup"` for CheckRow radios.
- `CheckRow`: a choice row with ListRow's metrics; `kind` radio (an 18 pt ink tick when checked) or checkbox (a leading
  `CheckboxBox`).
- `ChoiceRow` (`primitives/choice-row.tsx`): a single-choice row, 48 high, its tick in ink like every selection (root
  DESIGN.md, States). A new list uses CheckRow.
- `Toggle`: an independent on/off as a labelled checkbox. `RowCheckbox`: the checkbox alone, for a row that draws its own
  label. `CheckboxBox`: the 20 pt box CheckRow leads with. There are no switches.
- `SectionLabel`: a group's heading, 13 medium `ink3`, 16 in (`flush` for 0), `trailing` a count or a button.
- `Field`: a labelled text field, `field` fill with a `lineStrong` edge that turns `accent` while focused and `redInk`
  when `invalid`; `leading` and `trailing` sit inside the edge.
- `InlineError`: a field-level error in `redInk` (`warning` in `orangeInk`), announced. `ErrorNotice`: a blocking
  failure, a `redTint` card with its retry. `EmptyState`: a bare centred empty list with an optional secondary action.
- `ProgressBar`: a `lineStrong` track, 4 or 6 tall, filled ink or a status tone.
- `PageScroll`: every page's scroll view, with the page padding and an optional `fadeEdges`. `SettingsScroll`
  (`settings-find.tsx`) is the one Settings pages use, so a search result scrolls to its row.

**Chips and tags**

- `Chip`: a 32 pt pill, 13 medium. Picked is an ink fill with an onInk label; otherwise the surface with a 1px
  `lineStrong` edge and an `ink2` label. A radio in a `radiogroup`, a checkbox with `multiple`, a tab with `role="tab"`,
  static without `onPress`.
- `Tag`: a static 24 pt label at 12 medium: neutral on `field`, a status tone on its tint with its `-Ink` label, a dot or
  12 pt icon, `square` for 6 corners, `tint` for a data colour. A tappable one is a Chip.

**Menus and sheets**

- `PullDown`: a native menu on its trigger; with `onPress` a tap runs it and a long press opens the menu. `nativeTrigger`
  draws an SF Symbol or a footnote chip in SwiftUI on iOS; `searchable` opens the choice sheet instead. Sections are
  `MenuSection` (`primitives/menu.ts`): checked items, destructive items, subtitles, submenus.
- `NativeMenuSection` (`primitives/native-menu-section.tsx`): the SwiftUI rows inside PullDown on iOS. Not used alone.
- `showActions`: a row's actions in the confirmation sheet, Cancel last. `showChoiceSheet` (`choice-store.ts`): a
  searchable list in the choice sheet. Both wait in a store because a sheet route can't carry callbacks.
- `Segmented`: a short choice of two to four. Not for long lists (CheckRow in a radiogroup).
- `SheetHeader`, `SheetBody`, `useSheetBottomInset`: a sheet's top bar (a 17 semibold title centred between two equal
  slots, usually CircleButtons) and its non-scrolling body.
- `Toast` and `ToastPill` (`primitives/toast.tsx`): an ink capsule with onInk text and an optional Undo, gone after 2.6 s.

**Chat**

- `TranscriptDivider`: a transcript event between two rules, 12 `ink3`, a button with `onPress`.
- Your message is a `canvas` bubble, `radius.sheet`, padded `space.lg` by `space.xl`; a reply is `Markdown` at `textPx`.
  Both are `ChatReply` (`chat-reply.tsx`).

**Helpers**

- `pressStyle`, `PRESSED_OPACITY`, `DISABLED_OPACITY`: the press and disabled look of every Pressable.
- `useStyles`: the shared styles, built once per palette (`createStylesHook` in `theme.ts` for a screen's own).
- `announce` and `useAnnounce`: read a message aloud on both platforms.
- `tap`: the selection haptic. `useHover` and `HoverView` (`primitives/hover.tsx`): an iPad pointer's hover.
  `rowMetrics` and `rowHover` (`primitives/row-metrics.ts`): a row's heights, title style and hover fill.

## iOS and Android differences

What the code does today. Each rule is also a card on Settings › Design system › iOS and Android differences, from
`PLATFORM_RULES` in `design-system-catalogue.ts`.

- **Floating controls.** iOS: `GlassSurface` is Liquid Glass. Android has no Liquid Glass, and the library's stand-in
  smears into grey blobs, so it draws `surface` with `shadowRaised`: a raised surface, not glass.
- **Headers.** iOS: every Stack's bar is transparent with the content blurring softly under it (the scroll edge
  effect), and the content inset under it is automatic (`stackScreenOptions`). Android has neither, so bars are solid
  `page` and content starts below them. The Chat keeps a transparent bar on both and clears it itself; on Android an
  opaque `EdgeFade` under the title stands in for the blur.
- **Going back.** iOS: the header's sidebar button and the edge swipe open the Chats list; there is no system back.
  Android: the system back pops a pushed page, closes an open panel such as Changes, and from a Chat at the root opens
  the Chats list; back on the Chats list leaves the app, as a launcher's first page does.
- **Native header buttons.** iOS: `Stack.Toolbar.Button` with an SF Symbol (`xmark`, `sidebar.left`), its round glass
  drawn by iOS. Android's toolbar takes no SF Symbols, so it is `Stack.Toolbar.View` holding a `HeaderButton` with the
  Hugeicons glyph (`Cancel01Icon`, `SidebarLeftIcon`).
- **Glass icon buttons.** iOS: `GlassIconButton` is a SwiftUI button in the `glass` style (`glassProminent` when
  prominent) with its SF Symbol, or the Hugeicons glyph at `iconSize`. Android: a `CircleButton` with the Hugeicons
  glyph, `filled` when prominent.
- **Menus.** iOS: `PullDown` is a SwiftUI menu laid over the trigger, and a choice runs once the menu has closed.
  Android: the Material dropdown (`MenuView` from `@expo/ui`). Compose measured its trigger at the content's own width,
  so a long title ran under a row's actions; the trigger is capped to the box it sits in.
- **Segmented controls.** iOS: a SwiftUI `Picker` in the segmented style. Android: the same track and raised segment drawn from the theme (Material's dropdown read as a text field).
- **Switches and checkboxes.** Both: `Toggle`, `RowCheckbox` and a `ListRow` toggle draw a checkbox, never a switch.
  A checked item in a menu is a SwiftUI `Toggle` on iOS, drawn as a checkmark, and a Material item with its state on
  on Android.
- **Scrolling inside sheets.** `PageScroll` sets `nestedScrollEnabled`. Android needs it: without it the sheet keeps
  every vertical drag and a long Settings page can't scroll. iOS ignores it.
- **Dismissing the keyboard.** `PageScroll` lowers the keyboard interactively on iOS, following the finger, and as a
  drag starts on Android.
- **Panels under sheets.** iOS presents sheets above the side panels. Android sheets live in the app's own view tree,
  below the panels, so a Chat's panels hide while another screen covers it and come back, still open, when it closes.
- **Settings on a large screen.** iOS on an iPad: Settings is a card over a scrim (`SettingsSplit`), with the list
  beside the page once the card is 700 wide; Keybindings shows only there. Android: the one-column sheet at every width.
- **Following the end of a Chat.** iOS jumps to the end at once. Android waits a frame: it runs the jump before the
  grown content is mounted and lands short. Bursts of growth share one jump, so a streaming reply stays above the
  composer and a Chat opens at its end.
- **Haptics.** `tap()` plays the selection haptic on iOS and does nothing on Android.
- **Code font.** `fonts.mono` is Menlo on iOS and the system `monospace` on Android.
- **Announcements and roles.** There is no `"status"` accessibility role; Android rejects a view with it with a red
  screen. For a line that changes, use a polite `accessibilityLiveRegion` (spoken on Android only) or `announce()` (both
  platforms), never both, or TalkBack reads it twice. The `alert` role is never spoken on iOS, so `ErrorNotice` and
  `InlineError` announce themselves.
- **Words.** iOS says "This iPhone" or "This iPad" ("On this iPhone" heads Settings) and "simulator"; Android says "This
  phone" ("On this device" in Settings) and "emulator". On both the other machine is "your computer", never "your Mac".
