//! Drawing the rows (`DiffFile.tsx`, `diff-lines.tsx`): the file card's header, hunk headers, unified and split rows
//! with gutters, markers, syntax runs and word marks, the comment "+" and the selected range, and the messages a file
//! shows instead of rows.

use std::ops::Range;

use gpui::{
    AnyElement, ClickEvent, Context, FontWeight, HighlightStyle, MouseButton, MouseDownEvent, MouseMoveEvent, Pixels, SharedString,
    StyledText, Window, div, prelude::*, px,
};

use super::comments::{DiffSide, Target};
use super::rows::Row;
use super::view::DiffView;
use crate::logic::diff::layout::utf16_range_to_bytes;
use crate::logic::diff::{DiffLine, LineKind};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::markdown::highlight::{Bucket, SyntaxPalette};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};
use crate::workspace::panel::changes::files::{counts_inline, status_badge};

/// The scroller's side padding (`px-3`): the cards sit this far in.
pub const CARD_INSET: f32 = 12.0;
/// A file header (`h-9`).
pub const HEADER_H: f32 = 36.0;
/// A code row (`min-h-5`, `leading-5`).
pub const ROW_H: f32 = 20.0;
/// A hunk header (`h-6`).
pub const HUNK_H: f32 = 24.0;
/// A line-number gutter (`w-11`) and the marker column (`w-4`).
pub const GUTTER_W: f32 = 44.0;
pub const MARKER_W: f32 = 16.0;
/// The space between files (`gap-3`).
pub const FILE_GAP: f32 = 12.0;
/// The code size (`--code-size`, 12px by default).
pub const CODE_SIZE: f32 = 12.0;
/// The "+" on a hovered row (`size-4`, `top-0.5 left-1`).
const ADD_SIZE: f32 = 16.0;
/// The selected range's bar on the row's left edge (`w-[3px]`).
const SELECTED_BAR: f32 = 3.0;
/// The hover group of a row, for its "+".
const ROW_GROUP: &str = "diff-row";

fn tint(theme: &Theme, kind: LineKind) -> Option<gpui::Rgba> {
    match kind {
        LineKind::Add => Some(theme.diff_add),
        LineKind::Remove => Some(theme.diff_remove),
        LineKind::Context => None,
    }
}

fn marker(kind: LineKind) -> &'static str {
    match kind {
        LineKind::Add => "+",
        LineKind::Remove => "\u{2212}",
        LineKind::Context => "",
    }
}

fn marker_color(theme: &Theme, kind: LineKind) -> gpui::Rgba {
    match kind {
        LineKind::Add => theme.green_ink,
        LineKind::Remove => theme.red_ink,
        LineKind::Context => theme.ink,
    }
}

/// The colour runs of a line's text: syntax buckets, the changed words' wash behind them, and the code selection
/// over both. Byte ranges, ordered, not overlapping (what `StyledText` wants).
pub fn styled_runs(
    len: usize,
    syntax_runs: Option<&[(Range<usize>, Bucket)]>,
    words: &[Range<usize>],
    selected: Option<Range<usize>>,
    palette: &SyntaxPalette,
    word_bg: gpui::Hsla,
    selection_bg: gpui::Hsla,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let mut cuts = vec![0, len];
    if let Some(runs) = syntax_runs {
        cuts.extend(runs.iter().flat_map(|(r, _)| [r.start, r.end]));
    }
    cuts.extend(words.iter().flat_map(|r| [r.start, r.end]));
    if let Some(sel) = &selected {
        cuts.extend([sel.start, sel.end]);
    }
    cuts.retain(|c| *c <= len);
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = Vec::new();
    for pair in cuts.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a == b {
            continue;
        }
        let color = syntax_runs
            .and_then(|runs| runs.iter().find(|(r, _)| r.start <= a && a < r.end))
            .map(|(_, bucket)| bucket.color(palette).into());
        let in_sel = selected.as_ref().is_some_and(|s| s.start <= a && b <= s.end);
        let in_word = words.iter().any(|w| w.start <= a && b <= w.end);
        let background = if in_sel {
            Some(selection_bg)
        } else if in_word {
            Some(word_bg)
        } else {
            None
        };
        if color.is_none() && background.is_none() {
            continue;
        }
        out.push((a..b, HighlightStyle { color, background_color: background, ..Default::default() }));
    }
    out
}

