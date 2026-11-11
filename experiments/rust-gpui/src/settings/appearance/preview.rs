//! The Appearance window preview (`AppearanceWindowPreview.tsx`, G-05): a miniature of the app window that follows the
//! current settings and outlines the area a row changes while dimming the rest.
//!
//! GPUI cannot scale a subtree, so this draws the 1440 x 900 window with every length multiplied by one scale factor
//! (`WindowPreview::scale`), with the live theme, the chat/code/sidebar sizes, the chat width and the sidebar usage
//! mode of the settings. It is a fixture workspace (the same chats and diff as the React preview), not a snapshot
//! of the real window. The Changes panel replay for Panel animations is not drawn.

use gpui::{AnyElement, App, Div, FontWeight, IntoElement, ParentElement, RenderOnce, Rgba, Styled, Window, div, prelude::*, px};

use super::model::AppearanceOptions;
use super::palette::Scheme;
use crate::data::Provider;
use crate::theme::{ActiveTheme, Appearance, Theme, mono};
use crate::ui::{ProjectAvatar, ProviderLogo};

/// The real window the miniature stands for.
pub const WINDOW_WIDTH: f32 = 1440.0;
pub const WINDOW_HEIGHT: f32 = 900.0;

/// The part of the window a setting changes. `Ui` is the interface font: everything but code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewArea {
    Sidebar,
    Chat,
    Code,
    Width,
    Diff,
    Ui,
    Usage,
}

#[derive(IntoElement)]
pub struct WindowPreview {
    options: AppearanceOptions,
    highlight: Option<PreviewArea>,
    scale: f32,
}

impl WindowPreview {
    pub fn new(options: AppearanceOptions, highlight: Option<PreviewArea>) -> Self {
        Self { options, highlight, scale: 0.4 }
    }

    /// Miniature pixels per real pixel.
    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }
}

struct Ctx {
    k: f32,
    highlight: Option<PreviewArea>,
    theme: Theme,
    options: AppearanceOptions,
    add: Rgba,
    remove: Rgba,
}

impl Ctx {
    fn u(&self, v: f32) -> gpui::Pixels {
        px(v * self.k)
    }

    /// One piece of the miniature: outlined while `area` is highlighted, dimmed to 40% while another area is and it
    /// is not in `keep`. An empty `keep` never dims (a container whose children dim themselves).
    fn part(&self, area: Option<PreviewArea>, keep: &[PreviewArea], el: Div) -> Div {
        let dim = self.highlight.is_some_and(|h| !keep.is_empty() && !keep.contains(&h));
        let outlined = area.is_some() && area == self.highlight;
        el.border(px((4.0 * self.k).max(1.0)))
            .border_color(if outlined { self.theme.accent } else { Rgba { a: 0.0, ..self.theme.accent } })
            .opacity(if dim { 0.4 } else { 1.0 })
    }

    fn text(&self, size: f32) -> Div {
        div().text_size(self.u(size)).line_height(self.u(size * 1.4))
    }
}

/// The diff text colours: the chosen pair, or the theme's own status inks.
pub fn diff_text_colors(options: &AppearanceOptions, theme: &Theme) -> (Rgba, Rgba) {
    let pair = super::model::diff_pair(&options.diff_colors);
    let colors = if theme.appearance == Appearance::Dark { pair.dark } else { pair.light };
    match colors {
        Some((add, remove)) => (super::palette::parse_rgba(add), super::palette::parse_rgba(remove)),
        None => (theme.green_ink, theme.red_ink),
    }
}

fn counts(c: &Ctx, added: u32, removed: u32, size: f32) -> Div {
    c.part(
        Some(PreviewArea::Diff),
        &[PreviewArea::Sidebar, PreviewArea::Diff],
        c.text(size)
            .flex()
            .gap(c.u(4.0))
            .font_family(mono())
            .child(div().text_color(c.add).child(format!("+{added}")))
            .child(div().text_color(c.remove).child(format!("\u{2212}{removed}"))),
    )
}

