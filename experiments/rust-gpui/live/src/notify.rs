//! The Preview's own notifications, the main-process duty Electron's `AttentionNotifier` (`electron/notifications.cjs`)
//! has: a system notification when a Chat waits on the person (an approval or a question, the daemon's
//! `notification:waiting`) and when a Chat's work ends (its `agent:event` turn end), the dock badge (Chats with an
//! unread reply or waiting on the person), and the chime. Ported from the parked Tauri shell's `native.rs`
//! (`notifications::Activity`, `Schedule`, `show`).
//!
//! - Settings › Notifications is the window's own (Electron keeps it in its renderer and reports it to its main process
//!   with `settings:notify-when-waiting`, `settings:notification-chime`, `settings:notification-schedule` and
//!   `notification:state`): kept in the Preview's `preferences.json` ([`crate::prefs`]), seeded once from Electron's
//!   `preferences.json` (`milagre-settings`), never written there.
//! - Never for the Chat on screen while the window is focused, never for a waiting Chat while it is focused (as
//!   Electron), never for a hidden Project, never outside the schedule, and never while Electron's Milagre window runs
//!   (it notifies itself: two would chime twice).
//! - Clicking a notification opens its Chat and brings the window forward.
//!
//! The decisions are plain state ([`State`]); what shows them is a [`Poster`]: the system's notification centre in
//! the bundle ([`system_poster`]), a recorder in tests.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use serde_json::Value;

/// Settings › Notifications, as Electron's renderer keeps them (`lib/settings.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub waiting: bool,
    pub completion: bool,
    pub badge: bool,
    /// `system` or one of Electron's chimes (`settings::notifications::NOTIFICATION_CHIMES`).
    pub chime: String,
    pub schedule: Option<Schedule>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { waiting: true, completion: true, badge: true, chime: "system".into(), schedule: None }
    }
}

/// When notifications may show (`NotificationScheduleSetting.tsx`): days 0 (Sunday) to 6, minutes from midnight in a
/// time zone; an end before the start runs past midnight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub days: Vec<u32>,
    pub start: u32,
    pub end: u32,
    pub zone: String,
}

fn minutes(value: &str) -> Option<u32> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || !bytes.iter().enumerate().all(|(i, b)| i == 2 || b.is_ascii_digit()) {
        return None;
    }
    let (hour, minute) = (value[..2].parse::<u32>().ok()?, value[3..].parse::<u32>().ok()?);
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

