//! Sidebar column (304px, `canvas`): header with three icon buttons, destinations, the section label,
//! a virtualized Chat list, and a pinned bottom group (Done, usage, footer).
//!
//! The list is drawn through `uniform_list`, GPUI's virtualized list for rows of one fixed height, so
//! only the rows in (or just around) the viewport are built each frame. Fixture data is in
//! `fixtures.rs`. Icons are stroked vector paths painted in a `canvas` element: GPUI's `svg()` needs an
//! `AssetSource` registered on `Application`, which lives in `main.rs`.
//!
//! Keyboard: the sidebar owns a `FocusHandle` (`track_focus`); clicking a row or the sidebar focuses it,
//! and `on_key_down` moves the selection on Up/Down and scrolls the row into view through the
//! `UniformListScrollHandle`.

#[cfg(test)]
mod tests;

use std::f32::consts::TAU;
use std::ops::Range;

use gpui::{
    ClickEvent, Context, FocusHandle, FontWeight, KeyDownEvent, MouseButton, PathBuilder, Pixels, Rgba, ScrollStrategy, SharedString,
    UniformListScrollHandle, Window, canvas, div, point, prelude::*, px, uniform_list,
};

pub use crate::data::fixture::{ChatRow, ChatStatus};
use crate::data::fixture::{LogoKind, USAGE, UsageRow, chat_fixtures};
use crate::theme::{
    ActiveTheme, CONTROL_MD, CONTROL_XS, RADIUS_CHIP, RADIUS_CONTROL, ROW_TWO_LINE, StyledText, TEXT_11, TEXT_12, TEXT_13, Theme, hex,
};
use crate::ui::legacy_icons::{ProviderLogo, provider_logo};
use crate::workspace::chrome;

pub const SIDEBAR_WIDTH: f32 = 304.0;
/// Horizontal inset of each row inside the sidebar.
const ROW_INSET: f32 = 8.0;
const TILE_SIZE: f32 = 24.0;
const ICON: f32 = 16.0;
const DONE_HEIGHT: f32 = 40.0;
const FOOTER_HEIGHT: f32 = 44.0;
const SECTION_HEIGHT: f32 = 28.0;

pub struct Sidebar {
    rows: Vec<ChatRow>,
    selected: Option<usize>,
    focus: FocusHandle,
    scroll: UniformListScrollHandle,
    /// Rows the list asked for in the last frame (`render_rows` range), to see virtualization at work.
    visible: Range<usize>,
    /// Total `render_row` calls so far.
    rows_built: usize,
}

impl Sidebar {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            rows: chat_fixtures(),
            selected: Some(1),
            focus: cx.focus_handle(),
            scroll: UniformListScrollHandle::new(),
            visible: 0..0,
            rows_built: 0,
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

    /// How many times a Chat row element has been built since the sidebar was created.
    pub fn rows_built(&self) -> usize {
        self.rows_built
    }

    fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.selected != Some(ix) {
            self.selected = Some(ix);
            cx.notify();
        }
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

    fn render_rows(&mut self, range: Range<usize>, _window: &mut Window, cx: &mut Context<Self>) -> Vec<impl IntoElement + use<>> {
        let theme = *cx.theme();
        self.visible = range.clone();
        self.rows_built += range.len();
        range.map(|ix| self.render_row(ix, &theme, cx)).collect()
    }

    fn render_row(&self, ix: usize, theme: &Theme, cx: &Context<Self>) -> impl IntoElement + use<> {
        let row = &self.rows[ix];
        let selected = self.selected == Some(ix);
        let hover = theme.hover;
        // Outer box carries the 8px side inset so the rounded fill stops short of the edges.
        div().px(px(ROW_INSET)).child(
            div()
                .id(("chat-row", ix))
                .debug_selector(move || format!("chat-row-{ix}"))
                .h(ROW_TWO_LINE)
                .px_2()
                .flex()
                .items_center()
                .gap_2()
                .rounded(RADIUS_CONTROL)
                .cursor_pointer()
                .when(selected, |el| el.bg(theme.hover2))
                .when(!selected, |el| el.hover(move |style| style.bg(hover)))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.select(ix, cx);
                }))
                .child(project_tile(row, theme))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_step(TEXT_13)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink)
                                .truncate()
                                .child(row.title.clone()),
                        )
                        .child(
                            div()
                                .text_step(TEXT_12)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink3)
                                .truncate()
                                .child(row.detail.clone()),
                        ),
                )
                .child(div().flex().flex_none().items_center().justify_center().w(px(ICON)).child(status_mark(row.status, theme))),
        )
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
            .child(header(&theme))
            .child(destination("canvas", "Canvas", Icon::Canvas, false, &theme))
            .child(destination("routines", "Routines", Icon::Clock, true, &theme))
            .child(destination("links", "Links", Icon::Link, false, &theme))
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
                    .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child("All Chats"))
                    .child(icon(Icon::Filter, theme.ink3)),
            )
            .child(
                uniform_list("chat-list", self.rows.len(), cx.processor(Self::render_rows)).track_scroll(&self.scroll).flex_1().min_h_0(),
            )
            .child(bottom_group(&theme))
    }
}

