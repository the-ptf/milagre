//! Fit check (f): gpui-component's `diff` module against Milagre's diff view and line comments
//! (`apps/desktop/app/src/components/changes`: `DiffView.tsx`, `diff-lines.tsx`, `DiffComments.tsx`),
//! and its highlighter against the Shiki colour buckets of `markdown/highlighter.ts`.

use gpui::{
    AppContext as _, Context, Entity, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Render, Styled as _, Window, div, px,
};
use gpui_component::ActiveTheme as _;
use gpui_component::diff::{Diff, DiffAnnotation, DiffFile, DiffLinePosition, DiffLineRange, DiffMode, DiffSide, DiffState};

use super::fixture::PATCH;
use super::harness::{draw, mount};
use crate::testing::bounds;

const PATH: &str = "intro/Dawn.tsx";

/// The patch in a `Diff`, with one line comment on the added timer line (new line 13).
pub struct DiffProbe {
    pub state: Entity<DiffState>,
}

impl DiffProbe {
    pub fn new(mode: DiffMode, cx: &mut Context<Self>) -> Self {
        let files = DiffFile::parse(PATCH).expect("patch parses");
        Self { state: cx.new(|cx| DiffState::new(files, cx).with_mode(mode)) }
    }
}

impl Render for DiffProbe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = crate::theme::ActiveTheme::theme(&**cx).page;
        div().size_full().bg(page).child(
            div().debug_selector(|| "diff".into()).w(px(720.0)).h(px(400.0)).child(
                Diff::new(&self.state)
                    .annotations([DiffAnnotation::line("comment-1", DiffLinePosition::new(PATH, DiffSide::Modified, 13))])
                    .render_annotation(|annotation, _, _| {
                        let id = annotation.id().clone();
                        div().debug_selector(move || format!("annotation:{id}")).p_2().child("Use the 1.2 s from the design notes")
                    }),
            ),
        )
    }
}

#[test]
fn the_patch_parses_into_one_file() {
    let files = DiffFile::parse(PATCH).expect("parses");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path().as_ref(), PATH);
    assert_eq!((files[0].additions(), files[0].deletions()), (3, 1));
}

#[gpui::test]
fn unified_and_split_both_draw_a_line_comment(cx: &mut gpui::TestAppContext) {
    for mode in [DiffMode::Unified, DiffMode::Split] {
        let mut app = gpui::TestAppContext::single();
        let (_, vcx) = mount(&mut app, move |_, cx| DiffProbe::new(mode, cx));
        vcx.run_until_parked();
        draw(vcx);
        let diff = bounds(vcx, "diff");
        let comment = bounds(vcx, "annotation:comment-1");
        assert!(comment.top() > diff.top() && comment.top() < diff.bottom(), "{mode:?}: the comment card is in the diff's rows");
        match mode {
            DiffMode::Unified => assert!(diff.contains(&comment.center()), "unified: the card spans the one column"),
            // Split: the card sits under the modified (right) column. Its columns keep their content
            // width, so at 720px the right one runs past the frame and scrolls sideways.
            _ => assert!(comment.left() > diff.center().x, "split: the card is on the modified side"),
        }
    }
    let _ = cx;
}

/// A line range for a comment (P-07 drags lines from the gutter): set and read back as text.
#[gpui::test]
fn a_selected_line_range_copies_its_source(cx: &mut gpui::TestAppContext) {
    let (probe, cx) = mount(cx, |_, cx| DiffProbe::new(DiffMode::Unified, cx));
    let state = probe.read_with(cx, |p, _| p.state.clone());
    state.update(cx, |s, cx| s.set_selected_lines(Some(DiffLineRange::new(PATH, DiffSide::Modified, 13, 15)), cx));
    cx.run_until_parked();
    draw(cx);
    let text = cx.update(|_, cx| state.read(cx).selected_text(cx));
    assert!(text.contains("window.setTimeout(onReady, 1200)"), "{text}");
    assert!(text.contains("window.clearTimeout(fallback)"), "{text}");
    assert!(!text.contains("addEventListener(\"transitionend\", onReady);"), "the removed line is on the other side: {text}");
}

/// The diff paints added and removed rows from the theme's `success` and `danger` at 12%, and changed
/// words at 30%: DESIGN.md's dark `diff-add`/`diff-add-word` are exactly `green` at those alphas, so the
/// bridge maps `success` to `green` and `danger` to `red` (the danger button keeps `red-ink` through
/// `button_danger`). Light's diff tokens are opaque mixes; green at 12% over the page lands 3 units off.
#[gpui::test]
fn diff_colours_come_from_success_and_danger(cx: &mut gpui::TestAppContext) {
    let (_, cx) = mount(cx, |_, cx| DiffProbe::new(DiffMode::Unified, cx));
    let (success, danger) = cx.update(|_, cx| (cx.theme().success, cx.theme().danger));
    let dark = crate::theme::Theme::dark();
    let alpha = |c: Hsla, a: f32| gpui::Rgba::from(c.opacity(a));
    let close = |a: gpui::Rgba, b: gpui::Rgba| {
        (a.r - b.r).abs() < 0.004 && (a.g - b.g).abs() < 0.004 && (a.b - b.b).abs() < 0.004 && (a.a - b.a).abs() < 0.004
    };
    assert!(close(alpha(success, 0.12), dark.diff_add), "row: {:?} vs {:?}", alpha(success, 0.12), dark.diff_add);
    assert!(close(alpha(success, 0.3), dark.diff_add_word));
    assert!(close(alpha(danger, 0.12), dark.diff_remove));
    assert!(close(alpha(danger, 0.3), dark.diff_remove_word));
}

/// With `--features syntect`, gpui-component installs a syntect highlighter for every text view's
/// fenced code (and offers the same backend to `Diff` through `with_syntax_highlighter`).
#[cfg(feature = "syntect")]
#[gpui::test]
fn syntect_feature_installs_a_code_block_highlighter(cx: &mut gpui::TestAppContext) {
    super::harness::init(cx, crate::theme::Theme::dark());
    cx.update(|cx| assert!(gpui_base::TextViewDefaults::global(cx).has_code_block_highlighter()));
}

#[cfg(not(feature = "syntect"))]
#[gpui::test]
fn without_a_backend_code_is_not_highlighted(cx: &mut gpui::TestAppContext) {
    super::harness::init(cx, crate::theme::Theme::dark());
    cx.update(|cx| assert!(!gpui_base::TextViewDefaults::global(cx).has_code_block_highlighter()));
}
