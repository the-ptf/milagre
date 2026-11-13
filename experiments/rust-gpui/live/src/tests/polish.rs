//! The polish batch on the fake Node daemon: a saved reply's steps fold as Electron's `ReplyContent` does, a live
//! turn's tool calls show while they run, and attachments go out with `chat:send` and come back on the message.

use gpui::{Focusable as _, TestAppContext};
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

/// Victor's long thread: a PR action sent while the turn ran split the run, and its live folds (whose steps were saved
/// above the new message) stayed on screen as rows of bare chevrons, the action card below them. Now the Chat is read
/// again: the saved part, then the card, then only what still runs.
#[gpui::test]
fn a_split_run_leaves_no_empty_folds_and_the_card_sits_between(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let data = data_folder("polish-split");
    let fake = FakeDaemon::start(&data, world());
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#1");
    m.wait_for("the saved transcript", |m| m.items().len() >= 4);

    m.type_and_send("[tools] go");
    m.wait_for("the running call", |m| m.items().last().is_some_and(|item| item.starts_with("activity (2 steps)")));
    fake.world().agent(&key, json!({"type":"step-completed","id":"cmd-1","status":"done","title":"Ran `npm test`","durationMs":900}));
    fake.world().agent(&key, json!({"type":"text-delta","text":"PR #189 is open. Filing the follow-up issue now."}));
    fake.world().agent(&key, json!({"type":"step-started","step":{"id":"cmd-2","kind":"shell","title":"Ran `gh pr view`"}}));
    m.wait_for("the second fold", |m| m.items().last().is_some_and(|item| item.starts_with("activity (1 steps)")));

    // The PR action steers the turn (as Electron's pill sends it during a run).
    let url = "https://github.com/acme/app/pull/189";
    let request = json!({"projectPath":ALPHA,"worktreeId":1,"sessionId":1,"provider":"claude","model":"claude-opus-5-5",
        "body":"Update the branch of pull request #189","clientMessageId":"steer-1","permissionMode":"auto",
        "prAction":{"action":"behind","pr":189,"url":url}});
    fake.world().send_as(&request).expect("the steer");
    let tail = |m: &mut super::owned::Mounted| {
        let items = m.items();
        items[items.len().saturating_sub(4)..].to_vec()
    };
    m.wait_for("the saved part, the card, then the live call", |m| {
        tail(m)
            == [
                "activity (2 steps): Thought · ran 1 command".to_owned(),
                "reply: PR #189 is open. Filing the follow-up issue now.".to_owned(),
                "pr action behind #189".to_owned(),
                "activity (1 steps): Ran 1 command".to_owned(),
            ]
    });
    let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
    let empty = transcript
        .read_with(m.vcx, |t, _| t.items().iter().filter(|item| matches!(item, Item::Activity(a) if a.entries.is_empty())).count());
    assert_eq!(empty, 0, "no fold is left without its steps");
    assert!(m.running(), "the turn runs on");

    // The live call ends inside its new fold.
    let live_done = |m: &mut super::owned::Mounted| {
        let transcript = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).transcript.clone());
        transcript.read_with(
            m.vcx,
            |t, _| matches!(t.items().last(), Some(Item::Activity(a)) if a.steps().iter().all(|s| s.status == StepStatus::Done)),
        )
    };
    fake.world().agent(&key, json!({"type":"step-completed","id":"cmd-2","status":"done","title":"Ran `gh pr view`","durationMs":300}));
    m.wait_for("the ended call", live_done);
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.wait_for("the stopped turn", |m| !m.running() && fake.world().runs.is_empty());
    drop(m);
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}

