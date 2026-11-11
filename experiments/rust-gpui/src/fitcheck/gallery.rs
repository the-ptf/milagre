//! Snapshot pages for the fit check (feature `fitcheck`): gpui-component widgets through the theme
//! bridge, next to the spike's own primitives and renderer where there is one.
//!
//! ```sh
//! MILAGRE_GPUI_FITCHECK=markdown MILAGRE_GPUI_SNAPSHOT=/tmp/fit-markdown.png cargo run --features fitcheck
//! MILAGRE_GPUI_THEME=light MILAGRE_GPUI_FITCHECK=controls MILAGRE_GPUI_SNAPSHOT=/tmp/fit-controls-light.png cargo run --features fitcheck
//! ```
//!
//! Pages: `markdown` (TextView with Milagre's extensions beside the spike's renderer), `controls`
//! (gpui-component controls beside `ui::`), `diff` (unified and split), `webview` (feature `webview`).

use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    AnyView, App, AppContext as _, Bounds, Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, Styled as _,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, px, size,
};
use gpui_component::Root;
use gpui_component::Sizable as _;
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::checkbox::Checkbox;
use gpui_component::diff::{Diff, DiffAnnotation, DiffFile, DiffLinePosition, DiffMode, DiffSide, DiffState};
use gpui_component::input::{InlineToken, Input, InputState, Textarea, TextareaState};
use gpui_component::popover::Popover;
use gpui_component::radio::Radio;
use gpui_component::tab::{Tab, TabBar};

use super::fixture::{DRAFT_ANSWER, MESSAGES, PATCH, ROUTING};
use super::probes::MessagesView;
use crate::theme::{ActiveTheme, CHAT_TEXT, CONTROL_LG, CONTROL_SM, SANS, TEXT_12, TEXT_13, TextStepExt as _};
use crate::ui;

pub const WIDTH: f32 = 1280.0;
pub const HEIGHT: f32 = 860.0;

/// Opens the page `MILAGRE_GPUI_FITCHECK` names instead of the main window, and with `snapshot`
/// saves it and quits. Returns false when the variable is not set.
pub fn run(snapshot: Option<PathBuf>, cx: &mut App) -> bool {
    let Ok(page) = std::env::var("MILAGRE_GPUI_FITCHECK") else { return false };
    let window = open(page, cx);
    if let Some(path) = snapshot {
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let result = window.update(cx, |_, window, _| crate::snapshot::save_window_png(window, &path));
            match result {
                Ok(Ok((w, h))) => eprintln!("fitcheck snapshot: wrote {} ({w}x{h} px)", path.display()),
                Ok(Err(error)) => eprintln!("fitcheck snapshot failed: {error}"),
                Err(error) => eprintln!("fitcheck snapshot failed: window gone: {error}"),
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    } else {
        cx.activate(true);
    }
    true
}

fn open(page: String, cx: &mut App) -> WindowHandle<Root> {
    let bounds = Bounds::centered(None, size(px(WIDTH), px(HEIGHT)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some(format!("Fit check: {page}").into()), ..Default::default() }),
            ..Default::default()
        },
        move |window, cx| {
            let view: AnyView = match page.as_str() {
                "markdown" => cx.new(MarkdownPage::new).into(),
                "diff" => cx.new(DiffPage::new).into(),
                #[cfg(feature = "webview")]
                "webview" => cx.new(|cx| super::webview::WebviewPage::new(window, cx)).into(),
                _ => cx.new(|cx| ControlsPage::new(window, cx)).into(),
            };
            cx.new(|cx| Root::new(view, window, cx))
        },
    )
    .expect("open the fit-check window")
}

fn heading(text: &'static str, cx: &App) -> impl IntoElement + use<> {
    let theme = cx.theme();
    div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(text)
}

/// gpui-component's `TextView` with Milagre's extensions (left) beside the spike's own renderer (right).
pub struct MarkdownPage {
    messages: Entity<MessagesView>,
}

impl MarkdownPage {
    fn new(cx: &mut Context<Self>) -> Self {
        static TWO: [&str; 2] = [ROUTING, DRAFT_ANSWER];
        let _ = MESSAGES;
        Self { messages: cx.new(|cx| MessagesView::new(&TWO, cx)) }
    }
}