/// 44px title-bar header: the traffic lights sit at the left (see `main.rs`), three 16px icon buttons at
/// x 208, 240 and 272. Each button has a 24px hit area centred on its glyph.
fn header(theme: &Theme) -> impl IntoElement + use<> {
    let button = |name: &'static str, kind: Icon, x: f32| {
        let hover = theme.hover;
        div()
            .id(name)
            .debug_selector(move || name.to_string())
            .absolute()
            .left(px(x - 4.0))
            .top(px(10.0))
            .size(CONTROL_XS)
            .flex()
            .items_center()
            .justify_center()
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .child(icon(kind, theme.ink3))
    };
    chrome::header("sidebar-header")
        .relative()
        .child(button("hide-sidebar", Icon::PanelLeft, 208.0))
        .child(button("search", Icon::Search, 240.0))
        .child(button("new-chat", Icon::SquarePen, 272.0))
}

/// A 32px destination row: icon at x 12, label at x 40, optional accent dot at x 268.
fn destination(id: &'static str, label: &'static str, kind: Icon, dot: bool, theme: &Theme) -> impl IntoElement + use<> {
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
            .child(icon(kind, theme.ink3))
            .child(div().flex_1().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(label))
            .when(dot, |el| el.child(dot_mark(theme.accent))),
    )
}

/// Done row, usage block and footer, each under a 1px `line` rule.
fn bottom_group(theme: &Theme) -> impl IntoElement + use<> {
    let rule = || div().flex_none().h(px(1.0)).w_full().bg(theme.line);
    let hover = theme.hover;
    let done = div()
        .id("sidebar-done")
        .debug_selector(|| "sidebar-done".to_string())
        .flex()
        .flex_none()
        .items_center()
        .h(px(DONE_HEIGHT))
        .px(px(20.0))
        .gap(px(8.0))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon(Icon::ChevronRight, theme.ink3))
        .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Done"))
        .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child("35"));
    let usage = div()
        .id("sidebar-usage")
        .debug_selector(|| "sidebar-usage".to_string())
        .flex()
        .flex_col()
        .flex_none()
        .py(px(8.0))
        .children(USAGE.iter().map(|row| usage_row(row, theme)));
    let footer = div()
        .id("sidebar-footer")
        .debug_selector(|| "sidebar-footer".to_string())
        .flex()
        .flex_none()
        .items_center()
        .justify_between()
        .h(px(FOOTER_HEIGHT))
        .px(px(20.0))
        .child(icon(Icon::FolderPlus, theme.ink3))
        .child(icon(Icon::Sliders, theme.ink3));
    div().flex().flex_col().flex_none().child(rule()).child(done).child(rule()).child(usage).child(rule()).child(footer)
}

/// A project tile: the project's identity colour, or `field`, with its initial at 600.
fn project_tile(row: &ChatRow, theme: &Theme) -> impl IntoElement + use<> {
    let (fill, ink) = match row.tile {
        Some(color) => (color, hex("#ffffff")),
        None => (theme.field, theme.ink2),
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(TILE_SIZE))
        .rounded(RADIUS_CHIP)
        .bg(fill)
        .text_color(ink)
        .text_size(px(11.0))
        .line_height(px(TEXT_11.line_height))
        .font_weight(FontWeight::SEMIBOLD)
        .child(SharedString::from(row.initial.to_string()))
}

