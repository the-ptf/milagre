# Conventions for the GPUI port

How this crate is laid out and the rules every agent working on it follows. The why behind the GPUI choice is in
`README.md`; what to port next is in `PORT-MAP.md`; the design rules are the repository's `DESIGN.md`.

## Module layout

| Path                     | What lives there                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/main.rs`            | Calls `app::run()`. Nothing else.                                                                |
| `src/app.rs`             | Startup, globals, app-wide actions, key bindings, menus, window options, snapshot mode           |
| `src/assets/`            | The `AssetSource`: files under `assets/` embedded at build time (`embedded.rs` is generated)     |
| `src/theme/`             | Tokens: `colors.rs` (`Theme`), `typography.rs`, `metrics.rs`, `elevation.rs`; `tests.rs`         |
| `src/ui/`                | Shared primitives (`Icon`, `Button`, `IconButton`, `Chip`, `Tab`, `ScrollArea`, `Tooltip`, ...)  |
| `src/data/`              | Domain types (`model.rs`), the async `DataSource` trait (`source.rs`), `FixtureSource`           |
| `src/workspace/`         | The window: `mod.rs` (root), `chrome.rs` (title-bar headers), one folder per column              |
| `src/workspace/sidebar/` | `mod.rs` (the view, the list), `row.rs` (`ChatRowView`, `ChatRow`), `bottom.rs`, `tests.rs`      |
| `src/workspace/chat/`    | `mod.rs` (`ChatView`), `transcript.rs`, `running.rs`, `composer.rs`, `markdown.rs`, `fixture.rs` |
| `src/workspace/panel/`   | The side panel and its tabs                                                                      |
| `src/testing/`           | Helpers for headless tests (`mount_workspace`, `mount_element`, `bounds`, `leak`)                |
| `tools/gen-icons.mjs`    | Generates `assets/hugeicons/`, `assets/logos/`, `src/ui/icon_name.rs`, `src/assets/embedded.rs`  |

A new screen or column gets its own folder under `src/workspace/` (`mod.rs` for the view, `tests.rs` beside it). A
new primitive is one file in `src/ui/` with its test in `src/ui/tests.rs`. Domain types go in `src/data/model.rs`;
view models (what a row shows) stay with their view. `data/` never imports from `workspace/` or `ui/`.

## The look is not decided: keep it in the theme and the shell files

The owner has not chosen between design A (the spike's integrated sidebar) and today's React look. So:

- Every layout and look value (colours, sizes, radii, spacing, column widths, header heights, paddings that define the
  look) comes from `src/theme/` or a named constant at the top of the shell file that owns it, never inline in a
  feature view. Switching looks must be a change to the theme and the shell, not a hunt through views.
- The shell stays in its own files: the sidebar (`workspace/sidebar/`), the panel header (`workspace/panel/`), the top
  bar and column headers (`workspace/chrome.rs`, the headers in each column's `mod.rs`), the root layout
  (`workspace/mod.rs`). Feature views (a transcript item, a panel tab's content, a dialog) render inside the bounds the
  shell gives them and do not assume the shell's shape.

## Reading the theme

```rust
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_12, TextStepExt};
let theme = cx.theme(); // &Theme on any App or Context
div().h(CONTROL_SM).rounded(RADIUS_CONTROL).text_step(TEXT_12).bg(theme.surface).text_color(theme.ink2)
```

- Never write a hex colour, a font size or a radius in a view. Use the token; if one is missing, add it to
  `src/theme/` with its DESIGN.md row, and to `theme/tests.rs`.
- Colours: `theme.page`, `theme.ink3`, `theme.hover2`, ... (DESIGN.md names in snake case). Shadows:
  `theme.shadow_btn()`, `theme.shadow_raised()`. Fonts: `SANS`, `mono()`. Chat text: `CHAT_TEXT`.
- `Theme::dark()` and `Theme::light()` are both checked against DESIGN.md; run a snapshot in both.

## Adding a view that does not repaint its siblings

GPUI's rules (gpui-pre 0.3.12; `workspace/tests.rs` pins them down):

1. `cx.notify()` re-renders the notifying view and every view on its path to the root.
2. A re-rendering view re-renders its plain child views (`.child(entity)`), and reuses the last frame of its cached
   ones (`AnyView::from(entity).cached(style)`) unless they are dirty themselves.
3. A dirty cached view re-renders its whole subtree, the cached views inside it included.
4. An animation (`with_animation`) notifies the view that draws it, every frame.
5. A focus change, and the first key after the mouse (or mouse move after typing), refresh every view once.

So:

- Make a thing that changes on its own (a row with a spinner, the transcript, the running row) its own view, and
  mount it **cached** with a style that fixes its size (a cached view is laid out from that style alone, before it
  renders, so it cannot hug content).
- Do **not** cache a container whose descendants change often (the sidebar, the Chat column): rule 3 would rebuild
  everything in it. Keep it a plain view and keep its own render cheap: mostly cached children.
- Never put an animation inside a big view or a list's items. Give it a small view (see `chat/running.rs`) and
  turn motion off in tests with `ui::motion()`.
- Lists: `uniform_list` rows of one height can be cached views (`sidebar/mod.rs`: keep the views in a map by
  index and evict outside a fixed margin; `uniform_list` also asks for `0..1` to measure). `list()` items have
  their own heights and cannot be cached; keep their views quiet instead.
- A view mounted cached must fill its bounds (`size_full()`): it is laid out as a root, not as a flex child.

## Adding an icon

1. Find the name the desktop imports (`Search01Icon` in `apps/desktop/app/src`).
2. Add `"Search01"` to `ICONS` in `tools/gen-icons.mjs`.
3. Run `node tools/gen-icons.mjs [path/to/@hugeicons/core-free-icons]` (defaults to the repository's
   `node_modules`).
4. Use `Icon::new(IconName::Search01).size(IconSize::S16).color(theme.ink3)`. Sizes are 12, 14, 16, 18 with strokes
   1.6, 1.8, 1.8, 2 (DESIGN.md "Icons"). Commit the generated files with the change.

Other assets: put the file under `assets/` and rerun the script so `src/assets/embedded.rs` lists it. Provider marks:
`ProviderLogo::new(Provider::Claude)` (brand colours) or `.mono(color)`.

## Writing a headless test

```rust
#[gpui::test]
fn clicking_row_three_selects_it(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx); // or testing::mount_element(cx, |_, _| MyPrimitive::new())
    let row = testing::bounds(cx, "chat-row-3");          // an element's `debug_selector`, this frame
    cx.simulate_click(row.center(), Modifiers::none());
    let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
    assert_eq!(sidebar.read_with(cx, |s, _| s.selected()), Some(3));
}
```

- Give anything a test needs to find a `.debug_selector(|| "name".into())` (primitives use their element id).
- Assert state and geometry, not text metrics: the test platform's text system has fixed advances.
- Compute bounds into a local before `cx.simulate_click(..)` (two `&mut cx` borrows otherwise).
- `start_window_move` panics in the test platform; `chrome.rs` records the call under `cfg(test)` instead.
- Count renders (a `Cell` counter in `render`) to test that a change does not rebuild what it should not.

## Parallel agents: files and commits

- Each agent owns the files its task names, and creates new files rather than growing someone else's. Shared files
  (`lib.rs`, every `mod.rs`, `Cargo.toml`, `ui/mod.rs`'s list, `tools/gen-icons.mjs`'s `ICONS`) get **added lines
  only**: a `mod`, a `pub use`, a dependency, an icon name. Do not reorder or reformat them by hand; `cargo fmt`
  does what it does.
- Generated files (`src/ui/icon_name.rs`, `src/assets/embedded.rs`, `assets/hugeicons/`, `assets/logos/`) are only
  ever written by `tools/gen-icons.mjs`. If two agents add icons, the second reruns the script after rebasing.
- Commit in logical steps, `feat(experiments): ...` or `fix(experiments): ...`, adding files by path (never
  `git add -A` at the repository root). No AI attribution in commits. Never push or open a PR unless asked.
- Never edit outside `experiments/rust-gpui`. Never add Zed's GPL crates (`ui`, `editor`, `markdown`, `theme`, ...):
  see README.md "GPUI version decision".
- Upgrading GPUI: bump `gpui-pre`, `gpui-pre-platform` and `gpui-component` together (each gpui-component release pins
  one gpui-pre snapshot exactly).

## Verification

Run from `experiments/rust-gpui`, all of them, before every commit:

```sh
cargo fmt --check
cargo build                                   # no warnings from this crate
cargo clippy --all-targets -- -D warnings
cargo test
```

And when the change is visible, a snapshot in both themes, then look at it (the app draws, saves and quits by
itself; check with `pgrep -fl milagre-gpui-spike` that nothing is left running):

```sh
MILAGRE_GPUI_SNAPSHOT=/tmp/shot-dark.png cargo run
MILAGRE_GPUI_THEME=light MILAGRE_GPUI_SNAPSHOT=/tmp/shot-light.png cargo run
```

Snapshot mode never activates the window. AppKit may then report it occluded (or the display is asleep), and GPUI
stops drawing an occluded window after its first frames: anything a snapshot must show has to be ready before the
window opens (see the logo preload in `app.rs`). Markdown and `.mjs` files are formatted with the repository's
`oxfmt` (`npx oxfmt <file>`), which the pre-commit hook checks.