impl Render for MarkdownPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let spike = crate::workspace::chat::markdown::parse(&format!("{ROUTING}\n\n{DRAFT_ANSWER}"));
        div()
            .size_full()
            .flex()
            .gap_4()
            .p_4()
            .bg(theme.page)
            .font_family(SANS)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .w(px(672.0))
                    .child(heading("gpui-component TextView, Milagre extensions", cx))
                    .child(self.messages.clone()),
            )
            .child(
                div().flex().flex_col().gap_2().w(px(560.0)).child(heading("Spike renderer (workspace/chat/markdown.rs)", cx)).child(
                    div()
                        .p_4()
                        .text_color(theme.ink)
                        .text_size(px(CHAT_TEXT.size))
                        .line_height(px(CHAT_TEXT.line_height))
                        .child(crate::workspace::chat::markdown::render(&spike, 9_000, &theme)),
                ),
            )
    }
}

/// gpui-component controls (left column) beside the spike's `ui::` primitives (right column).
pub struct ControlsPage {
    area: Entity<TextareaState>,
    field: Entity<InputState>,
    field_36: Entity<InputState>,
}

impl ControlsPage {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let area = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx).auto_grow(1, 8).placeholder("Ask anything…");
            state.set_value("Look at ", window, cx);
            let end = state.value().len();
            state.set_selected_range(end..end, cx);
            let _ = state.replace_with_token(InlineToken::new("file:src/app.rs", "@src/app.rs").with_label("app.rs"), window, cx);
            state
        });
        let field = cx.new(|cx| InputState::new(window, cx).placeholder("Search (default height)"));
        let field_36 = cx.new(|cx| InputState::new(window, cx).placeholder("Search (36px)"));
        Self { area, field, field_36 }
    }
}

fn row(label: &'static str, left: impl IntoElement, right: impl IntoElement, cx: &App) -> gpui::AnyElement {
    let theme = cx.theme();
    div()
        .flex()
        .items_center()
        .gap_4()
        .py_1()
        .border_b_1()
        .border_color(theme.line)
        .child(div().w(px(150.0)).text_step(TEXT_12).text_color(theme.ink3).child(label))
        .child(div().w(px(520.0)).flex().items_center().gap_2().child(left))
        .child(div().w(px(460.0)).flex().items_center().gap_2().child(right))
        .into_any_element()
}

