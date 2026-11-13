//! Accounts: the computer's provider accounts and each Project's choice, after `AccountsSettings.tsx`,
//! `ProjectAccountsSettings.tsx` and `AccountsSnapshot` / `ProjectAccountsSnapshot` in `model.ts`.
//!
//! [`AccountsStore`] is a global holding the accounts as `accounts:list` would answer them and applying the
//! actions `accounts:action` takes (select, login, cancel, remove, add), so the Accounts page, the Per Project
//! rows and Plan usage's "Set as default" all read one list. Fixture data only; nothing leaves the process.

use std::collections::HashMap;

use gpui::{Global, SharedString};

use crate::data::Provider;
use crate::logic::identity::capabilities::provider_capabilities;
pub use crate::logic::usage::limit::{AccountState, ProviderAccount, account_type};

/// The id of the account every provider has: the connected CLI's own.
pub const DEFAULT_ACCOUNT: &str = "default";

/// A saved account and the note under it.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountEntry {
    pub account: ProviderAccount,
    /// `ProviderAccount.message`: why it is not ready, or how sign-in is going.
    pub message: Option<SharedString>,
}

impl AccountEntry {
    pub fn id(&self) -> &str {
        &self.account.id
    }

    /// The name a row leads with: the address, else the label.
    pub fn title(&self) -> &str {
        match &self.account.email {
            Some(email) if !email.is_empty() => email,
            _ => &self.account.label,
        }
    }

    /// The row's second line: the label (when it adds to the address), then why it is not ready.
    pub fn detail(&self) -> String {
        let label = match &self.account.email {
            Some(email) if !email.is_empty() && self.account.label != *email => Some(self.account.label.as_str()),
            _ => None,
        };
        let state = match self.account.state {
            AccountState::SignedOut => Some("Not signed in"),
            AccountState::Unknown => Some("Not checked"),
            _ => None,
        };
        [label, state].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} ")
    }
}

/// `CliStatus.state` for the Antigravity install row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliState {
    Ok,
    Missing,
    Broken,
    Outdated,
}

/// `CliProgress`: where an install is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CliPhase {
    Starting,
    Download { received: f64, total: f64 },
    Extract,
    Validate,
}

const MB: f64 = 1024.0 * 1024.0;

/// What the Antigravity row shows.
#[derive(Clone, Debug, PartialEq)]
pub struct CliRow {
    pub state: Option<CliState>,
    pub working: bool,
    pub phase: Option<CliPhase>,
    pub error: String,
}

impl CliRow {
    pub fn missing(&self) -> bool {
        matches!(self.state, Some(CliState::Missing | CliState::Broken))
    }

    pub fn outdated(&self) -> bool {
        self.state == Some(CliState::Outdated)
    }

    /// The button's label, shown while any of the three applies.
    pub fn label(&self) -> &'static str {
        if self.working {
            "Installing\u{2026}"
        } else if self.state == Some(CliState::Broken) {
            "Reinstall"
        } else if self.outdated() {
            "Update"
        } else {
            "Install"
        }
    }

    pub fn shows_button(&self) -> bool {
        self.missing() || self.outdated() || self.working
    }

    /// The line under the name.
    pub fn detail(&self) -> String {
        if !self.working {
            return if self.missing() {
                "Not installed. Milagre downloads Antigravity for you.".to_string()
            } else if self.outdated() {
                "A newer Antigravity is available.".to_string()
            } else if self.state.is_some() {
                "Installed.".to_string()
            } else {
                "Checking\u{2026}".to_string()
            };
        }
        match self.phase {
            Some(CliPhase::Download { received, total }) => {
                format!("Downloading {} of {} MB", (received / MB).round(), (total / MB).round().max(1.0))
            }
            Some(CliPhase::Extract) => "Unpacking\u{2026}".to_string(),
            Some(CliPhase::Validate) => "Checking\u{2026}".to_string(),
            _ => "Starting\u{2026}".to_string(),
        }
    }

    /// The bar's fill, 0 to 1: a sliver before the size is known, so it reads as started.
    pub fn percent(&self) -> f32 {
        match self.phase {
            Some(CliPhase::Download { received, total }) if total > 0.0 => (received / total).clamp(0.0, 1.0) as f32,
            _ => 0.05,
        }
    }
}

/// `AccountsSnapshot.providers[i]`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderGroup {
    pub provider: Provider,
    /// `false`: the CLI is not installed, so there is nothing to sign in to.
    pub installed: bool,
    /// The computer default.
    pub selected_id: String,
    pub accounts: Vec<AccountEntry>,
}

