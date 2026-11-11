# milagre-gpui-spike (experiment)

Milagre's desktop UI in [GPUI](https://gpui.rs), Zed's Rust UI framework. It started as a four-step spike (the three-column
shell, the sidebar, the panel tabs, the transcript and composer) and is now the foundation of a full port that runs beside
the Tauri shell. Standalone crate, fixture data only, not wired to the daemon yet.

- `CONVENTIONS.md`: module layout, how to add a view, an icon or a test, the rules for parallel agents, the checks.
- `PORT-MAP.md`: what of the Electron app is ported, and what is next.
- This file: the GPUI choice and its evidence, what each piece does, what was measured, what is still open.

## Build and run

```sh
cd experiments/rust-gpui
cargo build                    # debug binary: target/debug/milagre-gpui-spike
cargo run                      # opens the 1440x900 window, dark theme
MILAGRE_GPUI_THEME=light cargo run
cargo test                     # tokens, primitives, data, and the views in GPUI's headless test platform
cargo clippy --all-targets -- -D warnings
```

`MILAGRE_GPUI_SNAPSHOT=/tmp/shell.png cargo run` draws the window, saves it as a PNG and quits on its own. It exists
because `screencapture -l` needs the Screen Recording permission for whatever launched it, while a process may
capture its own windows without it (`src/snapshot.rs`). The window is not activated in this mode, so the traffic
lights come out grey, and AppKit may report it occluded, after which gpui-pre draws no more frames (it stops an
occluded window's display link): snapshot mode waits for the provider logos to decode before it opens the window, and
an animation or a later change never shows in a snapshot.

Needs Xcode's command line tools (for `bindgen`'s libclang). It does **not** need the Metal Toolchain (`runtime_shaders`).
`node tools/gen-icons.mjs` (run by hand when icons change) needs the repository's `node_modules`.

## GPUI version decision

**Decision (2026-11-11): `gpui-pre =0.3.12` (GPUI itself) with `gpui-pre-platform` (`font-kit`, `runtime_shaders`), plus
`gpui-component =0.9.1` made available.** Imported under upstream's crate names (`gpui`, `gpui_platform`), so the fallback,
a pinned `zed-industries/zed` git rev, is a `Cargo.toml` change with no code change.

Why: `gpui-pre` is not a fork. Each release is a snapshot of Zed's own `gpui*` crates at one commit, published to
crates.io; 0.3.12 is zed@d2a4fb6 (2026-11-08). Diffing it against that commit: `gpui_macos`, `gpui_apple` and
`gpui_platform` are identical, and `gpui` differs in one file (`action.rs`: the `actions!` macro says `$crate::Action`
instead of `gpui::Action`, needed for the renamed package). So we get upstream GPUI, the code Zed ships, without
cloning the Zed repository, and the component library with the most users is built against exactly these snapshots.
Staying on 0.2.2 keeps us on a year-old API with no macOS window move, no accessibility and no future. `gpui-ce` has
real extras (backdrop blur, letter-spacing) but diverges from upstream with one crates.io owner and few users.

Evidence. Hello-world window per option, cold `cargo build` (debug, crates already downloaded, Apple M5 Pro, rustc
1.99.1, no Metal Toolchain installed), and each gap checked in the source:

