//! Phone & sharing and This Mac on a data layer's host ([`crate::settings::host::SettingsHost`]), with the commands
//! Electron's `DevicesSettings` and `DeviceResources` send:
//!
//! | What | Read | Write |
//! | --- | --- | --- |
//! | Allow devices to connect, on local network | `phone:status []` | `phone:set-enabled [bool]`, `phone:set-lan [bool]` |
//! | The pairing code | `phone:status []` (`qrSvg`, `pairingOptions`) | `phone:open-pairing []` when the code shows, Allow pairing again |
//! | Paired devices | `devices:list []`, every 15 s while the page shows | `devices:remove [key]`, `devices:acknowledge [keys]` |
//! | Reset access | | `phone:reset []` |
//! | This Mac's memory and disk | `computer:resources:read []` (again while the disk is measured) | |
//!
//! Each answer replaces what [`DevicesStore`] holds; a refused action says why under the access rows. Without a host
//! every action changes the fixture store, as before.

use std::time::Duration;

use gpui::{App, AsyncApp, BorrowAppContext as _};
use serde_json::{Value, json};

use super::logic::{
    ComputerResources, DeviceKind, DiskResources, Lan, MemoryResources, PairedDevice, PairingOption, Part, PartKind, PhoneState,
    PhoneStatus, RelayLink, Remote, Route,
};
use super::model::DevicesStore;
use crate::settings::host;

/// How often the paired devices are read again while Phone & sharing shows (`usePairedDevices`).
pub const DEVICES_EVERY: Duration = Duration::from_secs(15);
/// How soon This Mac's disk is read again while its folders are being measured.
pub const MEASURING_EVERY: Duration = Duration::from_secs(3);

/// The pairing code as the host drew it: the QR (an SVG) and link of each way to pair, and the plain ones.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pairing {
    pub qr_svg: Option<String>,
    pub pairing_link: Option<String>,
    pub computer_link: Option<String>,
    /// `pairingOptions`: id, link and QR.
    pub options: Vec<(String, String, Option<String>)>,
}

impl Pairing {
    /// The QR and the link Copy link copies for the chosen way to pair (the first when it is gone), as Electron picks
    /// them: the option's, else the status's.
    pub fn chosen(&self, route: &str) -> (Option<&str>, Option<&str>) {
        let option = self.options.iter().find(|(id, _, _)| id == route).or_else(|| self.options.first());
        let svg = option.and_then(|(_, _, svg)| svg.as_deref()).or(self.qr_svg.as_deref());
        let link = option.map(|(_, link, _)| link.as_str()).or(self.computer_link.as_deref()).or(self.pairing_link.as_deref());
        (svg, link)
    }
}

/// What the pages keep of the host besides the store's own fields.
#[derive(Clone, Debug, Default)]
pub struct Hosted {
    /// A data layer backs the pages (set the first time one reads).
    pub on: bool,
    pub phone_read: bool,
    /// `phone:status` failed: said under Allow devices to connect.
    pub load_error: Option<String>,
    /// An action the host refused, said under the access rows.
    pub action_error: Option<String>,
    pub devices_read: bool,
    pub devices_error: Option<String>,
    /// An action waits for its answer: the access controls are off meanwhile.
    pub busy: bool,
    pub pairing: Pairing,
    /// The host's visit the pairing window was opened for (once per visit, as Electron opens it when the code shows).
    pub opened_for: Option<u64>,
}

fn host_of(url: &str, keep_port: bool) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = if keep_port { authority } else { authority.rsplit_once(':').map_or(authority, |(host, _)| host) };
    (!host.is_empty()).then(|| host.to_string())
}

