//! The Terminals drawer under the Chat (WP-33, P-11; `TerminalPanel.tsx`): each Chat's Terminals as tabs in a 36px
//! header (title, close, New Terminal, Hide), the shown one's grid below, in a card that rises from the window's bottom
//! edge. Each Terminal is a local login shell in the Worktree on its own PTY (`session.rs`), parsed by
//! `alacritty_terminal` and painted by our own grid element (`grid.rs`).
//!
//! - Per Chat: which Terminals it has, the one shown and whether its drawer is open ([`TerminalDrawer::set_chat`],
//!   driven by the Workspace from the sidebar's selection). The height is one for every Chat (`TERMINAL_HEIGHT`).
//! - ⌘J shows or hides the drawer, opening the first Terminal when the Chat has none; ⌘T opens another; ⌘W in a
//!   Terminal ends it. Ending one that runs a command asks first (the tab's close turns into "End <title>").
//! - The drawer is a cached view of fixed height and each Terminal a cached view inside it, so output repaints only
//!   the Terminal and the plain views on its path.
//!
//! Not built: the slide (`TerminalSlide.tsx` springs the slot open), the shell select, the Worktree choice of a
//! shared Chat, and a saved height.
//!
//! Snapshot and bench seeds (never in tests): `MILAGRE_GPUI_TERMINAL_RUN="<command>"` opens the drawer and types
//! the command into its first Terminal once the shell is up; `MILAGRE_GPUI_TERMINAL_BENCH=1` then times it (frames,
//! prepaint time) and prints to stderr; `MILAGRE_GPUI_TERMINAL_SNAPSHOT=<png>` saves the window when it ends and quits.

pub mod colors;
pub mod grid;
pub mod keys;
pub mod session;
pub mod view;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, AnyView, App, ClickEvent, Context, DragMoveEvent, Entity, Focusable, InteractiveElement, IntoElement, KeyBinding,
    SharedString, StyleRefinement, Subscription, Window, actions, div, prelude::*, px,
};

use self::session::{GridSize, Session};
use self::view::{TerminalEvent, TerminalView};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TextStepExt, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconButton, IconButtonSize, IconName, IconSize};
use crate::workspace::panel::dock::ToggleTerminal;

actions!(terminal, [NewTerminal]);

/// The drawer's height (`TERMINAL_HEIGHT` in `terminal-store.ts`): 280 at first, at least 120, at most 75% of the
/// column (`TerminalPanel.tsx` `startResize`).
pub const HEIGHT_INITIAL: f32 = 280.0;
pub const HEIGHT_MIN: f32 = 120.0;
pub const HEIGHT_MAX_SHARE: f32 = 0.75;
/// The gap between the Chat and the card (`GAP` in `TerminalSlide.tsx`).
pub const GAP: f32 = 8.0;
/// The card's inset from the column's right and bottom edges (the desktop's `main` has `pr-3 pb-3`).
pub const INSET: f32 = 12.0;
/// The header's height (`h-9`) and padding (`px-1.5`), a tab's height (`h-7`) and widest (`max-w-[200px]`).
pub const HEADER_HEIGHT: gpui::Pixels = px(36.0);
const HEADER_PAD: gpui::Pixels = px(6.0);
const TAB_HEIGHT: gpui::Pixels = px(28.0);
const TAB_MAX_WIDTH: gpui::Pixels = px(200.0);
/// The resize handle over the card's top edge (`inset-x-3 -top-1.5 h-2`).
const HANDLE_INSET: gpui::Pixels = px(12.0);
const HANDLE_HEIGHT: gpui::Pixels = px(8.0);

/// How Terminals are made: a real shell, or (in tests) an emulator with nothing behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Spawn {
    Shell,
    Detached,
}

struct Tab {
    id: usize,
    view: Entity<TerminalView>,
    _events: Subscription,
}

/// One Chat's Terminals (`ChatTerminals` in `terminal-store.ts`).
#[derive(Default)]
struct ChatTerminals {
    tabs: Vec<Tab>,
    active: usize,
    open: bool,
}

/// What a drag on the resize handle carries.
struct Resize;

struct DragGhost;

impl Render for DragGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

