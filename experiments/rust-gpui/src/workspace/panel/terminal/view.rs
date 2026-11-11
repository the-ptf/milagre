//! One Terminal on screen: its [`Session`], keyboard, mouse selection, wheel scrolling, copy and paste, and the PTY
//! resize that waits for the panel to hold still.
//!
//! The view notifies only itself when output arrives (at most once per drawn frame, see `session.rs`), and it is
//! mounted cached by the Terminal panel, so output repaints this view and the plain views on its path to the root,
//! never the sidebar's rows, the transcript's items or another tab's body.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use alacritty_terminal::event::Event;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use gpui::{
    ClipboardItem, Context, CursorStyle, EventEmitter, FocusHandle, Focusable, KeyBinding, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollEvent, SharedString, Task, Window, actions, anchored, deferred, div, prelude::*, px,
};

use super::colors::Palette;
use super::grid::{GridState, Metrics, TerminalGrid};
use super::keys::{self, KeyOptions, KeyRoute};
use super::session::{GridSize, Session};
use crate::theme::{ActiveTheme, RADIUS_CARD};
use crate::ui::{MenuList, MenuRow};

actions!(terminal, [Copy, Paste, CloseTerminal]);

/// The key context of a focused Terminal (`terminalFocus` in the desktop's keybindings).
pub const KEY_CONTEXT: &str = "Terminal";

/// xterm sends the PTY its size only once the panel has stopped moving (`PTY_RESIZE_MS` in `terminal-sessions.ts`).
pub const PTY_RESIZE: Duration = Duration::from_millis(100);

/// The body's padding around the grid (`px-2 pt-1.5 pb-1` in `TerminalPanel.tsx`).
pub const PAD_X: Pixels = px(8.0);
pub const PAD_TOP: Pixels = px(6.0);
pub const PAD_BOTTOM: Pixels = px(4.0);

pub enum TerminalEvent {
    /// The shell set another title.
    Title,
    /// The shell exited: the drawer drops the tab (`ended` in `terminal-sessions.ts`).
    Exited,
    /// ⌘W in this Terminal: the drawer ends it, asking first if a command runs.
    CloseRequested,
}

/// The right-click menu's width (`MENU_WIDTH` in `TerminalMenu.tsx`).
const MENU_WIDTH: Pixels = px(200.0);

