//! The state behind the Devices pages as the host would answer it (`phone:*`, `devices:*`, `computers:*`,
//! `computer:resources:read`, `storage:*`, `simlock:*`, `computer-use:*`, `main-sync:default:*`, `app-update:*`): one
//! global, [`DevicesStore`], filled with fixture data. Nothing talks to a network, a phone or the daemon. Every action
//! the pages offer changes the store the way the host's answer would, so the pages can be driven and tested.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{App, Global};

use super::logic::{
    ComputerResources, ComputerView, DAY_MS, DISK_GB, DeviceKind, DiskResources, GB, HOUR_MS, HostUpdate, IdleWorktree, Lan, MINUTE_MS,
    MemoryResources, PairedDevice, PairingOption, Part, PartKind, Permission, PhoneState, PhoneStatus, Reach, RelayLink, Remote, Route,
    UpdateStatus, WorktreeStatus,
};

/// Wall clock in milliseconds since the epoch.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// How long the pairing window stays open once the QR shows.
pub const PAIRING_MS: i64 = 10 * MINUTE_MS;

/// `SimlockSettings`.
#[derive(Clone, Debug, PartialEq)]
pub struct Simlock {
    pub enabled: bool,
    pub gateway: String,
    /// "settings" once a token was saved on this Mac.
    pub token_saved: bool,
    pub max_leases: u32,
    pub max_minutes: u32,
    /// A Simlock worker found on this Mac.
    pub detected_gateway: Option<String>,
}

/// `ComputerUseStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputerUse {
    pub supported: bool,
    pub enabled: bool,
    pub cursor: bool,
    pub accessibility: Permission,
    pub screen_recording: Permission,
    pub blocked_apps: Vec<String>,
    pub version: String,
}

/// What the page of one paired computer shows besides its connection.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputerMeta {
    pub version: Option<String>,
    pub projects: Vec<String>,
    pub update: Option<HostUpdate>,
    pub auto_update: bool,
}

#[derive(Clone, Debug)]
pub struct DevicesStore {
    pub phone: PhoneStatus,
    pub pairing_route: String,
    pub devices: Vec<PairedDevice>,
    /// `New` marks shown this visit.
    pub fresh: BTreeSet<String>,
    pub copied: bool,
    pub other_computers: bool,
    pub add_computer_requests: usize,
    pub computers: Vec<ComputerView>,
    pub meta: BTreeMap<String, ComputerMeta>,
    pub hidden_computers: BTreeSet<String>,
    /// Messages waiting on this Mac for a computer, by id.
    pub waiting: BTreeMap<String, usize>,
    pub resources: BTreeMap<String, ComputerResources>,
    pub this_mac: String,
    pub idle: Vec<IdleWorktree>,
    pub main_sync_default: bool,
    pub simlock: Simlock,
    pub computer_use: ComputerUse,
    /// The toast a cleanup ended with.
    pub last_toast: Option<String>,
}

impl Global for DevicesStore {}

fn part(kind: PartKind, gb: f64, count: usize) -> Part {
    Part { kind, bytes: gb * GB, count }
}

fn disk_part(kind: PartKind, gb: f64, count: usize) -> Part {
    Part { kind, bytes: gb * DISK_GB, count }
}

fn idle(now: i64, title: &str, project: &str, days: i64, chats: usize, gb: Option<f64>, status: (usize, usize)) -> IdleWorktree {
    IdleWorktree {
        project_name: project.into(),
        path: format!("/Users/victor/.milagre/worktrees/{project}/{title}"),
        branch: Some(format!("milagre/{title}")),
        title: title.into(),
        chats,
        last_at: now - days * DAY_MS - 3 * HOUR_MS,
        bytes: gb.map(|g| g * DISK_GB),
        status: WorktreeStatus { uncommitted: status.0, unpushed: status.1, removable: status == (0, 0) },
    }
}