/// Victor's video: while a reply streamed into the open Chat (and the daemon's stream closed for another Project's
/// oversized state, which makes the window sync again), the Tasks pill vanished, the transcript was read again and
/// jumped, and the running mark came late. Now: the mark shows on send, before the daemon starts the turn; the pills,
/// the composer's text and its focus hold through the stream and the re-sync; the transcript is not read again
/// mid-turn; and streamed deltas do not read the sidebar again.
#[gpui::test]
fn a_streaming_reply_and_a_resync_keep_the_pills_the_composer_and_the_scroll(cx: &mut TestAppContext) {
    const BETA: &str = "/fake-node/polish-beta";
    cx.executor().allow_parking();
    let data = data_folder("polish-stream");
    let mut world = world();
    let plan = json!({"source":"milagre","updatedAt":1,"tasks":[{"id":"1","title":"Port it","status":"completed"},{"id":"2","title":"Check it","status":"in_progress"}]});
    world.projects.get_mut(ALPHA).unwrap().sessions.get_mut(&1).unwrap()["plan"] = plan;
    let beta = World::with(vec![(BETA, "beta", true, vec![(1, "Other", vec![("user", "B"), ("assistant", "BA")])])]);
    world.known.extend(beta.known);
    world.projects.extend(beta.projects);
    let fake = FakeDaemon::start(&data, world);
    let session = DaemonSession::start(Daemon::new(Some(data.clone()), false));
    let mut m = mount_daemon(cx, session);
    let key = format!("{ALPHA}#1");
    m.wait_for("the sidebar", |m| m.items().len() >= 2);
    m.workspace.update(m.vcx, |w, cx| w.open_chat_key(&key, cx));
    m.wait_for("the open Chat", |m| m.open_key().as_deref() == Some(key.as_str()) && m.items().len() >= 4);
    let pills = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).pills.clone());
    m.wait_for("the Tasks pill", |m| m.vcx.debug_bounds("slot-pill-tasks").is_some());
    pills.update(m.vcx, |p, _| p.record_draws());

    // Send: the running mark shows before the daemon starts the turn.
    m.type_and_send("[silent] go on");
    m.vcx.run_until_parked();
    assert!(m.running(), "the running mark shows on send");
    m.wait_for("the saved message", |_m| fake.world().projects[ALPHA].messages[&1].len() == 3);
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        m.vcx.run_until_parked();
    }
    assert!(m.running(), "it stays while the turn has not started");
    let reads = |fake: &FakeDaemon| fake.methods().iter().filter(|method| *method == "chat:messages").count();
    let (reads_before, syncs_before) = (reads(&fake), fake.methods().iter().filter(|m| *m == "daemon:snapshot").count());

    // The person types the next message while the reply streams.
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    m.vcx.update(|window, cx| {
        composer.update(cx, |c, cx| c.set_text("also the next thing", window, cx));
        let focus = composer.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
    });
    let reloads_before = milagre_gpui_spike::workspace::sidebar::Sidebar::reloads();
    {
        let mut world = fake.world();
        world.runs.insert(key.clone(), json!({"text":"","model":"gpt-5.5","startedAt":crate::transcript::now_ms(),"steps":[],"approvals":[],"questions":[],"answered":{}}));
        world.agent(&key, json!({"type":"turn-started","turnId":"t-stream"}));
        world.pending_hold(&key);
    }
    for n in 0..12 {
        {
            let mut world = fake.world();
            world.agent(&key, json!({"type":"text-delta","text":format!("Word {n}. ")}));
            if n == 5 {
                // Another Project's oversized state: this window's stream closes and it syncs again.
                world.emit("agent:event", json!({"chatId":format!("{BETA}#1"),"stateTooLarge":true,"event":{"type":"step-started","step":{"id":"x","kind":"shell","title":"Ran `x`"}}}));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        m.vcx.run_until_parked();
    }
    m.wait_for("the streamed text", |m| {
        // The stream shows in batches timed on the executor's clock.
        m.vcx.executor().advance_clock(std::time::Duration::from_millis(100));
        m.items().last().is_some_and(|item| item.contains("Word 11."))
    });
    m.wait_for("the sync after the close", |_m| fake.methods().iter().filter(|m| *m == "daemon:snapshot").count() > syncs_before);
    m.vcx.run_until_parked();
    assert!(m.running(), "the turn still shows");
    assert_eq!(reads(&fake), reads_before, "the transcript was not read again mid-turn");
    let reloads = milagre_gpui_spike::workspace::sidebar::Sidebar::reloads() - reloads_before;
    assert!(reloads <= 4, "streamed deltas do not read the sidebar again ({reloads} reads for 12 deltas and a sync)");
    let (text, focused) = m.vcx.update(|window, cx| {
        let c = composer.read(cx);
        (c.text().to_owned(), c.focus_handle(cx).is_focused(window))
    });
    assert_eq!(text, "also the next thing", "the composer keeps its text");
    assert!(focused, "and its focus");
    let drawn = pills.read_with(m.vcx, |p, _| p.drawn().to_vec());
    assert!(!drawn.is_empty() && drawn.iter().all(|(tasks, _, _)| *tasks), "the Tasks pill never went away: {drawn:?}");

    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.set_text("", window, cx)));
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.wait_for("the stopped turn", |m| !m.running() && fake.world().runs.is_empty());
    drop(m);
    fake.stop();
    let _ = std::fs::remove_dir_all(&data);
}
