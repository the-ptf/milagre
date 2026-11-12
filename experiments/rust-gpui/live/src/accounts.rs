//! The account switcher on Milagre's daemon, as Electron's window drives it:
//!
//! - The usage card's account picker (`UsageCard.tsx` `AccountPicker`): the Project on screen's accounts,
//!   `accounts:scope [scopeKey]` (`ProjectAccountsSnapshot`, read again on `accounts:changed`); a pick is
//!   `accounts:assign [scopeKey, provider, accountId | null]` ("Use computer default" is `null`). The scope is the
//!   Project's path. Its refresh button is `usage:read [scopeKey]` (runs the provider's CLI, as Electron's does).
//! - Settings › Accounts' radio: `accounts:select [provider, accountId]` (answers the whole `AccountsSnapshot`).
//! - The usage-limit card (`UsageLimitCard.tsx`): its choices are `limitChoices` over `accounts:scope`; a pick is
//!   `chat:limit-switch [scope, sessionId, provider, accountId]` (`{continued, label}` → "Switched to …"); "Continue
//!   at <time>" is `chat:limit-resume [scope, sessionId, sourceMessageId]` (`false`: "This Chat can no longer continue
//!   at this reset time."), offered only when `limits:resume-at-reset:read` answers `{resumeAtReset: boolean}`; its
//!   Cancel is `chat:limit-resume:cancel [scope, sessionId, sendId]`. The schedule itself comes back in the Chat's
//!   `limitResume`. "Add account" / "Manage accounts" open Settings › Accounts.
//!
//! Every write goes on a short write connection and is refused in read-only mode, before any connection.

use std::rc::Rc;
use std::sync::Arc;

use gpui::{AppContext as _, Context, Entity};
use milagre_gpui_spike::data::Provider;
use milagre_gpui_spike::logic::usage::limit::{AccountState, LimitChoice, ProviderAccount, ProviderAccounts, UsageLimit, limit_choices};
use milagre_gpui_spike::settings::accounts::model::{AccountEntry, ProjectProvider};
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::preview::{
    AccountWrite, PreviewAccountWrites, PreviewAccounts, PreviewProjectAccounts, PreviewUsageReading,
};
use serde_json::{Value, json};

use crate::daemon::Daemon;

// ---- Decoding ----

fn account(value: &Value) -> Option<ProviderAccount> {
    Some(ProviderAccount {
        id: value["id"].as_str()?.to_owned(),
        label: value["label"].as_str().unwrap_or_default().to_owned(),
        state: match value["state"].as_str() {
            Some("ready") => AccountState::Ready,
            Some("signed-out") => AccountState::SignedOut,
            Some("signing-in") => AccountState::SigningIn,
            Some("error") => AccountState::Error,
            _ => AccountState::Unknown,
        },
        email: value["email"].as_str().filter(|e| !e.is_empty()).map(str::to_owned),
        plan: value["plan"].as_str().filter(|p| !p.is_empty()).map(str::to_owned),
        limited_until: value["limitedUntil"].as_str().map(str::to_owned),
        missing: value["missing"] == true,
    })
}

/// `accounts:scope`'s answer (`ProjectAccountsSnapshot.providers`).
pub fn project_accounts(snapshot: &Value) -> Vec<ProjectProvider> {
    snapshot["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|group| {
            Some(ProjectProvider {
                provider: Provider::from_id(group["provider"].as_str()?)?,
                account_id: group["accountId"].as_str().map(str::to_owned),
                effective_id: group["effectiveId"].as_str().unwrap_or_default().to_owned(),
                default_id: group["defaultId"].as_str().unwrap_or_default().to_owned(),
                accounts: group["accounts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| {
                        Some(AccountEntry { account: account(a)?, message: a["message"].as_str().map(|m| m.to_owned().into()) })
                    })
                    .collect(),
            })
        })
        .collect()
}

