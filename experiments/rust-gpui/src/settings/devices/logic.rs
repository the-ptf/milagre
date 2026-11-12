//! The rules behind the Devices, This Mac, Computer and Worktrees pages, ported from the shared TypeScript so the
//! words and numbers match: `packages/shared/src/computer-resources.ts` (gauges and breakdown), `storage.ts` (Clean up
//! worktrees), `main-sync.ts` (`ago`, the status line), `app-update.ts`, `computer-use.ts`; and the desktop's
//! `lib/devices.ts`, `lib/phone.ts` and `lib/computers.ts` (`routeLine`, `seenAgo`).
//!
//! Plain functions over plain data: no GPUI, so the unit tests below pin the same expectations the TypeScript tests do.

pub const MINUTE_MS: i64 = 60_000;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
pub const DAY_MS: i64 = 24 * HOUR_MS;
const MINUTE: i64 = MINUTE_MS;
const HOUR: i64 = HOUR_MS;
const DAY: i64 = DAY_MS;

/// `plural(count, word)`: `1 worktree`, `3 worktrees`.
pub fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

/// A JS number printed the way a template string would: no trailing `.0`.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

fn format_bytes(bytes: f64, unit: f64) -> String {
    let units = ["KB", "MB", "GB", "TB"];
    let bytes = if bytes.is_finite() { bytes.max(0.0) } else { 0.0 };
    let mut value = bytes / unit;
    let mut index = 0;
    while value >= unit && index < units.len() - 1 {
        value /= unit;
        index += 1;
    }
    let mut rounded = if value >= 100.0 { value.round() } else { (value * 10.0).round() / 10.0 };
    // 999.96 MB rounds to 1000: that is 1 GB.
    if rounded >= unit && index < units.len() - 1 {
        index += 1;
        rounded = ((value / unit) * 10.0).round() / 10.0;
    }
    format!("{} {}", js_number(rounded), units[index])
}

/// Memory in binary units, as Activity Monitor shows it: 24 GB for a 24 GB Mac (`formatMemory`).
pub fn format_memory(bytes: f64) -> String {
    format_bytes(bytes, 1024.0)
}

/// Disk in decimal units, as Finder shows it (`formatDisk`).
pub fn format_disk(bytes: f64) -> String {
    format_bytes(bytes, 1000.0)
}

pub const GB: f64 = 1024.0 * 1024.0 * 1024.0;
pub const DISK_GB: f64 = 1_000_000_000.0;

// -- Resources ------------------------------------------------------------------------------------------------------

/// What a part of Milagre's share is (`ResourcePartKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartKind {
    Claude,
    Codex,
    Antigravity,
    Kiro,
    Terminals,
    App,
    Worktrees,
    Chats,
    Checkpoints,
    Agents,
    Browser,
    Designs,
    Caches,
    Data,
}

