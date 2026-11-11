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

Headless snapshots (`src/snapshot/headless.rs`) draw with no window at all, so later frames show (a selection made
after the first frame, open popovers and dialogs, settled animations) whether or not the display is awake. No
`caffeinate` needed:

```sh
cargo build --features headless-snapshot
MILAGRE_GPUI_SNAPSHOT=/tmp/x.png target/debug/milagre-gpui-spike                 # headless by default in this build
MILAGRE_GPUI_SNAPSHOT=/tmp/x.png MILAGRE_GPUI_SNAPSHOT_FRAMES=240 target/debug/milagre-gpui-spike   # frames pumped (120)
MILAGRE_GPUI_SNAPSHOT=/tmp/x.png MILAGRE_GPUI_SNAPSHOT_HEADLESS=0 target/debug/milagre-gpui-spike   # the window capture
```

It runs the app on gpui-pre's `HeadlessAppContext` (its test platform with the real CoreText text system and the
app's assets), opens the main window as `app::run` does, so every `MILAGRE_GPUI_*` seed applies, pumps frames (next-frame
callbacks, redraw, the simulated clock moves 16.7 ms), then renders the last scene with `MetalHeadlessRenderer` and
reads it back: 2880 x 1800 px. What differs from the window capture: no traffic lights or window shadow (there is no
AppKit window), and the clock is simulated, so a looping spinner stops wherever the last frame left it. The feature
turns on gpui-pre's `test-support`, which is why it is not in the app's default build; `MILAGRE_GPUI_SNAPSHOT_HEADLESS=1`
in a build without it exits with an error. No gpui-pre patch: 0.3.12 already ships `HeadlessAppContext`,
`capture_screenshot` and `gpui_platform::current_headless_renderer`. `cargo test headless_renders_the_window --
--ignored` checks it.

Needs Xcode's command line tools (for `bindgen`'s libclang). It does **not** need the Metal Toolchain (`runtime_shaders`).
`node tools/gen-icons.mjs` (run by hand when icons change) needs the repository's `node_modules`.

## Package and install (macOS)

```sh
scripts/bundle-macos.sh                 # builds /tmp/milagre-gpui-bundle/"Milagre GPUI.app"
scripts/bundle-macos.sh --install       # also quits a running copy (by bundle id) and replaces ~/Applications/"Milagre GPUI.app"
scripts/bundle-macos.sh --out ~/Desktop # write the bundle somewhere else
```

The script builds a release binary from a clean `git archive` of **HEAD** (uncommitted changes are not in the bundle, and a
HEAD that does not build fails the script), then writes the bundle from `packaging/`: `Info.plist.in` (bundle id
`com.milagre.gpui-poc`, display name "Milagre GPUI", `CFBundleShortVersionString` from `Cargo.toml`, `CFBundleVersion` the
short commit SHA, `LSMinimumSystemVersion` 13.0, `NSHighResolutionCapable`) and `icon.icns`, and signs it ad hoc
(`codesign --force --deep -s -`). The build cache is `~/.cache/milagre-gpui-bundle/target` (override with
`CARGO_TARGET_DIR`), so only the first run compiles the dependencies. The same SHA is compiled in as `MILAGRE_GPUI_SHA`
and shown by `platform::updates::AppVersion` (`app:version`). Check a bundle with `codesign -dv --deep "<app>"` and
`plutil -p "<app>/Contents/Info.plist"`.

App updates (`src/platform/updates.rs`) are a fixture: `UpdateMachine` holds the `update:*` state (check, found, progress,
downloaded, install, fail, retry) and hands `UpdateNotice::set_state` its `AppUpdate`. There is no update feed and no
network; the mechanism is still an open decision.

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
  `theme::init_fonts` checks at startup and falls back to Menlo, which ships with every macOS. Bundling a mono font as
  the default was rejected: it would not match the desktop, and the system copy needs nothing.
- **Bundled fonts.** The families the desktop ships through fontsource for Settings › Appearance (Inter, Geist, Geist
  Mono, JetBrains Mono, all SIL OFL 1.1, licence texts in `assets/fonts/<family>/OFL.txt`) are embedded and registered
  at startup (`theme/fonts.rs`), so choosing one applies without it installed. They are the upstream static faces
  (Inter 4.1, Geist 1.9.2, JetBrains Mono 2.304) at 400, 500, 600, 700 and italic, not the variable fonts: GPUI picks a
  face by weight and does not set a variable font's axes. The platform's font list leaves out fonts added from
  memory, so the Appearance probe also asks `fonts::is_bundled`.

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

## Markdown notes

Assistant answers and user messages are gpui-base's rich text view (`TextView`, markdown-rs with GFM) inside
`ui::markdown::Markdown`, one `TextViewState` per message, selectable across blocks and messages through `Root`'s
window selection (2026-11-11, WP-14, WP-15, WP-16).

