//! The command palette (O-01; `CommandPalette.tsx`): ⌘K opens a search over the actions, the open Chat's actions,
//! every Chat, the other Projects, the quick settings, every Settings page and row, and, when nothing else
//! matches, the words in Chats' messages. Empty, it lists the last five commands run (Recent) and then the groups.
//!
//! | File | What |
//! | --- | --- |
//! | `commands.rs` | [`Command`], `filter_commands`, Recent, message rows, quick settings, [`results`] |
//! | `sources.rs` | the lists the window feeds in: actions, Chats, Projects, Settings pages |
//!
//! [`PaletteView`] is an in-window modal like Settings: the window mounts it and shows it above everything. It
//! does not run a command itself; it emits [`PaletteEvent::Run`] after it has closed, and the window carries the
//! [`CommandAction`] out. Escape, ⌘K and a press outside close it; the arrows move the selection (the pointer moves
//! it too); Return runs it; Tab keeps the focus in the field.
//!
//! Message search is asynchronous: when no command matches and the query has two characters, the view waits 120 ms
//! (a keystroke does not ask the host each time), asks the [`MessageSearch`], and lists nothing until it answers.
//!
//! Not built: a command's own key running it while the palette is open (the window's bindings do), the ⌘-held
//! keycap hints (the footer keeps its space and shows nothing), the entrance animation, and the backdrop blur.

pub mod commands;
pub mod sources;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, Render, ScrollHandle, SharedString, Styled, Subscription, Task, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

pub use commands::{Command, CommandAction, CommandIcon, Found, MessageMatch, QuickSetting, Results, results};
use commands::{RecentCommands, START_CHAT_ID, message_commands, remembered_id, step_selection};
pub use sources::{ChatEntry, PaletteInput, ProjectEntry};

use crate::data::DataFuture;
use crate::logic::keybindings::catalog::KEYBINDING_COMMANDS;
use crate::logic::keybindings::keys::key_label_for;
use crate::settings::SettingsStore;
use crate::theme::{ActiveTheme, RADIUS_INLINE, RADIUS_WINDOW, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt};
use crate::ui::{EmptyState, Icon, IconName, IconSize, Input, ScrollArea, SectionLabel, ShortcutKeys};

/// How long a query rests before the host is asked for messages.
pub const SEARCH_DELAY: Duration = Duration::from_millis(120);
/// The palette's width and height caps, and its distance from the window's top (`min(14vh, 100px)`).
const WIDTH: f32 = 640.0;
const MAX_HEIGHT: f32 = 560.0;
const EDGE: f32 = 16.0;
const TOP_MAX: f32 = 100.0;

/// The message search the host answers (`chat:search`): matches for `query`, best first.
pub trait MessageSearch {
    fn search(&self, query: &str) -> DataFuture<Vec<MessageMatch>>;
}

/// Searches the messages the window handed over (the fixture; a daemon adapter implements the trait instead).
pub struct FixtureMessages {
    messages: Vec<(String, u64, String)>,
}

impl FixtureMessages {
    /// `(chat key, message id, body)` for every message to search.
    pub fn new(messages: Vec<(String, u64, String)>) -> Self {
        Self { messages }
    }
}

impl MessageSearch for FixtureMessages {
    fn search(&self, query: &str) -> DataFuture<Vec<MessageMatch>> {
        crate::data::ready(Ok(commands::search_messages(&self.messages, query, 200)))
    }
}

/// What the palette tells the window.
pub enum PaletteEvent {
    /// The palette closed on this command: carry its action out.
    Run(Box<Command>),
    Closed,
}

impl EventEmitter<PaletteEvent> for PaletteView {}

pub struct PaletteView {
    open: bool,
    input: Option<Entity<InputState>>,
    _input_sub: Option<Subscription>,
    commands: Vec<Command>,
    titles: HashMap<String, String>,
    /// Read once per opening, so a command run from here does not reshuffle the list under the pointer.
    recent: Vec<String>,
    search: Option<Rc<dyn MessageSearch>>,
    found: Found,
    selected: Option<String>,
    scroll: ScrollHandle,
    focus: FocusHandle,
    /// What had the focus when it opened, for the window to give it back.
    previous: Option<FocusHandle>,
    _searching: Option<Task<()>>,
    /// The last frame's rows, for the key handlers.
    rows: Vec<Command>,
}

