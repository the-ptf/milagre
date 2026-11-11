//! Terminal tests: key encoding, colour mapping, the frame the grid paints, selection and copy, wheel scrolling,
//! the PTY resize debounce, tabs, what output re-renders, and one real shell.

use std::time::Duration;

use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{
    Entity, Keystroke, Modifiers, MouseButton, ScrollDelta, ScrollEvent, TestAppContext, TouchPhase, VisualTestContext, point, px, rgb,
};

use super::colors::{DARK_ANSI, LIGHT_ANSI, Palette, xterm_256};
use super::grid::build_frame;
use super::keys::{KeyOptions, KeyRoute, control_byte, encode, paste_bytes, scroll_arrows};
use super::session::{GridSize, Session};
use super::view::{PTY_RESIZE, TerminalView};
use super::{Spawn, TerminalPanel};
use crate::testing;
use crate::theme::Theme;

// ---------------------------------------------------------------------------------------------- keys

fn key(source: &'static str) -> Vec<u8> {
    key_in(source, TermMode::default())
}

fn key_in(source: &'static str, mode: TermMode) -> Vec<u8> {
    match encode(&Keystroke::parse(source).expect("a keystroke"), mode, KeyOptions::default()) {
        KeyRoute::Shell(bytes) => bytes,
        KeyRoute::App => panic!("{source} went to the app"),
    }
}

#[test]
fn arrows_follow_application_cursor_mode() {
    assert_eq!(key("up"), b"\x1b[A");
    assert_eq!(key("left"), b"\x1b[D");
    assert_eq!(key_in("up", TermMode::APP_CURSOR), b"\x1bOA");
    assert_eq!(key_in("home", TermMode::APP_CURSOR), b"\x1bOH");
    assert_eq!(key("end"), b"\x1b[F");
}

#[test]
fn modified_named_keys_carry_the_xterm_parameter() {
    assert_eq!(key("shift-up"), b"\x1b[1;2A");
    assert_eq!(key("alt-right"), b"\x1b[1;3C");
    assert_eq!(key("ctrl-left"), b"\x1b[1;5D");
    assert_eq!(key_in("ctrl-shift-up", TermMode::APP_CURSOR), b"\x1b[1;6A", "a modifier wins over application mode");
    assert_eq!(key("pageup"), b"\x1b[5~");
    assert_eq!(key("shift-pagedown"), b"\x1b[6;2~");
    assert_eq!(key("delete"), b"\x1b[3~");
    assert_eq!(key("insert"), b"\x1b[2~");
}

#[test]
fn function_keys() {
    assert_eq!(key("f1"), b"\x1bOP");
    assert_eq!(key("f4"), b"\x1bOS");
    assert_eq!(key("shift-f1"), b"\x1b[1;2P");
    assert_eq!(key("f5"), b"\x1b[15~");
    assert_eq!(key("f10"), b"\x1b[21~");
    assert_eq!(key("f12"), b"\x1b[24~");
    assert_eq!(key("ctrl-f12"), b"\x1b[24;5~");
}

#[test]
fn control_combinations_are_c0_bytes() {
    assert_eq!(key("ctrl-c"), [0x03]);
    assert_eq!(key("ctrl-a"), [0x01]);
    assert_eq!(key("ctrl-z"), [0x1a]);
    assert_eq!(key("ctrl-["), [0x1b]);
    assert_eq!(key("ctrl-\\"), [0x1c]);
    assert_eq!(key("ctrl-space"), [0x00]);
    assert_eq!(key("ctrl-alt-c"), [0x1b, 0x03]);
    assert_eq!(control_byte('/', false), Some(0x1f));
    assert_eq!(control_byte('8', false), Some(0x7f));
    assert_eq!(control_byte('=', false), None);
}