impl DiffView {
    /// One list item.
    pub(super) fn render_row(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut stats = self.stats.get();
        stats.row_renders += 1;
        self.stats.set(stats);
        let theme = *cx.theme();
        let Some(row) = self.rows.get(ix).copied() else { return div().into_any_element() };
        let element = match row {
            Row::Orphans => self.orphans_row(&theme, window, cx),
            Row::Header { file } => div().px(px(CARD_INSET)).child(self.file_header(file, false, &theme, cx)).into_any_element(),
            Row::Message { file } => self.message_row(file, &theme, cx),
            Row::Hunk { file, hunk } => {
                let header = self.files[file].hunks().and_then(|h| h.get(hunk)).map(|h| h.header.clone()).unwrap_or_default();
                card(&theme)
                    .child(
                        div()
                            .h(px(HUNK_H))
                            .px(px(12.0))
                            .bg(theme.inset)
                            .font_family(mono())
                            .text_size(px(11.0))
                            .line_height(px(HUNK_H))
                            .text_color(theme.ink3)
                            .truncate()
                            .child(header),
                    )
                    .into_any_element()
            }
            Row::Line { file, hunk, line } => self.unified_row(ix, file, hunk, line, &theme, cx),
            Row::Split { file, hunk, left, right } => self.split_row(ix, file, hunk, left, right, &theme, cx),
            Row::Threads { file, hunk, line } => {
                let ids = self.files[file].threads.get(&(hunk, line)).cloned().unwrap_or_default();
                self.threads_row(&ids, &theme, window, cx)
            }
            Row::Slot { .. } => self.slot_row(row, &theme, window, cx),
            Row::Stale { file } => {
                let ids = self.files[file].stale.clone();
                card(&theme).child(self.comment_slot(&ids, None, &theme, window, cx)).into_any_element()
            }
            Row::Loose { file } => {
                let ids = self.files[file].loose.clone();
                self.threads_row(&ids, &theme, window, cx)
            }
            Row::End { file } => {
                let collapsed = self.files[file].collapsed;
                div()
                    .px(px(CARD_INSET))
                    .pb(px(FILE_GAP))
                    .when(!collapsed, |el| {
                        el.child(
                            div()
                                .h(px(RADIUS_CARD.into()))
                                .rounded_b(RADIUS_CARD)
                                .border_1()
                                .border_t_0()
                                .border_color(theme.line)
                                .bg(theme.surface),
                        )
                    })
                    .into_any_element()
            }
            Row::Tail => {
                let review = self.source.as_ref().is_some_and(|s| s.review);
                div().h(px(if review { 80.0 } else { 4.0 })).into_any_element()
            }
        };
        self.spawn_highlights(cx);
        element
    }