pub struct TerminalDrawer {
    chat: SharedString,
    chats: HashMap<SharedString, ChatTerminals>,
    height: f32,
    next_id: usize,
    cwd: PathBuf,
    spawn: Spawn,
    /// The tab whose close asked "End <title>?": a second close ends it.
    armed: Option<usize>,
    seeded: bool,
    error: Option<SharedString>,
    renders: usize,
}

/// ⌘T for New Terminal, once per app (`terminal.new`, `mod+t`).
pub fn install_keys(cx: &mut App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    cx.bind_keys([KeyBinding::new("cmd-t", NewTerminal, None)]);
    view::install_keys(cx);
}

/// Hooks ⌘J and ⌘T onto `element` (the Workspace root), so they work wherever focus is.
pub fn on_actions<E: InteractiveElement>(element: E, drawer: &Entity<TerminalDrawer>) -> E {
    let (toggle, new) = (drawer.clone(), drawer.clone());
    element
        .on_action(move |_: &ToggleTerminal, window, cx| toggle.update(cx, |drawer, cx| drawer.toggle(window, cx)))
        .on_action(move |_: &NewTerminal, window, cx| new.update(cx, |drawer, cx| drawer.new_terminal(window, cx)))
}

/// The Chat column with the drawer under it when the Chat on screen has it open.
pub fn column(chat: impl IntoElement, drawer: &Entity<TerminalDrawer>, window: &Window, cx: &App) -> AnyElement {
    let (open, height) = {
        let d = drawer.read(cx);
        (d.is_open(), d.height)
    };
    let room = f32::from(window.viewport_size().height) * HEIGHT_MAX_SHARE;
    let slot = GAP + height.min(room).max(HEIGHT_MIN) + INSET;
    div()
        .flex()
        .flex_col()
        .size_full()
        .min_w_0()
        .child(div().flex_1().min_h_0().child(chat))
        .when(open, |el| {
            el.child(
                div().flex_none().w_full().h(px(slot)).child(AnyView::from(drawer.clone()).cached(StyleRefinement::default().size_full())),
            )
        })
        .into_any_element()
}