/// `phone:status`'s answer (`PhoneStatus`) as the page reads it, and its pairing code.
pub fn phone_status(value: &Value) -> (PhoneStatus, Pairing) {
    let text = |key: &str| value[key].as_str().map(str::to_string);
    let state = match value["state"].as_str() {
        Some("starting") => PhoneState::Starting,
        Some("on") => PhoneState::On,
        Some("error") => PhoneState::Error,
        _ => PhoneState::Off,
    };
    let remote = match value["remote"].as_str() {
        Some("cloudflare") => Remote::Cloudflare,
        Some("relay") => Remote::Relay,
        _ => Remote::None,
    };
    let relay = match value["relay"].as_str() {
        Some("connecting") => Some(RelayLink::Connecting),
        Some("online") => Some(RelayLink::Online),
        Some("offline") => Some(RelayLink::Offline),
        _ => None,
    };
    let options: Vec<&Value> = value["pairingOptions"].as_array().map(|list| list.iter().collect()).unwrap_or_default();
    let lan = value["lan"].is_object().then(|| Lan {
        enabled: value["lan"]["enabled"] == true,
        addresses: value["lan"]["addresses"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect(),
        error: value["lan"]["error"].as_str().map(str::to_string),
    });
    let status = PhoneStatus {
        enabled: value["enabled"] == true,
        state,
        error: text("error"),
        remote,
        relay,
        pairing_until: value["pairingUntil"].as_f64().map(|at| at as i64),
        local_host: text("localUrl").and_then(|url| host_of(&url, false)).unwrap_or_else(|| "127.0.0.1".into()),
        public_host: text("publicUrl").and_then(|url| host_of(&url, true)),
        // The page shows the code only when there is one to scan.
        pairing_link: if value["qrSvg"].is_string() { text("pairingLink").unwrap_or_default() } else { String::new() },
        pairing_options: options
            .iter()
            .filter_map(|o| {
                Some(PairingOption { id: o["id"].as_str()?.to_string(), label: o["label"].as_str().unwrap_or_default().to_string() })
            })
            .collect(),
        lan,
    };
    let pairing = Pairing {
        qr_svg: text("qrSvg"),
        pairing_link: text("pairingLink"),
        computer_link: text("computerLink"),
        options: options
            .iter()
            .filter_map(|o| {
                Some((
                    o["id"].as_str()?.to_string(),
                    o["link"].as_str().unwrap_or_default().to_string(),
                    o["qrSvg"].as_str().map(str::to_string),
                ))
            })
            .collect(),
    };
    (status, pairing)
}

/// `devices:list`'s answer (`PairedDevice[]`).
pub fn paired_devices(value: &Value) -> Vec<PairedDevice> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(PairedDevice {
                key: item["key"].as_str()?.to_string(),
                kind: if item["kind"] == "computer" { DeviceKind::Computer } else { DeviceKind::Phone },
                name: item["name"].as_str().map(str::to_string),
                last_seen: item["lastSeen"].as_f64().map(|at| at as i64),
                is_new: item["isNew"] == true,
                route: match item["route"].as_str() {
                    Some("lan") => Some(Route::Lan),
                    Some("relay") => Some(Route::Relay),
                    _ => None,
                },
            })
        })
        .collect()
}

fn part_kind(kind: &str) -> PartKind {
    match kind {
        "claude" => PartKind::Claude,
        "codex" => PartKind::Codex,
        "antigravity" => PartKind::Antigravity,
        "kiro" => PartKind::Kiro,
        "terminals" => PartKind::Terminals,
        "app" => PartKind::App,
        "worktrees" => PartKind::Worktrees,
        "chats" => PartKind::Chats,
        "checkpoints" => PartKind::Checkpoints,
        "agents" => PartKind::Agents,
        "browser" => PartKind::Browser,
        "designs" => PartKind::Designs,
        "caches" => PartKind::Caches,
        _ => PartKind::Data,
    }
}

fn parts(value: &Value) -> Vec<Part> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            Some(Part {
                kind: part_kind(part["kind"].as_str()?),
                bytes: part["bytes"].as_f64()?,
                count: part["count"].as_u64().unwrap_or(0) as usize,
            })
        })
        .collect()
}

