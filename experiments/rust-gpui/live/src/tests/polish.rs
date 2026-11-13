//! The polish batch on the fake Node daemon: a saved reply's steps fold as Electron's `ReplyContent` does, a live
//! turn's tool calls show while they run, and attachments go out with `chat:send` and come back on the message.

use gpui::TestAppContext;
use milagre_gpui_spike::data::StepStatus;
use milagre_gpui_spike::workspace::chat::transcript::Item;
use serde_json::json;

use super::daemon::{mount_daemon, mount_daemon_full, sent};
use super::fake_daemon::{FakeDaemon, World, data_folder};
use crate::controller::DaemonSession;
use crate::daemon::Daemon;

const ALPHA: &str = "/fake-node/polish";

fn world() -> World {
    let mut world = World::with(vec![(
        ALPHA,
        "polish",
        true,
        vec![(1, "Folded", vec![("user", "Look at it"), ("assistant", "Embedding the images inline is too large to send.")])],
    )]);
    // A Claude Chat whose model offers efforts, as Milagre's catalog reports Opus.
    world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&1).unwrap()["provider"] = json!("claude");
    world.models["claude"][0]["efforts"] = json!(["low", "medium", "high", "xhigh", "max"]);
    let messages = world.projects.get_mut(ALPHA).unwrap().messages.get_mut(&1).unwrap();
    messages[0]["images"] = json!([{"id":"a1","name":"shot.png","path":"/tmp/polish-shot.png"}]);
    let step = |id: &str, kind: &str, title: &str, status: &str, offset: usize| json!({"id":id,"kind":kind,"title":title,"status":status,"offset":offset,"durationMs":500});
    messages[1]["steps"] = json!([
        step("t1", "thinking", "Thought", "done", 0),
        step("r1", "read", "Read `gallery.html`", "done", 0),
        {"id":"v1","kind":"image","title":"Viewed an image","status":"done","offset":0,"file":"/tmp/polish-viewed.png","imageOrigin":"viewed"},
        step("c1", "shell", "Ran `ls`", "done", 0),
        step("c2", "shell", "Ran `cp`", "done", 0),
        {"id":"c3","kind":"shell","title":"Ran `mkdir`","status":"failed","offset":49,"detail":"Exit code 1"},
    ]);
    world
}

#[gpui::test]
fn replies_fold_their_steps_and_live_calls_show_while_they_run(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("polish");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    assert!(session.error.is_none(), "{:?}", session.error);
    // Electron's preferences: this Chat has no effort of its own; the last one picked anywhere was Medium.
    let electron = data.join("electron-preferences.json");
    std::fs::write(&electron, json!({"milagre.effort": "medium", "milagre.composer-preferences": "{}"}).to_string()).unwrap();
    let prefs = data.join("preview-preferences.json");
    let mut m = mount_daemon_full(cx, session, prefs, electron, None);
    let key = format!("{ALPHA}#1");
    m.wait_for("the saved transcript", |m| m.items().len() >= 4);

    // The model chip shows the Chat's effort from the start ("Opus 5.5 · Medium"), and no permission glyph.
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.wait_for("the chip's effort", |m| composer.read_with(m.vcx, |c, _| c.effort_id()) == Some("medium"));
    assert_eq!(composer.read_with(m.vcx, |c, _| c.model().1.to_string()), "claude-opus-5-5");
    assert!(m.vcx.debug_bounds("composer-permission-full").is_none());

    // Saved: the user's image strip over the bubble; the steps before the answer in one fold (the viewed image a
    // strip of its own, out of the fold), the answer, then the failed call after it as its own row.
    assert_eq!(
        m.items(),
        [
            "other: Card(Images(ImageStrip { kind: Attachments, images: [ImageRef { name: \"shot.png\", path: Some(\"/tmp/polish-shot.png\") }] }))",
            "user: Look at it",
            "activity (4 steps): Thought for 1s · read 1 file · ran 2 commands",
            "other: Card(Images(ImageStrip { kind: Viewed, images: [ImageRef { name: \"polish-viewed.png\", path: Some(\"/tmp/polish-viewed.png\") }] }))",
            "reply: Embedding the images inline is too large to send.",
            "activity (1 steps): Ran 1 command",
        ]
    );
    let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
    let folded = transcript.read_with(m.vcx, |t, _| match &t.items()[2] {
        Item::Activity(activity) => !activity.open && !activity.streaming,
        _ => false,
    });
    assert!(folded, "a saved fold starts closed");
    let failed = transcript.read_with(m.vcx, |t, _| match &t.items()[5] {
        Item::Activity(activity) => activity.steps()[0].status == StepStatus::Failed,
        _ => false,
    });
    assert!(failed, "the failed call after the answer is its own row");

    // Live: a turn's calls show as they start, run and end, in one streaming fold.
    m.type_and_send("[tools] go");
    let live = |m: &mut super::owned::Mounted| {
        let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
        transcript.read_with(m.vcx, |t, _| {
            t.items().iter().rev().find_map(|item| match item {
                Item::Activity(activity) if activity.streaming => {
                    Some(activity.steps().iter().map(|s| (s.id.to_string(), s.status)).collect::<Vec<_>>())
                }
                _ => None,
            })
        })
    };
    m.wait_for("the running call", |m| live(m) == Some(vec![("think-1".into(), StepStatus::Done), ("cmd-1".into(), StepStatus::Running)]));
    assert!(m.running());
    fake.world().agent(&key, json!({"type":"step-completed","id":"cmd-1","status":"done","title":"Ran `npm test`","durationMs":900}));
    m.wait_for("the ended call", |m| live(m).is_some_and(|steps| steps.iter().all(|(_, status)| *status == StepStatus::Done)));
    // Text, then another call: the call opens a fold under the text, as Electron's calls after an answer.
    fake.world().agent(&key, json!({"type":"text-delta","text":"Checking one more thing."}));
    fake.world().agent(&key, json!({"type":"step-started","step":{"id":"cmd-2","kind":"shell","title":"Ran `git status`"}}));
    m.wait_for("the second fold", |m| {
        let items = m.items();
        let n = items.len();
        n >= 2 && items[n - 2] == "reply: Checking one more thing." && items[n - 1].starts_with("activity (1 steps)")
    });
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.wait_for("the stopped turn", |m| !m.running() && fake.world().runs.is_empty());
    let _ = sent(&fake);
    drop(m);
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}

