//! The diff view (P-06, P-07, C-07; WP-31): every file of a diff in one scrolling list, the one the reader picked held
//! at the top, with line comments and a PR's review threads under their lines. The Changes panel shows a section's
//! or a commit's files in it; the PR panel's Files tab shows the PR's.
//!
//! | File | What |
//! | --- | --- |
//! | `view.rs` | [`DiffView`]: the source, files and their patches, rows, comments and the draft, code selection, events |
//! | `rows.rs` | The row model: each file as header, body rows and end; the smallest splice between two row lists |
//! | `render.rs` | Rows: card slices, hunk headers, unified and split rows with gutters, markers, runs and word marks |
//! | `cards.rs` | The comment slot: cards (label, Outdated, clamped body, Edit, Delete) and the editor |
//! | `bar.rs` | The diff bar: Back, Send N comments, Unified / Split / Wrap / Refresh |
//! | `highlight.rs` | Syntax runs per hunk side through syntect, lazily, in the Shiki buckets code blocks use |
//! | `comments.rs` | `lib/diff-comments.ts` (anchoring, labels, the Chat message), the store and the draft |
//!
//! How it differs from the desktop's DOM, on purpose:
//!
//! - Virtualized: the list lays out only the rows on screen (GPUI `list`), so a 10,000-line file opens and scrolls in
//!   frames (README "Diff notes" has the timing). A file is a run of rows, each drawing its slice of the card.
//! - The sticky file header is a copy drawn over the list's top, pushed up by the end of its card; it reads the list's
//!   last layout, so while scrolling it may trail by a frame.
//! - Patches load when their rows come within about 60 rows of the screen (the desktop: 800px), synchronously from
//!   the owner's loader; the held file keeps its place because the list anchors to the header's row.
//! - The unified view scrolls sideways as a whole (one offset for every row, gutters included), not per file.
//! - Code selection: a drag in the code selects text in one column (both columns of a split row never mix, as the
//!   comment ranges); ⌘C copies it as lines, without gutters or markers. WP-16's selection model
//!   (`ui::selection`) serialises Markdown and has no API for other text yet, so this is the diff's own.
//! - Comments are kept per Chat in memory (the desktop's `localStorage`), so they last the session.
//!
//! Where it is mounted: over the Chat column, as the desktop does, with the Chat's title as Back's label
//! (`over_chat.rs`). The Changes panel and the PR panel's Files tab keep their lists and open it; the window draws it.

mod bar;
mod cards;
pub mod comments;
pub mod highlight;
pub mod over_chat;
mod render;
pub mod rows;
mod view;

#[cfg(test)]
mod comments_tests;
#[cfg(test)]
mod tests;

pub use comments::{ChangesMode, CommentView, DiffComment, DiffSelection, DiffSide};
pub use rows::{DiffLayout, Row};
pub use view::{
    CodeSelection, DiffEvent, DiffPrefs, DiffSource, DiffStats, DiffView, LARGE_DIFF_LINES, Loader, ThreadAnchor, ThreadRenderer,
};

use gpui::{App, Context, Global, KeyBinding, MouseButton, MouseUpEvent, ScrollEvent, Window, div, font, list, prelude::*, px};
use gpui_base::input::Copy as CopyText;
use gpui_component::scroll::ScrollableElement as _;

use crate::theme::ActiveTheme;
use crate::ui::{EmptySize, EmptyState};

/// The key context of the diff: ⌘C copies the code selection while focus is in it.
const KEY_CONTEXT: &str = "DiffView";

struct KeysInstalled;
impl Global for KeysInstalled {}

/// ⌘C for the diff, once per app.
pub(crate) fn install_keys(cx: &mut App) {
    if cx.has_global::<KeysInstalled>() {
        return;
    }
    cx.set_global(KeysInstalled);
    cx.bind_keys([KeyBinding::new("cmd-c", CopyText, Some(KEY_CONTEXT))]);
}

