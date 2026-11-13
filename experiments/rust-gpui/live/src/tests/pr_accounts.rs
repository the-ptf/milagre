//! The PR panel, the sidebar's PR chip, the PR pills and the account switcher on a fake Node daemon, each driven as a
//! person would where the view allows it, and checked on the fake's request log and saved state:
//!
//! - `the_pr_panel_reads_and_writes_like_electron`: the PR tab comes with the Chat's PR; `pr:detail [{cwd, number}]`,
//!   the files' patches (`pr:diff-files`, `pr:diff-file`) and the pickers' lists are read; the review comments pill
//!   and Merge #N show until the tab does; Merge (two presses), Draft, auto-merge reach `pr:merge` / `pr:ready` with
//!   Electron's request; a refused write is taken back with its message; `pull-requests:changed` reads it again; the
//!   sidebar's PR chip opens the PR tab; an "Update branch" pill sends `chat:send` with `prAction` and the transcript
//!   shows the action card at once and after the save.
//! - `the_account_switcher_writes_like_electron`: the usage card's picker (`accounts:assign`), its refresh
//!   (`usage:read`), Settings › Accounts' radio (`accounts:select`), and the usage-limit card's switch
//!   (`chat:limit-switch`) and "Continue at" (`chat:limit-resume`).
//! - `a_read_only_window_writes_nothing`: every one of those refused before any connection.

use std::time::Duration;

use gpui::{Modifiers, TestAppContext};
use milagre_gpui_spike::workspace::panel::PanelTab;
use milagre_gpui_spike::workspace::preview::{AccountWrite, account_write};
use serde_json::{Value, json};

use super::daemon::{mount_daemon, sent};
use super::fake_daemon::{FakeDaemon, World, data_folder};
use crate::controller::DaemonSession;
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/alpha";
const BETA: &str = "/fake-node/beta";

fn pr_detail(number: u64) -> Value {
    json!({
        "number": number, "url": format!("https://github.com/acme/alpha/pull/{number}"), "title": "Make alpha faster",
        "body": "<p>Speeds up alpha.</p>", "state": "OPEN", "isDraft": false, "author": "someone",
        "createdAt": "2026-11-10T10:00:00Z", "updatedAt": "2026-11-12T10:00:00Z",
        "baseRefName": "main", "headRefName": "faster", "headRefOid": "bbb", "baseRefOid": "aaa",
        "additions": 12, "deletions": 3, "changedFiles": 2, "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
        "autoMerge": null, "viewerCanMergeAsAdmin": true, "viewerIsAuthor": true,
        "checks": [{"name": "test", "outcome": "pass"}], "reviewers": [{"login": "reviewer", "state": "APPROVED"}],
        "labels": [], "commits": [],
        "files": [{"path": "src/a.rs", "additions": 10, "deletions": 2, "status": "modified"}, {"path": "src/b.rs", "additions": 2, "deletions": 1, "status": "added"}],
        "threads": [{"id": "T1", "path": "src/a.rs", "line": 4, "side": "RIGHT", "resolved": false, "outdated": false,
                     "comments": [{"id": "C1", "author": "reviewer", "body": "Why?", "createdAt": "2026-11-11T10:00:00Z"}]}],
        "comments": [], "pendingReview": null
    })
}

fn snapshot_pr(number: u64, ready: bool, behind: bool) -> Value {
    json!({"number": number, "title": "Make alpha faster", "url": format!("https://github.com/acme/alpha/pull/{number}"), "state": "OPEN",
           "readyToMerge": ready, "isBehind": behind, "hasConflicts": false, "conflictStatusKnown": true})
}

fn world() -> World {
    let mut world = World::with(vec![
        (
            ALPHA,
            "alpha",
            true,
            vec![
                (1, "Alpha older", vec![("user", "Q"), ("assistant", "A")]),
                (2, "Alpha newest", vec![("user", "Q2"), ("assistant", "A2")]),
            ],
        ),
        (BETA, "beta", true, vec![(1, "Beta only", vec![("user", "B"), ("assistant", "BA")])]),
    ]);
    world.prs.insert(ALPHA.into(), json!({"worktrees": {(ALPHA): snapshot_pr(21, true, false)}, "chats": {}, "pending": false}));
    world.pr_details.insert(21, pr_detail(21));
    world
}