| File                                     | What                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ui/markdown/mod.rs`                     | Style from theme tokens, extensions (file chips, image links, raw HTML), `Markdown`      |
| `ui/markdown/stream.rs`                  | `splitStreamingBlocks`, `closeOpenMarkdown`, `isMarkdownFence` with both TS test vectors |
| `ui/markdown/files.rs`                   | `fileLinkTarget` (inline code that names a file) with its vectors                        |
| `ui/markdown/fences.rs`                  | Fence routing, the 40 desktop language ids, placeholders, code block label and Copy      |
| `ui/markdown/highlight.rs`               | Shiki buckets onto gpui-component's syntect names; installs the `HighlightTheme`         |
| `workspace/chat/transcript_selection.rs` | Selection ends per item, the keeper element that keeps them mounted                      |

Rules of `apps/desktop/app/src/components/markdown`, one by one:

| Rule                                                                     | State                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Chat size 14 at 1.6, headings 18/16/15/14 at 1.35, semibold, ink         | Done (`text_view_style`, size is a parameter for the user scale)                                         |
| Paragraph and list spacing (0.5em), quote (2px `line-strong`, `ink-2`)   | Done; heading gaps are gpui-base's collapsing section gaps, not the exact 1.25em/0.4em                   |
| List markers `ink-3`, ordered digits                                     | Done by gpui-base; the `--marker-digits` gutter is not measured                                          |
| Tables: 12px, `line` borders, `inset` head, scroll sideways              | Done; cells never wrap (`overflow-wrap: normal`); the body takes gpui-base's surface fill                |
| Rule, task lists (disabled, accent ticks)                                | Done by gpui-base                                                                                        |
| Links `accent-ink`; web, file (`localFileLink`), other                   | Done (`LinkTarget`); web and other open with the system; file viewer, Browser panel, ⌘-click: not ported |
| Remote links rewritten to the computer's address (`useReachableHref`)    | Not done (no remote computers yet)                                                                       |
| Autolinks (GFM literals and `<url>`)                                     | Done by gpui-base's GFM parse                                                                            |
| Inline code chip (`CODE_CHIP`: `hover-2`, 4px radius, 0.875em mono)      | Done (`hover-2`, as `Markdown.tsx`; its comment explains why not `field`)                                |
| Inline code naming a file is a chip that opens it, copies as its text    | Done (`FileChipPlugin`); opening goes to the link handler (editor not ported)                            |
| Images show as links (alt, else source, else "image"); loaded images     | Link: done (`ImageLinkPlugin`). Loaded images and the lightbox: not done                                 |
| Raw HTML as text                                                         | Done for block HTML and lone tags; a paired inline tag (`<b>x</b>`) is a mark in gpui-base: not done     |
| Fence `markdown`/`md`: nested markdown                                   | Done (a nested text view; copied whole it gives its source)                                              |
| Fence `mermaid`                                                          | Placeholder block naming `pele`, with the source                                                         |
| Fence `openui`                                                           | Placeholder block naming `@openuidev/lang-core`, with the source                                         |
| Code block: inset, `line`, 8px radius, mono 12 at 1.6, scrolls sideways  | Done; label and Copy sit in the top-right of a 36px band (gpui-base has no header row)                   |
| Copy with a tick for 1.5 s                                               | Done; shows while the pointer is over the message (gpui-base gives the block no hover group)             |
| Shiki colours (`diff` fence uses the diff grammar, lines in text colour) | Done through syntect (`highlight.rs`); names are coarser than scopes, see its doc comment                |
| Highlight only the 40 desktop languages, 40,000-char cap, near viewport  | Near viewport: done (only drawn items). The other two: not done (gpui-component owns the highlighter)    |
| Re-highlight a streaming block after a 120 ms pause                      | Not done: the live block is highlighted on each 50 ms batch                                              |
| `splitStreamingBlocks`, `closeOpenMarkdown`, 50 ms throttle              | Done (`Transcript::stream`): finished blocks append, only the live block parses again                    |
| Parsed-body cache (500 entries)                                          | Equivalent: a message keeps its parse while within 150 items of the screen                               |
| User messages as typed text                                              | Done (`plain_text_source` escapes markdown); chips, quotes, fences of `PromptText`: not done             |

Selection (WP-16). One drag selects across paragraphs, lists, tables, code blocks and messages (gpui-base); a
double click selects a word, a triple click a paragraph, and a shift-click extends from the anchor, into another
message too. The gap the fit check found (`gap_selection_is_dropped_when_the_anchor_message_unmounts`: the list drops
the message the drag began in and gpui-base clears the whole selection) is closed by keeping the ends mounted: the
transcript follows which items hold the anchor and the cursor (`SelectionTracker`, gpui-base's participant rule at
item level), and `Keeper`, painted after the list, draws each end item the list did not draw, at the list's width,
just outside its bounds, clipped away. Its participant stays registered, so the selection, its highlight and the
end's offset survive a drag past 50 items and scrolling far away (`transcript_tests.rs`). ⌘A with focus in the
transcript (a press anywhere in it takes focus, as a page does) selects every message, drawn or not: each text view
shows it through its own select-all as it is drawn, and the next press ends it.

⌘C is the transcript's, for every selection in it: the selected part of the two end items (from the source range
gpui-base reports) and the whole of every message between, mounted or not, serialised by `ui/selection/plain.rs` as
Chromium serialises the desktop's DOM (`TextIterator`: a blank line after a paragraph, one newline after other blocks,
table cells joined by tabs, no list markers, a code block's language line when the selection starts above it, user
messages as typed). It works from the Markdown source, so copying 2,000 messages parses none for display. Copy parity
is by reading the React and Chromium code, not by running Electron (the desktop has no copy handler). Left: a file chip
is a `<button>` in Electron, so Electron likely leaves its text out where this keeps it (as the brief asks); a partial
selection inside a nested `markdown` fence or a streaming answer copies gpui-base's text; tool rows and approvals are
not selectable, as in the desktop.

While a selection is dragged, each row drawn last frame is a cached view (`RowView`) at last frame's height, so a step
rebuilds only the rows whose selection changed: gpui-base tells every participant between the ends that the selection
moved, so that is the rows from the anchor to the pointer, never one outside them. A press becomes a drag only after
the pointer moves 3 px, so a click on a button keeps the rows it was built in. Views are not evicted during a drag, so
no message is parsed twice under the pointer.

Measured in `transcript_tests.rs` (test platform, 2,000-item fixture, `cargo test --release -- --test-threads=1`,
Apple M5 Pro; debug in brackets):

| What                              | Result                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| Open 2,000 items                  | 68 item builds, 10 texts parsed, 8 ms to the first frame (debug 56 ms)      |
| One streamed append (1,049 chars) | 2 texts parsed (the appended block, the live block), 28 item builds, 2.5 ms |
| Drag over 50 items (140 steps)    | 1,900 item builds (13.6 a step), 81 ms in all (debug 0.8 s)                 |
| Drag through 200 messages         | 544 frames: mean 0.70 ms, p95 0.92 ms, max 1.44 ms; 12 builds a frame       |
| Drag over a screenful, no scroll  | 60 frames: mean 0.26 ms, p95 0.32 ms; builds only rows inside the selection |

Assertions on `debug_bounds` only hold in debug builds; run the release measurement for the numbers, not the
pass. `MILAGRE_GPUI_TRANSCRIPT_TOP=<item>|rich` opens scrolled to an item (or the last answer with a table) and
`MILAGRE_GPUI_TRANSCRIPT_SELECT=1` drags a selection from the message above into that answer, for snapshots (a
snapshot window that is never activated presents only its first frame when the display sleeps or covers it, so the
selection shows only on a Mac whose screen is awake).

## Find in chat

Find in chat and quote selection (WP-28): `workspace/chat/find.rs` (the search text and `find-in-chat.ts`),
`find_bar.rs` (the bar and the Chat column's ⌘F, ⌘G, ⇧⌘' and Escape), `transcript/find.rs` (matches, highlights,
navigation), `transcript/quote.rs` (the passage and the Quote button), tests in `find_tests.rs`.

- What is searched: the text of user messages and answers, drawn or not. Each message's search text is read once
  from its Markdown source (blocks as the desktop's DOM walk groups text nodes, each piece keeping its source
  bytes); a query scans the lowercased blocks only, so typing parses nothing. A hit is a source range, turned into
  the text view's range (`RenderedText::range_for_source`) and set as a gpui-base range highlight when its message is
  drawn (`orange` at 28%, the active one at 70%). Tool rows, approvals and cards are not searched (the desktop
  searches the visible text of unfolded rows too), nor a code block's language label.
- Stepping scrolls a match's message into the list when it is off screen, then `reveal_range` brings its line in.
  The desktop centres the match; here it lands at the nearest edge. A streamed answer is searched again per batch
  and the active match stays.
- ⌘F works while focus is in the Chat column (composer, transcript, bar); the desktop's works window-wide, which needs
  a hook on the Workspace root. Escape closes from the bar or the transcript, not from the composer.
- Quote: a selection inside one message offers a Quote button under where the pointer let go (gpui-base does not
  expose the selection's line boxes); its text is what ⌘C copies of that selection.

Measured (`measure_find_over_two_thousand_messages`, 2,000 fixture messages, 0.3 MB of source, release test build,
Apple M5 Pro; debug in brackets): the first query 25 ms, reading every message's search text once (138 ms); each
keystroke after it median 0.9 ms, max 4.9 ms (5.2 / 31 ms); the frame after it 1.0 ms; a step to the next match with
its frame median 0.7 ms, max 49 ms for the first jump into unmeasured history (7 / 488 ms).

## Composer notes

The composer's editor (WP-24) is gpui-component's `Textarea` over the prompt string, in `workspace/chat/composer/`:
`editor.rs` (the string model and our undo), `chips.rs` (chip kinds, labels and look), `menu.rs` (the `@` and `/`
token, rows and panel), `mentions.rs` (the `MentionSource` trait and its fixture), `history.rs` (`createEditHistory`),
`mod.rs` (the view, keys, events, send).

- The text area's text is the prompt, byte for byte. A chip is an atomic inline token whose text is its source
  (`/tldr`, `@src/app.rs`, `@chat:12`, `@computer:Studio`, `[Image #1]`), so copy, send and history all see the
  string. After every edit the string is split with `logic::prompts::parts::prompt_parts` and the tokens are made to
  match (`set_value` with the content, keeping selection and scroll), so chips appear and dissolve as the desktop's
  do (`/tldr` is a chip, `/tldrx` is not). Not while an IME composition is open.
- Undo is ours (500 ms coalescing, 200 steps, a chip edit or paste is one step): the composer catches `Undo` and
  `Redo` before the text area and puts a recorded draft back, chips included. The text area's own undo manager is
  never used.
- Keys are the text area's actions caught in the capture phase: Enter sends or picks a row (Shift+Enter is a
  newline; nothing while composing), Tab picks a row or takes the suggestion, Up and Down move the menu highlight or
  step through sent prompts at the first or last line, Ctrl+Y redoes, Escape closes the menu and otherwise goes on.
