//! Sidebar column: the traffic-light header and the Chat list.
//!
//! The list is placeholder fixture rows drawn through `uniform_list`, GPUI's virtualized list for
//! rows of one fixed height. A later step replaces `fixture_rows` with real Chats and adds nav rows.

use std::ops::Range;

use gpui::{ClickEvent, Context, FontWeight, SharedString, Window, div, prelude::*, px, uniform_list};

use crate::chrome;
use crate::theme::{ActiveTheme, RADIUS_CHIP, RADIUS_CONTROL, ROW_TWO_LINE, StyledText, TEXT_10, TEXT_12, TEXT_13, Theme};

pub const SIDEBAR_WIDTH: f32 = 304.0;
/// Horizontal inset of each row inside the sidebar.
const ROW_INSET: f32 = 8.0;
const TILE_SIZE: f32 = 24.0;

/// One two-line row in the Chat list.
#[derive(Clone, Debug)]
pub struct ChatRow {
    pub project: SharedString,
    pub title: SharedString,
    pub detail: SharedString,
}

pub struct Sidebar {
    rows: Vec<ChatRow>,
    selected: Option<usize>,
}

impl Sidebar {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self { rows: fixture_rows(), selected: Some(1) }
    }

    pub fn selected(&self) -> Option<usize> {
        self.selected
    }

    fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.selected != Some(ix) {
            self.selected = Some(ix);
            cx.notify();
        }
    }

    fn render_rows(&mut self, range: Range<usize>, _window: &mut Window, cx: &mut Context<Self>) -> Vec<impl IntoElement + use<>> {
        let theme = *cx.theme();
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
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.select(ix, cx)))
                .child(project_tile(&row.project, theme))
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
                        .child(div().text_step(TEXT_12).text_color(theme.ink3).truncate().child(row.detail.clone())),
                ),
        )
    }
}

impl Render for Sidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .bg(theme.canvas)
            // Empty: the macOS traffic lights sit here (see main.rs, TitlebarOptions).
            .child(chrome::header("sidebar-header"))
            .child(uniform_list("chat-list", self.rows.len(), cx.processor(Self::render_rows)).flex_1())
    }
}

/// A project tile without an image: an ink square with its on-ink initial at 600 (DESIGN.md, Radius).
fn project_tile(project: &str, theme: &Theme) -> impl IntoElement + use<> {
    let initial: SharedString = project.chars().next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default().into();
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(TILE_SIZE))
        .rounded(RADIUS_CHIP)
        .bg(theme.ink)
        .text_color(theme.on_ink)
        .text_step(TEXT_10)
        .font_weight(FontWeight::SEMIBOLD)
        .child(initial)
}

fn fixture_rows() -> Vec<ChatRow> {
    [
        ("milagre-ade", "GPUI spike: three-column shell", "milagre-ade · 2m"),
        ("milagre-ade", "Fix sidebar undo toast on iPad", "milagre-ade · 14m"),
        ("happiergym", "Workout export to HealthKit", "happiergym · 1h"),
        ("milagre-ade", "Relay Durable Object backoff", "milagre-ade · 3h"),
        ("site", "Landing page Lighthouse budget", "site · 5h"),
        ("happiergym", "Live Activity for rest timer", "happiergym · yesterday"),
        ("milagre-ade", "Rust owner: forced-close receipts", "milagre-ade · yesterday"),
        ("dotfiles", "Simslim profiles per project", "dotfiles · Mon"),
    ]
    .into_iter()
    .map(|(project, title, detail)| ChatRow { project: project.into(), title: title.into(), detail: detail.into() })
    .collect()
}