/// `ResourcePart`: `count` is agents or terminals running, or worktrees on disk; 0 where nothing is counted.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Part {
    pub kind: PartKind,
    pub bytes: f64,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MemoryResources {
    pub total: f64,
    pub available: f64,
    pub milagre: Option<f64>,
    pub parts: Vec<Part>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiskResources {
    pub total: f64,
    pub available: f64,
    pub milagre: Option<f64>,
    pub parts: Vec<Part>,
    pub measuring: bool,
}

/// `ComputerResources`: what `computer:resources:read` answers.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputerResources {
    pub memory: MemoryResources,
    pub disk: Option<DiskResources>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GaugeKind {
    Memory,
    Disk,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GaugePart {
    pub kind: PartKind,
    /// "Claude · 3 agents"
    pub label: String,
    /// "1.4 GB"
    pub value: String,
    /// Its share of the whole gauge.
    pub share: f64,
    /// Its share of Milagre's amount alone.
    pub portion: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shares {
    pub milagre: f64,
    pub other: f64,
    pub free: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gauge {
    pub kind: GaugeKind,
    /// "11 GB"
    pub free: String,
    /// "free of 24 GB"
    pub of: String,
    /// Under a tenth free: the row turns orange.
    pub low: bool,
    pub measuring: bool,
    pub refreshing: bool,
    pub shares: Shares,
    pub tooltip: String,
    pub milagre: Option<String>,
    pub parts: Vec<GaugePart>,
}

pub const BREAKDOWN_TITLE: &str = "What Milagre uses";
pub const MEASURING_TOOLTIP: &str = "Measuring Milagre's folders";
pub const UNREADABLE: &str = "Couldn't read this computer's memory and disk.";
const LOW_SHARE: f64 = 0.1;

fn shares(total: f64, available: f64, milagre: Option<f64>) -> Shares {
    if total <= 0.0 {
        return Shares { milagre: 0.0, other: 0.0, free: 1.0 };
    }
    let free = available.clamp(0.0, total);
    let ours = milagre.unwrap_or(0.0).max(0.0).min(total - free);
    Shares { milagre: ours / total, other: (total - free - ours) / total, free: free / total }
}

pub fn part_label(part: &Part) -> String {
    let agents = |name: &str| if part.count > 0 { format!("{name} \u{b7} {}", plural(part.count, "agent")) } else { name.to_string() };
    match part.kind {
        PartKind::Claude => agents("Claude"),
        PartKind::Codex => agents("Codex"),
        PartKind::Antigravity => agents("Antigravity"),
        PartKind::Kiro => agents("Kiro"),
        PartKind::Terminals if part.count > 0 => format!("Terminals \u{b7} {}", part.count),
        PartKind::Terminals => "Terminals".into(),
        PartKind::App => "Milagre app".into(),
        PartKind::Worktrees if part.count > 0 => format!("Worktrees \u{b7} {}", part.count),
        PartKind::Worktrees => "Worktrees".into(),
        PartKind::Chats => "Chat history".into(),
        PartKind::Checkpoints => "Checkpoints".into(),
        PartKind::Agents => "Agent tools".into(),
        PartKind::Browser => "Browser data".into(),
        PartKind::Designs => "Designs".into(),
        PartKind::Caches => "Caches".into(),
        PartKind::Data => "Other app data".into(),
    }
}

fn gauge_parts(parts: &[Part], milagre_share: f64, format: fn(f64) -> String) -> Vec<GaugePart> {
    let mut known: Vec<Part> = parts.iter().copied().filter(|part| part.bytes.is_finite() && part.bytes > 0.0).collect();
    let sum: f64 = known.iter().map(|part| part.bytes).sum();
    if sum <= 0.0 {
        return Vec::new();
    }
    known.sort_by(|a, b| b.bytes.total_cmp(&a.bytes));
    known
        .iter()
        .map(|part| GaugePart {
            kind: part.kind,
            label: part_label(part),
            value: format(part.bytes),
            share: part.bytes / sum * milagre_share,
            portion: part.bytes / sum,
        })
        .collect()
}

/// `resourceGauges`: the rows for one answer; the disk is `None` when the host could not read it, and the whole answer
/// `None` when it can't be read at all.
pub fn resource_gauges(resources: &ComputerResources) -> Option<(Gauge, Option<Gauge>)> {
    let memory = &resources.memory;
    if !memory.total.is_finite() || !memory.available.is_finite() {
        return None;
    }
    let memory_shares = shares(memory.total, memory.available, memory.milagre);
    let memory_gauge = Gauge {
        kind: GaugeKind::Memory,
        free: format_memory(memory.available),
        of: format!("free of {}", format_memory(memory.total)),
        low: memory.total > 0.0 && memory.available / memory.total < LOW_SHARE,
        measuring: false,
        refreshing: false,
        shares: memory_shares,
        tooltip: match memory.milagre {
            None => format!("Other apps {}", format_memory(memory.total - memory.available)),
            Some(milagre) => {
                format!("Milagre {} \u{b7} Other apps {}", format_memory(milagre), format_memory(memory_shares.other * memory.total))
            }
        },
        milagre: memory.milagre.map(format_memory),
        parts: gauge_parts(&memory.parts, memory_shares.milagre, format_memory),
    };
    let Some(disk) = resources.disk.as_ref().filter(|disk| disk.total.is_finite() && disk.available.is_finite()) else {
        return Some((memory_gauge, None));
    };
    let disk_shares = shares(disk.total, disk.available, disk.milagre);
    let measuring = disk.milagre.is_none();
    let disk_gauge = Gauge {
        kind: GaugeKind::Disk,
        free: format_disk(disk.available),
        of: format!("free of {}", format_disk(disk.total)),
        low: disk.total > 0.0 && disk.available / disk.total < LOW_SHARE,
        measuring,
        refreshing: !measuring && disk.measuring,
        shares: disk_shares,
        tooltip: if measuring {
            MEASURING_TOOLTIP.to_string()
        } else {
            format!(
                "Milagre {} \u{b7} Everything else {}",
                format_disk(disk.milagre.unwrap_or(0.0)),
                format_disk(disk_shares.other * disk.total)
            )
        },
        milagre: if measuring { None } else { Some(format_disk(disk.milagre.unwrap_or(0.0))) },
        parts: gauge_parts(&disk.parts, disk_shares.milagre, format_disk),
    };
    Some((memory_gauge, Some(disk_gauge)))
}

/// `PART_OPACITY` / `partOpacity`: the opacity of a part's slice of the accent colour, largest first.
pub const PART_OPACITY: [f32; 6] = [1.0, 0.7, 0.5, 0.35, 0.22, 0.14];

pub fn part_opacity(index: usize) -> f32 {
    PART_OPACITY[index.min(PART_OPACITY.len() - 1)]
}

// -- Time -----------------------------------------------------------------------------------------------------------

/// `ago` (main-sync.ts): "just now", "5 min ago", "3 h ago" or "2 d ago".
pub fn ago(at: i64, now: i64) -> String {
    let elapsed = now - at;
    if elapsed < MINUTE {
        "just now".into()
    } else if elapsed < HOUR {
        format!("{} min ago", elapsed / MINUTE)
    } else if elapsed < DAY {
        format!("{} h ago", elapsed / HOUR)
    } else {
        format!("{} d ago", elapsed / DAY)
    }
}

/// `seenAgo` (lib/computers.ts): "just now", "5 min ago", "2h ago", "3d ago".
pub fn seen_ago(last_seen: Option<i64>, now: i64) -> Option<String> {
    let last_seen = last_seen?;
    let minutes = ((now - last_seen) / MINUTE).max(0);
    Some(if minutes < 1 {
        "just now".into()
    } else if minutes < 60 {
        format!("{minutes} min ago")
    } else if minutes < 24 * 60 {
        format!("{}h ago", minutes / 60)
    } else {
        format!("{}d ago", minutes / (24 * 60))
    })
}

// -- Computers ------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Lan,
    Relay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Online,
    Connecting,
    Reconnecting,
    Offline,
    Refused,
}

/// A paired computer as its page reads it (`ComputerView`).
#[derive(Clone, Debug, PartialEq)]
pub struct ComputerView {
    pub id: String,
    pub name: String,
    pub state: Reach,
    pub route: Option<Route>,
    pub relay_host: String,
    pub lan_routes: Vec<String>,
    pub last_seen: Option<i64>,
    pub added_at: Option<i64>,
    pub message: Option<String>,
}

/// `routeLine`: the second line under a computer's name.
pub fn route_line(view: &ComputerView, now: i64) -> String {
    match view.state {
        Reach::Online if view.route == Some(Route::Lan) => "Same network".into(),
        Reach::Online => view.relay_host.clone(),
        Reach::Connecting => "Connecting\u{2026}".into(),
        Reach::Reconnecting => view.message.clone().unwrap_or_else(|| "Reconnecting\u{2026}".into()),
        Reach::Offline => match seen_ago(view.last_seen, now) {
            Some(ago) => format!("Offline, seen {ago}"),
            None => "Offline".into(),
        },
        Reach::Refused => view.message.clone().unwrap_or_else(|| "Pair again with a new link.".into()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteState {
    InUse,
    Ready,
    NotAvailable,
}

impl RouteState {
    pub fn label(self) -> &'static str {
        match self {
            RouteState::InUse => "In use",
            RouteState::Ready => "Ready",
            RouteState::NotAvailable => "Not available",
        }
    }
}

/// The Same network pill of a Computer page.
pub fn lan_state(view: &ComputerView) -> RouteState {
    if view.state == Reach::Online && view.route == Some(Route::Lan) {
        RouteState::InUse
    } else if !view.lan_routes.is_empty() {
        RouteState::Ready
    } else {
        RouteState::NotAvailable
    }
}

/// The Relay pill of a Computer page.
pub fn relay_state(view: &ComputerView) -> RouteState {
    if view.state == Reach::Online && view.route == Some(Route::Relay) { RouteState::InUse } else { RouteState::Ready }
}

/// A Computer page's status line: "Connected · Milagre 0.232.0 · paired Oct 21".
pub fn computer_status_line(view: &ComputerView, version: Option<&str>, paired: Option<&str>, now: i64) -> String {
    let first = if view.state == Reach::Online { "Connected".to_string() } else { route_line(view, now) };
    [Some(first), version.map(|v| format!("Milagre {v}")), paired.map(|p| format!("paired {p}"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

// -- Devices --------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    Phone,
    Computer,
}

/// `PairedDevice`.
#[derive(Clone, Debug, PartialEq)]
pub struct PairedDevice {
    pub key: String,
    pub kind: DeviceKind,
    pub name: Option<String>,
    pub last_seen: Option<i64>,
    pub is_new: bool,
    pub route: Option<Route>,
}

/// `deviceName`.
pub fn device_name(device: &PairedDevice) -> String {
    device.name.clone().unwrap_or_else(|| if device.kind == DeviceKind::Computer { "Computer".into() } else { "Phone".into() })
}

/// `deviceSeenLine`.
pub fn device_seen_line(device: &PairedDevice, now: i64) -> String {
    match (device.route, device.last_seen) {
        (Some(Route::Lan), _) => "Connected now, same network".into(),
        (Some(Route::Relay), _) => "Connected now, relay".into(),
        (None, None) => "Not seen yet".into(),
        (None, Some(at)) => format!("Last seen {}", ago(at, now)),
    }
}

/// `removeDeviceQuestion`.
pub fn remove_device_question(device: &PairedDevice) -> String {
    format!("Remove {}? It can pair again from Pair a device.", device_name(device))
}

/// `devicesByKind`: the two lists, each with what is connected first and then the most recently seen.
pub fn devices_by_kind(devices: &[PairedDevice]) -> (Vec<PairedDevice>, Vec<PairedDevice>) {
    let order = |a: &PairedDevice, b: &PairedDevice| {
        b.route.is_some().cmp(&a.route.is_some()).then(b.last_seen.unwrap_or(-1).cmp(&a.last_seen.unwrap_or(-1)))
    };
    let mut computers: Vec<PairedDevice> = devices.iter().filter(|d| d.kind == DeviceKind::Computer).cloned().collect();
    let mut phones: Vec<PairedDevice> = devices.iter().filter(|d| d.kind == DeviceKind::Phone).cloned().collect();
    computers.sort_by(order);
    phones.sort_by(order);
    (computers, phones)
}

// -- Phone ----------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhoneState {
    Off,
    Starting,
    On,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remote {
    Cloudflare,
    Relay,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayLink {
    Connecting,
    Online,
    Offline,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Lan {
    pub enabled: bool,
    pub addresses: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PairingOption {
    pub id: String,
    pub label: String,
}

/// `PhoneStatus`, trimmed to what the page reads.
#[derive(Clone, Debug, PartialEq)]
pub struct PhoneStatus {
    pub enabled: bool,
    pub state: PhoneState,
    pub error: Option<String>,
    pub remote: Remote,
    pub relay: Option<RelayLink>,
    pub pairing_until: Option<i64>,
    pub local_host: String,
    pub public_host: Option<String>,
    pub pairing_link: String,
    pub pairing_options: Vec<PairingOption>,
    pub lan: Option<Lan>,
}

/// `phoneStatusLine`: the one line under "Allow devices to connect".
pub fn phone_status_line(status: Option<&PhoneStatus>) -> String {
    let Some(status) = status else { return "Checking\u{2026}".into() };
    match status.state {
        PhoneState::Off => "Off".into(),
        PhoneState::Starting => "Starting\u{2026}".into(),
        PhoneState::Error => status.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| "Phone access stopped.".into()),
        PhoneState::On => match (status.remote, &status.public_host) {
            (Remote::Cloudflare, Some(host)) => format!("Reachable at {host}"),
            (Remote::Relay, _) => match status.relay {
                Some(RelayLink::Online) => "On, reachable from any network".into(),
                Some(RelayLink::Offline) => "On, can't reach the relay. Retrying\u{2026}".into(),
                _ => "On, connecting to the relay\u{2026}".into(),
            },
            _ => format!("This Mac only \u{2014} {}", status.local_host),
        },
    }
}

/// `phoneLanLine`: the line under "Allow on local network". `None` until the daemon reports it.
pub fn phone_lan_line(status: &PhoneStatus) -> Option<String> {
    let lan = status.lan.as_ref()?;
    Some(if !lan.enabled {
        "Off".into()
    } else if let Some(error) = &lan.error {
        format!("Couldn't listen on the local network: {error}")
    } else if lan.addresses.is_empty() {
        "Not connected to a local network".into()
    } else {
        format!("Reachable at {}", lan.addresses.join(", "))
    })
}

/// `cloudflarePhonesNote`.
pub fn cloudflare_phones_note(status: &PhoneStatus) -> Option<&'static str> {
    (status.remote == Remote::Cloudflare).then_some("Phones on your Cloudflare tunnel keep access until Reset access.")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairingWindow {
    pub open: bool,
    pub minutes: i64,
}

/// `pairingWindow`: whether new devices may still pair, and for how many whole minutes (rounded up).
pub fn pairing_window(status: &PhoneStatus, now: i64) -> Option<PairingWindow> {
    let until = status.pairing_until?;
    let left = until - now;
    Some(if left > 0 {
        PairingWindow { open: true, minutes: (left + MINUTE - 1) / MINUTE }
    } else {
        PairingWindow { open: false, minutes: 0 }
    })
}

/// The line beside the pairing countdown.
pub fn pairing_line(window: PairingWindow) -> String {
    if window.open {
        format!("New devices can pair for {} more {}", window.minutes, if window.minutes == 1 { "minute" } else { "minutes" })
    } else {
        "Pairing is closed to new devices.".into()
    }
}

// -- Storage --------------------------------------------------------------------------------------------------------

pub const CLEANUP_TITLE: &str = "Clean up worktrees";
pub const CLEANUP_BUTTON: &str = "Clean up worktrees\u{2026}";
pub const CLEANUP_INTRO: &str = "Worktrees Milagre made that no Chat has used for a while. Their Chats are deleted with them.";
pub const SAVED_GROUP: &str = "No unsaved work";
pub const UNSAVED_GROUP: &str = "Unsaved work";
pub const IDLE_DAYS: [u32; 3] = [30, 60, 90];

/// `WorktreeStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorktreeStatus {
    pub uncommitted: usize,
    pub unpushed: usize,
    pub removable: bool,
}

/// `IdleWorktree`.
#[derive(Clone, Debug, PartialEq)]
pub struct IdleWorktree {
    pub project_name: String,
    pub path: String,
    pub branch: Option<String>,
    pub title: String,
    pub chats: usize,
    pub last_at: i64,
    pub bytes: Option<f64>,
    pub status: WorktreeStatus,
}

/// `lossReason` (archive.mjs).
pub fn loss_reason(status: &WorktreeStatus) -> String {
    let mut parts = Vec::new();
    if status.uncommitted > 0 {
        parts.push(plural(status.uncommitted, "uncommitted file"));
    }
    if status.unpushed > 0 {
        parts.push(plural(status.unpushed, "unpushed commit"));
    }
    if parts.is_empty() {
        return "Its HEAD is detached, so what it holds isn't on a branch".into();
    }
    format!("{} will be lost", parts.join(" and "))
}

/// `idleFor`: the worktrees unused for at least `days`, oldest first.
pub fn idle_for(list: &[IdleWorktree], days: u32, now: i64) -> Vec<IdleWorktree> {
    let cutoff = now - i64::from(days) * DAY;
    let mut kept: Vec<IdleWorktree> = list.iter().filter(|item| item.last_at <= cutoff).cloned().collect();
    kept.sort_by_key(|item| item.last_at);
    kept
}

/// `cleanupGroups`: removed safely, and removed only with what they hold.
pub fn cleanup_groups(list: &[IdleWorktree]) -> (Vec<IdleWorktree>, Vec<IdleWorktree>) {
    (list.iter().filter(|i| i.status.removable).cloned().collect(), list.iter().filter(|i| !i.status.removable).cloned().collect())
}

fn size_of(list: &[IdleWorktree]) -> f64 {
    list.iter().map(|item| item.bytes.unwrap_or(0.0)).sum()
}

fn measured(list: &[IdleWorktree]) -> bool {
    !list.is_empty() && list.iter().all(|item| item.bytes.is_some())
}

/// `groupLine`: "3 worktrees \u{b7} 2.1 GB".
pub fn group_line(list: &[IdleWorktree]) -> String {
    if list.is_empty() {
        return "None".into();
    }
    if measured(list) {
        format!("{} \u{b7} {}", plural(list.len(), "worktree"), format_disk(size_of(list)))
    } else {
        plural(list.len(), "worktree")
    }
}

/// `selectionLine`: what is selected and what goes with it.
pub fn selection_line(selected: &[IdleWorktree]) -> String {
    if selected.is_empty() {
        return "Choose the worktrees to remove.".into();
    }
    let size = if measured(selected) { format!(" \u{b7} {}", format_disk(size_of(selected))) } else { String::new() };
    let chats: usize = selected.iter().map(|item| item.chats).sum();
    let unsaved = selected.iter().filter(|item| !item.status.removable).count();
    let loses = if unsaved > 0 { format!(" Unsaved work in {} is lost.", plural(unsaved, "worktree")) } else { String::new() };
    let them = if selected.len() == 1 { "it" } else { "them" };
    let goes = if chats > 0 {
        format!("{} on {them} {} deleted too.", plural(chats, "Chat"), if chats == 1 { "is" } else { "are" })
    } else {
        format!("No Chat is on {them}.")
    };
    format!("{} selected{size}. {goes}{loses}", plural(selected.len(), "worktree"))
}

/// `removeLabel`.
pub fn remove_label(count: usize) -> String {
    if count > 0 { format!("Remove {}", plural(count, "worktree")) } else { "Remove".into() }
}

/// `rowSize`.
pub fn row_size(item: &IdleWorktree) -> String {
    item.bytes.map_or_else(|| "\u{2014}".to_string(), format_disk)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Days since 1970-01-01 to (year, month 1-12, day), proleptic Gregorian (Hinnant's `civil_from_days`).
pub fn civil_from_days(days: i64) -> (i64, usize, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, (month - 1) as usize, day)
}

/// `rowDate`: "Sep 18", with the year when it isn't this one ("Sep 18, 2025"). UTC, like a fixture clock.
pub fn row_date(last_at: i64, now: i64) -> String {
    let (year, month, day) = civil_from_days(last_at.div_euclid(DAY));
    let (this_year, ..) = civil_from_days(now.div_euclid(DAY));
    let short = format!("{} {day}", MONTHS[month]);
    if year == this_year { short } else { format!("{short}, {year}") }
}

/// `paired Oct 21` for a Computer page's status line.
pub fn paired_date(added_at: i64) -> String {
    let (_, month, day) = civil_from_days(added_at.div_euclid(DAY));
    format!("{} {day}", MONTHS[month])
}

/// `rowDetail`: the row's second line.
pub fn row_detail(item: &IdleWorktree) -> String {
    if item.status.removable { item.project_name.clone() } else { format!("{} \u{b7} {}", item.project_name, loss_reason(&item.status)) }
}

/// `progressLine`.
pub fn progress_line(done: usize, total: usize) -> String {
    format!("{done} of {total} removed\u{2026}")
}

/// `cleanupToast`.
pub fn cleanup_toast(removed: usize, failed: &[String], stopped: bool) -> String {
    let head = if removed > 0 { format!("Removed {}.", plural(removed, "worktree")) } else { "No worktree was removed.".to_string() };
    let stop = if stopped { " Stopped before the rest." } else { "" };
    match failed {
        [] => format!("{head}{stop}"),
        [one] => format!("{head}{stop} One was kept: {one}"),
        many => format!("{head}{stop} {} were kept. {}", many.len(), many[0]),
    }
}

// -- Main sync, updates, computer use -------------------------------------------------------------------------------

pub const MAIN_SYNC_TITLE: &str = "Sync source branch before new Worktrees";
pub const MAIN_SYNC_HINT: &str = "Fast-forwards the source branch from its remote. Skipped when it has local changes or commits.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MainSyncChoice {
    Default,
    On,
    Off,
}

impl MainSyncChoice {
    pub fn value(self) -> &'static str {
        match self {
            MainSyncChoice::Default => "default",
            MainSyncChoice::On => "on",
            MainSyncChoice::Off => "off",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "on" => MainSyncChoice::On,
            "off" => MainSyncChoice::Off,
            _ => MainSyncChoice::Default,
        }
    }

    /// `overrideOf`.
    pub fn override_of(self) -> Option<bool> {
        match self {
            MainSyncChoice::Default => None,
            MainSyncChoice::On => Some(true),
            MainSyncChoice::Off => Some(false),
        }
    }

    /// `choiceOf`.
    pub fn of(override_value: Option<bool>) -> Self {
        match override_value {
            None => MainSyncChoice::Default,
            Some(true) => MainSyncChoice::On,
            Some(false) => MainSyncChoice::Off,
        }
    }
}

/// `mainSyncChoices`.
pub fn main_sync_choices(default_on: bool) -> [(&'static str, String); 3] {
    [("default", format!("Default ({})", if default_on { "On" } else { "Off" })), ("on", "On".into()), ("off", "Off".into())]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    Updated,
    UpToDate,
    Skipped,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MainSyncResult {
    pub at: i64,
    pub outcome: SyncOutcome,
    pub branch: String,
    pub commit: Option<String>,
    pub message: Option<String>,
}

/// `mainSyncStatusLine`.
pub fn main_sync_status_line(last: Option<&MainSyncResult>, now: i64) -> String {
    let Some(last) = last else { return "Not synced yet".into() };
    let when = ago(last.at, now);
    match last.outcome {
        SyncOutcome::Updated => {
            format!("Synced {} {when}{}", last.branch, last.commit.as_ref().map(|c| format!(" ({c})")).unwrap_or_default())
        }
        SyncOutcome::UpToDate => format!("{} was up to date {when}", last.branch),
        SyncOutcome::Skipped => format!("Skipped {when}: {}", last.message.as_deref().unwrap_or("nothing to do")),
        SyncOutcome::Failed => format!("Couldn't sync {when}: {}", last.message.as_deref().unwrap_or("unknown error")),
    }
}

pub const AUTO_UPDATE_TITLE: &str = "Auto update";
pub const AUTO_UPDATE_HINT: &str = "Installs a downloaded update by itself once no Chat or Routine is running and nobody has used the Mac for 5 minutes. For a Mac nobody watches, like a server.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Downloading,
    Downloaded,
    Installing,
    Error,
    Unavailable,
}

/// `HostUpdate` (a desktop app open on that computer).
#[derive(Clone, Debug, PartialEq)]
pub struct HostUpdate {
    pub status: UpdateStatus,
    pub version: Option<String>,
    pub progress: f32,
    pub error: Option<String>,
    pub auto: bool,
    pub current: String,
}

/// `updateDescription`.
pub fn update_description(update: &HostUpdate) -> String {
    match update.status {
        UpdateStatus::Checking => "Checking for updates\u{2026}".into(),
        UpdateStatus::UpToDate => "Milagre is up to date.".into(),
        UpdateStatus::Downloading => format!(
            "Downloading {}\u{2026} {}%",
            update.version.as_ref().map_or_else(|| "update".to_string(), |v| format!("Milagre {v}")),
            update.progress.round() as i64
        ),
        UpdateStatus::Downloaded => format!(
            "{} is ready to install.{}",
            update.version.as_ref().map_or_else(|| "The update".to_string(), |v| format!("Milagre {v}")),
            if update.auto { " Auto update installs it once nothing is running." } else { "" }
        ),
        UpdateStatus::Installing => "Saving your work and restarting Milagre.".into(),
        UpdateStatus::Error => update.error.clone().unwrap_or_else(|| "Couldn't check for updates. Try again.".into()),
        UpdateStatus::Unavailable => "Update checks are available in the installed app.".into(),
        UpdateStatus::Idle => "Check for the latest Milagre release.".into(),
    }
}

/// `updateBusy`.
pub fn update_busy(update: &HostUpdate) -> bool {
    matches!(update.status, UpdateStatus::Checking | UpdateStatus::Downloading | UpdateStatus::Installing | UpdateStatus::Unavailable)
}

/// `updateAvailable`.
pub fn update_available(update: &HostUpdate) -> Option<String> {
    matches!(update.status, UpdateStatus::Downloading | UpdateStatus::Downloaded)
        .then(|| update.version.as_ref().map(|v| format!("Update available: v{v}")))
        .flatten()
}

/// `installQuestion`: (title, message, action).
pub fn install_question(computer: &str, version: Option<&str>) -> (String, &'static str, &'static str) {
    (
        format!("Restart Milagre on {computer} to install {}?", version.map_or_else(|| "the update".to_string(), |v| format!("v{v}"))),
        "Running Chats are saved and resume after the restart.",
        "Install & restart",
    )
}

/// `noDesktopUpdate`.
pub fn no_desktop_update(computer: &str) -> String {
    format!("Open Milagre on {computer} to check for updates.")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    NotRequired,
    Unknown,
}

/// `permissionMissing`: a granted permission needs nothing; anything else offers the Grant button.
pub fn permission_missing(state: Permission) -> bool {
    !matches!(state, Permission::Granted | Permission::NotRequired)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(n: i64) -> i64 {
        n * DAY
    }

    #[test]
    fn bytes_print_like_the_typescript() {
        assert_eq!(format_memory(24.0 * GB), "24 GB");
        assert_eq!(format_memory(11.0 * GB), "11 GB");
        assert_eq!(format_memory(3.6 * GB), "3.6 GB");
        assert_eq!(format_disk(994.0 * DISK_GB), "994 GB");
        assert_eq!(format_disk(2_100_000_000.0), "2.1 GB");
        assert_eq!(format_disk(1_000_000_000_000.0), "1 TB");
        // 999.96 MB rounds to 1000: that is 1 GB.
        assert_eq!(format_disk(999_960_000.0), "1 GB");
        assert_eq!(format_disk(f64::NAN), "0 KB");
        assert_eq!(format_disk(-5.0), "0 KB");
    }

    fn resources(memory_available: f64, milagre: Option<f64>, disk_milagre: Option<f64>) -> ComputerResources {
        ComputerResources {
            memory: MemoryResources {
                total: 24.0 * GB,
                available: memory_available,
                milagre,
                parts: vec![
                    Part { kind: PartKind::Claude, bytes: 1.0 * GB, count: 3 },
                    Part { kind: PartKind::App, bytes: 2.0 * GB, count: 0 },
                    Part { kind: PartKind::Terminals, bytes: 0.0, count: 1 },
                ],
            },
            disk: Some(DiskResources {
                total: 1000.0 * DISK_GB,
                available: 500.0 * DISK_GB,
                milagre: disk_milagre,
                parts: Vec::new(),
                measuring: false,
            }),
        }
    }

    #[test]
    fn gauges_split_the_bar_into_milagre_other_and_free() {
        let (memory, disk) = resource_gauges(&resources(11.0 * GB, Some(3.0 * GB), Some(40.0 * DISK_GB))).expect("readable");
        assert_eq!(memory.free, "11 GB");
        assert_eq!(memory.of, "free of 24 GB");
        assert!(!memory.low);
        assert!((memory.shares.milagre + memory.shares.other + memory.shares.free - 1.0).abs() < 1e-9);
        assert_eq!(memory.tooltip, "Milagre 3 GB \u{b7} Other apps 10 GB");
        let disk = disk.expect("disk");
        assert_eq!(disk.milagre.as_deref(), Some("40 GB"));
        assert_eq!(disk.tooltip, "Milagre 40 GB \u{b7} Everything else 460 GB");
        assert!(!disk.measuring);
    }

    #[test]
    fn parts_are_largest_first_and_drop_empty_ones() {
        let (memory, _) = resource_gauges(&resources(11.0 * GB, Some(3.0 * GB), None)).expect("readable");
        let labels: Vec<&str> = memory.parts.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(labels, ["Milagre app", "Claude \u{b7} 3 agents"]);
        assert!((memory.parts.iter().map(|p| p.portion).sum::<f64>() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn low_memory_and_unmeasured_disk_are_flagged() {
        let (memory, disk) = resource_gauges(&resources(1.0 * GB, None, None)).expect("readable");
        assert!(memory.low);
        assert_eq!(memory.tooltip, "Other apps 23 GB");
        let disk = disk.expect("disk");
        assert!(disk.measuring);
        assert_eq!(disk.tooltip, MEASURING_TOOLTIP);
    }

    #[test]
    fn an_answer_that_cannot_be_read_is_none() {
        let mut broken = resources(1.0, None, None);
        broken.memory.total = f64::NAN;
        assert!(resource_gauges(&broken).is_none());
    }

    #[test]
    fn part_opacity_steps_down_then_holds() {
        assert_eq!(part_opacity(0), 1.0);
        assert_eq!(part_opacity(5), 0.14);
        assert_eq!(part_opacity(40), 0.14);
    }

    #[test]
    fn times_are_worded_like_the_shared_helpers() {
        let now = day(100);
        assert_eq!(ago(now - 30_000, now), "just now");
        assert_eq!(ago(now - 5 * MINUTE, now), "5 min ago");
        assert_eq!(ago(now - 3 * HOUR, now), "3 h ago");
        assert_eq!(ago(now - 2 * DAY, now), "2 d ago");
        assert_eq!(seen_ago(Some(now - 2 * HOUR), now).as_deref(), Some("2h ago"));
        assert_eq!(seen_ago(Some(now - 3 * DAY), now).as_deref(), Some("3d ago"));
        assert_eq!(seen_ago(None, now), None);
    }

    fn view(state: Reach, route: Option<Route>) -> ComputerView {
        ComputerView {
            id: "c".into(),
            name: "deer".into(),
            state,
            route,
            relay_host: "relay.milagre.cloud".into(),
            lan_routes: vec!["192.168.1.7:8798".into()],
            last_seen: Some(day(100) - 2 * HOUR),
            added_at: None,
            message: None,
        }
    }

    #[test]
    fn route_lines_and_pills() {
        let now = day(100);
        assert_eq!(route_line(&view(Reach::Online, Some(Route::Lan)), now), "Same network");
        assert_eq!(route_line(&view(Reach::Online, Some(Route::Relay)), now), "relay.milagre.cloud");
        assert_eq!(route_line(&view(Reach::Offline, None), now), "Offline, seen 2h ago");
        assert_eq!(route_line(&view(Reach::Refused, None), now), "Pair again with a new link.");
        assert_eq!(lan_state(&view(Reach::Online, Some(Route::Lan))), RouteState::InUse);
        assert_eq!(lan_state(&view(Reach::Offline, None)), RouteState::Ready);
        let mut no_lan = view(Reach::Online, Some(Route::Relay));
        no_lan.lan_routes.clear();
        assert_eq!(lan_state(&no_lan), RouteState::NotAvailable);
        assert_eq!(relay_state(&no_lan), RouteState::InUse);
        assert_eq!(relay_state(&view(Reach::Offline, None)), RouteState::Ready);
        assert_eq!(
            computer_status_line(&view(Reach::Online, Some(Route::Lan)), Some("0.232.0"), Some("Oct 21"), now),
            "Connected \u{b7} Milagre 0.232.0 \u{b7} paired Oct 21"
        );
    }

    fn device(key: &str, kind: DeviceKind, route: Option<Route>, seen: Option<i64>) -> PairedDevice {
        PairedDevice { key: key.into(), kind, name: None, last_seen: seen, is_new: false, route }
    }

    #[test]
    fn devices_sort_connected_first_then_recent() {
        let now = day(100);
        let list = vec![
            device("a", DeviceKind::Phone, None, Some(now - DAY)),
            device("b", DeviceKind::Phone, Some(Route::Relay), Some(now - 9 * DAY)),
            device("c", DeviceKind::Phone, None, Some(now - HOUR)),
            device("d", DeviceKind::Computer, None, None),
        ];
        let (computers, phones) = devices_by_kind(&list);
        assert_eq!(computers.len(), 1);
        assert_eq!(phones.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
        assert_eq!(device_name(&computers[0]), "Computer");
        assert_eq!(device_name(&phones[0]), "Phone");
        assert_eq!(device_seen_line(&phones[0], now), "Connected now, relay");
        assert_eq!(device_seen_line(&phones[1], now), "Last seen 1 h ago");
        assert_eq!(device_seen_line(&computers[0], now), "Not seen yet");
        assert_eq!(remove_device_question(&phones[0]), "Remove Phone? It can pair again from Pair a device.");
    }

    fn status(state: PhoneState, remote: Remote) -> PhoneStatus {
        PhoneStatus {
            enabled: state != PhoneState::Off,
            state,
            error: None,
            remote,
            relay: Some(RelayLink::Online),
            pairing_until: None,
            local_host: "127.0.0.1".into(),
            public_host: Some("mac.milagre.cloud".into()),
            pairing_link: String::new(),
            pairing_options: Vec::new(),
            lan: Some(Lan { enabled: true, addresses: vec!["192.168.1.7".into()], error: None }),
        }
    }

    #[test]
    fn phone_status_lines() {
        assert_eq!(phone_status_line(None), "Checking\u{2026}");
        assert_eq!(phone_status_line(Some(&status(PhoneState::Off, Remote::None))), "Off");
        assert_eq!(phone_status_line(Some(&status(PhoneState::On, Remote::Relay))), "On, reachable from any network");
        assert_eq!(phone_status_line(Some(&status(PhoneState::On, Remote::Cloudflare))), "Reachable at mac.milagre.cloud");
        assert_eq!(phone_status_line(Some(&status(PhoneState::On, Remote::None))), "This Mac only \u{2014} 127.0.0.1");
        assert_eq!(phone_status_line(Some(&status(PhoneState::Error, Remote::None))), "Phone access stopped.");
        let mut offline = status(PhoneState::On, Remote::Relay);
        offline.relay = Some(RelayLink::Offline);
        assert_eq!(phone_status_line(Some(&offline)), "On, can't reach the relay. Retrying\u{2026}");
        assert_eq!(phone_lan_line(&status(PhoneState::On, Remote::Relay)).as_deref(), Some("Reachable at 192.168.1.7"));
        let mut lan_off = status(PhoneState::On, Remote::Relay);
        lan_off.lan = Some(Lan { enabled: false, addresses: Vec::new(), error: None });
        assert_eq!(phone_lan_line(&lan_off).as_deref(), Some("Off"));
        lan_off.lan = Some(Lan { enabled: true, addresses: Vec::new(), error: None });
        assert_eq!(phone_lan_line(&lan_off).as_deref(), Some("Not connected to a local network"));
        assert!(cloudflare_phones_note(&status(PhoneState::On, Remote::Cloudflare)).is_some());
        assert!(cloudflare_phones_note(&status(PhoneState::On, Remote::Relay)).is_none());
    }

    #[test]
    fn the_pairing_window_counts_whole_minutes_up() {
        let now = day(100);
        let mut s = status(PhoneState::On, Remote::Relay);
        assert_eq!(pairing_window(&s, now), None);
        s.pairing_until = Some(now + 4 * MINUTE + 1);
        let open = pairing_window(&s, now).expect("window");
        assert_eq!(open, PairingWindow { open: true, minutes: 5 });
        assert_eq!(pairing_line(open), "New devices can pair for 5 more minutes");
        s.pairing_until = Some(now + 30_000);
        assert_eq!(pairing_line(pairing_window(&s, now).expect("window")), "New devices can pair for 1 more minute");
        s.pairing_until = Some(now - 1);
        assert_eq!(pairing_line(pairing_window(&s, now).expect("window")), "Pairing is closed to new devices.");
    }

    fn idle(title: &str, days_ago: i64, removable: bool, bytes: Option<f64>) -> IdleWorktree {
        IdleWorktree {
            project_name: "milagre-ade".into(),
            path: format!("/w/{title}"),
            branch: Some(title.into()),
            title: title.into(),
            chats: 2,
            last_at: day(200) - day(days_ago),
            bytes,
            status: WorktreeStatus { uncommitted: if removable { 0 } else { 3 }, unpushed: if removable { 0 } else { 1 }, removable },
        }
    }

    #[test]
    fn cleanup_lists_by_age_and_group() {
        let now = day(200);
        let list = vec![idle("new", 10, true, None), idle("a", 40, true, Some(2e9)), idle("b", 95, false, Some(1e8))];
        assert_eq!(idle_for(&list, 30, now).len(), 2);
        assert_eq!(idle_for(&list, 90, now).len(), 1);
        assert_eq!(idle_for(&list, 30, now)[0].title, "b", "oldest first");
        let (saved, unsaved) = cleanup_groups(&idle_for(&list, 30, now));
        assert_eq!((saved.len(), unsaved.len()), (1, 1));
        assert_eq!(group_line(&saved), "1 worktree \u{b7} 2 GB");
        assert_eq!(group_line(&[]), "None");
        assert_eq!(group_line(&[idle("x", 40, true, None)]), "1 worktree");
    }

    #[test]
    fn selection_and_remove_lines() {
        assert_eq!(selection_line(&[]), "Choose the worktrees to remove.");
        let one = vec![idle("a", 40, true, Some(2e9))];
        assert_eq!(selection_line(&one), "1 worktree selected \u{b7} 2 GB. 2 Chats on it are deleted too.");
        let two = vec![idle("a", 40, true, Some(2e9)), idle("b", 95, false, Some(1e9))];
        assert_eq!(
            selection_line(&two),
            "2 worktrees selected \u{b7} 3 GB. 4 Chats on them are deleted too. Unsaved work in 1 worktree is lost."
        );
        assert_eq!(remove_label(0), "Remove");
        assert_eq!(remove_label(3), "Remove 3 worktrees");
        assert_eq!(progress_line(1, 3), "1 of 3 removed\u{2026}");
        assert_eq!(row_detail(&two[0]), "milagre-ade");
        assert_eq!(row_detail(&two[1]), "milagre-ade \u{b7} 3 uncommitted files and 1 unpushed commit will be lost");
        assert_eq!(
            loss_reason(&WorktreeStatus { uncommitted: 0, unpushed: 0, removable: false }),
            "Its HEAD is detached, so what it holds isn't on a branch"
        );
    }

    #[test]
    fn cleanup_toasts() {
        assert_eq!(cleanup_toast(2, &[], false), "Removed 2 worktrees.");
        assert_eq!(cleanup_toast(0, &[], true), "No worktree was removed. Stopped before the rest.");
        assert_eq!(cleanup_toast(1, &["a: busy".into()], false), "Removed 1 worktree. One was kept: a: busy");
        assert_eq!(cleanup_toast(1, &["a: x".into(), "b: y".into()], false), "Removed 1 worktree. 2 were kept. a: x");
    }

    #[test]
    fn dates_use_the_year_only_when_it_differs() {
        // 2026-11-11 00:00 UTC is day 20_768.
        let now = 20_768 * DAY;
        assert_eq!(row_date(now - 54 * DAY, now), "Sep 18");
        assert_eq!(row_date(now - 400 * DAY, now), "Oct 7, 2025");
        assert_eq!(civil_from_days(0), (1970, 0, 1));
        assert_eq!(paired_date(now), "Nov 11");
    }

    #[test]
    fn main_sync_status_lines() {
        let now = day(10);
        assert_eq!(main_sync_status_line(None, now), "Not synced yet");
        let updated = MainSyncResult {
            at: now - 5 * MINUTE,
            outcome: SyncOutcome::Updated,
            branch: "main".into(),
            commit: Some("a1b2c3d".into()),
            message: None,
        };
        assert_eq!(main_sync_status_line(Some(&updated), now), "Synced main 5 min ago (a1b2c3d)");
        let skipped =
            MainSyncResult { outcome: SyncOutcome::Skipped, message: Some("it has local commits".into()), commit: None, ..updated.clone() };
        assert_eq!(main_sync_status_line(Some(&skipped), now), "Skipped 5 min ago: it has local commits");
        let failed = MainSyncResult { outcome: SyncOutcome::Failed, message: None, commit: None, ..updated };
        assert_eq!(main_sync_status_line(Some(&failed), now), "Couldn't sync 5 min ago: unknown error");
        assert_eq!(main_sync_choices(true)[0].1, "Default (On)");
        assert_eq!(MainSyncChoice::of(None), MainSyncChoice::Default);
        assert_eq!(MainSyncChoice::parse("off").override_of(), Some(false));
    }

    #[test]
    fn host_update_copy() {
        let mut update = HostUpdate {
            status: UpdateStatus::Idle,
            version: Some("0.233.0".into()),
            progress: 41.6,
            error: None,
            auto: false,
            current: "0.232.0".into(),
        };
        assert_eq!(update_description(&update), "Check for the latest Milagre release.");
        update.status = UpdateStatus::Downloading;
        assert_eq!(update_description(&update), "Downloading Milagre 0.233.0\u{2026} 42%");
        assert_eq!(update_available(&update).as_deref(), Some("Update available: v0.233.0"));
        assert!(update_busy(&update));
        update.status = UpdateStatus::Downloaded;
        update.auto = true;
        assert_eq!(update_description(&update), "Milagre 0.233.0 is ready to install. Auto update installs it once nothing is running.");
        assert!(!update_busy(&update));
        let (title, _, action) = install_question("deer", Some("0.233.0"));
        assert_eq!(title, "Restart Milagre on deer to install v0.233.0?");
        assert_eq!(action, "Install & restart");
        assert_eq!(no_desktop_update("deer"), "Open Milagre on deer to check for updates.");
    }

    #[test]
    fn permissions() {
        assert!(!permission_missing(Permission::Granted));
        assert!(!permission_missing(Permission::NotRequired));
        assert!(permission_missing(Permission::Denied));
        assert!(permission_missing(Permission::Unknown));
    }
}