impl ProviderGroup {
    /// Whether the header offers "Add account".
    pub fn can_add(&self) -> bool {
        self.installed && provider_capabilities(Some(self.provider.id())).add_accounts
    }

    pub fn find(&self, id: &str) -> Option<&AccountEntry> {
        self.accounts.iter().find(|entry| entry.id() == id)
    }

    /// Whether "Re-authenticate" shows: every account but the CLI's own, which only Antigravity can sign in again.
    pub fn can_reauthenticate(&self, id: &str) -> bool {
        id != DEFAULT_ACCOUNT || self.provider == Provider::Antigravity
    }
}

/// The accounts action the Accounts page takes (`accountAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Select,
    Login,
    Cancel,
    Remove,
}

/// `ProjectAccountScope`: a Project, a Link or the Chats home.
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub key: String,
    pub name: String,
    pub link: bool,
    /// The Projects a Link joins, by name.
    pub projects: Vec<String>,
    /// The computer's Chats home: the scope of every Chat without a Project.
    pub chats_home: bool,
}

/// `CHATS_ACCOUNT_DETAIL`.
pub const CHATS_ACCOUNT_DETAIL: &str = "Every quick Chat on this computer";

/// One choice of a Project's account select (`projectAccountOptions`).
#[derive(Clone, Debug, PartialEq)]
pub struct AccountChoice {
    /// Empty for "Use computer default".
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub disabled: bool,
    /// The plan's mark, for the account type.
    pub plan: Option<String>,
}

/// `ProjectAccountsSnapshot.providers[i]` for one scope.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectProvider {
    pub provider: Provider,
    /// The explicit assignment; none follows the computer default.
    pub account_id: Option<String>,
    pub effective_id: String,
    pub default_id: String,
    pub accounts: Vec<AccountEntry>,
}

/// `statusLabel`.
pub fn status_label(state: AccountState) -> &'static str {
    match state {
        AccountState::SigningIn => "Signing in",
        AccountState::Error => "Account error",
        AccountState::Unknown => "Not checked",
        _ => "Not signed in",
    }
}

impl ProjectProvider {
    pub fn effective(&self) -> Option<&AccountEntry> {
        self.accounts.iter().find(|entry| entry.id() == self.effective_id)
    }

    /// The assigned account no longer exists, or was removed.
    pub fn missing(&self) -> bool {
        let effective = self.effective();
        self.account_id.is_some() && effective.is_none_or(|entry| entry.account.missing)
    }

    /// The effective account needs signing in (and is not just missing).
    pub fn needs_sign_in(&self) -> bool {
        !self.missing() && self.effective().is_some_and(|entry| entry.account.state != AccountState::Ready)
    }

    /// `projectAccountOptions`: the computer default, then each saved account.
    pub fn choices(&self) -> Vec<AccountChoice> {
        let default = self.accounts.iter().find(|entry| entry.id() == self.default_id);
        let default_name = default.map_or_else(|| "No computer default".to_string(), |entry| entry.title().to_string());
        let mut choices = vec![AccountChoice {
            value: String::new(),
            label: "Use computer default".to_string(),
            description: Some(default_name),
            disabled: false,
            plan: default.and_then(|entry| entry.account.plan.clone()),
        }];
        if let Some(id) = self.account_id.as_ref().filter(|_| self.missing() && self.effective().is_none()) {
            choices.push(AccountChoice {
                value: id.clone(),
                label: "Unavailable account".to_string(),
                description: None,
                disabled: true,
                plan: None,
            });
        }
        for entry in &self.accounts {
            let missing = entry.account.missing;
            choices.push(AccountChoice {
                value: entry.id().to_string(),
                label: if missing { "Unavailable account".to_string() } else { entry.title().to_string() },
                description: if missing {
                    Some("Removed account".to_string())
                } else if entry.account.state == AccountState::Ready {
                    None
                } else {
                    Some(status_label(entry.account.state).to_string())
                },
                disabled: missing || entry.account.state != AccountState::Ready,
                plan: entry.account.plan.clone(),
            });
        }
        choices
    }
}

/// The accounts of the computer, and which account each scope assigned.
#[derive(Clone, Debug)]
pub struct AccountsStore {
    pub groups: Vec<ProviderGroup>,
    pub cli: CliRow,
    pub scopes: Vec<Scope>,
    /// `(scope key, provider)` to an explicit account.
    pub assignments: HashMap<(String, Provider), String>,
    next_id: u32,
}

impl Global for AccountsStore {}

impl AccountsStore {
    pub fn new(groups: Vec<ProviderGroup>, cli: CliRow, scopes: Vec<Scope>, assignments: HashMap<(String, Provider), String>) -> Self {
        Self { groups, cli, scopes, assignments, next_id: 1 }
    }

