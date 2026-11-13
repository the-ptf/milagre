//! Settings on Milagre's daemon, read and written with the commands Electron's Settings sends (`Settings.tsx`,
//! `ContextSettings.tsx`, `KeybindingsSettings.tsx` and the bridge in `apps/desktop/electron/preload.cjs`):
//!
//! | Section | Rows | Read | Write |
//! | --- | --- | --- | --- |
//! | General | Done › Archive Done Chats after | `done:settings:read []` | `done:settings:save [{retentionHours}]` |
//! | General | System › Keep the Mac awake | this window's `preferences.json` | `app:set-keep-awake [bool]` |
//! | General | Editor › Open files in | this window's `preferences.json` | (Details' Open in editor uses it) |
//! | Chat | Messages during a turn | `context:settings:read []` | `context:settings:save [{followUps}]` |
//! | Chat | Reasoning, Tool calls | this window's `preferences.json` | the transcript follows them |
//! | Keybindings | every command | `keybindings:read []` | `keybindings:set-command [command, rules]`, `keybindings:reset []` |
//! | Models | Context: Auto compact, thresholds | `context:settings:read []` | `context:settings:save [patch]` |
//! | Experimental | Delegate to other computers | `linked:remote-enabled:read []` | `linked:remote-enabled:save [bool]` |
//! | Experimental | Device notes | `device-notes:read []` | `device-notes:save [bool]` |
//! | About | Version, Auto update | `app:version []`, `app-update:auto:read []` | `app-update:auto:save [bool]` |
//! | Worktrees | Sync source branch before new Worktrees | `main-sync:default:read []` | `main-sync:default:save [bool]` |
//! | Worktrees | Clean up worktrees | `storage:worktrees []` | `storage:remove-worktree [{projectPath, path, seen, force, activity, idleBefore, lastAt}]` |
//! | Skills | the open Project's skills | `skills:list [path]`, `skills:read [path, file]` | Open in editor, Show in Finder: this window |
//! | Integrations | Linear | `linear:enabled:read []`, `linear:status []` | `linear:enabled:save [bool]`, `linear:move-to-started:save [bool]`, `linear:connect [{window: false}]`, `linear:disconnect [{workspace}]` |
//! | Integrations | Babysit PRs | `babysit:settings:read []` | `babysit:settings:save [patch]` |
//! | Phone & sharing | access, the code, paired devices, Reset | `phone:status []`, `devices:list []` | `phone:set-enabled`, `phone:set-lan`, `phone:open-pairing`, `phone:reset`, `devices:remove [key]`, `devices:acknowledge [keys]` |
//! | This Mac | memory and disk | `computer:resources:read []` | |
//! | A Project | Sidebar, Worktrees, Branches, New worktrees | `project:recent`, `main-sync:read`, `project-git:read`, `files-to-copy:read` / `:preview`, `worktree-setup:read` `[path]` | `project:set-hidden`, `main-sync:save`, `project-git:save`, `files-to-copy:save`, `worktree-setup:save` `[path, value]` |
//!
//! Skills, Integrations, Phone & sharing, This Mac and the Projects' pages keep their own state and call the daemon
//! through the base crate's [`SettingsHost`](milagre_gpui_spike::settings::host::SettingsHost) ([`host`]); each reads
//! again when Settings opens or goes to it (the host's `visit`).
//!
//! The rows this window cannot honour (the sidebar's order and list, plan-usage display, default model and
//! permission, replies, Ultracode, update channel and checks) stay hidden and out of search ([`HIDDEN`]). Everything
//! is read when the window opens and again each time Settings opens; a change is written at once on a request-only
//! connection of the live Project, and the daemon's answer is what Settings shows. A refused write puts the row back
//! and says why in the sidebar. In read-only mode (`--snapshot`) nothing is written: the row goes back.

use std::sync::Arc;

use gpui::{App, AppContext as _, BorrowAppContext as _, Context, Entity, Global, WeakEntity};
use milagre_gpui_spike::data::LOCAL;
use milagre_gpui_spike::logic::keybindings::rules::RuleDraft;
use milagre_gpui_spike::logic::keybindings::{KeybindingRule, KeybindingsState};
use milagre_gpui_spike::settings::SettingsStore;
use milagre_gpui_spike::settings::devices::DevicesStore;
use milagre_gpui_spike::settings::devices::cleanup::CleanupRemover;
use milagre_gpui_spike::settings::devices::logic::{IdleWorktree, WorktreeStatus};
use milagre_gpui_spike::settings::keybindings::KeybindingsStore;
use milagre_gpui_spike::settings::keybindings::model::KeyWrite;
use milagre_gpui_spike::settings::search::SettingsSectionId as S;
use milagre_gpui_spike::settings::store::{FollowUpMode, ToolCallDisplay};
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::preview::PreviewSettings;
use serde_json::{Value, json};