fn dot_mark(color: Rgba) -> gpui::Div {
    div().flex_none().size(px(8.0)).rounded_full().bg(color)
}

/// The trailing status of a row. Placeholder glyphs: a ring, a "?" and a "!" stand in for real icons.
fn status_mark(status: ChatStatus, theme: &Theme) -> gpui::AnyElement {
    let glyph = |text: &'static str, color: Rgba| {
        div().flex_none().text_step(TEXT_12).font_weight(FontWeight::SEMIBOLD).text_color(color).child(text).into_any_element()
    };
    match status {
        ChatStatus::None => div().into_any_element(),
        ChatStatus::Running => icon(Icon::Spinner, theme.ink3).into_any_element(),
        ChatStatus::NeedsApproval => icon(Icon::Ring, theme.orange).into_any_element(),
        ChatStatus::Question => glyph("?", theme.orange),
        ChatStatus::Failed => glyph("!", theme.red),
        ChatStatus::Unread => dot_mark(theme.accent).into_any_element(),
    }
}

// Icons: strokes on a 16 x 16 grid, 1.5px wide, painted with `PathBuilder`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Icon {
    PanelLeft,
    Search,
    SquarePen,
    Canvas,
    Clock,
    Link,
    Filter,
    ChevronRight,
    FolderPlus,
    Sliders,
    Spinner,
    Ring,
}

enum Stroke {
    Line(Vec<(f32, f32)>),
    Closed(Vec<(f32, f32)>),
}

