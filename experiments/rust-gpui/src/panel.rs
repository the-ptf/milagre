//! Side panel column: the tab strip and an empty body.

use gpui::{ClickEvent, Context, FontWeight, ScrollHandle, Window, div, prelude::*, px};

use crate::chrome;
use crate::icons::{PanelIcon, icon};
use crate::theme::{ActiveTheme, CONTROL_SM, CONTROL_XS, RADIUS_CONTROL, StyledText, TEXT_12};

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

    pub fn icon(self) -> PanelIcon {
        match self {
            PanelTab::Changes => PanelIcon::FileDiff,
            PanelTab::Terminal => PanelIcon::Terminal,
            PanelTab::Browser => PanelIcon::Globe,
            PanelTab::Designs => PanelIcon::Palette,
            PanelTab::Artifact => PanelIcon::FileText,
            PanelTab::Pr => PanelIcon::PullRequest,
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
            let active = tab == self.active;
            let hover = theme.hover;
            let color = if active { theme.ink } else { theme.ink3 };
            div()
                .id(tab.label())
                .debug_selector(move || format!("panel-tab-{}", tab.label()))
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.0))
                .h(CONTROL_SM)
                .px(px(6.0))
                .rounded(RADIUS_CONTROL)
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .when(active, |el| el.bg(theme.hover2).text_color(theme.ink))
                .when(!active, |el| el.text_color(theme.ink3).hover(move |style| style.bg(hover)))
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    // Keep a double-click on a tab from reaching the header's zoom handler.
                    cx.stop_propagation();
                    this.activate(tab, cx);
                }))
                .child(div().debug_selector(move || format!("panel-tab-icon-{}", tab.label())).child(icon(tab.icon(), 14.0, 1.8, color)))
                .child(
                    div()
                        .flex()
                        .gap(px(4.0))
                        .child(tab.label())
                        .when(tab == PanelTab::Changes, |el| el.child(div().text_color(theme.ink3).child("4"))),
                )
        });
        let button = |id: &'static str, kind: PanelIcon| {
            let hover = theme.hover;
            div()
                .id(id)
                .debug_selector(move || id.to_string())
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(CONTROL_XS)
                .rounded(RADIUS_CONTROL)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(icon(kind, 16.0, 1.5, theme.ink3))
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
                    .child(button("panel-expand", PanelIcon::Expand))
                    .child(button("panel-close", PanelIcon::Close)),
            )
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            // The active tab's content goes here.
            .child(div().id("panel-body").flex_1().min_h_0())
    }
}