impl DevicesStore {
    /// The fixture, from the computers the data source lists (`computers`, as `(id, name, online)` plus this Mac's name).
    pub fn fixture(this_mac: &str, listed: &[(String, String, bool)]) -> Self {
        let now = now_ms();
        let mut computers = Vec::new();
        let mut meta = BTreeMap::new();
        let mut resources = BTreeMap::new();
        for (ix, (id, name, online)) in listed.iter().enumerate() {
            computers.push(ComputerView {
                id: id.clone(),
                name: name.clone(),
                state: if *online { Reach::Online } else { Reach::Offline },
                route: online.then_some(if ix % 2 == 0 { Route::Lan } else { Route::Relay }),
                relay_host: "relay.milagre.cloud".into(),
                lan_routes: if *online { vec!["192.168.1.24:8798".into()] } else { Vec::new() },
                last_seen: Some(now - if *online { 20_000 } else { 2 * HOUR_MS }),
                added_at: Some(now - 21 * DAY_MS),
                message: None,
            });
            meta.insert(
                id.clone(),
                ComputerMeta {
                    version: online.then(|| "0.232.0".to_string()),
                    projects: if *online { vec!["milagre-ade".into(), "happiergym".into()] } else { Vec::new() },
                    update: online.then(|| HostUpdate {
                        status: UpdateStatus::Downloaded,
                        version: Some("0.233.0".into()),
                        progress: 100.0,
                        error: None,
                        auto: false,
                        current: "0.232.0".into(),
                    }),
                    auto_update: false,
                },
            );
            if *online {
                resources.insert(
                    id.clone(),
                    ComputerResources {
                        memory: MemoryResources {
                            total: 16.0 * GB,
                            available: 1.2 * GB,
                            milagre: Some(2.9 * GB),
                            parts: vec![part(PartKind::Claude, 1.6, 2), part(PartKind::App, 1.0, 0), part(PartKind::Terminals, 0.3, 1)],
                        },
                        disk: Some(DiskResources {
                            total: 1000.0 * DISK_GB,
                            available: 612.0 * DISK_GB,
                            milagre: Some(24.5 * DISK_GB),
                            parts: vec![
                                disk_part(PartKind::Worktrees, 14.2, 4),
                                disk_part(PartKind::Chats, 5.1, 0),
                                disk_part(PartKind::Caches, 3.4, 0),
                                disk_part(PartKind::Agents, 1.8, 0),
                            ],
                            measuring: false,
                        }),
                    },
                );
            }
        }
        resources.insert(
            "this-mac".into(),
            ComputerResources {
                memory: MemoryResources {
                    total: 24.0 * GB,
                    available: 11.0 * GB,
                    milagre: Some(3.6 * GB),
                    parts: vec![
                        part(PartKind::Claude, 1.4, 3),
                        part(PartKind::Codex, 0.8, 1),
                        part(PartKind::Terminals, 0.3, 2),
                        part(PartKind::App, 1.1, 0),
                    ],
                },
                disk: Some(DiskResources {
                    total: 994.0 * DISK_GB,
                    available: 214.0 * DISK_GB,
                    milagre: Some(38.4 * DISK_GB),
                    parts: vec![
                        disk_part(PartKind::Worktrees, 21.4, 9),
                        disk_part(PartKind::Chats, 6.2, 0),
                        disk_part(PartKind::Checkpoints, 4.1, 0),
                        disk_part(PartKind::Agents, 2.8, 0),
                        disk_part(PartKind::Speech, 1.9, 0),
                        disk_part(PartKind::Browser, 1.4, 0),
                        disk_part(PartKind::Designs, 0.6, 0),
                    ],
                    measuring: false,
                }),
            },
        );
        let phone = PhoneStatus {
            enabled: true,
            state: PhoneState::On,
            error: None,
            remote: Remote::Relay,
            relay: Some(RelayLink::Online),
            pairing_until: Some(now + 8 * MINUTE_MS + 20_000),
            local_host: "127.0.0.1".into(),
            public_host: None,
            pairing_link: "https://relay.milagre.cloud/pair#k=Kj3x9Tq2".into(),
            pairing_options: vec![
                PairingOption { id: "automatic".into(), label: "Automatic".into() },
                PairingOption { id: "lan".into(), label: "Same network".into() },
                PairingOption { id: "tailscale".into(), label: "Tailscale".into() },
                PairingOption { id: "relay".into(), label: "Remote relay".into() },
            ],
            lan: Some(Lan { enabled: true, addresses: vec!["192.168.1.24".into()], error: None }),
        };
        let device = |key: &str, kind, name: Option<&str>, route, seen: Option<i64>, is_new| PairedDevice {
            key: key.into(),
            kind,
            name: name.map(str::to_string),
            last_seen: seen,
            is_new,
            route,
        };
        let devices = vec![
            device("p1", DeviceKind::Phone, Some("Victor's iPhone"), Some(Route::Lan), Some(now), false),
            device("p2", DeviceKind::Phone, Some("iPad Pro"), None, Some(now - 3 * HOUR_MS), true),
            device("p3", DeviceKind::Phone, None, None, Some(now - 9 * DAY_MS), false),
            device("c1", DeviceKind::Computer, Some("deer"), Some(Route::Relay), Some(now), false),
        ];
        let fresh = devices.iter().filter(|d| d.is_new).map(|d| d.key.clone()).collect();
        let idle = vec![
            idle(now, "fix-onboarding-hang", "milagre-ade", 41, 2, Some(2.4), (0, 0)),
            idle(now, "routine-editor-spike", "milagre-ade", 58, 1, Some(3.1), (4, 0)),
            idle(now, "watch-complications", "happiergym", 66, 3, Some(1.7), (0, 0)),
            idle(now, "paywall-experiment", "happiergym", 94, 1, Some(0.9), (0, 2)),
            idle(now, "release-notes-draft", "milagre-ade", 112, 0, Some(1.2), (0, 0)),
            idle(now, "tmp-bisect", "milagre-ade", 125, 1, None, (1, 1)),
        ];
        DevicesStore {
            phone,
            pairing_route: "automatic".into(),
            devices,
            fresh,
            copied: false,
            other_computers: true,
            add_computer_requests: 0,
            computers,
            meta,
            hidden_computers: BTreeSet::new(),
            waiting: BTreeMap::new(),
            resources,
            this_mac: this_mac.into(),
            idle,
            main_sync_default: false,
            simlock: Simlock {
                enabled: true,
                gateway: String::new(),
                token_saved: false,
                max_leases: 2,
                max_minutes: 60,
                detected_gateway: Some("http://127.0.0.1:4700".into()),
            },
            computer_use: ComputerUse {
                supported: true,
                enabled: true,
                cursor: true,
                accessibility: Permission::Granted,
                screen_recording: Permission::Denied,
                blocked_apps: ["1Password", "Keychain Access", "System Settings", "Terminal"].map(str::to_string).to_vec(),
                version: "0.1.4".into(),
            },
            last_toast: None,
        }
    }

