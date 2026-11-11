//! The Files tab (`Files`, `FileTree` in `PullRequestPanel.tsx`): the PR's files as the folder tree, each with the
//! open review threads on it and its counts. A click shows the file's diff under the list: a plain read-only
//! unified diff (gpui-component's `Diff`, as the Changes panel draws it) with the file's review threads above it
//! and the review bar floating over it. Split, wrap, line comments and threads under their lines wait for WP-31.

use std::collections::HashMap;

use gpui::{AnyElement, ClickEvent, Context, Window, div, prelude::*, px};
use gpui_component::diff::Diff;

use super::model::{PrFile, PullRequestDetail, PullState, open_threads};
use super::{PrView, ViewState};
use crate::logic::diff::build_diff_tree;
use crate::logic::diff::tree::{Counted, DiffTreeNode};
use crate::theme::{ActiveTheme, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{EmptySize, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize};
use crate::workspace::panel::changes::files::counts_inline;

const ROW: f32 = 28.0;
/// Left padding of a row, and what each depth adds (`12 + depth * 12`).
const INDENT_BASE: f32 = 12.0;
const INDENT_STEP: f32 = 12.0;

/// A flattened tree row.
enum Row<'a> {
    Folder { name: &'a str, path: &'a str, depth: usize, collapsed: bool },
    File { name: &'a str, file: &'a PrFile, depth: usize },
}

fn flatten<'a>(nodes: &'a [DiffTreeNode<PrFile>], depth: usize, collapsed: &std::collections::HashSet<String>, out: &mut Vec<Row<'a>>) {
    for node in nodes {
        match node {
            DiffTreeNode::File { name, file, .. } => out.push(Row::File { name, file, depth }),
            DiffTreeNode::Folder(folder) => {
                let closed = collapsed.contains(&folder.path);
                out.push(Row::Folder { name: &folder.name, path: &folder.path, depth, collapsed: closed });
                if !closed {
                    flatten(&folder.children, depth + 1, collapsed, out);
                }
            }
        }
    }
}

/// Open review threads per path.
pub fn thread_counts(pr: &PullRequestDetail) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for thread in open_threads(pr) {
        *counts.entry(thread.path.clone()).or_insert(0) += 1;
    }
    counts
}

impl PrView {
    pub(super) fn files(&self, pr: &PullRequestDetail, state: &ViewState, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        if pr.files.is_empty() {
            return EmptyState::new().size(EmptySize::Panel).icon(IconName::FileDiff).title("No files changed.").into_any_element();
        }
        let tree = build_diff_tree(&pr.files);
        let mut rows = Vec::new();
        flatten(&tree, 0, &state.collapsed, &mut rows);
        let counts = thread_counts(pr);
        div()
            .debug_selector(|| "pr-files".to_string())
            .flex()
            .flex_col()
            .pt(px(6.0))
            .children(rows.into_iter().enumerate().map(|(ix, row)| self.file_row(ix, row, state, &counts, &theme, cx)))
            .into_any_element()
    }

