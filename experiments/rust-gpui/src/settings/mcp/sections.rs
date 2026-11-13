//! The section bodies this package gives Settings: MCP servers (with Milagre MCP under it), Skills and
//! Integrations. `settings/mod.rs` owns one [`ToolSections`] and asks [`section_body`] for the selected section.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled, Window, div, prelude::*, px,
};

use super::local::LocalMcpView;
use super::page::McpView;
use crate::settings::integrations::IntegrationsView;
use crate::settings::skills::SkillsView;
use crate::settings::skills::model::PROJECT_PATH;
use crate::settings::{SelectedSection, SettingsSectionId};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TextStepExt};

/// Settings › MCP: the servers, then the Milagre MCP heading and its clients.
pub struct McpPage {
    pub servers: Entity<McpView>,
    pub local: Entity<LocalMcpView>,
    found: Option<String>,
}

impl McpPage {
    fn new(cx: &mut Context<Self>) -> Self {
        Self { servers: cx.new(McpView::new), local: cx.new(LocalMcpView::new), found: None }
    }
}

impl Render for McpPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let found = self.found.as_deref() == Some("Milagre MCP");
        div()
            .flex()
            .flex_col()
            .child(self.servers.clone())
            .child(
                div().mt(px(32.0)).px(px(4.0)).child(
                    div()
                        .debug_selector(|| "mcp-local-heading".into())
                        .rounded(RADIUS_CONTROL)
                        .when(found, |d| d.bg(theme.hover2))
                        .text_step(TEXT_12)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink3)
                        .child("Milagre MCP"),
                ),
            )
            .child(self.local.clone())
    }
}

/// The views behind the sections of this package, created once with the Settings dialog.
pub struct ToolSections {
    pub mcp: Entity<McpPage>,
    pub skills: Entity<SkillsView>,
    pub integrations: Entity<IntegrationsView>,
}

impl ToolSections {
    pub fn new(cx: &mut App) -> Self {
        Self { mcp: cx.new(McpPage::new), skills: cx.new(SkillsView::new), integrations: cx.new(IntegrationsView::new) }
    }
}

/// The body of the MCP, Skills or Integrations section, or `None` for any other. Also tells the page which row a
/// search result lit up.
pub fn section_body(
    selected: &SelectedSection,
    highlighted: Option<&str>,
    projects: &[(String, String)],
    views: &ToolSections,
    cx: &mut App,
) -> Option<AnyElement> {
    match selected {
        SelectedSection::Section(SettingsSectionId::Mcp) => {
            views.mcp.update(cx, |page, cx| {
                page.found = highlighted.map(str::to_string);
                let local = page.local.clone();
                let servers = page.servers.clone();
                local.update(cx, |view, cx| view.set_found(highlighted, cx));
                servers.update(cx, |view, cx| view.set_found(highlighted, cx));
                cx.notify();
            });
            Some(views.mcp.clone().into_any_element())
        }
        SelectedSection::Section(SettingsSectionId::Skills) => {
            // The open Project: a data layer's ([`crate::settings::host::project`]), else the fixture's, else the first
            // the sidebar lists.
            let project = if cx.has_global::<crate::settings::host::SettingsHost>() {
                crate::settings::host::project(cx)
            } else {
                projects
                    .iter()
                    .find(|(path, _)| path == PROJECT_PATH)
                    .or_else(|| projects.first())
                    .cloned()
                    .or_else(|| Some((PROJECT_PATH.to_string(), "milagre-ade".to_string())))
            };
            views.skills.update(cx, |view, cx| {
                view.set_project(project, cx);
                view.visit(cx);
                view.set_found(highlighted, cx);
            });
            Some(views.skills.clone().into_any_element())
        }
        SelectedSection::Section(SettingsSectionId::Connections) => {
            views.integrations.update(cx, |view, cx| {
                view.visit(cx);
                view.set_found(highlighted, cx);
            });
            Some(views.integrations.clone().into_any_element())
        }
        _ => None,
    }
}
