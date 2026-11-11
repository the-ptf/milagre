//! The diff over the Chat column (`DiffBar` and `DiffView` in `App.tsx`'s `<main>`): opening a file from Changes or a
//! PR's Files shows the diff in the Chat column's place, Back named after the Chat, while the panel keeps its list as
//! the opener. Hiding the panel takes it away (the desktop closes it then).
//!
//! The window asks the panel which diff is open (`Panel::diff_over_chat`) and draws it over the Chat column's body
//! with [`Workspace::diff_over_chat`]; the corner's toggles stay above it, so the bar keeps clear of them.

use gpui::{AnyElement, AnyView, Context, Entity, Pixels, SharedString, StyleRefinement, Window, div, prelude::*};

use super::DiffView;
use crate::theme::ActiveTheme;
use crate::workspace::Workspace;
use crate::workspace::shell::top_bar;
use crate::workspace::sidebar::{SIDEBAR_WIDTH, rail::RAIL_WIDTH};

/// Back's label and the bar's insets while the diff is over the Chat column.
#[derive(Clone, Debug, PartialEq)]
pub struct OverChat {
    pub label: SharedString,
    pub leading: Pixels,
    pub trailing: Pixels,
}

/// The diff the panel has open, and who draws it.
pub enum OpenDiff {
    /// A Changes list's (or a commit's) files: the diff view alone.
    Changes(Entity<DiffView>),
    /// A PR's files: the diff with the review bar under it, which the PR panel draws.
    Pr(Entity<crate::workspace::panel::pr::PrView>),
}

impl DiffView {
    /// Puts the diff over the Chat column (Back says `label`), or back in its owner's place with `None`.
    pub fn set_over_chat(&mut self, over: Option<OverChat>, cx: &mut Context<Self>) {
        if self.over_chat != over {
            self.over_chat = over;
            cx.notify();
        }
    }

    pub fn over_chat(&self) -> Option<&OverChat> {
        self.over_chat.as_ref()
    }
}

impl Workspace {
    /// `body` (the grid, the Chat column) with the panel's open diff over it.
    pub(crate) fn diff_over_chat(&mut self, body: AnyElement, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(open) = self.panel.read(cx).diff_over_chat(cx) else { return body };
        let title = self.chat.read(cx).title();
        let label: SharedString = if title.is_empty() { "Back".into() } else { title.to_string().into() };
        let collapsed = self.sidebar.read(cx).is_collapsed();
        let left = if collapsed { RAIL_WIDTH } else { SIDEBAR_WIDTH } + 1.0;
        let items = self.corner_items(cx).len() + crate::workspace::grid::corner_count(self.grid.read(cx));
        let over = OverChat { label, leading: top_bar::chat_leading_inset(left), trailing: top_bar::chat_trailing_inset(items) };
        let pane = match open {
            OpenDiff::Changes(diff) => {
                diff.update(cx, |diff, cx| diff.set_over_chat(Some(over), cx));
                AnyView::from(diff).cached(StyleRefinement::default().size_full()).into_any_element()
            }
            OpenDiff::Pr(pr) => pr.update(cx, |pr, cx| pr.diff_over_chat_pane(over, window, cx)),
        };
        let theme = *cx.theme();
        div()
            .relative()
            .size_full()
            .child(body)
            .child(
                div()
                    .id("diff-over-chat")
                    .debug_selector(|| "diff-over-chat".to_string())
                    .absolute()
                    .inset_0()
                    .occlude()
                    .bg(theme.page)
                    .child(pane),
            )
            .into_any_element()
    }
}