impl PaletteView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            open: false,
            input: None,
            _input_sub: None,
            commands: Vec::new(),
            titles: HashMap::new(),
            recent: Vec::new(),
            search: None,
            found: Found::default(),
            selected: None,
            scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            previous: None,
            _searching: None,
            rows: Vec::new(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// The text in the field.
    pub fn query(&self, cx: &App) -> String {
        self.input.as_ref().map(|input| input.read(cx).value().to_string()).unwrap_or_default()
    }

    /// The rows now listed, in order.
    pub fn rows(&self) -> &[Command] {
        &self.rows
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.selected.as_deref().or_else(|| self.rows.first().map(|row| row.id.as_str()))
    }

    /// Opens it on `input`'s Chats and Projects.
    pub fn show(&mut self, input: &PaletteInput, search: Option<Rc<dyn MessageSearch>>, window: &mut Window, cx: &mut Context<Self>) {
        let mut commands = sources::commands(input);
        // The quick settings sit between the Projects and the Settings pages, found only by typing.
        let store = cx.try_global::<SettingsStore>().cloned().unwrap_or_default();
        let quick: Vec<Command> = commands::quick_settings(&store);
        let at = commands.iter().position(|command| command.group == "Settings").unwrap_or(commands.len());
        commands.splice(at..at, quick);
        self.titles = input.chats.iter().map(|chat| (chat.key.clone(), chat.title.clone())).collect();
        self.recent = cx.try_global::<RecentCommands>().map(|recent| recent.0.clone()).unwrap_or_default();
        self.commands = commands;
        self.search = search;
        self.found = Found::default();
        self.selected = None;
        self._searching = None;
        self.previous = window.focused(cx);
        let field = self.ensure_input(window, cx);
        field.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        self.open = true;
        self.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        cx.notify();
    }

    /// The focus to give back after closing (once).
    pub fn take_previous_focus(&mut self) -> Option<FocusHandle> {
        self.previous.take()
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self._searching = None;
        cx.emit(PaletteEvent::Closed);
        cx.notify();
    }

    /// Runs `command`: remembered as Recent (a real command, not the new-Chat row), then closed, then told.
    pub fn run(&mut self, command: Command, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        let id = remembered_id(&command).to_string();
        if command.id != START_CHAT_ID && self.commands.iter().any(|item| item.id == id) {
            if !cx.has_global::<RecentCommands>() {
                cx.set_global(RecentCommands::default());
            }
            cx.global_mut::<RecentCommands>().remember(&id);
        }
        self.close(cx);
        cx.emit(PaletteEvent::Run(Box::new(command)));
    }

    /// Types into the field (tests and the snapshot runs).
    pub fn set_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        let field = self.ensure_input(window, cx);
        field.update(cx, |state, cx| state.set_value(query.to_string(), window, cx));
        // Setting the value in code is not a keystroke: the host search is asked for here.
        self.selected = None;
        self.ask_host(cx);
        cx.notify();
    }

    pub fn select(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.selected = id;
        cx.notify();
    }

    pub fn move_selection(&mut self, down: bool, cx: &mut Context<Self>) {
        if self.rows.is_empty() {
            return;
        }
        let current = self.selected_ix();
        let next = step_selection(self.rows.len(), current, down);
        self.selected = Some(self.rows[next].id.clone());
        cx.notify();
    }

    pub fn run_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(command) = self.rows.get(self.selected_ix()).cloned() {
            self.run(command, cx);
        }
    }

    fn selected_ix(&self) -> usize {
        self.selected.as_deref().and_then(|id| self.rows.iter().position(|row| row.id == id)).unwrap_or(0)
    }

    fn ensure_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = &self.input {
            return input.clone();
        }
        let input = Input::state("Search commands, Chats and Projects\u{2026}", window, cx);
        self._input_sub = Some(cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.selected = None;
                this.ask_host(cx);
                cx.notify();
            }
        }));
        self.input = Some(input.clone());
        input
    }

    /// When no command matches, waits [`SEARCH_DELAY`] and asks the host for messages with these words.
    fn ask_host(&mut self, cx: &mut Context<Self>) {
        self._searching = None;
        let query = self.query(cx);
        let shown = results(&self.commands, &self.recent, &query, &self.found);
        if !shown.searching {
            return;
        }
        let Some(search) = self.search.clone() else {
            self.found = Found { query: query.clone(), commands: Vec::new() };
            return;
        };
        let future = search.search(query.trim());
        let titles = self.titles.clone();
        self._searching = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DELAY).await;
            let commands = future.await.map(|matches| message_commands(&matches, &titles)).unwrap_or_default();
            this.update(cx, |this, cx| {
                this.found = Found { query, commands };
                cx.notify();
            })
            .ok();
        }));
    }

    fn handle_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" => self.close(cx),
            "down" => self.move_selection(true, cx),
            "up" => self.move_selection(false, cx),
            "enter" => self.run_selected(cx),
            "tab" => {
                if let Some(input) = &self.input {
                    input.update(cx, |state, cx| state.focus(window, cx));
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }
}

