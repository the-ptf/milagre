//! Plan usage and the usage-limit card on a fake Node daemon: the sidebar's rows and hover card are the Project's
//! `usage:cached`, read-only (never `usage:read`, which runs a provider's CLI), and a reply the plan's limit stopped
//! carries its read-only limit card. Names and numbers here are made up.

use std::time::Duration;

use gpui::{AnyView, AppContext as _, Modifiers, TestAppContext};
use gpui_component::Root;
use milagre_gpui_spike::workspace::Workspace;
use serde_json::json;

use super::fake_daemon::{FakeDaemon, World, data_folder};
use super::owned::Mounted;
use crate::controller::{DaemonSession, LiveController, install_daemon_globals};
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/alpha";
const BETA: &str = "/fake-node/beta";

fn world() -> World {
    let mut world = World::with(vec![
        (
            ALPHA,
            "alpha",
            true,
            vec![
                (1, "Alpha older", vec![("user", "Older question"), ("assistant", "Older answer")]),
                (2, "Alpha newest", vec![("user", "Newest question"), ("assistant", "Stopped by the limit")]),
            ],
        ),
        (BETA, "beta", true, vec![(1, "Beta only", vec![("user", "Beta question"), ("assistant", "Beta answer")])]),
    ]);
    world.usage = json!({
        "accountKey": "claude:default|codex:default",
        "generatedAt": "2026-11-12T10:00:00.000Z",
        "providers": [
            {"provider":"claude","status":"ok","updatedAt":"2026-11-12T09:58:00.000Z","account":{"id":"default","label":"Connected CLI account","email":"me@example.com"},
             "windows":[
               {"id":"five-hour","label":"5-hour limit","shortLabel":"5h","usedPercent":37.0,"resetsAt":"2099-01-01T13:00:00.000Z"},
               {"id":"weekly","label":"Weekly limit","shortLabel":"wk","usedPercent":81.0,"resetsAt":"2099-01-05T13:00:00.000Z"}]},
            {"provider":"codex","status":"ok","updatedAt":"2026-11-12T09:58:00.000Z","account":{"id":"default","label":"Connected CLI account"},
             "windows":[{"id":"five-hour","label":"5-hour limit","shortLabel":"5h","usedPercent":12.0,"resetsAt":"2099-01-01T13:00:00.000Z"}]},
            {"provider":"kiro","status":"unavailable","updatedAt":"2026-11-12T09:58:00.000Z","windows":[],"message":"Kiro has no usage numbers."}
        ]
    });
    // The newest Chat's last reply was stopped by the plan's limit.
    let messages = world.projects.get_mut(ALPHA).unwrap().messages.get_mut(&2).unwrap();
    messages.last_mut().unwrap()["context"] =
        json!({"kind":"limit","provider":"claude","accountId":"default","window":"five-hour","resetsAt":"2099-01-01T13:00:00.000Z"});
    world
}

fn mount(cx: &mut TestAppContext, session: DaemonSession) -> Mounted<'_> {
    let wiring = cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
        install_daemon_globals(&session, cx)
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let workspace = cx.new(|cx| Workspace::new(window, cx));
        Root::new(AnyView::from(workspace), window, cx)
    });
    let workspace = root.read_with(vcx, |root, _| root.view().clone().downcast::<Workspace>().expect("the workspace"));
    vcx.run_until_parked();
    let controller = vcx.update(|window, cx| LiveController::attach_daemon(&workspace, session, wiring, window, cx));
    vcx.run_until_parked();
    Mounted { vcx, workspace, controller }
}