#[test]
fn alt_is_meta_and_plain_keys_type() {
    assert_eq!(key("alt-b"), b"\x1bb");
    assert_eq!(key("alt-shift-a"), b"\x1bA");
    assert_eq!(key("alt-enter"), b"\x1b\r");
    assert_eq!(key("alt-backspace"), b"\x1b\x7f");
    assert_eq!(key("a"), b"a");
    assert_eq!(key("enter"), b"\r");
    assert_eq!(key("backspace"), [0x7f]);
    assert_eq!(key("ctrl-backspace"), [0x08]);
    assert_eq!(key("tab"), b"\t");
    assert_eq!(key("shift-tab"), b"\x1b[Z");
    assert_eq!(key("escape"), b"\x1b");
    // Option composing a character when Meta is off (xterm.js `macOptionIsMeta: false`).
    let composed = Keystroke { modifiers: Modifiers { alt: true, ..Modifiers::default() }, key: "e".into(), key_char: Some("´".into()) };
    assert_eq!(encode(&composed, TermMode::default(), KeyOptions { option_as_meta: false }), KeyRoute::Shell("´".as_bytes().to_vec()));
    let typed = Keystroke { modifiers: Modifiers::default(), key: "e".into(), key_char: Some("é".into()) };
    assert_eq!(encode(&typed, TermMode::default(), KeyOptions::default()), KeyRoute::Shell("é".as_bytes().to_vec()));
}

#[test]
fn command_keys_belong_to_the_app() {
    for source in ["cmd-c", "cmd-v", "cmd-t", "cmd-shift-up"] {
        assert_eq!(encode(&Keystroke::parse(source).unwrap(), TermMode::default(), KeyOptions::default()), KeyRoute::App, "{source}");
    }
}

#[test]
fn paste_is_bracketed_when_asked_and_newlines_are_returns() {
    assert_eq!(paste_bytes("a\nb\r\nc", TermMode::default()), b"a\rb\rc");
    assert_eq!(paste_bytes("ls\x1b[201~", TermMode::BRACKETED_PASTE), b"\x1b[200~ls[201~\x1b[201~");
    assert_eq!(scroll_arrows(2, TermMode::default()), b"\x1b[A\x1b[A");
    assert_eq!(scroll_arrows(-1, TermMode::APP_CURSOR), b"\x1bOB");
}

// ---------------------------------------------------------------------------------------------- colours

#[test]
fn the_256_colour_table_is_xterms() {
    assert_eq!(xterm_256(16), 0x000000);
    assert_eq!(xterm_256(21), 0x0000ff);
    assert_eq!(xterm_256(196), 0xff0000);
    assert_eq!(xterm_256(202), 0xff5f00);
    assert_eq!(xterm_256(231), 0xffffff);
    assert_eq!(xterm_256(232), 0x080808);
    assert_eq!(xterm_256(255), 0xeeeeee);
}

#[test]
fn palettes_follow_the_theme() {
    let dark = Palette::from_theme(&Theme::dark());
    let light = Palette::from_theme(&Theme::light());
    assert_eq!(dark.ansi[1], rgb(DARK_ANSI[1]));
    assert_eq!(dark.ansi[1], rgb(0xff7b72), "Milagre Blue dark red");
    assert_eq!(light.ansi[4], rgb(LIGHT_ANSI[4]));
    assert_eq!(light.ansi[4], rgb(0x0969da), "Milagre Blue light blue");
    assert_eq!(dark.foreground, Theme::dark().ink);
    assert_eq!(dark.cursor, Theme::dark().ink);
    assert_eq!(dark.cursor_accent, Theme::dark().surface);
    assert_eq!(dark.selection.a, 0.3);
    assert_eq!(
        (dark.selection.r, dark.selection.g, dark.selection.b),
        (Theme::dark().accent.r, Theme::dark().accent.g, Theme::dark().accent.b)
    );
}

fn cell(fg: Color, bg: Color, flags: Flags) -> Cell {
    Cell { c: 'x', fg, bg, flags, extra: None }
}