impl TerminalDrawer {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self::with_spawn(if cfg!(test) { Spawn::Detached } else { Spawn::Shell }, cx)
    }

    pub fn with_spawn(spawn: Spawn, cx: &mut Context<Self>) -> Self {
        install_keys(cx);
        Self {
            chat: SharedString::default(),
            chats: HashMap::new(),
            height: HEIGHT_INITIAL,
            next_id: 1,
            cwd: session::default_cwd(),
            spawn,
            armed: None,
            seeded: false,
            error: None,
            renders: 0,
        }
    }

    /// The bench and snapshot seed opens the drawer once the window's first Chat is known.
    fn seed(&mut self, cx: &mut Context<Self>) {
        if self.seeded || cfg!(test) || self.spawn != Spawn::Shell || std::env::var_os("MILAGRE_GPUI_TERMINAL_RUN").is_none() {
            return;
        }
        self.seeded = true;
        if let Some(view) = self.add(cx) {
            self.seed_from_env(&view, cx);
        }
    }

    fn current(&self) -> Option<&ChatTerminals> {
        self.chats.get(&self.chat)
    }

    fn current_mut(&mut self) -> &mut ChatTerminals {
        self.chats.entry(self.chat.clone()).or_default()
    }

    pub fn chat(&self) -> &str {
        &self.chat
    }

    pub fn is_open(&self) -> bool {
        self.current().is_some_and(|c| c.open)
    }

    pub fn height(&self) -> f32 {
        self.height
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn terminals(&self) -> Vec<Entity<TerminalView>> {
        self.current().map(|c| c.tabs.iter().map(|tab| tab.view.clone()).collect()).unwrap_or_default()
    }

    pub fn active_terminal(&self) -> Option<Entity<TerminalView>> {
        self.current().and_then(|c| c.tabs.get(c.active)).map(|tab| tab.view.clone())
    }

    pub fn active_index(&self) -> usize {
        self.current().map_or(0, |c| c.active)
    }

    /// Whether the tab `index` asks to be ended (its close became "End <title>").
    pub fn asking(&self, index: usize) -> bool {
        self.current().and_then(|c| c.tabs.get(index)).is_some_and(|tab| Some(tab.id) == self.armed)
    }

    /// Shows `chat`'s Terminals (and its drawer, if it had it open). Its shells keep running while out of sight.
    pub fn set_chat(&mut self, chat: SharedString, cx: &mut Context<Self>) {
        if chat == self.chat {
            return;
        }
        self.chat = chat;
        self.armed = None;
        self.seed(cx);
        cx.notify();
    }

    /// ⌘J: hides the drawer, shows it again, or opens the first Terminal when the Chat has none.
    pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let has = !self.terminals().is_empty();
        let current = self.current_mut();
        if current.open {
            current.open = false;
            self.armed = None;
            cx.notify();
        } else if has {
            current.open = true;
            self.focus_active(window, cx);
            cx.notify();
        } else {
            self.new_terminal(window, cx);
        }
    }

    pub fn hide(&mut self, cx: &mut Context<Self>) {
        self.current_mut().open = false;
        self.armed = None;
        cx.notify();
    }

    /// Opens a Terminal in this Chat, shows the drawer and gives it the keyboard.
    pub fn new_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.add(cx).is_some() {
            self.focus_active(window, cx);
        }
    }

    pub fn add(&mut self, cx: &mut Context<Self>) -> Option<Entity<TerminalView>> {
        let detached = |cx: &mut Context<TerminalView>| TerminalView::new(Session::detached(GridSize { cols: 80, lines: 24 }), cx);
        let view = match self.spawn {
            Spawn::Shell => {
                let cwd = self.cwd.clone();
                let mut failure = None;
                let view = cx.new(|cx| match TerminalView::spawn(&cwd, cx) {
                    Ok(view) => view,
                    Err(error) => {
                        failure = Some(error.to_string());
                        detached(cx)
                    }
                });
                if let Some(error) = failure {
                    self.error = Some(format!("Couldn't open a Terminal: {error}").into());
                    cx.notify();
                    return None;
                }
                view
            }
            Spawn::Detached => cx.new(detached),
        };
        let id = self.next_id;
        self.next_id += 1;
        let chat = self.chat.clone();
        let events = cx.subscribe(&view, move |this, _, event, cx| match event {
            TerminalEvent::Title => cx.notify(),
            TerminalEvent::Exited => this.remove(&chat, id, cx),
            TerminalEvent::CloseRequested => this.request_close(id, cx),
        });
        let current = self.current_mut();
        current.tabs.push(Tab { id, view: view.clone(), _events: events });
        current.active = current.tabs.len() - 1;
        current.open = true;
        self.armed = None;
        self.error = None;
        cx.notify();
        Some(view)
    }

    pub fn show(&mut self, index: usize, cx: &mut Context<Self>) {
        let current = self.current_mut();
        if index < current.tabs.len() && index != current.active {
            current.active = index;
            self.armed = None;
            cx.notify();
        }
    }

    /// The tab's close or ⌘W: ends the Terminal, or, while a command runs in it, asks first; asking again ends it.
    pub fn request_close(&mut self, id: usize, cx: &mut Context<Self>) {
        let busy = self.current().and_then(|c| c.tabs.iter().find(|tab| tab.id == id)).and_then(|tab| tab.view.read(cx).session().busy());
        if busy.is_some() && self.armed != Some(id) {
            self.armed = Some(id);
            if let Some(index) = self.current().and_then(|c| c.tabs.iter().position(|tab| tab.id == id)) {
                self.current_mut().active = index;
            }
            cx.notify();
            return;
        }
        let chat = self.chat.clone();
        self.remove(&chat, id, cx);
    }

    /// Ends a Terminal (its shell gets SIGHUP) and shows its neighbour; the drawer closes with the last one.
    fn remove(&mut self, chat: &SharedString, id: usize, cx: &mut Context<Self>) {
        let Some(terminals) = self.chats.get_mut(chat) else { return };
        let Some(index) = terminals.tabs.iter().position(|tab| tab.id == id) else { return };
        terminals.tabs.remove(index);
        if terminals.active >= terminals.tabs.len() || index < terminals.active {
            terminals.active = terminals.active.saturating_sub(1);
        }
        if terminals.tabs.is_empty() {
            terminals.open = false;
        }
        if self.armed == Some(id) {
            self.armed = None;
        }
        cx.notify();
    }

    fn focus_active(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = self.active_terminal() {
            let handle = view.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
    }

    fn resize_to(&mut self, event: &DragMoveEvent<Resize>, window: &mut Window, cx: &mut Context<Self>) {
        let card_bottom = event.bounds.bottom() - px(INSET);
        let room = f32::from(window.viewport_size().height) * HEIGHT_MAX_SHARE;
        let height = f32::from(card_bottom - event.event.position.y).clamp(HEIGHT_MIN, room.max(HEIGHT_MIN)).round();
        if height != self.height {
            self.height = height;
            cx.notify();
        }
    }

    fn seed_from_env(&self, view: &Entity<TerminalView>, cx: &mut Context<Self>) {
        if cfg!(test) || self.spawn != Spawn::Shell {
            return;
        }
        let Ok(command) = std::env::var("MILAGRE_GPUI_TERMINAL_RUN") else { return };
        let bench = std::env::var_os("MILAGRE_GPUI_TERMINAL_BENCH").is_some();
        let snapshot = std::env::var_os("MILAGRE_GPUI_TERMINAL_SNAPSHOT").map(PathBuf::from);
        let view = view.clone();
        cx.spawn(async move |_, cx| {
            // Let the shell print its prompt first (`MILAGRE_GPUI_TERMINAL_WAIT_MS`, 1200 by default).
            let wait = std::env::var("MILAGRE_GPUI_TERMINAL_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(1200);
            cx.background_executor().timer(Duration::from_millis(wait)).await;
            let marker = "milagre-terminal-done";
            let line = format!("{command}; printf '\\033]2;{marker}\\007'\r");
            let (frames, shaped, spent) = view.update(cx, |view, cx| {
                let grid = view.grid_state();
                let counters = (grid.frames, grid.shaped_rows, grid.prepaint_total);
                drop(grid);
                view.input(line.into_bytes(), cx);
                counters
            });
            let started = Instant::now();
            loop {
                cx.background_executor().timer(Duration::from_millis(5)).await;
                let done = view.read_with(cx, |view, _| view.title() == marker);
                if done || started.elapsed() > Duration::from_secs(120) {
                    break;
                }
            }
            let elapsed = started.elapsed();
            // The marker was only a signal: the tab goes back to the shell's name.
            view.update(cx, |view, cx| view.reset_title(cx));
            if bench {
                view.read_with(cx, |view, _| {
                    let grid = view.grid_state();
                    let frames = grid.frames - frames;
                    let prepaint = grid.prepaint_total - spent;
                    let (history, _) = view.scroll_position();
                    eprintln!(
                        "terminal bench: {:.0} ms, {frames} frames ({:.1} fps), prepaint {:.2} ms/frame avg, {:.2} ms max, {} rows shaped, {history} lines of scrollback",
                        elapsed.as_secs_f64() * 1000.0,
                        frames as f64 / elapsed.as_secs_f64(),
                        prepaint.as_secs_f64() * 1000.0 / frames.max(1) as f64,
                        grid.prepaint_max.as_secs_f64() * 1000.0,
                        grid.shaped_rows - shaped,
                    );
                });
            }
            if let Some(path) = snapshot {
                cx.background_executor().timer(Duration::from_millis(150)).await;
                cx.update(|cx| {
                    if let Some(window) = cx.active_window().or_else(|| cx.windows().first().copied()) {
                        let _ = window.update(cx, |_, window, _| save(window, &path));
                    }
                    cx.quit();
                });
            } else if bench {
                cx.update(|cx| cx.quit());
            }
        })
        .detach();
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let active = self.active_index();
        let tabs: Vec<AnyElement> = self
            .current()
            .map(|c| c.tabs.iter().collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(index, tab)| {
                let selected = index == active;
                let title = tab.view.read(cx).title();
                let id = tab.id;
                let asking = self.armed == Some(id);
                let group: SharedString = format!("terminal-tab-{id}").into();
                let close = if asking {
                    // Focus stays in the Terminal, so a second ⌘W confirms.
                    div()
                        .flex_none()
                        .mr(px(2.0))
                        .child(
                            Button::new(("terminal-end", id), format!("End {title}"))
                                .variant(ButtonVariant::Danger)
                                .size(ButtonSize::S24)
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.request_close(id, cx))),
                        )
                        .into_any_element()
                } else {
                    div()
                        .flex_none()
                        .mr(px(4.0))
                        .when(!selected, |el| el.invisible().group_hover(group.clone(), |el| el.visible()))
                        .child(
                            IconButton::new(("terminal-close", id), IconName::Cancel01)
                                .size(IconButtonSize::S20)
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.request_close(id, cx))),
                        )
                        .into_any_element()
                };
                div()
                    .id(("terminal-tab", id))
                    .debug_selector({
                        let name = format!("terminal-tab-{index}");
                        move || name.clone()
                    })
                    .group(group.clone())
                    .flex()
                    .min_w_0()
                    .max_w(TAB_MAX_WIDTH)
                    .h(TAB_HEIGHT)
                    .items_center()
                    .rounded(RADIUS_CONTROL)
                    .text_step(TEXT_12)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .when(selected, |el| el.bg(theme.hover2).text_color(theme.ink))
                    .when(!selected, |el| el.text_color(theme.ink2).hover(|el| el.bg(theme.hover).text_color(theme.ink)))
                    .child(
                        div()
                            .id(("terminal-tab-button", id))
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(px(6.0))
                            .py(px(4.0))
                            .pl(px(8.0))
                            .pr(px(4.0))
                            .cursor_pointer()
                            .child(Icon::new(IconName::ComputerTerminal01).size(IconSize::S12).color(theme.ink2))
                            .child(div().min_w_0().truncate().font_family(mono()).child(title))
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                this.show(index, cx);
                                this.focus_active(window, cx);
                            })),
                    )
                    .child(close)
                    .into_any_element()
            })
            .collect();
        div()
            .debug_selector(|| "terminal-header".to_string())
            .flex()
            .flex_none()
            .h(HEADER_HEIGHT)
            .items_center()
            .gap_1()
            .px(HEADER_PAD)
            .border_b_1()
            .border_color(theme.line)
            .child(
                div().flex().flex_1().min_w_0().items_center().gap_1().children(tabs).child(
                    div().flex_none().debug_selector(|| "terminal-new".to_string()).child(
                        IconButton::new("terminal-new", IconName::Add01)
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.new_terminal(window, cx))),
                    ),
                ),
            )
            .child(div().flex_none().debug_selector(|| "terminal-hide".to_string()).child(
                IconButton::new("terminal-hide", IconName::ArrowDown01).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.hide(cx))),
            ))
            .into_any_element()
    }
}