fn project_row(c: &Ctx, name: &str, current: bool) -> Div {
    let delta = c.options.sidebar_delta() as f32;
    c.part(
        None,
        &[PreviewArea::Sidebar, PreviewArea::Ui],
        div()
            .mx(c.u(8.0))
            .h(c.u(32.0))
            .px(c.u(8.0))
            .flex()
            .items_center()
            .gap(c.u(8.0))
            .child(ProjectAvatar::new(name).size(20.0 * c.k.max(0.6)))
            .child(
                c.text(13.0 + delta)
                    .flex_1()
                    .text_color(if current { c.theme.ink } else { c.theme.ink2 })
                    .when(current, |d| d.font_weight(FontWeight::MEDIUM))
                    .child(name.to_string()),
            ),
    )
}

fn chat_row(c: &Ctx, title: &str, added: u32, removed: u32, ago: &str, active: bool, mark: Option<bool>) -> Div {
    let delta = c.options.sidebar_delta() as f32;
    let dot = match mark {
        Some(true) => c.theme.accent,
        Some(false) => c.theme.accent_tint,
        None => c.theme.ink4,
    };
    div()
        .mx(c.u(8.0))
        .h(c.u(46.0))
        .px(c.u(8.0))
        .pt(c.u(6.0))
        .rounded(c.u(8.0))
        .relative()
        .when(active, |d| d.bg(c.theme.hover2))
        .child(
            c.part(
                None,
                &[PreviewArea::Sidebar, PreviewArea::Ui],
                div().flex().items_center().gap(c.u(8.0)).child(div().size(c.u(8.0)).rounded_full().bg(dot)).child(
                    c.text(14.0 + delta)
                        .flex_1()
                        .text_color(if active { c.theme.ink } else { c.theme.ink2 })
                        .when(active, |d| d.font_weight(FontWeight::MEDIUM))
                        .child(title.to_string()),
                ),
            ),
        )
        .child(
            div()
                .absolute()
                .top(c.u(26.0))
                .left(c.u(24.0))
                .flex()
                .items_center()
                .gap(c.u(8.0))
                .child(counts(c, added, removed, 11.0 + delta))
                .child(c.text(12.0 + delta).text_color(c.theme.ink3).child(ago.to_string())),
        )
}

fn usage(c: &Ctx, compact: bool) -> Div {
    let rows = [(Provider::Claude, "Claude", [(18, "5h"), (64, "wk")]), (Provider::Codex, "Codex", [(32, "5h"), (48, "wk")])];
    let mut col = div().flex().flex_col().gap(c.u(2.0));
    for (provider, name, windows) in rows {
        let mut row = div()
            .h(c.u(32.0))
            .px(c.u(8.0))
            .flex()
            .items_center()
            .gap(c.u(6.0))
            .child(ProviderLogo::new(provider).size(14.0 * c.k.max(0.6)));
        if compact {
            let peak = windows[0].0.max(windows[1].0) as f32;
            row = row.child(
                div().flex_1().flex().justify_center().child(
                    div()
                        .w(c.u(16.0))
                        .h(c.u(2.0))
                        .rounded_full()
                        .bg(c.theme.line_strong)
                        .child(div().h_full().w(c.u(16.0 * peak / 100.0)).rounded_full().bg(c.theme.ink3)),
                ),
            );
        } else {
            row = row.child(c.text(12.0).flex_1().text_color(c.theme.ink2).child(name.to_string()));
            for (percent, label) in windows {
                row = row.child(
                    div()
                        .w(c.u(48.0))
                        .flex()
                        .flex_col()
                        .items_end()
                        .gap(c.u(3.0))
                        .child(
                            c.text(12.0)
                                .flex()
                                .gap(c.u(3.0))
                                .child(div().text_color(c.theme.ink).child(format!("{percent}%")))
                                .child(div().text_color(c.theme.ink3).child(label)),
                        )
                        .child(
                            div()
                                .w_full()
                                .h(c.u(2.0))
                                .rounded_full()
                                .bg(c.theme.line_strong)
                                .child(div().h_full().w(c.u(48.0 * percent as f32 / 100.0)).rounded_full().bg(c.theme.ink3)),
                        ),
                );
            }
        }
        col = col.child(row);
    }
    c.part(
        Some(PreviewArea::Usage),
        &[PreviewArea::Sidebar, PreviewArea::Ui, PreviewArea::Usage],
        div().mx(c.u(8.0)).mt_auto().border_t(c.u(1.0)).border_color(c.theme.line).pt(c.u(6.0)).child(col),
    )
}