#[test]
fn cell_attributes_change_its_colours() {
    let palette = Palette::from_theme(&Theme::dark());
    let none = Colors::default();
    let fg = |c: &Cell| palette.cell(c, &none).fg;
    let bg = |c: &Cell| palette.cell(c, &none).bg;
    let default = NamedColor::Background;
    let plain = cell(Color::Named(NamedColor::Red), Color::Named(default), Flags::empty());
    assert_eq!(fg(&plain), rgb(0xff7b72).into());
    assert_eq!(bg(&plain), None, "the default background is the panel's");
    let bold = cell(Color::Named(NamedColor::Red), Color::Named(default), Flags::BOLD);
    assert_eq!(fg(&bold), rgb(0xffa198).into(), "bold draws in the bright colour");
    let indexed = cell(Color::Indexed(202), Color::Spec(Rgb { r: 1, g: 2, b: 3 }), Flags::empty());
    assert_eq!(fg(&indexed), rgb(0xff5f00).into());
    assert_eq!(bg(&indexed), Some(rgb(0x010203).into()));
    let inverse = cell(Color::Named(NamedColor::Foreground), Color::Named(default), Flags::INVERSE);
    assert_eq!(fg(&inverse), Theme::dark().surface.into(), "inverse on the default background writes in the surface");
    assert_eq!(bg(&inverse), Some(Theme::dark().ink.into()));
    let dim = cell(Color::Named(NamedColor::Green), Color::Named(default), Flags::DIM);
    assert_eq!(fg(&dim).a, 0.5);
    let hidden = cell(Color::Named(NamedColor::Green), Color::Named(default), Flags::HIDDEN);
    assert_eq!(fg(&hidden).a, 0.0);
    let mut set = Colors::default();
    set[1] = Some(Rgb { r: 0x12, g: 0x34, b: 0x56 });
    assert_eq!(palette.cell(&plain, &set).fg, rgb(0x123456).into(), "a colour the program set (OSC 4) wins");
}

// ---------------------------------------------------------------------------------------------- frame and selection

fn session(cols: usize, lines: usize, bytes: &[u8]) -> Session {
    let session = Session::detached(GridSize { cols, lines });
    session.feed(bytes);
    session
}

#[test]
fn a_frame_holds_text_runs_backgrounds_and_the_cursor() {
    let palette = Palette::from_theme(&Theme::dark());
    let s = session(20, 4, b"\x1b[31mred\x1b[0m plain\r\n\x1b[44m   \x1b[0m\x1b[42m \x1b[0m");
    let frame = build_frame(&s.term.lock(), &palette, true);
    assert_eq!(frame.rows.len(), 4);
    assert_eq!(frame.rows[0].text, "red plain", "trailing blanks are dropped");
    assert_eq!(frame.rows[0].runs.len(), 2);
    assert_eq!(frame.rows[0].runs[0].len, 3);
    assert_eq!(frame.rows[0].runs[0].fg, rgb(0xff7b72).into());
    assert_eq!(frame.rows[2].text, "");
    let backgrounds: Vec<_> = frame.backgrounds.iter().map(|s| (s.line, s.col, s.cols)).collect();
    assert_eq!(backgrounds, vec![(1, 0, 3), (1, 3, 1)], "same-colour cells merge into one rect");
    let cursor = frame.cursor.expect("a cursor");
    assert_eq!((cursor.line, cursor.col), (1, 4));
    // A row's hash changes with its content and only then.
    let again = build_frame(&s.term.lock(), &palette, true);
    assert_eq!(again.rows[0].hash, frame.rows[0].hash);
    s.feed(b"\x1b[1;1Hb");
    assert_ne!(build_frame(&s.term.lock(), &palette, true).rows[0].hash, frame.rows[0].hash);
}

#[test]
fn a_block_cursor_writes_its_glyph_in_the_accent_only_when_focused() {
    let palette = Palette::from_theme(&Theme::dark());
    let s = session(10, 2, b"ab\x1b[1;1H");
    let focused = build_frame(&s.term.lock(), &palette, true);
    assert_eq!(focused.rows[0].runs[0].fg, palette.cursor_accent.into());
    assert_eq!(focused.rows[0].runs[0].len, 1);
    let blurred = build_frame(&s.term.lock(), &palette, false);
    assert_eq!(blurred.rows[0].runs.len(), 1, "unfocused, the glyph keeps its colour");
    assert_eq!(blurred.cursor.unwrap().shape, alacritty_terminal::vte::ansi::CursorShape::HollowBlock);
}

