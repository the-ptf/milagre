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

use gpui::{Context, Entity, Subscription, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, Theme};
use crate::workspace::chat::ChatView;
use crate::workspace::panel::dock;
use crate::workspace::panel::{Panel, PanelEvent};
use crate::workspace::sidebar::Sidebar;

pub struct Workspace {
    pub sidebar: Entity<Sidebar>,
    pub chat: Entity<ChatView>,
    pub panel: Entity<Panel>,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        dock::install_keys(cx);
        let (sidebar, chat, panel) = (cx.new(Sidebar::new), cx.new(ChatView::new), cx.new(Panel::new));
        // The panel's place in the window changed: lay the columns out again.
        let layout = cx.subscribe(&panel, |_, _, _: &PanelEvent, cx| cx.notify());
        let follow = cx.observe(&sidebar, |this, _, cx| this.follow_sidebar(cx));
        Self { sidebar, chat, panel, _subscriptions: vec![layout, follow] }
    }

    /// A different Chat picked in the sidebar: the panel shows that Chat's tab and width. The sidebar does not
    /// notify itself on a selection (only the two rows do, and every view above them re-renders), so `render`
    /// calls this too; it is two reads when nothing changed.
    fn follow_sidebar(&mut self, cx: &mut Context<Self>) {
        let sidebar = self.sidebar.read(cx);
        let key = sidebar.selected().and_then(|ix| sidebar.row(ix)).map(|row| row.key.clone());
        if let Some(key) = key.filter(|key| self.panel.read(cx).chat() != key.as_ref()) {
            self.panel.update(cx, |panel, cx| panel.set_chat(key, cx));
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.follow_sidebar(cx);
        let theme = *cx.theme();
        let columns = dock::layout(&self.panel, self.chat.clone(), cx);
        dock::on_actions(div(), &self.panel)
            .flex()
            .flex_row()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .child(self.sidebar.clone())
            .child(hairline(&theme))
            .child(columns)
    }
}

fn hairline(theme: &Theme) -> impl IntoElement + use<> {
    div().flex_none().w(px(1.0)).h_full().bg(theme.line)
}
