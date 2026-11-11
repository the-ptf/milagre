//! One tool call as a row, and what opening it shows. After `agents/StepRow.tsx`, `StepOutput.tsx` and
//! `ActivitySource.tsx`.
//!
//! A row is 24 high (`h-6`): the kind's glyph on the reply text's edge, the title (code between backticks is a
//! chip), a note or summary, a failed mark, a chevron when it opens, and the duration last. While the step
//! runs the whole title shimmers (a pulse between `ink-3` and `ink`; the app sweeps a gradient through the text,
//! which GPUI cannot clip to glyphs) and there is no spinner. The hover fill is drawn behind the row and reaches
//! 13px past both column edges (DESIGN.md "Desktop"; `--row-bleed`).
//!
//! Opening shows the detail as plain blocks: the command and its output (the last 40 lines), the input of a
//! tool, a file's diff as a placeholder that names the package that draws it, thinking as text. Detail the host
//! keeps elsewhere (`has_detail`) names that it is not read yet: there is no `chat:message` read in this crate.
//!
//! The row is built from data and returns an element; the transcript passes the click handlers (they need its
//! `Context`).

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, ClickEvent, ElementId, FontWeight, Rgba, SharedString, Window, div, prelude::*, px,
    relative,
};

use super::summary::{self, Source};
use crate::data::{ChatStep, Millis, StepKind, StepStatus};
use crate::theme::{CODE_TEXT, CONTROL_XS, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, motion};

/// A click handler the transcript made for a row.
pub type Click = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// How far the hover fill reaches past the column edge.
pub const ROW_BLEED: f32 = 13.0;
/// Where a note, an error or a detail starts: past the glyph and its gap.
pub const DETAIL_INSET: f32 = 22.0;
/// A console block shows this many lines until asked for all of them (`StepOutput`).
pub const CLIP_LINES: usize = 40;
/// A loop of the title shimmer (`step-shimmer 1.2s`).
const SHIMMER: Duration = Duration::from_millis(1200);

/// The glyph of a kind (`ActivitySource.tsx` `ICONS`); an unknown kind is the wrench.
pub fn kind_icon(kind: Option<StepKind>) -> IconName {
    match kind {
        Some(StepKind::Shell | StepKind::Setup) => IconName::CommandLine,
        Some(StepKind::Read) => IconName::File01,
        Some(StepKind::Edit) => IconName::PencilEdit02,
        Some(StepKind::Search) => IconName::Search01,
        Some(StepKind::Thinking) => IconName::AiBrain01,
        Some(StepKind::Image) => IconName::Image01,
        Some(StepKind::Artifact) => IconName::PaintBoard,
        Some(StepKind::Other) | None => IconName::Wrench01,
    }
}

/// The glyph of a source: Linear has a brand mark in the app, drawn here as the wrench until the logo is ported.
pub fn source_icon(source: &Source) -> IconName {
    kind_icon(source.kind)
}

/// Whether a step opens: it has input or detail (inline, or kept on the host).
pub fn is_expandable(step: &ChatStep) -> bool {
    step.input.is_some() || step.detail.is_some() || step.has_detail
}

/// Everything a row draws, borrowed from the item that owns it.
pub struct StepRow<'a> {
    pub step: &'a ChatStep,
    /// Unique among the rows of the transcript, for element ids and test selectors.
    pub key: (usize, usize),
    pub open: bool,
    pub all_lines: bool,
    pub waiting: bool,
    pub now: Millis,
    pub on_toggle: Option<Click>,
    pub on_all: Option<Click>,
}

fn mix(from: Rgba, to: Rgba, t: f32) -> Rgba {
    Rgba {
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
        a: from.a + (to.a - from.a) * t,
    }
}

/// A title piece in `color`, shimmering when `running`: the pulse runs `ink-3` to `ink` and back; with motion off
/// (tests, reduced motion) it keeps the static `ink-3` tint.
fn tinted(piece: gpui::Div, id: impl Into<ElementId>, color: Rgba, running: bool, theme: &Theme) -> AnyElement {
    if !running {
        return piece.text_color(color).into_any_element();
    }
    let (from, to) = (theme.ink3, theme.ink);
    let piece = piece.text_color(from);
    if !motion() {
        return piece.into_any_element();
    }
    piece
        .with_animation(id, Animation::new(SHIMMER).repeat(), move |piece, t| {
            let wave = if t < 0.5 { t * 2.0 } else { (1.0 - t) * 2.0 };
            piece.text_color(mix(from, to, wave))
        })
        .into_any_element()
}

/// The title as spans: text, and code as a chip (`CODE_CHIP`).
pub fn title(text: &str, key: (usize, usize), color: Rgba, running: bool, theme: &Theme) -> AnyElement {
    let spans = summary::title_spans(text).into_iter().enumerate().map(|(n, (text, code))| {
        let id = ElementId::from((SharedString::from(format!("shimmer-{}-{}-{n}", key.0, key.1)), 0usize));
        let piece = div().flex_none().whitespace_nowrap().child(text);
        if code {
            let chip = piece.px(px(4.0)).rounded(RADIUS_INLINE).bg(theme.field).font_family(mono()).text_step(CODE_TEXT);
            tinted(chip, id, theme.ink, running, theme)
        } else {
            tinted(piece, id, color, running, theme)
        }
    });
    div().flex().flex_1().min_w_0().overflow_hidden().items_center().children(spans).into_any_element()
}