impl Focusable for PaletteView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The glyph a row shows. `BubbleChatSearch`, `Bug01`, `HardDrive` and `FolderOpen` are not in the icon set yet;
/// their rows borrow the nearest glyph here, the one place to change.
fn icon_name(icon: CommandIcon) -> IconName {
    match icon {
        CommandIcon::Chat | CommandIcon::Unread | CommandIcon::Message => IconName::BubbleChat,
        CommandIcon::Add => IconName::Add01,
        CommandIcon::Folder | CommandIcon::Storage => IconName::Folder01,
        CommandIcon::Settings => IconName::Settings01,
        CommandIcon::Git => IconName::GitBranch,
        CommandIcon::Editor => IconName::Code,
        CommandIcon::Copy => IconName::Copy01,
        CommandIcon::Search => IconName::Search01,
        CommandIcon::Reload => IconName::Refresh01,
        CommandIcon::Routines => IconName::TimeSchedule,
        CommandIcon::Usage => IconName::ChartColumn,
        CommandIcon::NewChat => IconName::PencilEdit02,
        CommandIcon::Triage => IconName::Alert02,
        CommandIcon::Terminal => IconName::ComputerTerminal01,
        CommandIcon::Link => IconName::Link04,
        CommandIcon::PullRequest => IconName::GitPullRequest,
        CommandIcon::FolderAdd => IconName::FolderAdd,
        CommandIcon::Canvas => IconName::FlowConnection,
    }
}

/// A row's shortcut, as the hints draw it (`⌘N`).
pub fn shortcut_of(command: &str) -> Option<String> {
    let default = KEYBINDING_COMMANDS.iter().find(|item| item.id == command)?.defaults.first()?;
    key_label_for(default, true)
}

impl Render for PaletteView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            self.rows.clear();
            return div().into_any_element();
        }
        let theme = *cx.theme();
        let input = self.ensure_input(window, cx);
        let query = input.read(cx).value().to_string();
        let shown = results(&self.commands, &self.recent, &query, &self.found);
        self.rows = shown.rows.clone();
        let selected_ix = self.selected_ix();
        let selected_id = self.rows.get(selected_ix).map(|row| row.id.clone());
        let this = cx.entity();

        let viewport = window.viewport_size();
        let width = (viewport.width.as_f32() - 2.0 * EDGE).min(WIDTH);
        let height = (viewport.height.as_f32() * 0.8).min(MAX_HEIGHT);
        let top = (viewport.height.as_f32() * 0.14).min(TOP_MAX);

        // One flat list so the scroll handle can bring the selected row into view: group labels and rows alike.
        let mut list: Vec<AnyElement> = Vec::new();
        let mut flat_of_selected = 0;
        let mut last_group: Option<&str> = None;
        for (ix, row) in self.rows.iter().enumerate() {
            if last_group != Some(row.group.as_str()) {
                last_group = Some(row.group.as_str());
                list.push(
                    div()
                        .debug_selector({
                            let key = format!("palette-group-{}", row.group);
                            move || key.clone()
                        })
                        .pl(px(10.0))
                        .pt(px(if list.is_empty() { 0.0 } else { 6.0 }))
                        .child(SectionLabel::new(row.group.clone()).menu())
                        .into_any_element(),
                );
            }
            let is_selected = selected_id.as_deref() == Some(row.id.as_str());
            if is_selected {
                flat_of_selected = list.len();
            }
            list.push(command_row(ix, row, is_selected, &theme, &this));
        }
        if self.rows.is_empty() && !shown.searching {
            list.push(
                EmptyState::new()
                    .size(crate::ui::EmptySize::Compact)
                    .title(format!("No results for \u{201c}{query}\u{201d}"))
                    .into_any_element(),
            );
        }
        self.scroll.scroll_to_item(flat_of_selected);

        let scrim = this.clone();
        let panel = div()
            .id("palette")
            .debug_selector(|| "palette".into())
            .key_context("CommandPalette")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.handle_key(event, window, cx)))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .flex()
            .flex_col()
            .w(px(width))
            .max_h(px(height))
            .overflow_hidden()
            .rounded(RADIUS_WINDOW)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .text_color(theme.ink)
            .shadow(theme.shadow_raised())
            .child(
                div()
                    .debug_selector(|| "palette-header".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .border_b_1()
                    .border_color(theme.line)
                    .child(Icon::new(IconName::Search01).size(IconSize::S18).color(theme.ink3))
                    .child(div().min_w_0().flex_1().text_step(TEXT_15).child(Input::new("palette-input", &input).bare())),
            )
            .child(
                div()
                    .debug_selector(|| "palette-list".into())
                    .min_h_0()
                    .flex_1()
                    .pt(px(6.0))
                    .pb(px(8.0))
                    .pl(px(6.0))
                    .child(ScrollArea::new("palette-scroll", &self.scroll).children(list)),
            )
            .child(
                // The footer keeps its space; its keys show while ⌘ is held on the desktop.
                div()
                    .flex()
                    .flex_none()
                    .gap(px(16.0))
                    .px(px(16.0))
                    .py(px(8.0))
                    .border_t_1()
                    .border_color(theme.line)
                    .text_step(TEXT_11)
                    .text_color(theme.ink3)
                    .opacity(0.0)
                    .child("\u{2191} \u{2193} Navigate")
                    .child("\u{21b5} Run")
                    .child(div().ml_auto().child("esc Close")),
            );
        div()
            .id("palette-scrim")
            .debug_selector(|| "palette-scrim".into())
            .absolute()
            .inset_0()
            .bg(theme.scrim)
            .flex()
            .flex_col()
            .items_center()
            .pt(px(top))
            .on_mouse_down(MouseButton::Left, move |_, _, cx| scrim.update(cx, |this, cx| this.close(cx)))
            .child(panel)
            .into_any_element()
    }
}