impl Schedule {
    /// From its parts (`HH:MM` times, an IANA zone); `None` when invalid.
    pub fn parse(days: &[u32], start: &str, end: &str, zone: &str) -> Option<Self> {
        let (start, end) = (minutes(start)?, minutes(end)?);
        let zone_ok = !zone.is_empty()
            && zone.len() <= 100
            && !zone.starts_with('/')
            && !zone.split('/').any(|p| p == ".." || p == ".")
            && zone.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b));
        let days: Vec<u32> = days.iter().copied().filter(|d| *d < 7).collect();
        (start != end && zone_ok && !days.is_empty()).then(|| Self { days, start, end, zone: zone.to_owned() })
    }

    /// Whether `day` (0 = Sunday) at `time` (minutes) is inside.
    pub fn at(&self, day: u32, time: u32) -> bool {
        if self.start < self.end {
            self.days.contains(&day) && time >= self.start && time < self.end
        } else {
            (self.days.contains(&day) && time >= self.start) || (self.days.contains(&((day + 6) % 7)) && time < self.end)
        }
    }

    /// Whether now, in its zone, is inside (`/bin/date`, as the Tauri shell asks).
    pub fn now(&self) -> bool {
        let Ok(output) = std::process::Command::new("/bin/date").env("TZ", &self.zone).arg("+%w:%H:%M").output() else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<u32> = text.trim().split(':').filter_map(|p| p.parse().ok()).collect();
        parts.len() == 3 && self.at(parts[0], parts[1] * 60 + parts[2])
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Completion {
    failed: bool,
    body: String,
}

/// One Chat's work as its agent events tell it (the Tauri shell's `Activity`): running, waiting requests, background
/// agents and tasks, and the reply so far for the notification's body.
#[derive(Default)]
struct Activity {
    running: bool,
    ended: bool,
    failed: bool,
    requests: HashSet<String>,
    agents: HashSet<String>,
    tasks: HashSet<String>,
    preview: String,
    end: Option<Completion>,
}

impl Activity {
    /// 0 idle, 1 running, 2 background work, 3 failed.
    fn status(&self) -> u8 {
        if self.running {
            1
        } else if self.failed {
            3
        } else if !self.agents.is_empty() || !self.tasks.is_empty() {
            2
        } else {
            0
        }
    }

    /// Applies one agent event; the completion to announce when the Chat's work just ended.
    fn observe(&mut self, event: &Value) -> Option<Completion> {
        let kind = event["type"].as_str().unwrap_or("");
        let terminal = matches!(kind, "turn-completed" | "turn-failed" | "turn-cancelled");
        if terminal && !self.running && !self.ended {
            self.running = true;
        }
        let previous = self.status();
        match kind {
            "turn-started" | "message-sent" => {
                self.running = true;
                self.ended = false;
                self.failed = false;
                self.end = None;
                self.preview.clear();
            }
            "answers-sent" => self.preview.clear(),
            "text-delta" if self.running => {
                if event["startsMessage"] == true {
                    self.preview.clear();
                }
                self.preview.push_str(event["text"].as_str().unwrap_or(""));
                self.preview = self.preview.chars().take(4096).collect();
            }
            "permission-request" | "question-request" if self.running => {
                if let Some(id) = event["requestId"].as_str() {
                    self.requests.insert(id.to_owned());
                }
            }
            "permission-resolved" | "question-resolved" => {
                if let Some(id) = event["requestId"].as_str() {
                    self.requests.remove(id);
                }
            }
            "subagent-update" => {
                let agent = &event["agent"];
                if (agent["background"] == true || agent["source"] == "milagre-advisor")
                    && let Some(id) = agent["id"].as_str()
                {
                    if matches!(agent["status"].as_str(), Some("initializing" | "running" | "waiting")) {
                        self.agents.insert(id.to_owned());
                    } else {
                        self.agents.remove(id);
                    }
                }
            }
            "background-tasks" => {
                self.tasks = event["tasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|t| t["kind"] != "local_bash")
                    .filter_map(|t| t["id"].as_str().map(str::to_owned))
                    .collect();
            }
            _ if terminal => {
                self.running = false;
                self.ended = true;
                self.requests.clear();
                self.failed = kind == "turn-failed";
                self.end = if kind == "turn-cancelled" || event["quiet"] == true {
                    None
                } else {
                    let body = if self.failed {
                        event["message"].as_str().unwrap_or("Turn failed.").to_owned()
                    } else if self.preview.is_empty() {
                        "Turn completed.".into()
                    } else {
                        self.preview.clone()
                    };
                    Some(Completion { failed: self.failed, body })
                };
                self.preview.clear();
            }
            _ => {}
        }
        let next = self.status();
        if previous != next && matches!(previous, 1 | 2) && matches!(next, 0 | 3) { self.end.take() } else { None }
    }
}

/// One system notification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    /// The Chat key it opens.
    pub chat: String,
    pub title: String,
    pub body: String,
    /// `system` plays the notification's own sound; anything else is silent and plays that chime.
    pub chime: String,
    pub waiting: bool,
}

/// What shows the notifier's decisions.
pub trait Poster {
    fn post(&self, post: &Post);
    /// The dock badge: a count, or none.
    fn badge(&self, count: Option<usize>);
    /// Plays a chime by its id (Settings' Play button, or a silent notification's own chime).
    fn play(&self, chime: &str);
    /// Whether Electron's Milagre window runs (it notifies itself).
    fn electron_running(&self) -> bool {
        false
    }
}

/// What the window tells the notifier about a Chat: its title and whether its Project is hidden.
pub struct ChatInfo {
    pub title: String,
    pub hidden: bool,
}

/// The notifier's state: settings, every Chat's activity, the badge's sets.
#[derive(Default)]
pub struct State {
    pub settings: Settings,
    chats: HashMap<String, Activity>,
    order: VecDeque<String>,
    /// Waiting requests already announced, by Chat and request id.
    shown: HashSet<(String, String)>,
    /// The Chat on screen.
    pub active: Option<String>,
    /// The window has focus.
    pub focused: bool,
    /// Chats with an unread reply (the reducer's `unread`), not hidden.
    pub unread: HashSet<String>,
    badge: Option<Option<usize>>,
}

impl State {
    fn activity(&mut self, chat: &str) -> &mut Activity {
        if !self.chats.contains_key(chat) {
            self.order.push_back(chat.to_owned());
            self.chats.insert(chat.to_owned(), Activity::default());
            if self.order.len() > 500
                && let Some(old) = self.order.pop_front()
            {
                self.chats.remove(&old);
                self.shown.retain(|(id, _)| id != &old);
            }
        }
        self.chats.get_mut(chat).expect("inserted")
    }

    /// Whether a notification for `chat` may show now (focus, settings; hidden Projects are the caller's).
    fn allowed(&self, chat: &str, waiting: bool) -> bool {
        let on = if waiting { self.settings.waiting } else { self.settings.completion };
        let in_view = self.focused && (waiting || self.active.as_deref() == Some(chat));
        on && !in_view
    }

    /// The badge's count: unread Chats and Chats waiting on the person (none when off or zero).
    fn badge_count(&self) -> Option<usize> {
        if !self.settings.badge {
            return None;
        }
        let mut chats: HashSet<&str> = self.unread.iter().map(String::as_str).collect();
        chats.extend(self.chats.iter().filter(|(_, a)| !a.requests.is_empty()).map(|(k, _)| k.as_str()));
        (!chats.is_empty()).then_some(chats.len())
    }
}

fn capped(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > limit { format!("{}…", text.chars().take(limit - 1).collect::<String>()) } else { text }
}

/// The notifier: [`State`] and a [`Poster`].
pub struct Notifier {
    pub state: RefCell<State>,
    poster: Box<dyn Poster>,
}

impl Notifier {
    pub fn new(poster: Box<dyn Poster>, settings: Settings) -> Self {
        Self { state: RefCell::new(State { settings, ..State::default() }), poster }
    }

    pub fn settings(&self) -> Settings {
        self.state.borrow().settings.clone()
    }

    /// New settings (from Settings › Notifications); the badge follows.
    pub fn set_settings(&self, settings: Settings) {
        self.state.borrow_mut().settings = settings;
        self.badge();
    }

    /// The Chat on screen and whether the window has focus.
    pub fn set_view(&self, active: Option<String>, focused: bool) {
        let mut state = self.state.borrow_mut();
        state.active = active;
        state.focused = focused;
    }

    /// The Chats with an unread reply (hidden Projects' left out by the caller).
    pub fn set_unread(&self, unread: HashSet<String>) {
        if self.state.borrow().unread != unread {
            self.state.borrow_mut().unread = unread;
            self.badge();
        }
    }

    pub fn play(&self, chime: &str) {
        self.poster.play(chime);
    }

    fn badge(&self) {
        let count = self.state.borrow().badge_count();
        let mut state = self.state.borrow_mut();
        if state.badge != Some(count) {
            state.badge = Some(count);
            drop(state);
            self.poster.badge(count);
        }
    }

    fn show(&self, chat: &str, info: &ChatInfo, body: String, waiting: bool) -> bool {
        let (allowed, chime, schedule) = {
            let state = self.state.borrow();
            (state.allowed(chat, waiting), state.settings.chime.clone(), state.settings.schedule.clone())
        };
        if info.hidden || !allowed || schedule.is_some_and(|s| !s.now()) || self.poster.electron_running() {
            return false;
        }
        let title = if info.title.trim().is_empty() { "Milagre".to_owned() } else { capped(&info.title, 120) };
        let post = Post { chat: chat.to_owned(), title, body: capped(&body, 240), chime: chime.clone(), waiting };
        self.poster.post(&post);
        if chime != "system" {
            self.poster.play(&chime);
        }
        true
    }

    /// One of the live stream's events (`agent:event`, `notification:waiting`); `info` tells about a Chat by key.
    pub fn event(&self, channel: &str, payload: &Value, info: impl Fn(&str) -> ChatInfo) {
        match channel {
            "agent:event" => {
                let Some(chat) = payload["chatId"].as_str() else { return };
                let event = &payload["event"];
                let ended = {
                    let mut state = self.state.borrow_mut();
                    if matches!(event["type"].as_str(), Some("permission-resolved" | "question-resolved")) {
                        let request = event["requestId"].as_str().unwrap_or("").to_owned();
                        state.shown.remove(&(chat.to_owned(), request));
                    }
                    state.activity(chat).observe(event)
                };
                if let Some(end) = ended {
                    let body = if end.failed { format!("Turn failed: {}", end.body) } else { end.body };
                    self.show(chat, &info(chat), body, false);
                }
                self.badge();
            }
            "notification:waiting" => {
                let (Some(chat), Some(request)) = (payload["chatId"].as_str(), payload["requestId"].as_str()) else { return };
                let key = (chat.to_owned(), request.to_owned());
                {
                    let mut state = self.state.borrow_mut();
                    let open = state.chats.get(chat).is_some_and(|a| a.requests.contains(request));
                    if !open || !state.shown.insert(key.clone()) {
                        return;
                    }
                }
                let mut chat_info = info(chat);
                if let Some(title) = payload["title"].as_str().filter(|t| !t.trim().is_empty()) {
                    chat_info.title = title.to_owned();
                }
                let body = payload["body"].as_str().unwrap_or("Needs your input").to_owned();
                if !self.show(chat, &chat_info, body, true) {
                    self.state.borrow_mut().shown.remove(&key);
                }
            }
            _ => {}
        }
    }
}

// ---- Settings › Notifications in the Preview's preferences ----

/// The notification settings in the Preview's `preferences.json` (`notifications`), or `None`.
pub fn from_json(value: &Value) -> Option<Settings> {
    let n = value.get("notifications")?;
    Some(settings_from(n))
}

/// Electron's renderer settings (`milagre-settings` in its `preferences.json`, a JSON string): its notification keys.
pub fn from_electron(preferences: &Value) -> Option<Settings> {
    let saved: Value = serde_json::from_str(preferences.get("milagre-settings")?.as_str()?).ok()?;
    Some(settings_from(&serde_json::json!({
        "notifyWhenWaiting": saved["notifyWhenWaiting"],
        "notifyOnCompletion": saved["notifyOnCompletion"],
        "showDockBadge": saved["showDockBadge"],
        "notificationChime": saved["notificationChime"],
        "notificationSchedule": saved["notificationSchedule"],
    })))
}

fn settings_from(n: &Value) -> Settings {
    let defaults = Settings::default();
    let flag = |key: &str, default: bool| n[key].as_bool().unwrap_or(default);
    let chime = n["notificationChime"]
        .as_str()
        .filter(|c| milagre_gpui_spike::settings::notifications::NOTIFICATION_CHIMES.iter().any(|(id, _)| id == c))
        .unwrap_or("system")
        .to_owned();
    let schedule = n["notificationSchedule"].as_object().and_then(|s| {
        let days: Vec<u32> = s.get("days")?.as_array()?.iter().filter_map(|d| d.as_u64().map(|d| d as u32)).collect();
        Schedule::parse(&days, s.get("start")?.as_str()?, s.get("end")?.as_str()?, s.get("timeZone")?.as_str()?)
    });
    Settings {
        waiting: flag("notifyWhenWaiting", defaults.waiting),
        completion: flag("notifyOnCompletion", defaults.completion),
        badge: flag("showDockBadge", defaults.badge),
        chime,
        schedule,
    }
}

/// The settings as the Preview's `preferences.json` keeps them (Electron's key names).
pub fn to_json(settings: &Settings) -> Value {
    serde_json::json!({
        "notifyWhenWaiting": settings.waiting,
        "notifyOnCompletion": settings.completion,
        "showDockBadge": settings.badge,
        "notificationChime": settings.chime,
        "notificationSchedule": settings.schedule.as_ref().map(|s| serde_json::json!({
            "days": s.days, "start": format!("{:02}:{:02}", s.start / 60, s.start % 60),
            "end": format!("{:02}:{:02}", s.end / 60, s.end % 60), "timeZone": s.zone,
        })),
    })
}

/// Settings › Notifications' store fields as [`Settings`].
pub fn from_store(store: &milagre_gpui_spike::settings::SettingsStore) -> Settings {
    let schedule = store.notification_schedule.as_ref().and_then(|s| {
        let days: Vec<u32> = s.days.iter().map(|d| *d as u32).collect();
        Schedule::parse(&days, &s.start, &s.end, &s.time_zone)
    });
    Settings {
        waiting: store.notify_on_attention,
        completion: store.notify_on_complete,
        badge: store.show_dock_badge,
        chime: store.notification_chime.clone(),
        schedule,
    }
}

/// [`Settings`] into Settings › Notifications' store fields.
pub fn into_store(settings: &Settings, store: &mut milagre_gpui_spike::settings::SettingsStore) {
    store.notify_on_attention = settings.waiting;
    store.notify_on_complete = settings.completion;
    store.show_dock_badge = settings.badge;
    store.notification_chime = settings.chime.clone();
    store.notification_schedule = settings.schedule.as_ref().map(|s| milagre_gpui_spike::settings::store::NotificationSchedule {
        days: s.days.iter().map(|d| *d as u8).collect(),
        start: format!("{:02}:{:02}", s.start / 60, s.start % 60),
        end: format!("{:02}:{:02}", s.end / 60, s.end % 60),
        time_zone: s.zone.clone(),
    });
}

/// Electron's own `preferences.json` (read only, never written).
pub fn electron_preferences() -> std::path::PathBuf {
    crate::setup::home().join("Library/Application Support/Milagre/preferences.json")
}

/// A chime's sound file: `chime_<id>.mp3` (Electron's `assets/chimes/`), in the bundle's `Resources/chimes` or
/// `MILAGRE_GPUI_CHIMES`.
pub fn chime_file(chime: &str) -> Option<std::path::PathBuf> {
    if chime == "system" || !chime.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
        return None;
    }
    let name = format!("chime_{}.mp3", chime.replace('-', "_"));
    let mut folders = Vec::new();
    if let Some(dir) = std::env::var_os("MILAGRE_GPUI_CHIMES") {
        folders.push(std::path::PathBuf::from(dir));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(contents) = exe.parent().and_then(Path::parent)
    {
        folders.push(contents.join("Resources/chimes"));
    }
    folders.into_iter().map(|dir| dir.join(&name)).find(|path| path.is_file())
}

// ---- The system's notifications (macOS) ----

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSRunningApplication};
    use objc2_foundation::{NSBundle, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::{Post, Poster};

    /// Notification ids to the Chat each opens, and the clicked Chats not taken yet.
    static IDS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    pub static CLICKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MilagreGpuiPreviewNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Shown while the app is in front too (the notifier already left out the Chat on screen).
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                let chat = IDS.lock().ok().and_then(|ids| ids.as_ref().and_then(|ids| ids.get(&id).cloned()));
                if let Some(chat) = chat
                    && let Ok(mut clicked) = CLICKED.lock()
                {
                    clicked.push(chat);
                }
                handler.call(());
            }
        }
    );

    pub struct SystemPoster {
        center: Retained<UNUserNotificationCenter>,
        _delegate: Retained<Delegate>,
        mtm: MainThreadMarker,
        next: std::cell::Cell<u64>,
    }

    /// The notification centre, inside an app bundle only (it throws for a bare executable).
    pub fn system_poster() -> Option<SystemPoster> {
        let mtm = MainThreadMarker::new()?;
        let bundled =
            NSBundle::mainBundle().bundleIdentifier().is_some() && NSBundle::mainBundle().bundlePath().to_string().ends_with(".app");
        if !bundled {
            return None;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(mtm), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let done = block2::RcBlock::new(|_granted: objc2::runtime::Bool, _error: *mut objc2_foundation::NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &done,
        );
        Some(SystemPoster { center, _delegate: delegate, mtm, next: std::cell::Cell::new(0) })
    }

    impl Poster for SystemPoster {
        fn post(&self, post: &Post) {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&post.title));
            content.setBody(&NSString::from_str(&post.body));
            if post.chime == "system" {
                content.setSound(Some(&UNNotificationSound::defaultSound()));
            }
            self.next.set(self.next.get() + 1);
            let id = format!("milagre-chat-{}-{}", std::process::id(), self.next.get());
            if let Ok(mut ids) = IDS.lock() {
                let ids = ids.get_or_insert_with(HashMap::new);
                if ids.len() > 500 {
                    ids.clear();
                }
                ids.insert(id.clone(), post.chat.clone());
            }
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
            self.center.addNotificationRequest_withCompletionHandler(&request, None);
        }

        fn badge(&self, count: Option<usize>) {
            let tile = NSApplication::sharedApplication(self.mtm).dockTile();
            let label = count.map(|n| NSString::from_str(&n.to_string()));
            tile.setBadgeLabel(label.as_deref());
        }

        fn play(&self, chime: &str) {
            if let Some(file) = super::chime_file(chime) {
                let _ = std::process::Command::new("/usr/bin/afplay").arg(file).spawn().map(|mut child| {
                    std::thread::spawn(move || child.wait());
                });
            }
        }

        fn electron_running(&self) -> bool {
            NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str("com.milagre.app"))
                .iter()
                .any(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::system_poster;

/// The Chats whose notifications were clicked since the last call.
pub fn take_clicked() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        mac::CLICKED.lock().map(|mut clicked| std::mem::take(&mut *clicked)).unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// A poster to use instead of the system's (tests): taken once by the window that installs the notifier.
pub struct PosterOverride(pub RefCell<Option<Box<dyn Poster>>>);

impl gpui::Global for PosterOverride {}

/// The poster for this window: a test's override, else the notification centre in the app bundle, else a log.
pub fn poster(cx: &gpui::App) -> Box<dyn Poster> {
    if let Some(taken) = cx.try_global::<PosterOverride>().and_then(|o| o.0.borrow_mut().take()) {
        return taken;
    }
    #[cfg(target_os = "macos")]
    if let Some(system) = system_poster() {
        return Box::new(system);
    }
    Box::new(LogPoster)
}

/// A poster that only logs (no bundle: a dev build or a check).
pub struct LogPoster;

impl Poster for LogPoster {
    fn post(&self, post: &Post) {
        eprintln!("live: notification (not shown outside the app bundle): {} — {}", post.title, post.body);
    }
    fn badge(&self, _count: Option<usize>) {}
    fn play(&self, _chime: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_and_electrons_settings_read_as_electron_writes_them() {
        let day = Schedule::parse(&[1, 2, 3, 4, 5], "09:00", "17:30", "America/Sao_Paulo").unwrap();
        assert!(day.at(1, 9 * 60) && day.at(5, 17 * 60 + 29) && !day.at(5, 17 * 60 + 30) && !day.at(0, 12 * 60));
        let night = Schedule::parse(&[5], "22:00", "06:00", "UTC").unwrap();
        assert!(night.at(5, 23 * 60) && night.at(6, 5 * 60) && !night.at(6, 7 * 60) && !night.at(4, 23 * 60));
        assert!(Schedule::parse(&[1], "09:00", "09:00", "UTC").is_none(), "an empty window");
        assert!(Schedule::parse(&[1], "09:00", "10:00", "../etc/passwd").is_none());
        assert!(Schedule::parse(&[], "09:00", "10:00", "UTC").is_none());
        let electron = serde_json::json!({"milagre-settings": serde_json::json!({"notifyWhenWaiting": false, "notificationChime": "metal-pipe",
            "notificationSchedule": {"days":[1,2],"start":"08:00","end":"18:00","timeZone":"Europe/Paris"}}).to_string()});
        let settings = from_electron(&electron).unwrap();
        assert_eq!((settings.waiting, settings.completion, settings.badge, settings.chime.as_str()), (false, true, true, "metal-pipe"));
        assert_eq!(settings.schedule.as_ref().map(|s| (s.start, s.end, s.zone.as_str())), Some((480, 1080, "Europe/Paris")));
        // Round trip through the Preview's own file.
        assert_eq!(from_json(&serde_json::json!({"notifications": to_json(&settings)})), Some(settings));
        let unknown = serde_json::json!({"milagre-settings": "{\"notificationChime\":\"rm -rf\"}"});
        assert_eq!(from_electron(&unknown).unwrap().chime, "system");
    }

    #[test]
    fn a_turn_end_is_announced_once_and_a_cancel_never() {
        let mut activity = Activity::default();
        assert!(activity.observe(&serde_json::json!({"type":"turn-started"})).is_none());
        activity.observe(&serde_json::json!({"type":"text-delta","text":"Hello"}));
        assert_eq!(
            activity.observe(&serde_json::json!({"type":"turn-completed"})),
            Some(Completion { failed: false, body: "Hello".into() })
        );
        assert!(activity.observe(&serde_json::json!({"type":"turn-completed"})).is_none());
        activity.observe(&serde_json::json!({"type":"turn-started"}));
        assert!(activity.observe(&serde_json::json!({"type":"turn-cancelled"})).is_none());
        activity.observe(&serde_json::json!({"type":"turn-started"}));
        let failed = activity.observe(&serde_json::json!({"type":"turn-failed","message":"Rate limited"})).unwrap();
        assert!(failed.failed && failed.body == "Rate limited");
    }
}