use crate::daemon::Daemon;
use crate::usage::off_thread;

mod host;

/// The sections this window draws as full pages on Milagre's daemon. MCP stays out: its place goes to the tool
/// orchestrator being designed.
pub const SECTIONS: &[S] = &[
    S::General,
    S::Chat,
    S::Keybindings,
    S::Models,
    S::Skills,
    S::Worktrees,
    S::Connections,
    S::Devices,
    S::ThisMac,
    S::Project,
    S::Experimental,
    S::About,
];

/// Rows and groups (Settings search titles) on [`SECTIONS`] this window cannot honour: hidden and not searched.
pub const HIDDEN: &[(S, &str)] = &[
    // The sidebar keeps its own order and list; the plan usage rows have no display switch.
    (S::General, "Sidebar"),
    (S::General, "Chat order"),
    (S::General, "Chat list"),
    (S::General, "One list"),
    (S::General, "By Project"),
    (S::General, "Plan usage"),
    (S::General, "Show"),
    (S::General, "Show in sidebar"),
    // A new Chat's model comes from the composer's picker; the sends fix TLDR and Concise; the composer has no
    // context-size control.
    (S::Models, "New chats"),
    (S::Models, "Default model"),
    (S::Models, "Default permission"),
    (S::Models, "Replies"),
    (S::Models, "TLDR writing"),
    (S::Models, "Claude replies"),
    (S::Models, "Context size beside Send"),
    (S::Models, "Show Compact below threshold"),
    // No Ultracode overlay or new-Chat stats here.
    (S::Experimental, "Ultracode Fatality"),
    (S::Experimental, "New Chat stats"),
    // Electron's own updater (`update:*` are Electron-only).
    (S::About, "Release channel"),
    (S::About, "Updates"),
    (S::About, "Check for updates"),
    // Simlock and the published pages are not read here yet.
    (S::Devices, "Simulators"),
    (S::Devices, "Simlock devices"),
    (S::Devices, "Designs and artifacts"),
    (S::Devices, "Published pages"),
    // Driving other computers is the computers' own (their pages); Computer use is not read here yet.
    (S::ThisMac, "Drive other computers"),
    (S::ThisMac, "Add computer"),
    (S::ThisMac, "Automation"),
    (S::ThisMac, "Computer use"),
    // A Project's icon (decoded and resized before `project:set-icon`), its accounts and Remove Project are not
    // wired here yet.
    (S::Project, "Appearance"),
    (S::Project, "Accounts"),
    (S::Project, "Remove Project"),
];

/// The reads, in order, on one request-only connection.
pub const READS: &[&str] = &[
    "app:version",
    "context:settings:read",
    "done:settings:read",
    "linked:remote-enabled:read",
    "device-notes:read",
    "app-update:auto:read",
    "main-sync:default:read",
    "storage:worktrees",
];

/// The host-kept values Settings shows, as last agreed with the daemon (Keep awake: as last sent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Host {
    pub follow_ups: FollowUpMode,
    pub auto_compact: bool,
    pub button_threshold: u8,
    pub auto_threshold: u8,
    pub done_hours: u32,
    pub remote_delegation: bool,
    pub device_notes: bool,
    pub auto_update: bool,
    pub keep_awake: bool,
}

impl Host {
    pub fn of(store: &SettingsStore) -> Self {
        Self {
            follow_ups: store.follow_ups,
            auto_compact: store.auto_compact,
            button_threshold: store.button_threshold,
            auto_threshold: store.auto_threshold,
            done_hours: store.done_retention_hours,
            remote_delegation: store.delegate_to_other_computers,
            device_notes: store.device_notes,
            auto_update: store.auto_update,
            keep_awake: store.keep_awake,
        }
    }

    pub fn put(&self, store: &mut SettingsStore) {
        store.follow_ups = self.follow_ups;
        store.auto_compact = self.auto_compact;
        store.button_threshold = self.button_threshold;
        store.auto_threshold = self.auto_threshold;
        store.done_retention_hours = self.done_hours;
        store.delegate_to_other_computers = self.remote_delegation;
        store.device_notes = self.device_notes;
        store.auto_update = self.auto_update;
        store.keep_awake = self.keep_awake;
    }

