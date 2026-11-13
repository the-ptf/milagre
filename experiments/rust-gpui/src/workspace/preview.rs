//! Preview mode: the window runs on a real Chat runtime that serves only part of what the fixture shows.
//!
//! A live data layer sets [`PreviewMode`] before it opens the window. Then nothing the runtime does not back may look
//! real: the side panel (Details, PR, Designs, Artifact, Browser, Simulator; Changes and its diff only once the data
//! layer feeds them with `Panel::set_live_changes`), Routines (and the top bar's Routines, Link Projects and Search
//! buttons), Settings and the notices are not shown; the sidebar's menus keep Mark as unread, Rename, Done and Reopen (the writes the runtime takes)
//! while Pin, Delete and drag do nothing unless the data layer backs them ([`PreviewWrites`]); the sidebar has no status text (the plan usage rows only when the data layer reads them, and its notice when it has one); the Terminal
//! drawer is labelled as this computer's local shell unless the data layer hosts its terminals. The fixture app never sets it.
//! Settings lists only the sections the data layer backs ([`settings_shows`]): Appearance (this window's own) and,
//! once the data layer feeds them, Accounts ([`PreviewAccounts`], read-only), Usage, Notifications and the sections in
//! [`PreviewSettings`] (full pages, less the rows it hides); the others are not in its list or its search, and it opens on Appearance. The panel shows Details and
//! the pill row only once the data layer feeds them (`Panel::set_live_details`, `PillRow::set_live`).

use gpui::{App, Global, SharedString};

pub const UNAVAILABLE: &str = "Not available in this preview";

/// The sidebar writes the runtime takes (`chat:patch` unread, done and title); every other row action is off unless
/// the data layer backs it ([`PreviewWrites`]).
pub fn menu_allows(action: crate::workspace::sidebar::menu::MenuAction) -> bool {
    use crate::workspace::sidebar::menu::MenuAction as A;
    matches!(action, A::MarkUnread | A::Rename | A::Done | A::Reopen)
}

/// The row actions a data layer backs beyond [`menu_allows`] (Milagre's daemon: Pin, Delete, Reload, …), set with
/// [`PreviewMode`].
#[derive(Clone, Debug, Default)]
pub struct PreviewWrites(pub Vec<crate::workspace::sidebar::menu::MenuAction>);

impl Global for PreviewWrites {}

/// Whether a row action does something: always outside preview mode, else when the data layer backs it.
pub fn allows(cx: &App, action: crate::workspace::sidebar::menu::MenuAction) -> bool {
    !is_on(cx) || menu_allows(action) || cx.try_global::<PreviewWrites>().is_some_and(|writes| writes.0.contains(&action))
}
pub const LOCAL_SHELL: &str = "local shell (this computer, not the runtime)";

#[derive(Clone, Debug)]
pub struct PreviewMode {
    /// The signed-in account the runtime was created with (its label).
    pub account: SharedString,
    /// The model fixed for this runtime.
    pub model: SharedString,
}

impl Global for PreviewMode {}

/// One account a data layer read for Settings › Accounts (read-only in preview).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewAccount {
    /// `claude`, `codex`, `antigravity` or `kiro`.
    pub provider: SharedString,
    pub label: SharedString,
    /// Its email, plan or state.
    pub detail: SharedString,
    /// The account the computer uses for that provider.
    pub selected: bool,
    /// Its id, for `accounts:select`.
    pub id: SharedString,
    /// Signed in: only a ready account can be made the default (Electron's radio is disabled otherwise).
    pub ready: bool,
}

/// An accounts write the data layer backs ([`PreviewAccountWrites`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountWrite {
    /// Settings › Accounts' radio: the computer default for a provider (`accounts:select [provider, id]`).
    SetDefault { provider: SharedString, id: SharedString },
    /// The usage card's account picker: the Project on screen's account (`accounts:assign [scope, provider, id]`),
    /// `None` for "Use computer default".
    Assign { provider: crate::data::Provider, account_id: Option<String> },
    /// The usage card's refresh (`usage:read [scope]`, which reads the provider's CLI).
    RefreshUsage,
}

/// Set by a data layer that makes the accounts writes: Settings › Accounts' radios, the usage card's picker and
/// refresh, and the usage-limit card's actions come on. Without it they stay off in preview mode.
#[derive(Clone)]
pub struct PreviewAccountWrites(pub AccountWriter);

/// What runs an [`AccountWrite`].
pub type AccountWriter = std::rc::Rc<dyn Fn(AccountWrite, &mut App)>;

impl Global for PreviewAccountWrites {}

/// The Project on screen's accounts (`accounts:scope`), per provider: the usage card's picker lists them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PreviewProjectAccounts(pub Vec<crate::settings::accounts::model::ProjectProvider>);