- The menu is an absolutely placed, deferred panel over the transcript, not `ui::Popover`/`MenuList`: those own
  focus and keys, while here the prompt keeps focus and the highlight follows the caret's token.
- The box is 68 at rest and grows with its rows to 100 (the desktop's `min-h-[68px]` and `maxHeight={100}`): the
  composer sets its height from `display_row_count()`; the text area grows to four rows, then scrolls.
- The text area is made on the composer's first frame (it needs the window, and `ChatView::new` has none); the Chat
  view focuses it after that frame.

Snapshot env: `MILAGRE_GPUI_COMPOSER_TEXT` (`\n` for a newline), `_SELECT=<start>..<end>`, `_IMAGES=<n>`,
`_QUOTE=<passage>`, `_ACTIVE=<row>` (a highlighted menu row).

Seams: `ComposerAttachment` events (pasted images and files, dropped files, a deleted image chip, a clicked image
chip) and `insert_image_mentions` for the attachments tray (WP-25); `set_mentions`, `set_image_count`,
`set_can_undo`, `set_suggestion`, `set_prompt_history`, `add_quote` and `set_text` (drafts) for real data; the send
row is unchanged. Not built: dictation, the attachments tray and file-chip attachment sync, the model picker,
queue and steering placeholders, draft persistence, the skill chip's description tooltip, `/undo` and `/storage`
opening their panels.

## Activity notes

WP-22 (2026-11-11): the activity fold and the tool rows, in `workspace/chat/transcript/{summary,step_row,activity}.rs`.

- **Data.** Items hold the real `data::ChatStep`: `Item::Activity(Activity)` is a reply's activity (entries of text and
  steps) and draws as a fold, or as the lone step's row when it has one step; `Item::Step` is a call between two
  texts; `Item::Approval` wraps a `ChatStep`. The old `Tool`/`ToolKind` stand-ins are gone.