    pub fn group(&self, provider: Provider) -> Option<&ProviderGroup> {
        self.groups.iter().find(|group| group.provider == provider)
    }

    fn group_mut(&mut self, provider: Provider) -> Option<&mut ProviderGroup> {
        self.groups.iter_mut().find(|group| group.provider == provider)
    }

    /// Whether any sign-in is in flight (the page polls and disables the other buttons).
    pub fn signing_in(&self) -> bool {
        self.groups.iter().any(|group| group.accounts.iter().any(|entry| entry.account.state == AccountState::SigningIn))
    }

    /// `accountAction`.
    pub fn act(&mut self, action: Action, provider: Provider, id: &str) {
        match action {
            Action::Select => {
                if let Some(group) =
                    self.group_mut(provider).filter(|group| group.find(id).is_some_and(|e| e.account.state == AccountState::Ready))
                {
                    group.selected_id = id.to_string();
                }
            }
            Action::Login => {
                if let Some(entry) = self.entry_mut(provider, id) {
                    entry.account.state = AccountState::SigningIn;
                    entry.message = Some("Finish signing in in your computer's browser.".into());
                }
            }
            Action::Cancel => {
                if let Some(entry) = self.entry_mut(provider, id) {
                    entry.account.state = AccountState::SignedOut;
                    entry.message = None;
                }
            }
            Action::Remove => self.remove(provider, id),
        }
    }

    fn entry_mut(&mut self, provider: Provider, id: &str) -> Option<&mut AccountEntry> {
        self.group_mut(provider)?.accounts.iter_mut().find(|entry| entry.id() == id)
    }

    /// Removing the active account selects the connected CLI account; the local profile stays. The CLI's own
    /// account can not be removed.
    fn remove(&mut self, provider: Provider, id: &str) {
        if id == DEFAULT_ACCOUNT {
            return;
        }
        if let Some(group) = self.group_mut(provider) {
            group.accounts.retain(|entry| entry.id() != id);
            if group.selected_id == id {
                group.selected_id = DEFAULT_ACCOUNT.to_string();
            }
        }
        self.assignments.retain(|(_, assigned_provider), assigned| !(*assigned_provider == provider && assigned == id));
    }

    /// `accountAction("add", ...)`: a named account that starts signing in. Returns its id.
    pub fn add(&mut self, provider: Provider, label: &str) -> Option<String> {
        let label = label.trim();
        if label.is_empty() || !self.group(provider)?.can_add() {
            return None;
        }
        let id = format!("{}-{}", provider.id(), self.next_id);
        self.next_id += 1;
        let entry = AccountEntry {
            account: ProviderAccount {
                id: id.clone(),
                label: label.chars().take(80).collect(),
                state: AccountState::SigningIn,
                email: None,
                plan: None,
                limited_until: None,
                missing: false,
            },
            message: Some("Finish signing in in your computer's browser.".into()),
        };
        self.group_mut(provider)?.accounts.push(entry);
        Some(id)
    }

    /// The browser sign-in finished: the account is ready, and says whose it is.
    pub fn finish_sign_in(&mut self, provider: Provider, id: &str) {
        if let Some(entry) = self.entry_mut(provider, id) {
            if entry.account.state != AccountState::SigningIn {
                return;
            }
            entry.account.state = AccountState::Ready;
            entry.message = None;
            if entry.account.email.is_none() {
                let handle: String = entry.account.label.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
                entry.account.email = Some(format!("{}@example.com", if handle.is_empty() { "account" } else { &handle }));
                entry.account.plan.get_or_insert_with(|| "pro".to_string());
            }
        }
    }

    /// Makes `id` the computer default (Plan usage's "Set as default").
    pub fn set_default(&mut self, provider: Provider, id: &str) {
        self.act(Action::Select, provider, id);
    }

    /// `assignProjectAccount`: an empty `account_id` follows the computer default.
    pub fn assign(&mut self, scope: &str, provider: Provider, account_id: Option<&str>) {
        let key = (scope.to_string(), provider);
        match account_id.filter(|id| !id.is_empty()) {
            Some(id) => {
                self.assignments.insert(key, id.to_string());
            }
            None => {
                self.assignments.remove(&key);
            }
        }
    }

