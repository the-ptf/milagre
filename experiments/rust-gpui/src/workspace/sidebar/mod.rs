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
//! Keyboard: the sidebar owns a `FocusHandle` (`track_focus`); clicking a row or the sidebar focuses it,
//! and `on_key_down` moves the selection on Up/Down and scrolls the row into view through the
//! `UniformListScrollHandle`.

mod bottom;
pub mod list;
mod row;

#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, Context, Entity, FocusHandle, FontWeight, KeyDownEvent, MouseButton, ScrollStrategy, StyleRefinement,
    Subscription, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list,
};

use crate::data::{Data, Polled, poll_once};
use crate::logic::lists::order::ChatOrder;
use crate::theme::{ActiveTheme, CONTROL_MD, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, SectionLabel};
use crate::workspace::chrome::{self, NoDrag};
pub use list::{ChatLists, SidebarData, SidebarSeed};
pub use row::ChatRow;
use row::{ChatRowView, ROW_INSET, RowEvent, dot_mark};

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
        let mut this = Self {
            data: SidebarData::default(),
            opened: seed.open_families,
            rows: Vec::new(),
            pinned: 0,
            done: 0,
            selected: None,
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            row_views: HashMap::new(),
            visible: 0..0,
            rows_built: Rc::new(Cell::new(0)),
            _load: None,
        };
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
        let lists = list::chat_lists(&self.data, CHAT_ORDER, &self.opened);
        self.pinned = lists.pinned.len();
        self.done = lists.done.len();
        self.rows = lists.pinned.iter().chain(&lists.rows).map(|shown| ChatRow::new(shown, &self.data)).collect();
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

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
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
                let view = cx.new(|_| ChatRowView::new(ix, row, selected, renders));
                let events = cx.subscribe_in(&view, window, move |this, _, event: &RowEvent, window, cx| match event {
                    RowEvent::Clicked => {
                        window.focus(&this.focus, cx);
                        this.select(ix, cx);
                    }
                    RowEvent::ToggleFamily => this.toggle_family(ix, cx),
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

impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let pinned: Vec<AnyElement> = (0..self.pinned).map(|ix| self.row_view(ix, window, cx)).collect();
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
                    .child(SectionLabel::new("All Chats"))
                    .child(Icon::new(IconName::Filter).color(theme.ink3)),
            )
            .child(
                uniform_list("chat-list", self.rows.len() - self.pinned, cx.processor(Self::render_rows))
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0(),
            )
            .child(bottom::bottom_group(self.done, &self.data.usage, &theme))
    }
}

/// 44px title-bar header: the traffic lights sit at the left (see `app.rs`), three 16px icon buttons at
/// x 208, 240 and 272. Each button has a 24px hit area centred on its glyph.
fn header(on_new_chat: impl Fn(&mut Window, &mut gpui::App) + 'static) -> impl IntoElement {
    let on_new_chat = Rc::new(on_new_chat);
    let button = |name: &'static str, icon: IconName, x: f32| {
        div()
            .absolute()
            .left(px(x - 4.0))
            .top(px(10.0))
            .no_drag()
            .child(IconButton::new(name, icon).size(IconButtonSize::S24).glyph(IconSize::S16))
    };
    chrome::header("sidebar-header")
        .relative()
        .child(button("hide-sidebar", IconName::SidebarLeft01, 208.0))
        .child(button("search", IconName::Search01, 240.0))
        .child(
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