- **The logic was not in `logic::activity`**, so `summary.rs` ports `tool-activity.mjs` (titles, durations, sources,
  sections), `reply-parts.ts` (`replyActivity`, `activitySummary`, `titleSpans`) and `activity-window.ts`, with tests.
  `logic::lists::chat_display::ToolCallDisplay` is used as is (`Transcript::set_display`, default Compact; Full detail
  draws every call inline; Always expand reasoning opens thinking rows).
- **Rows** are 24 high, glyph on the reply text's edge, hover fill drawn 13px past it (an absolute child behind the
  row). The app's nine kinds map to six glyph families: shell/setup, read, edit (and write: both `edit`), search,
  thinking, other (MCP, web fetch, subagent, to-do are all `other` in the app, told apart by title and `source`);
  image and artifact steps are cards in the app (WP-23) and stay out of the fold.
- **Folding re-measures one item.** The rows of an open fold are drawn inside the fold's own list item; every click
  is one `ListState::splice(ix..ix + 1, 1)`. Tests assert the neighbour keeps its height.
- **Shimmer.** The app sweeps a gradient through the title text; GPUI cannot clip a gradient to glyphs, so the whole
  title pulses between `ink-3` and `ink` (1.2s loop, per span), and keeps the static `ink-3` tint with motion off. A
  `with_animation` inside the list marks the transcript dirty every frame, so while a tool runs the visible items
  are rebuilt each frame (about 13). The running mark avoids this by being outside the list; the shimmer cannot.
  Moving it into a cached view does not help (rule 1). Not measured here; a person should watch CPU with a tool
  running, and the fix, if needed, is a lower frame rate (stepped fade) or painting the title in a custom element.
- **The running row** now follows the last item (`chat/mod.rs::running_offset`): the distance the reader has scrolled
  from the end moves it down with the content and the transcript's box clips it. Past 40 items from the end the list
  has not measured the gap, so the row is simply not drawn. `ListState::bounds_for_item` is wrong while the list is
  pinned to the end (its pinned scroll top is the content's end, not the viewport's top), so it is not used.
- **Not built:** the full diff view (the edit's detail is a placeholder naming the Changes package, with the first
  lines on the diff colours), markdown in thinking and in text between steps (plain text), the fold's 280ms height
  transition, the inline approval on a fold's line and `agent:respond-permission`, the Linear mark (a wrench), detail
  the host keeps elsewhere (`has_detail`: needs `chat:message`), a ticking clock for running durations (`Activity.now`
  is fixed), file-link clicks on read and edit titles, tooltips on the marks.
- Snapshot: `MILAGRE_GPUI_TRANSCRIPT_ACTIVITY=1` swaps the history for `fixture::activity_demo()` (a folded reply, an
  open one with every kind of row, a running tool); add `MILAGRE_GPUI_TRANSCRIPT_TOP=0` to open at its top.

## Panel notes

- Dock (`workspace/panel/dock.rs`): the Chat and the panel are one gpui-component `h_resizable` group; the panel's left edge drags
  (min/default/max per kind from `panel-width.ts`: Changes, Terminal and PR 280/320/640, Browser 360/440/1400, Designs and Artifact
  440/560/1400; the Chat keeps 420). The width is remembered per kind for the session; a double-click on the edge resets it (read by a
  window-level listener, because the handle occludes hit-tested ones). Every layout change (open, close, expand, tab, Chat) makes a fresh
  `ResizableState`, so the panel always opens at its remembered width. Expanded drops the group: the panel takes the width.
- Shortcuts: `changes.toggle`, `terminal.toggle`, `browser.toggle`, `designs.toggle`, `artifacts.toggle` are bound from
  `logic::keybindings` (`dock::install_keys`, once) and handled on the Workspace root; a shortcut hides the panel when its tab is the open one.
- Per Chat: `Panel` keeps open/tab/expanded by Chat key. The sidebar does not notify itself on a selection, so `Workspace::render`
  (which re-renders when a row does) calls `follow_sidebar`. Designs, Artifact and PR tabs show only for Chats that have content
  (`panel/fixture.rs`, the seam for the daemon); Changes, Terminal, Browser always do.
- Each tab body is a cached view (`size_full`): `ChangesView` or a `TabPlaceholder`. Typing in the composer renders neither the panel nor a body
  (`dock_tests.rs`); a view mounted cached sees the first key after a mouse press as a refresh, so tests type once before measuring.
- Changes (`panel/changes/`): `data.rs` panel-local input types over `logic::diff::git`; `fixture.rs` 13 files not committed, 3 on the
  branch, 5 commits, patches whose counts are computed and tested against gpui-component's parser; `files.rs` flat list (<=10 files) and
  folder tree with A/M/D/R badges and count columns; `diff.rs` the source for the diff view (below); `commits.rs` the Commits view.
  Snapshot seeds (never in tests): `MILAGRE_GPUI_PANEL_WIDTH`, `MILAGRE_GPUI_CHANGES_FILE`, `MILAGRE_GPUI_CHANGES_LAYOUT=split`,
  `MILAGRE_GPUI_DIFF_WRAP=1`, `MILAGRE_GPUI_DIFF_COMMENTS=1` (a comment, an outdated one and an open editor).

## Diff notes