#[test]
fn wide_characters_keep_the_columns_after_them() {
    let palette = Palette::from_theme(&Theme::dark());
    let s = session(10, 1, "日x".as_bytes());
    let frame = build_frame(&s.term.lock(), &palette, false);
    assert_eq!(frame.rows[0].text, "日 x", "the spacer cell is a space, so x lands in column 2");
}

fn grid_point(line: i32, col: usize) -> GridPoint {
    GridPoint::new(Line(line), Column(col))
}

#[test]
fn selections_read_and_paint_their_cells() {
    let palette = Palette::from_theme(&Theme::dark());
    let s = session(20, 3, b"hello world\r\nsecond line");
    let mut term = s.term.lock();
    let mut selection = Selection::new(SelectionType::Simple, grid_point(0, 0), Side::Left);
    selection.update(grid_point(0, 4), Side::Right);
    term.selection = Some(selection);
    assert_eq!(term.selection_to_string().as_deref(), Some("hello"));
    let frame = build_frame(&term, &palette, false);
    let spans: Vec<_> = frame.selection.iter().map(|s| (s.line, s.col, s.cols)).collect();
    assert_eq!(spans, vec![(0, 0, 5)]);

    term.selection = Some(Selection::new(SelectionType::Semantic, grid_point(0, 8), Side::Left));
    assert_eq!(term.selection_to_string().as_deref(), Some("world"), "a double click takes the word");
    term.selection = Some(Selection::new(SelectionType::Lines, grid_point(1, 3), Side::Left));
    assert_eq!(term.selection_to_string().as_deref(), Some("second line\n"), "a triple click takes the line");

    let mut across = Selection::new(SelectionType::Simple, grid_point(0, 6), Side::Left);
    across.update(grid_point(1, 5), Side::Right);
    term.selection = Some(across);
    assert_eq!(term.selection_to_string().as_deref(), Some("world\nsecond"));
}

// ---------------------------------------------------------------------------------------------- the view

fn mount(cx: &mut TestAppContext) -> (Entity<TerminalPanel>, &mut VisualTestContext) {
    let (panel, cx) = testing::mount_in_root(cx, |_, cx| TerminalPanel::with_spawn(Spawn::Detached, cx));
    cx.run_until_parked();
    (panel, cx)
}

fn active(panel: &Entity<TerminalPanel>, cx: &mut VisualTestContext) -> Entity<TerminalView> {
    panel.read_with(cx, |p, _| p.active_terminal()).expect("a Terminal")
}

fn feed(view: &Entity<TerminalView>, bytes: &[u8], cx: &mut VisualTestContext) {
    view.update(cx, |v, cx| {
        v.session().feed(bytes);
        cx.notify();
    });
    cx.run_until_parked();
}

fn written(view: &Entity<TerminalView>, cx: &mut VisualTestContext) -> Vec<u8> {
    view.read_with(cx, |v, _| std::mem::take(&mut v.session().record.lock().unwrap().input))
}

#[gpui::test]
fn the_tab_opens_one_terminal_sized_to_its_bounds(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    assert_eq!(panel.read_with(cx, |p, _| p.terminals().len()), 1, "the first Terminal opens when the tab shows");
    let view = active(&panel, cx);
    let grid = view.read_with(cx, |v, _| v.grid_size()).expect("laid out");
    let term_cols = view.read_with(cx, |v, _| {
        use alacritty_terminal::grid::Dimensions;
        v.session().term.lock().columns()
    });
    assert_eq!(term_cols, grid.cols, "the grid reflowed to the element's width");
    assert!(grid.cols > 20 && grid.lines > 5, "{grid:?}");
    assert!(cx.debug_bounds("terminal-tab-0").is_some());
}

#[gpui::test]
fn typing_goes_to_the_shell_and_command_keys_do_not(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    let grid = cx.debug_bounds("terminal-grid").expect("the grid").center();
    cx.simulate_click(grid, Modifiers::none());
    written(&view, cx);
    cx.simulate_keystrokes("l s enter ctrl-c up alt-b");
    assert_eq!(written(&view, cx), b"ls\r\x03\x1b[A\x1bb");
}

