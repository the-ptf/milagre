//! Settings › Keybindings (WP-41, `KeybindingsSettings.tsx`; G-09). Voice (G-07) is not ported: the desktop's Voice page
//! holds only dictation, which Victor left out of the port (PORT-MAP), so its sidebar entry stays the WP-41 stand-in.
//!
//! - `logic.rs`: ownership of rules, key capture, edits, search and the `when` checks (pure).
//! - `model.rs`: [`KeybindingsStore`], each computer's keybindings.json as its host answers.
//! - `view.rs`: [`KeybindingsView`], the page.

pub mod logic;
pub mod model;
pub mod view;

#[cfg(test)]
mod tests;

use gpui::{AnyElement, App, Entity, IntoElement};

pub use model::KeybindingsStore;
pub use view::KeybindingsView;

use super::{SelectedSection, SettingsSectionId};

/// Installs the fixture [`KeybindingsStore`] if it is not there yet. Called from [`super::init`].
pub fn init(cx: &mut App) {
    model::init(cx);
}

/// The Keybindings page, or `None` for any other section. Also tells it the computers and the row a Settings search
/// result lit up.
pub fn section_body(
    selected: &SelectedSection,
    highlighted: Option<&str>,
    this_mac: &str,
    computers: &[(String, String, bool)],
    view: &Entity<KeybindingsView>,
    cx: &mut App,
) -> Option<AnyElement> {
    if *selected != SelectedSection::Section(SettingsSectionId::Keybindings) {
        return None;
    }
    view.update(cx, |view, cx| view.set_context(this_mac, computers, highlighted, cx));
    Some(view.clone().into_any_element())
}