`workspace/panel/diff/` (WP-31, P-06, P-07, C-07) replaces gpui-component's `Diff` in both the Changes panel and the PR Files tab. It is
our own rather than a wrap of `Diff` (the fit check's suggestion): sticky file headers, the held file, our parser's comment anchoring
(`lib/diff-comments.ts`, ported with its vectors in `comments_tests.rs`) and DESIGN.md's `diff-*` colours each fought `Diff`'s internals.
The module comment in `diff/mod.rs` lists the files and every deliberate difference from the DOM.

- Every file of the list in one GPUI `list` (virtualized, variable heights): a file is its header, body rows and end, each row drawing its
  slice of the card. The sticky header is a copy over the list's top, pushed up by the end of its card. Unified, split (always wraps, two
  equal columns) and wrap; the choice is the session's `DiffPrefs` global, shared by every diff.
- Syntax runs: syntect with gpui-component's grammars, mapped to the same Shiki buckets code blocks use (`ui::markdown::highlight`); word
  marks from `logic::diff::word_changes` under them. Hunks up to 120 lines are highlighted in the frame; longer ones on a background thread,
  400 lines at a time (syntect costs about 0.25 ms a TypeScript line here, 0.07 ms a Rust one), plain until their chunk lands.
- The picked file is held at the top until the reader scrolls, presses or something else moves the list; patches load when their rows
  come within 60 rows of the screen; files over 3,000 changed lines wait for "Show diff"; binary, too large, renamed and empty files say so.
- Line comments: press the row's "+" and drag (Shift extends), the editor opens under the range (⌘↵ saves, Esc cancels); cards with
  label, Outdated, a clamped body, Edit and Delete; outdated ones under their file, ones whose file left at the top. "Send N comments" sends
  `formatCommentsMessage` to the Chat through `PanelEvent::FixInChat`. Kept per Chat in memory (the desktop's `localStorage`).
- PR: threads under their lines through `PrView::thread_card`, the rest under the file; the editor's "Add to review" is `Write::Comment`.
- Code selection is the diff's own (WP-16's `ui::selection` serialises Markdown): a drag selects text in one column, ⌘C copies it as lines.
- Placement: under the panel's list, where the old pane was. The desktop draws it over the Chat column; that is a hook in
  `workspace/mod.rs`, not built.

10,000-line patch (`diff/tests.rs` `ten_thousand_line_patch_timing`, test platform, `cargo test --release -- --ignored --nocapture
ten_thousand`, Apple M5 Pro, three runs): first frame after open and Show diff 4.4 to 7.9 ms; 240 scroll frames (200 screens down, 40
back) median 1.08 ms, p95 1.12 to 1.15 ms, max 1.17 to 1.53 ms, about 125 rows drawn a frame; the whole file's syntax parse 2.4 s on the
background thread. The test platform's text system has fixed advances and no GPU, so real frames cost more; not yet measured in a window.

## Daemon adapter

`daemon-check/` is the first real-data stage, off by default: `DaemonAdapter` implements `DataSource` on the
backend's shared daemon client (`milagre-daemon-client`, used exactly as committed at 9aa5deb3) and is checked
headless against the backend's owned `app-fixture`. It is its own crate with its own `[workspace]` and lock; this
crate's manifest, lock and build do not know it exists, and the app never constructs the adapter.

```sh
cd daemon-check
python3 scripts/check-gpui-adapter.py export --backend <backend worktree>   # client tree into ../target/
cargo test --offline --locked                                                # mapping on captured bodies
python3 scripts/check-gpui-adapter.py run --backend <backend worktree>      # real fixture, staged in /tmp
```

`export` unpacks `git archive 9aa5deb3 experiments/rust-daemon-client` into `target/daemon-client-9aa5deb3/` and
checks every file against the commit's blobs. `run` also checks the fixture's SHA-256, stages the test runner beside
a copy of that exact binary in a private /tmp directory (the client's `FixtureGuard::launch()` only launches its
sibling `app-fixture`), runs each ignored `real::` test in its own process, records both hashes and HEADs, and
removes the stage; the log is `daemon-check/target/check-gpui-adapter.log`.

- `src/map.rs`: the client's JSON bodies into the domain types, by wire name; a wrong type is an error naming its path.
- `src/adapter.rs`: `project:current`, `project:open`, `project:read`, `state:read`, `chat:runs`, `chat:messages`.
  `computers:list`, `project:recent`, `pull-requests:snapshot`, `usage:cached` and any other computer answer a typed
  `NotAvailable`. `chat:messages` needs `project:open` on the connection first (the owner refuses with
  `ISOLATED_SCOPE_ONLY`); the adapter does not open on its own, since opening may persist owner state.
- `src/events.rs`: connect, `runtime_snapshot()`, apply to a `Reducer`, `accept_snapshot`, then released events in
  `wire_seq` order (a stale or regressing one is refused with a typed error). Each is kept in a count plus a tail with
  hard caps like the client's queue (1,024 events, 16 MiB of payload; an event over the byte cap is counted, not
  kept). A closed stream (`StateTooLarge` included) is an error, never an empty state. `LiveStore` is the seam a view
  subscribes to: a version counter, coalescing change signals and a read accessor; the app is not wired to it yet.