    /// `getProjectAccounts`: the scope's providers with the account each uses.
    pub fn project_accounts(&self, scope: &str) -> Vec<ProjectProvider> {
        self.groups
            .iter()
            .filter(|group| group.installed)
            .map(|group| {
                let assigned = self.assignments.get(&(scope.to_string(), group.provider)).cloned();
                // An assignment to an account that no longer exists reads as missing, not as the default.
                let mut accounts = group.accounts.clone();
                if let Some(id) = assigned.as_ref().filter(|id| group.find(id).is_none()) {
                    accounts.push(AccountEntry {
                        account: ProviderAccount {
                            id: id.clone(),
                            label: "Unavailable account".to_string(),
                            state: AccountState::SignedOut,
                            email: None,
                            plan: None,
                            limited_until: None,
                            missing: true,
                        },
                        message: None,
                    });
                }
                ProjectProvider {
                    provider: group.provider,
                    effective_id: assigned.clone().unwrap_or_else(|| group.selected_id.clone()),
                    default_id: group.selected_id.clone(),
                    account_id: assigned,
                    accounts,
                }
            })
            .collect()
    }

    /// `listAccountScopes` order: Projects first, then Links.
    pub fn sorted_scopes(&self) -> Vec<&Scope> {
        let mut scopes: Vec<&Scope> = self.scopes.iter().collect();
        scopes.sort_by_key(|scope| scope.link);
        scopes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::accounts::fixture;

    fn store() -> AccountsStore {
        fixture::accounts_store(&[("/Users/victor/Code/milagre".to_string(), "milagre".to_string())])
    }

    #[test]
    fn the_cli_account_leads_and_only_installed_providers_with_accounts_to_add_offer_it() {
        let store = store();
        assert!(store.group(Provider::Claude).unwrap().can_add());
        assert!(!store.group(Provider::Kiro).unwrap().can_add(), "kiro-cli owns its one account");
        assert!(!store.group(Provider::Antigravity).unwrap().can_add(), "not installed yet");
        let claude = store.group(Provider::Claude).unwrap();
        assert!(!claude.can_reauthenticate(DEFAULT_ACCOUNT));
        assert!(claude.can_reauthenticate("claude-work"));
        assert!(store.group(Provider::Antigravity).unwrap().can_reauthenticate(DEFAULT_ACCOUNT));
    }

    #[test]
    fn a_row_leads_with_the_address_and_notes_the_label_and_what_is_wrong() {
        let store = store();
        let claude = store.group(Provider::Claude).unwrap();
        let work = claude.find("claude-work").unwrap();
        assert_eq!(work.title(), "victor@rdplus.com");
        assert_eq!(work.detail(), "Work");
        let mut out = work.clone();
        out.account.state = AccountState::SignedOut;
        assert_eq!(out.detail(), "Work \u{b7} Not signed in");
        out.account.state = AccountState::Unknown;
        assert_eq!(out.detail(), "Work \u{b7} Not checked");
        let personal = claude.find(DEFAULT_ACCOUNT).unwrap();
        assert_eq!(personal.detail(), "Personal");
    }

    #[test]
    fn selecting_needs_a_ready_account_and_removing_the_default_falls_back_to_the_cli_account() {
        let mut store = store();
        store.act(Action::Select, Provider::Claude, "claude-work");
        assert_eq!(store.group(Provider::Claude).unwrap().selected_id, "claude-work");
        store.act(Action::Select, Provider::Codex, "codex-old");
        assert_eq!(store.group(Provider::Codex).unwrap().selected_id, DEFAULT_ACCOUNT, "a signed-out account can not be picked");
        store.act(Action::Remove, Provider::Claude, "claude-work");
        let claude = store.group(Provider::Claude).unwrap();
        assert_eq!(claude.selected_id, DEFAULT_ACCOUNT);
        assert!(claude.find("claude-work").is_none());
        store.act(Action::Remove, Provider::Claude, DEFAULT_ACCOUNT);
        assert!(store.group(Provider::Claude).unwrap().find(DEFAULT_ACCOUNT).is_some(), "the CLI account stays");
    }

    #[test]
    fn adding_an_account_signs_in_then_it_is_ready_and_login_and_cancel_move_the_state() {
        let mut store = store();
        assert_eq!(store.add(Provider::Claude, "   "), None);
        assert_eq!(store.add(Provider::Kiro, "Work"), None);
        let id = store.add(Provider::Claude, " Side project ").unwrap();
        assert!(store.signing_in());
        let entry = store.group(Provider::Claude).unwrap().find(&id).unwrap().clone();
        assert_eq!((entry.account.label.as_str(), entry.account.state), ("Side project", AccountState::SigningIn));
        store.finish_sign_in(Provider::Claude, &id);
        assert!(!store.signing_in());
        let entry = store.group(Provider::Claude).unwrap().find(&id).unwrap();
        assert_eq!(entry.account.state, AccountState::Ready);
        assert_eq!(entry.account.email.as_deref(), Some("sideproject@example.com"));
        store.act(Action::Login, Provider::Claude, &id);
        assert!(store.signing_in());
        store.act(Action::Cancel, Provider::Claude, &id);
        assert_eq!(store.group(Provider::Claude).unwrap().find(&id).unwrap().account.state, AccountState::SignedOut);
    }

    #[test]
    fn a_project_follows_the_default_until_it_picks_and_a_removed_pick_reads_as_unavailable() {
        let mut store = store();
        let scope = "/Users/victor/Code/other";
        let claude = |store: &AccountsStore| store.project_accounts(scope).into_iter().find(|p| p.provider == Provider::Claude).unwrap();
        let view = claude(&store);
        assert_eq!((view.account_id.clone(), view.effective_id.as_str()), (None, DEFAULT_ACCOUNT));
        store.assign(scope, Provider::Claude, Some("claude-work"));
        let view = claude(&store);
        assert_eq!((view.account_id.as_deref(), view.effective_id.as_str()), (Some("claude-work"), "claude-work"));
        store.assign(scope, Provider::Claude, Some(""));
        assert_eq!(claude(&store).account_id, None);
        // Assigned to an account that is gone.
        store.assignments.insert((scope.to_string(), Provider::Claude), "claude-gone".to_string());
        let view = claude(&store);
        assert!(view.missing());
        let choices = view.choices();
        assert!(choices.iter().any(|c| c.value == "claude-gone" && c.disabled && c.label == "Unavailable account"));
        // Removing the assigned account clears the assignment.
        store.assign(scope, Provider::Claude, Some("claude-work"));
        store.act(Action::Remove, Provider::Claude, "claude-work");
        assert_eq!(claude(&store).account_id, None);
    }

    #[test]
    fn the_choices_list_the_default_first_and_say_why_an_account_is_greyed() {
        let store = store();
        let view = store.project_accounts("/Users/victor/Code/milagre").into_iter().find(|p| p.provider == Provider::Codex).unwrap();
        let choices = view.choices();
        assert_eq!(choices[0].value, "");
        assert_eq!(choices[0].label, "Use computer default");
        assert_eq!(choices[0].description.as_deref(), Some("victor@example.com"));
        let old = choices.iter().find(|c| c.value == "codex-old").unwrap();
        assert!(old.disabled);
        assert_eq!(old.description.as_deref(), Some("Not signed in"));
        let ready = choices.iter().find(|c| c.value == DEFAULT_ACCOUNT).unwrap();
        assert!(!ready.disabled && ready.description.is_none());
        assert!(!view.missing() && !view.needs_sign_in());
    }

    #[test]
    fn an_assigned_account_that_needs_signing_in_is_flagged() {
        let mut store = store();
        store.assign("/p", Provider::Codex, Some("codex-old"));
        let view = store.project_accounts("/p").into_iter().find(|p| p.provider == Provider::Codex).unwrap();
        assert!(view.needs_sign_in() && !view.missing());
        assert_eq!(status_label(AccountState::SigningIn), "Signing in");
        assert_eq!(status_label(AccountState::Error), "Account error");
    }

    #[test]
    fn the_antigravity_row_names_what_it_is_doing() {
        let row = |state, working, phase| CliRow { state, working, phase, error: String::new() };
        let missing = row(Some(CliState::Missing), false, None);
        assert_eq!((missing.label(), missing.shows_button()), ("Install", true));
        assert_eq!(missing.detail(), "Not installed. Milagre downloads Antigravity for you.");
        assert_eq!(row(Some(CliState::Broken), false, None).label(), "Reinstall");
        assert_eq!(row(Some(CliState::Outdated), false, None).label(), "Update");
        assert_eq!(row(Some(CliState::Ok), false, None).detail(), "Installed.");
        assert!(!row(Some(CliState::Ok), false, None).shows_button());
        assert_eq!(row(None, false, None).detail(), "Checking\u{2026}");
        let working = row(Some(CliState::Missing), true, Some(CliPhase::Download { received: 40.0 * MB, total: 100.0 * MB }));
        assert_eq!((working.label(), working.detail()), ("Installing\u{2026}", "Downloading 40 of 100 MB".to_string()));
        assert!((working.percent() - 0.4).abs() < 1e-6);
        assert_eq!(row(Some(CliState::Missing), true, None).detail(), "Starting\u{2026}");
        assert!((row(Some(CliState::Missing), true, None).percent() - 0.05).abs() < 1e-6, "a sliver before the size is known");
        assert_eq!(row(Some(CliState::Missing), true, Some(CliPhase::Extract)).detail(), "Unpacking\u{2026}");
    }
}
