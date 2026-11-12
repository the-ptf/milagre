//! Plan usage and the usage-limit card on Milagre's Node daemon, read-only, as the Electron window shows them.
//!
//! - The sidebar's usage rows and hover card are the Project's `usage:cached` (what `useUsage` seeds from before it
//!   reads), for the Chat on screen's Project (`accountScope` in `App.tsx`): the numbers, the account they were read
//!   for, when. It is read again every [`READ_EVERY`] and whenever the Chat on screen changes Project. Only the cached
//!   read is made: `usage:read` runs the provider's CLI, which Electron's own window does on its poll (every five
//!   minutes and when its hover card opens) and writes the cache this reads, so the numbers here are as fresh as
//!   Electron's, and the Preview never causes a provider request. The card's refresh button and account picker
//!   are off ([`LiveUsage`]).
//! - The usage-limit card under a reply the plan's limit stopped (`UsageLimitCard.tsx`) is built from the message's
//!   `{ kind: "limit" }` context: its heading and when it resets, in this computer's zone. Its actions (switch account,
//!   continue at reset) are Electron's: they write.
//!
//! A read that fails (the daemon restarted, a Project went away) keeps the numbers on screen.

use std::sync::Arc;
use std::time::Duration;

use gpui::{App, AppContext as _, AsyncApp, Context, Entity, Global, SharedString, Task, WeakEntity};
use milagre_gpui_spike::data::{AccountRef, AccountUsage, ChatContext, Provider, ProviderUsage, UsageSnapshot, UsageStatus, WindowUsage};
use milagre_gpui_spike::logic::usage::limit::UsageLimit;
use milagre_gpui_spike::workspace::chat::transcript::cards::LimitCard;
use milagre_gpui_spike::workspace::preview::{LiveUsage, PreviewPlanUsage};
use milagre_gpui_spike::workspace::sidebar::Sidebar;
use serde_json::{Value, json};

use crate::daemon::Daemon;

/// How often the cached numbers are read again (Electron's own poll is five minutes and refreshes the cache).
pub const READ_EVERY: Duration = Duration::from_secs(60);

/// `usage:cached`'s answer (`UsageSnapshot` in `packages/shared/src/model.ts`). A provider entry that does not read
/// as one (an unknown provider, no status) is left out: nothing is made up.
pub fn decode_snapshot(value: &Value) -> UsageSnapshot {
    let text = |value: &Value| value.as_str().map(|s| SharedString::from(s.to_owned()));
    UsageSnapshot {
        account_key: text(&value["accountKey"]),
        generated_at: text(&value["generatedAt"]),
        providers: value["providers"].as_array().map(|list| list.iter().filter_map(decode_provider).collect()).unwrap_or_default(),
    }
}

fn decode_provider(value: &Value) -> Option<ProviderUsage> {
    let provider = Provider::from_id(value["provider"].as_str()?)?;
    let status = match value["status"].as_str()? {
        "ok" => UsageStatus::Ok,
        "unavailable" => UsageStatus::Unavailable,
        "error" => UsageStatus::Error,
        _ => return None,
    };
    let account = value["account"].as_object().map(|_| {
        let account = &value["account"];
        AccountRef {
            id: account["id"].as_str().unwrap_or_default().to_owned(),
            label: account["label"].as_str().unwrap_or_default().to_owned(),
            email: account["email"].as_str().map(str::to_owned),
        }
    });
    let windows = value["windows"].as_array()?.iter().filter_map(decode_window).collect();
    Some(ProviderUsage {
        usage: AccountUsage {
            account,
            provider,
            status,
            windows,
            updated_at: value["updatedAt"].as_str().unwrap_or_default().to_owned(),
            banked_resets: value["bankedResets"].as_u64().map(|n| n as u32),
        },
        checked_at: value["checkedAt"].as_str().map(|s| s.to_owned().into()),
        message: value["message"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_owned().into()),
    })
}