/// `computer:resources:read`'s answer (`ComputerResources`).
pub fn resources(value: &Value) -> Option<ComputerResources> {
    let memory = &value["memory"];
    let disk = &value["disk"];
    Some(ComputerResources {
        memory: MemoryResources {
            total: memory["total"].as_f64()?,
            available: memory["available"].as_f64()?,
            milagre: memory["milagre"].as_f64(),
            parts: parts(&memory["parts"]),
        },
        disk: disk.is_object().then(|| DiskResources {
            total: disk["total"].as_f64().unwrap_or(0.0),
            available: disk["available"].as_f64().unwrap_or(0.0),
            milagre: disk["milagre"].as_f64(),
            parts: parts(&disk["parts"]),
            measuring: disk["measuring"] == true,
        }),
    })
}

/// Whether a data layer backs Phone & sharing and This Mac.
pub fn hosted(cx: &App) -> bool {
    host::host(cx).is_some()
}

fn store(cx: &mut App, f: impl FnOnce(&mut DevicesStore)) {
    cx.update_global::<DevicesStore, _>(|store, _| f(store));
}

fn store_async(cx: &mut AsyncApp, f: impl FnOnce(&mut DevicesStore)) {
    cx.update(|cx| store(cx, f));
}

/// Shows a phone status the host answered.
fn show_status(value: &Value, cx: &mut App) {
    let (status, pairing) = phone_status(value);
    store(cx, |s| {
        s.phone = status;
        s.hosted.pairing = pairing;
        s.hosted.phone_read = true;
        s.hosted.load_error = None;
        if !s.phone.pairing_options.iter().any(|o| o.id == s.pairing_route)
            && let Some(first) = s.phone.pairing_options.first()
        {
            s.pairing_route = first.id.clone();
        }
    });
}

/// Phone & sharing shows: the status and the devices, the devices again every [`DEVICES_EVERY`] while it shows in this
/// visit, and the pairing window opened once the code shows.
pub fn read_devices_page(visit: u64, cx: &mut App) {
    store(cx, |s| s.hosted.on = true);
    read_phone(Some(visit), cx);
    read_devices(cx);
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(DEVICES_EVERY).await;
            let shown = cx.update(|cx| host::visit(cx) == Some(visit));
            if !shown {
                break;
            }
            cx.update(read_devices);
        }
    })
    .detach();
}

fn read_phone(visit: Option<u64>, cx: &mut App) {
    let Some(task) = host::call("phone:status", json!([]), cx) else { return };
    cx.spawn(async move |cx| {
        let answer = task.await;
        cx.update(|cx| match answer {
            Ok(value) => {
                show_status(&value, cx);
                if let Some(visit) = visit {
                    open_pairing_once(visit, cx);
                }
            }
            Err(error) => store(cx, |s| s.hosted.load_error = Some(format!("Couldn't read device access: {error}"))),
        });
    })
    .detach();
}

/// Showing the code is what invites a new device to pair, so it opens the pairing window (`phone:open-pairing`).
fn open_pairing_once(visit: u64, cx: &mut App) {
    let s = cx.global::<DevicesStore>();
    let showing = s.phone.state == PhoneState::On && s.hosted.pairing.qr_svg.is_some() && s.phone.pairing_until.is_some();
    if !showing || s.hosted.opened_for == Some(visit) || host::host(cx).is_some_and(|h| h.read_only) {
        return;
    }
    store(cx, |s| s.hosted.opened_for = Some(visit));
    let Some(task) = host::call("phone:open-pairing", json!([]), cx) else { return };
    cx.spawn(async move |cx| {
        if let Ok(value) = task.await {
            cx.update(|cx| show_status(&value, cx));
        }
    })
    .detach();
}

/// `devices:list`; the devices new since the owner last looked stay marked New this visit, and the host hears at once
/// that they were shown (`devices:acknowledge`).
pub fn read_devices(cx: &mut App) {
    let Some(task) = host::call("devices:list", json!([]), cx) else { return };
    cx.spawn(async move |cx| {
        let answer = task.await;
        cx.update(|cx| match answer {
            Ok(value) => show_devices(&value, cx),
            Err(error) => store(cx, |s| s.hosted.devices_error = Some(format!("Couldn't read paired devices: {error}"))),
        });
    })
    .detach();
}

