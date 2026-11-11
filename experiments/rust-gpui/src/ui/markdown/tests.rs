//! The markdown view under gpui-component's `Root`, as the app mounts it. The test platform's text system has fixed
//! advances, so these drag between element corners and check the text a selection or copy yields.

use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, MouseButton, ParentElement as _, Render, Styled as _, VisualTestContext,
    Window, div, point, px,
};
use gpui_base::{TextSelection, TextViewState};

use super::*;
use crate::testing;

struct Harness {
    state: Entity<TextViewState>,
    style: TextViewStyle,
    clicks: Arc<std::sync::Mutex<Vec<LinkTarget>>>,
}

impl Render for Harness {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        let on_link: LinkHandler = Arc::new(move |target, _, _, _| clicks.lock().expect("clicks").push(target.clone()));
        div().size_full().p_4().child(div().debug_selector(|| "message".into()).w(px(536.0)).child(Markdown::new(
            &self.state,
            self.style.clone(),
            extensions(on_link.clone()),
            on_link,
        )))
    }
}

fn mount<'a>(cx: &'a mut gpui::TestAppContext, text: &'static str) -> (Entity<Harness>, &'a mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, move |_, cx| Harness {
        state: cx.new(|cx| TextViewState::markdown(text, cx)),
        style: text_view_style(cx.theme(), crate::theme::CHAT_TEXT.size),
        clicks: Default::default(),
    });
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
}

fn drag_over(cx: &mut VisualTestContext, bounds: gpui::Bounds<gpui::Pixels>) {
    let (from, to) = (point(bounds.left() + px(1.0), bounds.top() + px(2.0)), point(bounds.right() - px(1.0), bounds.bottom() - px(2.0)));
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    draw(cx);
}

const SAMPLE: &str = "## Fix\n\nThe fix is in `apps/desktop/app/src/intro/Dawn.tsx:42`; `npm test` stays code.\n\n- one\n- two\n\n```rust\nfn main() {}\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quoted\n\n![the diagram](https://example.test/d.png) and <span>raw and https://milagre.cloud/docs.\n\n<div>block html</div>\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```md\n**nested**\n```";

#[gpui::test]
fn every_block_kind_renders_and_one_drag_selects_across_them(cx: &mut gpui::TestAppContext) {
    let (view, cx) = mount(cx, SAMPLE);
    assert!(cx.debug_bounds("file-chip:apps/desktop/app/src/intro/Dawn.tsx").is_some(), "a file chip");
    assert!(cx.debug_bounds("file-chip:npm test").is_none(), "a command stays code");
    assert!(cx.debug_bounds("mermaid-block").is_some(), "mermaid routes to its placeholder");
    assert!(cx.debug_bounds("nested-markdown").is_some(), "a markdown fence renders as markdown");
    assert!(cx.debug_bounds(IMAGE_LINK).is_some(), "an image is a link");
    let rendered = view.read_with(cx, |v, cx| v.state.read(cx).rendered_text().as_str().to_string());
    assert!(rendered.contains("<span>raw") && rendered.contains("<div>block html</div>"), "raw HTML shows as text: {rendered:?}");
    assert!(rendered.contains("the diagram"), "the image link shows its alt text");

    let message = testing::bounds(cx, "message");
    drag_over(cx, message);
    let text = cx.update(TextSelection::selected_text);
    for part in ["Fix", "apps/desktop/app/src/intro/Dawn.tsx:42", "npm test", "one", "two", "fn main() {}", "quoted", "<span>raw"] {
        assert!(text.contains(part), "selection lacks {part:?}:\n{text}");
    }
    // Fences stay out of a plain selection. A nested `markdown` fence copied whole gives its source (its node's text).
    assert!(!text.contains("```"), "fences stay out of a plain selection:\n{text}");
}

#[gpui::test]
fn links_chips_images_and_autolinks_reach_the_handler(cx: &mut gpui::TestAppContext) {
    let (view, cx) = mount(cx, "`src/theme/colors.rs:7` then ![shot](https://example.test/a.png)");
    let chip = testing::bounds(cx, "file-chip:src/theme/colors.rs");
    cx.simulate_click(chip.center(), Modifiers::none());
    let image = testing::bounds(cx, IMAGE_LINK);
    cx.simulate_click(image.center(), Modifiers::none());
    let clicks = view.read_with(cx, |v, _| v.clicks.lock().expect("clicks").clone());
    assert_eq!(
        clicks,
        vec![
            LinkTarget::Chip(files::FileLinkTarget { path: "src/theme/colors.rs".into(), line: Some(7), column: None }),
            LinkTarget::Web("https://example.test/a.png".into()),
        ]
    );
    assert_eq!(LinkTarget::of("https://milagre.cloud", None), LinkTarget::Web("https://milagre.cloud".into()));
    assert!(matches!(LinkTarget::of("/Users/me/repo/a.ts:3", None), LinkTarget::File(_)));
    assert_eq!(LinkTarget::of("mailto:a@b.co", None), LinkTarget::Other("mailto:a@b.co".into()));
}

#[gpui::test]
fn a_long_code_line_scrolls_instead_of_wrapping(cx: &mut gpui::TestAppContext) {
    let long = Box::leak(format!("```\n{}\n```", "x".repeat(400)).into_boxed_str());
    let (_, cx) = mount(cx, long);
    let one_line = testing::bounds(cx, "message").size.height;
    let mut app = gpui::TestAppContext::single();
    let (_, cx) = mount(&mut app, "```\nx\n```");
    let short = testing::bounds(cx, "message").size.height;
    assert_eq!(one_line, short, "400 characters stay on one line (the block scrolls sideways)");
}

#[test]
fn plain_text_source_renders_as_typed() {
    assert_eq!(plain_text_source("a *b*\n# c"), "a \\*b\\*\\\n\\# c");
    assert_eq!(plain_text_source("one\n\ntwo"), "one\n\ntwo");
    assert_eq!(plain_text_source("    indented"), "&#32;&#32;&#32;&#32;indented");
}
