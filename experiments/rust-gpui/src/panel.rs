//! Side panel column: the tab strip and an empty body.

use gpui::{ClickEvent, Context, FontWeight, Window, div, prelude::*, px};

use crate::chrome;
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, StyledText, TEXT_12};

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
}

pub struct Panel {
    active: PanelTab,
}

impl Panel {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self { active: PanelTab::Changes }
    }

    pub fn active(&self) -> PanelTab {
        self.active
    }

    fn activate(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
        if self.active != tab {
            self.active = tab;
            cx.notify();
        }
    }
}

impl Render for Panel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let tabs = PanelTab::ALL.map(|tab| {
            let active = tab == self.active;
            let hover = theme.hover;
            div()
                .id(tab.label())
                .debug_selector(move || format!("panel-tab-{}", tab.label()))
                .flex()
                .flex_none()
                .items_center()
                .h(CONTROL_SM)
                .px(px(10.0))
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
                .child(tab.label())
        });
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(PANEL_WIDTH))
            .h_full()
            .bg(theme.canvas)
            .child(chrome::header("panel-tabs").px_2().gap_1().children(tabs))
            .child(div().flex_none().h(px(1.0)).bg(theme.line))
            // The active tab's content goes here.
            .child(div().id("panel-body").flex_1().min_h_0())
    }
}