    /// A read's or a save's answer over these values; anything missing or of the wrong type keeps its value.
    pub fn apply(&mut self, method: &str, answer: &Value) {
        let flag = |key: &str, held: bool| answer[key].as_bool().unwrap_or(held);
        let percent = |key: &str, held: u8| answer[key].as_u64().and_then(|n| u8::try_from(n).ok()).unwrap_or(held);
        match method {
            "context:settings:read" | "context:settings:save" => {
                if let Some(mode) = answer["followUps"].as_str() {
                    self.follow_ups = FollowUpMode::parse(mode);
                }
                self.auto_compact = flag("autoCompact", self.auto_compact);
                self.button_threshold = percent("buttonThreshold", self.button_threshold);
                self.auto_threshold = percent("autoThreshold", self.auto_threshold);
            }
            "done:settings:read" | "done:settings:save" => {
                if let Some(hours) = answer["retentionHours"].as_u64().and_then(|h| u32::try_from(h).ok()) {
                    self.done_hours = hours;
                }
            }
            "linked:remote-enabled:read" | "linked:remote-enabled:save" => self.remote_delegation = flag("enabled", self.remote_delegation),
            "device-notes:read" | "device-notes:save" => self.device_notes = flag("enabled", self.device_notes),
            "app-update:auto:read" | "app-update:auto:save" => self.auto_update = flag("autoUpdate", self.auto_update),
            _ => {}
        }
    }

    /// `self` with what `method` writes put back from `before` (its write was refused).
    fn revert(&mut self, method: &str, before: &Host) {
        match method {
            "context:settings:save" => {
                self.follow_ups = before.follow_ups;
                self.auto_compact = before.auto_compact;
                self.button_threshold = before.button_threshold;
                self.auto_threshold = before.auto_threshold;
            }
            "done:settings:save" => self.done_hours = before.done_hours,
            "linked:remote-enabled:save" => self.remote_delegation = before.remote_delegation,
            "device-notes:save" => self.device_notes = before.device_notes,
            "app-update:auto:save" => self.auto_update = before.auto_update,
            "app:set-keep-awake" => self.keep_awake = before.keep_awake,
            _ => {}
        }
    }
}

/// The commands that take `after` from `before`, with Electron's arguments (a context patch has only what changed).
pub fn writes(before: &Host, after: &Host) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    let mut patch = serde_json::Map::new();
    if before.follow_ups != after.follow_ups {
        patch.insert("followUps".into(), json!(after.follow_ups.as_str()));
    }
    if before.auto_compact != after.auto_compact {
        patch.insert("autoCompact".into(), json!(after.auto_compact));
    }
    if before.button_threshold != after.button_threshold {
        patch.insert("buttonThreshold".into(), json!(after.button_threshold));
    }
    if before.auto_threshold != after.auto_threshold {
        patch.insert("autoThreshold".into(), json!(after.auto_threshold));
    }
    if !patch.is_empty() {
        out.push(("context:settings:save", json!([Value::Object(patch)])));
    }
    if before.done_hours != after.done_hours {
        out.push(("done:settings:save", json!([{"retentionHours": after.done_hours}])));
    }
    if before.remote_delegation != after.remote_delegation {
        out.push(("linked:remote-enabled:save", json!([after.remote_delegation])));
    }
    if before.device_notes != after.device_notes {
        out.push(("device-notes:save", json!([after.device_notes])));
    }
    if before.auto_update != after.auto_update {
        out.push(("app-update:auto:save", json!([after.auto_update])));
    }
    if before.keep_awake != after.keep_awake {
        out.push(("app:set-keep-awake", json!([after.keep_awake])));
    }
    out
}

/// `keybindings:read`'s (and a write's) answer: `{path, rules: [{key, command, when?}], issues}`.
pub fn keybindings_state(value: &Value) -> Option<KeybindingsState> {
    let rules = value["rules"]
        .as_array()?
        .iter()
        .filter_map(|rule| {
            Some(KeybindingRule {
                key: rule["key"].as_str()?.to_owned(),
                command: rule["command"].as_str()?.to_owned(),
                when: rule["when"].as_str().filter(|w| !w.is_empty()).map(str::to_owned),
            })
        })
        .collect();
    Some(KeybindingsState {
        path: value["path"].as_str().unwrap_or_default().to_owned(),
        rules,
        issues: value["issues"].as_array().into_iter().flatten().filter_map(|i| i.as_str().map(str::to_owned)).collect(),
    })
}

/// A keybindings write as the command Electron sends.
pub fn key_write(write: &KeyWrite) -> (&'static str, Value) {
    match write {
        KeyWrite::SetCommand { command, rules } => (
            "keybindings:set-command",
            json!([command, rules.iter().map(|RuleDraft { key, when }| match when {
                Some(when) if !when.trim().is_empty() => json!({"key": key, "when": when}),
                _ => json!({"key": key}),
            }).collect::<Vec<_>>()]),
        ),
        KeyWrite::ResetAll => ("keybindings:reset", json!([])),
    }
}