#[gpui::test]
fn dragging_selects_and_cmd_c_copies_then_clears(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    feed(&view, b"hello world", cx);
    let origin = cx.debug_bounds("terminal-grid").expect("the grid").origin;
    let (cell_w, line_h) = view.read_with(cx, |v, _| {
        let m = v.grid_state().metrics.unwrap();
        (m.cell_width, m.line_height)
    });
    let at = |col: f32| point(origin.x + cell_w * col, origin.y + line_h * 0.5);
    cx.simulate_mouse_down(at(0.1), MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(at(3.0), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_move(at(4.9), Some(MouseButton::Left), Modifiers::none());
    cx.simulate_mouse_up(at(4.9), MouseButton::Left, Modifiers::none());
    assert_eq!(view.read_with(cx, |v, _| v.selection_text()).as_deref(), Some("hello"));
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some("hello"));
    assert_eq!(view.read_with(cx, |v, _| v.selection_text()), None, "copying clears the selection");
    assert!(written(&view, cx).is_empty(), "⌘C sends nothing to the shell");
}

#[gpui::test]
fn cmd_v_pastes_bracketed_when_the_program_asks(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    let grid = cx.debug_bounds("terminal-grid").expect("the grid").center();
    cx.simulate_click(grid, Modifiers::none());
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("echo hi\n".into()));
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(written(&view, cx), b"echo hi\r");
    feed(&view, b"\x1b[?2004h", cx);
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(written(&view, cx), b"\x1b[200~echo hi\n\x1b[201~");
}

#[gpui::test]
fn the_wheel_scrolls_back_and_typing_returns_to_the_bottom(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    let lines: String = (0..200).map(|i| format!("line {i}\r\n")).collect();
    feed(&view, lines.as_bytes(), cx);
    assert!(view.read_with(cx, |v, _| v.scroll_position().0) > 100, "scrollback keeps what scrolled off");
    let grid = cx.debug_bounds("terminal-grid").expect("the grid").center();
    let shaped = |cx: &mut VisualTestContext| view.read_with(cx, |v, _| v.grid_state().shaped_rows);
    let before = shaped(cx);
    cx.simulate_event(ScrollEvent {
        position: grid,
        delta: ScrollDelta::Lines(point(0.0, 5.0)),
        modifiers: Modifiers::none(),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    });
    cx.run_until_parked();
    assert_eq!(view.read_with(cx, |v, _| v.scroll_position().1), 5, "five lines up");
    assert!(shaped(cx) - before <= 5, "only the five rows that came into view are shaped");
    cx.simulate_click(grid, Modifiers::none());
    cx.simulate_keystrokes("a");
    assert_eq!(view.read_with(cx, |v, _| v.scroll_position().1), 0, "typing scrolls to the bottom");
}

#[gpui::test]
fn the_pty_hears_a_new_size_only_after_it_holds_still(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    let sizes = |cx: &mut VisualTestContext| view.read_with(cx, |v, _| v.session().record.lock().unwrap().sizes.clone());
    assert_eq!(sizes(cx).len(), 1, "the first size goes at once");
    let before = view.read_with(cx, |v, _| v.grid_size()).unwrap();
    for width in [900.0, 860.0, 820.0] {
        cx.simulate_resize(gpui::size(px(width), px(500.0)));
        cx.run_until_parked();
    }
    let after = view.read_with(cx, |v, _| v.grid_size()).unwrap();
    assert_ne!(after, before, "the grid follows the window at once");
    assert_eq!(sizes(cx).len(), 1, "no PTY resize while the size moves");
    cx.executor().advance_clock(PTY_RESIZE + Duration::from_millis(10));
    cx.run_until_parked();
    assert_eq!(sizes(cx), vec![sizes(cx)[0], after], "one resize, to the size it settled on");
}

#[gpui::test]
fn tabs_add_show_and_close(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let plus = cx.debug_bounds("terminal-new").expect("+").center();
    cx.simulate_click(plus, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| (p.terminals().len(), p.active_index())), (2, 1));
    let first = cx.debug_bounds("terminal-tab-0").expect("tab 0").center();
    cx.simulate_click(first, Modifiers::none());
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| p.active_index()), 0);
    // ⌘T in a focused Terminal opens another.
    cx.simulate_keystrokes("cmd-t");
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| p.terminals().len()), 3);
    let shown = active(&panel, cx);
    panel.update(cx, |p, cx| {
        let id = p.tabs.iter().find(|t| t.view == shown).unwrap().id;
        p.close(id, cx)
    });
    cx.run_until_parked();
    assert_eq!(panel.read_with(cx, |p, _| (p.terminals().len(), p.active_index())), (2, 1));
}

