//! The Terminal tab (WP-33, P-11): a tab per Terminal in a 36px header with a New Terminal button, over the shown
//! Terminal's grid. Each Terminal is a local login shell in the Worktree on its own PTY (`session.rs`), parsed by
//! `alacritty_terminal` and painted by our own grid element (`grid.rs`).
//!
//! The desktop puts this panel in a drawer under the Chat (`TerminalPanel.tsx`); the port shows it as the side
//! panel's Terminal tab. Each Terminal view is mounted cached, so output repaints only that view.
//!
//! Snapshot and bench seeds (never in tests): `MILAGRE_GPUI_TERMINAL_RUN="<command>"` types the command into the
//! first Terminal once its shell is up; `MILAGRE_GPUI_TERMINAL_BENCH=1` then times it (frames, prepaint time) and
//! prints to stderr; `MILAGRE_GPUI_TERMINAL_SNAPSHOT=<png>` saves the window when it ends and quits.

pub mod colors;
pub mod grid;
pub mod keys;
pub mod session;
pub mod view;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, AnyView, ClickEvent, Context, Entity, FocusHandle, Focusable, SharedString, StyleRefinement, Subscription, Window, actions,
    div, prelude::*, px,
};

use self::session::{GridSize, Session};
use self::view::{TerminalEvent, TerminalView};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TextStepExt, mono};
use crate::ui::{EmptySize, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize};

actions!(terminal, [NewTerminal]);

/// The header's height (`h-9`) and padding (`px-1.5`), a tab's height (`h-7`) and widest (`max-w-[200px]`).
pub const HEADER_HEIGHT: gpui::Pixels = px(36.0);
const HEADER_PAD: gpui::Pixels = px(6.0);
const TAB_HEIGHT: gpui::Pixels = px(28.0);
const TAB_MAX_WIDTH: gpui::Pixels = px(200.0);

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

pub struct TerminalPanel {
    tabs: Vec<Tab>,
    active: usize,
    next_id: usize,
    cwd: PathBuf,
    spawn: Spawn,
    /// The first Terminal is made when the tab is first shown, not at startup.
    started: bool,
    error: Option<SharedString>,
    focus: FocusHandle,
    renders: usize,
}

impl TerminalPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self::with_spawn(if cfg!(test) { Spawn::Detached } else { Spawn::Shell }, cx)
    }

    pub fn with_spawn(spawn: Spawn, cx: &mut Context<Self>) -> Self {
        view::install_keys(cx);
        Self {
            tabs: Vec::new(),
            active: 0,
            next_id: 1,
            cwd: session::default_cwd(),
            spawn,
            started: false,
            error: None,
            focus: cx.focus_handle(),
            renders: 0,
        }
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    pub fn terminals(&self) -> Vec<Entity<TerminalView>> {
        self.tabs.iter().map(|tab| tab.view.clone()).collect()
    }

    pub fn active_terminal(&self) -> Option<Entity<TerminalView>> {
        self.tabs.get(self.active).map(|tab| tab.view.clone())
    }

    pub fn active_index(&self) -> usize {
        self.active
    }

    /// Opens a Terminal and shows it.
    pub fn add(&mut self, cx: &mut Context<Self>) -> Option<Entity<TerminalView>> {
        self.started = true;
        let view = match self.spawn {
            Spawn::Shell => {
                let cwd = self.cwd.clone();
                let mut failure = None;
                let view = cx.new(|cx| match TerminalView::spawn(&cwd, cx) {
                    Ok(view) => view,
                    Err(error) => {
                        failure = Some(error.to_string());
                        TerminalView::new(Session::detached(GridSize { cols: 80, lines: 24 }), cx)
                    }
                });
                if let Some(error) = failure {
                    self.error = Some(format!("Couldn't open a Terminal: {error}").into());
                    cx.notify();
                    return None;
                }
                view
            }
            Spawn::Detached => cx.new(|cx| TerminalView::new(Session::detached(GridSize { cols: 80, lines: 24 }), cx)),
        };
        let id = self.next_id;
        self.next_id += 1;
        let events = cx.subscribe(&view, move |this, _, event, cx| match event {
            TerminalEvent::Title => cx.notify(),
            TerminalEvent::Exited => this.close(id, cx),
        });
        self.tabs.push(Tab { id, view: view.clone(), _events: events });
        self.active = self.tabs.len() - 1;
        self.error = None;
        if self.tabs.len() == 1 {
            self.seed_from_env(&view, cx);
        }
        cx.notify();
        Some(view)
    }

    pub fn show(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.tabs.len() && index != self.active {
            self.active = index;
            cx.notify();
        }
    }

    /// Ends a Terminal (its shell gets SIGHUP) and shows its neighbour.
    pub fn close(&mut self, id: usize, cx: &mut Context<Self>) {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else { return };
        self.tabs.remove(index);
        if self.active >= self.tabs.len() || index < self.active {
            self.active = self.active.saturating_sub(1);
        }
        cx.notify();
    }

    fn focus_active(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = self.active_terminal() {
            let handle = view.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
    }

    fn new_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.add(cx).is_some() {
            self.focus_active(window, cx);
        }
    }

    /// The bench and snapshot seeds (module docs). Not in tests.
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
        let tabs = self.tabs.iter().enumerate().map(|(index, tab)| {
            let selected = index == self.active;
            let title = tab.view.read(cx).title();
            let id = tab.id;
            let group: SharedString = format!("terminal-tab-{id}").into();
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
                .child(
                    div().flex_none().mr(px(4.0)).when(!selected, |el| el.invisible().group_hover(group, |el| el.visible())).child(
                        IconButton::new(("terminal-close", id), IconName::Cancel01)
                            .size(IconButtonSize::S20)
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.close(id, cx))),
                    ),
                )
        });
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

impl Render for TerminalPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        if !self.started {
            self.add(cx);
        }
        let theme = *cx.theme();
        let header = self.header(cx);
        // The shown Terminal is its own cached view: its output never rebuilds this header.
        let body: AnyElement = match self.active_terminal() {
            Some(view) => AnyView::from(view).cached(StyleRefinement::default().size_full()).into_any_element(),
            None => {
                let help = self.error.clone().unwrap_or_else(|| "Every Terminal has ended.".into());
                div()
                    .size_full()
                    .child(EmptyState::new().size(EmptySize::Panel).icon(IconName::ComputerTerminal01).title("No Terminal").help(help))
                    .into_any_element()
            }
        };
        div()
            .id("terminal-panel")
            .debug_selector(|| "panel-body-Terminal".to_string())
            .key_context("TerminalPanel")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NewTerminal, window, cx| this.new_terminal(window, cx)))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.surface)
            .child(header)
            .child(div().flex_1().min_h_0().child(body))
    }
}
