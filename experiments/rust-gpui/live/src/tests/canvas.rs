//! The Designs and Artifact tabs on a fake Node daemon ([`crate::canvas`]), checked on the fake's request log:
//!
//! - `designs_and_the_page_read_and_write_like_electron`: opening a Chat with designs and a page reads
//!   `artifact:list`, `artifact:comments`, every kept version (`artifact:get {chatId, id, version}`), the page
//!   (`artifact:get {chatId, id}`) and its file in chunks (`artifact:asset {chatId, name, offset}`); the Designs and
//!   Artifact tabs show, the designs with their kept versions and pins, the page with its tabs, file and comments.
//!   An agent step that shows a design reads it all again once it ends (versions already read are not); Delete sends
//!   `artifact:delete [{chatId, id}]` and the board follows the read; Send with a chosen version sends Electron's
//!   message through `chat:send`. A Chat without any shows neither tab.
//! - `a_read_only_window_deletes_nothing`: Delete (and recording comments) is refused before any connection.
//! - `comments_send_and_record_like_electron`: a comment pinned on a design and one on the page, each written in its
//!   bubble, go to the Chat with Send as Electron's message (`chat:send`) and are then recorded with
//!   `artifact:add-comments [{chatId, comments}]`; the read after shows them as sent pins; typing still reaches the
//!   composer.

use gpui::TestAppContext;
use milagre_gpui_spike::workspace::panel::PanelTab;
use serde_json::{Value, json};

use super::daemon::{mount_daemon, sent};
use super::fake_daemon::{Canvas, FakeDaemon, World, data_folder};
use crate::controller::DaemonSession;
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/alpha";

/// A small valid design document (`validateDesignDocument`'s shape).
fn document(title: &str) -> Value {
    json!({"schemaVersion": 1, "width": 390, "height": 844, "background": "#ffffff",
           "nodes": [{"id": "title", "type": "text", "x": 24, "y": 80, "width": 342, "height": 40, "text": title, "fontSize": 28, "fill": "#111111"}]})
}

fn canvas() -> Canvas {
    let mut canvas = Canvas {
        list: vec![
            json!({"id": "welcome", "title": "Welcome", "version": 3, "versions": 2, "format": "design", "group": "Onboarding", "width": 390, "height": 844}),
            json!({"id": "sign-in", "title": "Sign in", "version": 1, "versions": 1, "format": "design", "group": "Onboarding", "width": 390, "height": 844}),
            json!({"id": "report", "title": "Report", "version": 4, "versions": 1, "format": "html", "width": 720, "height": 900}),
            json!({"id": "reply", "title": "Inline reply", "version": 1, "versions": 1, "format": "html", "inline": true}),
        ],
        ..Canvas::default()
    };
    for (id, version) in [("welcome", 2), ("welcome", 3), ("sign-in", 1)] {
        canvas.gets.insert(
            format!("{id} {version}"),
            json!({"id": id, "version": version, "format": "design", "document": document(&format!("{id} v{version}"))}),
        );
    }
    canvas.gets.insert(
        "report".into(),
        json!({"id": "report", "title": "Report", "version": 4, "format": "html", "html": "<h1>Report</h1>",
               "tabs": [{"id": "status", "title": "Status", "html": "<h1>Status</h1><img src=\"assets/chart.png\">"},
                        {"id": "numbers", "title": "Numbers", "html": "<p>42</p>"}],
               "assets": [{"name": "chart.png", "hash": "abc", "size": 5, "type": "image/png"}]}),
    );
    canvas.files.insert("chart.png".into(), vec![1, 2, 3, 4, 5]);
    canvas.comments = vec![
        json!({"id": "c1", "design": {"id": "welcome", "version": 3, "title": "Welcome"}, "x": 0.5, "y": 0.1, "text": "Bigger", "createdAt": 1}),
        json!({"id": "c2", "design": {"id": "welcome", "version": 2, "title": "Welcome"}, "x": 0.2, "y": 0.3, "text": "Old one", "createdAt": 2,
               "resolved": {"note": "Done", "at": 3}}),
        json!({"id": "c3", "design": {"id": "report", "version": 4, "title": "Report", "format": "html"}, "x": 0.4, "y": 0.6,
               "anchor": "h1:1@0.5,0.5", "tab": {"id": "status", "title": "Status"}, "text": "Which week?", "createdAt": 4}),
    ];
    canvas
}

