# Appearance options and skill/file chips

Date: 2026-10-19. Status: draft for Victor's approval.

## Why

Settings › Appearance only offers Mode, the theme picker and Custom theme. People want to tune how Milagre reads: bigger or smaller text, a different font, a wider chat on a big monitor, colorblind-safe diffs, less motion. Other apps expose these as raw number boxes ("14 px", "820 px"), which nobody enjoys. Every option here is a menu with named choices.

In the composer, a recognized `/skill` only turns accent-colored and an `@file` disappears into an attachment tile. Both should read as distinct objects in the text, the way Victor's reference shows: `Use [Frontend Design] to fix the flaky test in [TS surface.test.ts] ...`.

## Goals

1. Appearance gains Typography, Layout, Diffs and Motion groups. Every control is a menu (the `Select` primitive), never a number field.
2. Skills and files are inline chips: in the desktop composer, in sent user messages on desktop and phone, and (tinted, no icon) in the phone composer.
3. `@file` mentions stay inline in the prompt text where they were typed, and the file is still attached as today.
4. The phone gets an `@` file menu and its own Appearance options.
5. One PR, desktop and phone. Phone changes are JS only (OTA, no native build).

## Non-goals

- Syncing appearance between desktop and phone. Each device keeps its own settings, like themes today.
- Per-Project or per-Chat appearance.
- Free-form font names or pixel values. The menus are the whole surface.
- Changing the theme picker or Custom theme editor.

## Anti-goals

- Chip editing that loses text: undo, paste, IME (Japanese/Chinese input), history recall and the existing slash/@ menus must keep working. A composer that is prettier but drops a character is a failure.
- Layout shift: changing a size must not leave the composer's auto-height, the terminal or diff gutters misaligned.

## Desktop Appearance screen

Order: Mode, Theme, Custom theme (unchanged), then:

**Typography**
- *Interface font*: menu, default "System (SF Pro)". Curated list, filtered to fonts installed on this Mac (checked with `document.fonts.check` / a width probe). Each row is drawn in its own font, with search (`Select searchable`). Default row marked "default".
- Sizes are per area (Victor, like T3 Code and Paseo), each its own menu with named steps. Settings, dialogs, menus and pills stay at today's size.
  - *Sidebar size*: Small, Default, Large, Larger. Scales sidebar Project and Chat rows (names, second lines, counts, icons) from today's sizes by one step each (about 1 px per step on 12.5 to 13.5 px text). Row heights grow with the text.
  - *Chat size*: Small 12, Default 13, Medium 14, Large 15, Larger 17. Transcript text, user bubbles, Markdown, chips and the composer (including `composerLayout()`'s measuring font).
- *Monospace font*: menu, default "System (SF Mono)". Curated mono list, filtered to installed.
- *Code size*: menu, Small 11, Default 12, Medium 13, Large 14. Applies to code blocks, diffs, FileCode and the terminal (xterm `fontSize`, today 12.5, scales with the same step).
- A live preview card under the group: one paragraph with a skill chip and two file chips, plus a four-line diff, using the current settings. It is the reference image's preview.

Fonts bundled with the app (Victor): Inter, Geist, Geist Mono, JetBrains Mono (OFL, woff2, about 1.5 MB), loaded with `@font-face` so they always appear. The other curated fonts appear only when installed.

Curated lists (my call, edit freely):
- Interface: System, Inter, Geist, IBM Plex Sans, Source Sans 3, Helvetica Neue, Avenir Next, Charter, Iowan Old Style, Atkinson Hyperlegible.
- Monospace: System, JetBrains Mono, Fira Code, Geist Mono, Cascadia Code, IBM Plex Mono, Source Code Pro, Menlo, Monaco, Berkeley Mono, Iosevka.

A saved font that is later uninstalled shows as the default, with the saved value kept.

**Mini window preview** (Victor, 2026-10-19; replaces the preview card). A live schematic of the app at the top of the Typography..Motion groups, sticky while scrolling: sidebar (Project + Chat rows with change counts), chat column (user message with skill + file chips, assistant reply, code block with a diff), pill row and composer. Drawn at real CSS sizes inside a container scaled to about 0.45 of a 1440 px window, so every setting shows faithfully. Hovering a row, opening its menu or changing it highlights the area it affects (outline + dim the rest), held 1.5 s after a change: Sidebar size → sidebar; Chat size → messages + composer; Code size / Monospace font → code + diff; Chat width → chat column with edge markers and the px value; Diff colors → diff lines + counts; Interface font → everything but code. Changing Panel animations plays a panel slide in the preview at the chosen speed.

**Layout**
- *Chat width*: Comfortable (default, today's 768 px), Wide (1024 px), Full (fills the pane with side padding). Plus Custom (Victor, 2026-10-19): a px field appears next to the menu, saved on Enter or blur, clamped to 600-2400 px, starting at 900 px. This is the one number field on the screen, by request. Applies to the transcript column, the pill row and the composer together.

**Diffs**
- *Diff colors*: Red & green (default), Blue & orange, Purple & yellow (both colorblind-safe). Each option shows two dots. Drives `--diff-add*`, `--diff-remove*` and the colors of change counts (`+12 −3`) in the sidebar, canvas, git dialog and changes panel. Light and dark variants per pair, and the setting overrides a Custom theme's add/remove colors (my call). Red & green keeps each theme's own green/red.

**Motion**
- *Panel animations*: Normal (default), Fast (about 0.6x durations), Off (instant). "System" behavior stays: macOS Reduce Motion still forces Off. Covers framer-motion panels and morphs plus CSS transitions that use a duration variable (sidebar slide, PillMorph); hover color fades are left alone (my call).

Implementation shape (builder's call within this): settings live in `AppSettings` (`lib/settings.ts`) and apply as CSS variables on `:root` (`--ui-font`, `--sidebar-size`, `--chat-size`, `--mono-font`, `--code-size`, `--chat-width`, diff colors, `--motion-scale`). Hardcoded `text-[12px]`, `text-[13px]`, `max-w-3xl` and literal durations move to those variables. Framer-motion durations read a shared scale (a `MotionConfig` at the root or a helper in `lib/ease.ts`).

## Chips

**Look** (from the reference): a rounded pill, 1 px tinted border, faint tinted fill, icon then label, same font size as the text, vertically centred on the line.
- Skill chip: accent tint (purple-ish in the reference; uses the theme accent), no icon (Victor, 2026-10-19), label is the skill name title-cased from the slug ("frontend-design" → "Frontend Design"). Hover shows the skill description (today's tooltip).
- File chip: neutral/blue tint, a file-type icon, label is the file name only. Hover shows the relative path. Click opens the file viewer (desktop file link viewer, phone `/file-preview`).
- File-type icons (my call): there is no icon set in the repo. Add a small local map: colored letter badges for common languages (TS, JS, PY, GO, RS, MD, JSON, CSS, HTML, SH, SWIFT, KT) plus Hugeicons for React (`.tsx`/`.jsx`), images, folders, and a generic file fallback. Shared between desktop and phone (data in `packages/shared`, rendered per platform).

**Text format.** The prompt text stays plain text, and that is what the agent receives:
- Skill: `/skill-name` (unchanged).
- File: `@relative/path/to/file.ts`. Paths with spaces are wrapped as `@"path with space.ts"`. The file is also attached to the message (`message.files`) as today, so the agent gets the contents up front.
- A shared parser (`packages/shared`, next to `prompt-skills.mjs`) splits a prompt into text / skill / file parts. Skills must match the skill catalog (as today).
- The text is the source of truth for mentions (my call). In a draft, an `@path` is a chip when the path exists in the Project (checked against the project file search, cached), so chips survive restarts, history recall and drafts coming from the phone. Deleting the chip deletes the mention. On send, every chip's file is attached; files attached another way (paste, + menu) are attached as today and get no inline text. In a sent message, an `@path` is a chip when it matches one of that message's `files`, so a stray `@` in prose never becomes a chip.

**Desktop composer.** Replace the textarea + `PromptHighlights` overlay with a `contenteditable` editor that holds chips as atomic, non-editable inline nodes. Requirements the builder must keep:
- The draft is still the plain-text string above (`draft` / `onDraftChange` props unchanged); the editor serializes and parses it. Draft store, queued messages, history and the phone see the same string.
- Caret and selection map to string offsets so the `/` and `@` menus, `pick()`, history recall (first/last line), Enter-to-send, Shift+Enter, IME (`isComposing`) and Escape behave as now.
- Backspace next to a chip deletes the whole chip. Arrow keys step over it.
- Paste inserts plain text (rich HTML stripped); image/file paste still goes to `usePastedImages`. Copying a selection with chips copies the plain text.
- Undo/redo covers typing and chip insertion (native undo on the contenteditable, or a small own stack if native breaks on programmatic edits).
- Auto-height up to the existing cap, placeholder, disabled/offline states.
- Whether to hand-roll it or use a small library (Lexical) is the builder's call; Lexical is the fallback if hand-rolled undo/IME gets shaky.

**Sent messages.** Desktop `UserBody` (`ChatComposer.tsx`) and the phone user bubble (`chat-reply.tsx`) render chips inline from the shared parser. A file that appears as an inline chip is not shown again as a separate attachment tile; files attached without a mention (paste, + menu) keep their tile.

**Phone composer** (`prompt-field.tsx`): skills and files get a tinted background and accent color inside the TextInput (no icon or padding, a TextInput limit). Editing a token so it no longer matches just drops the tint (my call); the phone uses the same shared parser and quoted-path form. New `@` menu: typing `@` lists project files (same daemon call desktop uses through `useProjectFiles`), picking inserts `@path ` and attaches the file.

## Phone Appearance

New groups on `app/appearance.tsx`, stored in `PhoneThemeSettings` (SecureStore, per phone):
- *Text size*: Small, Default, Large, Larger (scales chat text 15 → 14/15/17/19 and Markdown).
- *Code size*: Small, Default, Large.
- *Diff colors*: same three pairs as desktop, applied everywhere the phone shows diffs or `+12 −3` counts (my call).
- *Animations*: Normal, Fast, Off. In-app Reanimated animations only; navigation push/sheet transitions stay native (my call).
- No font family on the phone (listing iOS fonts needs native code) and no chat width.

## Testing and QA

- Unit: the shared prompt parser (skills, files, quoted paths, code spans ignored, unknown `@` left as text), the font-size and diff-color resolvers, settings load/defaults.
- Desktop composer: an Electron check covering type, `/` pick, `@` pick, backspace over a chip, paste, undo, history recall, IME composition, send.
- Real-app screenshots for the PR (dev app, real provider), desktop Appearance at each width and size, and the phone on a simulator.

## Left to the builder

- Exact chip padding, radius and tint values (match the reference).
- Whether settings apply via one `applyAppearance()` next to `applyPalette` or inside it.
- Splitting the work into commits.