/// `limitChoices` for a limit, over a scope's accounts.
pub fn choices(groups: &[ProjectProvider], limit: &UsageLimit, now: i64) -> Vec<LimitChoice> {
    let groups: Vec<ProviderAccounts> = groups
        .iter()
        .map(|g| ProviderAccounts {
            provider: g.provider,
            effective_id: g.effective_id.clone(),
            accounts: g.accounts.iter().map(|e| e.account.clone()).collect(),
        })
        .collect();
    limit_choices(&groups, limit, now, &milagre_gpui_spike::logic::usage::time::SystemZone)
}

/// `{continued, label}` → `switchedText`.
pub fn switched(answer: &Value, fallback: &str) -> String {
    let label = answer["label"].as_str().filter(|l| !l.is_empty()).unwrap_or(fallback);
    milagre_gpui_spike::logic::usage::limit::switched_text(answer["continued"] == true, label)
}

// ---- The driver ----

/// What a finished write changes.
enum Answer {
    /// `accounts:select`: the whole list again.
    Accounts(Value),
    /// `accounts:assign`: the scope's accounts again.
    Scope(String, Value),
    /// `usage:read`: the scope's usage.
    Usage(Value),
    /// A limit card's action: the card's item and its result line (or `None`: the card waits for the state).
    Limit(usize, Option<String>),
}

pub struct LiveAccounts {
    daemon: Arc<Daemon>,
    workspace: Entity<Workspace>,
    /// The Project on screen (the usage card's and the limit card's scope), and its accounts.
    scope: Option<String>,
    groups: Vec<ProjectProvider>,
    /// `limits:resume-at-reset:read` answered with a boolean.
    resume_supported: Option<bool>,
    sent: Vec<(String, Value)>,
    refused: Vec<String>,
    errors: Vec<String>,
}

impl LiveAccounts {
    /// Turns the writes on (`PreviewAccountWrites`): every write the views ask for comes here.
    pub fn attach(daemon: Arc<Daemon>, workspace: Entity<Workspace>, cx: &mut gpui::App) -> Entity<Self> {
        let entity = cx.new(|_| Self {
            daemon,
            workspace,
            scope: None,
            groups: Vec::new(),
            resume_supported: None,
            sent: Vec::new(),
            refused: Vec::new(),
            errors: Vec::new(),
        });
        let weak = entity.downgrade();
        cx.set_global(PreviewAccountWrites(Rc::new(move |write, cx| {
            if let Some(entity) = weak.upgrade() {
                entity.update(cx, |this, cx| this.write(write, cx));
            }
        })));
        entity
    }

    /// The Project on screen: its accounts are read (once per Project, and again on `accounts:changed`).
    pub fn set_scope(&mut self, scope: Option<String>, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.groups.clear();
        cx.set_global(PreviewProjectAccounts::default());
        self.read(cx);
    }