impl Render for DiffView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_prefs(cx);
        self.apply_env_seed(window, cx);
        if self.char_width.is_none() {
            let text = window.text_system();
            let id = text.resolve_font(&font(crate::theme::mono()));
            self.char_width = text.advance(id, px(render::CODE_SIZE), 'm').ok().map(|size| size.width);
        }
        self.load_near(cx);
        let top = self.list.logical_scroll_top();
        let visible =
            self.holding.or_else(|| self.rows.get(top.item_ix).and_then(|row| row.file())).or((!self.files.is_empty()).then_some(0));
        self.set_visible(visible, cx);
        self.layouts.borrow_mut().clear();
        let viewport = self.list.viewport_bounds().size.width;
        let max_x = self.max_scroll_x(viewport);
        if self.scroll_x > max_x {
            self.scroll_x = max_x;
        }
        let theme = *cx.theme();
        let sticky = self.sticky_header(&theme, cx);
        let empty = self.source.is_some() && self.files.is_empty();
        let body = div()
            .id("diff-body")
            .debug_selector(|| "diff-body".to_string())
            .relative()
            .flex_1()
            .min_h_0()
            .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                this.release_hold();
                let delta = event.delta.pixel_delta(px(render::ROW_H));
                let unified = this.applied.layout == DiffLayout::Unified && !this.applied.wrap;
                if unified && delta.x != px(0.0) {
                    let max = this.max_scroll_x(this.list.viewport_bounds().size.width);
                    this.scroll_x = (this.scroll_x - delta.x).clamp(px(0.0), max);
                    cx.notify();
                }
                let _ = window;
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, _| this.release_hold()))
            .child(list(self.list.clone(), cx.processor(|this, ix, window, cx| this.render_row(ix, window, cx))).size_full())
            .children(sticky)
            .when(empty, |el| {
                el.child(
                    div().absolute().top_0().left_0().right_0().child(EmptyState::new().size(EmptySize::Page).title("No changes to show")),
                )
            })
            .vertical_scrollbar(&self.list);
        let finish = |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
            this.finish_drag(window, cx);
            this.select_end(cx);
        };
        div()
            .id("diff-view")
            .debug_selector(|| "diff-view".to_string())
            .track_focus(&self.focus)
            .key_context(KEY_CONTEXT)
            .on_action(cx.listener(|this, _: &CopyText, _, cx| this.copy(cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(move |this, _: &MouseUpEvent, window, cx| finish(this, window, cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(move |this, _: &MouseUpEvent, window, cx| finish(this, window, cx)))
            .flex()
            .flex_col()
            .size_full()
            .pt(px(6.0))
            .bg(theme.page)
            .text_color(theme.ink)
            .child(self.bar(&theme, cx))
            .child(body)
    }
}

impl DiffView {
    /// Snapshot runs (never tests): `MILAGRE_GPUI_DIFF_COMMENTS=1` puts a comment, an outdated one and an open editor
    /// on the held file once it shows.
    fn apply_env_seed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if cfg!(test) || self.seeded || std::env::var("MILAGRE_GPUI_DIFF_COMMENTS").is_err() {
            return;
        }
        let Some(path) = self.holding().map(str::to_string) else { return };
        if !self.source.as_ref().is_some_and(|s| s.comments) {
            return;
        }
        self.seeded = true;
        self.seed_comment(
            &path,
            0,
            3,
            5,
            None,
            "Keep `mode` first: the hook reads it before the list, and this order made the refresh flash.",
            cx,
        );
        self.seed_raw_comment(
            DiffComment {
                id: String::new(),
                path: "apps/desktop/app/src/components/changes/OldPanel.tsx".into(),
                side: DiffSide::New,
                start: 140,
                end: 141,
                snippet: vec!["+const gone = true;".into(), "+return gone;".into()],
                body: "This branch went away in the last push.".into(),
                created_at: 0,
                mode: self.mode(),
            },
            cx,
        );
        let target = comments::Target { path, hunk: 0, line: 2, side: None };
        self.start_comment(target, false, false, window, cx);
        // The outdated comment's file left the diff: it sits at the top, so show the top.
        self.release_hold();
        self.list.scroll_to(gpui::ListOffset::default());
        self.set_editor_text("Should this read the PR's head too?", window, cx);
    }
}