fn panel_pr(m: &mut super::owned::Mounted<'_>) -> Option<u32> {
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    panel.read_with(m.vcx, |p, cx| p.pr().read(cx).detail().map(|d| d.number))
}

fn methods(fake: &FakeDaemon, method: &str) -> Vec<Value> {
    fake.log().into_iter().filter(|(m, _)| m == method).map(|(_, args)| args).collect()
}

#[gpui::test]
fn the_pr_panel_reads_and_writes_like_electron(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("pr-panel");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));

    // The Chat's Worktree has PR #21: the tab comes, the PR is read in that folder, then its files and the pickers.
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the PR tab", |m| panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Pr)));
    m.wait_for("the PR read", |m| panel_pr(m) == Some(21));
    assert_eq!(methods(&fake, "pr:detail")[0], json!([{"cwd": ALPHA, "number": 21}]));
    m.wait_for("the patches", |_| methods(&fake, "pr:diff-file").len() == 2);
    assert_eq!(methods(&fake, "pr:diff-files")[0], json!([{"cwd": ALPHA, "base": "aaa", "head": "bbb"}]));
    assert_eq!(
        methods(&fake, "pr:diff-file")[0],
        json!([{"cwd": ALPHA, "base": "aaa", "head": "bbb", "path": "src/a.rs", "oldPath": null}])
    );
    m.wait_for("the pickers", |_| !methods(&fake, "pr:labels").is_empty() && !methods(&fake, "pr:reviewer-candidates").is_empty());

    // The pills: one open review thread, and Merge #21 (ready, no blocker), while the PR tab is not showing.
    let pills = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).pills.clone());
    m.wait_for("the review pill", |m| pills.read_with(m.vcx, |p, _| p.data().review_comments == 1));
    assert_eq!(
        pills.read_with(m.vcx, |p, _| p.data().pr_action.as_ref().map(|a| (a.label.to_string(), a.merge))),
        Some(("Merge #21".into(), true))
    );
    // The review pill opens the PR tab; then both pills hide.
    m.vcx.run_until_parked();
    let at = m.vcx.debug_bounds("pill-review").expect("the review pill").center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("the PR tab shows", |m| panel.read_with(m.vcx, |p, _| p.active() == PanelTab::Pr && p.is_open()));
    m.wait_for("the pills hide", |m| pills.read_with(m.vcx, |p, _| p.data().review_comments == 0 && p.data().pr_action.is_none()));

    // Writes, as Electron sends them: Merge needs two presses; then auto-merge and draft.
    let pr = panel.read_with(m.vcx, |p, _| p.pr().clone());
    pr.update(m.vcx, |v, cx| v.set_auto_merge(true, cx));
    m.wait_for("auto-merge", |_| !methods(&fake, "pr:merge").is_empty());
    assert_eq!(methods(&fake, "pr:merge")[0], json!([{"cwd": ALPHA, "number": 21, "method": "squash", "auto": true}]));
    m.wait_for("the write settles", |m| !pr.read_with(m.vcx, |v, _| v.writing()));
    pr.update(m.vcx, |v, cx| v.set_draft(true, cx));
    m.wait_for("draft", |_| !methods(&fake, "pr:ready").is_empty());
    assert_eq!(methods(&fake, "pr:ready")[0], json!([{"cwd": ALPHA, "number": 21, "draft": true}]));
    m.wait_for("the PR read back as a draft", |m| pr.read_with(m.vcx, |v, _| !v.writing() && v.detail().is_some_and(|d| d.is_draft)));
    pr.update(m.vcx, |v, cx| v.set_draft(false, cx));
    m.wait_for("ready", |_| methods(&fake, "pr:ready").len() == 2);
    assert_eq!(methods(&fake, "pr:ready")[1], json!([{"cwd": ALPHA, "number": 21}]));
    m.wait_for("the write settles", |m| !pr.read_with(m.vcx, |v, _| v.writing()));

    // A refused write is taken back and says why.
    fake.world().pr_refuse = Some("Merge blocked by branch rules".into());
    pr.update(m.vcx, |v, cx| v.merge(false, cx));
    pr.update(m.vcx, |v, cx| v.merge(false, cx));
    m.wait_for("the refusal", |m| pr.read_with(m.vcx, |v, _| v.write_error() == Some("Merge blocked by branch rules")));
    assert_eq!(
        pr.read_with(m.vcx, |v, _| v.detail().map(|d| d.state)),
        Some(milagre_gpui_spike::workspace::panel::pr::model::PullState::Open)
    );
    assert_eq!(methods(&fake, "pr:merge").last().unwrap()[0]["admin"], json!(false));
    m.controller.update(m.vcx, |c, _| c.take_errors());
    fake.world().pr_refuse = None;
    pr.update(m.vcx, |v, cx| v.merge(false, cx));
    pr.update(m.vcx, |v, cx| v.merge(false, cx));
    m.wait_for("merged", |m| {
        pr.read_with(m.vcx, |v, _| {
            !v.writing() && v.detail().is_some_and(|d| d.state == milagre_gpui_spike::workspace::panel::pr::model::PullState::Merged)
        })
    });

    // `pull-requests:changed` for the Project reads the PR again.
    let before = methods(&fake, "pr:detail").len();
    fake.world().emit("pull-requests:changed", json!({"projectPath": ALPHA}));
    m.wait_for("the read after the change", |_| methods(&fake, "pr:detail").len() > before);

    // The sidebar's PR chip: Beta's Chat, then a click on alpha's chip opens alpha's Chat on its PR tab.
    m.open(&format!("{BETA}#1"));
    m.wait_for("beta", |m| m.open_key().as_deref() == Some(&*format!("{BETA}#1")));
    m.wait_for("no PR tab on beta", |m| !panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Pr)));
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    let ix = m.row_keys().iter().position(|k| *k == key).expect("alpha's row");
    m.wait_for("the chip's PR", |m| sidebar.read_with(m.vcx, |s, _| s.rows()[ix].pr_number == Some(21)));
    m.vcx.run_until_parked();
    let chip = format!("chat-row-prs-{ix}");
    let at = m.vcx.debug_bounds(Box::leak(chip.into_boxed_str())).expect("the PR chip").center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("alpha on its PR tab", |m| {
        m.open_key().as_deref() == Some(key.as_str()) && panel.read_with(m.vcx, |p, _| p.active() == PanelTab::Pr && p.is_open())
    });

    // An "Update branch" pill (the branch PR is behind): sent with `prAction`, the action card shown at once and kept.
    {
        let mut w = fake.world();
        w.prs.insert(ALPHA.into(), json!({"worktrees": {(ALPHA): snapshot_pr(22, false, true)}, "chats": {}, "pending": false}));
        w.pr_details.insert(22, pr_detail(22));
        w.emit("pull-requests:changed", json!({"projectPath": ALPHA}));
    }
    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Details, cx));
    m.wait_for("the Update branch pill", |m| {
        pills.read_with(m.vcx, |p, _| p.data().pr_action.as_ref().is_some_and(|a| a.label.as_str() == "Update branch"))
    });
    m.vcx.run_until_parked();
    let at = m.vcx.debug_bounds("pill-pr-action").expect("the PR pill").center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.vcx.run_until_parked();
    assert!(m.items().iter().any(|i| i == "pr action behind #22"), "the card shows at once: {:?}", m.items());
    m.wait_for("the PR action sent", |_| sent(&fake).iter().any(|s| s.get("prAction").is_some()));
    let action = sent(&fake).into_iter().find(|s| s.get("prAction").is_some()).unwrap();
    assert_eq!(action["prAction"], json!({"action": "behind", "pr": 22, "url": "https://github.com/acme/alpha/pull/22"}));
    assert_eq!((action["sessionId"].as_u64(), action["worktreeId"].as_u64()), (Some(2), Some(1)));
    assert!(!action["model"].as_str().unwrap_or_default().is_empty(), "a model is named");
    m.wait_for("the saved card", |m| !m.running() && m.items().iter().filter(|i| *i == "pr action behind #22").count() == 1);
    assert!(pills.read_with(m.vcx, |p, _| p.data().pr_action.is_none()), "the pill hides once its fix is asked for");

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

