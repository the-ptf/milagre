//! Root view: three flush, full-height columns separated by 1px hairlines.
//!
//! Each column is its own entity with its own `Render` impl, so one can change and re-render without
//! touching the others (`cx.notify()` in the panel re-renders the panel only).

use gpui::{Context, Entity, Window, div, prelude::*, px};

use crate::chat::ChatView;
use crate::panel::Panel;
use crate::sidebar::Sidebar;
use crate::theme::{ActiveTheme, Theme};

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
            .child(self.panel.clone())
    }
}

fn hairline(theme: &Theme) -> impl IntoElement + use<> {
    div().flex_none().w(px(1.0)).h_full().bg(theme.line)
}