    /// A file's header: fold, name, folder, counts, status. `pinned` is the copy held over the top of the list.
    pub(super) fn file_header(&self, file: usize, pinned: bool, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.files[file];
        let path = state.entry.path.clone();
        let collapsed = state.collapsed;
        let (folder, name) = match path.rsplit_once('/') {
            Some((folder, name)) => (Some(folder.to_string()), name.to_string()),
            None => (None, path.clone()),
        };
        let hover = theme.hover;
        let toggle_path = path.clone();
        let id = SharedString::from(format!("diff-fold-{}{}", if pinned { "pinned-" } else { "" }, path));
        let selector = format!("diff-header-{}{path}", if pinned { "pinned-" } else { "" });
        div()
            .debug_selector(move || selector.clone())
            .flex()
            .items_center()
            .gap(px(8.0))
            .h(px(HEADER_H))
            .px(px(12.0))
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .when(collapsed, |el| el.rounded(RADIUS_CARD))
            .when(!collapsed, |el| el.rounded_t(RADIUS_CARD))
            .text_step(TEXT_12)
            .child(
                div()
                    .id(id)
                    .debug_selector({
                        let key = format!("diff-fold-{}{path}", if pinned { "pinned-" } else { "" });
                        move || key.clone()
                    })
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .ml(px(-4.0))
                    .rounded(crate::theme::RADIUS_CONTROL)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_collapsed(&toggle_path, cx)))
                    .child(
                        Icon::new(if collapsed { IconName::ArrowRight01 } else { IconName::ArrowDown01 })
                            .size(IconSize::S14)
                            .color(theme.ink3),
                    ),
            )
            .child(div().flex_none().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(name))
            .child(match folder {
                // The folder keeps its end when it truncates (`dir="rtl"`): the part nearest the file shows.
                Some(folder) => div()
                    .min_w_0()
                    .flex_1()
                    .overflow_hidden()
                    .text_color(theme.ink3)
                    .child(div().flex().justify_end().whitespace_nowrap().child(div().flex_none().child(folder))),
                None => div().flex_1(),
            })
            .when(!state.entry.binary, |el| el.child(counts_inline(theme, state.entry.added, state.entry.removed)))
            .child(status_badge(theme, state.entry.status))
            .into_any_element()
    }

    fn message_row(&self, file: usize, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.files[file];
        let message = state.message().unwrap_or_default();
        let path = state.entry.path.clone();
        let show = state.waits_for_show();
        card(theme)
            .child(
                div()
                    .debug_selector({
                        let key = format!("diff-message-{path}");
                        move || key.clone()
                    })
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(12.0))
                    .px(px(16.0))
                    .py(px(24.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child(message)
                    .when(show, |el| {
                        let view = cx.entity();
                        el.child(
                            Button::new(SharedString::from(format!("diff-show-{path}")), "Show diff")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .selector("diff-show")
                                .on_click(move |_, _, cx| view.update(cx, |this, cx| this.show_large(&path, cx))),
                        )
                    }),
            )
            .into_any_element()
    }

    /// The text of a code cell: its runs, its word marks and the selection, recorded for pointer hit tests.
    #[allow(clippy::too_many_arguments)]
    fn code_text(&self, row: usize, half: u8, file: usize, hunk: usize, index: usize, line: &DiffLine, theme: &Theme) -> StyledText {
        let palette = theme.syntax;
        let runs = self.runs_for(file, hunk, index);
        let words: Vec<Range<usize>> = self
            .words_for(file, hunk)
            .and_then(|w| w.get(index).cloned().flatten())
            .map(|ranges| {
                ranges
                    .into_iter()
                    .map(|r| {
                        let (a, b) = utf16_range_to_bytes(&line.text, r);
                        a..b
                    })
                    .collect()
            })
            .unwrap_or_default();
        let selected = self.selection.and_then(|s| s.range_in(row, half, line.text.len()));
        let word_bg = if line.kind == LineKind::Add { theme.diff_add_word } else { theme.diff_remove_word };
        let highlights =
            styled_runs(line.text.len(), runs.as_deref(), &words, selected, &palette, word_bg.into(), theme.accent_tint.into());
        // An empty line still takes a row's height (the desktop draws a zero-width space).
        let text: SharedString = if line.text.is_empty() { "\u{200b}".into() } else { line.text.clone().into() };
        let styled = StyledText::new(text).with_highlights(if line.text.is_empty() { Vec::new() } else { highlights });
        self.layouts.borrow_mut().insert((row, half), styled.layout().clone());
        styled
    }

    /// The text cell and its pointer handlers: a press starts a code selection, a drag extends it.
    fn code_cell(&self, row: usize, half: u8, styled: StyledText, wrap: bool, theme: &Theme, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .min_w_0()
            .flex_1()
            .pr(px(12.0))
            .text_color(theme.ink)
            .cursor_text()
            .when(!wrap, |el| el.whitespace_nowrap())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.release_hold();
                    this.select_start(row, half, event.position, event.modifiers.shift, cx);
                }),
            )
            .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                if event.pressed_button == Some(MouseButton::Left) {
                    this.select_move(row, half, event.position, cx);
                }
            }))
            .child(styled)
    }

    fn gutter(value: Option<u32>, theme: &Theme) -> gpui::Div {
        div().flex_none().w(px(GUTTER_W)).pr(px(8.0)).flex().justify_end().text_color(theme.ink3).children(value.map(|v| v.to_string()))
    }

    fn marker_cell(kind: LineKind, theme: &Theme) -> gpui::Div {
        div().flex_none().w(px(MARKER_W)).flex().justify_center().text_color(marker_color(theme, kind)).child(marker(kind))
    }

    /// The "+" that starts a comment on a hovered row: a press starts a range that follows the drag.
    fn add_button(&self, target: Target, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let key = format!("diff-add-{}-{}-{}{}", target.path, target.hunk, target.line, target.side.map(|s| s.as_str()).unwrap_or(""));
        div()
            .id(SharedString::from(key.clone()))
            .debug_selector(move || key.clone())
            .absolute()
            .top(px(2.0))
            .left(px(4.0))
            .size(px(ADD_SIZE))
            .flex()
            .items_center()
            .justify_center()
            .rounded(RADIUS_CHIP)
            .bg(theme.ink)
            .opacity(0.0)
            .group_hover(ROW_GROUP, |s| s.opacity(1.0))
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.release_hold();
                    this.start_comment(target.clone(), event.modifiers.shift, true, window, cx);
                }),
            )
            .child(Icon::new(IconName::Add01).size(IconSize::S12).color(theme.on_ink))
            .into_any_element()
    }

    /// The neutral wash and the ink bar of a row in the draft's range.
    fn selected_marks(theme: &Theme) -> [AnyElement; 2] {
        [
            div().absolute().top_0().bottom_0().left_0().right_0().bg(theme.hover2).into_any_element(),
            div().absolute().top_0().bottom_0().left_0().w(px(SELECTED_BAR)).bg(theme.ink).into_any_element(),
        ]
    }

    fn drag_target(&self, row_target: Target, cx: &mut Context<Self>) -> impl Fn(&MouseMoveEvent, &mut Window, &mut gpui::App) + 'static {
        let view = cx.entity().downgrade();
        move |_, _, cx| {
            let target = row_target.clone();
            view.update(cx, |this, cx| {
                if this.draft.as_ref().is_some_and(|d| d.dragging) {
                    this.drag_comment(target, cx);
                }
            })
            .ok();
        }
    }

    fn unified_row(&self, ix: usize, file: usize, hunk: usize, index: usize, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(line) = self.files[file].hunks().and_then(|h| h.get(hunk)).and_then(|h| h.lines.get(index)).cloned() else {
            return div().into_any_element();
        };
        let path = self.files[file].entry.path.clone();
        let wrap = self.applied.wrap;
        let selected = self.draft.as_ref().is_some_and(|d| d.covers(&path, hunk, index, None));
        let target = Target { path: path.clone(), hunk, line: index, side: None };
        let styled = self.code_text(ix, 0, file, hunk, index, &line, theme);
        let shift = if wrap { px(0.0) } else { -self.scroll_x };
        let content = div()
            .relative()
            .left(shift)
            .flex()
            .min_h(px(ROW_H))
            .when(wrap, |el| el.w_full())
            .when(!wrap, |el| el.min_w_full())
            .child(Self::gutter(line.old_number, theme))
            .child(Self::gutter(line.new_number, theme))
            .child(Self::marker_cell(line.kind, theme))
            .child(self.code_cell(ix, 0, styled, wrap, theme, cx));
        let mut row = div()
            .debug_selector({
                let key = format!("diff-row-{ix}");
                move || key.clone()
            })
            .group(ROW_GROUP)
            .relative()
            .overflow_hidden()
            .font_family(mono())
            .text_size(px(CODE_SIZE))
            .line_height(px(ROW_H))
            .when_some(tint(theme, line.kind), |el, tint| el.bg(tint))
            .on_mouse_move(self.drag_target(target.clone(), cx));
        if selected {
            row = row.children(Self::selected_marks(theme));
        }
        let commenting = self.source.as_ref().is_some_and(|s| s.comments);
        let row = row.child(content).when(commenting, |el| el.child(self.add_button(target, theme, cx)));
        card(theme).child(row).into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn split_row(
        &self,
        ix: usize,
        file: usize,
        hunk: usize,
        left: Option<usize>,
        right: Option<usize>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(h) = self.files[file].hunks().and_then(|h| h.get(hunk)).cloned() else { return div().into_any_element() };
        let path = self.files[file].entry.path.clone();
        let commenting = self.source.as_ref().is_some_and(|s| s.comments);
        let half = |which: u8, index: Option<usize>, cx: &mut Context<Self>| -> AnyElement {
            let border = which == 0;
            let Some(index) = index else {
                return div()
                    .flex_1()
                    .min_w_0()
                    .min_h(px(ROW_H))
                    .bg(theme.inset)
                    .when(border, |el| el.border_r_1().border_color(theme.line))
                    .into_any_element();
            };
            let line = &h.lines[index];
            let side = if which == 0 { DiffSide::Old } else { DiffSide::New };
            let selected = self.draft.as_ref().is_some_and(|d| d.covers(&path, hunk, index, Some(side)));
            let target = Target { path: path.clone(), hunk, line: index, side: Some(side) };
            let styled = self.code_text(ix, which, file, hunk, index, line, theme);
            let number = if which == 0 { line.old_number } else { line.new_number };
            let mut cell = div()
                .group(ROW_GROUP)
                .relative()
                .flex_1()
                .min_w_0()
                .flex()
                .min_h(px(ROW_H))
                .when_some(tint(theme, line.kind), |el, tint| el.bg(tint))
                .when(border, |el| el.border_r_1().border_color(theme.line))
                .on_mouse_move(self.drag_target(target.clone(), cx));
            if selected {
                cell = cell.children(Self::selected_marks(theme));
            }
            cell.child(Self::gutter(number, theme))
                .child(Self::marker_cell(line.kind, theme))
                .child(self.code_cell(ix, which, styled, true, theme, cx))
                .when(commenting, |el| el.child(self.add_button(target, theme, cx)))
                .into_any_element()
        };
        let left_el = half(0, left, cx);
        let right_el = half(1, right, cx);
        card(theme)
            .child(
                div()
                    .debug_selector({
                        let key = format!("diff-row-{ix}");
                        move || key.clone()
                    })
                    .flex()
                    .font_family(mono())
                    .text_size(px(CODE_SIZE))
                    .line_height(px(ROW_H))
                    .child(left_el)
                    .child(right_el),
            )
            .into_any_element()
    }

    fn threads_row(&self, ids: &[String], theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(renderer) = self.thread_renderer.clone() else { return card(theme).into_any_element() };
        let threads = renderer(ids, window, cx);
        card(theme)
            .child(
                div()
                    .debug_selector(|| "diff-threads".to_string())
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .py(px(8.0))
                    .bg(theme.surface)
                    .child(threads),
            )
            .into_any_element()
    }

    fn slot_row(&self, row: Row, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Row::Slot { file, hunk, line } = row else { return div().into_any_element() };
        let ids = self.files[file].placed.get(&(hunk, line)).cloned().unwrap_or_default();
        let editing = self.editor_at(row);
        card(theme).child(self.comment_slot(&ids, editing.then_some(()), theme, window, cx)).into_any_element()
    }

    fn orphans_row(&self, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let ids = self.orphans();
        let cards: Vec<AnyElement> = ids
            .iter()
            .filter_map(|id| self.comment_view(id))
            .map(|view| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(div().truncate().font_family(mono()).text_step(TEXT_11).text_color(theme.ink3).child(view.comment.path.clone()))
                    .child(self.comment_card(&view, theme, window, cx))
                    .into_any_element()
            })
            .collect();
        div()
            .px(px(CARD_INSET))
            .pb(px(12.0))
            .child(
                div()
                    .debug_selector(|| "diff-orphans".to_string())
                    .overflow_hidden()
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface)
                    .child(div().flex().flex_col().gap(px(8.0)).px(px(12.0)).py(px(8.0)).children(cards)),
            )
            .into_any_element()
    }

    /// The sticky header over the top of the list: the file the top row belongs to, pushed up by the end of its
    /// card when the next file comes in. Positions come from the list's last layout (a frame behind while scrolling).
    pub(super) fn sticky_header(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let top = self.list.logical_scroll_top();
        let file = self.rows.get(top.item_ix)?.file()?;
        let range = self.file_ranges.get(file)?;
        if top.item_ix == range.start && top.offset_in_item <= px(0.5) {
            return None;
        }
        let end = range.end - 1;
        let card_bottom: Option<Pixels> = match (self.list.bounds_for_item(top.item_ix), self.list.bounds_for_item(end)) {
            (Some(first), Some(last)) => {
                let collapsed = self.files[file].collapsed;
                let edge = if collapsed { px(0.0) } else { px(RADIUS_CARD.into()) };
                Some(last.origin.y - first.origin.y - top.offset_in_item + edge)
            }
            _ => None,
        };
        let y = card_bottom.map(|b| (b - px(HEADER_H)).min(px(0.0))).unwrap_or(px(0.0));
        Some(
            div()
                .absolute()
                .top(y)
                .left_0()
                .right_0()
                .px(px(CARD_INSET))
                // The page fills behind the header's rounded corners, so rows scrolling under don't show through them.
                .child(
                    div()
                        .relative()
                        .child(div().absolute().top_0().left_0().right_0().h(px(RADIUS_CARD.into())).bg(theme.page))
                        .child(self.file_header(file, true, theme, cx)),
                )
                .into_any_element(),
        )
    }
}

/// A row's slice of the file card: the card's side borders and fill.
pub(super) fn card(theme: &Theme) -> gpui::Div {
    div().mx(px(CARD_INSET)).border_l_1().border_r_1().border_color(theme.line).bg(theme.surface)
}