#[gpui::test]
fn pasted_images_go_out_with_chat_send_and_show_on_the_message(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("polish-paste");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the saved transcript", |m| m.items().len() >= 4);
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    assert!(composer.read_with(m.vcx, |c, _| c.limits().attachments), "attachments are on with Milagre's daemon");
    let png = std::path::PathBuf::from(format!("{}/../tests/assets/images/attachment-screenshot.png", env!("CARGO_MANIFEST_DIR")));
    let pasted = milagre_gpui_spike::workspace::chat::composer::pasted_images(Vec::new(), &[png.clone(), png]);
    m.vcx.update(|window, cx| {
        composer.update(cx, |c, cx| {
            c.attach_pasted_named(pasted, 0..0, window, cx);
        })
    });
    assert_eq!(composer.read_with(m.vcx, |c, _| c.attachments().len()), 2, "one tray, two tiles");
    m.wait_for("nothing yet", |_| true);
    let draft = composer.read_with(m.vcx, |c, _| c.text().to_string());
    m.vcx.update(|window, cx| {
        composer.update(cx, |c, cx| {
            c.set_text(&format!("{draft}see these"), window, cx);
            c.submit(window, cx);
        })
    });
    m.wait_for("the send", |_| !sent(&fake).is_empty());
    let request = sent(&fake).pop().unwrap();
    let images = request["images"].as_array().expect("images");
    assert_eq!(images.len(), 2);
    assert_eq!(images[0]["name"], "attachment-screenshot.png");
    assert!(images[0]["dataUrl"].as_str().is_some_and(|url| url.starts_with("data:image/png;base64,")));
    assert!(images[0].get("path").is_none(), "a pasted image is its bytes");
    assert_eq!(request["files"], json!([]));
    assert!(request["body"].as_str().unwrap().ends_with("see these"));
    assert_eq!(request["prompt"], request["body"], "no files: the prompt is the body");
    // The saved message: its two images as one strip over the bubble.
    m.wait_for("the saved message's strip", |m| {
        m.items().iter().any(|item| item.contains("kind: Attachments") && item.matches("attachment-screenshot.png").count() == 2)
    });
    drop(m);
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}

/// The pills over the composer never blink empty during a turn (item 12): a state replaced mid-turn that briefly lacks
/// the Chat's plan keeps the Tasks pill until the plan is back. Every pill-row render is recorded.
#[gpui::test]
fn the_pill_row_never_blinks_empty_while_a_turn_runs(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("polish-pills");
    let mut world = world();
    let plan = json!({"source":"milagre","updatedAt":1,"tasks":[{"id":"1","title":"Port it","status":"completed"},{"id":"2","title":"Check it","status":"in_progress"}]});
    world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&1).unwrap()["plan"] = plan.clone();
    let fake = FakeDaemon::start(&data, world);
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    m.wait_for("the saved transcript", |m| m.items().len() >= 4);
    let pills = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).pills.clone());
    m.wait_for("the Tasks pill", |m| m.vcx.debug_bounds("slot-pill-tasks").is_some());
    pills.update(m.vcx, |p, _| p.record_draws());

    m.type_and_send("[hold] keep going");
    m.wait_for("the run", |m| m.running());
    // Mid-turn, a state without the plan, then the plan again.
    // The window takes the frames as they come (a real socket): let each state land and draw.
    let settle = |m: &mut super::owned::Mounted| {
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            m.vcx.run_until_parked();
        }
    };
    {
        let mut world = fake.world();
        world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&1).unwrap().as_object_mut().unwrap().remove("plan");
        world.emit_state(ALPHA);
    }
    settle(&mut m);
    {
        let mut world = fake.world();
        world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&1).unwrap()["plan"] = plan;
        world.emit_state(ALPHA);
    }
    settle(&mut m);
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.wait_for("the run's end", |m| !m.running() && fake.world().runs.is_empty());
    let drawn = pills.read_with(m.vcx, |p, _| p.drawn().to_vec());
    assert!(!drawn.is_empty(), "the row drew during the turn");
    assert!(drawn.iter().all(|(tasks, _, _)| *tasks), "the Tasks pill never went away: {drawn:?}");
    drop(m);
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}
