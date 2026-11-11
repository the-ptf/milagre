//! Root view: three flush, full-height columns separated by 1px hairlines.
//!
//! How re-rendering works in this GPUI, and so how the views are mounted (CONVENTIONS.md has the rule):
//! a `cx.notify()` re-renders the notifying view and every view on the path up to this root. A view that
//! re-renders re-renders its plain child views too, but reuses the last frame of its cached ones
//! (`AnyView::cached`) unless they are dirty themselves; a dirty cached view re-renders its whole subtree,
//! cached views inside it included.
//!
//! So only the panel is cached here: nothing inside it changes on its own. The sidebar and the Chat column
//! are plain children, because things inside them change all the time (a spinner turns in a sidebar row,
//! the composer takes a key) and a cached container would then rebuild everything under it. Their renders
//! stay cheap instead: the sidebar's rows, the transcript and the running row are cached leaves inside them.

pub mod chat;
pub mod chrome;
pub mod panel;
pub mod sidebar;

#[cfg(test)]
mod tests;

use gpui::{AnyView, Context, Entity, StyleRefinement, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, Theme};
use crate::workspace::chat::ChatView;
use crate::workspace::panel::{PANEL_WIDTH, Panel};
use crate::workspace::sidebar::Sidebar;

pub struct Workspace {
    pub sidebar: Entity<Sidebar>,
    pub chat: Entity<ChatView>,
    pub panel: Entity<Panel>,
}

impl Workspace {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self { sidebar: cx.new(Sidebar::new), chat: cx.new(ChatView::new), panel: cx.new(Panel::new) }
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .child(self.sidebar.clone())
            .child(hairline(theme))
            .child(self.chat.clone())
            .child(hairline(theme))
            // A cached view is laid out from this style alone, before it renders: it must say its size.
            .child(AnyView::from(self.panel.clone()).cached(StyleRefinement::default().flex_none().w(px(PANEL_WIDTH)).h_full()))
    }
}

fn hairline(theme: &Theme) -> impl IntoElement + use<> {
    div().flex_none().w(px(1.0)).h_full().bg(theme.line)
}