fn accounts_world() -> World {
    let mut world = world();
    world.scope_accounts = json!({"scopeKey": ALPHA, "providers": [{"provider": "claude", "accountId": null, "effectiveId": "default", "defaultId": "default", "accounts": [
        {"id": "default", "provider": "claude", "label": "Connected CLI account", "state": "ready", "email": "me@example.com"},
        {"id": "work", "provider": "claude", "label": "Work", "state": "ready", "email": "work@example.com", "plan": "team"}]}]});
    world.usage = json!({"providers": [{"provider": "claude", "status": "ok", "updatedAt": "2026-11-12T09:58:00.000Z",
        "account": {"id": "default", "label": "Connected CLI account", "email": "me@example.com"},
        "windows": [{"id": "five-hour", "label": "5-hour limit", "shortLabel": "5h", "usedPercent": 100.0, "resetsAt": "2099-01-01T13:00:00.000Z"}]}]});
    let chat = world.projects.get_mut(ALPHA).unwrap();
    let last = chat.messages.get_mut(&2).unwrap().last_mut().unwrap();
    last["context"] = json!({"kind": "limit", "provider": "claude", "accountId": "default", "window": "five-hour", "resetsAt": "2099-01-01T13:00:00.000Z"});
    let source = last["id"].clone();
    chat.sessions.get_mut(&2).unwrap()["limitTurn"] = json!({"sourceMessageId": source});
    world
}

