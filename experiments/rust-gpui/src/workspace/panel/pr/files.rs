//! The Files tab (`Files`, `FileTree` in `PullRequestPanel.tsx`): the PR's files as the folder tree, each with the
//! open review threads on it and its counts. A click opens the diff view (`workspace::panel::diff`) under the list
//! with every file of the PR, scrolled to the one picked: review threads under their lines (the ones no row carries
//! below their file), line comments, and the review bar floating over its bottom.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{AnyElement, AnyView, ClickEvent, Context, Entity, SharedString, StyleRefinement, Window, div, prelude::*, px};

use super::bridge::{PrBridge, Write};
use super::model::{PrFile, PullRequestDetail, PullState, Side, open_threads};
use super::{PrEvent, PrView, ViewState};
use crate::logic::diff::build_diff_tree;
use crate::logic::diff::git::DiffFileEntry;
use crate::logic::diff::tree::{Counted, DiffTreeNode};
use crate::theme::{ActiveTheme, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{EmptySize, EmptyState, Icon, IconName, IconSize};
use crate::workspace::panel::changes::files::counts_inline;
use crate::workspace::panel::diff::{ChangesMode, DiffEvent, DiffSide, DiffSource, DiffView, ThreadAnchor, ThreadRenderer};

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
                // While the diff is open, the file whose header it has pinned.
                let active = self.visible.as_deref().or(state.selected.as_deref()) == Some(file.path.as_str());
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

    /// The diff view, made on the first pick, and its events.
    pub(super) fn diff_entity(&mut self, cx: &mut Context<Self>) -> Entity<DiffView> {
        if let Some(diff) = &self.diff {
            return diff.clone();
        }
        let diff = cx.new(DiffView::new);
        self._diff_sub = Some(cx.subscribe(&diff, |this, _, event: &DiffEvent, cx| match event {
            DiffEvent::Close => this.close_file(cx),
            DiffEvent::Send(message) => {
                // Back to the Chat first, so the message shows up as it lands.
                this.close_file(cx);
                cx.emit(PrEvent::FixInChat(message.clone()));
            }
            DiffEvent::AddToReview { path, selection, body } => {
                let side = match selection.side {
                    DiffSide::Old => Side::Left,
                    DiffSide::New => Side::Right,
                };
                let start = (selection.start != selection.end).then_some(selection.start);
                this.write(
                    "comment",
                    Write::Comment { path: path.clone(), side, line: selection.end, start_line: start, body: body.clone() },
                    cx,
                );
            }
            DiffEvent::VisibleFile(path) => {
                if this.visible != *path {
                    this.visible = path.clone();
                    cx.notify();
                }
            }
            DiffEvent::Refresh => {}
        }));
        self.diff = Some(diff.clone());
        diff
    }

    /// Gives the diff the PR's threads and how to draw them, when they (or a fold, or the reply field) changed.
    pub(super) fn sync_diff_threads(&mut self, cx: &mut Context<Self>) {
        let (Some(diff), Some(pr)) = (self.diff_view(), &self.detail) else { return };
        let key = format!("{:?}{:?}{:?}", pr.threads, self.review.folded, self.review.replying);
        if key == self.diff_threads {
            return;
        }
        self.diff_threads = key;
        let anchors: Vec<ThreadAnchor> = pr
            .threads
            .iter()
            .map(|thread| ThreadAnchor {
                id: thread.id.clone(),
                path: thread.path.clone(),
                line: thread.line,
                side: match thread.side {
                    Side::Left => DiffSide::Old,
                    Side::Right => DiffSide::New,
                },
            })
            .collect();
        let view = cx.entity().downgrade();
        let renderer: ThreadRenderer = Rc::new(move |ids: &[String], window: &mut Window, cx: &mut gpui::App| {
            let ids = ids.to_vec();
            view.update(cx, |this, cx| {
                let theme = *cx.theme();
                let Some(pr) = this.detail.clone() else { return div().into_any_element() };
                let cards: Vec<AnyElement> = ids
                    .iter()
                    .filter_map(|id| pr.threads.iter().find(|t| &t.id == id))
                    .map(|thread| this.thread_card(thread, &theme, window, cx))
                    .collect();
                div().flex().flex_col().gap(px(8.0)).children(cards).into_any_element()
            })
            .unwrap_or_else(|_| div().into_any_element())
        });
        diff.update(cx, |diff, cx| diff.set_threads(anchors, Some(renderer), cx));
    }

    /// The picked file's diff (the diff view, its own cached view) and the review bar over its bottom.
    pub(super) fn diff_pane(&self, pr: &PullRequestDetail, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let Some(diff) = self.diff_view() else { return div().into_any_element() };
        let bar = (pr.state == PullState::Open).then(|| self.review_bar(pr, window, cx));
        div()
            .debug_selector(|| "pr-diff-pane".to_string())
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .border_t_1()
            .border_color(theme.line)
            .child(div().flex_1().min_h_0().child(AnyView::from(diff).cached(StyleRefinement::default().size_full())))
            .children(bar)
            .into_any_element()
    }
}

/// The PR's files as the diff view reads them, and their patches through the bridge (`pr:diff-file`).
pub fn diff_source(chat: &SharedString, pr: &PullRequestDetail, number: u32, bridge: Rc<dyn PrBridge>) -> DiffSource {
    let files: Vec<DiffFileEntry> = pr
        .files
        .iter()
        .map(|file| DiffFileEntry {
            path: file.path.clone(),
            old_path: None,
            status: file.status,
            added: file.additions,
            removed: file.deletions,
            binary: false,
            untracked: false,
        })
        .collect();
    let by_path: HashMap<String, PrFile> = pr.files.iter().map(|f| (f.path.clone(), f.clone())).collect();
    DiffSource {
        chat: chat.clone(),
        mode: ChangesMode::Pr,
        base: Some(format!("PR #{}", pr.number)),
        files,
        loader: Rc::new(move |entry| by_path.get(&entry.path).and_then(|file| bridge.file_patch(number, file))),
        back_label: SharedString::default(),
        review: pr.state == PullState::Open,
        comments: true,
    }
}
