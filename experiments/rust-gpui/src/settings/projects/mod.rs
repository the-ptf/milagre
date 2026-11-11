//! A Project's Settings page (WP-44: the Project half; `Settings.tsx` `ProjectSettings`, `ProjectIconSetting`,
//! `ShowInSidebarSetting`, `MainSyncSetting`, `FilesToCopy`, `SetupCommand`, `ProjectGitSettings.tsx`; G-22).
//!
//! - `logic.rs`: the Branches rules from `packages/shared/src/branch-policy.mjs`, the Files to copy matching and
//!   sentence, the icon size rule and the autosave debounce.
//! - `model.rs`: [`ProjectsStore`], one fixture entry per Project path and the saves that change it.
//! - `view.rs`: [`ProjectView`], the page.

pub mod logic;
pub mod model;
pub mod view;

#[cfg(test)]
mod tests;

use gpui::{AnyElement, App, Entity, IntoElement};

pub use model::ProjectsStore;
pub use view::ProjectView;

use super::SelectedSection;

/// Installs the fixture [`ProjectsStore`] if it is not there yet. Called from [`super::init`].
pub fn init(cx: &mut App) {
    model::init(cx);
}

/// The body of a Project's page, or `None` for any other section. Also tells the page which row a Settings search
/// result lit up.
pub fn section_body(selected: &SelectedSection, highlighted: Option<&str>, view: &Entity<ProjectView>, cx: &mut App) -> Option<AnyElement> {
    let SelectedSection::Project { path, name } = selected else { return None };
    view.update(cx, |view, cx| view.set_target(path, name, highlighted, cx));
    Some(view.clone().into_any_element())
}