- `src/live.rs`: the live fold. `project:state {path, state}` replaces the scope's state; `agent:event {chatId, event,
  seq?, state?}` replaces it when it carries `state` and folds `event` into the Chat's run as `applyRunEvent` does
  (skipped when `seq` is at or below the runs' `seq`). Hydrated events apply their current catch-up state the same
  way. A stamp comes only from the payload. Other channels (`link:state`, ...), foreign scopes and event types the
  run fold leaves alone are counted, never interpreted. Every live collection has a hard bound (`LiveBounds`).
  A snapshot's runs are checked against the same bounds before it replaces anything. A turn started by the host
  runs on the Chat summary's `lastModel` (`lastUserModel`), `startedAt` comes from an injectable clock, steering
  uses JavaScript's `trim`, and step output is capped by UTF-16 units. `scripts/run-vectors.mjs` replays
  `tests/vectors/run-cases.json` through the repository's own `applyRunEvent`
  (`node scripts/run-vectors.mjs tests/vectors/run-cases.json > tests/vectors/run-traces.json`); a plain test
  requires the Rust fold to match after every event. One normalized difference: where `capOutput` cuts an astral
  character in half, JavaScript keeps a lone surrogate a Rust string cannot hold; both sides compare it as U+FFFD.
- `src/real/actions.rs`: the backend's `ScriptedActions` (`send`, `interrupt`) on the populated fixture, after an
  explicit `project:open` and an accepted snapshot (before the open both refuse with `ISOLATED_SCOPE_ONLY`). Events are
  awaited on the notifications with a bound, never on the action's future. The exact sequences cover the Chat's `agent:event`s
  up to the terminal one; events released after it (sometimes a `project:state`, sometimes none; the contract
  promises none) are collected and only checked to hold no further `agent:event` for that Chat. A send streams through the live reducer
  (run appears, text grows, run ends, summary count +2); a `fixture:blocked-start` send then `interrupt` gives
  `turn-cancelled` and removes the run (that path saves an empty, `cancelled` reply because no text was streamed;
  not a general rule for interrupted turns); the mounted transcript shows the new messages through the same manual seam.
  The required post-snapshot proof is a send's state-bearing `agent:event`s (admission and terminal); a
  `project:state` after `project:open` is optional evidence (opening an already-ready Project publishes nothing).
- `src/view.rs`: `open_on_select` (explicit `project:open`, then the Chat's first page) and `transcript_items`.
  The GPUI test swaps the Chat column's public `transcript` entity, because the base crate has no seam to give
  `ChatView` a Chat (title and Project label are private fixture text) and `Workspace` routes a selection only to
  the panel.

Not done in this stage: wiring the live state into the app's views, state patches, `applyAgentEvent`'s own state
folding for events that carry no `state`, the viewed-image step cap, content writes and any write beyond the
backend's fixture-only `ScriptedActions`, Links, other computers. Not decoded yet: subagent transcripts and progress (a non-empty one is an error),
typed message contexts other than `reload`, `git-action`, `limit-reset` and `handover` (the rest stay whole in
`ChatContext::Other`), `native_sessions`, `plan`, `limitResume`, `limitTurn`, `openSuggestions`, queued messages'
images and context. The fixture's two Chats have no messages, so the sidebar mounted from the adapter lists no row
(the shared rule leaves empty starter Chats out).

## Settings notes

The in-window Settings dialog (WP-39) lives in `src/settings/` and renders over the three-column workspace with a scrim,
a `1120 × 800` `rounded-window` (`12px`) surface, a `248px` `bg-canvas` left navigation rail, and a scrollable
`max-w-[788px]` section body.

| File                        | What                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `settings/mod.rs`           | `SettingsModal` entity, `ToggleSettings` (`cmd-,`), `FindInSettings` (`cmd-f`), Escape cascade, scrim      |
| `settings/nav.rs`           | 248px left nav (`Search01` input, grouped section rows, `ComputerDot`, `ProjectAvatar`, search hit list)   |
| `settings/search.rs`        | `SettingsSectionId`, `ALL_SECTIONS`, `SETTINGS_INDEX`, `fold_search_text`, `search_ranges`, `search_trail` |
| `settings/store.rs`         | `SettingsStore` GPUI global with React defaults and `MODEL_CATALOG` (in-memory only, no daemon calls)      |
| `settings/group.rs`         | `page_header`, `SettingsGroup`, `SettingRow`, `CheckboxRow` (no switches), `ChoiceCard`                    |
| `settings/general.rs`       | General (G-03): Editor, Sidebar Chat order, Chat list choice cards, Done retention, Plan usage, Awake      |
| `settings/chat.rs`          | Chat (G-06): Messages during a turn, Reasoning choice cards, Tool calls choice cards                       |
| `settings/notifications.rs` | Notifications (G-08): Alerts, Schedule (Anytime / Custom with day pills & time range), Sound, Routines     |
| `settings/models.rs`        | Models (G-10): Default model & permission, Context preview & thresholds bar/steppers, Replies (TLDR)       |
| `settings/browser.rs`       | Browser (G-16): Open links in (`Panel` / `System browser`), per-computer session sign-out                  |
| `settings/church.rs`        | Church (G-23): Floating inbox (+ activity), Ultracode Fatality, New Chat stats, Delegate, Device notes     |
| `settings/about.rs`         | About (G-24): Version, Release channel, Check for updates, Auto update, Runtime, License, Privacy, Support |
| `settings/tests.rs`         | Headless tests for search ranking/accents, modal open/close, nav & placeholders, search jump, all controls |

- **Workspace wiring**: `Workspace::new` (`src/workspace/mod.rs`) calls `settings::init(cx)` (installs `SettingsStore`
  and binds `cmd-,` to `ToggleSettings` and `cmd-f` inside `SettingsModal` to `FindInSettings`), mounts `SettingsModal`
  as the top child of `Workspace`, and handles `ToggleSettings`. The sidebar footer Settings icon button
  (`src/workspace/sidebar/bottom.rs`) dispatches `ToggleSettings`.
- **Popovers inside Settings**: `SettingsModal` renders inside `Root`'s main view tree (not inside `Root`'s dialog
  portal), so `Select` triggers inside Settings open their `Popover` menus in `Root`'s popover layer above the modal.
- **Placeholders**: Sections owned by other packages (`appearance` WP-40, `voice` & `keybindings` WP-41, `accounts` &
  `usage` WP-42, `skills`, `mcp` & `connections` WP-43, and `worktrees`, `devices`, `this-mac`, paired computers &
  recent Projects WP-44) appear in the left nav in their exact desktop order and render an `EmptyState` naming their
  work package.
- **Snapshot env var**: `MILAGRE_GPUI_SETTINGS=1` (or a section id such as `MILAGRE_GPUI_SETTINGS=general` or `models`)
  opens Settings on that section before snapshot capture.
  images and context. The default fixture's two Chats have no messages, so the sidebar mounted from it lists no row
  (the shared rule leaves empty starter Chats out). `real::populated::*` uses `FixtureGuard::launch_populated()` (Chat 1:
  two turns, 4 messages; Chat 2: one turn, 2): the sidebar draws exactly those two rows, Chat 2 first (`ChatOrder::Created`:
  newest first message first), and both transcripts and their before/turns/limit pages read in order.

## Cards notes

WP-23 (2026-11-11): every non-prose transcript item, in `workspace/chat/transcript/cards/`. `Item::Card(Card)` is one list
item per card; `cards::build::items_for(&ChatMessage)` picks what a message is in the order `MessageSection` does, so a
context kind nothing knows (`ChatContext::Other`) draws as the ordinary bubble or answer (nothing when it has no text).

| Kind                                  | React source                                                                                              | Status   | Notes                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question card                         | `QuestionCard.tsx`, `question-answers.ts`                                                                 | partial  | options, Other field (`ui::Input::bare`), tabs, Next/Send, Dismiss, resolves in place; mic/image inert; no secret or bug-report variants; rows are mouse-only                                                                                                                                             |
| Answer card                           | `AnswerCard.tsx`                                                                                          | done     |                                                                                                                                                                                                                                                                                                           |
| Dividers (9 kinds)                    | `TranscriptDivider` and the eight divider files                                                           | partial  | handoff, compaction, reload, account switch, limit reset, Routine Run, babysit stopped, checkpoint restore, Worktree link. Brief opens in a simple overlay (handoff brief is not in the typed data); Redo inert; clock is UTC; no quiet-Run folding; handoff names the model string, not the catalog name |
| Attachments, viewed, generated images | `Attachments.tsx`, `ViewedImages.tsx`, `GeneratedImage.tsx`                                               | partial  | sizes as the app; hover Copy/Download inert; no dither field (generating shows a label); decode is synchronous on first draw; viewer is an overlay (`Viewer`) with no zoom, pan, swipe or morph                                                                                                           |
| PR action card                        | `PullRequestActionCard.tsx`                                                                               | done     | validated with `pull_request_action_context`; optional state pill from `pull_request_state_pill`                                                                                                                                                                                                          |
| Linear issue card                     | `LinearIssueCard.tsx`                                                                                     | partial  | no Linear mark, state dot is neutral (data has the name only)                                                                                                                                                                                                                                             |
| Usage-limit card                      | `UsageLimitCard.tsx`                                                                                      | partial  | headline, resume toggle, switch rows, result line; choices are given, no live accounts or schedule                                                                                                                                                                                                        |
| Delegation report line                | `DelegationReportLine.tsx`                                                                                | partial  | report text opens as plain text (no markdown), no open-Chat link                                                                                                                                                                                                                                          |
| Subchat note                          | `SubchatMessages.tsx` `NoteLine`                                                                          | partial  | "Answered by"; escalation line and suggestion card not built                                                                                                                                                                                                                                              |
| Queued messages                       | `QueuedMessages.tsx`                                                                                      | moved    | docked above the composer now (see Composer bar notes); the transcript card is gone                                                                                                                                                                                                                       |
| Not built                             | secret, bug report, advisor, recommendation, Heartbeat, next check, remote delegation, computer use cards | not done |                                                                                                                                                                                                                                                                                                           |

Snapshot: `MILAGRE_GPUI_TRANSCRIPT_CARDS=1` (add `MILAGRE_GPUI_TRANSCRIPT_TOP=<item>`) shows `fixture::cards_demo()`, built from
messages. Test images are generated PNGs in `tests/assets/images/`. Item re-measure: a card that changes is replaced with
`set_card`, which splices its item.

## Composer bar notes

WP-25 (2026-11-11): the composer's bottom row, attachments tray, queue and the outgoing message, in
`workspace/chat/composer/{bar,send,attachments,queue}.rs` (`bar_tests.rs` beside them).

| Feature (React source)                                            | Status   | Notes                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attach button + picker (`PromptComposer.tsx`)                     | done     | `cx.prompt_for_paths`; tests answer it with `simulate_path_prompt_response` or call `attach_paths`                                                                                                |
| Permission and model trigger chips                                | partial  | `ui::Chip` triggers, Full shows the orange shield; click opens a placeholder popover naming WP-26. Popover opens below the chip (the `ui::Popover` has no upward anchor)                          |
| Context ring slot                                                 | partial  | slot shows the percentage when `set_context_percent` gives one; ring and card are WP-26                                                                                                           |
| Mic                                                               | partial  | drawn, inert (dictation is later)                                                                                                                                                                 |
| Send / Stop / Send now / Queue message (`canSend`, `canStop`)     | done     | `send::SendState` table with tests; Stop is a 10px rounded square; disabled at 40%; Enter never stops; running placeholder ("Steer the agent…" / "Queue a message…")                              |
| Attachments tray (`Attachments.tsx`)                              | partial  | image (80px) and file tiles, `#n` badges, remove buttons, tooltip path, in-memory; no upload progress/cancel, no offline placeholder, no preview dialog (tile click emits `OpenImage`/`OpenFile`) |
| Image numbering and chips                                         | done     | add inserts `[Image #N]` at the caret/paste/drop point; tile remove and chip delete both drop the image and renumber                                                                              |
| Limits and errors (`limits.mjs`, `usePastedImages.ts`)            | done     | PNG/JPEG/WebP/GIF pasted images, 50 MiB, React's three error texts; non-image paths become file tiles                                                                                             |
| Queued messages (`QueuedMessages.tsx`)                            | done     | docked above the box, Send now (Stop and send when the provider cannot steer), Remove; Edit is new (needs an empty composer)                                                                      |
| Steering                                                          | done     | idle sends; running + steering provider sends into the turn (`Steer`); Queue setting, compacting or a non-steering provider queues                                                                |
| Outgoing message + sink (`send::{OutgoingMessage, MessageSink}`)  | done     | prompt, text, quotes, files, images, delivery; `FixtureSink` records calls; `set_sink`                                                                                                            |
| Draft persistence, offline tray and outbox, quote chips' redesign | not done | later                                                                                                                                                                                             |