#[gpui::test]
fn a_shell_title_names_its_tab(cx: &mut TestAppContext) {
    let (panel, cx) = mount(cx);
    let view = active(&panel, cx);
    let before = panel.read_with(cx, |p, _| p.renders());
    view.update(cx, |v, _| {
        // The emulator reports the OSC 2 title as an event, which is what a real shell's output would do.
        v.session().feed(b"\x1b]2;vim notes.md\x07");
    });
    cx.run_until_parked();
    assert_eq!(view.read_with(cx, |v, _| v.title()).as_ref(), "vim notes.md");
    assert!(panel.read_with(cx, |p, _| p.renders()) > before, "the header shows the new title");
}

/// Output (and typing) repaint the Terminal and the plain views on its path, never the sidebar's rows or the
/// transcript's items.
#[gpui::test]
fn output_repaints_only_the_terminal(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, chat, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.chat.clone(), w.panel.clone()));
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    let tab = cx.debug_bounds("panel-tab-Terminal").expect("Terminal tab").center();
    cx.simulate_click(tab, Modifiers::none());
    cx.run_until_parked();
    let terminals = panel
        .read_with(cx, |p, _| p.body_view(crate::workspace::panel::PanelTab::Terminal))
        .and_then(|v| v.downcast::<TerminalPanel>().ok())
        .expect("the Terminal tab's body");
    let view = active(&terminals, cx);
    let grid = cx.debug_bounds("terminal-grid").expect("the grid").center();
    cx.simulate_click(grid, Modifiers::none());
    cx.simulate_keystrokes("a"); // the first key after the mouse refreshes every view once
    cx.run_until_parked();
    let counts = |cx: &mut VisualTestContext| {
        (
            transcript.read_with(cx, |t, _| t.item_renders()),
            sidebar.read_with(cx, |s, _| s.rows_built()),
            panel.read_with(cx, |p, _| p.renders()),
            terminals.read_with(cx, |t, _| t.renders()),
            view.read_with(cx, |v, _| v.renders()),
        )
    };
    let before = counts(cx);
    for i in 0..5 {
        feed(&view, format!("output {i}\r\n").as_bytes(), cx);
    }
    cx.simulate_keystrokes("b c");
    cx.run_until_parked();
    let after = counts(cx);
    assert_eq!((after.0, after.1), (before.0, before.1), "no transcript item and no sidebar row is rebuilt");
    assert!(after.4 >= before.4 + 5, "the Terminal itself repainted");
    // GPUI re-renders every view on the notifying view's path (CONVENTIONS.md rule 1): the panel and the tab
    // header do run, once per frame, and are cheap; the sidebar and Chat column stay on their cached children.
    assert!(after.2 - before.2 <= after.4 - before.4 && after.3 - before.3 <= after.4 - before.4, "at most once per Terminal frame");
}

/// A real login-free shell on a PTY: output reaches the grid and the exit closes the tab.
#[gpui::test]
fn a_real_shell_runs_and_exits(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = std::env::temp_dir();
    let session = Session::spawn(&dir, GridSize { cols: 40, lines: 5 }, (8, 15)).expect("a PTY");
    assert!(session.has_shell());
    session.write(b"printf 'milagre-%s\\n' ok; exit\r".to_vec());
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut seen = String::new();
    while std::time::Instant::now() < deadline {
        let term = session.term.lock();
        use alacritty_terminal::grid::Dimensions;
        seen = (0..term.screen_lines() as i32).map(|line| super::grid::grid_text(&term, line, 0..=39)).collect::<Vec<_>>().join("\n");
        drop(term);
        if seen.contains("milagre-ok") {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(seen.contains("milagre-ok"), "the shell's output reached the grid:\n{seen}");
}