fn decode_window(value: &Value) -> Option<WindowUsage> {
    Some(WindowUsage {
        id: value["id"].as_str()?.to_owned(),
        label: value["label"].as_str()?.to_owned(),
        short_label: value["shortLabel"].as_str().or_else(|| value["label"].as_str())?.to_owned(),
        used_percent: value["usedPercent"].as_f64()?,
        resets_at: value["resetsAt"].as_str().map(str::to_owned),
        detail: value["detail"].as_str().map(str::to_owned),
    })
}

/// The Project a Chat key (`<scope>#<id>`) names.
pub fn scope_of_chat_key(key: &str) -> Option<&str> {
    key.rsplit_once('#').map(|(scope, _)| scope).filter(|scope| !scope.is_empty())
}

/// The usage-limit card for a reply whose context is `{ kind: "limit" }` (kept whole in `ChatContext::Other`), or the
/// typed context when a decoder produces one. It is the read-only card: the heading and when the limit resets.
pub fn limit_card(context: &ChatContext, now: i64) -> Option<LimitCard> {
    let limit = match context {
        ChatContext::Limit { provider, account_id, resets_at, .. } => UsageLimit {
            provider: *provider,
            account_id: account_id.as_ref().map(ToString::to_string),
            resets_at: resets_at.as_ref().map(ToString::to_string),
        },
        ChatContext::Other { kind, raw } if kind.as_ref() == "limit" => UsageLimit {
            provider: Provider::from_id(raw["provider"].as_str()?)?,
            account_id: raw["accountId"].as_str().map(str::to_owned),
            resets_at: raw["resetsAt"].as_str().map(str::to_owned),
        },
        _ => return None,
    };
    Some(LimitCard {
        limit,
        now,
        choices: Vec::new(),
        pending_at: None,
        interactive: false,
        result: None,
        resume: false,
        live: false,
        busy: false,
        error: None,
        message: None,
    })
}

/// One `usage:cached` read for `scope` (a Project's path; `None` reads the computer's default accounts), on a short
/// request-only connection of `project`. Nothing is loaded, nothing is written.
pub async fn read_cached(daemon: &Daemon, project: &str, scope: Option<&str>) -> anyhow::Result<UsageSnapshot> {
    let answer = daemon.read(project, "usage:cached", json!([scope])).await?;
    Ok(decode_snapshot(&answer))
}

/// One `usage:accounts:cached` read: every saved account's last plan usage on this computer (Settings › Usage).
pub async fn read_accounts_cached(daemon: &Daemon, project: &str) -> anyhow::Result<UsageSnapshot> {
    let answer = daemon.read(project, "usage:accounts:cached", json!([])).await?;
    Ok(decode_snapshot(&answer))
}

/// Runs `work` on a thread of its own and answers on any executor.
pub(crate) fn off_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> futures::channel::oneshot::Receiver<T> {
    let (sender, receiver) = futures::channel::oneshot::channel();
    std::thread::Builder::new()
        .name("milagre-live-usage".into())
        .spawn(move || {
            let _ = sender.send(work());
        })
        .expect("a worker thread");
    receiver
}

/// Keeps the sidebar's usage current. Held by a global; it ends with the sidebar.
pub struct Poller {
    sidebar: WeakEntity<Sidebar>,
    daemon: Arc<Daemon>,
    /// The Project the numbers were last asked for.
    scope: Option<String>,
    reading: bool,
    again: bool,
    /// When the every-account numbers were last asked for.
    accounts_at: Option<std::time::Instant>,
    reads: u64,
    errors: Vec<String>,
    _task: Option<Task<()>>,
}

