//! `diagram.ts`'s labels and the block drawn in a markdown view.

use std::sync::Arc;

use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, ParentElement as _, Render, Styled as _, TestAppContext, VisualTestContext,
    Window, div, px,
};
use gpui_base::TextViewState;
use gpui_component::WindowExt as _;

use super::*;
use crate::testing;
use crate::theme::{ActiveTheme as _, Theme};
use crate::ui::markdown::{FenceHooks, Markdown, extensions_with, open_with_system, text_view_style};

#[test]
fn labels_follow_diagram_ts() {
    for (kind, label) in [
        ("flowchart", "Flowchart"),
        ("graph", "Flowchart"),
        ("sequence", "Sequence diagram"),
        ("stateDiagram-v2", "State diagram"),
        ("erDiagram", "Entity relationship diagram"),
        ("xychart-beta", "Chart"),
        ("block-beta", "Block diagram"),
        ("gitGraph", "Git graph"),
        ("quadrantChart", "Quadrant chart"),
        ("pie", "Pie chart"),
        ("mystery", "Diagram"),
    ] {
        assert_eq!(diagram_label(Some(kind)), label, "{kind}");
    }
    assert_eq!(diagram_label(None), "Diagram");
    assert_eq!(diagram_label(Some("")), "Diagram");
}

#[test]
fn the_type_is_the_first_word_after_comments_and_front_matter() {
    assert_eq!(detect_type("flowchart LR\n A-->B").as_deref(), Some("flowchart"));
    assert_eq!(detect_type("%% note\n\n  graph TD\n A-->B").as_deref(), Some("graph"));
    assert_eq!(detect_type("---\ntitle: x\n---\nsequenceDiagram\n A->>B: hi").as_deref(), Some("sequence"));
    assert_eq!(detect_type("stateDiagram-v2\n [*] --> A").as_deref(), Some("stateDiagram-v2"));
    assert_eq!(detect_type("   \n"), None);
}

#[test]
fn only_the_whole_info_string_mermaid_is_a_diagram_fence() {
    assert!(is_mermaid_fence(Some(" Mermaid ")));
    assert!(!is_mermaid_fence(Some("mermaid title=x")));
    assert!(!is_mermaid_fence(None));
}

#[gpui::test]
fn the_renderer_draws_the_kinds_replies_use_and_refuses_what_is_not_one(cx: &mut TestAppContext) {
    testing::init(cx);
    let theme = Theme::dark();
    for code in [
        "flowchart LR\n A[Start] --> B{Ok?}\n B -->|yes| C[Done]",
        "graph TD\n A --> B",
        "sequenceDiagram\n A->>B: hi",
        "classDiagram\n class A\n A <|-- B",
        "stateDiagram-v2\n [*] --> A",
        "erDiagram\n A ||--o{ B : has",
        "pie title t\n \"a\" : 1\n \"b\" : 2",
        "gantt\n title t\n dateFormat YYYY-MM-DD\n section s\n x :a1, 2024-01-01, 3d",
        "mindmap\n root((r))\n  a\n  b",
        "journey\n title t\n section s\n  step: 5: me",
    ] {
        let svg = render::svg(code, &theme).unwrap_or_else(|error| panic!("{code}: {error}"));
        assert!(svg.starts_with("<svg"), "{code}");
    }
    assert!(render::svg("hello world", &theme).is_err());
    assert!(render::svg("not-a-diagram\n A --> B", &theme).unwrap_err().contains("diagram type"));
    assert!(render::svg("flowchart LR\n A-->", &theme).is_err());
    // The renderer's colours are the chat's: the ground is the code background.
    let svg = render::svg("graph TD\n A --> B", &theme).expect("svg");
    assert!(svg.contains(&render::hex(theme.code_bg)), "ground colour in the SVG");
    assert!(render::svg("graph TD\n A --> B", &Theme::light()).expect("light").contains(&render::hex(Theme::light().code_bg)));
}