#[gpui::test]
fn the_account_switcher_writes_like_electron(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("accounts");
    let fake = FakeDaemon::start(&data, accounts_world());
    let source = fake.world().projects[ALPHA].messages[&2].last().unwrap()["id"].as_u64().unwrap();
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    m.wait_for("the scope's accounts", |_| methods(&fake, "accounts:scope").first() == Some(&json!([ALPHA])));

    // The usage card's account line is a picker (two saved accounts): Work is picked → `accounts:assign`.
    m.wait_for("the usage row", |m| m.vcx.debug_bounds("usage-row-Claude").is_some());
    let row = m.vcx.debug_bounds("usage-row-Claude").unwrap().center();
    m.vcx.simulate_mouse_move(row, None, Modifiers::none());
    m.vcx.executor().advance_clock(Duration::from_millis(400));
    m.wait_for("the usage card", |m| m.vcx.debug_bounds("usage-card-Claude").is_some());
    m.wait_for("the picker", |m| m.vcx.debug_bounds("usage-card-account").is_some());
    let at = m.vcx.debug_bounds("usage-card-account").unwrap().center();
    m.vcx.simulate_mouse_move(at, None, Modifiers::none());
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("the picker's choices", |m| m.vcx.debug_bounds("usage-card-pick-2").is_some());
    let at = m.vcx.debug_bounds("usage-card-pick-2").unwrap().center();
    m.vcx.simulate_click(at, Modifiers::none());
    m.wait_for("accounts:assign", |_| !methods(&fake, "accounts:assign").is_empty());
    assert_eq!(methods(&fake, "accounts:assign")[0], json!([ALPHA, "claude", "work"]));

    // The refresh (usage:read for the scope), and Settings' radio (accounts:select).
    m.vcx.update(|_, cx| assert!(account_write(AccountWrite::RefreshUsage, cx)));
    m.wait_for("usage:read", |_| methods(&fake, "usage:read") == vec![json!([ALPHA])]);
    m.vcx.update(|_, cx| account_write(AccountWrite::SetDefault { provider: "claude".into(), id: "work".into() }, cx));
    m.wait_for("accounts:select", |_| methods(&fake, "accounts:select") == vec![json!(["claude", "work"])]);
    m.wait_for("the new default", |m| {
        m.vcx.update(|_, cx| {
            cx.try_global::<milagre_gpui_spike::workspace::preview::PreviewAccounts>()
                .is_some_and(|a| a.0.iter().any(|a| a.id.as_ref() == "work" && a.selected))
        })
    });

    // The usage-limit card: its account choice (`chat:limit-switch`) and "Continue at" (`chat:limit-resume`).
    m.wait_for("the limit card's choice", |m| {
        m.vcx.debug_bounds("limit-account-2-0").is_some() || m.vcx.debug_bounds("limit-account-3-0").is_some()
    });
    let ix = if m.vcx.debug_bounds("limit-account-2-0").is_some() { 2 } else { 3 };
    let resume = m.vcx.debug_bounds("limit-resume").expect("Continue at").center();
    m.vcx.simulate_click(resume, Modifiers::none());
    m.wait_for("chat:limit-resume", |_| !methods(&fake, "chat:limit-resume").is_empty());
    assert_eq!(methods(&fake, "chat:limit-resume")[0], json!([ALPHA, 2, source]));
    m.wait_for("the card settles", |m| m.vcx.debug_bounds(Box::leak(format!("limit-account-{ix}-0").into_boxed_str())).is_some());
    let choice = m.vcx.debug_bounds(Box::leak(format!("limit-account-{ix}-0").into_boxed_str())).unwrap().center();
    m.vcx.simulate_click(choice, Modifiers::none());
    m.wait_for("chat:limit-switch", |_| !methods(&fake, "chat:limit-switch").is_empty());
    assert_eq!(methods(&fake, "chat:limit-switch")[0][0], json!(ALPHA));
    assert_eq!(methods(&fake, "chat:limit-switch")[0][1], json!(2));
    assert_eq!(methods(&fake, "chat:limit-switch")[0][2], json!("claude"));
    let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
    m.wait_for("Switched to …", |m| {
        transcript.read_with(m.vcx, |t, _| {
            t.items().iter().any(|i| matches!(i, milagre_gpui_spike::workspace::chat::transcript::Item::Card(
                milagre_gpui_spike::workspace::chat::transcript::cards::Card::Limit(c)) if c.result.as_deref() == Some("Switched to work@example.com. Continuing\u{2026}")))
        })
    });

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_read_only_window_writes_nothing(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("pr-read-only");
    let fake = FakeDaemon::start(&data, accounts_world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), true));
    let mut m = mount_daemon(cx, session);
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the PR read", |m| panel_pr(m) == Some(21));
    let pr = panel.read_with(m.vcx, |p, _| p.pr().clone());
    pr.update(m.vcx, |v, cx| v.set_draft(true, cx));
    m.wait_for("the refusal", |m| pr.read_with(m.vcx, |v, _| v.write_error().is_some_and(|e| e.starts_with("Read-only"))));
    m.vcx.update(|_, cx| {
        account_write(AccountWrite::RefreshUsage, cx);
        account_write(AccountWrite::SetDefault { provider: "claude".into(), id: "work".into() }, cx);
        account_write(AccountWrite::Assign { provider: milagre_gpui_spike::data::Provider::Claude, account_id: Some("work".into()) }, cx);
    });
    m.vcx.run_until_parked();
    let written: Vec<String> = fake
        .methods()
        .into_iter()
        .filter(|m| {
            m.starts_with("pr:merge")
                || m.starts_with("pr:ready")
                || m.starts_with("accounts:assign")
                || m.starts_with("accounts:select")
                || m == "usage:read"
                || m.starts_with("chat:limit")
                || m == "chat:send"
        })
        .collect();
    assert!(written.is_empty(), "nothing written: {written:?}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}
