//! Sidebar column (304px, `canvas`): header with three icon buttons, destinations, the Pinned rows, the
//! "All Chats" label and a virtualized Chat list, and a pinned bottom group (Done, usage, footer: `bottom.rs`).
//!
//! The rows come from the app's [`Data`] source through `list.rs`, which runs the shared list rules
//! (`logic::lists`: listing, pins, order, Done, Subchat families) and the mark rules (`logic::marks`). Pinned rows
//! sit above the "All Chats" label, as in the desktop's one-list layout; the rest are drawn through `uniform_list`,
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

#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, AnyView, Bounds, Context, Entity, FocusHandle, FontWeight, KeyDownEvent, MouseButton, Pixels, ScrollStrategy, SharedString,
    StyleRefinement, Subscription, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list,
};

use crate::data::{Data, Polled, poll_once};
use crate::logic::lists::chat_row::{ChatRowShow, DESKTOP_CHAT_ROW_SHOW};
use crate::logic::lists::order::ChatOrder;
use crate::theme::{ActiveTheme, CONTROL_MD, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, SectionLabel};
use crate::workspace::chat::pills::bookmark::FamilyChat;
use crate::workspace::chrome::{self, NoDrag};
pub use actions::{Actions, ArchiveMode, ChatPatch, RecordingActions, SidebarActions, SidebarCall};
use list::ListFilters;
pub use list::{ChatLists, SidebarData, SidebarSeed};
pub use row::ChatRow;
use row::{ChatRowView, ROW_INSET, RowEvent, RowMeta, dot_mark};

pub const SIDEBAR_WIDTH: f32 = 304.0;
const SECTION_HEIGHT: f32 = 28.0;
/// Row views kept on each side of the visible range, so scrolling back a little does not rebuild them.
/// A fixed margin, not a multiple of the range: `uniform_list` also asks for `0..1` to measure a row, and
/// that call must not evict the real rows (a new entity per frame would lose clicks and the cache).
const KEEP_ROWS: usize = 64;
/// The desktop's default Chat order (`DEFAULTS.chatOrder` in `lib/settings.ts`).
const CHAT_ORDER: ChatOrder = ChatOrder::Created;

pub struct Sidebar {
    data: SidebarData,
    /// The families this device opened, by the parent's Chat key.
    opened: HashSet<String>,
    /// The Pinned rows, then the All Chats rows.
    rows: Vec<ChatRow>,
    /// Where each row's Chat lives, parallel to `rows`.
    meta: Vec<RowMeta>,
    pinned: usize,
    done: usize,
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
    /// The editor "Open in …" names.
    editor: Option<SharedString>,
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
    /// Snapshot seed (never in tests): a state to open on the first frame, from `MILAGRE_GPUI_SIDEBAR_DEMO`.
    demo: Option<String>,
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
    /// The Routines button: the window shows the Routines page in place of the Chat column.
    Routines,
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
            opened: seed.open_families,
            rows: Vec::new(),
            meta: Vec::new(),
            pinned: 0,
            done: 0,
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
            editor: Some("Zed".into()),
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
            demo: if cfg!(test) { None } else { std::env::var("MILAGRE_GPUI_SIDEBAR_DEMO").ok() },
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
        let lists = list::chat_lists_with(&self.data, CHAT_ORDER, &self.opened, &self.list_filters);
        self.pinned = lists.pinned.len();
        self.done = lists.done.len();
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

    fn toggle_family(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(key) = self.rows.get(ix).map(|row| row.key.to_string()) else { return };
        if !self.opened.remove(&key) {
            self.opened.insert(key);
        }
        self.rebuild(None);
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
                let view = cx.new(|_| {
                    let mut view = ChatRowView::new(ix, row, selected, renders);
                    view.set_rename_silently(renaming);
                    view.set_draggable(pinned, dragging);
                    view
                });
                let events = cx.subscribe_in(&view, window, move |this, _, event: &RowEvent, window, cx| match event {
                    RowEvent::Clicked => {
                        window.focus(&this.focus, cx);
                        this.select(ix, cx);
                    }
                    RowEvent::ToggleFamily => this.toggle_family(ix, cx),
                    RowEvent::ContextMenu(at) => this.open_menu(ix, *at, window, cx),
                    RowEvent::Hover(bounds) => this.hover_row(ix, *bounds, cx),
                });
                self.row_views.insert(ix, (view.clone(), events));
                view
            }
        };
        AnyView::from(view).cached(StyleRefinement::default().w_full().h(ROW_TWO_LINE)).into_any_element()
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
            // The traffic lights and the window's bar (with its Expand sidebar toggle) sit over this header and run on
            // past the rail's edge (`workspace/shell/top_bar.rs`).
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
        let (footer, toast) = (self.footer(cx), self.toast_slot(cx));
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
            .child(destination("canvas", "Canvas", IconName::FlowConnection, false, &theme))
            .child(div().id("routines-button").on_click(cx.listener(|_, _, _, cx| cx.emit(SidebarEvent::Routines))).child(destination(
                "routines",
                "Routines",
                IconName::TimeSchedule,
                true,
                &theme,
            )))
            .child(destination("links", "Links", IconName::Link04, false, &theme))
            .when(!pinned.is_empty(), |el| {
                el.child(
                    div()
                        .id("sidebar-pinned")
                        .debug_selector(|| "sidebar-pinned".into())
                        .flex()
                        .flex_col()
                        .flex_none()
                        .pt(px(4.0))
                        .children(pinned),
                )
            })
            .child(
                div()
                    .id("section-label")
                    .debug_selector(|| "section-label".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_between()
                    .h(px(SECTION_HEIGHT))
                    .pl(px(20.0))
                    .pr(px(16.0))
                    .child(SectionLabel::new("All Chats")),
            )
            .child(
                uniform_list("chat-list", self.rows.len() - self.pinned, cx.processor(Self::render_rows))
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0(),
            )
            .child(bottom::bottom_group(self.done, &self.data.usage, toast, footer, &theme))
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

/// A 32px destination row: icon at x 12, label at x 40, optional accent dot at x 268.
fn destination(id: &'static str, label: &'static str, icon: IconName, dot: bool, theme: &Theme) -> impl IntoElement + use<> {
    let hover = theme.hover;
    div().flex_none().px(px(ROW_INSET)).child(
        div()
            .id(id)
            .h(CONTROL_MD)
            .pl(px(4.0))
            .pr(px(20.0))
            .flex()
            .items_center()
            .gap(px(12.0))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .child(Icon::new(icon).color(theme.ink3))
            .child(div().flex_1().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(label))
            .when(dot, |el| el.child(dot_mark(theme.accent))),
    )
}

#[cfg(test)]
mod drag_tests;
#[cfg(test)]
mod menu_tests;
