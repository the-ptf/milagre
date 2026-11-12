//! The live GPUI window on the staged `chat-runtime` (SHA-256 c4a6c25a…), driven through the views as a person would.
//!
//! The root is created through the public `OwnedChatGuard::create` with a launch manifest whose `program` is a
//! two-line wrapper around the backend's own fixed Claude stand-in (`runtime-fake-claude`, staged beside the runner):
//! it picks the first-launch or the resumed script. No account, network or production profile is involved.
//!
//! One process, in order: new Project Chat by its first send; an approval answered with the card's Allow once; the
//! reply streamed into the transcript with the running row up; the same client message id sent again (no replay) and
//! `send_status`; a second turn answered Always allow (wire `allow-for-chat`); a queued message removed from the
//! composer's queue; Stop on a running turn; Mark as unread from the row's menu; then stop, reopen the same root in a
//! new window (new wire epoch, same saved transcript) and a resumed turn; idle interrupt and the missing-queue
//! answers; clean shutdowns.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{AnyView, AppContext as _, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};
use gpui_component::Root;
use milagre_daemon_client::{Error, OwnedChatGuard, SendOptions, SendTarget};
use milagre_gpui_spike::workspace::Workspace;
use serde_json::{Value, json};

use crate::controller::{LiveController, install_globals, shown_items};
use crate::session::{self, Root as RootKind, Session};

const SESSION: &str = "gpui-native-session";

fn stage() -> PathBuf {
    std::env::current_exe().unwrap().parent().unwrap().to_owned()
}

fn handshake(launch: Value) -> Vec<Value> {
    vec![
        json!({"expect_launch": launch}),
        json!({"expect":{"subtype":"initialize"}}),
        json!({"reply":{}}),
        json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
        json!({"reply":{}}),
        // The composer's default reply style (concise) goes to the session as a flag setting before the first turn.
        json!({"expect":{"subtype":"apply_flag_settings"}}),
        json!({"reply":{}}),
    ]
}
fn init() -> Value {
    json!({"emit":{"type":"system","subtype":"init","session_id":SESSION}})
}
fn delta(text: &str) -> Value {
    json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}}})
}
fn result() -> Value {
    json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})
}
fn permission(id: &str, command: &str) -> [Value; 2] {
    [
        json!({"request":{"id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":command}}}}),
        json!({"expect":{"type":"control_response","fields":{"/response/request_id":id,"/response/response/behavior":"allow"}}}),
    ]
}

/// The case folder: wrapper, both scripts and the private manifest. The root is left for `create`.
fn prepare(case: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
    std::fs::DirBuilder::new().mode(0o700).create(case).unwrap();
    for dir in ["claude-home", "claude-config"] {
        std::fs::DirBuilder::new().mode(0o700).create(case.join(dir)).unwrap();
    }
    let mut first = handshake(json!({"absent":["--no-session-persistence","--resume"]}));
    first.extend([json!({"expect":{"type":"user"}}), init()]);
    first.extend(permission("perm-1", "printf one"));
    first.extend([delta("Fixed GPUI "), delta("reply one"), result()]);
    first.extend([json!({"expect":{"type":"user"}}), init()]);
    first.extend(permission("perm-2", "printf two"));
    first.extend([delta("Reply two"), result()]);
    first.extend([
        json!({"expect":{"type":"user"}}),
        init(),
        delta("Working"),
        json!({"expect":{"subtype":"interrupt"}}),
        json!({"reply":{}}),
    ]);
    first.extend([json!({"sleep_ms":20}), result(), json!({"wait_eof":true})]);
    let mut resumed = handshake(json!({"flags":[format!("--resume={SESSION}")],"absent":["--no-session-persistence"]}));
    resumed.extend([json!({"expect":{"type":"user"}}), init(), delta("Resumed reply"), result(), json!({"wait_eof":true})]);
    std::fs::write(case.join("first.json"), serde_json::to_vec(&first).unwrap()).unwrap();
    std::fs::write(case.join("resumed.json"), serde_json::to_vec(&resumed).unwrap()).unwrap();
    let fake = stage().join("runtime-fake-claude");
    let wrapper = case.join("fake-claude");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \"$*\" in *--resume=*) s={c}/resumed.json ;; *) s={c}/first.json ;; esac\nFAKE_CLAUDE_SCRIPT=\"$s\" exec {f} \"$@\" 2>>{c}/fake.log\n",
            c = case.display(),
            f = fake.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/src/bundled-skills").canonicalize().unwrap();
    let manifest = case.join("launch.json");
    let launch = json!({"program":wrapper,"home":case.join("claude-home"),"configDirectory":case.join("claude-config"),"skillsDirectory":skills,"model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"GPUI fixed child (not authenticated)","userName":"gpui-live-check"});
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&manifest).unwrap();
    std::io::Write::write_all(&mut file, launch.to_string().as_bytes()).unwrap();
    (case.join("root"), manifest)
}

struct Mounted<'a> {
    vcx: &'a mut VisualTestContext,
    workspace: Entity<Workspace>,
    controller: Entity<LiveController>,
}