fn world() -> World {
    let mut world = World::with(vec![(
        ALPHA,
        "alpha",
        true,
        vec![(1, "Plain Chat", vec![("user", "Q"), ("assistant", "A")]), (2, "Designs Chat", vec![("user", "Q2"), ("assistant", "A2")])],
    )]);
    world.canvases.insert(format!("{ALPHA}#2"), canvas());
    world
}

fn methods(fake: &FakeDaemon, method: &str) -> Vec<Value> {
    fake.log().into_iter().filter(|(m, _)| m == method).map(|(_, args)| args).collect()
}

#[gpui::test]
fn designs_and_the_page_read_and_write_like_electron(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("canvas");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("both tabs", |m| {
        panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Designs) && p.visible_tabs().contains(&PanelTab::Artifact))
    });
    let request = json!([{"chatId": key}]);
    assert_eq!(methods(&fake, "artifact:list")[0], request);
    assert_eq!(methods(&fake, "artifact:comments")[0], request);
    let gets = methods(&fake, "artifact:get");
    for (id, version) in [("welcome", 2), ("welcome", 3), ("sign-in", 1)] {
        assert!(gets.contains(&json!([{"chatId": key, "id": id, "version": version}])), "{id} v{version}: {gets:?}");
    }
    assert!(!gets.iter().any(|g| g[0]["id"] == "welcome" && g[0]["version"] == 1), "v1 is not kept");
    assert!(gets.contains(&json!([{"chatId": key, "id": "report"}])));
    assert!(!gets.iter().any(|g| g[0]["id"] == "reply"), "an inline reply is not the page");
    let assets = methods(&fake, "artifact:asset");
    assert_eq!(assets.iter().map(|a| a[0]["offset"].as_u64().unwrap()).collect::<Vec<_>>(), vec![0, 2, 4], "in chunks");

    // The board: two designs, welcome with versions 2..3 and its pins; the page with its tabs, file and comment.
    let (designs, artifacts) = panel.read_with(m.vcx, |p, _| (p.designs().clone(), p.artifacts().clone()));
    let read = designs.read_with(m.vcx, |d, _| {
        (d.designs().iter().map(|d| (d.id.clone(), d.first, d.latest(), d.group.clone())).collect::<Vec<_>>(), d.pins().to_vec())
    });
    assert_eq!(
        read.0,
        vec![("welcome".to_owned(), 2, 3, Some("Onboarding".to_owned())), ("sign-in".to_owned(), 1, 1, Some("Onboarding".to_owned()))]
    );
    assert_eq!(
        read.1.iter().map(|p| (p.id.as_str(), p.version, p.number, p.resolved)).collect::<Vec<_>>(),
        vec![("c1", 3, 1, false), ("c2", 2, 2, true)]
    );
    let page = artifacts.read_with(m.vcx, |a, _| a.page().clone());
    assert_eq!((page.id.as_ref(), page.version, page.tabs.len()), ("report", 4, 2));
    assert_eq!(
        page.assets.iter().map(|a| (a.name.as_str(), a.mime.as_str(), a.bytes.to_vec())).collect::<Vec<_>>(),
        vec![("chart.png", "image/png", vec![1, 2, 3, 4, 5])]
    );
    assert_eq!(
        page.comments.iter().map(|c| (c.id.as_ref(), c.tab.as_ref(), c.anchor.as_deref())).collect::<Vec<_>>(),
        vec![("c3", "status", Some("h1:1@0.5,0.5"))]
    );

    // An agent shows a new version: once its step ends, the Chat is read again; versions read before are not.
    let reads = m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).reads());
    {
        let mut w = fake.world();
        let canvas = w.canvases.get_mut(&key).unwrap();
        canvas.list[0]["version"] = json!(4);
        canvas.list[0]["versions"] = json!(3);
        canvas
            .gets
            .insert("welcome 4".into(), json!({"id": "welcome", "version": 4, "format": "design", "document": document("welcome v4")}));
        w.agent(
            &key,
            json!({"type": "step-started", "step": {"id": "s1", "kind": "artifact", "tool": "design_apply", "title": "Revised Welcome"}}),
        );
        w.agent(&key, json!({"type": "step-completed", "id": "s1"}));
    }
    m.wait_for("the read after the step", |m| m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).reads()) > reads);
    m.wait_for("version 4", |m| designs.read_with(m.vcx, |d, _| d.design("welcome").is_some_and(|w| w.latest() == 4)));
    let gets = methods(&fake, "artifact:get");
    assert_eq!(gets.iter().filter(|g| g[0]["id"] == "welcome" && g[0]["version"] == 3).count(), 1, "v3 read once");
    // A step that is not a canvas step reads nothing.
    let reads = m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).reads());
    {
        let mut w = fake.world();
        w.agent(&key, json!({"type": "step-started", "step": {"id": "s2", "kind": "shell", "title": "ls"}}));
        w.agent(&key, json!({"type": "step-completed", "id": "s2"}));
    }
    m.vcx.run_until_parked();
    std::thread::sleep(std::time::Duration::from_millis(200));
    m.vcx.run_until_parked();
    assert_eq!(m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).reads()), reads);

    // Delete: `artifact:delete [{chatId, id}]`, then the board follows the read.
    designs.update(m.vcx, |d, cx| d.delete("sign-in", cx));
    m.wait_for("artifact:delete", |_| !methods(&fake, "artifact:delete").is_empty());
    assert_eq!(methods(&fake, "artifact:delete")[0], json!([{"chatId": key, "id": "sign-in"}]));
    m.wait_for("the read after the delete", |m| {
        designs.read_with(m.vcx, |d, _| d.designs().len() == 1)
            && m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).reads()) > reads
    });

    // Send with a chosen version: Electron's message, through the composer's `chat:send`.
    designs.update(m.vcx, |d, cx| {
        d.choose("welcome", cx);
        d.send(cx);
    });
    m.wait_for("chat:send", |_| sent(&fake).iter().any(|r| r["body"].as_str().is_some_and(|b| b.starts_with("I chose the design"))));
    let body = sent(&fake).into_iter().find_map(|r| r["body"].as_str().map(str::to_owned).filter(|b| b.starts_with("I chose"))).unwrap();
    assert_eq!(body, "I chose the design \"Welcome\" (welcome, version 4). Continue from this one.");

    // A Chat with no designs and no page: neither tab.
    m.open(&format!("{ALPHA}#1"));
    m.wait_for("the plain Chat", |m| m.open_key().as_deref() == Some(format!("{ALPHA}#1").as_str()));
    m.wait_for("its list read", |_| methods(&fake, "artifact:list").iter().any(|a| a[0]["chatId"] == format!("{ALPHA}#1")));
    m.vcx.run_until_parked();
    let tabs = panel.read_with(m.vcx, |p, _| p.visible_tabs());
    assert!(!tabs.contains(&PanelTab::Designs) && !tabs.contains(&PanelTab::Artifact), "{tabs:?}");
    assert!(m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).errors().is_empty()));

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn a_read_only_window_deletes_nothing(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("canvas-read-only");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), true));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("the Designs tab", |m| panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Designs)));
    let designs = panel.read_with(m.vcx, |p, _| p.designs().clone());
    designs.update(m.vcx, |d, cx| d.delete("sign-in", cx));
    m.wait_for("the refusal", |m| m.controller.read_with(m.vcx, |c, cx| !c.live_canvas().unwrap().read(cx).refused().is_empty()));
    m.vcx.run_until_parked();
    assert!(methods(&fake, "artifact:delete").is_empty(), "nothing reached the daemon");
    // A comment's record is refused too (its message would be: chat:send is the composer's, refused alike).
    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Designs, cx));
    m.vcx.run_until_parked();
    designs.update_in(m.vcx, |d, window, cx| {
        d.set_commenting(true, cx);
        d.pin_comment("welcome", 0.5, 0.5, window, cx);
    });
    m.vcx.simulate_input("x");
    designs.update(m.vcx, |d, cx| d.send(cx));
    m.wait_for("the comment's refusal", |m| {
        m.controller
            .read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).refused().iter().any(|r| r.starts_with("artifact:add-comments")))
    });
    assert!(methods(&fake, "artifact:add-comments").is_empty());
    m.wait_for("the board back from the read", |m| designs.read_with(m.vcx, |d, _| d.design("sign-in").is_some()));
    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

