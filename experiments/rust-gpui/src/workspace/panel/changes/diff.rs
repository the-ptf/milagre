//! The selected file's diff under the list: gpui-component's `Diff` over a `DiffState`, re-skinned through the
//! theme bridge (its added and removed rows are `success` and `danger` at 12 percent, words at 30 percent, which are
//! DESIGN.md's `diff-add` and `diff-remove` tokens in the dark theme). The view feeds it the host's patch and
//! the unified/split choice; word marks, line numbers and signs are its own.
//!
//! Seams for the later packages: a file header slot (sticky headers, WP-31), `Diff::annotations` and
//! `on_add_annotation` (line comments, WP-31), a per-file PR panel (WP-32).

use gpui::{App, Context, Entity, IntoElement, SharedString, div, prelude::*, px};
use gpui_component::diff::{Diff, DiffFile, DiffMode, DiffState};

use super::{ChangesView, Layout};
use crate::logic::diff::git::{DiffFileEntry, DiffFileResult};
use crate::logic::diff::tree::Counted;
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt, mono};
use crate::ui::{EmptySize, EmptyState, IconButton, IconButtonSize, IconName};

/// The `DiffState` of the file on screen and what it was made from.
pub struct DiffPane {
    pub path: SharedString,
    /// Which source (section or commit) and path it shows, to know when to build another.
    pub key: SharedString,
    pub state: Option<Entity<DiffState>>,
    pub note: Option<&'static str>,
}

fn diff_mode(layout: Layout) -> DiffMode {
    match layout {
        Layout::Unified => DiffMode::Unified,
        Layout::Split => DiffMode::Split,
    }
}

impl DiffPane {
    /// Parses `result.patch` into a `DiffState`; a binary, oversized or unparsable file keeps a note instead.
    pub fn build(key: SharedString, path: &str, result: Option<&DiffFileResult>, layout: Layout, cx: &mut App) -> Self {
        let path: SharedString = path.to_string().into();
        let note = match result {
            None => Some("There is no diff to show for this file."),
            Some(result) if result.binary => Some("Binary file. There is no text diff to show."),
            Some(result) if result.too_large => Some("This file is too large to show. Open it in your editor."),
            Some(result) if result.patch.trim().is_empty() => Some("No changes to show."),
            Some(_) => None,
        };
        let files = match (note, result) {
            (None, Some(result)) => DiffFile::parse(&result.patch).ok(),
            _ => None,
        };
        match files {
            Some(files) if !files.is_empty() => {
                let state = cx.new(|cx| DiffState::new(files, cx).with_mode(diff_mode(layout)));
                Self { path, key, state: Some(state), note: None }
            }
            _ => Self { path, key, state: None, note: Some(note.unwrap_or("This patch could not be read.")) },
        }
    }

    pub fn set_layout(&self, layout: Layout, cx: &mut App) {
        if let Some(state) = &self.state {
            state.update(cx, |state, cx| state.set_mode(diff_mode(layout), cx));
        }
    }
}

/// The pane: a 32px header (the path, the counts, close) over the diff.
pub fn render(pane: &DiffPane, entry: Option<&DiffFileEntry>, cx: &mut Context<ChangesView>) -> gpui::AnyElement {
    let theme = *cx.theme();
    let counts = entry.map(|e| (e.added(), e.removed()));
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
        .when_some(counts.filter(|_| pane.state.is_some()), |el, (added, removed)| {
            el.child(super::files::counts_inline(&theme, added, removed))
        })
        .child(
            IconButton::new("diff-close", IconName::Cancel01)
                .size(IconButtonSize::S24)
                .on_click(cx.listener(|this, _, _window, cx| this.close_diff(cx))),
        );
    let body = match &pane.state {
        Some(state) => div()
            .id("diff-body")
            .debug_selector(|| "diff-body".to_string())
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
    div().debug_selector(|| "diff-pane".to_string()).flex().flex_col().flex_1().min_h_0().child(header).child(body).into_any_element()
}