|                                         | a. `gpui` 0.2.2                                  | b. zed git rev                                                                                                   | c. `gpui-pre` 0.3.12 (+ gpui-component)                                                                | d. `gpui-ce` 0.3.0                                                   |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Builds here without the Metal Toolchain | yes (`runtime_shaders`)                          | yes (`gpui_platform/runtime_shaders`)                                                                            | yes (same feature)                                                                                     | yes (same feature)                                                   |
| Cold build, crates compiled             | 20.4 s, 451                                      | 17.7 s, 308                                                                                                      | 17.0 s, 310 (31.4 s, 409 with gpui-component)                                                          | 25.7 s, 380                                                          |
| Extra fetch                             | none                                             | first resolve 74 s; 522 MB git db + 671 MB checkouts (Zed, plus git deps wgpu, scap, oo7, font-kit, wasm_thread) | none (crates.io)                                                                                       | none (crates.io)                                                     |
| Selectable static text                  | no                                               | no                                                                                                               | no in GPUI; yes in gpui-component (`SelectableText`, markdown `TextView`, window-wide `TextSelection`) | no                                                                   |
| Per-span size / padding / radius        | no                                               | no (`TextRun` unchanged)                                                                                         | no in GPUI; gpui-component's `TextView` lays inline code out as a padded rounded chip                  | no (adds per-run `letter_spacing` only)                              |
| Element backdrop blur                   | no                                               | no (window background blur only)                                                                                 | no                                                                                                     | **yes** (`backdrop_blur`, `blur`, `filter`)                          |
| Letter-spacing                          | no                                               | no                                                                                                               | no                                                                                                     | **yes**                                                              |
| macOS `start_window_move`               | no                                               | **yes** (+ `app_owns_titlebar_drag`)                                                                             | **yes** (same code)                                                                                    | yes                                                                  |
| Colour space on the Metal layer         | never set                                        | opt-in Display P3 only (`WindowOptions::use_display_p3`)                                                         | same as b                                                                                              | same (opt-in P3)                                                     |
| Accessibility                           | none                                             | AccessKit (`.role(...)`, macOS adapter)                                                                          | same as b                                                                                              | AccessKit                                                            |
| API                                     | 2025-10                                          | current                                                                                                          | = b (one-line diff)                                                                                    | upstream plus its own additions                                      |
| Licence                                 | Apache-2.0                                       | Apache-2.0 for every `gpui*` crate and its deps                                                                  | Apache-2.0; gpui-component, gpui-base, gpui-kit-assets Apache-2.0                                      | Apache-2.0                                                           |
| Releases, maintainers                   | 0.2.0 to 0.2.2 in Oct 2025, none since; Zed team | Zed main, daily                                                                                                  | weekly since 2026-09-03 (13 versions); one owner, huacnlee (Longbridge, gpui-component's author)       | 0.2.2 2026-08, 0.3.0 2026-10; one crates.io owner; 1.6k GitHub stars |
| Our code that broke                     | n/a                                              | same as c                                                                                                        | 7 library, 4 binary, 5 test compile errors, all mechanical (below)                                     | not ported                                                           |

Licences, checked with `cargo metadata` over the macOS dependency graph of each probe: no GPL crate anywhere. MPL-2.0
appears only in `cbindgen` (a build tool, not linked) and `option-ext` (via `dirs-sys`). Zed's higher-level crates are
GPL-3.0-or-later and must never be added: `ui`, `markdown`, `editor`, `text`, `language`, `theme`, `component`,
`ui_input`, `menu`, `picker`. The Apache-2.0 ones we use are `gpui`, `gpui_platform`, `gpui_macos`, `gpui_apple`,
`gpui_macros`, `gpui_util`, `gpui_shared_string`, `collections`, `sum_tree`, `refineable`, `scheduler`, `http_client`.

What changed in our code (gpui 0.2.2 to gpui-pre 0.3.12):

- `Application::new()` is gone; the app starts with `gpui_platform::application()`. Platform code lives in
  `gpui_macos`/`gpui_apple`, and **text needs the `font-kit` feature**: without it macOS uses a no-op text system and
  draws no text at all, with only a log line.
- `Window::focus(&handle, cx)`, `UniformList::track_scroll(&handle)`, `Menu::new(..).items(..)`,
  `on_window_closed(|cx, window_id| ..)`, `ScrollWheelEvent` is `ScrollEvent` (with `source`),
  `max_offset_for_scrollbar()` returns a `Point`, `WrappedLine` is no longer `Clone`, and async `cx.update` returns the
  closure's value instead of a `Result`.
- Tests: debug bounds are now per frame (0.2.2 kept every selector ever drawn), so tests can check that something left.
- Text truncation (`truncate()`) now ends in "…".
- Input modality: the first key after using the mouse, and the first mouse move after typing, refresh the whole
  window, cached views included (`modality_switches_redraw_every_view_once` in `chat_tests.rs`).

Risks: `gpui-pre` is ten weeks old and has one publisher; if it stops, pin the same zed commit as a git dependency
(costs the 1.2 GB fetch above, nothing else). Upgrading means bumping `gpui-pre` and `gpui-component` together, since
each gpui-component release pins one snapshot exactly.

### gpui-component

Version 0.9.1 (repository `longbridge/gpui-kit`, Apache-2.0, ~20k GitHub stars). `gpui_component::init` runs at
startup and in `tests.rs::gpui_component_widgets_mount`. What it offers for the pieces Milagre needs:

| Need                       | gpui-component 0.9.1                                                                                                                             | Could replace                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Text input, editor         | `Input` (one line), `Textarea` (`auto_grow(min, max)`, soft wrap, placeholder, undo/redo, IME), `Editor` (code: highlighting, search, LSP hooks) | our composer's text field (`composer.rs`, ~600 lines)                  |
| Selectable text, markdown  | `SelectableText`; markdown/HTML `TextView` with window-wide selection, inline code chips, streaming fade                                         | our markdown renderer (`markdown.rs`) and the selection we never built |
| Tabs                       | `TabBar`, `Tab`                                                                                                                                  | panel tab strip (keep ours until its scroll behaviour is matched)      |
| Resizable panels, dock     | `h_resizable`/`v_resizable`, `DockArea` with persisted layout                                                                                    | fixed 304/518 px columns                                               |
| Scroll area with scrollbar | `Scrollbar`, `ScrollableMask`, overlay scrollbars                                                                                                | the missing scrollbars                                                 |
| Popover, menu              | `Popover`, `PopupMenu`, `ContextMenu`, `DropdownMenu`                                                                                            | nothing yet (we have none)                                             |
| Dialog, tooltip            | `Dialog`, `AlertDialog`, `Tooltip` (dialogs need `Root` as the window root)                                                                      | our `Tooltip` stub                                                     |
| Webview                    | separate crate `gpui-webview` 0.9.1 (Apache-2.0) on `lb-wry` 0.53.3 (Apache-2.0 OR MIT, a wry fork)                                              | the Browser tab                                                        |

Not adopted into our views yet: its widgets draw with its own theme (`gpui_component::Theme`), which would need to be
fed from our tokens first.

## What is where

`CONVENTIONS.md` has the module table. In short: `app.rs` starts the app; `theme/` holds the tokens; `ui/` the shared
primitives; `data/` the domain types, the `DataSource` trait and its fixture; `workspace/` the window, one folder per
column; `testing/` the headless test helpers; `assets/` and `tools/gen-icons.mjs` the icons.

Seams for the next steps: the sidebar reads its rows through the `Data` global (`workspace/sidebar/list.rs`; a daemon
client's adapter implementing `DataSource` replaces the fixture with no sidebar change), the transcript's items come from
`workspace/chat/fixture.rs` (turning `chat:messages` pages into `Item`s is not written), and each panel tab's content goes
in the `"panel-body"` div in `workspace/panel/mod.rs`.

## Icons, logos and fonts

- **Icons are Hugeicons**, the set the desktop uses: `@hugeicons/core-free-icons` 4.3.5 (MIT; licence copied to
  `assets/hugeicons/LICENSE.md`). The package is not in this worktree's `node_modules` (none is installed here); the
  generator was run against the main checkout's copy, the version the root `package.json` pins. `tools/gen-icons.mjs`
  writes each glyph as an SVG stroked the way the desktop's `<Icon>` draws it (`HugeiconsIcon` with `strokeWidth` puts the
  stroke on every element; the width is in the 24-unit viewBox, so 1.8 at 16px draws 1.2px). Files carry 1.8; the asset
  source swaps it to 1.6 or 2 for the `@1.6` and `@2` paths 12 and 18px icons ask for. The 35 names are the ones the
  sidebar, panel tabs, composer, tool rows and primitives import in `apps/desktop/app/src`.
- `Icon::new(IconName::Search01).size(IconSize::S16).color(theme.ink3)`. Every hand-drawn path icon is gone. Status
  marks follow the desktop's `ChatMarkDot`: a `SpinnerRing` while running, `ShieldAlert` and `BubbleChatQuestion` in
  orange, a red dot for failed, the accent dot for unread. The usage warning is `Alert02` in `red-ink`, as
  `SidebarUsage.tsx` draws "Couldn't read usage" (the spike drew an orange triangle).
- **Provider logos are the real marks** from `packages/shared/src/provider-logos.ts` (from Lobe Icons,
  `@lobehub/icons-static-svg` 1.95.1, MIT; the marks are their owners' trademarks), generated to `assets/logos/`: brand
  colours drawn with `img()` (resvg keeps Codex's gradient and Antigravity's masked, blurred blobs; `assets/tests.rs`
  renders each and checks it is in colour) and a one-colour outline for `.mono(color)`. They are decoded at startup.
- Everything is embedded with `include_bytes!` (a generated table, no runtime file reads). The asset source falls back
  to `gpui-kit-assets` (Lucide, ISC) for gpui-component's own widgets; ours live under `hugeicons/`, `logos/` and `ui/` so
  the two never collide.
- **Fonts.** Text is the system UI font (`.SystemUIFont`, SF Pro). Code is **SF Mono through the private family
  `.AppleSystemUIFontMonospaced`**: CoreText resolves it (every glyph 1266 units wide, unlike Menlo's 1233), so the app gets
  what CSS `ui-monospace` gives the Electron app without bundling a font (Apple's licence does not allow shipping SF Mono).
  `theme::init_fonts` checks at startup and falls back to Menlo, which ships with every macOS. Bundling a mono font was
  rejected: it would not match the desktop, and the system copy needs nothing.

## Window chrome

| Question                                               | Status                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dragging by the full 44px headers of all three columns | Built: the window opens with `app_owns_titlebar_drag` and every header calls `Window::start_window_move` on the first mouse move after a press (Zed's own title bar does the same). Controls in a header take `.no_drag()`. Covered by a headless test with the call recorded; **not dragged by hand**.                                                                                                               |
| Double-click to zoom                                   | Built: `titlebar_double_click` (honours the system's "double-click a title bar to" setting); a double-click on a tab or button does not zoom. Test as above.                                                                                                                                                                                                                                                          |
| Traffic lights centred                                 | `traffic_light_position` (16, 15): measured in the snapshot at rows 30 to 57 of 2x pixels, centre 22.00pt in the 44px header (the spike's 21.75 was with a looser threshold; same frame).                                                                                                                                                                                                                             |
| Colour space                                           | Still open. gpui-pre's `CAMetalLayer` is untagged unless `WindowOptions::use_display_p3` tags it Display P3, which would make our sRGB tokens look more saturated, not convert them. A fix: tag the layer `kCGColorSpaceSRGB` (a few lines in `gpui_apple::MetalRenderer::configure_layer` plus a window option), or tag it P3 and convert every token, and every image, from sRGB to P3 ourselves. Not patched here. |

## Rendering: what re-renders what

GPUI re-renders a notifying view and every view on its path to the root; a re-rendering view re-renders its plain child
views and reuses its cached ones (`AnyView::cached`) unless they are dirty; a dirty cached view rebuilds its whole subtree,
cached views inside it included (`workspace/tests.rs` pins this down). What the layout does with that:

- Cached leaves: each visible sidebar row (`ChatRowView`), the transcript, the running row, the panel. Plain views,
  kept cheap: the root, the sidebar, the Chat column, the composer (its height follows its text).
- The running mark is no longer a transcript item: an animation re-renders its own view every frame, and inside the list
  that rebuilt every visible item (13 per frame measured on 0.2.2). It is now `RunningRow`, a cached view over the
  transcript's bottom edge, and the transcript keeps room for it.
- Measured in the test platform: a keystroke rebuilds no transcript item, no sidebar row, not the panel and not the
  running row; a running-mark frame rebuilds only the running row; a sidebar re-render rebuilds no row; a selection change
  renders exactly the two rows it touches.
- Still re-rendered on every keystroke and every animation frame: the root, the sidebar's own render (header, the list's
  frame, the bottom group) and the Chat column's (header, pills, composer). Each is a small tree.
- GPUI refreshes every view once on a focus change, and on the first key after mouse input (or the first mouse move after
  typing); `chat/tests.rs` documents it.

## Results (2026-11-11, Apple M5 Pro, 18 cores, rustc 1.99.1)

- Cold `cargo build` (after `cargo clean`, crates already downloaded): 34.4 s wall, 407 crates, no warnings (0.2.2 was
  20.7 s and 451 crates; gpui-component and the Lucide bundle are most of the difference, see the decision table). Cold
  `cargo build --release`: 51.3 s. `cargo test` compile and run from warm dependencies: 32 s (`test-support` builds a
  second GPUI variant).
- Debug binary 110.7 MB, release binary 21.4 MB, not stripped (0.2.2: 30.7 and 5.9 MB). A gpui-pre hello world is 8.8 MB in
  release; how much of the rest is gpui-component (`init` links its widgets) was not isolated. `target/` is 4.8 GB after
  one debug and one release build.
- Clippy clean with `-D warnings`. Tests: 60 pass (the spike's 34, consciously updated where gpui-pre differs, plus 26
  new: light theme and type scale, assets, primitives, data and fixture, window chrome, cached rows and re-render paths).
- Snapshot: traffic lights centred at 22.00pt in the 44px header; dark and light compared with the spike's last shot (the
  only differences are the real icons and logos, SF Mono code, the secondary button's ring, the tile letter at 10px, and
  fixture content).

## What was easy

- It built and drew on the first compile. `div()` styling reads like Tailwind (`h`, `px`, `rounded`, `bg`,
  `border_1`, `border_color`, `truncate`), so DESIGN.md values map one to one, and `px()` is `const`, so radii and
  heights can be `const` tokens.
- A theme is a struct with `impl Global`, set once with `cx.set_global` and read in any render with
  `cx.global::<Theme>()` (wrapped as `cx.theme()`). Colours are `Rgba`; translucent tokens keep their alpha.
- `uniform_list` is a ready virtualized list for fixed-height rows (Milagre's 48px two-line rows), and its rows can be
  cached views.
- System UI font, 500/600 weights, 13/18 and 12/16 line heights all render crisply and match the Electron metrics.
- The headless test platform is the best surprise: mount the real view, find elements by `debug_selector`, click
  them, assert state and pixel bounds, in milliseconds and without a screen.
- Moving from 0.2.2 to gpui-pre took 16 mechanical compile fixes and two test changes.

## What was awkward

- GPUI itself still has no selectable static text, no per-span size, padding or radius, no letter-spacing and no element
  backdrop blur (the decision table above). gpui-component covers the first two for markdown and text views; the
  composer's blur and the 22px title's `-0.02em` have no answer short of gpui-ce or a patch.
- Caching is coarse: a dirty cached view rebuilds every cached view inside it, so containers cannot be cached when
  something inside them changes often. See "Rendering".
- `list()` items have their own heights, so they cannot be cached views: anything that changes on its own must live
  outside the list.
- `img()` draws nothing until its asset has decoded and its view renders again. Logos are decoded at startup.
- A window AppKit reports occluded gets no frames (gpui-pre stops its display link), so unattended runs (snapshot mode,
  the timing probe) only ever see the first frames.
- The text system is not loaded unless `gpui_platform`'s `font-kit` feature is on; without it, no text and no error,
  only a log line.
- Edition 2024 return-position `impl Trait` captures every lifetime in scope, so helpers that take `&Theme` and return
  an element need `impl IntoElement + use<>`.
- At the 960px minimum width the Chat column is only 136px wide; the real app needs the panel to collapse. Not a GPUI
  limit, just not built.
- `screencapture` is refused without Screen Recording permission, so screenshots needed the in-process capture in
  `snapshot.rs`, which calls `CGWindowListCreateImage` through `dlsym` because the macOS 15+ SDK obsoletes it. It may
  stop working on a future macOS.

## Data layer

`src/data` holds the shapes the daemon sends, trimmed to what screens read, each type documented with its TypeScript
source (`data/mod.rs` has the table): `Provider` (picker order), computers and `ScopeKey`, `Project`/`OpenProject`/
`StateRead` with their `StateStamp`, the lean `ScopeState`, `Worktree`, `Chat` (`AgentSession` with its summary,
subagents, background tasks, Routine, parent, pins, Done), `ChatRuns`/`AgentRun` with approvals and questions,
`ChatMessage` with its context kinds and steps, PRs and usage. `DataSource` is read-only, one method per daemon method
(`computers:list`, `project:recent`, `project:current`, `project:open`, `project:read`, `state:read`, `chat:runs`,
`chat:messages`, `pull-requests:snapshot`, `usage:cached`); `experiments/rust-daemon-client`'s adapter will implement it.
No serde on the domain types: decoding is the adapter's. `serde_json` (already in the tree) only keeps a message
context kind whole (`ChatContext::Other`). The fixture (`data/fixture.rs`) spans three computers (one offline) with the
states every list shows; `app::install_fixture` installs it and seeds the sidebar's device state (opened families, the
Chat on screen) until a preference store exists.

## Sidebar notes

- `workspace/sidebar/` is the full 304px sidebar: header with three 24px icon buttons (x 208, 240, 272), Canvas /
  Routines / Links, the Pinned rows, an "All Chats" section label, a `uniform_list` of the fixture's 500 rows, and a
  pinned Done row (with its count), usage block and footer (`bottom.rs`).
- `list.rs` reads computers, recent Projects, states, runs, PRs and usage through `DataSource` and ports the desktop's
  `scopeChats`, `mergeScopeChats` and `shownChats` over `logic::lists` and `logic::marks`: hidden Projects and archived,
  Done and empty starter Chats out, a hidden Run Chat only while it waits, pinned first, then every scope merged by the
  Chat order (created), Subchats under their family's top Chat (folded unless opened; the count on the parent's tile
  folds them), each row's mark from `chat_mark`. `ChatRow::new` (`row.rs`) follows `InboxLine`: "project · #PR · +n ·
  computer" (the computer with several computers, ", offline" in `orange-ink`), the first PR by `row_pull_requests`. The
  tile is the Project's initial (the Chat's in a Chats home, where the desktop draws its bubble mark).
- Keyboard: the sidebar has a `FocusHandle` (`track_focus`, `key_context("Sidebar")`) and `on_key_down`; Up/Down move the
  selection and call `UniformListScrollHandle::scroll_to_item` (only Top/Center/Bottom exist, no "nearest", so the sidebar
  uses the last built range to pick Top or Bottom). Nothing focuses the sidebar at startup; a click does.
- Virtualization: only the rows in view (about 19 at 900px high) have views, plus 64 on each side kept for scrolling back.

## Panel tabs notes

- The panel header shows six `ui::Tab`s (Changes with a "4" count, Terminal, Browser, Designs, Artifact, PR) in a list
  that scrolls horizontally; expand and close (24px `IconButton`s, 16px glyphs) are pinned at the right, outside the list.
- Scrolling is GPUI's own: `overflow_x_scroll()` plus `track_scroll(&ScrollHandle)` on the list. A mouse wheel, a trackpad
  swipe and shift+wheel move it; there is no scrollbar. Clicking a tab calls `ScrollHandle::scroll_to_item(ix)`, which
  scrolls the minimum needed to show the tab fully on the next frame. Tabs must be direct children of the scroll div.
- At 518px the PR tab is mostly clipped at rest, as intended. A clipped tab is not clickable where it is clipped.

## Usage block notes

- Three 32px rows: the provider's brand mark (16px, x 12), name (x 40), the `Alert02` mark after a provider whose read
  failed, then per usage window a right-aligned 12px label over a 2px track (`line`) with an `ink3` fill. Two windows use
  68px meters at x 132 and 208; one window uses one 144px track from x 132 to 276. Fills are at least 2px above 0% and
  absent at 0%. Data: `usage:cached` through `DataSource`; the rows are `visible_providers`, labels `format_percent`, and
  fills take the usage tone (orange from 80 %, red from 95 %; the desktop's normal fill is `ink`, the spike keeps `ink3`).

## Transcript notes

The Chat column now holds a real transcript and composer (2026-11-11).

| File                           | Lines (code) | What                                                                                |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------- |
| `workspace/chat/transcript.rs` | 608 (526)    | `Transcript` entity: items, `list()` + `ListState`, item rows, timing probe         |
| `workspace/chat/composer.rs`   | 830 (710)    | Composer: multi-line text input (~590 code lines) plus the send row (~120)          |
| `workspace/chat/markdown.rs`   | 455 (393)    | pulldown-cmark events to blocks; blocks to GPUI elements                            |
| `workspace/chat/mod.rs`        | 123 (106)    | Header, cached transcript and running row, floating pills, composer                 |
| `workspace/chat/fixture.rs`    | 284 (226)    | The first screen plus ~2,000 generated items (fixed seed), long markdown answers    |
| `workspace/chat/tests.rs`      | 277 (236)    | Headless tests (markdown, list, approvals, typing, keys, paste, IME, link, caching) |

(Line counts are from the spike's step 4, before the move into folders.)

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

Measurements on GPUI 0.2.2, before this foundation (Apple M5 Pro, release build, `MILAGRE_GPUI_TIMING=1` with
`MILAGRE_GPUI_SNAPSHOT` so the window never activates; three runs). On gpui-pre the probe still prints the first frame (26
items built, as before), but its later steps need frames an unattended, occluded window no longer gets; the headless
tests in "Rendering" are the evidence for the structural changes since. The probe times from the start of `Transcript::render` to the paint of a zero-size canvas drawn last in the
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
- An animation anywhere in the transcript (the breathing running mark) asked for a frame and marked the transcript view
  dirty, so every visible item was rebuilt every frame (13 per frame here). It now lives outside the list (`running.rs`).
- Static text is not selectable in GPUI (0.2.2 or gpui-pre): no selection, no copy. `StyledText::layout()` maps points to indices, so
  selection inside one paragraph is buildable; selection across paragraphs and list items (some not even laid out) needs a
  transcript-wide selection model, as Zed's own `markdown` crate has (not published on crates.io).
- `TextRun` has a font, colours and decorations but no size, padding or radius: inline code is mono at the prose size with a
  square `field` background, not a 4px pill at a smaller size (gpui-component's `TextView` draws it as a chip).
- Code is SF Mono through `.AppleSystemUIFontMonospaced` (see "Icons, logos and fonts").
- A hugging flex container whose children have negative margins measures 0px wide (the activity marks overlapped their text);
  fixed with an explicit width.
- GPUI 0.2.2's test support never cleared a frame's debug bounds (gpui-pre does, per frame). The test platform's text system
  is a no-op with fixed advances.
- Code blocks scroll sideways (`overflow_x_scroll`, `restrict_scroll_to_axis` so vertical wheel deltas stay with the list);
  not tried with a real trackpad.
- IME and dead keys go through `NSTextInputClient` (`setMarkedText`, `insertText`) into the composer's input handler, the same
  path Zed's editor uses. The test drives that handler's methods directly; nobody typed Option+E, A on the real window.
- Not built in the composer: undo, word movement, double-click selection, caret blink, drag and drop, attachments.