/// One row: a 20px icon slot, the label (bold where it matched) and, on the selected row, its hint; the detail and
/// the shortcut at the right. MenuRow's metrics; the highlight follows the selection.
fn command_row(ix: usize, command: &Command, selected: bool, theme: &crate::theme::Theme, palette: &Entity<PaletteView>) -> AnyElement {
    let (id, for_move, for_click) = (command.id.clone(), palette.clone(), palette.clone());
    let (move_id, command_for_click) = (id.clone(), command.clone());
    let label: AnyElement = match command.highlight {
        Some((start, end))
            if end <= command.label.len() && command.label.is_char_boundary(start) && command.label.is_char_boundary(end) =>
        {
            div()
                .truncate()
                .child(command.label[..start].to_string())
                .child(div().font_weight(FontWeight::SEMIBOLD).child(command.label[start..end].to_string()))
                .child(command.label[end..].to_string())
                .flex()
                .into_any_element()
        }
        _ => div().truncate().child(command.label.clone()).into_any_element(),
    };
    div()
        .id(SharedString::from(format!("palette-row-{ix}")))
        .debug_selector({
            let key = format!("palette-row-{ix}");
            move || key.clone()
        })
        .flex()
        .min_h(px(32.0))
        .w_full()
        .items_center()
        .gap(px(8.0))
        .px(px(8.0))
        .when(command.hint.is_some() && selected, |row| row.py(px(6.0)))
        .rounded(RADIUS_INLINE)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .cursor_pointer()
        .when(selected, |row| row.bg(theme.hover2))
        .active(|row| row.bg(theme.hover2))
        .on_mouse_move(move |_, _, cx| {
            if !selected {
                for_move.update(cx, |this, cx| this.select(Some(move_id.clone()), cx));
            }
        })
        .on_click(move |_, _, cx| for_click.update(cx, |this, cx| this.run(command_for_click.clone(), cx)))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(20.0))
                .child(Icon::new(icon_name(command.icon)).size(IconSize::S16).color(theme.ink2)),
        )
        .child(div().flex().flex_col().min_w_0().flex_1().child(label).when_some(command.hint.clone().filter(|_| selected), |col, hint| {
            col.child(div().truncate().text_step(TEXT_12).font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(hint))
        }))
        .when_some(command.detail.clone(), |row, detail| {
            row.child(
                div()
                    .max_w(gpui::relative(0.45))
                    .truncate()
                    .text_step(TEXT_11)
                    .font_weight(FontWeight::NORMAL)
                    .text_color(theme.ink3)
                    .child(detail),
            )
        })
        .when_some(command.keybinding.and_then(shortcut_of), |row, keys| {
            row.child(div().min_w(px(48.0)).flex().justify_end().child(ShortcutKeys::new(keys).plain()))
        })
        .into_any_element()
}