fn arc(cx: f32, cy: f32, r: f32, from: f32, to: f32, steps: usize) -> Vec<(f32, f32)> {
    (0..=steps)
        .map(|i| {
            let a = from + (to - from) * i as f32 / steps as f32;
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect()
}

fn circle(cx: f32, cy: f32, r: f32) -> Stroke {
    let mut points = arc(cx, cy, r, 0.0, TAU, 24);
    points.pop();
    Stroke::Closed(points)
}

fn rrect(x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> Stroke {
    use std::f32::consts::FRAC_PI_2 as Q;
    let mut p = arc(x1 - r, y0 + r, r, -Q, 0.0, 4);
    p.extend(arc(x1 - r, y1 - r, r, 0.0, Q, 4));
    p.extend(arc(x0 + r, y1 - r, r, Q, 2.0 * Q, 4));
    p.extend(arc(x0 + r, y0 + r, r, 2.0 * Q, 3.0 * Q, 4));
    Stroke::Closed(p)
}

fn strokes(kind: Icon) -> Vec<Stroke> {
    use Stroke::{Closed, Line};
    match kind {
        Icon::PanelLeft => vec![rrect(2.0, 3.0, 14.0, 13.0, 2.0), Line(vec![(6.0, 3.0), (6.0, 13.0)])],
        Icon::Search => vec![circle(7.0, 7.0, 4.5), Line(vec![(10.3, 10.3), (13.5, 13.5)])],
        Icon::SquarePen => vec![
            Line(vec![(9.0, 3.0), (5.0, 3.0), (3.0, 5.0), (3.0, 11.0), (5.0, 13.0), (11.0, 13.0), (13.0, 11.0), (13.0, 7.0)]),
            Line(vec![(7.0, 9.0), (7.4, 7.4), (12.2, 2.6), (13.4, 3.8), (8.6, 8.6), (7.0, 9.0)]),
        ],
        Icon::Canvas => vec![
            rrect(2.5, 2.5, 7.0, 7.0, 1.0),
            rrect(9.0, 2.5, 13.5, 7.0, 1.0),
            rrect(2.5, 9.0, 7.0, 13.5, 1.0),
            rrect(9.0, 9.0, 13.5, 13.5, 1.0),
        ],
        Icon::Clock => vec![circle(8.0, 8.0, 5.5), Line(vec![(8.0, 5.0), (8.0, 8.0), (10.0, 9.5)])],
        Icon::Link => vec![circle(4.0, 8.0, 2.0), circle(12.0, 8.0, 2.0), Line(vec![(6.0, 8.0), (10.0, 8.0)])],
        Icon::Filter => {
            vec![Line(vec![(2.0, 4.0), (14.0, 4.0)]), Line(vec![(4.0, 8.0), (12.0, 8.0)]), Line(vec![(6.0, 12.0), (10.0, 12.0)])]
        }
        Icon::ChevronRight => vec![Line(vec![(6.0, 4.0), (10.0, 8.0), (6.0, 12.0)])],
        Icon::FolderPlus => vec![
            Closed(vec![(2.0, 4.5), (6.0, 4.5), (7.5, 6.0), (14.0, 6.0), (14.0, 12.5), (2.0, 12.5)]),
            Line(vec![(8.0, 8.0), (8.0, 11.0)]),
            Line(vec![(6.5, 9.5), (9.5, 9.5)]),
        ],
        Icon::Sliders => vec![
            Line(vec![(2.0, 5.0), (8.3, 5.0)]),
            Line(vec![(11.7, 5.0), (14.0, 5.0)]),
            circle(10.0, 5.0, 1.7),
            Line(vec![(2.0, 11.0), (4.3, 11.0)]),
            Line(vec![(7.7, 11.0), (14.0, 11.0)]),
            circle(6.0, 11.0, 1.7),
        ],
        Icon::Spinner => vec![Stroke::Line(arc(8.0, 8.0, 4.5, 0.0, TAU * 0.75, 18))],
        Icon::Ring => vec![circle(8.0, 8.0, 4.0)],
    }
}

/// A 16px stroked icon in `color`.
fn icon(kind: Icon, color: Rgba) -> impl IntoElement + use<> {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let unit: Pixels = bounds.size.width / ICON;
            let mut builder = PathBuilder::stroke(px(1.5));
            for stroke in strokes(kind) {
                let (points, closed) = match &stroke {
                    Stroke::Line(p) => (p, false),
                    Stroke::Closed(p) => (p, true),
                };
                let at = |&(x, y): &(f32, f32)| point(bounds.origin.x + unit * x, bounds.origin.y + unit * y);
                let mapped: Vec<_> = points.iter().map(at).collect();
                builder.add_polygon(&mapped, closed);
            }
            if let Ok(path) = builder.build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(ICON))
}

const USAGE_ROW_HEIGHT: f32 = 32.0;
const METER_WIDTH: f32 = 68.0;

/// One provider row: logo at x 12, name at x 40, then one or two meters ending at x 276.
fn usage_row(row: &UsageRow, theme: &Theme) -> impl IntoElement + use<> {
    let logo = match row.logo {
        LogoKind::Claude => ProviderLogo::Claude,
        LogoKind::Codex => ProviderLogo::Codex,
        LogoKind::Antigravity => ProviderLogo::Antigravity,
    };
    let single = row.windows.len() == 1;
    let mut el = div()
        .relative()
        .flex_none()
        .w(px(288.0))
        .h(px(USAGE_ROW_HEIGHT))
        .debug_selector({
            let name = row.name;
            move || format!("usage-row-{name}")
        })
        .child(div().absolute().left(px(12.0)).top(px(8.0)).child(provider_logo(logo, 16.0, 1.6, row.color)))
        .child(
            div()
                .absolute()
                .left(px(40.0))
                .top(px(8.0))
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child(row.name),
        );
    if row.warning {
        el = el.child(div().absolute().left(px(86.0)).top(px(10.0)).child(provider_logo(ProviderLogo::Warning, 12.0, 1.5, theme.orange)));
    }
    for (i, w) in row.windows.iter().enumerate() {
        let (x, width) = if single { (132.0, 144.0) } else { (132.0 + 76.0 * i as f32, METER_WIDTH) };
        let fill = if w.percent == 0 { 0.0 } else { (width * w.percent as f32 / 100.0).max(2.0) };
        let id = format!("usage-meter-{}-{i}", row.name);
        let track_id = format!("usage-track-{}-{i}", row.name);
        let fill_id = format!("usage-fill-{}-{i}", row.name);
        el = el
            .child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(3.0))
                    .w(px(width))
                    .debug_selector(move || id.clone())
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink3)
                    .text_right()
                    .child(w.label),
            )
            .child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(23.0))
                    .w(px(width))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(theme.line)
                    .debug_selector(move || track_id.clone()),
            );
        if fill > 0.0 {
            el = el.child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(23.0))
                    .w(px(fill))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(theme.ink3)
                    .debug_selector(move || fill_id.clone()),
            );
        }
    }
    el
}
