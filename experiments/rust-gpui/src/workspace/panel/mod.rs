//! Side panel column: the tab strip (`ui::Tab` in a horizontally scrolling list, expand and close pinned
//! at the right) and an empty body.

#[cfg(test)]
mod tests;

use gpui::{ClickEvent, Context, ScrollHandle, Window, div, prelude::*, px};

use crate::theme::ActiveTheme;
use crate::ui::{IconButton, IconButtonSize, IconName, IconSize, Tab};
use crate::workspace::chrome::{self, NoDrag};

pub const PANEL_WIDTH: f32 = 518.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelTab {
    Changes,
    Terminal,
    Browser,
    Designs,
    Artifact,
    Pr,
}

impl PanelTab {
    pub const ALL: [PanelTab; 6] =
        [PanelTab::Changes, PanelTab::Terminal, PanelTab::Browser, PanelTab::Designs, PanelTab::Artifact, PanelTab::Pr];

    pub fn label(self) -> &'static str {
        match self {
            PanelTab::Changes => "Changes",
            PanelTab::Terminal => "Terminal",
            PanelTab::Browser => "Browser",
            PanelTab::Designs => "Designs",
            PanelTab::Artifact => "Artifact",
            PanelTab::Pr => "PR",
        }
    }

    /// The desktop's tab glyphs (`agents/PanelToggles.tsx`).
    pub fn icon(self) -> IconName {
        match self {
            PanelTab::Changes => IconName::FileDiff,
            PanelTab::Terminal => IconName::ComputerTerminal01,
            PanelTab::Browser => IconName::Globe02,
            PanelTab::Designs => IconName::PaintBoard,
            PanelTab::Artifact => IconName::File01,
            PanelTab::Pr => IconName::GitPullRequest,
        }
    }
}

pub struct Panel {
    active: PanelTab,
    /// Horizontal scroll of the tab list; also used to bring a clicked tab fully into view.
    tabs_scroll: ScrollHandle,
}

impl Panel {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self { active: PanelTab::Changes, tabs_scroll: ScrollHandle::new() }
    }

    pub fn active(&self) -> PanelTab {
        self.active
    }

    pub fn tabs_scroll(&self) -> &ScrollHandle {
        &self.tabs_scroll
    }

    fn activate(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
        let ix = PanelTab::ALL.iter().position(|t| *t == tab).unwrap_or(0);
        // Applied while the list paints next frame: scrolls the least needed to show the tab fully.
        self.tabs_scroll.scroll_to_item(ix);
        cx.notify();
        self.active = tab;
    }
}

impl Render for Panel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let tabs = PanelTab::ALL.map(|tab| {
            Tab::new(tab.label(), tab.label())
                .selector(format!("panel-tab-{}", tab.label()))
                .icon(tab.icon())
                .active(tab == self.active)
                .when(tab == PanelTab::Changes, |el| el.count("4"))
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.activate(tab, cx)))
        });
        // Expand and close: 24px buttons with 16px glyphs, pinned right of the scrolling tabs.
        let button = |id: &'static str, icon: IconName| {
            div().flex_none().no_drag().child(IconButton::new(id, icon).size(IconButtonSize::S24).glyph(IconSize::S16))
        };
        let tab_list = div()
            .id("panel-tab-list")
            .debug_selector(|| "panel-tab-list".to_string())
            .flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .items_center()
            .gap(px(2.0))
            .overflow_x_scroll()
            .track_scroll(&self.tabs_scroll)
            .children(tabs);
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(PANEL_WIDTH))
            .h_full()
            .bg(theme.canvas)
            .child(
                chrome::header("panel-tabs")
                    .px_2()
                    .gap_1()
                    .child(tab_list)
                    .child(button("panel-expand", IconName::ArrowExpand01))
                    .child(button("panel-close", IconName::Cancel01)),
            )
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            // The active tab's content goes here.
            .child(div().id("panel-body").flex_1().min_h_0())
    }
}