    /// `accounts:changed`, a new sync: read again.
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.read(cx);
    }

    pub fn groups(&self) -> &[ProjectProvider] {
        &self.groups
    }

    /// Whether "Continue at" may be offered (`limits:resume-at-reset:read` answered).
    pub fn resume_supported(&self) -> bool {
        self.resume_supported == Some(true)
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let Some(scope) = self.scope.clone() else { return };
        let daemon = self.daemon.clone();
        let need_resume = self.resume_supported.is_none();
        let work = crate::usage::off_thread(move || {
            futures::executor::block_on(async {
                let accounts = daemon.read(&scope, "accounts:scope", json!([scope])).await;
                let resume = if need_resume { Some(daemon.read(&scope, "limits:resume-at-reset:read", json!([])).await) } else { None };
                (scope, accounts, resume)
            })
        });
        cx.spawn(async move |this, cx| {
            let Ok((scope, accounts, resume)) = work.await else { return };
            let _ = this.update(cx, |this, cx| {
                if let Some(resume) = resume {
                    this.resume_supported = Some(resume.ok().is_some_and(|value| value["resumeAtReset"].is_boolean()));
                }
                if this.scope.as_deref() != Some(scope.as_str()) {
                    return;
                }
                match accounts {
                    Ok(snapshot) => this.set_groups(project_accounts(&snapshot), cx),
                    Err(error) => this.errors.push(format!("accounts:scope: {error:#}")),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn set_groups(&mut self, groups: Vec<ProjectProvider>, cx: &mut Context<Self>) {
        self.groups = groups.clone();
        cx.set_global(PreviewProjectAccounts(groups));
        cx.refresh_windows();
        cx.notify();
    }

    /// Runs one write the views asked for.
    pub fn write(&mut self, write: AccountWrite, cx: &mut Context<Self>) {
        let scope = self.scope.clone();
        let (method, args) = match &write {
            AccountWrite::SetDefault { provider, id } => ("accounts:select", json!([provider.as_ref(), id.as_ref()])),
            AccountWrite::Assign { provider, account_id } => {
                let Some(scope) = scope.clone() else { return };
                ("accounts:assign", json!([scope, provider.id(), account_id]))
            }
            AccountWrite::RefreshUsage => {
                let Some(scope) = scope.clone() else { return };
                ("usage:read", json!([scope]))
            }
        };
        let Some(project) = scope.or_else(|| self.daemon.primary().map(|(project, _)| project)) else { return };
        let reading = matches!(write, AccountWrite::RefreshUsage);
        if reading {
            cx.set_global(PreviewUsageReading);
            cx.refresh_windows();
        }
        self.send(project, method, args, None, cx);
    }

    /// A usage-limit card's account pick at item `ix` (`chat:limit-switch`).
    pub fn limit_switch(&mut self, ix: usize, chat: (String, u64), provider: Provider, account_id: String, label: String, cx: &mut Context<Self>) {
        let (project, session) = chat;
        let args = json!([project, session, provider.id(), account_id]);
        self.send(project, "chat:limit-switch", args, Some((ix, label)), cx);
    }

    /// "Continue at" (`chat:limit-resume [scope, sessionId, sourceMessageId]`) or its Cancel (`chat:limit-resume:cancel
    /// [scope, sessionId, sendId]`).
    pub fn limit_resume(&mut self, ix: usize, chat: (String, u64), cancel: Option<String>, source: u64, cx: &mut Context<Self>) {
        let (project, session) = chat;
        let (method, args) = match cancel {
            Some(send_id) => ("chat:limit-resume:cancel", json!([project, session, send_id])),
            None => ("chat:limit-resume", json!([project, session, source])),
        };
        self.send(project, method, args, Some((ix, String::new())), cx);
    }

    fn send(&mut self, project: String, method: &'static str, args: Value, limit: Option<(usize, String)>, cx: &mut Context<Self>) {
        if self.daemon.read_only() {
            eprintln!("live: read-only, not sent: {method}");
            self.refused.push(method.to_owned());
            self.settle(method, Err("Read-only: nothing is written to Milagre's daemon in this window.".into()), limit, cx);
            return;
        }
        self.sent.push((method.to_owned(), args.clone()));
        let daemon = self.daemon.clone();
        let target = project;
        let work = crate::usage::off_thread(move || {
            futures::executor::block_on(async {
                let writer = daemon.writer(&target).await.map_err(|e| format!("{e:#}"))?;
                let answer = writer.call(method, args).await.map_err(|e| format!("{e:#}"));
                drop(writer);
                answer
            })
        });
        cx.spawn(async move |this, cx| {
            let answer = work.await.unwrap_or_else(|_| Err("The write thread ended.".into()));
            let _ = this.update(cx, |this, cx| this.settle(method, answer, limit, cx));
        })
        .detach();
    }

    fn settle(&mut self, method: &str, answer: Result<Value, String>, limit: Option<(usize, String)>, cx: &mut Context<Self>) {
        if method == "usage:read" && cx.has_global::<PreviewUsageReading>() {
            cx.remove_global::<PreviewUsageReading>();
            cx.refresh_windows();
        }
        let answer = match answer {
            Ok(value) => match method {
                "accounts:select" => Ok(Answer::Accounts(value)),
                "accounts:assign" => Ok(Answer::Scope(self.scope.clone().unwrap_or_default(), value)),
                "usage:read" => Ok(Answer::Usage(value)),
                "chat:limit-switch" => {
                    let (ix, label) = limit.clone().unwrap_or_default();
                    Ok(Answer::Limit(ix, Some(switched(&value, &label))))
                }
                "chat:limit-resume" if value == Value::Bool(false) => {
                    Err("This Chat can no longer continue at this reset time.".to_owned())
                }
                _ => Ok(Answer::Limit(limit.as_ref().map_or(0, |(ix, _)| *ix), None)),
            },
            Err(error) => Err(error),
        };
        match answer {
            Ok(Answer::Accounts(list)) => {
                cx.set_global(PreviewAccounts(crate::panels::accounts(&list)));
                cx.refresh_windows();
                // The computer default moved: a Project following it shows another account.
                self.read(cx);
            }
            Ok(Answer::Scope(scope, snapshot)) if self.scope.as_deref() == Some(scope.as_str()) => {
                self.set_groups(project_accounts(&snapshot), cx);
            }
            Ok(Answer::Scope(..)) => {}
            Ok(Answer::Usage(usage)) => {
                let snapshot = crate::usage::decode_snapshot(&usage);
                self.daemon.set_usage(snapshot.clone());
                let sidebar = self.workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |s, cx| s.set_usage(snapshot, cx));
            }
            Ok(Answer::Limit(ix, result)) => self.limit_card(ix, result, None, cx),
            Err(error) => {
                self.errors.push(format!("{method}: {error}"));
                match limit {
                    Some((ix, _)) => self.limit_card(ix, None, Some(error), cx),
                    None => {
                        let sidebar = self.workspace.read(cx).sidebar.clone();
                        sidebar.update(cx, |s, cx| s.set_notice(Some(format!("Couldn't update the account: {error}").into()), cx));
                    }
                }
            }
        }
        cx.notify();
    }

    fn limit_card(&mut self, ix: usize, result: Option<String>, error: Option<String>, cx: &mut Context<Self>) {
        let transcript = self.workspace.read(cx).chat.read(cx).transcript.clone();
        transcript.update(cx, |t, cx| {
            t.update_limit_cards(
                |at, card| {
                    if at != ix {
                        return false;
                    }
                    card.busy = false;
                    card.error = error.clone().map(Into::into);
                    if let Some(result) = &result {
                        card.result = Some(result.clone().into());
                    }
                    true
                },
                cx,
            )
        });
    }

    /// Requests sent, oldest first (tests), and the writes a read-only window refused.
    pub fn sent(&self) -> &[(String, Value)] {
        &self.sent
    }

    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }
}

/// Settings › Accounts from a limit card: opens Settings on Accounts.
pub fn open_settings(workspace: &Entity<Workspace>, window: gpui::AnyWindowHandle, cx: &mut gpui::App) {
    let settings = workspace.read(cx).settings.clone();
    let _ = window.update(cx, |_, window, cx| {
        settings.update(cx, |s, cx| s.open_section(milagre_gpui_spike::settings::SettingsSectionId::Accounts, window, cx))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_decodes_with_its_choices() {
        let groups = project_accounts(&json!({"scopeKey": "/p", "providers": [
            {"provider": "claude", "accountId": null, "effectiveId": "default", "defaultId": "default", "accounts": [
                {"id": "default", "provider": "claude", "label": "CLI", "state": "ready", "email": "me@example.com"},
                {"id": "work", "provider": "claude", "label": "Work", "state": "ready", "email": "work@example.com", "plan": "team"},
                {"id": "old", "provider": "claude", "label": "Old", "state": "signed-out"},
                {"id": "gone", "provider": "claude", "label": "Gone", "state": "ready", "missing": true}
            ]},
            {"provider": "nobody", "accounts": []}
        ]}));
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].choices().len(), 5, "computer default, then each account");
        let limit = UsageLimit { provider: Provider::Claude, account_id: Some("default".into()), resets_at: None };
        let choices = choices(&groups, &limit, 0);
        assert_eq!(choices.iter().map(|c| (c.id.as_str(), c.disabled)).collect::<Vec<_>>(), vec![("work", false), ("old", true)]);
        assert_eq!(switched(&json!({"continued": true, "label": "work@example.com"}), "x"), "Switched to work@example.com. Continuing\u{2026}");
        assert_eq!(switched(&json!({"continued": false}), "Work"), "Switched to Work. Send your message again to continue.");
    }
}