fn mount(cx: &mut TestAppContext, session: Session) -> Mounted<'_> {
    let wiring = cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
        install_globals(&session, cx)
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let workspace = cx.new(|cx| Workspace::new(window, cx));
        Root::new(AnyView::from(workspace), window, cx)
    });
    let workspace = root.read_with(vcx, |root, _| root.view().clone().downcast::<Workspace>().expect("the workspace"));
    vcx.run_until_parked();
    let controller = vcx.update(|window, cx| LiveController::attach(&workspace, session, wiring, window, cx));
    vcx.run_until_parked();
    Mounted { vcx, workspace, controller }
}

impl Mounted<'_> {
    /// Runs the app until `done` holds, waking for the client's I/O thread (bounded).
    fn until(&mut self, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            self.vcx.run_until_parked();
            if done(self) {
                return;
            }
            let errors = self.controller.read_with(self.vcx, |c, _| c.errors().to_vec());
            assert!(errors.is_empty(), "while waiting for {what}: {errors:?}");
            assert!(
                Instant::now() < until,
                "timed out waiting for {what}; shown {:?}; fake: {}",
                self.items(),
                std::fs::read_to_string(stage().join("case-live/fake.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn items(&mut self) -> Vec<String> {
        let transcript = self.workspace.read_with(self.vcx, |w, cx| w.chat.read(cx).transcript.clone());
        transcript.read_with(self.vcx, |t, _| shown_items(t.items()))
    }

    fn running(&mut self) -> bool {
        self.workspace.read_with(self.vcx, |w, cx| w.chat.read(cx).running.is_some())
    }

    fn type_and_send(&mut self, text: &str) {
        let composer = self.workspace.read_with(self.vcx, |w, cx| w.chat.read(cx).composer.clone());
        self.vcx.update(|window, cx| {
            composer.update(cx, |c, cx| {
                c.set_text(text, window, cx);
                c.submit(window, cx);
            })
        });
    }

    fn click(&mut self, selector: &'static str) {
        let at = self.vcx.debug_bounds(selector).unwrap_or_else(|| panic!("{selector} is drawn")).center();
        self.vcx.simulate_click(at, Modifiers::none());
    }

    /// `state:read`'s epoch on this window's connection.
    fn state_epoch(&mut self, project: &str) -> Value {
        let client = self.controller.read_with(self.vcx, |c, _| c.client().clone());
        futures::executor::block_on(client.state_read(project)).expect("state:read").epoch
    }

    fn released_decisions(&mut self) -> Vec<String> {
        self.controller.read_with(self.vcx, |c, _| {
            c.store().read(|r| {
                r.released()
                    .tail()
                    .filter(|e| e.channel == "agent:event" && e.payload["event"]["type"] == "permission-resolved")
                    .map(|e| e.payload["event"].to_string())
                    .collect()
            })
        })
    }

    fn sidebar_row(&mut self, key: &str) -> Option<milagre_gpui_spike::workspace::sidebar::ChatRow> {
        let sidebar = self.workspace.read_with(self.vcx, |w, _| w.sidebar.clone());
        sidebar.read_with(self.vcx, |s, _| (0..s.row_count()).filter_map(|ix| s.row(ix)).find(|row| row.key.as_ref() == key).cloned())
    }
}

fn finish(guard: &OwnedChatGuard) -> Value {
    let report = session::shutdown_blocking(guard, Duration::from_secs(20)).expect("shutdown");
    println!("GPUI_LIVE_CLEANUP {report:?}");
    assert!(session::clean(&report), "not a clean stop: {report:?}");
    json!(format!("{report:?}"))
}

#[gpui::test]
#[ignore = "staged runtime: run through daemon-check/scripts/check-gpui-live.py"]
fn the_live_window_runs_real_chats_on_the_owned_runtime(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let case = stage().join("case-live");
    let (root, manifest) = prepare(&case);
    let guard =
        Arc::new(futures::executor::block_on(session::launch(RootKind::Create { root: &root, manifest: &manifest })).expect("create"));
    // Before `project:open` on its connection, actions refuse locally.
    let early = futures::executor::block_on(async {
        let (client, _, _n) = guard.connect(Default::default()).await.unwrap();
        let actions = guard.chat_actions(&client).unwrap();
        let refused = actions.interrupt(1).await;
        client.disconnect();
        refused
    });
    assert_eq!(early, Err(Error::ViewNotOpened));
    // A second owner for the running root is refused.
    let second = futures::executor::block_on(OwnedChatGuard::open(&root));
    assert!(second.is_err(), "a second writer must be refused");
    let session = futures::executor::block_on(Session::connect(guard.clone())).expect("connect, open, snapshot, accept");
    let project = session.project.clone();
    let mut m = mount(cx, session);

    // No Chat has messages yet: the window opens on the empty new-Chat screen.
    assert!(m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).is_new_chat()));
    assert!(!m.running());
    let attach_drawn = m.vcx.debug_bounds("composer-attach").is_some();
    assert!(!attach_drawn, "attachments are off");
    // Preview mode: the account and model line stands where usage was; nothing unbacked looks real.
    assert!(m.vcx.debug_bounds("preview-note").is_some(), "the preview line is drawn");

    // 1. New Project Chat by its first send; the approval card; Allow once.
    m.type_and_send("First live turn");
    m.until("the approval card", |m| m.items().iter().any(|i| i.starts_with("approval Waiting")));
    let key = m.controller.read_with(m.vcx, |c, _| c.open_key().map(str::to_owned)).expect("the new Chat is open");
    assert_eq!(key, format!("{project}#1"));
    assert!(m.running(), "the running row is up while the turn waits");
    assert!(m.sidebar_row(&key).is_some(), "the new Chat is listed");
    m.click("approval-allow-once");
    // The saved transcript replaces the live tail (the approval card) once the run ends.
    m.until("the saved first reply", |m| !m.running() && m.items() == ["user: First live turn", "reply: Fixed GPUI reply one"]);
    let first = m.items();
    println!("GPUI_LIVE_RESOLVED {:?}", m.released_decisions());

    // 2. Same client message id again: the owner's receipt, no replay; send_status matches.
    let (id, receipt) = m.controller.read_with(m.vcx, |c, _| c.receipts()[0].clone());
    let actions = m.controller.read_with(m.vcx, |c, _| c.actions().clone());
    let (duplicate, status) = futures::executor::block_on(async {
        let duplicate = actions.send(SendTarget::NewProjectChat, "must not replay", &id, SendOptions::default()).await.unwrap();
        (duplicate, actions.send_status(&id).await.unwrap())
    });
    assert_eq!(duplicate, receipt);
    assert_eq!(status, receipt);
    std::thread::sleep(Duration::from_millis(200));
    m.vcx.run_until_parked();
    assert_eq!(m.items(), first, "the duplicate was not replayed");

    // 3. A second turn, Always allow (wire allow-for-chat).
    m.type_and_send("Second live turn");
    m.until("the second approval", |m| m.items().iter().any(|i| i.starts_with("approval Waiting")));
    m.click("approval-always");
    m.until("the saved second reply", |m| {
        !m.running() && m.items().last().is_some_and(|i| i == "reply: Reply two") && m.items().len() == 4
    });
    println!("GPUI_LIVE_RESOLVED {:?}", m.released_decisions());
    let decisions = m.controller.read_with(m.vcx, |c, _| c.decisions().to_vec());
    assert_eq!(decisions[1], ("perm-2".to_owned(), "AllowForChat".to_owned()), "Always allow is Chat-wide, never global");
    // The effective decision depends on whether the card offered Chat-wide allowance (Node behaves the same).
    let (offered, resolved) = m.controller.read_with(m.vcx, |c, _| {
        c.store().read(|r| {
            let events: Vec<_> = r.released().tail().filter(|e| e.channel == "agent:event").map(|e| e.payload["event"].clone()).collect();
            let offered =
                events.iter().find(|e| e["type"] == "permission-request" && e["requestId"] == "perm-2").map(|e| e["allowForChat"] == true);
            let resolved =
                events.iter().find(|e| e["type"] == "permission-resolved" && e["requestId"] == "perm-2").map(|e| e["decision"].clone());
            (offered, resolved)
        })
    });
    let expected = if offered == Some(true) { "allow-for-chat" } else { "allow" };
    assert_eq!(resolved, Some(json!(expected)), "card offered allowForChat: {offered:?}");

    // 4. A running turn: a follow-up queues in the runtime and is removed from the composer; Stop ends the turn.
    m.type_and_send("Third live turn");
    m.until("the streamed text", |m| m.items().iter().any(|i| i == "reply: Working") && m.running());
    m.type_and_send("Queued follow-up");
    let composer = m.workspace.read_with(m.vcx, |w, cx| w.chat.read(cx).composer.clone());
    let runtime_queue = |m: &mut Mounted| {
        m.controller.read_with(m.vcx, |c, _| {
            c.store().read(|r| {
                r.state()
                    .ok()
                    .map(|a| {
                        a.projects[0]
                            .state
                            .as_ref()
                            .map(|s| s.sessions[&1].queued.iter().map(|q| q.id.to_string()).collect::<Vec<_>>())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
            })
        })
    };
    m.until("the runtime's queue", |m| {
        let ids = runtime_queue(m);
        ids.len() == 1 && composer.read_with(m.vcx, |c, _| c.queued().iter().map(|q| q.message.id.to_string()).collect::<Vec<_>>()) == ids
    });
    let queued = runtime_queue(&mut m)[0].clone();
    println!("GPUI_LIVE_QUEUED {queued}");
    composer.update(m.vcx, |c, cx| c.remove_queued(&queued, cx));
    m.until("the queue to empty", |m| runtime_queue(m).is_empty() && composer.read_with(m.vcx, |c, _| c.queued().is_empty()));
    m.vcx.update(|window, cx| composer.update(cx, |c, cx| c.press_send(window, cx)));
    m.until("the stopped turn", |m| !m.running() && m.items().len() >= 6);
    let saved = m.items();
    println!("GPUI_LIVE_ITEMS {saved:?}");

    // 5. Mark as unread from the row's menu: the row shows it.
    let row = m.sidebar_row(&key).expect("row");
    assert!(row.mark != milagre_gpui_spike::logic::marks::chat_mark::ChatMark::Unread);
    let at = m.vcx.debug_bounds("chat-row-0").expect("row 0").center();
    m.vcx.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
    m.vcx.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
    m.vcx.run_until_parked();
    let sidebar = m.workspace.read_with(m.vcx, |w, _| w.sidebar.clone());
    assert!(sidebar.read_with(m.vcx, |s, _| s.menu_open()), "the row's menu opened");
    // The menu's "Mark as unread" item runs this (its overlay row is drawn in a later layer).
    m.vcx.update(|window, cx| {
        sidebar.update(cx, |s, cx| s.run_menu(milagre_gpui_spike::workspace::sidebar::menu::MenuAction::MarkUnread, window, cx))
    });
    m.until("the unread mark", |m| {
        let saved = m.controller.read_with(m.vcx, |c, _| {
            c.store().read(|r| r.state().ok().is_some_and(|a| a.projects[0].state.as_ref().is_some_and(|s| s.sessions[&1].unread)))
        });
        saved && m.sidebar_row(&key).is_some_and(|row| row.mark == milagre_gpui_spike::logic::marks::chat_mark::ChatMark::Unread)
    });
    let unread_row = m.sidebar_row(&key).expect("row");
    let runs = m.controller.read_with(m.vcx, |c, _| c.store().read(|r| format!("{:?}", r.state().map(|a| a.runs.clone()))));
    let running = m.running();
    let tail: Vec<String> = m.controller.read_with(m.vcx, |c, _| {
        c.store().read(|r| r.released().tail().map(|e| format!("{} {}", e.channel, e.payload["event"]["type"])).collect())
    });
    println!("GPUI_LIVE_UNREAD mark={:?} runs={runs} chat_running={running} tail={tail:?}", unread_row.mark);
    assert_eq!(unread_row.mark, milagre_gpui_spike::logic::marks::chat_mark::ChatMark::Unread);

    // 6. The Terminal drawer on the runtime's PTY: opened for this Chat on the main connection, its output read on the
    //    second one, typed input reaching the shell. The "local shell" label is gone.
    let drawer = m.workspace.read_with(m.vcx, |w, _| w.terminals.clone());
    drawer.update(m.vcx, |d, cx| d.set_chat(key.clone().into(), cx));
    let view = drawer.update(m.vcx, |d, cx| d.add(cx)).expect("a Terminal tab");
    assert!(view.read_with(m.vcx, |v, _| v.session().is_remote()), "the drawer opened the runtime's PTY");
    view.update(m.vcx, |v, cx| v.input(b"printf 'gpui-%s-%s\\n' term ok\r".to_vec(), cx));
    let screen = |m: &mut Mounted| {
        view.read_with(m.vcx, |v, _| {
            use alacritty_terminal::grid::Dimensions as _;
            let term = v.session().term.lock();
            let (lines, cols) = (term.screen_lines() as i32, term.columns());
            (0..lines)
                .map(|line| milagre_gpui_spike::workspace::panel::terminal::grid::grid_text(&*term, line, 0..=cols - 1))
                .collect::<Vec<_>>()
                .join("\n")
        })
    };
    m.until("the shell's output in the grid", |m| screen(m).contains("gpui-term-ok"));
    m.vcx.run_until_parked();
    assert!(m.vcx.debug_bounds("terminal-local-shell").is_none(), "no local-shell label on a runtime terminal");
    println!("GPUI_LIVE_TERMINAL {:?}", screen(&mut m).lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>());
    drawer.update(m.vcx, |d, cx| d.hide(cx));
    drop(view);

    let epoch = m.state_epoch(&project);
    // Close this window's connection, then stop the runtime.
    m.controller.update(m.vcx, |c, _| c.disconnect());
    let first_stop = finish(&guard);
    drop(m);
    drop(guard);

    // 7. Reopen the same root: a new wire epoch, the same saved transcript, a resumed native session.
    let guard = Arc::new(futures::executor::block_on(session::launch(RootKind::Open { root: &root })).expect("open"));
    let session = futures::executor::block_on(Session::connect(guard.clone())).expect("reconnect");
    let mut m = mount(cx, session);
    m.until("the reopened Chat", |m| {
        m.controller.read_with(m.vcx, |c, _| c.open_key() == Some(key.as_str())) && m.items().len() == saved.len()
    });
    assert_eq!(m.items(), saved, "the saved transcript survives the restart");
    let reopened = m.state_epoch(&project);
    assert_ne!(reopened, epoch, "a new wire epoch");
    m.type_and_send("After restart");
    m.until("the resumed reply", |m| m.items().last().is_some_and(|i| i == "reply: Resumed reply") && !m.running());
    let actions = m.controller.read_with(m.vcx, |c, _| c.actions().clone());
    let (idle, now, removed) = futures::executor::block_on(async {
        (actions.interrupt(1).await, actions.send_queued_now(1, "missing").await, actions.remove_queued(1, "missing").await)
    });
    assert_eq!(idle, Ok(Value::Null));
    assert!(matches!(now, Err(Error::Remote { .. })), "{now:?}");
    assert_eq!(removed, Ok(Value::Bool(false)));
    let after = m.items();
    m.controller.update(m.vcx, |c, _| c.disconnect());
    let second_stop = finish(&guard);
    println!(
        "GPUI_LIVE_EVIDENCE {}",
        json!({"provider":"backend fixed child (runtime-fake-claude) through the public create path","key":key,"afterFirstTurn":first,"beforeRestart":saved,"afterRestart":after,"epochs":[format!("{epoch:?}"),format!("{reopened:?}")],"duplicateReceipt":receipt,"cleanups":[first_stop,second_stop]})
    );
}
