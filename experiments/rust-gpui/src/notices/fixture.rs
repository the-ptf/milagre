//! The states a snapshot or a test starts the notices in. `MILAGRE_GPUI_NOTICES=<name>`:
//!
//! | Name | Shows |
//! | --- | --- |
//! | `update-downloaded` | the card: "Update available", What's new, Install & restart |
//! | `update-downloaded-auto` | the same with auto update on |
//! | `update-pill` | the pill after the card was closed |
//! | `update-downloading` | the pill with the percent; `update-downloading-card` the card with its bar |
//! | `update-installing` | "Restarting Milagre" |
//! | `update-error` | "Update failed" with Try again |
//! | `update-checking`, `update-uptodate` | the card opened from Settings |
//! | `provider`, `provider-error` | the CLI update card; the second fails the first install |
//! | `host-outdated`, `host-disconnected`, `host-failed` | the host notices |
//! | `save`, `save-offline` | a Project's unsaved changes |
//! | `toast` | the toast |
//! | `all` | the provider card, the host notice and a save failure at once |

use super::NoticesLayer;
use super::model::{AppUpdate, HostConnection, ProviderUpdate, UnsavedScope, UpdateStatus};
use crate::data::Provider;
use gpui::Context;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    UpdateDownloaded,
    UpdateDownloadedAuto,
    UpdatePill,
    UpdateDownloading,
    UpdateDownloadingCard,
    UpdateInstalling,
    UpdateError,
    UpdateChecking,
    UpdateUpToDate,
    Provider,
    ProviderError,
    HostOutdated,
    HostDisconnected,
    HostFailed,
    Save,
    SaveOffline,
    Toast,
    All,
}

impl Scenario {
    pub fn from_name(name: &str) -> Option<Scenario> {
        Some(match name {
            "update-downloaded" => Scenario::UpdateDownloaded,
            "update-downloaded-auto" => Scenario::UpdateDownloadedAuto,
            "update-pill" => Scenario::UpdatePill,
            "update-downloading" => Scenario::UpdateDownloading,
            "update-downloading-card" => Scenario::UpdateDownloadingCard,
            "update-installing" => Scenario::UpdateInstalling,
            "update-error" => Scenario::UpdateError,
            "update-checking" => Scenario::UpdateChecking,
            "update-uptodate" => Scenario::UpdateUpToDate,
            "provider" => Scenario::Provider,
            "provider-error" => Scenario::ProviderError,
            "host-outdated" => Scenario::HostOutdated,
            "host-disconnected" => Scenario::HostDisconnected,
            "host-failed" => Scenario::HostFailed,
            "save" => Scenario::Save,
            "save-offline" => Scenario::SaveOffline,
            "toast" => Scenario::Toast,
            "all" => Scenario::All,
            _ => return None,
        })
    }

    pub fn apply(self, layer: &mut NoticesLayer, cx: &mut Context<NoticesLayer>) {
        let downloaded = || AppUpdate::new(UpdateStatus::Downloaded).with_version("0.233.0");
        let update = |state: Option<AppUpdate>, layer: &mut NoticesLayer, cx: &mut Context<NoticesLayer>| {
            layer.update.update(cx, |notice, cx| notice.set_state(state, cx))
        };
        match self {
            Scenario::UpdateDownloaded => update(Some(downloaded()), layer, cx),
            Scenario::UpdateDownloadedAuto => update(Some(AppUpdate { auto: true, ..downloaded() }), layer, cx),
            Scenario::UpdatePill => {
                update(Some(downloaded()), layer, cx);
                layer.update.update(cx, |notice, cx| notice.close(cx));
            }
            Scenario::UpdateDownloading => {
                update(Some(AppUpdate { progress: 42.0, ..AppUpdate::new(UpdateStatus::Downloading).with_version("0.233.0") }), layer, cx)
            }
            Scenario::UpdateDownloadingCard => {
                update(Some(AppUpdate { progress: 42.0, ..AppUpdate::new(UpdateStatus::Downloading).with_version("0.233.0") }), layer, cx);
                layer.update.update(cx, |notice, _| notice.open_without_focus());
            }
            Scenario::UpdateInstalling => update(Some(AppUpdate::new(UpdateStatus::Installing).with_version("0.233.0")), layer, cx),
            Scenario::UpdateError => update(
                Some(AppUpdate {
                    error: Some("Couldn\u{2019}t download the update. Check your connection.".into()),
                    ..AppUpdate::new(UpdateStatus::Error).with_version("0.233.0")
                }),
                layer,
                cx,
            ),
            Scenario::UpdateChecking => {
                update(Some(AppUpdate::new(UpdateStatus::Checking)), layer, cx);
                layer.update.update(cx, |notice, _| notice.open_without_focus());
            }
            Scenario::UpdateUpToDate => {
                update(Some(AppUpdate::new(UpdateStatus::UpToDate)), layer, cx);
                layer.update.update(cx, |notice, _| notice.open_without_focus());
            }
            Scenario::Provider | Scenario::ProviderError => layer.provider.update(cx, |notice, cx| {
                notice.set_updates(
                    vec![
                        ProviderUpdate { provider: Provider::Claude, version: "2.1.140".into() },
                        ProviderUpdate { provider: Provider::Codex, version: "0.131.0".into() },
                    ],
                    cx,
                );
                if self == Scenario::ProviderError {
                    notice.fail_first_install();
                }
            }),
            Scenario::HostOutdated => layer
                .host
                .update(cx, |notices, cx| notices.set_connection(HostConnection { host_outdated: true, ..HostConnection::online() }, cx)),
            Scenario::HostDisconnected => layer
                .host
                .update(cx, |notices, cx| notices.set_connection(HostConnection { connected: false, ..HostConnection::online() }, cx)),
            Scenario::HostFailed => layer.host.update(cx, |notices, cx| {
                notices.set_connection(
                    HostConnection {
                        connected: false,
                        failed: true,
                        host_outdated: false,
                        message: Some("The host did not answer in time.".into()),
                    },
                    cx,
                )
            }),
            Scenario::Save => layer.host.update(cx, |notices, cx| notices.set_saves(vec![save("happiergym", false)], cx)),
            Scenario::SaveOffline => layer.host.update(cx, |notices, cx| notices.set_saves(vec![save("happiergym", true)], cx)),
            Scenario::Toast => layer.show_toast("Opened in Zed", cx),
            Scenario::All => {
                Scenario::Provider.apply(layer, cx);
                Scenario::HostOutdated.apply(layer, cx);
                layer.host.update(cx, |notices, cx| notices.set_saves(vec![save("happiergym", false)], cx));
            }
        }
    }
}

/// A Project that could not save: the disk was full.
pub fn save(name: &str, offline: bool) -> UnsavedScope {
    UnsavedScope {
        scope: format!("/Users/me/Code/{name}"),
        name: name.to_string(),
        error: "ENOSPC: no space left on device".into(),
        code: Some("ENOSPC".into()),
        saving: false,
        offline,
    }
}