fn sidebar(c: &Ctx) -> Div {
    let header_chip = |label: &str| {
        c.text(13.0).h(c.u(32.0)).flex_1().flex().items_center().justify_center().text_color(c.theme.ink3).child(label.to_string())
    };
    c.part(
        Some(PreviewArea::Sidebar),
        &[],
        div()
            .w(c.u(272.0))
            .flex_none()
            .flex()
            .flex_col()
            .rounded(c.u(14.0))
            .bg(c.theme.surface)
            .pt(c.u(8.0))
            .child(c.part(
                None,
                &[PreviewArea::Sidebar, PreviewArea::Ui],
                div().mx(c.u(8.0)).mb(c.u(12.0)).flex().gap(c.u(4.0)).child(header_chip("Canvas")).child(header_chip("Search")),
            ))
            .child(project_row(c, "milagre", true))
            .child(chat_row(c, "Appearance mini preview", 248, 31, "2m", true, Some(true)))
            .child(chat_row(c, "Skill and file chips", 96, 12, "1h", false, Some(false)))
            .child(chat_row(c, "Fix the flaky surface test", 4, 9, "3h", false, None))
            .child(div().mt(c.u(12.0)).child(project_row(c, "relay", false)))
            .child(usage(c, c.options.sidebar_usage == "compact"))
            .child(div().h(c.u(48.0))),
    )
}

fn diff_line(c: &Ctx, marker: &str, text: &str, add: Option<bool>) -> Div {
    let tint = match add {
        Some(true) => Some(c.theme.diff_add),
        Some(false) => Some(c.theme.diff_remove),
        None => None,
    };
    let marker_color = match add {
        Some(true) => c.add,
        Some(false) => c.remove,
        None => c.theme.ink,
    };
    c.text(c.options.code_px() as f32)
        .font_family(mono())
        .flex()
        .pr(c.u(12.0))
        .when_some(tint, |d, t| d.bg(t))
        .child(div().w(c.u(24.0)).flex_none().flex().justify_center().text_color(marker_color).child(marker.to_string()))
        .child(div().text_color(c.theme.ink).child(text.to_string()))
}

fn code_block(c: &Ctx) -> Div {
    c.part(
        Some(PreviewArea::Code),
        &[PreviewArea::Code, PreviewArea::Diff, PreviewArea::Width],
        div().my(c.u(8.0)).child(
            div()
                .rounded(c.u(8.0))
                .border(c.u(1.0))
                .border_color(c.theme.line)
                .bg(c.theme.inset)
                .overflow_hidden()
                .child(
                    c.text(11.0)
                        .h(c.u(28.0))
                        .px(c.u(10.0))
                        .flex()
                        .items_center()
                        .border_b(c.u(1.0))
                        .border_color(c.theme.line)
                        .font_family(mono())
                        .text_color(c.theme.ink3)
                        .child("diff"),
                )
                .child(
                    div()
                        .py(c.u(6.0))
                        .flex()
                        .flex_col()
                        .child(diff_line(c, " ", "export function AppearanceSettings() {", None))
                        .child(diff_line(c, "\u{2212}", "  return <AppearancePreview />;", Some(false)))
                        .child(diff_line(c, "+", "  const [area, setArea] = useState<PreviewArea | null>(null);", Some(true)))
                        .child(diff_line(c, "+", "  return <AppearanceWindowPreview highlight={area} />;", Some(true)))
                        .child(diff_line(c, " ", "}", None)),
                ),
        ),
    )
}

fn composer(c: &Ctx) -> Div {
    c.part(
        Some(PreviewArea::Chat),
        &[PreviewArea::Chat, PreviewArea::Ui, PreviewArea::Width],
        div()
            .rounded(c.u(14.0))
            .bg(c.theme.surface)
            .p(c.u(6.0))
            .flex()
            .items_end()
            .gap(c.u(4.0))
            .child(
                c.text(c.options.chat_px() as f32)
                    .flex_1()
                    .px(c.u(4.0))
                    .py(c.u(5.0))
                    .text_color(c.theme.ink3)
                    .child("Prompt or mention a file with @"),
            )
            .child(
                c.text(12.0)
                    .h(c.u(28.0))
                    .px(c.u(10.0))
                    .flex()
                    .items_center()
                    .gap(c.u(6.0))
                    .text_color(c.theme.ink2)
                    .font_weight(FontWeight::MEDIUM)
                    .child(ProviderLogo::new(Provider::Claude).size(14.0 * c.k.max(0.6)))
                    .child("Opus 5.5 \u{b7} High"),
            )
            .child(div().size(c.u(28.0)).rounded_full().bg(c.theme.ink)),
    )
}

