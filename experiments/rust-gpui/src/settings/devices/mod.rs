//! Phone & sharing, This Mac, Worktrees and paired Computer pages of Settings (WP-44: the Devices, computers and storage
//! half; `Settings.tsx` `DevicesSettings`, `ThisMacPage`, `WorktreesSettings`, `ComputerSettings`,
//! `settings/{ComputerResources,ComputerUseSettings,SimlockSettings,HostUpdateRow,WorktreeCleanup}.tsx`; G-17, G-19,
//! G-20, G-21).
//!
//! - `logic.rs`: the rules ported from `packages/shared` and `lib/*`: gauges, storage words, device and phone lines.
//! - `model.rs`: [`DevicesStore`], the fixture the host would answer, and the actions on it. Nothing here pairs a
//!   phone, reaches a network or reads the machine.
//! - `view.rs`: [`DevicesView`], the entity; `phone.rs`, `mac.rs`, `computer.rs`, `worktrees.rs`: the pages;
//!   `resources.rs`: the memory and disk rows; `cleanup.rs`: the Clean up worktrees dialog; `qr.rs`: the pairing code.
//!
//! Not built: a real QR code (the `qrcode` crate is not a dependency; the page draws a fixture symbol that scans as
//! nothing), the Computer page's MCP servers section, the Published pages dialog's revoke, the indeterminate state of a
//! cleanup group's checkbox, the per-bar hover (a tooltip, shown on hover), and every refresh timer (the page reads the
//! store when it renders).

pub mod cleanup;
mod computer;
pub mod logic;
mod mac;
pub mod model;
mod phone;
mod qr;
mod resources;
pub mod view;
mod widgets;
mod worktrees;

#[cfg(test)]
mod tests;

use gpui::{AnyElement, App, Entity, IntoElement};

pub use model::DevicesStore;
pub use view::{DevicesView, MacPage, Target};

use super::{SelectedSection, SettingsSectionId};

/// Installs the fixture [`DevicesStore`] if it is not there yet. Called from [`super::init`].
pub fn init(cx: &mut App) {
    model::init(cx);
}

/// Snapshot aid: `MILAGRE_GPUI_SETTINGS=computer:<id or position>` or `project:<name>` opens a Computer or Project page,
/// which `SettingsSectionId::parse` cannot name.
pub fn snapshot_selection(name: &str, computers: &[(String, String, bool)], projects: &[(String, String)]) -> Option<SelectedSection> {
    if let Some(key) = name.strip_prefix("computer:") {
        let found = computers.iter().enumerate().find(|(ix, (id, label, _))| id == key || label == key || ix.to_string() == key);
        return found.map(|(_, (id, label, connected))| SelectedSection::Computer {
            id: id.clone(),
            name: label.clone(),
            connected: *connected,
        });
    }
    let key = name.strip_prefix("project:")?;
    let found = projects.iter().enumerate().find(|(ix, (path, label))| path == key || label == key || ix.to_string() == key);
    found.map(|(_, (path, label))| SelectedSection::Project { path: path.clone(), name: label.clone() })
}

/// The body of Phone & sharing, This Mac, Worktrees or a Computer page, or `None` for any other section. Also tells the
/// page which row a Settings search result lit up.
pub fn section_body(selected: &SelectedSection, highlighted: Option<&str>, view: &Entity<DevicesView>, cx: &mut App) -> Option<AnyElement> {
    let target = match selected {
        SelectedSection::Section(SettingsSectionId::Devices) => Target::Devices,
        SelectedSection::Section(SettingsSectionId::ThisMac) => Target::ThisMac { name: cx.global::<DevicesStore>().this_mac.clone() },
        SelectedSection::Section(SettingsSectionId::Worktrees) => Target::Worktrees,
        SelectedSection::Computer { id, .. } => Target::Computer { id: id.clone() },
        _ => return None,
    };
    view.update(cx, |view, cx| view.set_target(target, highlighted, cx));
    Some(view.clone().into_any_element())
}