fn show_devices(value: &Value, cx: &mut App) {
    let devices = paired_devices(value);
    let fresh: Vec<String> = devices.iter().filter(|d| d.is_new).map(|d| d.key.clone()).collect();
    store(cx, |s| {
        s.devices = devices;
        s.hosted.devices_read = true;
        s.hosted.devices_error = None;
        s.fresh.extend(fresh.iter().cloned());
    });
    if !fresh.is_empty()
        && !host::host(cx).is_some_and(|h| h.read_only)
        && let Some(task) = host::call("devices:acknowledge", json!([fresh]), cx)
    {
        task.detach();
    }
}

/// An access action: the answer is the new phone status; a refusal is said under the access rows.
fn phone_action(method: &'static str, args: Value, cx: &mut App) {
    if cx.global::<DevicesStore>().hosted.busy {
        return;
    }
    let Some(task) = host::call(method, args, cx) else { return };
    store(cx, |s| {
        s.hosted.busy = true;
        s.hosted.action_error = None;
    });
    cx.spawn(async move |cx| {
        let answer = task.await;
        cx.update(|cx| {
            store(cx, |s| s.hosted.busy = false);
            match answer {
                Ok(value) => {
                    show_status(&value, cx);
                    // A reset or a pairing changes the list.
                    read_devices(cx);
                }
                Err(error) => store(cx, |s| s.hosted.action_error = Some(error)),
            }
        });
    })
    .detach();
}

/// "Allow devices to connect".
pub fn set_phone_enabled(enabled: bool, cx: &mut App) {
    if !hosted(cx) {
        return store(cx, |s| s.set_phone_enabled(enabled));
    }
    if cx.global::<DevicesStore>().hosted.phone_read {
        phone_action("phone:set-enabled", json!([enabled]), cx);
    }
}

/// "Allow on local network".
pub fn set_lan(enabled: bool, cx: &mut App) {
    if !hosted(cx) {
        return store(cx, |s| s.set_lan(enabled));
    }
    phone_action("phone:set-lan", json!([enabled]), cx);
}

/// "Allow pairing again".
pub fn allow_pairing_again(cx: &mut App) {
    if !hosted(cx) {
        return store(cx, |s| s.allow_pairing_again());
    }
    phone_action("phone:open-pairing", json!([]), cx);
}

/// "Reset and disconnect".
pub fn reset_access(cx: &mut App) {
    if !hosted(cx) {
        return store(cx, |s| s.reset_access());
    }
    phone_action("phone:reset", json!([]), cx);
}

/// A paired device's Remove: the answer is the list without it.
pub fn remove_device(key: String, cx: &mut App) {
    if !hosted(cx) {
        return store(cx, |s| s.remove_device(&key));
    }
    let Some(task) = host::call("devices:remove", json!([key]), cx) else { return };
    store(cx, |s| {
        s.hosted.busy = true;
        s.hosted.action_error = None;
    });
    cx.spawn(async move |cx| {
        let answer = task.await;
        cx.update(|cx| {
            store(cx, |s| s.hosted.busy = false);
            match answer {
                Ok(value) => show_devices(&value, cx),
                Err(error) => store(cx, |s| s.hosted.action_error = Some(error)),
            }
        });
    })
    .detach();
}

/// This Mac shows: its memory and disk (`computer:resources:read`), read again while the disk is being measured.
pub fn read_this_mac(visit: u64, cx: &mut App) {
    store(cx, |s| s.hosted.on = true);
    let Some(task) = host::call("computer:resources:read", json!([]), cx) else { return };
    cx.spawn(async move |cx| {
        let answer = task.await;
        let measuring = match answer.as_ref().ok().and_then(resources) {
            Some(read) => {
                let measuring = read.disk.as_ref().is_some_and(|disk| disk.measuring);
                store_async(cx, |s| {
                    s.resources.insert("this-mac".into(), read);
                });
                measuring
            }
            None => {
                store_async(cx, |s| {
                    s.resources.remove("this-mac");
                });
                false
            }
        };
        if measuring {
            cx.background_executor().timer(MEASURING_EVERY).await;
            cx.update(|cx| {
                if host::visit(cx) == Some(visit) {
                    read_this_mac(visit, cx);
                }
            });
        }
    })
    .detach();
}