struct Held(#[allow(dead_code)] Entity<Poller>);

impl Global for Held {}

/// Turns usage on for Milagre's daemon: the rows and card show (read-only) and are read now and every [`READ_EVERY`].
pub fn attach(sidebar: &Entity<Sidebar>, daemon: Arc<Daemon>, cx: &mut App) -> Entity<Poller> {
    cx.set_global(LiveUsage);
    let poller = cx.new(|cx| Poller::new(sidebar, daemon, cx));
    cx.set_global(Held(poller.clone()));
    poller
}

impl Poller {
    fn new(sidebar: &Entity<Sidebar>, daemon: Arc<Daemon>, cx: &mut Context<Self>) -> Self {
        // The sidebar notifies on every selection; only a new Project's scope asks again.
        cx.observe(sidebar, |this, sidebar, cx| {
            let scope = this.scope_on_screen(&sidebar, cx);
            if scope != this.scope {
                this.read(cx);
            }
        })
        .detach();
        let task = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                if this.update(cx, |this, cx| this.read(cx)).is_err() {
                    return;
                }
                cx.background_executor().timer(READ_EVERY).await;
            }
        });
        Self {
            sidebar: sidebar.downgrade(),
            daemon,
            scope: None,
            reading: false,
            again: false,
            accounts_at: None,
            reads: 0,
            errors: Vec::new(),
            _task: Some(task),
        }
    }

    /// The Project of the Chat on screen, else the daemon's most recently opened one (Electron's current Project).
    fn scope_on_screen(&self, sidebar: &Entity<Sidebar>, cx: &App) -> Option<String> {
        let chosen = sidebar.read(cx).selected_row().and_then(|row| scope_of_chat_key(&row.key).map(str::to_owned));
        chosen.or_else(|| self.daemon.known().first().map(|known| known.path.clone()))
    }

    /// Reads `usage:cached` for the Chat on screen's Project (one read at a time; one more after it if asked meanwhile).
    pub fn read(&mut self, cx: &mut Context<Self>) {
        let Some(sidebar) = self.sidebar.upgrade() else { return };
        if self.reading {
            self.again = true;
            return;
        }
        let scope = self.scope_on_screen(&sidebar, cx);
        self.scope = scope.clone();
        // No Project known yet (no sync): nothing to ask.
        let Some(project) = scope.clone().or_else(|| self.daemon.known().first().map(|known| known.path.clone())) else { return };
        self.reading = true;
        let daemon = self.daemon.clone();
        // Settings › Usage's every-account numbers: with the first read and then on the poll, not on a Project switch.
        let accounts = self.accounts_at.is_none_or(|at| at.elapsed() >= READ_EVERY - Duration::from_secs(5));
        if accounts {
            self.accounts_at = Some(std::time::Instant::now());
        }
        let read = off_thread(move || {
            futures::executor::block_on(async {
                let sidebar = read_cached(&daemon, &project, scope.as_deref()).await;
                let accounts = if accounts { Some(read_accounts_cached(&daemon, &project).await) } else { None };
                (sidebar, accounts)
            })
        });
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let answer = read.await;
            let _ = this.update(cx, |this, cx| {
                this.reading = false;
                this.reads += 1;
                match answer {
                    Ok((sidebar_read, accounts_read)) => {
                        match sidebar_read {
                            Ok(snapshot) => {
                                this.daemon.set_usage(snapshot.clone());
                                if let Some(sidebar) = this.sidebar.upgrade() {
                                    sidebar.update(cx, |sidebar, cx| sidebar.set_usage(snapshot, cx));
                                }
                            }
                            // The numbers on screen stay.
                            Err(error) => this.errors.push(format!("usage:cached: {error:#}")),
                        }
                        match accounts_read {
                            Some(Ok(snapshot)) if cx.try_global::<PreviewPlanUsage>().is_none_or(|held| held.0 != snapshot) => {
                                cx.set_global(PreviewPlanUsage(snapshot));
                                cx.refresh_windows();
                            }
                            Some(Err(error)) => {
                                this.accounts_at = None;
                                this.errors.push(format!("usage:accounts:cached: {error:#}"));
                            }
                            _ => {}
                        }
                    }
                    Err(_) => this.errors.push("usage:cached: the read thread ended".into()),
                }
                if std::mem::take(&mut this.again) {
                    this.read(cx);
                }
            });
        })
        .detach();
    }

    /// How many reads have finished, and the errors they ended with (tests and evidence).
    pub fn reads(&self) -> u64 {
        self.reads
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cached_read_decodes_as_electron_reads_it() {
        let snapshot = decode_snapshot(&json!({
            "accountKey": "claude:default|codex:default",
            "generatedAt": "2026-11-12T10:00:00.000Z",
            "providers": [
                {"provider":"claude","status":"ok","updatedAt":"2026-11-12T09:58:00.000Z","checkedAt":"2026-11-12T09:59:00.000Z",
                 "bankedResets":2,
                 "account":{"id":"default","label":"Connected CLI account","email":"me@example.com","state":"ready","default":true},
                 "windows":[
                   {"id":"five-hour","label":"5-hour limit","shortLabel":"5h","usedPercent":23.4,"resetsAt":"2026-11-12T13:00:00.000Z"},
                   {"id":"weekly","label":"Weekly limit","shortLabel":"wk","usedPercent":61,"resetsAt":null,"detail":"61 of 100 credits"}]},
                {"provider":"codex","status":"error","updatedAt":"2026-11-12T08:00:00.000Z","message":"The Codex CLI timed out.","windows":[]},
                {"provider":"nobody","status":"ok","updatedAt":"x","windows":[]},
                {"provider":"kiro","status":"strange","updatedAt":"x","windows":[]}
            ]
        }));
        assert_eq!(snapshot.account_key.as_deref(), Some("claude:default|codex:default"));
        assert_eq!(snapshot.providers.len(), 2, "an unknown provider and an unknown status are left out");
        let claude = &snapshot.providers[0];
        assert_eq!((claude.provider, claude.status, claude.banked_resets), (Provider::Claude, UsageStatus::Ok, Some(2)));
        assert_eq!(claude.account.as_ref().and_then(|a| a.email.as_deref()), Some("me@example.com"));
        assert_eq!(claude.windows.len(), 2);
        assert_eq!((claude.windows[0].short_label.as_str(), claude.windows[0].used_percent), ("5h", 23.4));
        assert_eq!(claude.windows[1].resets_at, None);
        assert_eq!(claude.windows[1].detail.as_deref(), Some("61 of 100 credits"));
        assert_eq!(claude.checked_at.as_deref(), Some("2026-11-12T09:59:00.000Z"));
        let codex = &snapshot.providers[1];
        assert_eq!(
            (codex.status, codex.windows.len(), codex.message.as_deref()),
            (UsageStatus::Error, 0, Some("The Codex CLI timed out."))
        );
        assert_eq!(decode_snapshot(&json!({"providers": []})), UsageSnapshot::default());
        assert_eq!(decode_snapshot(&Value::Null), UsageSnapshot::default());
    }

    #[test]
    fn a_chat_key_names_its_project() {
        assert_eq!(scope_of_chat_key("/work/alpha#12"), Some("/work/alpha"));
        assert_eq!(scope_of_chat_key("/work/a#b/c#3"), Some("/work/a#b/c"));
        assert_eq!(scope_of_chat_key("no-id"), None);
    }

    #[test]
    fn a_limit_context_becomes_the_read_only_card() {
        let raw =
            json!({"kind":"limit","provider":"claude","accountId":"default","window":"five-hour","resetsAt":"2026-11-12T13:00:00.000Z"});
        let context = ChatContext::Other { kind: "limit".into(), raw };
        let card = limit_card(&context, 1_000).expect("a card");
        assert_eq!((card.limit.provider, card.limit.account_id.as_deref()), (Provider::Claude, Some("default")));
        assert_eq!(card.limit.resets_at.as_deref(), Some("2026-11-12T13:00:00.000Z"));
        assert!(!card.interactive && card.choices.is_empty() && card.pending_at.is_none(), "no write is offered");
        let other = ChatContext::Other { kind: "linked-notice".into(), raw: json!({"kind":"linked-notice"}) };
        assert!(limit_card(&other, 0).is_none());
        let broken = ChatContext::Other { kind: "limit".into(), raw: json!({"kind":"limit"}) };
        assert!(limit_card(&broken, 0).is_none(), "no provider, no card");
    }
}
