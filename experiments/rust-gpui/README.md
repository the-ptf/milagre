# milagre-gpui-spike (experiment)

Can Milagre's desktop UI be built in [GPUI](https://gpui.rs), Zed's Rust UI framework? This crate is step 1 of 4: a
window with the three-column shell (design A, "integrated sidebar") drawn with the real theme tokens from
`DESIGN.md`. Standalone crate, fixture data only, not wired to anything.

## Build and run

```sh
cd experiments/rust-gpui
cargo build                    # debug binary: target/debug/milagre-gpui-spike
cargo run                      # opens the 1440x900 window, dark theme
MILAGRE_GPUI_THEME=light cargo run
cargo test                     # token test + interaction tests in GPUI's headless test platform
cargo clippy --all-targets -- -D warnings
```

`MILAGRE_GPUI_SNAPSHOT=/tmp/shell.png cargo run` draws the window, saves it as a PNG and quits on its own. It exists
because `screencapture -l` needs the Screen Recording permission for whatever launched it, while a process may
capture its own windows without it (`src/snapshot.rs`). The window is not activated in this mode, so the traffic
lights come out grey.

Needs Xcode's command line tools (for `bindgen`'s libclang). It does **not** need the Metal Toolchain: see below.

## GPUI version

`gpui = "=0.2.2"` from crates.io, with the `runtime_shaders` feature.

- 0.2.2 is the newest release the Zed team has published to crates.io (2025-10-22, owners `zed-industries`). It
  built on rustc 1.99.1 / macOS arm64 with no patches, and the examples shipped inside the crate match its API, so
  that is what this crate is written against. The brief preferred the official crates.io release if it works; it
  does.
- It is old. Zed has moved on for about 13 months since. Newer GPUI comes only as a git dependency on
  `zed-industries/zed` pinned to a rev (clones the whole Zed repository), or as third-party snapshots: `gpui-pre`
  (0.3.12, 2026-11-09, "snapshot of zed@d2a4fb6", published by the gpui-component author) and the `gpui-ce` community
  fork. Upstream has since split platform code into separate crates, so moving later is real API churn, not a
  version bump.