- The Chat's `ChatView` subscribes to `ComposerEvent::{Send, Queued, Stop}`: Stop ends the fixture's turn. Empty sends are not echoed.
- The textarea's own placeholder is empty; the composer draws the placeholder (it changes while a turn runs).
- Snapshot env: `MILAGRE_GPUI_COMPOSER_BAR=1` (running, queue setting, tray with two images and a file, two queued messages) or `=stop` (nothing typed, the Stop button).

## Model picker notes

WP-26 (`src/workspace/chat/composer/{models,model_picker,permission,context,new_chat,pick_list}.rs`, `src/ui/range_slider.rs`):

- All composer popovers open upward (`ui::Popover::above()`, added) and are controlled by `BarState::open`, so a snapshot or an action opens one and only one is open. `MILAGRE_GPUI_COMPOSER_OPEN=model|permission|context|project|computer|isolation|branch|tray` (comma-separated) opens them in snapshot mode. Popover content is a layer a composer `notify` does not reach, so handlers call `window.refresh()`.
- `pick_list.rs` is the shared row list (coloured icons, tick, meta, one `hover-2` highlight; Up/Down/Home/End, Enter/Space, checked row focused on open). `ui::MenuRow` cannot colour its icon, and Full permissions are orange.
- The model catalog is a fixture (`models.rs`, ids and names from `model-options.ts`, `antigravity-models.mjs`, `kiro-models.mjs`); capabilities and context windows follow `capabilityFor` and `contextWindowFor`.
- `RangeSlider` measures its track in a canvas, so the first frame uses a 176px guess; no spring, the handle lands at once.
- The new-Chat tray folds the Project picker (React's "Start building in" heading) in as its first chip. Start it with `Composer::start_new_chat`; the sidebar's New Chat button needs `chat.composer.update(cx, |c, cx| c.start_new_chat(cx))`.
- Not built: model search, account select, CLI notice, row tooltips, the picker's footer permission select, Ultracode's breathing glow, context card on hover/focus and Settings thresholds, branch search, Linear issue chip.

## Pills, Subchats, tasks and undo notes

WP-27 (2026-11-11): `workspace/chat/pills/`, `workspace/chat/undo_panel.rs`, `logic/plan/`.

- **The row** (`pills/mod.rs`) is one plain view over the composer: Subchats at the left; Ports, Tasks, Subagents and Go to
  bottom at the right. It is not cached (an open panel is taller than the row) and re-renders with the Chat column, which is
  cheap. Spinners in pills and panels are the static arc: an animation notifies its view, and so the column, every frame.
- **The morph** (`morph.rs`) is one surface hung from the pill's bottom corner (right for Ports, Tasks and Subagents; left for
  Subchats) that grows from the pill's size to the panel's over 300ms (ease-out), corners going from round to `radius-card`,
  while the faces crossfade (panel in after 60ms over 180ms, pill out over 100ms). Timing and geometry are plain functions,
  tested at fixed times; the view asks for frames only while a morph runs, and with motion off it is over at once. The pill's
  ring is a border: a shadow would show through the translucent glass. Left: no backdrop blur (DESIGN.md exception N-14),
  the glass is `surface` at 76%; the rolling digits and rising letters; the slot's grow-in; the panel's shift for a narrow
  window is computed (`right_shift`, `left_shift`) but not applied; panel heights are estimated from row counts, not measured.
