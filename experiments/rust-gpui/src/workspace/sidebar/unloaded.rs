//! Projects the data layer knows but has not loaded, by name only (the live app on Milagre's Node daemon: a Project
//! Electron has not opened this run). A row is the Project's name; clicking it asks the data layer to load it
//! ([`super::SidebarEvent::OpenProject`]), after which its Chats join the list and the row goes. The fixture has none,
//! so the section is not drawn there.

use std::rc::Rc;

use gpui::{App, FontWeight, SharedString, Window, div, prelude::*, px};

use crate::theme::{TEXT_12, TEXT_13, TextStepExt, Theme, sidebar_step};
use crate::ui::{Icon, IconName, IconSize};

/// A row's height, and how many rows show before the section scrolls.
pub const UNLOADED_ROW: f32 = 26.0;
const MAX_ROWS: usize = 12;
const PAD: f32 = 16.0;

/// A Project shown by name only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnloadedProject {
    pub path: SharedString,
    pub name: SharedString,
    /// Asked to load; the row says so until the Project's Chats arrive.
    pub loading: bool,
}

/// A row's click handler: it gets the row's index.
pub type OnOpen = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// The section: a quiet heading and a row per Project.
pub fn section(projects: &[UnloadedProject], on_open: OnOpen, theme: &Theme) -> impl IntoElement + use<> {
    let hover = theme.hover;
    let rows = projects.iter().enumerate().map(|(ix, project)| {
        let on_open = on_open.clone();
        let loading = project.loading;
        div()
            .id(("unloaded-project", ix))
            .debug_selector(move || format!("unloaded-project-{ix}"))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .h(px(UNLOADED_ROW))
            .px(px(PAD))
            .when(!loading, |el| el.cursor_pointer().hover(move |style| style.bg(hover)))
            .on_click(move |_, window, cx| {
                if !loading {
                    on_open(ix, window, cx)
                }
            })
            .child(Icon::new(IconName::Folder01).size(IconSize::S14).color(theme.ink4))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_step(sidebar_step(TEXT_13))
                    .text_color(if loading { theme.ink4 } else { theme.ink2 })
                    .child(project.name.clone()),
            )
            .when(loading, |el| el.child(div().text_step(sidebar_step(TEXT_12)).text_color(theme.ink4).child("Loading…")))
    });
    let height = UNLOADED_ROW * projects.len().min(MAX_ROWS) as f32;
    div()
        .id("sidebar-unloaded")
        .debug_selector(|| "sidebar-unloaded".into())
        .flex()
        .flex_col()
        .flex_none()
        .pt(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .h(px(24.0))
                .px(px(PAD))
                .text_step(sidebar_step(TEXT_12))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink3)
                .child("Not loaded"),
        )
        .child(div().id("sidebar-unloaded-rows").flex().flex_col().h(px(height)).overflow_y_scroll().children(rows))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{Modifiers, TestAppContext};

    use super::UnloadedProject;
    use crate::testing;
    use crate::workspace::sidebar::SidebarEvent;

    #[gpui::test]
    fn name_only_projects_ask_to_load_when_clicked(cx: &mut TestAppContext) {
        let (workspace, cx) = testing::mount_workspace(cx);
        let sidebar = workspace.read_with(cx, |w, _| w.sidebar.clone());
        assert!(cx.debug_bounds("sidebar-unloaded").is_none(), "the fixture has no unloaded Projects");
        let project =
            |path: &str, name: &str| UnloadedProject { path: path.to_owned().into(), name: name.to_owned().into(), loading: false };
        sidebar.update(cx, |s, cx| s.set_unloaded_projects(vec![project("/p/one", "one"), project("/p/two", "two")], cx));
        cx.run_until_parked();
        assert!(cx.debug_bounds("sidebar-unloaded").is_some());
        let opened = Rc::new(RefCell::new(Vec::new()));
        let seen = opened.clone();
        let _subscription = cx.update(|_, cx| {
            cx.subscribe(&sidebar, move |_, event: &SidebarEvent, _| {
                if let SidebarEvent::OpenProject(path) = event {
                    seen.borrow_mut().push(path.to_string());
                }
            })
        });
        let row = cx.debug_bounds("unloaded-project-1").expect("the second row is drawn");
        cx.simulate_click(row.center(), Modifiers::none());
        cx.run_until_parked();
        assert_eq!(*opened.borrow(), ["/p/two"]);
        assert!(sidebar.read_with(cx, |s, _| s.unloaded_projects()[1].loading), "it shows as loading");
        // A loading row asks once.
        let row = cx.debug_bounds("unloaded-project-1").expect("still drawn");
        cx.simulate_click(row.center(), Modifiers::none());
        cx.run_until_parked();
        assert_eq!(opened.borrow().len(), 1);
    }
}