#[cfg(target_os = "macos")]
fn save(window: &Window, path: &std::path::Path) {
    match crate::snapshot::save_window_png(window, path) {
        Ok((w, h)) => eprintln!("terminal snapshot: wrote {} ({w}x{h} px)", path.display()),
        Err(error) => eprintln!("terminal snapshot failed: {error}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn save(_: &Window, _: &std::path::Path) {}

impl Render for TerminalDrawer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        let header = self.header(cx);
        // The shown Terminal is its own cached view: its output never rebuilds this header.
        let body: AnyElement = match self.active_terminal() {
            Some(view) => AnyView::from(view).cached(StyleRefinement::default().size_full()).into_any_element(),
            None => div()
                .size_full()
                .p_4()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(self.error.clone().unwrap_or_else(|| "No Terminal.".into()))
                .into_any_element(),
        };
        let card = div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .overflow_hidden()
            .child(header)
            .child(div().flex_1().min_h_0().child(body));
        // The handle straddles the card's top edge, in the gap above it.
        let handle = div()
            .id("terminal-resize")
            .debug_selector(|| "terminal-resize".to_string())
            .absolute()
            .top(px(GAP) - px(6.0))
            .left(HANDLE_INSET)
            .right(px(INSET) + HANDLE_INSET)
            .h(HANDLE_HEIGHT)
            .cursor_row_resize()
            .on_drag(Resize, |_, _, _, cx| cx.new(|_| DragGhost));
        div()
            .id("terminal-drawer")
            .debug_selector(|| "terminal-drawer".to_string())
            .relative()
            .size_full()
            .pt(px(GAP))
            .pr(px(INSET))
            .pb(px(INSET))
            .on_drag_move(cx.listener(Self::resize_to))
            .child(card)
            .child(handle)
    }
}