- **Tasks**: the tree (fold, numbers, markers, the in-progress row's active form) and the phase graph. Geometry is
  `logic::plan`, a port of `phase-graph.mjs` and the `chat-plan` counters, with `phase-graph.test.ts` ported and the path pinned
  to the `.mjs` output; the plot is a `canvas` (S-curve with `PathBuilder`, dashed Now line, dots) with the gap chips and time
  labels as text over it. Times are UTC (the fixture's clock).
- **Ports** (stop with a spinner, Stop all, a row closes the panel and records the port; the Browser panel is another
  package), **Subchats** (the pill words, the one-asking pill that opens its Chat, rows with one-tap answers, Allow and Deny,
  Reply), **Subagents** (list, Archive finished, Archived, and a detail with plan or Now and steps, Result, Task and Full log).
  Not built: QA persona avatars, advisor Stop and Retry, markdown in Result and the log, keyboard walk through subagent rows.
- **C-06** (`pills/bookmark.rs`): the identity in the top strip, the Subchat bookmark (`... / ‹ ● Parent / Subchat ⇅`, the
  parent tinted with Needs you) and the family menu, over `chat_bookmark` and `chat_family`. Not built: the Routine chip and
  the bookmark reserve, ⌘[, and the two split entries do nothing yet (`ChatEvent::Beside` and `ShowAll`).
- **Undo** (`undo_panel.rs`) replaces the composer: list (arrows, Enter, Escape), preview with conflicts (Keep current or
  Undo) and a button that stays off until every conflict is answered. `/undo` opens it. Fixture checkpoints; `checkpoints.ts`
  helpers ported and tested. Not built: Esc Esc, the task's message outline in the transcript, the Changes panel on a file.
- Seeds for snapshots (never in tests): `MILAGRE_GPUI_PILLS_OPEN=tasks|ports|subchats|subagents`, `_PILLS_AGENT=<id>`,
  `_UNDO=list|preview|redo`, `_FAMILY_MENU=1`, `_SELECT_ROW=<n>`.
- `ChatView` emits `ChatEvent` (open a Chat, answer, respond, the split entries); `Workspace` follows `OpenChat` into the sidebar.
