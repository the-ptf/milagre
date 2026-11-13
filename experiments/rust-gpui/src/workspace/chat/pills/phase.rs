//! The phase graph (`PhaseGraph.tsx`): the Chat's phase history on a time axis that ends at Now. The legend is a
//! column of one 21px row per phase (the current one filled); the plot beside it is drawn with paths: the S-curve,
//! the dashed Now line and the dots in a `canvas`, the gap chips and the time labels as text over it. The geometry is
//! `logic::plan` (a port of `phase-graph.mjs`, tested against its vectors); this file only paints it.

use gpui::{
    AnyElement, Bounds, FontWeight, IntoElement, ParentElement, PathBuilder, Styled, canvas, div, fill, point, prelude::*, px, size,
};

use crate::logic::plan::{Anchor, ChatPlan, PHASES, PathStep, Phase, default_format, phase_graph, phase_graph_layout};
use crate::theme::{RADIUS_CHIP, RADIUS_INLINE, TEXT_10, TEXT_11, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, SectionLabel};

pub const HEIGHT: f32 = 168.0;
/// One legend row per phase: its centre is `row_y(row, HEIGHT)`, so every dot sits on its label.
pub const ROW: f32 = HEIGHT / 8.0;
/// The legend's width (the longest label, "Release", with its glyph).
pub const LEGEND_WIDTH: f32 = 76.0;

fn icon(phase: Phase) -> IconName {
    match phase {
        Phase::Start => IconName::Flag01,
        Phase::Plan => IconName::Target02,
        Phase::Build => IconName::Wrench01,
        Phase::Test => IconName::TestTube01,
        Phase::Review => IconName::Eye,
        Phase::Merge => IconName::GitMerge,
        Phase::Release => IconName::Rocket01,
        Phase::Done => IconName::CheckmarkCircle02,
    }
}

/// How tall the section is: its header, the legend and the time labels under the plot, and its padding.
pub const SECTION_HEIGHT: f32 = 16.0 + 8.0 + HEIGHT + 18.0 + 8.0;

/// The plot's width inside a panel of `panel_width`: less the panel's padding (4 each side), the section's (8), the
/// legend and the 8px between.
pub fn plot_width(panel_width: f32) -> f32 {
    (panel_width - 8.0 - 16.0 - LEGEND_WIDTH - 8.0).max(1.0)
}

/// The section, or `None` when the plan has no phase history. `now` is the moment the panel opened.
pub fn phase_graph_section(plan: &ChatPlan, now: i64, panel_width: f32, theme: &Theme, action: Option<AnyElement>) -> Option<AnyElement> {
    let graph = phase_graph(&plan.phases, now, &default_format);
    let current = graph.current?;
    let width = plot_width(panel_width);
    let layout = phase_graph_layout(&graph, f64::from(width), f64::from(HEIGHT));
    let theme = *theme;
    let legend = div().flex_none().w(px(LEGEND_WIDTH)).h(px(HEIGHT)).flex().flex_col().children(PHASES.iter().rev().map(|phase| {
        let is_current = *phase == current;
        div()
            .debug_selector({
                let phase = *phase;
                move || format!("phase-legend-{}", phase.label().to_lowercase())
            })
            .h(px(ROW))
            .flex()
            .items_center()
            .gap_1()
            .px_1()
            .rounded(RADIUS_INLINE)
            .text_step(TEXT_11)
            .text_color(if is_current { theme.ink } else { theme.ink3 })
            .when(is_current, |el| el.bg(theme.hover2))
            .child(Icon::new(icon(*phase)).size(IconSize::S12).color(if is_current { theme.ink } else { theme.ink3 }))
            .child(phase.label())
    }));
    let (steps, line_x) = (layout.steps.clone(), layout.now.line_x as f32);
    let dots: Vec<(f32, f32, bool)> = layout.points.iter().map(|p| (p.x as f32, p.y as f32, p.current)).collect();
    let accent = theme.accent;
    let ink2 = theme.ink2;
    let paint = canvas(
        |_, _, _| (),
        move |bounds: Bounds<gpui::Pixels>, _, window, _| {
            let at = |x: f64, y: f64| point(bounds.origin.x + px(x as f32), bounds.origin.y + px(y as f32));
            let mut path = PathBuilder::stroke(px(2.0));
            let mut last = (0.0, 0.0);
            for step in &steps {
                match *step {
                    PathStep::Move(x, y) => {
                        path.move_to(at(x, y));
                        last = (x, y);
                    }
                    PathStep::Curve { c1, c2, to } => {
                        path.cubic_bezier_to(at(to.0, to.1), at(c1.0, c1.1), at(c2.0, c2.1));
                        last = to;
                    }
                    PathStep::HLine(x) => {
                        path.line_to(at(x, last.1));
                    }
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, accent);
            }
            // The Now line: 3 on, 3 off.
            let mut y = 0.0;
            while y < HEIGHT {
                let dash = Bounds::new(at(f64::from(line_x) - 0.5, f64::from(y)), size(px(1.0), px(3.0_f32.min(HEIGHT - y))));
                window.paint_quad(fill(dash, accent));
                y += 6.0;
            }
            for (x, y, current) in &dots {
                let r = if *current { 5.0 } else { 3.0 };
                let dot = Bounds::new(at(f64::from(x - r), f64::from(y - r)), size(px(r * 2.0), px(r * 2.0)));
                window.paint_quad(fill(dot, if *current { accent } else { ink2 }).corner_radii(px(r)));
            }
        },
    )
    .absolute()
    .size_full();
    let label = |text: String, x: f32, anchor: Anchor, top: f32| {
        let (left, w) = match anchor {
            Anchor::Start => (x, 44.0),
            Anchor::Middle => (x - 22.0, 44.0),
            Anchor::End => (x - 28.0, 28.0),
        };
        div()
            .absolute()
            .left(px(left))
            .top(px(top))
            .w(px(w))
            .flex()
            .when(anchor == Anchor::Start, |el| el.justify_start())
            .when(anchor == Anchor::Middle, |el| el.justify_center())
            .when(anchor == Anchor::End, |el| el.justify_end())
            .text_step(TEXT_10)
            .text_color(theme.ink3)
            .whitespace_nowrap()
            .child(text)
    };
    let plot = div()
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(HEIGHT + 18.0))
        .debug_selector(|| "phase-plot".into())
        .child(paint)
        .children(layout.gaps.iter().map(|gap| {
            div()
                .absolute()
                .left(px(gap.x as f32 - 12.0))
                .top(px(gap.y as f32 - 8.0))
                .w(px(24.0))
                .h(px(16.0))
                .rounded(RADIUS_CHIP.min(px(4.0)))
                .bg(theme.field)
                .flex()
                .items_center()
                .justify_center()
                .text_step(TEXT_10)
                .font_weight(FontWeight::NORMAL)
                .text_color(theme.ink2)
                .child(gap.label.clone())
        }))
        .children(layout.ticks.iter().map(|tick| label(tick.label.clone(), tick.x as f32, tick.anchor, HEIGHT + 3.0)))
        .child(label("Now".into(), layout.now.x as f32, Anchor::End, HEIGHT + 3.0));
    Some(
        div()
            .id("phase-graph")
            .debug_selector(|| "phase-graph".into())
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .px_2()
            .pb_2()
            .child(div().flex().items_center().child(div().flex_1().child(SectionLabel::new("Phase graph"))).children(action))
            .child(div().flex().gap_2().child(legend).child(plot))
            .into_any_element(),
    )
}
