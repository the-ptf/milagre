//! Sidebar column (304px, `canvas`): header with the New Chat button, the Pinned rows, the
//! rows of every other Chat as a virtualized list, and a pinned bottom group (Done, usage, footer: `bottom.rs`).
//!
//! The rows come from the app's [`Data`] source through `list.rs`, which runs the shared list rules
//! (`logic::lists`: listing, pins, order, Done, Subchat families) and the mark rules (`logic::marks`). Pinned rows
//! sit at the top of the list with no heading of their own (a pin marks each), as in the desktop's one-list layout; the rest are drawn through `uniform_list`,
//! GPUI's virtualized list for rows of one fixed height, so only the rows in (or just around) the viewport are
//! built each frame. Each row is a view of its own (`row.rs`) mounted as a cached view, so a sidebar re-render
//! reuses the rows that did not change. Row indices run over the pinned rows first, then the list.
//!
//! Menus, actions and undo (WP-20): a right press on a row opens its context menu (`menu.rs`), resting on it opens
//! the hover card (`hover_card.rs`), Rename edits the title in place (`rename.rs`), Done, Delete and Pin apply at once
//! to the sidebar's copy of the data, send their call through `actions.rs` and are recorded in the undo book
//! (`undo.rs`: the toast above the usage meters, ⌘Z and ⇧⌘Z), pins are this device's (`pins.rs`), the collapsed
//! sidebar is the scope rail (`rail.rs`) and the footer's Filters menu (`filters.rs`) chooses what the lists show.
//! `commands.rs` holds the `Sidebar` methods behind all of it.
//!
//! Drag and drop and Links (WP-49): a row drags onto the Chat view (the grid) and a pinned row within the Pinned rows
//! (`drag.rs`, with the window's side in `hooks.rs`); a drop on a row or "Link with…" opens the Link popovers
//! (`links.rs`, `link_popover.rs`).
//!
//! Keyboard: the sidebar owns a `FocusHandle` (`track_focus`); clicking a row or the sidebar focuses it,
//! and `on_key_down` moves the selection on Up/Down and scrolls the row into view through the
//! `UniformListScrollHandle`.

pub mod actions;
mod bottom;
mod commands;
pub mod drag;
pub mod filters;
mod hooks;
pub mod hover_card;
pub mod link_popover;
pub mod links;
pub mod list;
pub mod menu;
pub mod pins;
pub mod rail;
pub mod rename;
mod row;
pub mod undo;
mod usage;

#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, AnyView, Bounds, Context, Entity, FocusHandle, KeyDownEvent, MouseButton, Pixels, ScrollStrategy, StyleRefinement,
    Subscription, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list,
};

use crate::data::{Data, Polled, poll_once};
use crate::logic::lists::chat_row::{ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
use crate::logic::lists::order::ChatOrder;
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt, sidebar_step};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize};
use crate::workspace::chat::pills::bookmark::FamilyChat;
use crate::workspace::chrome::{self, NoDrag};
pub use actions::{Actions, ArchiveMode, ChatPatch, RecordingActions, SidebarActions, SidebarCall};
use list::ListFilters;
pub use list::{ChatLists, SidebarData, SidebarSeed};
pub use row::{ChatRow, RowState};
use row::{ChatRowView, ROW_GAP, ROW_INSET, ROW_PITCH, RowEvent, RowMeta};

pub const SIDEBAR_WIDTH: f32 = 304.0;
/// Row views kept on each side of the visible range, so scrolling back a little does not rebuild them.
/// A fixed margin, not a multiple of the range: `uniform_list` also asks for `0..1` to measure a row, and
/// that call must not evict the real rows (a new entity per frame would lose clicks and the cache).
const KEEP_ROWS: usize = 64;
/// The desktop's default Chat order (`DEFAULTS.chatOrder` in `lib/settings.ts`).
const CHAT_ORDER: ChatOrder = ChatOrder::Created;
/// From the header's bottom to the first row's box.
const LIST_TOP: f32 = 8.0;

