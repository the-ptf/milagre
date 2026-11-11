//! Fit check (e), feature `webview`: a local HTML string in a `gpui-webview` (wry on WKWebView) child
//! view, laid out the way the side panel's body would host an Artifact page (D1).
//!
//! The page sets up three compositing questions for the snapshot:
//!
//! - **Over**: a GPUI badge drawn after the webview, at the same place (`webview-over`). Does GPUI
//!   paint above the native view?
//! - **Clip**: the webview's container is 220px tall with `overflow_hidden`, while the page asks for
//!   400px, and it sits 40px above the container's top. Does the native view respect GPUI's clip?
//! - **Below**: a GPUI row under the container, where an unclipped native view would spill.
//!
//! ```sh
//! MILAGRE_GPUI_FITCHECK=webview MILAGRE_GPUI_SNAPSHOT=/tmp/fit-webview.png cargo run --features webview
//! ```

use gpui::{AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, Styled as _, Window, div, px};
use gpui_webview::WebView;

use crate::theme::{ActiveTheme, HEADER_HEIGHT, RADIUS_CARD, SANS, TEXT_12, TEXT_13, TextStepExt as _};

pub const HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; font: 13px -apple-system, system-ui; }
  body { background: linear-gradient(#ffd166, #ef476f); min-height: 400px; }
  .row { height: 40px; display: flex; align-items: center; padding: 0 12px; border-bottom: 1px solid rgba(0,0,0,.15); }
</style></head><body>
  <div class="row"><b>Web content</b>&nbsp;— row 1 (sits 40px above the clip, so it should be hidden)</div>
  <div class="row">row 2: first visible row if GPUI's clip applies</div>
  <div class="row">row 3</div><div class="row">row 4</div><div class="row">row 5</div>
  <div class="row">row 6</div><div class="row">row 7: spills over the GPUI row below if unclipped</div>
  <div class="row">row 8</div><div class="row">row 9</div><div class="row">row 10</div>
</body></html>"#;

pub struct WebviewPage {
    webview: Option<Entity<WebView>>,
    error: Option<String>,
}

impl WebviewPage {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let builder = wry::WebViewBuilder::new().with_html(HTML);
        match WebView::build(builder, window, cx) {
            Ok(webview) => Self { webview: Some(cx.new(|_| webview)), error: None },
            Err(error) => Self { webview: None, error: Some(error.to_string()) },
        }
    }
}

impl Render for WebviewPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let body = match (&self.webview, &self.error) {
            (Some(webview), _) => div()
                .relative()
                .w(px(520.0))
                .h(px(220.0))
                .overflow_hidden()
                .border_1()
                .border_color(theme.accent)
                // The webview asks for 400px and starts 40px above the clip.
                .child(div().absolute().top(px(-40.0)).left_0().w(px(520.0)).h(px(400.0)).child(webview.clone()))
                // Drawn after the webview, over its middle: is it visible?
                .child(
                    div()
                        .absolute()
                        .top(px(80.0))
                        .left(px(160.0))
                        .px_3()
                        .py_2()
                        .rounded(RADIUS_CARD)
                        .bg(theme.ink)
                        .text_color(theme.on_ink)
                        .text_step(TEXT_13)
                        .child("GPUI badge over the webview"),
                ),
            (None, error) => div().text_color(theme.red_ink).child(format!("webview failed: {error:?}")),
        };
        div()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .font_family(SANS)
            .flex()
            .flex_col()
            .child(
                div()
                    .h(HEADER_HEIGHT)
                    .px_4()
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.line)
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .child("Panel header (GPUI): Artifact"),
            )
            .child(
                div()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().text_step(TEXT_12).text_color(theme.ink3).child("Panel body: a 520 x 220 clip (accent border)"))
                    .child(body),
            )
            .child(
                div()
                    .mx_4()
                    .h(px(120.0))
                    .w(px(520.0))
                    .rounded(RADIUS_CARD)
                    .bg(theme.surface)
                    .p_3()
                    .text_step(TEXT_13)
                    .child("GPUI row below the clip: web content here means the native view spilled"),
            )
    }
}