impl Render for ControlsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .size_full()
            .flex()
            .flex_col()
            .p_4()
            .gap_1()
            .bg(theme.page)
            .text_color(theme.ink)
            .font_family(SANS)
            .text_step(TEXT_13)
            .child(row("", heading("gpui-component (bridged)", cx), heading("spike ui::", cx), cx))
            .child(row(
                "Buttons, default",
                div()
                    .flex()
                    .gap_2()
                    .child(Button::new("p").label("Allow once").primary())
                    .child(Button::new("s").label("Always allow"))
                    .child(Button::new("d").label("Delete").danger())
                    .child(Button::new("g").label("Cancel").ghost()),
                div()
                    .flex()
                    .gap_2()
                    .child(ui::Button::new("up", "Allow once"))
                    .child(ui::Button::new("us", "Always allow").variant(ui::ButtonVariant::Secondary))
                    .child(ui::Button::new("ud", "Delete").variant(ui::ButtonVariant::Danger))
                    .child(ui::Button::new("ug", "Cancel").variant(ui::ButtonVariant::Ghost)),
                cx,
            ))
            .child(row(
                "Buttons, small / 28",
                div()
                    .flex()
                    .gap_2()
                    .child(Button::new("p2").label("small").primary().small())
                    .child(Button::new("p3").label("h(28)").primary().h(CONTROL_SM))
                    .child(Button::new("p4").label("xsmall").primary().xsmall()),
                div()
                    .flex()
                    .gap_2()
                    .child(ui::Button::new("u28", "S28").size(ui::ButtonSize::S28))
                    .child(ui::Button::new("u24", "S24").size(ui::ButtonSize::S24)),
                cx,
            ))
            .child(row(
                "Tabs",
                div().flex().flex_col().gap_1().child(
                    TabBar::new("tabs").child(Tab::new().label("Changes")).child(Tab::new().label("Terminal")).child(Tab::new().label("Browser")).selected_index(0),
                ).child(
                    TabBar::new("tabs28").h(CONTROL_SM).child(Tab::new().label("Changes")).child(Tab::new().label("Terminal")).selected_index(1),
                ),
                div().flex().gap_1().child(ui::Tab::new("t1", "Changes").active(true)).child(ui::Tab::new("t2", "Terminal")),
                cx,
            ))
            .child(row(
                "Checkbox, radio",
                div()
                    .flex()
                    .gap_4()
                    .child(Checkbox::new("c1").label("Show stats").checked(true))
                    .child(Checkbox::new("c2").label("Off"))
                    .child(Radio::new("r1").label("One").checked(true))
                    .child(Radio::new("r2").label("Two")),
                div().flex().gap_4().child(ui::Checkbox::new("uc1", true).label("Show stats")).child(ui::Checkbox::new("uc2", false).label("Off")),
                cx,
            ))
            .child(row(
                "Input",
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .w(px(320.0))
                    .child(Input::new(&self.field))
                    .child(Input::new(&self.field_36).h(CONTROL_LG)),
                div().text_color(theme.ink3).child("(composer.rs is the spike's only field)"),
                cx,
            ))
            .child(row(
                "Textarea + token",
                div().w(px(480.0)).child(Textarea::new(&self.area)),
                div().text_color(theme.ink3).child("composer chips: contentEditable in React"),
                cx,
            ))
            .child(row(
                "Popover (open)",
                div().h(px(140.0)).flex().items_start().child(
                    Popover::new("menu").default_open(true).trigger(Button::new("open").label("Chat actions").small()).content(|_, _, cx| {
                        let theme = *cx.theme();
                        div()
                            .w(px(200.0))
                            .flex()
                            .flex_col()
                            .child(div().h(px(32.0)).px_2().flex().items_center().rounded(px(4.0)).bg(theme.hover2).child("Rename Chat"))
                            .child(div().h(px(32.0)).px_2().flex().items_center().child("Mark as unread"))
                            .child(div().h(px(32.0)).px_2().flex().items_center().text_color(theme.red_ink).child("Archive"))
                    }),
                ),
                div().text_color(theme.ink3).child("none yet in the spike"),
                cx,
            ))
            .child(div().pt_2().text_step(TEXT_12).text_color(theme.ink3).child(
                "Bridge: rem 16 so h_6/h_7/h_8/h_9 are 24/28/32/36; colours, radii (8, dialogs 14) and fonts from src/theme. Widget text is text_sm (14).",
            ))
    }
}

/// The patch in gpui-component's `Diff`, unified on top and split below, with one line comment.
pub struct DiffPage {
    unified: Entity<DiffState>,
    split: Entity<DiffState>,
}

impl DiffPage {
    fn new(cx: &mut Context<Self>) -> Self {
        let files = DiffFile::parse(PATCH).expect("patch parses");
        Self {
            unified: cx.new(|cx| DiffState::new(files.clone(), cx).with_mode(DiffMode::Unified)),
            split: cx.new(|cx| DiffState::new(files, cx).with_mode(DiffMode::Split)),
        }
    }
}

fn diff_view(state: &Entity<DiffState>) -> impl IntoElement + use<> {
    Diff::new(state)
        .annotations([DiffAnnotation::line("comment-1", DiffLinePosition::new("intro/Dawn.tsx", DiffSide::Modified, 13))])
        .render_annotation(|_, _, cx| {
            let theme = *cx.theme();
            div()
                .m_2()
                .p_3()
                .rounded(px(10.0))
                .border_1()
                .border_color(theme.line_strong)
                .bg(theme.surface)
                .child("Use the 1.2 s from the design notes.")
        })
}

impl Render for DiffPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_2()
            .p_4()
            .bg(theme.page)
            .child(heading("gpui-component Diff, unified", cx))
            .child(div().h(px(360.0)).w_full().child(diff_view(&self.unified)))
            .child(heading("Split", cx))
            .child(div().h(px(360.0)).w_full().child(diff_view(&self.split)))
    }
}