pub struct TerminalView {
    pub(super) session: Session,
    focus: FocusHandle,
    grid: Rc<RefCell<GridState>>,
    title: SharedString,
    keys: KeyOptions,
    /// A drag selection is under way.
    selecting: bool,
    /// Wheel movement not yet a whole line.
    scroll_rest: f32,
    /// The pending PTY resize (dropped, and so cancelled, by a newer size).
    resize: Option<Task<()>>,
    /// Whether the PTY has been told a size yet: the first one goes at once.
    sized: bool,
    /// The right-click menu: where it opened and whether Copy is offered.
    menu: Option<(Point<Pixels>, bool)>,
    _events: Task<()>,
    renders: usize,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Copy, Paste and Close for a focused Terminal (⌘C, ⌘V, ⌘W), once per app.
pub fn install_keys(cx: &mut gpui::App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    cx.bind_keys([
        KeyBinding::new("cmd-c", Copy, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-v", Paste, Some(KEY_CONTEXT)),
        // `app:close-focused-terminal`: ⌘W ends the focused Terminal instead of closing the window.
        KeyBinding::new("cmd-w", CloseTerminal, Some(KEY_CONTEXT)),
    ]);
}

impl TerminalView {
    pub fn new(session: Session, cx: &mut Context<Self>) -> Self {
        install_keys(cx);
        let events = session.events.clone();
        let task = cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                let mut batch = vec![event];
                while let Ok(more) = events.try_recv() {
                    batch.push(more);
                }
                let alive = this.update(cx, |view, cx| {
                    for event in batch {
                        view.on_event(event, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        let title = session.shell_name.clone().into();
        Self {
            session,
            focus: cx.focus_handle(),
            grid: Rc::default(),
            title,
            keys: KeyOptions::default(),
            selecting: false,
            scroll_rest: 0.0,
            resize: None,
            sized: false,
            menu: None,
            _events: task,
            renders: 0,
        }
    }

    /// A shell in `cwd`, on a PTY of 80 by 24 until the grid is laid out.
    pub fn spawn(cwd: &Path, cx: &mut Context<Self>) -> std::io::Result<Self> {
        let session = Session::spawn(cwd, GridSize { cols: 80, lines: 24 }, (8, 15))?;
        Ok(Self::new(session, cx))
    }

    pub fn title(&self) -> SharedString {
        self.title.clone()
    }

    pub fn reset_title(&mut self, cx: &mut Context<Self>) {
        self.title = self.session.shell_name.clone().into();
        cx.emit(TerminalEvent::Title);
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn grid_state(&self) -> std::cell::Ref<'_, GridState> {
        self.grid.borrow()
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    fn on_event(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Wakeup => {
                self.session.woke();
                cx.notify();
            }
            Event::Title(title) => {
                self.title = title.into();
                cx.emit(TerminalEvent::Title);
            }
            Event::ResetTitle => {
                self.title = self.session.shell_name.clone().into();
                cx.emit(TerminalEvent::Title);
            }
            Event::PtyWrite(text) => self.session.write(text.into_bytes()),
            Event::ClipboardStore(_, text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            Event::ClipboardLoad(_, format) => {
                let text = cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default();
                self.session.write(format(&text).into_bytes());
            }
            Event::ColorRequest(index, format) => {
                let palette = Palette::from_theme(cx.theme());
                let color = {
                    let term = self.session.term.lock();
                    palette.resolve(alacritty_terminal::vte::ansi::Color::Indexed(index.min(255) as u8), term.colors())
                };
                let to = |c: f32| (c * 255.0).round() as u8;
                let rgb = alacritty_terminal::vte::ansi::Rgb { r: to(color.r), g: to(color.g), b: to(color.b) };
                self.session.write(format(rgb).into_bytes());
            }
            Event::TextAreaSizeRequest(format) => {
                let grid = self.grid.borrow();
                if let (Some(size), Some(metrics)) = (grid.size, grid.metrics) {
                    let window_size = alacritty_terminal::event::WindowSize {
                        num_lines: size.lines as u16,
                        num_cols: size.cols as u16,
                        cell_width: f32::from(metrics.cell_width) as u16,
                        cell_height: f32::from(metrics.line_height) as u16,
                    };
                    self.session.write(format(window_size).into_bytes());
                }
            }
            Event::ChildExit(_) | Event::Exit => cx.emit(TerminalEvent::Exited),
            Event::MouseCursorDirty | Event::CursorBlinkingChange | Event::Bell => {}
        }
    }

    /// The grid was laid out at `size`: reflow it now, tell the PTY after [`PTY_RESIZE`] of stillness.
    pub fn set_grid_size(&mut self, size: GridSize, metrics: Metrics, cx: &mut Context<Self>) {
        self.session.term.lock().resize(size);
        let cell = (f32::from(metrics.cell_width).round() as u16, f32::from(metrics.line_height) as u16);
        if !self.sized {
            self.sized = true;
            self.session.resize_pty(size, cell);
            return;
        }
        self.resize = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PTY_RESIZE).await;
            let _ = this.update(cx, |view, _| view.session.resize_pty(size, cell));
        }));
    }

    pub fn grid_size(&self) -> Option<GridSize> {
        self.grid.borrow().size
    }

    /// Sends typed bytes and brings the view back to the bottom, as xterm does on input.
    pub fn input(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let mut term = self.session.term.lock();
        if term.grid().display_offset() != 0 || term.selection.is_some() {
            term.scroll_display(Scroll::Bottom);
            term.selection = None;
            drop(term);
            cx.notify();
        } else {
            drop(term);
        }
        self.session.write(bytes);
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let mode = *self.session.term.lock().mode();
        match keys::encode(&event.keystroke, mode, self.keys) {
            KeyRoute::Shell(bytes) => {
                cx.stop_propagation();
                self.input(bytes, cx);
            }
            KeyRoute::App => {}
        }
    }

    /// The selection as text; clears it, so the next Ctrl+C interrupts (`copySelection`).
    pub fn copy(&mut self, cx: &mut Context<Self>) -> Option<String> {
        let text = {
            let mut term = self.session.term.lock();
            let text = term.selection_to_string().filter(|t| !t.is_empty());
            if text.is_some() {
                term.selection = None;
            }
            text
        };
        if let Some(text) = &text {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            cx.notify();
        }
        text
    }

    /// The clipboard's text into the program in front; with no text (an image) the program gets ^V and reads the
    /// clipboard itself (`paste` in `terminal-sessions.ts`).
    pub fn paste(&mut self, cx: &mut Context<Self>) {
        let text = cx.read_from_clipboard().and_then(|item| item.text()).filter(|t| !t.is_empty());
        let mode = *self.session.term.lock().mode();
        let bytes = match text {
            Some(text) => keys::paste_bytes(&text, mode),
            None => vec![0x16],
        };
        self.input(bytes, cx);
    }

    /// The grid point under a window position.
    fn point_at(&self, position: gpui::Point<Pixels>) -> Option<(GridPoint, Side)> {
        let grid = self.grid.borrow();
        let (metrics, size) = (grid.metrics?, grid.size?);
        let (line, col, right) = metrics.cell_at(position - grid.origin, size);
        let offset = self.session.term.lock().grid().display_offset() as i32;
        Some((GridPoint::new(Line(line as i32 - offset), Column(col)), if right { Side::Right } else { Side::Left }))
    }

    /// A right click: the Copy and Paste menu where it was pressed (`TerminalMenu.tsx`).
    fn on_right_down(&mut self, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let can_copy = self.session.term.lock().selection.as_ref().is_some_and(|s| !s.is_empty());
        self.menu = Some((event.position, can_copy));
        cx.stop_propagation();
        cx.notify();
    }

    pub fn menu_open(&self) -> bool {
        self.menu.is_some()
    }

    /// Closes the menu and gives the keyboard back to the Terminal.
    pub fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    fn menu(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let (position, can_copy) = self.menu?;
        let theme = *cx.theme();
        let view = cx.entity().downgrade();
        let run = move |action: fn(&mut TerminalView, &mut Context<TerminalView>)| {
            let view = view.clone();
            move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut gpui::App| {
                let _ = view.update(cx, |view, cx| {
                    action(view, cx);
                    view.close_menu(window, cx);
                });
            }
        };
        let list = MenuList::new("terminal-menu")
            .row(MenuRow::new("terminal-menu-copy", "Copy").trailing_shortcut("⌘C").disabled(!can_copy).on_click(run(|view, cx| {
                view.copy(cx);
            })))
            .row(MenuRow::new("terminal-menu-paste", "Paste").trailing_shortcut("⌘V").on_click(run(|view, cx| view.paste(cx))));
        let surface = div()
            .id("terminal-menu-surface")
            .debug_selector(|| "terminal-menu".to_string())
            .occlude()
            .w(MENU_WIDTH)
            .p(px(6.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| this.close_menu(window, cx)))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.close_menu(window, cx);
                }
            }))
            .child(list);
        Some(deferred(anchored().position(position).snap_to_window_with_margin(px(8.0)).child(surface)).with_priority(1))
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some((point, side)) = self.point_at(event.position) else { return };
        let kind = match event.click_count {
            2 => SelectionType::Semantic,
            n if n >= 3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        let mut term = self.session.term.lock();
        if event.modifiers.shift
            && let Some(selection) = term.selection.as_mut()
        {
            selection.update(point, side);
        } else {
            term.selection = Some(Selection::new(kind, point, side));
        }
        drop(term);
        self.selecting = true;
        cx.notify();
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some((point, side)) = self.point_at(event.position) else { return };
        if let Some(selection) = self.session.term.lock().selection.as_mut() {
            selection.update(point, side);
        }
        cx.notify();
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.selecting = false;
        let mut term = self.session.term.lock();
        if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
            term.selection = None;
            drop(term);
            cx.notify();
        }
    }

    /// Wheel: scrollback, or arrows for a full-screen program that asked for them (alternate scroll).
    pub fn scroll_lines(&mut self, lines: i32, cx: &mut Context<Self>) {
        if lines == 0 {
            return;
        }
        let mut term = self.session.term.lock();
        let mode = *term.mode();
        if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            drop(term);
            self.session.write(keys::scroll_arrows(lines, mode));
            return;
        }
        let before = term.grid().display_offset();
        term.scroll_display(Scroll::Delta(lines));
        let moved = term.grid().display_offset() != before;
        drop(term);
        if moved {
            cx.notify();
        }
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let line_height = self.grid.borrow().metrics.map_or(px(15.0), |m| m.line_height);
        self.scroll_rest += f32::from(event.delta.pixel_delta(line_height).y) / f32::from(line_height);
        let lines = self.scroll_rest.trunc() as i32;
        self.scroll_rest -= lines as f32;
        self.scroll_lines(lines, cx);
    }

    /// Lines of scrollback above the screen, and how far up the view is.
    pub fn scroll_position(&self) -> (usize, usize) {
        let term = self.session.term.lock();
        (term.grid().history_size(), term.grid().display_offset())
    }

    pub fn selection_text(&self) -> Option<String> {
        self.session.term.lock().selection_to_string()
    }

    pub fn screen_lines(&self) -> usize {
        self.session.term.lock().screen_lines()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let menu = self.menu(cx);
        let grid = TerminalGrid {
            view: cx.entity(),
            term: self.session.term.clone(),
            state: self.grid.clone(),
            palette: Palette::from_theme(&theme),
            focused: self.focus.is_focused(window),
        };
        div()
            .id("terminal-view")
            .debug_selector(|| "terminal-view".to_string())
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &Copy, _, cx| {
                this.copy(cx);
            }))
            .on_action(cx.listener(|this, _: &Paste, _, cx| this.paste(cx)))
            .on_action(cx.listener(|_, _: &CloseTerminal, _, cx| cx.emit(TerminalEvent::CloseRequested)))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_right_down))
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll))
            .cursor(CursorStyle::IBeam)
            .size_full()
            .overflow_hidden()
            .pl(PAD_X)
            .pr(PAD_X)
            .pt(PAD_TOP)
            .pb(PAD_BOTTOM)
            .bg(theme.surface)
            .child(div().debug_selector(|| "terminal-grid".to_string()).size_full().child(grid))
            .children(menu)
    }
}
