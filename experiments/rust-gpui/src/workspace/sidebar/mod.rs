//! Sidebar column (304px, `canvas`): header with three icon buttons, destinations, the section label,
//! a virtualized Chat list, and a pinned bottom group (Done, usage, footer: `bottom.rs`).
//!
//! The list is drawn through `uniform_list`, GPUI's virtualized list for rows of one fixed height, so
//! only the rows in (or just around) the viewport are built each frame. Each row is a view of its own
//! (`row.rs`) mounted as a cached view, so a sidebar re-render reuses the rows that did not change.
//! Fixture data is in `data/fixture.rs`.
//!
//! Keyboard: the sidebar owns a `FocusHandle` (`track_focus`); clicking a row or the sidebar focuses it,
//! and `on_key_down` moves the selection on Up/Down and scrolls the row into view through the
//! `UniformListScrollHandle`.

mod bottom;
mod row;

#[cfg(test)]
mod tests;

use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, Context, Entity, FocusHandle, FontWeight, KeyDownEvent, MouseButton, ScrollStrategy, StyleRefinement,
    Subscription, UniformListScrollHandle, Window, div, prelude::*, px, uniform_list,
};

pub use crate::data::ChatStatus;
use crate::data::fixture::FixtureData;
use crate::theme::{ActiveTheme, CONTROL_MD, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, SectionLabel};
use crate::workspace::chrome::{self, NoDrag};
pub use row::ChatRow;
use row::{ChatRowView, ROW_INSET, RowEvent, dot_mark};

pub const SIDEBAR_WIDTH: f32 = 304.0;
const SECTION_HEIGHT: f32 = 28.0;
/// Row views kept on each side of the visible range, so scrolling back a little does not rebuild them.
/// A fixed margin, not a multiple of the range: `uniform_list` also asks for `0..1` to measure a row, and
/// that call must not evict the real rows (a new entity per frame would lose clicks and the cache).
const KEEP_ROWS: usize = 64;

pub struct Sidebar {
    rows: Vec<ChatRow>,
    selected: Option<usize>,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    /// The views of the rows in and near the viewport, by row index, with their click subscriptions.
    row_views: HashMap<usize, (Entity<ChatRowView>, Subscription)>,
    /// Rows the list asked for in the last frame (`render_rows` range), to see virtualization at work.
    visible: Range<usize>,
    /// Total `ChatRowView::render` calls so far, shared with the row views.
    rows_built: Rc<Cell<usize>>,
}

impl Sidebar {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            rows: fixture_rows(),
            selected: Some(1),
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            row_views: HashMap::new(),
            visible: 0..0,
            rows_built: Rc::new(Cell::new(0)),
        }
    }

    pub fn selected(&self) -> Option<usize> {
        self.selected
    }

    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// Row indices the list built in the last frame.
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
        if ix <= self.visible.start {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Top);
        } else if ix + 1 >= self.visible.end {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Bottom);
        }
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

    /// The visible rows as cached views. Creates the views that are missing and drops the ones far away.
    fn render_rows(&mut self, range: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        self.visible = range.clone();
        let keep = range.start.saturating_sub(KEEP_ROWS)..range.end + KEEP_ROWS;
        self.row_views.retain(|ix, _| keep.contains(ix));
        range
            .map(|ix| {
                let view = match self.row_views.get(&ix) {
                    Some((view, _)) => view.clone(),
                    None => {
                        let (row, selected, renders) = (self.rows[ix].clone(), self.selected == Some(ix), self.rows_built.clone());
                        let view = cx.new(|_| ChatRowView::new(ix, row, selected, renders));
                        let clicks = cx.subscribe_in(&view, window, move |this, _, event: &RowEvent, window, cx| match event {
                            RowEvent::Clicked => {
                                window.focus(&this.focus, cx);
                                this.select(ix, cx);
                            }
                        });
                        self.row_views.insert(ix, (view.clone(), clicks));
                        view
                    }
                };
                AnyView::from(view).cached(StyleRefinement::default().w_full().h(ROW_TWO_LINE)).into_any_element()
            })
            .collect()
    }
}

impl Render for Sidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
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
            .child(header())
            .child(destination("canvas", "Canvas", IconName::FlowConnection, false, &theme))
            .child(destination("routines", "Routines", IconName::TimeSchedule, true, &theme))
            .child(destination("links", "Links", IconName::Link04, false, &theme))
            .child(
                div()
                    .id("section-label")
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
                uniform_list("chat-list", self.rows.len(), cx.processor(Self::render_rows)).track_scroll(&self.scroll).flex_1().min_h_0(),
            )
            .child(bottom::bottom_group(&theme))
    }
}

/// The fixture's All Chats list as rows. The seam for real data: read `state:read` and `chat:runs` through
/// the app's `DataSource` and map each Chat with `ChatRow::new` the same way.
fn fixture_rows() -> Vec<ChatRow> {
    let data = FixtureData::new();
    data.chats.iter().map(|listed| ChatRow::new(listed, &data.projects[listed.project])).collect()
}

/// 44px title-bar header: the traffic lights sit at the left (see `app.rs`), three 16px icon buttons at
/// x 208, 240 and 272. Each button has a 24px hit area centred on its glyph.
fn header() -> impl IntoElement {
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
        .child(button("new-chat", IconName::PencilEdit02, 272.0))
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