/// `storage:worktrees`' answer (`{worktrees: IdleWorktree[]}`) as the cleanup dialog lists it.
pub fn idle_worktrees(answer: &Value) -> Vec<IdleWorktree> {
    answer["worktrees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let status = &item["status"];
            Some(IdleWorktree {
                project_name: item["projectName"].as_str().unwrap_or_default().to_owned(),
                path: item["path"].as_str()?.to_owned(),
                branch: item["branch"].as_str().map(str::to_owned),
                title: item["title"].as_str().unwrap_or_default().to_owned(),
                chats: item["chats"].as_u64().unwrap_or(0) as usize,
                last_at: item["lastAt"].as_i64().unwrap_or(0),
                bytes: item["bytes"].as_f64(),
                status: WorktreeStatus {
                    uncommitted: status["uncommitted"].as_u64().unwrap_or(0) as usize,
                    unpushed: status["unpushed"].as_u64().unwrap_or(0) as usize,
                    removable: status["removable"] == true,
                },
            })
        })
        .collect()
}

/// The `storage:remove-worktree` request for an item of `storage:worktrees` (`removeIdleWorktrees` in
/// `packages/shared/src/storage.ts`): what the list saw, so the host refuses a stale selection; unsaved work is forced.
pub fn remove_request(item: &Value) -> Value {
    json!({
        "projectPath": item["projectPath"],
        "path": item["path"],
        "seen": item["status"],
        "force": item["status"]["removable"] != true,
        "activity": item["activity"],
        "idleBefore": item["idleBefore"],
        "lastAt": item["lastAt"],
    })
}

/// The store's transcript display, as the transcript names it.
fn display(store: &SettingsStore) -> (milagre_gpui_spike::logic::lists::chat_display::ToolCallDisplay, bool) {
    use milagre_gpui_spike::logic::lists::chat_display::ToolCallDisplay as Shown;
    let shown = match store.tool_call_display {
        ToolCallDisplay::Compact => Shown::Compact,
        ToolCallDisplay::Full => Shown::Full,
    };
    (shown, store.expand_reasoning)
}

/// Keeps Settings on Milagre's daemon. Held by a global; it ends with the window.
pub struct LiveSettings {
    daemon: Arc<Daemon>,
    workspace: WeakEntity<Workspace>,
    /// The host-kept values as last agreed; `None` until the first read answers.
    host: Option<Host>,
    reading: bool,
    /// A read waits for the daemon's first sync (no Project known yet).
    waiting: bool,
    /// Settings › Worktrees' default as last agreed (`None` before the first read), and the idle worktrees as the host
    /// listed them (the removal sends back what the list saw).
    main_sync: Option<bool>,
    idle: Vec<Value>,
    toast: Option<String>,
    /// Writes sent so far, and those not answered yet: a read that crossed one is not shown (it may predate it) and
    /// is asked again once they are answered.
    write_seq: u64,
    writing: usize,
    read_seq: Option<u64>,
    read_again: bool,
    keys_busy: bool,
    settings_open: bool,
    /// The page Settings shows (`None`: closed), for the pages' host visits.
    shown_page: Option<milagre_gpui_spike::settings::SelectedSection>,
    opened_file: usize,
    /// Every write sent (method and arguments), refused in read-only mode, and failed reads and writes (tests).
    pub sent: Vec<(String, Value)>,
    pub refused: Vec<String>,
    pub errors: Vec<String>,
    pub reads: u64,
}

struct Held(Entity<LiveSettings>);

impl Global for Held {}

/// The Project whose connection carries Settings' reads and writes: the live one, else the most recent.
pub(crate) fn project_of(daemon: &Daemon) -> Option<String> {
    daemon.primary().map(|(project, _)| project).or_else(|| daemon.known().first().map(|known| known.path.clone()))
}

/// The window's [`LiveSettings`], once [`attach`]ed.
pub fn live(cx: &App) -> Option<Entity<LiveSettings>> {
    cx.try_global::<Held>().map(|held| held.0.clone())
}

/// Turns Settings' daemon sections on: lists them, reads them now, and follows every change.
pub fn attach(workspace: &Entity<Workspace>, daemon: Arc<Daemon>, cx: &mut App) -> Entity<LiveSettings> {
    cx.set_global(PreviewSettings { sections: SECTIONS.to_vec(), hidden: HIDDEN.to_vec() });
    if !cx.has_global::<SettingsStore>() {
        cx.set_global(SettingsStore::default());
    }
    if !cx.has_global::<KeybindingsStore>() {
        cx.set_global(KeybindingsStore::default());
    }
    cx.update_global::<KeybindingsStore, _>(|keys, _| keys.live = true);
    milagre_gpui_spike::settings::devices::init(cx);
    // The pages' host first: Settings' views read it when they are made.
    let pages = daemon.clone();
    let live = cx.new(|cx| {
        cx.set_global(host::make(pages, cx.weak_entity()));
        LiveSettings::new(workspace, daemon, cx)
    });
    cx.set_global(Held(live.clone()));
    let remover = live.downgrade();
    cx.set_global(CleanupRemover(std::rc::Rc::new(move |path: String, cx: &mut App| match remover.upgrade() {
        Some(live) => live.update(cx, |live, cx| live.remove_worktree(&path, cx)),
        None => gpui::Task::ready(Err("This window closed.".to_owned())),
    })));
    live
}