/// The row alone: glyph, title, note, failed mark, chevron, duration.
pub fn row(view: &StepRow, theme: &Theme) -> AnyElement {
    let step = view.step;
    let running = step.status == StepStatus::Running;
    let shimmering = running && !view.waiting;
    let shown_title = summary::step_display_title(step, shimmering);
    let expandable = is_expandable(step);
    let duration = summary::step_duration(step, view.now);
    let note = (!running).then(|| step.summary.clone().or_else(|| step.note.clone())).flatten();
    let failed = step.status == StepStatus::Failed;
    let (a, b) = view.key;
    let group: SharedString = "step-row".into();
    let mut row = div()
        .id(ElementId::from((SharedString::from(format!("step-{a}-{b}")), 0usize)))
        .debug_selector(move || format!("step-row-{a}-{b}"))
        .group(group.clone())
        .relative()
        .flex()
        .items_center()
        .gap_2()
        .h(CONTROL_XS)
        .w_full()
        .min_w_0()
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_12)
        .text_color(theme.ink2);
    if expandable {
        row = row
            .cursor_pointer()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(-ROW_BLEED))
                    .right(px(-ROW_BLEED))
                    .rounded(RADIUS_CONTROL)
                    .group_hover(group, |style| style.bg(theme.hover)),
            )
            .when_some(view.on_toggle.clone(), |row, on_toggle| row.on_click(move |event, window, cx| on_toggle(event, window, cx)));
    }
    row.child(div().flex().flex_none().items_center().child(Icon::new(kind_icon(step.kind)).size(IconSize::S14).color(theme.ink2)))
        .child(title(&shown_title, view.key, theme.ink2, shimmering, theme))
        .when_some(note, |row, note| {
            let color = if failed { theme.red_ink } else { theme.ink3 };
            row.child(div().flex_none().max_w(relative(0.4)).truncate().text_step(TEXT_11).text_color(color).child(note))
        })
        .when(view.waiting, |row| {
            row.child(
                div()
                    .flex_none()
                    .text_step(TEXT_11)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.orange_ink)
                    .child("Waiting for approval"),
            )
        })
        .when(failed && !view.waiting, |row| {
            row.child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1()
                    .text_step(TEXT_11)
                    .text_color(theme.red_ink)
                    .child(Icon::new(IconName::Alert02).size(IconSize::S12).color(theme.red_ink))
                    .when(step.summary.is_none(), |el| el.child("Failed")),
            )
        })
        .child(chevron_slot(expandable, view.open, !duration.is_empty(), theme))
        .when(!duration.is_empty(), |row| {
            row.child(div().flex_none().min_w(px(40.0)).flex().justify_end().text_step(TEXT_11).text_color(theme.ink3).child(duration))
        })
        .into_any_element()
}

/// The chevron of a row that opens (up while open); a row without detail keeps an empty slot of the same width
/// when it has a duration, so every row's note and time share their columns.
pub fn chevron_slot(expandable: bool, open: bool, has_duration: bool, theme: &Theme) -> AnyElement {
    if expandable {
        let icon = if open { IconName::ArrowUp01 } else { IconName::ArrowDown01 };
        div().flex().flex_none().child(Icon::new(icon).size(IconSize::S12).color(theme.ink3)).into_any_element()
    } else if has_duration {
        div().flex_none().w(px(12.0)).into_any_element()
    } else {
        div().into_any_element()
    }
}

/// The row and, when open, its error and detail.
pub fn step(view: &StepRow, theme: &Theme) -> AnyElement {
    let step = view.step;
    let (a, b) = view.key;
    div()
        .debug_selector(move || format!("step-{a}-{b}"))
        .flex()
        .flex_col()
        .min_w_0()
        .child(row(view, theme))
        .when_some(step.error.clone(), |el, error| {
            el.child(
                div()
                    .mb_1()
                    .ml(px(DETAIL_INSET))
                    .pl_2()
                    .border_l_2()
                    .border_color(theme.red)
                    .font_family(mono())
                    .text_size(px(11.0))
                    .line_height(px(17.0))
                    .text_color(theme.ink2)
                    .child(error),
            )
        })
        .when(view.open, |el| el.child(detail(view, theme)))
        .into_any_element()
}