    pub fn computer(&self, id: &str) -> Option<&ComputerView> {
        self.computers.iter().find(|c| c.id == id)
    }

    // -- Phone ------------------------------------------------------------------------------------------------------

    /// "Allow devices to connect".
    pub fn set_phone_enabled(&mut self, enabled: bool) {
        self.phone.enabled = enabled;
        self.phone.state = if enabled { PhoneState::On } else { PhoneState::Off };
        self.phone.pairing_until = enabled.then(|| now_ms() + PAIRING_MS);
    }

    /// "Allow on local network".
    pub fn set_lan(&mut self, enabled: bool) {
        if let Some(lan) = &mut self.phone.lan {
            lan.enabled = enabled;
        }
    }

    /// "Allow pairing again".
    pub fn allow_pairing_again(&mut self) {
        self.phone.pairing_until = Some(now_ms() + PAIRING_MS);
    }

    /// "Reset and disconnect": a new code, and every device pairs again.
    pub fn reset_access(&mut self) {
        self.devices.clear();
        self.fresh.clear();
        self.phone.pairing_link = "https://relay.milagre.cloud/pair#k=Wm81Qa7d".into();
        self.phone.pairing_until = Some(now_ms() + PAIRING_MS);
    }

    pub fn remove_device(&mut self, key: &str) {
        self.devices.retain(|device| device.key != key);
        self.fresh.remove(key);
    }

    // -- Computers --------------------------------------------------------------------------------------------------

    pub fn rename_computer(&mut self, id: &str, name: &str) -> bool {
        let name = name.trim();
        match self.computers.iter_mut().find(|c| c.id == id) {
            Some(computer) if !name.is_empty() && computer.name != name => {
                computer.name = name.to_string();
                true
            }
            _ => false,
        }
    }

