//! Fit check (d): gpui-component's `v_virtual_list` (gpui-base `VirtualList`, also under its
//! `list::List` picker) against GPUI's `list` (the transcript) and `uniform_list` (the sidebar).

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    Context, InteractiveElement as _, IntoElement, ListAlignment, ListState, ParentElement as _, Pixels, Render, Size, Styled as _, Window,
    div, list, px, size,
};
use gpui_component::v_virtual_list;

use super::harness::mount;
use crate::testing::{bounds, leak};
use crate::theme::ActiveTheme;

const ROWS: usize = 10_000;

/// 10,000 rows of two known heights in a 300px viewport, counting what the list builds.
struct VirtualProbe {
    sizes: Rc<Vec<Size<Pixels>>>,
    built: Rc<Cell<usize>>,
    /// Each row's content is this tall, whatever its declared size says.
    content: Pixels,
}

impl Render for VirtualProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let built = self.built.clone();
        let content = self.content;
        div().size_full().bg(theme.page).child(
            div().w(px(320.0)).h(px(300.0)).child(
                v_virtual_list(cx.entity(), "rows", self.sizes.clone(), move |_, range, _, _| {
                    built.set(built.get() + range.len());
                    range
                        .map(|ix| div().debug_selector(move || leak(format!("vrow-{ix}")).into()).w_full().child(div().h(content).w_full()))
                        .collect::<Vec<_>>()
                })
                .size_full(),
            ),
        )
    }
}

fn sizes() -> Rc<Vec<Size<Pixels>>> {
    Rc::new((0..ROWS).map(|ix| size(px(320.0), if ix % 2 == 0 { px(32.0) } else { px(48.0) })).collect())
}

#[gpui::test]
fn virtual_list_builds_only_the_rows_in_view(cx: &mut gpui::TestAppContext) {
    let built: Rc<Cell<usize>> = Rc::default();
    let counter = built.clone();
    let (_, cx) = mount(cx, move |_, _| VirtualProbe { sizes: sizes(), built: counter, content: px(32.0) });
    let per_frame = built.get();
    assert!(per_frame > 0 && per_frame < 40, "a 300px view of 10,000 rows builds a handful ({per_frame})");
    // Rows are placed by their declared sizes (32, 48, 32, ...), whatever their content measures.
    let (first, second, third) = (bounds(cx, "vrow-0"), bounds(cx, "vrow-1"), bounds(cx, "vrow-2"));
    assert_eq!(second.top() - first.top(), px(32.0));
    assert_eq!(third.top() - second.top(), px(48.0), "the 48px slot holds a 32px row: a gap");
}

/// The transcript's items have heights only layout knows (wrapped markdown). `VirtualList` places rows
/// at the sizes it was given, so a row whose content is taller runs under the next one.
#[gpui::test]
fn virtual_list_rows_take_declared_not_measured_heights(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| VirtualProbe { sizes: sizes(), built: Rc::default(), content: px(100.0) });
    let first = bounds(cx, "vrow-0");
    let second = bounds(cx, "vrow-1");
    assert_eq!(first.size.height, px(100.0), "the row lays out its content");
    assert_eq!(second.top(), first.top() + px(32.0), "but the next row starts at the declared 32px, 68px inside it");
}

/// GPUI's `list` measures each item from its content, keeps a logical scroll position and can open at
/// the bottom: what the transcript uses (`workspace/chat/transcript.rs`).
struct MeasuredProbe {
    state: ListState,
}

impl Render for MeasuredProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(cx.theme().page).child(
            div().w(px(320.0)).h(px(300.0)).child(
                list(self.state.clone(), |ix, _, _| {
                    let height = px(20.0 + (ix % 5) as f32 * 30.0);
                    div().debug_selector(move || leak(format!("lrow-{ix}")).into()).w_full().child(div().h(height)).into_any_element()
                })
                .size_full(),
            ),
        )
    }
}

#[gpui::test]
fn gpui_list_measures_content_and_opens_at_the_bottom(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, _| MeasuredProbe { state: ListState::new(ROWS, ListAlignment::Bottom, px(200.0)) });
    let last = bounds(cx, leak(format!("lrow-{}", ROWS - 1)));
    assert_eq!(last.size.height, px(20.0 + ((ROWS - 1) % 5) as f32 * 30.0), "measured from content");
    let view = bounds(cx, leak(format!("lrow-{}", ROWS - 2)));
    assert!(view.bottom() <= last.top() + px(0.5), "items stack by their measured heights");
}