fn chat_column(c: &Ctx, available: f32) -> Div {
    let chat = c.options.chat_px() as f32;
    let chat_text = [PreviewArea::Chat, PreviewArea::Ui, PreviewArea::Width];
    let limit = c.options.chat_width_limit().map_or(available, |w| (w as f32).min(available));
    let body = |text: &str| c.part(None, &chat_text, c.text(chat).text_color(c.theme.ink).child(text.to_string()));
    c.part(
        Some(PreviewArea::Width),
        &[],
        div()
            .w(c.u(limit))
            .h_full()
            .mx_auto()
            .px(c.u(12.0))
            .pt(c.u(64.0))
            .pb(c.u(12.0))
            .flex()
            .flex_col()
            .gap(c.u(12.0))
            .child(
                c.part(
                    Some(PreviewArea::Chat),
                    &[],
                    div()
                        .flex()
                        .flex_col()
                        .gap(c.u(12.0))
                        .child(
                            div().flex().flex_col().items_end().pl(c.u(48.0)).child(
                                c.part(
                                    None,
                                    &chat_text,
                                    c.text(chat)
                                        .rounded(c.u(10.0))
                                        .bg(c.theme.field)
                                        .px(c.u(12.0))
                                        .py(c.u(6.0))
                                        .text_color(c.theme.ink)
                                        .child("Use frontend-design to give Appearance a live preview, starting from Settings.tsx."),
                                ),
                            ),
                        )
                        .child(body("The preview sits above Typography and follows every setting as you change it.")),
                ),
            )
            .child(code_block(c))
            .child(body("Typecheck and the Electron check pass."))
            .child(div().flex_1())
            .child(composer(c)),
    )
}

impl RenderOnce for WindowPreview {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (add, remove) = diff_text_colors(&self.options, &theme);
        let c = Ctx { k: self.scale, highlight: self.highlight, theme, options: self.options, add, remove };
        let chat_available = WINDOW_WIDTH - 8.0 - 272.0 - 12.0 - 12.0;
        let title_bar = c.part(
            None,
            &[PreviewArea::Ui],
            div().absolute().top_0().left_0().right_0().h(c.u(44.0)).px(c.u(20.0)).flex().items_center().gap(c.u(8.0)).children(
                [
                    Rgba { r: 1.0, g: 0.37, b: 0.34, a: 1.0 },
                    Rgba { r: 1.0, g: 0.74, b: 0.18, a: 1.0 },
                    Rgba { r: 0.16, g: 0.78, b: 0.25, a: 1.0 },
                ]
                .map(|dot| div().size(c.u(12.0)).rounded_full().bg(dot)),
            ),
        );
        let window: AnyElement = c
            .part(
                Some(PreviewArea::Ui),
                &[],
                div().relative().size_full().bg(theme.page).text_color(theme.ink).child(title_bar).child(
                    div()
                        .size_full()
                        .pt(c.u(44.0))
                        .pb(c.u(8.0))
                        .pl(c.u(8.0))
                        .flex()
                        .gap(c.u(12.0))
                        .child(sidebar(&c))
                        .child(div().min_w_0().flex_1().h_full().mt(c.u(-44.0)).child(chat_column(&c, chat_available))),
                ),
            )
            .into_any_element();
        div()
            .debug_selector(|| "appearance-window-preview".into())
            .w(px(WINDOW_WIDTH * self.scale))
            .h(px(WINDOW_HEIGHT * self.scale))
            .flex_none()
            .overflow_hidden()
            .rounded(px(10.0))
            .border_1()
            .border_color(theme.line)
            .child(window)
    }
}

/// The scheme a preview of `theme` is drawn in, for tests.
pub fn scheme_of(theme: &Theme) -> Scheme {
    if theme.appearance == Appearance::Dark { Scheme::Dark } else { Scheme::Light }
}