#[gpui::test]
fn a_drawing_is_rasterised_once_per_text_and_appearance(cx: &mut TestAppContext) {
    testing::init(cx);
    let theme = Theme::dark();
    let code = "flowchart LR\n A --> B";
    let (first, second, light) = cx.update(|cx| {
        (
            render::draw(code, &theme, cx).expect("a"),
            render::draw(code, &theme, cx).expect("b"),
            render::draw(code, &Theme::light(), cx).expect("c"),
        )
    });
    assert!(Arc::ptr_eq(&first, &second), "cached");
    assert!(!Arc::ptr_eq(&first, &light), "each appearance has its own");
    assert!(first.width > 24.0 && first.height > 24.0);
    let pixels = first.image.size(0);
    assert!((pixels.width.0 as f32 - first.width * 2.0).abs() <= 1.5, "twice the density: {pixels:?} for {}", first.width);
}

#[test]
fn a_pie_chart_with_a_percentage_width_gets_its_size_from_the_view_box() {
    let svg = render::svg("pie title t\n \"a\" : 1\n \"b\" : 2", &Theme::dark()).expect("svg");
    let sized = render::with_pixel_size_for_test(&svg);
    assert!(sized.is_some_and(|(width, height)| width > 100.0 && height > 100.0));
}

struct Harness {
    state: Entity<TextViewState>,
    streaming: bool,
}

impl Render for Harness {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let style = text_view_style(cx.theme(), crate::theme::CHAT_TEXT.size);
        let hooks = FenceHooks { streaming: self.streaming, send: None };
        div().size_full().p_4().child(div().w(px(536.0)).child(Markdown::new(
            &self.state,
            style,
            extensions_with(open_with_system(), hooks),
            open_with_system(),
        )))
    }
}

fn mount<'a>(cx: &'a mut TestAppContext, code: &'static str, streaming: bool) -> (Entity<Harness>, &'a mut VisualTestContext) {
    let text = testing::leak(format!("```mermaid\n{code}\n```"));
    let (view, cx) = testing::mount_in_root(cx, move |_, cx| Harness { state: cx.new(|cx| TextViewState::markdown(text, cx)), streaming });
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn a_diagram_shows_its_picture_and_switches_to_its_source_and_back(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, "flowchart LR\n A --> B", false);
    assert!(cx.debug_bounds("mermaid-block").is_some());
    let picture = testing::bounds(cx, "mermaid-diagram");
    assert!(picture.size.width > px(100.0) && picture.size.height > px(30.0), "{:?}", picture.size);
    assert!(cx.debug_bounds("mermaid-source").is_none());
    let source = testing::bounds(cx, "mermaid-Source");
    cx.simulate_click(source.center(), Modifiers::none());
    draw(cx);
    assert!(cx.debug_bounds("mermaid-source").is_some(), "the source view");
    assert!(cx.debug_bounds("mermaid-diagram").is_none());
    let diagram = testing::bounds(cx, "mermaid-Diagram");
    cx.simulate_click(diagram.center(), Modifiers::none());
    draw(cx);
    assert!(cx.debug_bounds("mermaid-diagram").is_some(), "back to the picture");
}

#[gpui::test]
fn a_diagram_that_does_not_draw_shows_why_over_its_source(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, "not-a-diagram\n A --> B", false);
    assert!(cx.debug_bounds("mermaid-error").is_some());
    assert!(cx.debug_bounds("mermaid-diagram").is_none());
}

#[gpui::test]
fn the_block_being_written_stays_code(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, "flowchart LR\n A --> B", true);
    assert!(cx.debug_bounds("mermaid-block").is_some());
    assert!(cx.debug_bounds("mermaid-diagram").is_none());
    assert!(cx.debug_bounds("mermaid-Source").is_none(), "no header controls");
}

#[gpui::test]
fn copy_puts_the_source_on_the_clipboard_and_expand_opens_the_picture(cx: &mut TestAppContext) {
    let (_, cx) = mount(cx, "flowchart LR\n A --> B", false);
    let copy = testing::bounds(cx, "mermaid-copy");
    cx.simulate_click(copy.center(), Modifiers::none());
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("flowchart LR\n A --> B"));
    let expand = testing::bounds(cx, "mermaid-expand");
    cx.simulate_click(expand.center(), Modifiers::none());
    draw(cx);
    assert!(cx.update(|window, cx| window.has_active_dialog(cx)), "the lightbox opened");
    assert!(cx.debug_bounds("mermaid-lightbox-picture").is_some());
}
