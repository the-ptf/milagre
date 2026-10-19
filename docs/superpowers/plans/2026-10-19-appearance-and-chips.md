# Appearance options and skill/file chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menu-only Appearance options (fonts, per-area sizes, chat width, diff colors, motion) on desktop and phone, and inline skill/file chips in the composer and sent messages.

**Architecture:** Option tables and the prompt parser live in `packages/shared` so desktop and phone agree. Desktop applies settings as CSS variables on `:root` next to `applyPalette`; the phone keeps its own copy in `PhoneThemeSettings`. The desktop composer's textarea becomes a `contenteditable` editor whose value is still the plain-text draft; chips are parsed from that text.

**Tech Stack:** React 19 + Tailwind v4 (Electron), Expo / React Native, `node:test`, Electron checks in `scripts/test-*.cjs`, `@fontsource-variable/{inter,geist,geist-mono,jetbrains-mono}` for bundled fonts.

**Spec:** `docs/superpowers/specs/2026-10-19-appearance-and-chips-design.md`

## Global Constraints

- Every Appearance control is a menu (`Select` on desktop, the phone's existing option list); no number fields, no free-form font names.
- Prompt text format: skill `/skill-name`; file `@relative/path`, quoted `@"path with space.ts"` when the path has whitespace.
- Desktop size steps: Sidebar Small / Default / Large / Larger (−1, 0, +1, +2 px from today's sizes); Chat Small 12, Default 13, Medium 14, Large 15, Larger 17; Code Small 11, Default 12, Medium 13, Large 14.
- Chat width: Comfortable 768 px (default), Wide 1024 px, Full (pane width, side padding kept).
- Diff pairs: `red-green` (default, theme's own colors), `blue-orange`, `purple-yellow`; light and dark values each; overrides Custom theme colors.
- Motion: `normal` (1), `fast` (0.6), `off` (0). macOS Reduce Motion still forces off.
- Phone: Text size Small 14 / Default 15 / Large 17 / Larger 19; Code size Small / Default / Large; same diff pairs; Animations normal/fast/off for Reanimated only.
- Phone changes are JS only (no native module, no fingerprint change).
- No Claude attribution in commits or the PR. PR screenshots from the real app, on the orphan `screenshots` branch.

## Review Focus

1. A draft restored after restart or recalled from history with `@src/a.ts` must still show a chip once file search confirms it, and plain text if the file is gone. Test in Task 7.
2. IME composition (Japanese input) in the composer must not split or duplicate characters, and Enter during composition must not send. Test in Task 7.
3. Pasting rich HTML (from a browser) must insert plain text only. Test in Task 7.
4. A saved font that is no longer installed (or a bundled font missing) falls back to System without throwing. Test in Task 2.
5. An `@` in prose (`email me@host.com`, `@team`) never becomes a chip in sent messages. Test in Task 1.

---

### Task 1: Shared prompt parts parser and file icons

**Files:**
- Create: `packages/shared/src/prompt-parts.mjs`, `packages/shared/src/prompt-parts.d.mts`, `packages/shared/src/prompt-parts.test.ts`
- Create: `packages/shared/src/file-kinds.mjs`, `packages/shared/src/file-kinds.d.mts`, `packages/shared/src/file-kinds.test.ts`
- Modify: `packages/shared/package.json` (exports `./prompt-parts`, `./file-kinds`)

**Interfaces:**
- Produces:
  - `type PromptPart = { kind: "text"; text: string } | { kind: "skill"; text: string; name: string } | { kind: "file"; text: string; path: string }`
  - `promptParts(prompt: string, opts: { skills: string[]; files: (path: string) => boolean }): PromptPart[]`. Concatenated `text` equals `prompt`. Skills follow `promptSkillParts` rules (reuse it). File tokens: `@path` or `@"quoted path"` at start or after whitespace, outside code spans/fences, counted only when `files(path)` is true.
  - `formatFileMention(path: string): string` → `@path` or `@"path"`.
  - `fileMentionQuery(prompt, caret)` is not needed; desktop keeps `promptToken`.
  - `skillLabel(name: string): string` → `"frontend-design"` → `"Frontend Design"`, `"plugin:review-code"` → `"Review Code"`.
  - `fileKind(path: string): { badge: string | null; icon: "react" | "image" | "folder" | "file" | null; color: string }`. Badge letters for ts, js, py, go, rs, md, json, css, html, sh, swift, kt; `react` for tsx/jsx; `image` for png/jpg/jpeg/gif/webp/svg; `folder` for a trailing `/`; else `file`.

- [ ] **Step 1: Write failing tests** in `prompt-parts.test.ts`:
  - `"Use /frontend-design to fix @src/surface.test.ts now"` with skills `["frontend-design"]`, files `{src/surface.test.ts}` → kinds `["text","skill","text","file","text"]`, file `path === "src/surface.test.ts"`, join equals input.
  - `'see @"my app/a b.ts".'` → file path `"my app/a b.ts"`, trailing `"."` is text.
  - `"email me@host.com and @team"` with files always true → only text parts (mid-word `@` and unknown files never parse; `@team` excluded when `files` returns false).
  - `` "`@src/a.ts`" `` → text only (code span).
  - `formatFileMention("a b.ts") === '@"a b.ts"'`, `formatFileMention("a.ts") === "@a.ts"`.
  - `skillLabel` cases above. `fileKind("x.tsx").icon === "react"`, `fileKind("x.ts").badge === "TS"`, `fileKind("dir/").icon === "folder"`.
- [ ] **Step 2:** Run `node --test packages/shared/src/prompt-parts.test.ts packages/shared/src/file-kinds.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement both modules and the `.d.mts` types; add exports.
- [ ] **Step 4:** Rerun. Expected: PASS. Also `npm run typecheck --workspace @milagre/shared`.
- [ ] **Step 5:** Commit `feat(shared): prompt parts parser and file kinds`.

### Task 2: Shared appearance options

**Files:**
- Create: `packages/shared/src/appearance.mjs`, `.d.mts`, `appearance.test.ts`; export `./appearance`

**Interfaces:**
- Produces:
  - `type SizeStep = "small" | "default" | "medium" | "large" | "larger"`, `type ChatWidth = "comfortable" | "wide" | "full"`, `type DiffColors = "red-green" | "blue-orange" | "purple-yellow"`, `type MotionSpeed = "normal" | "fast" | "off"`.
  - `type Appearance = { uiFont: string; monoFont: string; sidebarSize: SizeStep; chatSize: SizeStep; codeSize: SizeStep; chatWidth: ChatWidth; diffColors: DiffColors; motion: MotionSpeed }` and `DEFAULT_APPEARANCE` (fonts `"system"`, sizes `"default"`, `comfortable`, `red-green`, `normal`).
  - `parseAppearance(raw: unknown): Appearance` (unknown or bad fields → defaults, kept fields untouched).
  - Option tables with labels: `SIDEBAR_SIZES` (small/default/large/larger with px delta −1/0/1/2), `CHAT_SIZES` (12/13/14/15/17), `CODE_SIZES` (small 11, default 12, medium 13, large 14), `CHAT_WIDTHS` (768, 1024, null), `DIFF_PAIRS` (`{ id, label, light: {add, remove}, dark: {add, remove} }`; red-green has `null` colors = theme's own), `MOTION_SPEEDS` (1, 0.6, 0).
  - `UI_FONTS`, `MONO_FONTS`: `{ id, label, stack: string, bundled: boolean }[]`, curated lists from the spec, `system` first; bundled = Inter, Geist (ui), Geist Mono, JetBrains Mono (mono).
  - `fontStack(list, id, installed: (family: string) => boolean): string` → the stack, or the `system` stack when the id is unknown or neither bundled nor installed.
  - Phone tables: `PHONE_TEXT_SIZES` (small 14, default 15, large 17, larger 19), `PHONE_CODE_SIZES` (small 11, default 12, large 14).
- [ ] **Step 1:** Failing tests: `parseAppearance({chatSize: "huge", motion: "fast"})` → `chatSize "default"`, `motion "fast"`; `parseAppearance(null)` equals defaults; `fontStack(UI_FONTS, "berkeley", () => false)` equals the system stack; `fontStack(MONO_FONTS, "jetbrains-mono", () => false)` contains `"JetBrains Mono"` (bundled); `fontStack(UI_FONTS, "charter", () => true)` contains `"Charter"`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS. **Step 5:** Commit `feat(shared): appearance option tables`.

### Task 3: Desktop settings, CSS variables and bundled fonts

**Files:**
- Modify: `apps/desktop/app/src/lib/settings.ts` (add `appearance: Appearance` to `AppSettings`, `DEFAULTS`, `load()` via `parseAppearance`)
- Create: `apps/desktop/app/src/lib/appearance.ts`, `appearance.test.ts`
- Modify: `apps/desktop/app/src/styles.css` (`--font-sans`, `--font-mono` read `--ui-font` / `--mono-font`; new vars), `apps/desktop/app/src/main.tsx` or the root that imports styles (import the four `@fontsource-variable/*` CSS files), `apps/desktop/package.json`
- Modify: `apps/desktop/app/renderer-csp.mjs` only if font loading needs `font-src` (check it; fontsource files are bundled, `'self'`).

**Interfaces:**
- Consumes: Task 2.
- Produces: `appearanceVars(a: Appearance, dark: boolean, installed: (f: string) => boolean): Record<string, string>` returning `--ui-font`, `--mono-font`, `--sidebar-delta` (px), `--chat-size`, `--code-size`, `--chat-width` (`768px` / `1024px` / `none`), `--motion-scale`, and for non-default diff pairs `--diff-add-color`, `--diff-remove-color` plus the tint vars derived as 14% / 28% alpha (`color-mix`). `applyAppearance(a: Appearance)` writes them to `document.documentElement.style` and is called wherever `applyPalette` runs on settings change and on theme mode change. `isFontInstalled(family: string): boolean` (`document.fonts.check(\`12px "${family}"\`)` plus a canvas width probe against `monospace` and `serif`).
- [ ] **Step 1:** Failing test `appearanceVars` with `{chatSize: "large", chatWidth: "full", diffColors: "blue-orange", motion: "off"}` → `--chat-size: "15px"`, `--chat-width: "none"`, `--motion-scale: "0"`, `--diff-add-color` equals the pair's dark add color when `dark`; red-green emits no diff vars.
- [ ] **Step 2:** Run `node --test apps/desktop/app/src/lib/appearance.test.ts`, expect FAIL.
- [ ] **Step 3:** Implement; install fontsource packages (`npm i -w milagre @fontsource-variable/inter @fontsource-variable/geist @fontsource-variable/geist-mono @fontsource-variable/jetbrains-mono`); default CSS values equal today's (14px body, 13px chat, 12px code, 768px), so nothing changes with defaults.
- [ ] **Step 4:** Tests pass; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(desktop): appearance settings as CSS variables`.

### Task 4: Desktop surfaces read the variables

**Files (modify):**
- Chat size: `components/ChatComposer.tsx` (user bubble 13px at ~:252, assistant Markdown text, `max-w-3xl` at :1109, :1176, :1212 → `max-w-[var(--chat-width)]`, Full keeps `px-6`), `components/markdown/Markdown.tsx`, `components/PromptComposer.tsx` (input 13/14px at :269, `composerLayout()` measuring font at :281 reads `--chat-size`).
- Code size: `components/markdown/CodeBlock.tsx:108,130`, `components/changes/DiffFile.tsx:481`, `components/FileCode.tsx:8`, `lib/terminal-sessions.ts:56-81` (`fontSize` = `--code-size` + 0.5, reapplied to open terminals on change, then fit).
- Sidebar size: `components/sidebar/ChatRow.tsx` and the Project row text/icon sizes → `calc(<today> + var(--sidebar-delta))`.
- Diff colors: `styles.css` `--diff-add*`, `--diff-remove*`, and a `text-diff-add` / `text-diff-remove` utility; replace `text-green`/`text-red` on counts in `sidebar/ChatRow.tsx:357,873`, `CanvasView.tsx:266`, `GitActionsDialog.tsx:164,171,187`, `changes/ChangesPanel.tsx:17-26`, `changes/DiffFile.tsx:46,75,77`, `markdown/CodeBlock.tsx:9,11`.
- Motion: `lib/ease.ts` adds `useMotionScale(): number` (0 when `useReducedMotion()` or setting off) and `scaled(seconds: number, scale: number): number`; wrap the app root in framer's `<MotionConfig transition={...}>` only if it scales cleanly, otherwise apply `scaled` at `motion/morph.ts`, `motion/PillMorph.tsx`, `changes/ChangesPanelSlot.tsx`, `terminal/TerminalSlide.tsx`, `agents/DockSlide.tsx`, `motion/MediaLightbox.tsx`, `motion/PreviewRail.tsx`; CSS `--sidebar-copy-duration` multiplied by `--motion-scale`. Springs at scale 0 become `{ duration: 0 }`.
- Create: `scripts/test-appearance.cjs` (Electron check, registered like the other `test-*.cjs` in `scripts/test.cjs`).

- [ ] **Step 1:** Write `scripts/test-appearance.cjs`: set settings `appearance` in localStorage, reload, and assert computed styles: transcript column `max-width` 1024px for wide and > 1024 for full at a 1600px window; user bubble `font-size` 15px for large; a diff row marker color equals the blue-orange add color; a sidebar chat name grows by 2px for larger; with motion off a side panel opens with `transitionDuration`/framer duration 0 (check `getAnimations()` empty after toggle).
- [ ] **Step 2:** Run `node scripts/test.cjs --electron test-appearance` (or the runner's per-file form), expect FAIL.
- [ ] **Step 3:** Change the files above.
- [ ] **Step 4:** Check passes; `npm run test:unit`, `npm run typecheck`, `npm run lint` clean.
- [ ] **Step 5:** Commit `feat(desktop): sizes, chat width, diff colors and motion follow Appearance`.

### Task 5: Desktop Appearance screen

**Files:**
- Modify: `components/Settings.tsx` (`AppearanceSettings` at :702), `components/primitives/Select.tsx` (optional `SelectOption.style?: CSSProperties` applied to the row label, so each font row draws in its font; trigger shows it too)
- Create: `components/settings/AppearancePreview.tsx`
- Modify: `scripts/test-settings-sections.cjs` (or add cases to `test-appearance.cjs`)

**Interfaces:**
- Consumes: Tasks 2, 3, 6 (`PromptChip` for the preview; build Task 6 first if running in order, or stub-import).
- Groups after Custom theme: **Typography** (Interface font `Select searchable`, Monospace font `Select searchable`, Sidebar size, Chat size, Code size), **Layout** (Chat width), **Diffs** (Diff colors with two-dot `icon`), **Motion** (Panel animations). Copy:
  - Interface font: "Used across the app."; Monospace font: "Code, diffs and the terminal."
  - Sidebar size: "Project and chat names in the sidebar."; Chat size: "Messages and the composer."; Code size: "Code blocks, diffs and the terminal."
  - Chat width: "How wide messages and the composer grow on large screens."
  - Diff colors: "Additions and deletions, including change counts."
  - Panel animations: "How fast panels open and close. macOS Reduce Motion turns them off."
  - Font options list only fonts where `isFontInstalled` or `bundled`; the default row's `description` is `"default"`.
- `AppearancePreview`: the sentence `Use [Frontend Design] to fix the flaky test in [surface.test.ts] and align the header with [SettingsPanels.tsx] before shipping.` plus the four-line diff from the spec reference, at current settings.
- [ ] **Step 1:** Electron check: open Settings › Appearance, choose Chat size "Large" in the menu, assert `localStorage` `milagre-settings.appearance.chatSize === "large"` and the preview paragraph is 15px; open Interface font, type "inter", assert a row "Inter" whose computed font-family starts with `"Inter`; assert no `input[type=number]` on the page.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** PASS + `no-native-select.test.ts` still passes. **Step 5:** Commit `feat(desktop): Appearance typography, layout, diff and motion menus`.

### Task 6: Desktop chips in sent messages

**Files:**
- Create: `components/PromptChip.tsx` (`SkillChip({ name, description? })`, `FileChip({ path, onOpen? })`, `FileKindIcon({ path })` from `fileKind`), `components/PromptText.tsx` (`PromptText({ text, skills, files, onOpenFile })` renders `promptParts` with chips, `whitespace-pre-wrap`)
- Modify: `components/ChatComposer.tsx` `UserBody` (:103-117) uses `PromptText` with `files: (p) => message.files` match (relative to the worktree root, or absolute equal); attachment tiles (`Attachments.tsx`) skip files rendered as inline chips.

Chip style: `inline-flex items-center gap-1 rounded-[6px] border px-1.5 align-[-0.15em] leading-[1.35]`, skill `border-accent/40 bg-accent-tint text-accent-ink`, file `border-line-strong bg-hover text-ink`; icon 0.95em; label font-size inherits.
- [ ] **Step 1:** Unit test `PromptText` via `react-dom/server` `renderToStaticMarkup` (as other component tests do, check `apps/desktop/app/src/components/**/*.test.tsx` for the pattern): `"fix @src/a.ts"` with files `["src/a.ts"]` renders one `[data-chip="file"]` with text `a.ts` and `title="src/a.ts"`; with files `[]` renders no chip.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; extend `scripts/test-chat-attachments.cjs`: a sent message with an inline mention shows the chip and no duplicate tile; a file attached via + still shows its tile. **Step 5:** Commit `feat(desktop): skill and file chips in sent messages`.

### Task 7: Desktop chip composer

**Files:**
- Create: `apps/desktop/app/src/lib/editor-model.ts`, `editor-model.test.ts` (pure: parts ↔ DOM-independent model, offset mapping)
- Create: `apps/desktop/app/src/components/PromptEditor.tsx`
- Modify: `components/PromptComposer.tsx` (textarea at ~:630-660 and every API listed below), delete `components/PromptHighlights.tsx` and its usage
- Modify: `lib/file-mentions.ts` (`insertPromptToken` callers pass `formatFileMention(path)`)
- Create: `scripts/test-composer-chips.cjs`

**Interfaces:**
- `PromptEditor` props: `{ value: string; onChange(value: string, caret: number): void; parts: PromptPart[]; placeholder: string; disabled: boolean; maxHeight: number; onKeyDown(e: KeyboardEvent<HTMLDivElement>): void; onPaste(e: ClipboardEvent<HTMLDivElement>): void; onSelect(caret: number): void; skillDescriptions: ReadonlyMap<string, string> }` and a ref handle `PromptEditorHandle = { focus(): void; setSelection(start: number, end?: number): void; getSelection(): { start: number; end: number }; isCaretOnFirstLine(): boolean; isCaretOnLastLine(): boolean }`.
- `editor-model.ts`: `domOffsetToText(root: Node, node: Node, offset: number): number` and `textOffsetToDom(root: Node, offset: number): { node: Node; offset: number }`. Chips are `<span contenteditable="false" data-chip data-text="/frontend-design">`, counted as their `data-text` length; `<br>` and block boundaries count as `\n`.
- Behavior: render from `parts` on every `value` change, preserving the caret via the offset mapping; typing goes through `beforeinput` (`insertText`, `insertLineBreak`, `deleteContentBackward/Forward`, `insertFromPaste`, `historyUndo/Redo`) handled against the string and re-rendered, so the DOM never diverges. Undo: own stack of `{ value, caret }`, coalescing typing within 500 ms, one entry per chip insert/delete; ⌘Z / ⌘⇧Z. IME: while `isComposing`, let the browser edit, then on `compositionend` read the text back and commit once. Backspace/Delete adjacent to a chip removes the whole `data-text`. Paste: `text/plain` only; images/files still go to `usePastedImages.onPaste` (call it first; if it `preventDefault`s, stop). Copy/cut: write `text/plain` of the selected string range.
- `PromptComposer` changes: `caret` from `onSelect`; `recall()` uses the handle's first/last-line checks and `setSelection`; @ pick now inserts `formatFileMention(path)` via `insertPromptToken` and keeps `attachPath(absPath)`; on send, attach every file chip's path not already attached; deleting a chip whose file was attached only through a mention detaches it. Chips in the draft use `files: (p) => known.has(p)`, where `known` is filled by `searchProjectFiles(root, p)` results that contain `p` exactly (cache per root, look up mentions that are not known yet, debounce 100 ms).
- [ ] **Step 1:** Unit tests for `editor-model.ts` with jsdom-free fake nodes or `linkedom` if already a dev dep (check; else build a minimal DOM in the Electron check instead): offsets around a chip (`"a /x b"` with a chip for `/x`: text offset 4 maps to after the chip), across `\n`.
- [ ] **Step 2:** `scripts/test-composer-chips.cjs` (fake bridge like `test-chat-attachments.cjs:48`): type `use /tl`, pick `tldr` → one skill chip, draft `"use /tldr "`; type `@my`, pick `src/my app.ts` → file chip, draft contains `@"src/my app.ts"`, one attachment; Backspace after the chip removes it and the attachment; ⌘Z restores both; paste `text/html` `<b>hi</b>` → draft gets `hi`; IME: dispatch `compositionstart`/`compositionupdate`/`compositionend` with `"日本"` → draft gains `日本` once and Enter during composition doesn't send; ArrowUp on the first line recalls history; reload with a saved draft `fix @src/model.ts` → chip appears after search; Enter sends and the sent message shows the chip.
- [ ] **Step 3:** Run both, FAIL. **Step 4:** Implement. **Step 5:** Run both plus `test-chat-drafts.cjs`, `test-chat-attachments.cjs`, `test-chat-send-feedback.cjs`, `test-command-palette.cjs` (they drive the composer; update their textarea selectors to `[data-prompt-editor]`). All PASS. **Step 6:** Commit `feat(desktop): chip composer for skills and files`.

### Task 7b: Custom chat width

**Files:**
- Modify: `packages/shared/src/appearance.mjs`, `.d.mts`, `appearance.test.ts` (`ChatWidth` gains `"custom"`; `Appearance` gains `chatWidthPx: number`, default 900; `CHAT_WIDTHS` gains `{ id: "custom", label: "Custom", px: null }`; `clampChatWidth(px: unknown): number` clamps to 600..2400, non-numbers → 900; `parseAppearance` runs it)
- Modify: `apps/desktop/app/src/lib/appearance.ts` + test (`custom` → `--chat-width: "<chatWidthPx>px"`)
- Modify: `apps/desktop/app/src/components/Settings.tsx` (Chat width row: when `custom`, a numeric field with "px" suffix beside the Select, commits on Enter/blur via `clampChatWidth`, shows the clamped value back)
- Test: `scripts/test-settings-sections.cjs` or `scripts/test-appearance.cjs`

- [ ] **Step 1:** Failing tests: `parseAppearance({chatWidth:"custom", chatWidthPx: 5000}).chatWidthPx === 2400`; `clampChatWidth("x") === 900`; `clampChatWidth(300) === 600`; `appearanceVars({...default, chatWidth:"custom", chatWidthPx: 1200}).["--chat-width"] === "1200px"`. Electron: pick Custom, type 1100 + Enter → transcript column max-width 1100px and localStorage `chatWidthPx` 1100; type 99999 + blur → field shows 2400.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + typecheck + lint. **Step 5:** Commit `feat(desktop): custom chat width in px`.

### Task 8: Daemon: file search for the phone

**Files:**
- Modify: `apps/daemon/src/mobile-bridge.cjs` (allow `"project:files"` next to `"skills:list"`), `apps/daemon/src/confine.cjs` (`"project:files": ([root]) => [root]`)
- Test: the existing confine/mobile-bridge test file next to them (find with `ls apps/daemon/src/*.test.*`).
- [ ] **Step 1:** Failing test: a confined phone call `project:files` with an allowed worktree returns files; with a path outside its Projects is refused.
- [ ] **Step 2:** FAIL. **Step 3:** Add both entries. **Step 4:** PASS. **Step 5:** Commit `feat(daemon): phone can search project files`.
- Note for the PR: the phone `@` menu needs a desktop build with this change; on an older Mac the menu shows "Update Milagre on your Mac to mention files." (Task 10 handles the error).

### Task 9: Phone Appearance settings

**Files:**
- Modify: `apps/mobile/src/theme-store.ts` (`PhoneThemeSettings` gains `textSize: "small"|"default"|"large"|"larger"`, `codeSize: "small"|"default"|"large"`, `diffColors: DiffColors`, `motion: MotionSpeed`; parse with defaults), its test
- Modify: `apps/mobile/src/appearance-section.tsx` (groups Text size, Code size, Diff colors, Animations using the existing row/option pattern used by Mode or the theme list; menus, not sliders)
- Modify: `apps/mobile/src/theme.ts` (expose `typeScale`, `codeSize`, `diff: {add, remove}` and `motionScale` on the theme hook), chat text sites (`chat-reply.tsx` user bubble 15/22, Markdown renderer), code/diff sites (find with `git grep -n "fontFamily: .*mono\|Menlo" apps/mobile/src`), counts (`git grep -n "colors.green\|colors.red" apps/mobile/src`), Reanimated durations (`git grep -n "withTiming\|withSpring" apps/mobile/src`, multiply duration by `motionScale`, scale 0 → set value directly).
- [ ] **Step 1:** Failing test in `theme-store` test: old saved JSON without new fields parses to defaults; `{textSize: "huge"}` → `"default"`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `npm run typecheck:mobile`; `scripts/mobile-ui.test.cjs` if it covers appearance. **Step 5:** Commit `feat(mobile): text size, code size, diff colors and animations`.

### Task 10: Phone chips, tinted composer, @ menu

**Files:**
- Create: `apps/mobile/src/prompt-chip.tsx` (`SkillChip`, `FileChip` inline in Text, using `fileKind` badges; Hugeicons for react/image/folder/file)
- Modify: `apps/mobile/src/chat-reply.tsx:299-334` (user bubble renders `promptParts` with chips; files rendered inline skip their `FileChip` tile), `apps/mobile/src/prompt-field.tsx` (tint file mentions like skills: `backgroundColor` = tint, `color` = accentInk; `@` menu listing `project:files` results above the field like the `/` menu; pick inserts `formatFileMention(path) + " "` and appends an `Attachment` with `path` (absolute = worktree root + relative, as desktop's `fileMentionPath`), respecting `MAX_ATTACHMENTS`), `apps/mobile/src/app/chat.tsx` if attachments state lives there
- Test: `apps/mobile/src/attachments.test.ts` (mention attach helper), a pure helper `mentionAttachment(root: string, path: string): Attachment` in `attachments.ts`
- [ ] **Step 1:** Failing tests: `mentionAttachment("/w", "src/a.ts")` → `{ name: "a.ts", path: "/w/src/a.ts" }`; refuses `../x`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `project:files` error → menu row "Update Milagre on your Mac to mention files." **Step 4:** PASS; typecheck mobile; run the app on a slim simulator (`simslim list`, `simslim on <udid> --except widgets,icloud,web`) against a real desktop host (memory: desktop-phone shared daemon QA recipe), check: `/` and `@` tint, `@` pick attaches, sent message shows chips, Text size Large grows the bubble. **Step 5:** Commit `feat(mobile): skill and file chips and @ file menu`.

### Task 11: QA, screenshots, PR

- [ ] **Step 1:** `npm run test`, `npm run typecheck`, `npm run typecheck:mobile`, `npm run lint`. All green.
- [ ] **Step 2:** Screenshots from the dev app with a real provider: Appearance (each group, font menu open), composer with chips, sent message with chips, Wide and Full widths, blue-orange diff; phone Appearance and a chat with chips. Push them to the orphan `screenshots` branch.
- [ ] **Step 3:** Open the PR (no attribution). Note: phone OTA after merge needs the desktop build with Task 8 for the `@` menu; everything else works on today's desktop.