#[gpui::test]
fn the_sidebar_shows_the_daemons_cached_usage_and_the_limit_card(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("usage");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert!(session.error.is_none(), "{:?}", session.error);
    let mut m = mount(cx, session);

    // The rows: one per provider with numbers (kiro has none), from `usage:cached` for the Chat on screen's Project.
    m.until("the usage rows", |m| m.vcx.debug_bounds("usage-row-Claude").is_some() && m.vcx.debug_bounds("usage-row-Codex").is_some());
    assert!(m.vcx.debug_bounds("usage-row-Kiro").is_none(), "a provider with no numbers has no row");
    let reads: Vec<_> = fake.log().into_iter().filter(|(method, _)| method.starts_with("usage:")).collect();
    assert!(
        !reads.is_empty() && reads.iter().all(|(method, _)| method == "usage:cached" || method == "usage:accounts:cached"),
        "cached reads only: {reads:?}"
    );
    assert_eq!(reads[0].1, json!([ALPHA]), "the newest Chat's Project");
    assert!(m.vcx.debug_bounds("preview-note").is_none(), "no status text under the rows");

    // The newest Chat's stopped reply carries the read-only limit card.
    m.until("the limit card", |m| m.items().iter().any(|i| i.starts_with("limit claude")));
    assert_eq!(m.items().last().map(String::as_str), Some("limit claude resets 2099-01-01T13:00:00.000Z"));
    // Its item index: the question, the reply, then the card.
    m.until("the card is drawn", |m| m.vcx.debug_bounds("usage-limit-2").is_some());
    assert!(m.vcx.debug_bounds("limit-add").is_none() && m.vcx.debug_bounds("limit-resume").is_none(), "no action is offered");

    // Hovering a row opens the card: the account, when it was read, each window with its numbers; no picker, no refresh.
    let row = m.vcx.debug_bounds("usage-row-Claude").expect("the Claude row").center();
    m.vcx.simulate_mouse_move(row, None, Modifiers::none());
    m.vcx.executor().advance_clock(Duration::from_millis(400));
    m.until("the usage card", |m| m.vcx.debug_bounds("usage-card-Claude").is_some());
    assert!(m.vcx.debug_bounds("usage-card-account").is_some());
    assert!(m.vcx.debug_bounds("usage-card-refresh").is_none(), "refresh (usage:read) is Electron's");

    // Settings › Usage: every account's cached plan usage, read-only (no default switch, no refresh).
    use milagre_gpui_spike::settings::SettingsSectionId;
    let settings = m.workspace.read_with(m.vcx, |w, _| w.settings.clone());
    m.until("the accounts' usage", |m| m.vcx.update(|_, cx| cx.has_global::<milagre_gpui_spike::workspace::preview::PreviewPlanUsage>()));
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.open_section(SettingsSectionId::Usage, window, cx)));
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("settings-section-usage").is_some(), "the Usage page is drawn");
    assert!(m.vcx.debug_bounds("usage-window-claude-default-five-hour").is_some(), "Claude's 5-hour window");
    assert!(m.vcx.debug_bounds("usage-window-claude-default-weekly").is_some());
    assert!(m.vcx.debug_bounds("usage-window-codex-default-five-hour").is_some());
    assert!(m.vcx.debug_bounds("settings-unavailable").is_none());
    assert!(m.vcx.debug_bounds("usage-set-default-claude-default").is_none(), "no write is offered");
    m.vcx.update(|window, cx| settings.update(cx, |s, cx| s.close(window, cx)));

    // Another Project's Chat: its scope is asked for.
    m.workspace.update(m.vcx, |w, cx| w.open_chat_key(&format!("{BETA}#1"), cx));
    let (sidebar, chat) = m.workspace.read_with(m.vcx, |w, _| (w.sidebar.clone(), w.chat.clone()));
    let row = sidebar.read_with(m.vcx, |s, _| s.selected_row().cloned()).expect("beta's row");
    m.vcx.update(|window, cx| chat.update(cx, |c, cx| c.set_chat(&row, window, cx)));
    m.vcx.run_until_parked();
    m.until("beta's scope", |_| fake.log().iter().any(|(method, args)| method == "usage:cached" && args == &json!([BETA])));

    let methods = fake.methods();
    assert!(!methods.iter().any(|m| m == "usage:read" || m == "usage:accounts:read" || m == "project:open"), "{methods:?}");
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}