    fn file_row(
        &self,
        ix: usize,
        row: Row,
        state: &ViewState,
        counts: &HashMap<String, usize>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view = cx.entity();
        let theme = *theme;
        let hover = theme.hover;
        let base = div().id(("pr-file-row", ix)).flex().items_center().gap(px(6.0)).w_full().h(px(ROW)).pr(px(12.0)).text_step(TEXT_12);
        match row {
            Row::Folder { name, path, depth, collapsed } => {
                let path_owned = path.to_string();
                base.debug_selector({
                    let key = format!("pr-folder-{path}");
                    move || key.clone()
                })
                .pl(px(INDENT_BASE + depth as f32 * INDENT_STEP))
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(move |_: &ClickEvent, _, cx| view.update(cx, |this, cx| this.toggle_folder(&path_owned, cx)))
                .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).child(
                    Icon::new(if collapsed { IconName::ArrowRight01 } else { IconName::ArrowDown01 }).size(IconSize::S14).color(theme.ink3),
                ))
                .child(div().min_w_0().flex_1().truncate().text_color(theme.ink3).child(name.to_string()))
                .into_any_element()
            }
            Row::File { name, file, depth } => {
                let active = state.selected.as_deref() == Some(file.path.as_str());
                let path = file.path.clone();
                let threads = counts.get(&file.path).copied().filter(|n| *n > 0);
                base.debug_selector({
                    let key = format!("pr-file-{}", file.path);
                    move || key.clone()
                })
                .pl(px(INDENT_BASE + depth as f32 * INDENT_STEP))
                .cursor_pointer()
                .when(active, |el| el.bg(hover))
                .hover(move |style| style.bg(hover))
                .on_click(move |_: &ClickEvent, _, cx| view.update(cx, |this, cx| this.open_file(&path, cx)))
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(16.0))
                        .child(Icon::new(IconName::File01).size(IconSize::S14).color(theme.ink3)),
                )
                .child(div().min_w_0().flex_1().truncate().text_color(theme.ink).child(name.to_string()))
                .when_some(threads, |el, n| {
                    el.child(
                        div()
                            .debug_selector(|| "pr-file-threads".to_string())
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(2.0))
                            .text_step(TEXT_11)
                            .text_color(theme.orange_ink)
                            .child(Icon::new(IconName::Comment01).size(IconSize::S12).color(theme.orange_ink))
                            .child(n.to_string()),
                    )
                })
                .child(counts_inline(&theme, file.added(), file.removed()))
                .into_any_element()
            }
        }
    }

    /// The picked file's diff: a 32px header (path, counts, close), its review threads, the diff, and the review bar.
    pub(super) fn diff_pane(&self, pr: &PullRequestDetail, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let Some(pane) = &self.diff else { return div().into_any_element() };
        let file = pr.files.iter().find(|file| file.path == pane.path.as_ref());
        let (dir, name) = match pane.path.rsplit_once('/') {
            Some((dir, name)) => (Some(dir.to_string()), name.to_string()),
            None => (None, pane.path.to_string()),
        };
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .h(px(32.0))
            .pl(px(12.0))
            .pr(px(8.0))
            .gap(px(8.0))
            .border_t_1()
            .border_b_1()
            .border_color(theme.line)
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .flex_1()
                    .items_center()
                    .gap(px(6.0))
                    .text_step(TEXT_12)
                    .child(div().flex_none().font_family(mono()).text_color(theme.ink).child(name))
                    .when_some(dir, |el, dir| el.child(div().min_w_0().truncate().text_color(theme.ink3).child(dir))),
            )
            .when_some(file.filter(|_| pane.state.is_some()), |el, file| el.child(counts_inline(&theme, file.added(), file.removed())))
            .child(
                IconButton::new("pr-diff-close", IconName::Cancel01)
                    .size(IconButtonSize::S24)
                    .on_click(cx.listener(|this, _, _window, cx| this.close_file(cx))),
            );
        let body: AnyElement = match &pane.state {
            Some(state) => div()
                .id("pr-diff-body")
                .debug_selector(|| "pr-diff-body".to_string())
                .relative()
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(Diff::new(state).header_visible(false))
                .into_any_element(),
            None => div()
                .flex_1()
                .min_h_0()
                .child(EmptyState::new().size(EmptySize::Compact).title(pane.note.unwrap_or("Nothing to show.")))
                .into_any_element(),
        };
        let path = pane.path.to_string();
        let threads = self.thread_cards(pr, &path, window, cx);
        let bar = (pr.state == PullState::Open).then(|| self.review_bar(pr, window, cx));
        div()
            .debug_selector(|| "pr-diff-pane".to_string())
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(header)
            .children(threads)
            .child(body)
            .children(bar)
            .into_any_element()
    }
}