/// Typing reaches the composer in a Chat with designs and a page, with the Artifact tab open and closed, and in a
/// Chat without them (the Preview's 864fd82a typed nothing).
#[gpui::test]
fn the_composer_takes_typing_beside_the_canvas_tabs(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("canvas-typing");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("both tabs", |m| {
        panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Designs) && p.visible_tabs().contains(&PanelTab::Artifact))
    });
    m.vcx.run_until_parked();
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    let text = |m: &mut super::owned::Mounted<'_>| composer.read_with(m.vcx, |c, _| c.text().to_owned());

    m.vcx.simulate_input("hello");
    assert_eq!(text(&mut m), "hello", "the panel closed");

    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Artifact, cx));
    m.vcx.run_until_parked();
    assert!(panel.read_with(m.vcx, |p, _| p.is_open() && p.active() == PanelTab::Artifact));
    m.vcx.simulate_input(" there");
    assert_eq!(text(&mut m), "hello there", "the Artifact tab open");

    panel.update(m.vcx, |p, cx| p.toggle_tab(PanelTab::Artifact, cx));
    m.vcx.run_until_parked();
    m.vcx.simulate_input("!");
    assert_eq!(text(&mut m), "hello there!", "the Artifact tab closed again");

    // Every tab in turn (a press in each body: the Designs board takes the focus on one), then a click in the
    // composer: the click focuses its text area (not the transcript under it) and typing reaches it.
    for (round, letter) in ["?", "."].into_iter().enumerate() {
        for tab in panel.read_with(m.vcx, |p, _| p.visible_tabs()) {
            panel.update(m.vcx, |p, cx| p.activate(tab, cx));
            m.vcx.run_until_parked();
            let first = m.vcx.debug_bounds("panel-tab-Details").expect("the Details tab");
            m.vcx.simulate_click(gpui::point(first.origin.x + gpui::px(120.0), first.origin.y + gpui::px(300.0)), gpui::Modifiers::none());
            m.vcx.run_until_parked();
        }
        let before = text(&mut m);
        let input = m.vcx.debug_bounds("composer-input").expect("the composer's text area");
        m.vcx.simulate_click(input.center(), gpui::Modifiers::none());
        m.vcx.run_until_parked();
        m.vcx.simulate_input(letter);
        assert_eq!(text(&mut m), format!("{before}{letter}"), "round {round}: after every tab and a click in the composer");
    }

    // The Preview's Designs tab is for viewing: no layer editor, by its button or otherwise.
    let designs = panel.read_with(m.vcx, |p, _| p.designs().clone());
    assert!(!designs.read_with(m.vcx, |d, cx| d.can_edit(cx)), "no Edit in the Preview");
    designs.update(m.vcx, |d, cx| d.open_editor("welcome", cx));
    assert!(designs.read_with(m.vcx, |d, _| d.editor().is_none()), "the editor never opens in the Preview");

    m.open(&format!("{ALPHA}#1"));
    m.wait_for("the plain Chat", |m| m.open_key().as_deref() == Some(format!("{ALPHA}#1").as_str()));
    m.vcx.run_until_parked();
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    let before = composer.read_with(m.vcx, |c, _| c.text().to_owned());
    m.vcx.simulate_input("hi");
    assert_eq!(composer.read_with(m.vcx, |c, _| c.text().to_owned()), format!("{before}hi"), "a Chat without designs");

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn comments_send_and_record_like_electron(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("canvas-comments");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#2");
    m.wait_for("the newest Chat", |m| m.open_key().as_deref() == Some(key.as_str()));
    let panel = m.workspace.read_with(m.vcx, |w, _| w.panel.clone());
    m.wait_for("both tabs", |m| {
        panel.read_with(m.vcx, |p, _| p.visible_tabs().contains(&PanelTab::Designs) && p.visible_tabs().contains(&PanelTab::Artifact))
    });
    let (designs, artifacts) = panel.read_with(m.vcx, |p, _| (p.designs().clone(), p.artifacts().clone()));
    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Designs, cx));
    m.vcx.run_until_parked();

    // A design: comment mode, a pin on welcome (it shows version 3), its text, Send.
    designs.update_in(m.vcx, |d, window, cx| {
        d.set_commenting(true, cx);
        d.pin_comment("welcome", 0.25, 0.12, window, cx);
    });
    m.vcx.run_until_parked();
    m.vcx.simulate_input("Bigger title");
    let id = designs.read_with(m.vcx, |d, _| d.comments_state().drafts[0].key.clone());
    designs.update(m.vcx, |d, cx| d.send(cx));
    m.wait_for("the message", |_| {
        sent(&fake).iter().any(|r| r["body"].as_str().is_some_and(|b| b.starts_with("A comment on the designs")))
    });
    let body = sent(&fake).into_iter().find_map(|r| r["body"].as_str().map(str::to_owned).filter(|b| b.starts_with("A comment"))).unwrap();
    assert!(
        body.contains(&format!(
            "1. (comment {id}) On the design \"Welcome\" (welcome, version 3), 25% across and 12% down, layer \"title\""
        )),
        "{body}"
    );
    m.wait_for("artifact:add-comments", |_| !methods(&fake, "artifact:add-comments").is_empty());
    assert_eq!(
        methods(&fake, "artifact:add-comments")[0],
        json!([{"chatId": key, "comments": [{"id": id, "design": {"id": "welcome", "title": "Welcome", "version": 3}, "x": 0.25, "y": 0.12,
            "text": "Bigger title", "nodeId": "title"}]}])
    );
    m.wait_for("the sent pin", |m| designs.read_with(m.vcx, |d, _| d.pins().iter().any(|p| p.id == id && p.version == 3)));
    assert_eq!(designs.read_with(m.vcx, |d, _| d.feedback()), 0);

    // The page: comment mode, a press the helper reports on the Status tab, its text, Send.
    panel.update(m.vcx, |p, cx| p.activate(PanelTab::Artifact, cx));
    m.vcx.run_until_parked();
    artifacts.update_in(m.vcx, |a, window, cx| {
        milagre_gpui_spike::workspace::panel::comments::set_commenting(a, true, cx);
        a.pin_on_page((0.4, 0.6), "h1:1@0.5,0.5".into(), "Status".into(), (30.0, 40.0), window, cx);
    });
    m.vcx.run_until_parked();
    // A headless window has no native view for the page (it shows its error), so its bubble is not drawn here: the
    // text goes into the bubble's field directly (typing in the bubble is the base crate's `artifacts` test).
    let field = artifacts.read_with(m.vcx, |a, _| a.comments_state().editor().cloned()).expect("the bubble's field");
    m.vcx.update(|window, cx| field.update(cx, |f, cx| f.set_value("Which week?", window, cx)));
    let page_id = artifacts.read_with(m.vcx, |a, _| a.comments_state().drafts[0].key.clone());
    artifacts.update(m.vcx, |a, cx| a.send(cx));
    m.wait_for("the page's message", |_| {
        sent(&fake).iter().any(|r| r["body"].as_str().is_some_and(|b| b.starts_with("A comment on the artifact")))
    });
    m.wait_for("the page's record", |_| methods(&fake, "artifact:add-comments").len() == 2);
    assert_eq!(
        methods(&fake, "artifact:add-comments")[1],
        json!([{"chatId": key, "comments": [{"id": page_id, "design": {"id": "report", "title": "Report", "version": 4, "format": "html"},
            "x": 0.4, "y": 0.6, "text": "Which week?", "anchor": "h1:1@0.5,0.5", "near": "Status", "tab": {"id": "status", "title": "Status"}}]}])
    );
    m.wait_for("the page's sent comment", |m| {
        artifacts.read_with(m.vcx, |a, _| a.page().comments.iter().any(|c| c.id.as_ref() == page_id))
    });

    // The composer still types: a click in it, then keys.
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    let before = composer.read_with(m.vcx, |c, _| c.text().to_owned());
    let input = m.vcx.debug_bounds("composer-input").expect("the composer's text area");
    m.vcx.simulate_click(input.center(), gpui::Modifiers::none());
    m.vcx.run_until_parked();
    m.vcx.simulate_input("go");
    assert_eq!(composer.read_with(m.vcx, |c, _| c.text().to_owned()), format!("{before}go"));
    assert!(m.controller.read_with(m.vcx, |c, cx| c.live_canvas().unwrap().read(cx).errors().is_empty()));

    m.controller.update(m.vcx, |c, _| c.disconnect());
    drop(m);
    drop(fake);
    let _ = std::fs::remove_dir_all(&data);
}