impl Global for PreviewProjectAccounts {}

/// A usage read the card's refresh asked for is on its way (the button spins).
#[derive(Clone, Copy, Debug, Default)]
pub struct PreviewUsageReading;

impl Global for PreviewUsageReading {}

/// Runs an accounts write through the data layer, when it backs them.
pub fn account_write(write: AccountWrite, cx: &mut App) -> bool {
    let Some(writes) = cx.try_global::<PreviewAccountWrites>().cloned() else { return false };
    (writes.0)(write, cx);
    true
}

/// The accounts a data layer read; without it, Settings › Accounts says it is not available.
#[derive(Clone, Debug, Default)]
pub struct PreviewAccounts(pub Vec<PreviewAccount>);

impl Global for PreviewAccounts {}

/// Set by a data layer that feeds the sidebar's plan usage (`Sidebar::set_usage`, read-only): the usage rows and card
/// then show in preview mode. The card's account picker and its refresh button stay off (they would write or force
/// a provider read the runtime does not take here), and the usage-limit card shows times in this computer's zone.
#[derive(Clone, Copy, Debug, Default)]
pub struct LiveUsage;

impl Global for LiveUsage {}

/// Every account's plan usage a data layer read (`usage:accounts:cached`), for Settings › Usage (read-only). Without it
/// that section says it is not available.
#[derive(Clone, Debug, Default)]
pub struct PreviewPlanUsage(pub crate::data::UsageSnapshot);

impl Global for PreviewPlanUsage {}

/// Whether plan usage is live (see [`LiveUsage`]).
pub fn usage_is_live(cx: &App) -> bool {
    cx.has_global::<LiveUsage>()
}

pub fn is_on(cx: &App) -> bool {
    cx.has_global::<PreviewMode>()
}

pub fn get(cx: &App) -> Option<&PreviewMode> {
    cx.try_global::<PreviewMode>()
}

/// Set by a data layer that keeps Settings › Notifications itself (the Preview's own notifier): that section shows.
#[derive(Clone, Copy, Debug, Default)]
pub struct PreviewNotifications;

impl Global for PreviewNotifications {}

/// The Settings sections a preview shows: only those it backs (Appearance always; Accounts, Usage and Notifications
/// once the data layer feeds them). Outside preview mode, every section. Paired computers and Projects' pages are not
/// shown in preview mode.
pub fn settings_shows(cx: &App, page: crate::settings::search::SettingsSectionId) -> bool {
    use crate::settings::search::SettingsSectionId as S;
    if !is_on(cx) {
        return true;
    }
    match page {
        S::Appearance => true,
        S::Accounts => cx.has_global::<PreviewAccounts>(),
        S::Usage => cx.has_global::<PreviewPlanUsage>(),
        S::Notifications => cx.has_global::<PreviewNotifications>(),
        S::Computer => cx.has_global::<PreviewComputers>(),
        page => settings_backs(cx, page),
    }
}

/// The Settings sections a data layer backs with Milagre's daemon or this window's own preferences, drawn as their
/// full pages ([`settings_backs`]), and the rows on them this window cannot honour ([`settings_row_shows`]).
#[derive(Clone, Debug, Default)]
pub struct PreviewSettings {
    pub sections: Vec<crate::settings::search::SettingsSectionId>,
    /// Rows and groups (their Settings search titles) on a listed section that stay hidden and out of search.
    pub hidden: Vec<(crate::settings::search::SettingsSectionId, &'static str)>,
}

impl Global for PreviewSettings {}

/// Whether a data layer draws `page` as its full page ([`PreviewSettings`]).
pub fn settings_backs(cx: &App, page: crate::settings::search::SettingsSectionId) -> bool {
    is_on(cx) && cx.try_global::<PreviewSettings>().is_some_and(|backed| backed.sections.contains(&page))
}

/// Whether a row or group titled `title` on `page` shows: always outside preview mode, else unless the data layer
/// hides it ([`PreviewSettings::hidden`]).
pub fn settings_row_shows(cx: &App, page: crate::settings::search::SettingsSectionId, title: &str) -> bool {
    !is_on(cx) || !cx.try_global::<PreviewSettings>().is_some_and(|backed| backed.hidden.iter().any(|(p, t)| *p == page && *t == title))
}

/// Set by a data layer that opens folders itself (Show in Finder, Open in editor): Details shows those buttons.
#[derive(Clone, Copy, Debug, Default)]
pub struct PreviewOpeners;

impl Global for PreviewOpeners {}

/// Paired computers a data layer read (its computer vault unlocked): Settings lists them, each with a read-only page.
#[derive(Clone, Debug, Default)]
pub struct PreviewComputers(pub crate::data::ComputersSnapshot);

impl Global for PreviewComputers {}