- `runtime_shaders`: GPUI's build script otherwise runs `xcrun metal` to precompile its shaders, and since Xcode 26 the
  Metal Toolchain is a separate download that is not installed on this Mac (`xcrun metal` says "missing Metal
  Toolchain; use: xcodebuild -downloadComponent MetalToolchain"). With the feature, the shader source is compiled when
  the app starts. The cost of that at launch was not measured.

### gpui-component

Not added. Worth a look later for inputs, menus, scroll areas and a virtual list with variable heights, but it ties
the GPUI choice: gpui-component 0.5.1 (2026-02) is the last release on crates.io `gpui ^0.2.2`; 0.6 onward pins
`gpui-pre` snapshots (0.9.1 needs `gpui-pre =0.3.12`). Adopting a current gpui-component means adopting its GPUI
snapshot too.

## Layout

| File               | What                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `src/main.rs`      | `Application`, the Quit action and menu, `WindowOptions`, theme global, snapshot mode     |
| `src/lib.rs`       | Module list; everything but startup is in the library so tests can mount it               |
| `src/theme.rs`     | `Theme` (`dark()`, `light()`) as a GPUI global, `ActiveTheme`, type scale, radii, heights |
| `src/workspace.rs` | Root view: three column entities and the 1px hairlines between them                       |
| `src/sidebar.rs`   | Sidebar (304px, `canvas`): traffic-light header, `uniform_list` of 8 fixture Chat rows    |
| `src/chat.rs`      | Chat column (flex, `page`): header, empty transcript area, composer placeholder           |
| `src/panel.rs`     | Side panel (518px, `canvas`): six text tabs that switch on click, a `line` rule, a body   |
| `src/chrome.rs`    | `header(id)`: the 44px header every column uses as the window title bar                   |
| `src/snapshot.rs`  | macOS self-capture to PNG                                                                 |
| `src/tests.rs`     | Clicks a tab and a row through GPUI's test window; checks column and row geometry         |

Seams for the next steps: the Chat list is `Sidebar::render_rows` (swap `fixture_rows` for real data; nav rows go
above the `uniform_list`), the transcript goes in the `"transcript"` div in `chat.rs`, and each panel tab's content in
the `"panel-body"` div in `panel.rs`. Each column is its own `Entity` with its own `Render`, so `cx.notify()` in one
re-renders only that one.

## Results (2026-11-11, Apple M5 Pro, 18 cores)

- Cold `cargo build` (after `cargo clean`, crates already downloaded): 20.7 s wall, 180 s CPU, 451 crates.
  Incremental rebuild after editing one view: 1.5 s. `cargo test` compile from warm deps: 13.6 s (the
  `test-support` feature builds a second GPUI variant).
- Debug binary 30.7 MB, release binary 5.9 MB (not stripped). `target/` is 2.4 GB after one debug build.
- No warnings from this crate; clippy clean with `-D warnings`. The only warning is cargo's future-incompatibility
  note about two dependencies (`block 0.1.6`, `proc-macro-error2 2.0.1`).
- Tests: 6 pass. `dark_theme_matches_design_md` checks 27 dark tokens against hand-copied DESIGN.md values;
  `clicking_a_panel_tab_makes_it_active` and `clicking_a_chat_row_selects_it` click through `simulate_click`;
  `columns_have_their_fixed_widths` checks where rows and tabs land.
- Screenshot pixels: sidebar 0–304pt, hairlines at 304 and 921, panel from 922, tab rule at 44, composer bottom edge
  24 from the window bottom, traffic lights centred at 21.75 in the 44px header.

## What was easy

- It built and drew on the first compile. `div()` styling reads like Tailwind (`h`, `px`, `rounded`, `bg`,
  `border_1`, `border_color`, `truncate`), so DESIGN.md values map one to one, and `px()` is `const`, so radii and
  heights can be `const` tokens.
- A theme is a struct with `impl Global`, set once with `cx.set_global` and read in any render with
  `cx.global::<Theme>()` (wrapped as `cx.theme()`). Colours are `Rgba`; translucent tokens keep their alpha.
- One entity per column with its own `Render` gives independent re-renders for free.
- `uniform_list` is a ready virtualized list for fixed-height rows (Milagre's 48px two-line rows), and click
  handlers inside it work like anywhere else.
- System UI font, 500/600 weights, 13/18 and 12/16 line heights all render crisply and match the Electron metrics.
- The headless test platform is the best surprise: mount the real view, find elements by `debug_selector`, click
  them, assert state and pixel bounds, in milliseconds and without a screen.
- Debug build cycle is fast: 1.5 s incremental.

## What was awkward

- The crates.io release is a year old, and newer GPUI is a git rev of the whole Zed repo or someone else's snapshot.
  This is the biggest long-term question for a real port.
- The default build needs Xcode's Metal Toolchain, which is no longer installed with Xcode; `runtime_shaders` works
  around it.
- Window dragging on macOS: GPUI 0.2.2 has no macOS `start_window_move`, so only AppKit's native title-bar strip
  (the top ~28px) drags the window; the lower 16px of the 44px headers do not. `WindowControlArea::Drag` only feeds
  the Windows hit test. Double-click to zoom is wired through `titlebar_double_click`. **Not tested by hand**: nobody
  was at the Mac to drag the window.
- `traffic_light_position.y` is the button frame's top, measured inside the native title bar. y 16 (Electron's value)
  put the lights 0.75pt low; 15 centres them. Found by measuring the screenshot.
- Colour management, from reading the source and the captured pixels: GPUI 0.2.2 never sets a colour space on its
  `CAMetalLayer`, and the raw window pixels equal the token hex values within ±2. So sRGB hex values are shown as the
  display's native colours instead of being converted the way Chromium does. Neutral surfaces barely change; on a P3
  display the saturated accent and status colours should look more vivid than in the Electron app. Fixing it needs a
  GPUI patch. Not compared side by side with Electron.
- Missing styles Milagre uses: no letter-spacing (the 22px title's `-0.02em`), and no backdrop blur on an element
  (DESIGN.md's `backdrop-blur-chip` on the composer, the progressive edge blur); GPUI only blurs shadows and whole
  window backgrounds.
- Edition 2024 return-position `impl Trait` captures every lifetime in scope, so helpers that take `&Theme` and return
  an element need `impl IntoElement + use<>`.
- At the 960px minimum width the Chat column is only 136px wide; the real app needs the panel to collapse. Not a GPUI
  limit, just not built.
- `screencapture` is refused without Screen Recording permission, so screenshots needed the in-process capture in
  `snapshot.rs`, which calls `CGWindowListCreateImage` through `dlsym` because the macOS 15+ SDK obsoletes it. It may
  stop working on a future macOS.

## Sidebar notes

- `src/sidebar.rs` is the full 304px sidebar: header with three icon buttons (x 208, 240, 272), Canvas / Routines / Links,
  an "All Chats" label, a `uniform_list` of 500 fixture Chats (`src/fixtures.rs`), and a pinned Done row, usage block and footer.
- Icons are stroked vector paths (`PathBuilder` painted in a `canvas`), not SVG files: `svg()` needs an `AssetSource` set with
  `Application::with_assets`, which is in `main.rs`. Strokes have butt caps (GPUI does not re-export lyon's `LineCap`).
  The running mark is a static arc (no spinner), "needs approval" is a ring, question and failed are "?" and "!" text.
- Keyboard: the sidebar has a `FocusHandle` (`track_focus`, `key_context("Sidebar")`) and `on_key_down`; Up/Down move the
  selection and call `UniformListScrollHandle::scroll_to_item` (only Top/Center/Bottom exist, no "nearest", so the sidebar
  uses the last built range to pick Top or Bottom). Nothing focuses the sidebar at startup; a click does.
- Virtualization: each frame builds only the visible rows (about 19 at 900px high) out of 500 (`sidebar_tests.rs`).

## Panel tabs notes

- The panel header (`src/panel.rs`) shows six tabs as icon plus name (Changes with a "4" count, Terminal, Browser, Designs, Artifact, PR)
  in a list that scrolls horizontally; expand and close (24px buttons, 16px glyphs) are pinned at the right, outside the list.
- Scrolling is GPUI's own: `overflow_x_scroll()` plus `track_scroll(&ScrollHandle)` on the list. A mouse wheel, a trackpad swipe and
  shift+wheel move it (the wheel scroll is exercised in `panel_tests.rs`); there is no scrollbar. Clicking a tab calls
  `ScrollHandle::scroll_to_item(ix)`, which scrolls the minimum needed to show the tab fully on the next frame. Tabs must be direct children
  of the scroll div for that to work.
- Icons are Lucide-style strokes on a 24 grid (`src/icons.rs`), painted with `PathBuilder` at 14px / 1.8px stroke (tabs) and 16px / 1.5px (buttons).
- At 518px the PR tab is mostly clipped at rest, as intended. A clipped tab is not clickable where it is clipped, so `tests.rs` clicks Artifact
  instead of PR; `panel_tests.rs` scrolls the list with the wheel first, then clicks PR.

## Usage block notes

- The usage block (`usage_row` in `src/sidebar.rs`) has three 32px rows: provider logo (16px, x 12), name (x 40), a 12px orange warning
  triangle after "Claude", then per usage window a right-aligned 12px label over a 2px track (`line`) with an `ink3` fill. Two windows
  use 68px meters at x 132 and 208; one window uses one 144px track from x 132 to 276. The block pads 8px top and bottom only, since
  the x positions are relative to the 288px inner area. Fills are at least 2px above 0% and absent at 0%. Data is in `fixtures.rs` (`USAGE`).
- The logos (`ProviderLogo` in `src/icons.rs`) are stand-ins drawn as stroked vector paths (starburst, cloud, arch), not the real marks.

## Transcript notes

The Chat column now holds a real transcript and composer (2026-11-11).

| File                   | Lines (code) | What                                                                                     |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `src/transcript.rs`    | 608 (526)    | `Transcript` entity: items, `list()` + `ListState`, item rows, path glyphs, timing probe |
| `src/composer.rs`      | 830 (710)    | Composer: multi-line text input (~590 code lines) plus the send row (~120)               |
| `src/markdown.rs`      | 455 (393)    | pulldown-cmark events to blocks; blocks to GPUI elements                                 |
| `src/chat.rs`          | 123 (106)    | Header, cached transcript view, floating pills, composer; Send appends a user message    |
| `src/chat_fixtures.rs` | 284 (226)    | The first screen plus ~2,000 generated items (fixed seed), long markdown answers         |
| `src/chat_tests.rs`    | 277 (236)    | 15 headless tests (markdown, list, approvals, typing, keys, paste, IME, link, caching)   |

How it works:

- `list(ListState::new(n, ListAlignment::Bottom, px(600.)), cx.processor(Self::render_item))`. Bottom alignment opens at the
  newest item and stays pinned there while items arrive, unless the reader has scrolled up. Only items in view, plus a 600px
  band above and below that is measured but not painted, are built each frame. Item heights are cached in a sum tree, so a
  change to a measured item has to be reported with `ListState::splice` (`Transcript::resolve` does this for approvals).
- The transcript is drawn as `AnyView::cached`. Without it, any `cx.notify()` in the window (one keystroke in the composer)
  re-renders every view, and the transcript re-lays out all its visible items: 18 item builds per keystroke measured in the
  test, against 0 with the cache. The README's earlier claim that one entity per column re-renders only that column holds only
  with `cached`.
- Markdown is parsed once per message (pulldown-cmark, 2,000 items in 0.6 ms release). A paragraph is one `StyledText` with
  `TextRun`s, so bold, inline code and links wrap together; paragraphs with links are `InteractiveText` with click ranges that
  call `cx.open_url`.
- The composer follows the gpui crate's `examples/input.rs`: the entity implements `EntityInputHandler` (text, selection, IME
  marked range, all in UTF-16 for the platform), and a custom `Element` shapes the text with `shape_text` at the wrap width,
  paints selection rects, lines and the caret, and calls `window.handle_input` so typed text, dead keys and IME reach it.
  Editing keys are actions bound in a `Composer` key context. It grows to 8 lines, then scrolls to keep the caret visible.

Env vars: `MILAGRE_GPUI_TIMING=1` prints the timing probe; `MILAGRE_GPUI_TRANSCRIPT_ITEMS=<n>` sets the fixture size;
`MILAGRE_GPUI_COMPOSER_TEXT` (`\n` for newlines) and `MILAGRE_GPUI_COMPOSER_SELECT=<start>..<end>` prefill the composer for a
snapshot.

Measurements (Apple M5 Pro, release build, `MILAGRE_GPUI_TIMING=1` with `MILAGRE_GPUI_SNAPSHOT` so the window never activates;
three runs). The probe times from the start of `Transcript::render` to the paint of a zero-size canvas drawn last in the
transcript, and counts calls to `render_item`. Launch time is perl's clock just before `exec` against the epoch printed at the
first paint. GPU time and presentation are not included.

| What                                          | Result                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Launch to first transcript paint, 2,000 items | 123, 126 ms warm (380 ms on the first, cold run); 10 items: 120 ms |
| Items built in the first frame                | 26 of 2,000 (in view plus the overdraw band)                       |
| Fixture build and markdown parse              | 0.6 ms (debug 2.5 ms; 20,000 items in debug 23.7 ms)               |
| Append one item at the bottom                 | 1.6 to 3.7 ms render to paint, 13 items built                      |
| Jump 300 items up into never-measured history | 6 to 13 ms, 37 items built                                         |
| One 120px scroll step                         | 1.7 to 2.5 ms, 11 items built                                      |
| Idle 500 ms with the running mark breathing   | 31 frames, 403 items built (13 per frame)                          |
| Typing in the composer                        | 0 transcript items built per keystroke (test platform count)       |

Not measured: GPU frame time, smoothness of a real trackpad scroll, memory, and anything that needs a person at the keyboard.

What was awkward:

- Never-measured items count as 0px. After jumping 300 items up, the list knew a scrollable height of 2,983px for 2,001 items,
  so a scrollbar would be wrong and pixel jumps (`scroll_by`) land short. `ListState::measure_all()` fixes it by laying out
  every item once on open. Wheel scrolling measures as it goes and is fine.
- An animation anywhere in the transcript (the breathing running mark) asks for a frame and marks the transcript view dirty,
  so every visible item is rebuilt every frame (13 per frame here). GPUI marks ancestors of a dirty view dirty too, so moving
  the mark into its own entity does not help; it has to live outside the list. The headless tests keep it still (`cfg(test)`).
- Static text is not selectable in GPUI 0.2.2: no selection, no copy. `StyledText::layout()` maps points to indices, so
  selection inside one paragraph is buildable; selection across paragraphs and list items (some not even laid out) needs a
  transcript-wide selection model, as Zed's own `markdown` crate has (not published on crates.io).
- `TextRun` has a font, colours and decorations but no size, padding or radius: inline code is Menlo at the prose size with a
  square `field` background, not a 4px pill at a smaller size.
- `ui-monospace` (SF Mono) has no family name apps can load (`NSFontManager` lists Andale Mono, Menlo, PT Mono); code uses Menlo.
- A hugging flex container whose children have negative margins measures 0px wide (the activity marks overlapped their text);
  fixed with an explicit width.
- GPUI's test support never clears a frame's debug bounds, so `debug_bounds("x").is_none()` passes only for selectors that
  were never drawn. Tests check state or new selectors instead. The test platform's text system is a no-op with fixed advances.
- Code blocks scroll sideways (`overflow_x_scroll`, `restrict_scroll_to_axis` so vertical wheel deltas stay with the list);
  not tried with a real trackpad.
- IME and dead keys go through `NSTextInputClient` (`setMarkedText`, `insertText`) into the composer's input handler, the same
  path Zed's editor uses. The test drives that handler's methods directly; nobody typed Option+E, A on the real window.
- Not built in the composer: undo, word movement, double-click selection, caret blink, drag and drop, attachments.