/// What opening shows.
fn detail(view: &StepRow, theme: &Theme) -> AnyElement {
    let step = view.step;
    let mut blocks = div().debug_selector({
        let (a, b) = view.key;
        move || format!("step-detail-{a}-{b}")
    });
    blocks = blocks.flex().flex_col().min_w_0().gap_1().py_1();
    if step.kind == Some(StepKind::Thinking) {
        let text = step.detail.clone().unwrap_or_default();
        return blocks
            .child(div().text_step(TEXT_12).line_height(px(12.0 * 1.55)).text_color(theme.ink2).child(text.trim().to_string()))
            .into_any_element();
    }
    if step.detail.is_none() && step.has_detail {
        return blocks
            .child(
                div()
                    .pl(px(DETAIL_INSET))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child("Output is kept on the host and is not read here yet."),
            )
            .into_any_element();
    }
    let sections = summary::step_sections(step, None);
    let console = matches!(step.kind, Some(StepKind::Shell | StepKind::Setup));
    // An input that is only the file's path repeats the row's own title.
    let input_is_file = step.file.as_deref() == Some(sections.input.as_str());
    if !sections.input.is_empty() && !input_is_file {
        blocks = blocks.child(code_block(sections.input_label, &sections.input, theme));
    }
    if step.kind == Some(StepKind::Edit) && is_unified_diff(&sections.output) {
        return blocks.child(diff_placeholder(step, &sections.output, theme)).into_any_element();
    }
    if !sections.output.is_empty() {
        let lines: Vec<&str> = sections.output.trim_end_matches('\n').split('\n').collect();
        let clipped = !view.all_lines && lines.len() > CLIP_LINES;
        let (shown, label) = if clipped {
            let kept: Vec<&str> = if console { lines[lines.len() - CLIP_LINES..].to_vec() } else { lines[..CLIP_LINES].to_vec() };
            (
                kept.join("\n"),
                format!("{} · {} {CLIP_LINES} of {} lines", sections.output_label, if console { "last" } else { "first" }, lines.len()),
            )
        } else {
            (sections.output.clone(), sections.output_label.to_string())
        };
        blocks = blocks.child(code_block(&label, &shown, theme));
        if clipped && let Some(on_all) = view.on_all.clone() {
            let (a, b) = view.key;
            let more = lines.len() - CLIP_LINES;
            blocks = blocks.child(
                div().child(
                    Button::new(
                        ElementId::from((SharedString::from(format!("step-more-{a}-{b}")), 0usize)),
                        format!("Show {more} {} lines", if console { "earlier" } else { "more" }),
                    )
                    .variant(ButtonVariant::Quiet)
                    .size(ButtonSize::S24)
                    .selector("step-show-all")
                    .on_click(move |event, window, cx| on_all(event, window, cx)),
                ),
            );
        }
    }
    blocks.into_any_element()
}

/// A labelled block of monospaced text on the column's edges: `inset` fill, hairline, `rounded-control`.
fn code_block(label: &str, text: &str, theme: &Theme) -> AnyElement {
    div()
        .rounded(RADIUS_CONTROL)
        .bg(theme.inset)
        .border_1()
        .border_color(theme.line)
        .child(div().px(px(12.0)).pt(px(6.0)).text_step(TEXT_11).text_color(theme.ink3).child(label.to_string()))
        .child(
            div()
                .px(px(12.0))
                .pb(px(8.0))
                .pt(px(2.0))
                .font_family(mono())
                .text_step(CODE_TEXT)
                .text_color(theme.ink)
                .child(text.trim_end_matches('\n').to_string()),
        )
        .into_any_element()
}

fn is_unified_diff(text: &str) -> bool {
    text.lines().any(|line| line.starts_with("@@"))
        || (text.lines().any(|l| l.starts_with("--- ")) && text.lines().any(|l| l.starts_with("+++ ")))
}

/// An edit's unified diff: the full view (hunks, word highlights, copy) is the Changes package's; here the file,
/// the line counts and the first lines on the diff colours.
fn diff_placeholder(step: &ChatStep, diff: &str, theme: &Theme) -> AnyElement {
    let added = diff.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
    let removed = diff.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
    let path = step.file.clone().unwrap_or_default();
    let lines = diff.trim_end_matches('\n').split('\n').take(CLIP_LINES).map(|line| {
        let fill = match line.chars().next() {
            Some('+') if !line.starts_with("+++") => Some(theme.diff_add),
            Some('-') if !line.starts_with("---") => Some(theme.diff_remove),
            _ => None,
        };
        div().px(px(12.0)).when_some(fill, |el, fill| el.bg(fill)).child(line.to_string())
    });
    div()
        .debug_selector(|| "step-diff-placeholder".into())
        .rounded(RADIUS_CONTROL)
        .overflow_hidden()
        .bg(theme.inset)
        .border_1()
        .border_color(theme.line)
        .child(
            div()
                .flex()
                .gap_2()
                .px(px(12.0))
                .pt(px(6.0))
                .pb(px(4.0))
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(div().flex_1().truncate().child(path))
                .child(div().text_color(theme.green).child(format!("+{added}")))
                .child(div().text_color(theme.red_ink).child(format!("-{removed}")))
                .child("Diff view comes with the Changes package"),
        )
        .child(div().pb(px(6.0)).font_family(mono()).text_step(CODE_TEXT).text_color(theme.ink).children(lines))
        .into_any_element()
}