pub struct Sidebar {
    data: SidebarData,
    /// The Pinned rows, then the All Chats rows.
    rows: Vec<ChatRow>,
    /// Where each row's Chat lives, parallel to `rows`.
    meta: Vec<RowMeta>,
    pinned: usize,
    done: usize,
    /// The Done section's rows, most recently marked first (`DoneSection.tsx`), and whether its list is open: kept for
    /// the session (the desktop keeps it in `milagre.sidebarDoneOpen`).
    done_rows: Vec<ChatRow>,
    done_open: bool,
    /// The Chat on screen while no list row is selected: a Done row picked, or a Chat with no row (a Subchat opened from
    /// the Details panel).
    picked: Option<ChatRow>,
    done_scroll: UniformListScrollHandle,
    selected: Option<usize>,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    /// The views of the rows in and near the viewport, by row index, with their click subscriptions.
    row_views: HashMap<usize, (Entity<ChatRowView>, Subscription)>,
    /// The list's rows built in the last frame, as row indices (the pinned rows are always built), to see
    /// virtualization.
    visible: Range<usize>,
    /// Total `ChatRowView::render` calls so far, shared with the row views.
    rows_built: Rc<Cell<usize>>,
    _load: Option<gpui::Task<()>>,
    /// Where the menus' writes go; `recorder` is the sidebar's own recording when the app gave none.
    actions: Arc<dyn SidebarActions>,
    recorder: Option<Arc<RecordingActions>>,
    /// This device's pins and the computers Filters leaves out.
    list_filters: ListFilters,
    /// Which facts a row's second line carries (Filters › Show).
    show: ChatRowShow,
    /// Chats whose Worktree a canvas Link reaches, with the labels of what they are Linked with.
    linked: HashMap<String, Vec<String>>,
    book: undo::UndoBook,
    toast_shown: Option<u64>,
    _toast_timer: Option<gpui::Task<()>>,
    menu: Option<menu::OpenMenu>,
    /// The hover card: the Chat's key and its row's bounds.
    card: Option<(String, Bounds<Pixels>)>,
    hover_task: Option<gpui::Task<()>>,
    renaming: Option<commands::Renaming>,
    /// Filters is open, with this submenu beside it.
    filters_open: Option<Option<filters::Sub>>,
    /// Where the Filters button was painted.
    filters_button: Rc<Cell<Bounds<Pixels>>>,
    collapsed: bool,
    /// The rail icon whose card is open (row index) and where the pointer was.
    rail_card: Option<(usize, Pixels)>,
    rail_task: Option<gpui::Task<()>>,
    /// The provider whose usage card is open, where each usage row was painted, and the open or close timer.
    usage_card: Option<crate::data::Provider>,
    usage_bounds: usage::RowBounds,
    usage_task: Option<gpui::Task<()>>,
    /// Snapshot seed (never in tests): a state to open on the first frame, from `MILAGRE_GPUI_SIDEBAR_DEMO`.
    demo: Option<String>,
    /// Snapshot seed: the row drawn as hovered, its Done action showing (`MILAGRE_GPUI_SIDEBAR_DEMO=hover-done`).
    show_hover: Option<usize>,
    /// The row being dragged and where it would land (`drag.rs`), and what the keyboard drag last announced.
    drag: Option<drag::DragState>,
    announcement: String,
    /// The canvas Links the sidebar knows, the popover or picker open over it, and the last fixture Link id.
    links: Vec<links::CanvasLink>,
    link_open: Option<links::OpenLinks>,
    next_link: u64,
}

/// What the sidebar asks the window to do.
pub enum SidebarEvent {
    /// The New Chat button: the Chat column opens its new-Chat composer.
    NewChat,
}

impl gpui::EventEmitter<SidebarEvent> for Sidebar {}

