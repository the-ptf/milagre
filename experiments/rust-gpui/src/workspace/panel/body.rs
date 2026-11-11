//! The bodies of the tabs that have no port yet (Terminal, Browser, Designs, Artifact): one small view
//! each, so a tab's content is always its own cached view and never part of the panel's render.

use gpui::{Context, Window, div, prelude::*};

use super::PanelTab;
use crate::theme::ActiveTheme;
use crate::ui::{EmptySize, EmptyState};

/// What a tab says until its package lands (WP-33 Terminal, WP-35 Browser, WP-36 Designs, WP-37 Artifacts).
pub struct TabPlaceholder {
    tab: PanelTab,
    renders: usize,
}

impl TabPlaceholder {
    pub fn new(tab: PanelTab) -> Self {
        Self { tab, renders: 0 }
    }

    pub fn renders(&self) -> usize {
        self.renders
    }
}

impl Render for TabPlaceholder {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let theme = *cx.theme();
        div()
            .id(("panel-tab-body", self.tab as usize))
            .debug_selector({
                let name = format!("panel-body-{}", self.tab.label());
                move || name.clone()
            })
            .size_full()
            .text_color(theme.ink)
            .child(EmptyState::new().size(EmptySize::Panel).icon(self.tab.icon()).title(self.tab.label()).help("Not ported yet."))
    }
}