impl LiveSettings {
    fn new(workspace: &Entity<Workspace>, daemon: Arc<Daemon>, cx: &mut Context<Self>) -> Self {
        cx.observe_global::<SettingsStore>(|this, cx| this.store_changed(cx)).detach();
        cx.observe_global::<KeybindingsStore>(|this, cx| this.keys_changed(cx)).detach();
        cx.observe_global::<DevicesStore>(|this, cx| this.devices_changed(cx)).detach();
        let settings = workspace.read(cx).settings.clone();
        // Snapshot aid: `MILAGRE_GPUI_SETTINGS=<section>` opened Settings before these sections were listed, so it fell
        // back to Appearance; open the section asked for now that it is.
        if let Some(section) = std::env::var("MILAGRE_GPUI_SETTINGS")
            .ok()
            .and_then(|name| S::parse(&name))
            .filter(|section| SECTIONS.contains(section))
        {
            settings.update(cx, |s, cx| s.select_section(milagre_gpui_spike::settings::SelectedSection::Section(section), cx));
        }
        cx.observe(&settings, |this, settings, cx| {
            let (open, page) = {
                let settings = settings.read(cx);
                (settings.is_open(), settings.selected().clone())
            };
            if open && !this.settings_open {
                this.read(cx);
            }
            // The pages read again when Settings opens or goes to another page, and stop following once it closes.
            let shown = open.then_some(page);
            if shown != this.shown_page {
                this.shown_page = shown;
                cx.update_global::<milagre_gpui_spike::settings::host::SettingsHost, _>(|host, _| host.visit += 1);
                cx.refresh_windows();
            }
            this.settings_open = open;
        })
        .detach();
        let mut this = Self {
            daemon,
            workspace: workspace.downgrade(),
            host: None,
            reading: false,
            waiting: false,
            main_sync: None,
            idle: Vec::new(),
            toast: None,
            write_seq: 0,
            writing: 0,
            read_seq: None,
            read_again: false,
            keys_busy: false,
            settings_open: settings.read(cx).is_open(),
            shown_page: None,
            opened_file: cx.global::<KeybindingsStore>().opened_file,
            sent: Vec::new(),
            refused: Vec::new(),
            errors: Vec::new(),
            reads: 0,
        };
        this.follow_display(cx);
        // A read-only snapshot opened on Settings (`--snapshot` with `MILAGRE_GPUI_SETTINGS`) draws once, so it is read
        // before the first frame.
        let snapshot = this.daemon.read_only() && std::env::var_os("MILAGRE_GPUI_SETTINGS").is_some();
        match this.project().filter(|_| snapshot) {
            Some(project) => {
                let mut calls: Vec<(&'static str, Value)> = READS.iter().map(|m| (*m, json!([]))).collect();
                calls.push(("keybindings:read", json!([])));
                let daemon = this.daemon.clone();
                let answers = futures::executor::block_on(off_thread(move || {
                    futures::executor::block_on(daemon.read_many(&project, calls)).map_err(|e| format!("{e:#}"))
                }))
                .unwrap_or_else(|_| Err("The read thread ended.".into()));
                this.reading = true;
                this.read_seq = Some(0);
                this.settle_read(answers, cx);
            }
            None => this.read(cx),
        }
        this
    }

    /// The Project whose connection carries Settings' reads and writes: the live one, else the most recent.
    fn project(&self) -> Option<String> {
        project_of(&self.daemon)
    }

    /// Reads every section's host-kept values and this computer's keybindings.
    pub fn read(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            // Asked again meanwhile (Settings opened): once more after this one.
            self.read_again = true;
            return;
        }
        let Some(project) = self.project() else {
            // The daemon's Projects are not known yet (the first sync): ask again shortly.
            if !self.waiting {
                self.waiting = true;
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
                    let _ = this.update(cx, |this, cx| {
                        this.waiting = false;
                        this.read(cx);
                    });
                })
                .detach();
            }
            return;
        };
        self.reading = true;
        self.read_seq = (self.writing == 0).then_some(self.write_seq);
        let daemon = self.daemon.clone();
        let work = off_thread(move || {
            futures::executor::block_on(async {
                let mut calls: Vec<(&'static str, Value)> = READS.iter().map(|m| (*m, json!([]))).collect();
                calls.push(("keybindings:read", json!([])));
                daemon.read_many(&project, calls).await.map_err(|e| format!("{e:#}"))
            })
        });
        cx.spawn(async move |this, cx| {
            let answers = work.await.unwrap_or_else(|_| Err("The read thread ended.".into()));
            let _ = this.update(cx, |this, cx| this.settle_read(answers, cx));
        })
        .detach();
    }

    fn settle_read(&mut self, answers: Result<Vec<anyhow::Result<Value>>, String>, cx: &mut Context<Self>) {
        self.reading = false;
        self.reads += 1;
        let answers = match answers {
            Ok(answers) => answers,
            Err(error) => {
                eprintln!("live: couldn't read Settings: {error}");
                self.errors.push(format!("read: {error}"));
                return;
            }
        };
        self.show_read(answers, cx);
        if self.read_again && self.writing == 0 {
            self.read_again = false;
            self.read(cx);
        }
    }

    fn show_read(&mut self, answers: Vec<anyhow::Result<Value>>, cx: &mut Context<Self>) {
        let mut host = Host::of(cx.global::<SettingsStore>());
        let mut version = None;
        let mut keys = None;
        let mut main_sync = None;
        let mut idle = None;
        let methods = READS.iter().copied().chain(["keybindings:read"]);
        for (method, answer) in methods.zip(answers) {
            match answer {
                Ok(value) if method == "app:version" => version = value.as_str().map(str::to_owned),
                Ok(value) if method == "main-sync:default:read" => main_sync = value["syncMain"].as_bool(),
                Ok(value) if method == "storage:worktrees" => idle = Some(value),
                Ok(value) if method == "keybindings:read" => {
                    keys = Some(keybindings_state(&value).ok_or_else(|| "keybindings.json couldn't be read.".to_owned()))
                }
                Ok(value) => host.apply(method, &value),
                Err(error) => {
                    eprintln!("live: couldn't read {method}: {error:#}");
                    self.errors.push(format!("{method}: {error:#}"));
                    if method == "keybindings:read" {
                        keys = Some(Err(format!("Couldn't read the keybindings: {error:#}")));
                    }
                }
            }
        }
        // A write crossed this read: what it read may be older than the write's answer; read again after it.
        if self.read_seq != Some(self.write_seq) {
            self.read_again = true;
            return;
        }
        // Held first: the store's observer then sees nothing to write.
        self.host = Some(host);
        cx.update_global::<SettingsStore, _>(|store, _| {
            host.put(store);
            if version.is_some() {
                store.milagre_version = version;
            }
        });
        if main_sync.is_some() {
            self.main_sync = main_sync;
        }
        if let Some(idle) = &idle {
            self.idle = idle["worktrees"].as_array().cloned().unwrap_or_default();
        }
        let removing = cx.try_global::<milagre_gpui_spike::settings::devices::cleanup::CleanupState>().is_some_and(|c| c.progress.is_some());
        cx.update_global::<DevicesStore, _>(|store, _| {
            if let Some(on) = main_sync {
                store.main_sync_default = on;
            }
            // Not under a cleanup that is removing: its list goes as it removes.
            if let (Some(idle), false) = (&idle, removing) {
                store.idle = idle_worktrees(idle);
            }
        });
        if let Some(keys) = keys {
            // A write in flight answers with the file as it ends; this read could be older.
            if !self.keys_busy {
                cx.update_global::<KeybindingsStore, _>(|store, _| store.set_read(LOCAL, keys));
            }
        }
        cx.refresh_windows();
    }

    fn store_changed(&mut self, cx: &mut Context<Self>) {
        self.follow_display(cx);
        let Some(before) = self.host else { return };
        let after = Host::of(cx.global::<SettingsStore>());
        if after == before {
            return;
        }
        let writes = writes(&before, &after);
        self.host = Some(after);
        self.send(writes, before, cx);
    }

    /// The transcript follows Settings › Chat's reasoning and tool calls.
    fn follow_display(&mut self, cx: &mut Context<Self>) {
        let Some(workspace) = self.workspace.upgrade() else { return };
        let (shown, expand) = display(cx.global::<SettingsStore>());
        let transcript = workspace.read(cx).chat.read(cx).transcript.clone();
        transcript.update(cx, |t, cx| t.set_display(shown, expand, cx));
    }

    fn send(&mut self, writes: Vec<(&'static str, Value)>, before: Host, cx: &mut Context<Self>) {
        if writes.is_empty() {
            return;
        }
        let Some(project) = self.project().filter(|_| !self.daemon.read_only()) else {
            let mut host = self.host.unwrap_or(before);
            for (method, _) in &writes {
                eprintln!("live: read-only, not sent: {method}");
                self.refused.push((*method).to_owned());
                host.revert(method, &before);
            }
            self.put_back(host, "Read-only: nothing is written to Milagre's daemon in this window.".to_owned(), cx);
            return;
        };
        self.sent.extend(writes.iter().map(|(method, args)| ((*method).to_owned(), args.clone())));
        self.write_seq += 1;
        self.writing += 1;
        let daemon = self.daemon.clone();
        let calls = writes.clone();
        let work = off_thread(move || {
            futures::executor::block_on(async {
                let writer = match daemon.writer(&project).await {
                    Ok(writer) => writer,
                    Err(error) => return calls.iter().map(|(m, _)| (*m, Err(format!("{error:#}")))).collect::<Vec<_>>(),
                };
                let mut answers = Vec::new();
                for (method, args) in calls {
                    answers.push((method, writer.call(method, args).await.map_err(|e| format!("{e:#}"))));
                }
                drop(writer);
                answers
            })
        });
        cx.spawn(async move |this, cx| {
            let answers = work.await.unwrap_or_default();
            let _ = this.update(cx, |this, cx| this.settle_writes(answers, before, cx));
        })
        .detach();
    }

    fn settle_writes(&mut self, answers: Vec<(&'static str, Result<Value, String>)>, before: Host, cx: &mut Context<Self>) {
        self.writing -= 1;
        if self.writing == 0 && self.read_again && !self.reading {
            self.read_again = false;
            self.read(cx);
        }
        let mut host = self.host.unwrap_or(before);
        let mut failed = None;
        for (method, answer) in answers {
            match answer {
                Ok(value) => host.apply(method, &value),
                Err(error) => {
                    self.errors.push(format!("{method}: {error}"));
                    host.revert(method, &before);
                    failed = Some(error);
                }
            }
        }
        match failed {
            Some(error) => self.put_back(host, format!("Couldn't save the setting: {error}"), cx),
            None => {
                self.host = Some(host);
                cx.update_global::<SettingsStore, _>(|store, _| host.put(store));
            }
        }
    }

    /// The store back on `host`, and why in the sidebar.
    fn put_back(&mut self, host: Host, notice: String, cx: &mut Context<Self>) {
        self.host = Some(host);
        cx.update_global::<SettingsStore, _>(|store, _| host.put(store));
        if let Some(workspace) = self.workspace.upgrade() {
            let sidebar = workspace.read(cx).sidebar.clone();
            sidebar.update(cx, |s, cx| s.set_notice(Some(notice.into()), cx));
        }
        cx.refresh_windows();
    }

    /// Settings › Worktrees' default changed (written at once), or a cleanup ended (the list read again).
    fn devices_changed(&mut self, cx: &mut Context<Self>) {
        let store = cx.global::<DevicesStore>();
        let (on, toast) = (store.main_sync_default, store.last_toast.clone());
        if toast != self.toast {
            self.toast = toast;
            self.read(cx);
        }
        let Some(held) = self.main_sync else { return };
        if on == held {
            return;
        }
        self.main_sync = Some(on);
        let Some(project) = self.project().filter(|_| !self.daemon.read_only()) else {
            eprintln!("live: read-only, not sent: main-sync:default:save");
            self.refused.push("main-sync:default:save".to_owned());
            self.main_sync = Some(held);
            cx.update_global::<DevicesStore, _>(|store, _| store.main_sync_default = held);
            self.notice("Read-only: nothing is written to Milagre's daemon in this window.".to_owned(), cx);
            return;
        };
        self.sent.push(("main-sync:default:save".to_owned(), json!([on])));
        let work = self.write_one(project, "main-sync:default:save", json!([on]));
        cx.spawn(async move |this, cx| {
            let answer = work.await.unwrap_or_else(|_| Err("The write thread ended.".into()));
            let _ = this.update(cx, |this, cx| {
                let next = match &answer {
                    Ok(value) => value["syncMain"].as_bool().unwrap_or(on),
                    Err(_) => held,
                };
                this.main_sync = Some(next);
                cx.update_global::<DevicesStore, _>(|store, _| store.main_sync_default = next);
                if let Err(error) = answer {
                    this.errors.push(format!("main-sync:default:save: {error}"));
                    this.notice(format!("Couldn't save the setting: {error}"), cx);
                }
            });
        })
        .detach();
    }

    /// One write on a request-only connection of `project`, off the UI thread.
    fn write_one(&self, project: String, method: &'static str, args: Value) -> futures::channel::oneshot::Receiver<Result<Value, String>> {
        let daemon = self.daemon.clone();
        off_thread(move || {
            futures::executor::block_on(async {
                let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                let answer = writer.call(method, args).await.map_err(|e| format!("{e:#}"));
                drop(writer);
                answer
            })
        })
    }

    /// Clean up worktrees' removal of one listed worktree (`storage:remove-worktree`, as `removeIdleWorktrees` sends it).
    pub fn remove_worktree(&mut self, path: &str, cx: &mut Context<Self>) -> gpui::Task<Result<(), String>> {
        let Some(item) = self.idle.iter().find(|item| item["path"] == path).cloned() else {
            return gpui::Task::ready(Err("It is no longer in the list.".to_owned()));
        };
        let Some(project) = self.project().filter(|_| !self.daemon.read_only()) else {
            eprintln!("live: read-only, not sent: storage:remove-worktree");
            self.refused.push("storage:remove-worktree".to_owned());
            return gpui::Task::ready(Err("Read-only: nothing is removed in this window.".to_owned()));
        };
        let request = remove_request(&item);
        self.sent.push(("storage:remove-worktree".to_owned(), json!([request.clone()])));
        let work = self.write_one(project, "storage:remove-worktree", json!([request]));
        cx.spawn(async move |this, cx| {
            let answer = work.await.unwrap_or_else(|_| Err("The write thread ended.".into()));
            if let Err(error) = &answer {
                let _ = this.update(cx, |this, _| this.errors.push(format!("storage:remove-worktree: {error}")));
            }
            answer.map(|_| ())
        })
    }

    fn notice(&self, notice: String, cx: &mut Context<Self>) {
        if let Some(workspace) = self.workspace.upgrade() {
            let sidebar = workspace.read(cx).sidebar.clone();
            sidebar.update(cx, |s, cx| s.set_notice(Some(notice.into()), cx));
        }
    }

    fn keys_changed(&mut self, cx: &mut Context<Self>) {
        let opened = cx.global::<KeybindingsStore>().opened_file;
        if opened != self.opened_file {
            self.opened_file = opened;
            let path = cx.global::<KeybindingsStore>().get(LOCAL).state.path;
            open_file(&path, cx);
        }
        if self.keys_busy || cx.global::<KeybindingsStore>().outbox.is_empty() {
            return;
        }
        let outbox = cx.update_global::<KeybindingsStore, _>(|store, _| std::mem::take(&mut store.outbox));
        let writes: Vec<(&'static str, Value)> = outbox.iter().map(key_write).collect();
        let project = self.project().filter(|_| !self.daemon.read_only());
        let Some(project) = project else {
            for (method, _) in &writes {
                eprintln!("live: read-only, not sent: {method}");
                self.refused.push((*method).to_owned());
            }
            // The page goes back to the file as it is.
            self.read(cx);
            if let Some(workspace) = self.workspace.upgrade() {
                let sidebar = workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| {
                    s.set_notice(Some("Read-only: nothing is written to Milagre's daemon in this window.".into()), cx)
                });
            }
            return;
        };
        self.keys_busy = true;
        self.sent.extend(writes.iter().map(|(method, args)| ((*method).to_owned(), args.clone())));
        let daemon = self.daemon.clone();
        let work = off_thread(move || {
            futures::executor::block_on(async {
                let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
                let mut last = Value::Null;
                for (method, args) in writes {
                    last = writer.call(method, args).await.map_err(|e| format!("{method}: {e:#}"))?;
                }
                drop(writer);
                Ok::<Value, String>(last)
            })
        });
        cx.spawn(async move |this, cx| {
            let answer = work.await.unwrap_or_else(|_| Err("The write thread ended.".into()));
            let _ = this.update(cx, |this, cx| {
                this.keys_busy = false;
                match answer.map(|value| keybindings_state(&value)) {
                    Ok(Some(state)) => cx.update_global::<KeybindingsStore, _>(|store, _| store.set_read(LOCAL, Ok(state))),
                    Ok(None) => this.read(cx),
                    Err(error) => {
                        this.errors.push(error.clone());
                        this.read(cx);
                        if let Some(workspace) = this.workspace.upgrade() {
                            let sidebar = workspace.read(cx).sidebar.clone();
                            sidebar.update(cx, |s, cx| s.set_notice(Some(format!("Couldn't save the keybinding: {error}").into()), cx));
                        }
                    }
                }
                // Edits made meanwhile.
                this.keys_changed(cx);
                cx.refresh_windows();
            });
        })
        .detach();
    }
}

/// "Open keybindings.json": the file in Settings' editor, else the system's text editor (`app:open-keybindings-file`
/// is Electron's). Recorded instead under [`crate::opener::DryRun`].
fn open_file(path: &str, cx: &mut App) {
    let home = crate::setup::home();
    let path = match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => std::path::PathBuf::from(path),
    };
    let choice = cx.global::<SettingsStore>().default_editor.as_str().to_owned();
    if let Some(dry) = cx.try_global::<crate::opener::DryRun>() {
        dry.0.borrow_mut().push(format!("file {} {choice}", path.display()));
        return;
    }
    cx.background_executor()
        .spawn(async move {
            if !path.is_absolute() || !path.is_file() {
                return;
            }
            let editors = crate::opener::detect();
            let mut command = std::process::Command::new("/usr/bin/open");
            match crate::opener::pick(&editors, &choice).and_then(|e| e.app.clone()) {
                Some(app) => command.arg("-a").arg(app),
                None => command.arg("-t"),
            };
            let _ = command.arg(&path).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).status();
        })
        .detach();
}