impl Sidebar {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let seed = cx.try_global::<SidebarSeed>().cloned().unwrap_or_default();
        let (actions, recorder): (Arc<dyn SidebarActions>, Option<Arc<RecordingActions>>) = match cx.try_global::<Actions>() {
            Some(actions) => (actions.0.clone(), None),
            None => {
                let recorder = Arc::new(RecordingActions::default());
                (recorder.clone(), Some(recorder))
            }
        };
        let mut this = Self {
            data: SidebarData::default(),
            rows: Vec::new(),
            meta: Vec::new(),
            pinned: 0,
            done: 0,
            done_rows: Vec::new(),
            done_open: false,
            picked: None,
            done_scroll: UniformListScrollHandle::new(),
            selected: None,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            row_views: HashMap::new(),
            visible: 0..0,
            rows_built: Rc::new(Cell::new(0)),
            _load: None,
            actions,
            recorder,
            list_filters: ListFilters::default(),
            show: DESKTOP_CHAT_ROW_SHOW,
            linked: HashMap::new(),
            book: undo::UndoBook::new(),
            toast_shown: None,
            _toast_timer: None,
            menu: None,
            card: None,
            hover_task: None,
            renaming: None,
            filters_open: None,
            filters_button: Rc::default(),
            collapsed: false,
            rail_card: None,
            rail_task: None,
            usage_card: None,
            usage_bounds: Rc::default(),
            usage_task: None,
            demo: if cfg!(test) { None } else { std::env::var("MILAGRE_GPUI_SIDEBAR_DEMO").ok() },
            show_hover: None,
            drag: None,
            announcement: String::new(),
            links: Vec::new(),
            link_open: None,
            next_link: 0,
        };
        commands::install_undo_keys(cx);
        let open_chat = seed.open_chat;
        let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else { return this };
        // A source that answers at once (the fixture) fills the first frame; any other is read in the background.
        match poll_once(SidebarData::load(source)) {
            Polled::Ready(Ok(data)) => this.set_data(data, open_chat.as_deref()),
            Polled::Ready(Err(error)) => eprintln!("sidebar: couldn't read the Chats: {error}"),
            Polled::Pending(load) => {
                this._load = Some(cx.spawn(async move |this, cx| {
                    let Ok(data) = load.await else { return };
                    let _ = this.update(cx, |this, cx| {
                        this.set_data(data, open_chat.as_deref());
                        cx.notify();
                    });
                }));
            }
        }
        this
    }

    fn set_data(&mut self, data: SidebarData, select: Option<&str>) {
        self.data = data;
        self.rebuild(select);
        // Snapshot seed (never in tests): open on another row.
        if let Some(ix) =
            std::env::var("MILAGRE_GPUI_SELECT_ROW").ok().and_then(|v| v.parse::<usize>().ok()).filter(|ix| *ix < self.rows.len())
        {
            self.selected = Some(ix);
        }
    }

    /// Builds the rows again from the data, keeping the selection on the same Chat (or `select`).
    fn rebuild(&mut self, select: Option<&str>) {
        let selected_key =
            select.map(str::to_owned).or_else(|| self.selected.and_then(|ix| self.rows.get(ix)).map(|row| row.key.to_string()));
        let picked = self.picked.take().filter(|_| select.is_none() && selected_key.is_none());
        // Chats marked Done in the last day stay in the list (dimmed, with the check); older ones are the Done section.
        self.list_filters.done_since = Some(list::list_clock() - list::DONE_INLINE_WINDOW);
        let lists = list::chat_lists_with(&self.data, CHAT_ORDER, &self.list_filters);
        self.pinned = lists.pinned.len();
        self.done = lists.done.len();
        self.done_rows =
            lists.done.iter().map(|item| ChatRow::with_show(&list::ShownChat { item: item.clone() }, &self.data, self.show)).collect();
        self.picked = picked.filter(|row| self.selected.is_none() && self.locate(row.key.as_ref()).is_some());
        self.rows = lists.pinned.iter().chain(&lists.rows).map(|shown| ChatRow::with_show(shown, &self.data, self.show)).collect();
        self.meta = lists.pinned.iter().chain(&lists.rows).map(RowMeta::of).collect();
        self.selected = selected_key.and_then(|key| self.rows.iter().position(|row| row.key.as_ref() == key));
        self.row_views.clear();
    }

    pub fn selected(&self) -> Option<usize> {
        self.selected
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// The row the sidebar shows at `ix` (pinned rows first).
    pub fn row(&self, ix: usize) -> Option<&ChatRow> {
        self.rows.get(ix)
    }

    /// The row of the Chat on screen: the selected list row, or the Done row picked.
    pub fn selected_row(&self) -> Option<&ChatRow> {
        match self.selected {
            Some(ix) => self.rows.get(ix),
            None => self.picked.as_ref(),
        }
    }

    pub fn done_open(&self) -> bool {
        self.done_open
    }

    pub fn done_rows(&self) -> &[ChatRow] {
        &self.done_rows
    }

    /// A row's hover action: Done on a live Chat, Reopen on a Done one; ⌘Z takes either back.
    pub fn toggle_done_row(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(ix) else { return };
        let key = row.key.to_string();
        if self.is_done_key(&key) {
            self.reopen(&key, true, cx);
        } else {
            self.mark_done(&key, true, cx);
        }
    }

    /// The footer's toggle: opens or folds the Done list.
    pub fn toggle_done(&mut self, cx: &mut Context<Self>) {
        self.done_open = !self.done_open;
        cx.notify();
    }

    /// A Done row clicked: its Chat opens, with no list row selected.
    pub fn select_done(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(row) = self.done_rows.get(ix).cloned() else { return };
        self.pick(row, cx);
    }

    /// Shows a Chat that has no list row: nothing in the list is selected.
    fn pick(&mut self, row: ChatRow, cx: &mut Context<Self>) {
        if let Some((view, _)) = self.selected.and_then(|row| self.row_views.get(&row)) {
            view.update(cx, |view, cx| view.set_selected(false, cx));
        }
        self.selected = None;
        self.picked = Some(row);
        cx.notify();
    }

    /// New Chat: nothing is selected, in the list or among the Done rows.
    pub fn clear_selection(&mut self, cx: &mut Context<Self>) {
        if let Some((view, _)) = self.selected.and_then(|row| self.row_views.get(&row)) {
            view.update(cx, |view, cx| view.set_selected(false, cx));
        }
        self.selected = None;
        self.picked = None;
        cx.notify();
    }

    /// The Project the new-Chat screen starts in: the Chat on screen's, else the first visible Project's.
    pub fn new_chat_project(&self) -> Option<String> {
        let at = self.selected_row().and_then(|row| self.locate(&row.key)).map(|(scope, _)| scope);
        let scope = at.or_else(|| self.data.scopes.iter().position(|s| !s.project.is_chats_home() && !s.project.hidden))?;
        Some(self.data.scopes[scope].project.name.to_string())
    }

    /// A fixture Chat from the first message sent on the empty new-Chat screen: it joins the list (newest first) and
    /// becomes the selected row. It goes in the Project the screen started in.
    pub fn create_chat(&mut self, text: &str, project: Option<&str>, cx: &mut Context<Self>) -> Option<ChatRow> {
        use crate::data::{Chat, ChatSummary};
        let scope_ix = project
            .and_then(|name| self.data.scopes.iter().position(|s| s.project.name.as_ref() == name && !s.project.hidden))
            .or_else(|| self.data.scopes.iter().position(|s| !s.project.is_chats_home() && !s.project.hidden))?;
        let scope = &mut self.data.scopes[scope_ix];
        let worktree =
            scope.state.sessions.values().next().map(|chat| chat.worktree_id).or_else(|| scope.state.worktrees.keys().next().copied())?;
        let id = scope.state.sessions.keys().max().copied().unwrap_or(0) + 1;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let mut chat = Chat::new(id, worktree, "main");
        let title: String = text.lines().next().unwrap_or_default().chars().take(60).collect();
        chat.summary = Some(ChatSummary {
            count: 1,
            first_at: Some(now),
            last_at: Some(now),
            title_line: Some(title.into()),
            ..ChatSummary::default()
        });
        let key = scope.project.scope().chat_key(id);
        scope.state.sessions.insert(id, chat);
        self.rebuild(Some(&key));
        cx.notify();
        self.rows.iter().find(|row| row.key.as_ref() == key).cloned()
    }

    /// Opens the Chat with this key whether or not it has a row (the Details panel's Subchats have none).
    pub fn open_key(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.rows.iter().any(|row| row.key.as_ref() == key) {
            self.select_key(key, cx);
        } else if let Some(row) = self.row_of(key) {
            self.pick(row, cx);
        }
    }

    /// A row for any Chat of the data, listed or not.
    fn row_of(&self, key: &str) -> Option<ChatRow> {
        let (scope, _) = self.locate(key)?;
        let listed = list::listed_chat(&self.data, scope, key, &self.list_filters.pins)?;
        Some(ChatRow::with_show(&list::ShownChat { item: listed }, &self.data, self.show))
    }

    /// Every Chat of every visible scope as the bookmark and the family menu read it. A Chat with a row borrows the
    /// row's mark; one without is running when it has a run and idle otherwise.
    pub fn family_chats(&self) -> Vec<FamilyChat> {
        use crate::logic::activity::subchat_states::SubchatKind;
        use crate::logic::marks::chat_mark::ChatMark;
        let mut out = Vec::new();
        for scope in self.data.scopes.iter().filter(|scope| !scope.project.hidden) {
            let key_scope = scope.project.scope();
            for (id, chat) in &scope.state.sessions {
                let key = key_scope.chat_key(*id);
                let row = self.rows.iter().find(|row| row.key.as_ref() == key);
                let mark = row
                    .map(|row| row.mark)
                    .unwrap_or_else(|| if self.data.runs.get(&key).is_some() { ChatMark::Running } else { ChatMark::Idle });
                let kind = match mark {
                    ChatMark::Question | ChatMark::Waiting => SubchatKind::NeedsYou,
                    ChatMark::Failed => SubchatKind::Failed,
                    ChatMark::Running | ChatMark::Background | ChatMark::Delegated => SubchatKind::Working,
                    _ => SubchatKind::Done,
                };
                out.push(FamilyChat {
                    parent: chat.parent.map(|parent| key_scope.chat_key(parent)),
                    title: chat.display_title(&[]).to_string(),
                    archived: chat.archived,
                    done: chat.done_at.is_some(),
                    background: row.map_or(0, |row| row.background),
                    key,
                    kind,
                    mark,
                });
            }
        }
        out
    }

    /// Selects the Chat with this key when it has a row.
    pub fn select_key(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(ix) = self.rows.iter().position(|row| row.key.as_ref() == key) {
            self.select(ix, cx);
            self.scroll.scroll_to_item(ix.saturating_sub(self.pinned), gpui::ScrollStrategy::Nearest);
            cx.notify();
        }
    }

    pub fn pinned_count(&self) -> usize {
        self.pinned
    }

    pub fn done_count(&self) -> usize {
        self.done
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// The list's row indices built in the last frame (pinned rows are built every frame besides).
    pub fn visible_range(&self) -> Range<usize> {
        self.visible.clone()
    }

    /// How many times a Chat row has rendered since the sidebar was created.
    pub fn rows_built(&self) -> usize {
        self.rows_built.get()
    }

    /// How many row views exist (the visible rows plus a margin), out of `row_count`.
    pub fn row_views_alive(&self) -> usize {
        self.row_views.len()
    }

    fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.selected == Some(ix) {
            return;
        }
        // Only the two rows that changed render again; the list itself does not need to.
        for (row, selected) in [(self.selected, false), (Some(ix), true)] {
            if let Some((view, _)) = row.and_then(|row| self.row_views.get(&row)) {
                view.update(cx, |view, cx| view.set_selected(selected, cx));
            }
        }
        self.selected = Some(ix);
        self.picked = None;
    }

    fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let last = self.rows.len().saturating_sub(1);
        let ix = match self.selected {
            Some(current) => current.saturating_add_signed(delta).min(last),
            None => 0,
        };
        self.select(ix, cx);
        // The list reports the rows it drew; keep the selected one fully inside, one row from the edge.
        if let Some(item) = ix.checked_sub(self.pinned) {
            if ix <= self.visible.start {
                self.scroll.scroll_to_item(item, ScrollStrategy::Top);
            } else if ix + 1 >= self.visible.end {
                self.scroll.scroll_to_item(item, ScrollStrategy::Bottom);
            }
        }
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.drag_key(event, window, cx) {
            cx.stop_propagation();
            return;
        }
        match event.keystroke.key.as_str() {
            "down" => self.move_selection(1, cx),
            "up" => self.move_selection(-1, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// The row at `ix` as a cached view, created when missing.
    fn row_view(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let view = match self.row_views.get(&ix) {
            Some((view, _)) => view.clone(),
            None => {
                let (row, selected, renders) = (self.rows[ix].clone(), self.selected == Some(ix), self.rows_built.clone());
                let renaming = self.renaming.as_ref().filter(|renaming| renaming.key == row.key.as_ref()).map(|renaming| renaming.view());
                let dragging = self.dragging() == Some(row.key.as_ref());
                let pinned = ix < self.pinned;
                let show_hover = self.show_hover == Some(ix);
                let view = cx.new(|_| {
                    let mut view = ChatRowView::new(ix, row, selected, renders);
                    view.set_rename_silently(renaming);
                    view.set_draggable(pinned, dragging);
                    view.set_show_hover(show_hover);
                    view
                });
                let events = cx.subscribe_in(&view, window, move |this, _, event: &RowEvent, window, cx| match event {
                    RowEvent::Clicked => {
                        window.focus(&this.focus, cx);
                        this.select(ix, cx);
                    }
                    RowEvent::ContextMenu(at) => this.open_menu(ix, *at, window, cx),
                    RowEvent::Hover(bounds) => this.hover_row(ix, *bounds, cx),
                    RowEvent::ToggleDone => this.toggle_done_row(ix, cx),
                });
                self.row_views.insert(ix, (view.clone(), events));
                view
            }
        };
        AnyView::from(view).cached(StyleRefinement::default().w_full().h(px(ROW_PITCH))).into_any_element()
    }

    /// The list's visible rows (list item `i` is row `pinned + i`) as cached views. Creates the views that are
    /// missing and drops the ones far away; pinned rows are always kept.
    fn render_rows(&mut self, range: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let pinned = self.pinned;
        let rows = range.start + pinned..range.end + pinned;
        self.visible = rows.clone();
        let keep = rows.start.saturating_sub(KEEP_ROWS)..rows.end + KEEP_ROWS;
        self.row_views.retain(|ix, _| *ix < pinned || keep.contains(ix));
        rows.map(|ix| self.row_view(ix, window, cx)).collect()
    }
}

impl Sidebar {
    /// The Done list's rows `range`: a check, the title, and the row's menu (Reopen) on a right press.
    fn render_done_rows(&mut self, range: Range<usize>, _window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        range
            .filter_map(|ix| {
                let row = self.done_rows.get(ix)?.clone();
                let selected = self.picked.as_ref().is_some_and(|picked| picked.key == row.key);
                let hover = theme.hover2;
                Some(
                    div()
                        .id(("done-row", ix))
                        .debug_selector(move || format!("done-row-{ix}"))
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .h(px(bottom::DONE_ROW))
                        .mx(px(8.0))
                        .px(px(8.0))
                        .rounded(crate::theme::RADIUS_CONTROL)
                        .cursor_pointer()
                        .when(selected, |el| el.bg(hover))
                        .when(!selected, |el| el.hover(move |style| style.bg(hover)))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            window.focus(&this.focus, cx);
                            this.select_done(ix, cx);
                        }))
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                this.select_done(ix, cx);
                                let key = this.done_rows[ix].key.to_string();
                                this.open_menu_key(&key, event.position, window, cx);
                            }),
                        )
                        .child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S14).color(theme.ink4))
                        .child(div().min_w_0().truncate().text_step(sidebar_step(TEXT_13)).text_color(theme.ink3).child(row.title.clone()))
                        .into_any_element(),
                )
            })
            .collect()
    }

    /// The collapsed rail's icons for the list rows `range`.
    fn render_rail(&mut self, range: Range<usize>, _window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        range
            .filter_map(|ix| {
                let row = self.rows.get(ix)?.clone();
                let name = list::project_label(&self.data.scopes[self.meta[ix].scope].project);
                let item = rail::item(&row, name, self.selected == Some(ix));
                Some(
                    div()
                        .flex()
                        .justify_center()
                        .w_full()
                        .h(px(rail::ITEM_SIZE + 1.0))
                        .child(
                            rail::icon(ix, &row, &item, cx)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    window.focus(&this.focus, cx);
                                    this.rail_card = None;
                                    this.select(ix, cx);
                                    cx.notify();
                                }))
                                .on_hover(cx.listener(move |this, hovered: &bool, window, cx| this.rail_hover(ix, *hovered, window, cx))),
                        )
                        .into_any_element(),
                )
            })
            .collect()
    }

    fn render_collapsed(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = *cx.theme();
        let button = |id: &'static str, icon: IconName| IconButton::new(id, icon).size(IconButtonSize::S32).glyph(IconSize::S16);
        let footer = self.footer(cx);
        let (on_add, on_filters) = (footer.on_add_project.clone(), footer.on_filters.clone());
        let dot = footer.filters_dot;
        let footer_bounds = footer.button_bounds.clone();
        let toast = self.toast_slot(cx);
        let marks = usage::rail_marks(&self.data.usage, &self.usage_hooks(cx), &theme);
        div()
            .id("sidebar")
            .key_context("Sidebar")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .flex_none()
            .w(px(rail::RAIL_WIDTH))
            .h_full()
            .bg(theme.canvas)
            .text_color(theme.ink)
            // The traffic lights and the window's bar sit over this header and run on past the rail's edge, over the Chat
            // header's leading edge (`workspace/shell/top_bar.rs`): one top row, expanded or not.
            .child(chrome::header("sidebar-header"))
            .child(div().h(px(8.0)).flex_none())
            .child(uniform_list("rail-list", self.rows.len(), cx.processor(Self::render_rail)).flex_1().min_h_0())
            .child(toast)
            .child(
                div()
                    .id("sidebar-footer")
                    .debug_selector(|| "sidebar-footer".to_string())
                    .flex()
                    .flex_col_reverse()
                    .items_center()
                    .flex_none()
                    .gap(px(4.0))
                    .py(px(6.0))
                    .border_t_1()
                    .border_color(theme.line)
                    // Under the footer's icons (the column is reversed, so first is lowest): each provider's mark.
                    .child(div().id("rail-usage").debug_selector(|| "rail-usage".into()).flex().flex_col().items_center().children(marks))
                    .child(
                        button("settings", IconName::Settings01)
                            .on_click(|_, window, cx| window.dispatch_action(Box::new(crate::settings::ToggleSettings), cx)),
                    )
                    .child(
                        div()
                            .relative()
                            .child(
                                gpui::canvas(
                                    {
                                        let cell = footer_bounds.clone();
                                        move |bounds, _, _| cell.set(bounds)
                                    },
                                    |_, _, _, _| (),
                                )
                                .absolute()
                                .size_full(),
                            )
                            .child(
                                button("filters", IconName::Filter)
                                    .pressed(self.filters_open.is_some())
                                    .on_click(move |_, window, cx| on_filters(window, cx)),
                            )
                            .children(dot.map(|dot| {
                                let color = if dot == bottom::FiltersDot::Away { theme.orange } else { theme.accent };
                                div()
                                    .debug_selector(|| "filters-dot".into())
                                    .absolute()
                                    .top(px(4.0))
                                    .right(px(4.0))
                                    .size(px(6.0))
                                    .rounded_full()
                                    .bg(color)
                            })),
                    )
                    .child(button("add-project", IconName::FolderAdd).on_click(move |_, window, cx| on_add(window, cx))),
            )
            .children(self.overlays(window, cx))
            .into_any_element()
    }
}

impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(demo) = self.demo.take() {
            self.apply_demo(&demo, window, cx);
        }
        if self.collapsed {
            return self.render_collapsed(window, cx);
        }
        let theme = *cx.theme();
        let pinned: Vec<AnyElement> = (0..self.pinned).map(|ix| self.row_view(ix, window, cx)).collect();
        let pinned_empty = pinned.is_empty();
        let (footer, toast) = (self.footer(cx), self.toast_slot(cx));
        let done = bottom::DoneSection {
            count: self.done,
            open: self.done_open,
            on_toggle: {
                let sidebar = cx.entity();
                Rc::new(move |_, cx| sidebar.update(cx, |sidebar, cx| sidebar.toggle_done(cx)))
            },
            list: (self.done_open && self.done > 0).then(|| {
                uniform_list("done-list", self.done_rows.len(), cx.processor(Self::render_done_rows))
                    .track_scroll(&self.done_scroll)
                    .h(px(bottom::DONE_LIST_HEIGHT.min(bottom::DONE_ROW * self.done_rows.len() as f32 + 2.0)))
                    .into_any_element()
            }),
        };
        div()
            .id("sidebar")
            .key_context("Sidebar")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| window.focus(&this.focus, cx)))
            .flex()
            .flex_col()
            .flex_none()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .bg(theme.canvas)
            .text_color(theme.ink)
            .child(header({
                let sidebar = cx.entity();
                move |_, cx| sidebar.update(cx, |_, cx| cx.emit(SidebarEvent::NewChat))
            }))
            .when(!pinned.is_empty(), |el| {
                el.child(
                    div()
                        .id("sidebar-pinned")
                        .debug_selector(|| "sidebar-pinned".into())
                        .flex()
                        .flex_col()
                        .flex_none()
                        .pt(px(LIST_TOP - ROW_GAP / 2.0))
                        .children(pinned),
                )
            })
            .when(pinned_empty, |el| el.child(div().flex_none().h(px(LIST_TOP - ROW_GAP / 2.0))))
            .child(
                uniform_list("chat-list", self.rows.len() - self.pinned, cx.processor(Self::render_rows))
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0(),
            )
            .child(bottom::bottom_group(done, usage::rows(&self.data.usage, &self.usage_hooks(cx), &theme), toast, footer, &theme))
            .children(self.overlays(window, cx))
            .into_any_element()
    }
}

/// 44px title-bar header: the traffic lights sit at the left (see `app.rs`), the window's bar beside them (the
/// sidebar toggle, Routines, Link Projects and Search, drawn by `workspace/shell/top_bar.rs` from x 80 to 232), and
/// the New Chat button with its 16px glyph at x 272 (a 24px hit area centred on it).
fn header(on_new_chat: impl Fn(&mut Window, &mut gpui::App) + 'static) -> impl IntoElement {
    chrome::header("sidebar-header").relative().child(
        div().absolute().left(px(268.0)).top(px(10.0)).no_drag().child(
            IconButton::new("new-chat", IconName::PencilEdit02)
                .size(IconButtonSize::S24)
                .glyph(IconSize::S16)
                .on_click(move |_, window, cx| on_new_chat(window, cx)),
        ),
    )
}

#[cfg(test)]
mod drag_tests;
#[cfg(test)]
mod menu_tests;