    pub fn set_computer_hidden(&mut self, id: &str, hidden: bool) {
        if hidden {
            self.hidden_computers.insert(id.to_string());
        } else {
            self.hidden_computers.remove(id);
        }
    }

    /// Remove: the computer, the messages waiting for it and its hidden mark go.
    pub fn remove_computer(&mut self, id: &str) {
        self.computers.retain(|c| c.id != id);
        self.meta.remove(id);
        self.resources.remove(id);
        self.waiting.remove(id);
        self.hidden_computers.remove(id);
    }

    pub fn check_host_update(&mut self, id: &str) {
        if let Some(update) = self.meta.get_mut(id).and_then(|m| m.update.as_mut()) {
            update.status = UpdateStatus::Checking;
        }
    }

    /// The check ends: a newer release downloads.
    pub fn host_update_found(&mut self, id: &str) {
        if let Some(update) = self.meta.get_mut(id).and_then(|m| m.update.as_mut()) {
            update.status = UpdateStatus::Downloaded;
            update.version = Some("0.233.0".into());
            update.progress = 100.0;
        }
    }

    pub fn install_host_update(&mut self, id: &str) {
        if let Some(update) = self.meta.get_mut(id).and_then(|m| m.update.as_mut()) {
            update.status = UpdateStatus::Installing;
        }
    }

    pub fn set_auto_update(&mut self, id: &str, on: bool) {
        if let Some(meta) = self.meta.get_mut(id) {
            meta.auto_update = on;
        }
    }

    // -- Storage ----------------------------------------------------------------------------------------------------

    /// One idle worktree removed; the folders are measured again after (a smaller Worktrees share).
    pub fn remove_idle(&mut self, path: &str) {
        let Some(at) = self.idle.iter().position(|item| item.path == path) else { return };
        let gone = self.idle.remove(at);
        if let Some(disk) = self.resources.get_mut("this-mac").and_then(|r| r.disk.as_mut()) {
            let freed = gone.bytes.unwrap_or(0.0);
            disk.available += freed;
            disk.milagre = disk.milagre.map(|m| (m - freed).max(0.0));
            for part in disk.parts.iter_mut().filter(|p| p.kind == PartKind::Worktrees) {
                part.bytes = (part.bytes - freed).max(0.0);
                part.count = part.count.saturating_sub(1);
            }
        }
    }

    // -- Simlock, computer use --------------------------------------------------------------------------------------

    /// "Save and check": the gateway is kept and the token cleared from the field. The fixture gateway always answers.
    pub fn save_simlock(&mut self, gateway: &str, token: &str) -> String {
        let gateway = gateway.trim();
        self.simlock.gateway = gateway.to_string();
        if !token.trim().is_empty() {
            self.simlock.token_saved = true;
        }
        let shown = if gateway.is_empty() { self.simlock.detected_gateway.clone().unwrap_or_default() } else { gateway.to_string() };
        format!("Connected to {shown} as {} (agent).", self.this_mac)
    }

    pub fn grant_permissions(&mut self) {
        self.computer_use.accessibility = Permission::Granted;
        self.computer_use.screen_recording = Permission::Granted;
    }
}

/// Installs the fixture store once, from the data source's computers.
pub fn init(cx: &mut App) {
    if cx.has_global::<DevicesStore>() {
        return;
    }
    let (this_mac, listed) = listed_computers(cx);
    cx.set_global(DevicesStore::fixture(&this_mac, &listed));
}

/// This Mac's name and the computers the data source lists, as `(id, name, online)`.
pub fn listed_computers(cx: &App) -> (String, Vec<(String, String, bool)>) {
    use crate::data::{ComputerState, Data, Polled, poll_once};
    let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else {
        return ("Victor XPro".into(), vec![("tianxu-mini".into(), "tianxu".into(), false), ("deer-studio".into(), "deer".into(), true)]);
    };
    match poll_once(source.computers()) {
        Polled::Ready(Ok(snapshot)) => (
            snapshot.this_mac.to_string(),
            snapshot.computers.iter().map(|c| (c.id.to_string(), c.name.to_string(), c.state == ComputerState::Online)).collect(),
        ),
        _ => ("This Mac".into(), Vec::new()),
    }
}
