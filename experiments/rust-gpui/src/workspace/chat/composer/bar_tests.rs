//! WP-25 tests: the bottom row, the attachments tray, the queue and the outgoing message, in the headless platform.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    AppContext as _, Context, Entity, Focusable as _, Image, ImageFormat, IntoElement, Modifiers, ParentElement as _, Render, Styled as _,
    Subscription, TestAppContext, VisualTestContext, Window, div,
};

use super::{
    Composer, ComposerAttachment, ComposerEvent, Delivery, ERROR_SIZE, ERROR_TYPE, FixtureSink, OutgoingMessage, SendAction, SinkCall,
};
use crate::testing::{self, bounds};

struct Host {
    composer: Entity<Composer>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().flex_col().justify_end().items_center().child(self.composer.clone())
    }
}

struct Rig {
    composer: Entity<Composer>,
    sink: Rc<FixtureSink>,
    events: Rc<RefCell<Vec<String>>>,
    attached: Rc<RefCell<Vec<ComposerAttachment>>>,
    _subscriptions: [Subscription; 2],
}

fn mount(cx: &mut TestAppContext) -> (Rig, &mut VisualTestContext) {
    let (host, cx) = testing::mount_in_root(cx, |_, cx| Host { composer: cx.new(Composer::new) });
    let composer = host.read_with(cx, |host, _| host.composer.clone());
    let sink = Rc::new(FixtureSink::default());
    composer.update_in(cx, |composer, window, cx| {
        composer.set_sink(Some(sink.clone()));
        let handle = composer.focus_handle(cx);
        window.focus(&handle, cx);
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let attached = Rc::new(RefCell::new(Vec::new()));
    let (e, a) = (events.clone(), attached.clone());
    let subscriptions = cx.update(|_, cx| {
        [
            cx.subscribe(&composer, move |_, event: &ComposerEvent, _| {
                e.borrow_mut().push(match event {
                    ComposerEvent::Send(text) => format!("send:{text}"),
                    ComposerEvent::Queued(text) => format!("queued:{text}"),
                    ComposerEvent::Stop => "stop".to_string(),
                    ComposerEvent::Compact => "compact".to_string(),
                })
            }),
            cx.subscribe(&composer, move |_, event: &ComposerAttachment, _| a.borrow_mut().push(event.clone())),
        ]
    });
    cx.run_until_parked();
    (Rig { composer, sink, events, attached, _subscriptions: subscriptions }, cx)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
}

fn asset(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/assets/images").join(name)
}

fn scratch(name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gpui-composer-bar-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn text(rig: &Rig, cx: &mut VisualTestContext) -> String {
    rig.composer.read_with(cx, |c, _| c.text().to_string())
}

fn attach(rig: &Rig, cx: &mut VisualTestContext, paths: Vec<PathBuf>) {
    rig.composer.update_in(cx, |c, window, cx| {
        let at = c.selected_range();
        c.attach_paths(paths, at, window, cx);
    });
    cx.run_until_parked();
}

fn tray_summary(rig: &Rig, cx: &mut VisualTestContext) -> (usize, usize) {
    rig.composer.read_with(cx, |c, _| {
        let images = c.attachments().iter().filter(|item| item.is_image()).count();
        (images, c.attachments().len() - images)
    })
}

#[gpui::test]
fn attached_images_get_numbered_tiles_and_chips_and_a_file_gets_a_tile(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    cx.simulate_input("see ");
    attach(&rig, cx, vec![asset("viewed-checker.png"), asset("viewed-wide.png"), scratch("notes.txt", b"hello")]);
    assert_eq!(tray_summary(&rig, cx), (2, 1));
    assert_eq!(text(&rig, cx), "see [Image #1] [Image #2] ");
    for tile in ["attachment-tile-0", "attachment-tile-1", "attachment-tile-2"] {
        assert!(bounds(cx, tile).size.height > gpui::px(80.0), "{tile} holds an 80px picture and a name");
    }
    assert!(cx.debug_bounds("attachment-badge-0").is_some() && cx.debug_bounds("attachment-badge-1").is_some());
    assert!(cx.debug_bounds("attachment-badge-2").is_none(), "a file has no number");
    // A path already attached is not added twice.
    attach(&rig, cx, vec![asset("viewed-checker.png")]);
    assert_eq!(tray_summary(&rig, cx), (2, 1));
}

#[gpui::test]
fn removing_an_image_tile_removes_its_chip_and_renumbers_the_rest(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    attach(&rig, cx, vec![asset("viewed-checker.png"), asset("viewed-wide.png")]);
    assert_eq!(text(&rig, cx), "[Image #1] [Image #2] ");
    click(cx, "attachment-remove-0");
    assert_eq!(tray_summary(&rig, cx), (1, 0));
    assert_eq!(text(&rig, cx).trim(), "[Image #1]");
    assert!(rig.attached.borrow().iter().any(|event| matches!(event, ComposerAttachment::ImageRemoved(1))));
    // The remaining image is the wide one.
    let name = rig.composer.read_with(cx, |c, _| c.attachments()[0].name.to_string());
    assert_eq!(name, "viewed-wide.png");
}

#[gpui::test]
fn deleting_an_image_chip_from_the_text_removes_the_image_from_the_tray(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    attach(&rig, cx, vec![asset("viewed-checker.png"), asset("viewed-wide.png")]);
    rig.composer.update_in(cx, |c, window, cx| c.set_text("a [Image #2]", window, cx));
    cx.run_until_parked();
    assert_eq!(tray_summary(&rig, cx), (2, 0), "set_text does not count as deleting");
    rig.composer.update_in(cx, |c, _, cx| {
        let state = c.input().unwrap().clone();
        state.update(cx, |state, cx| state.set_selected_range(12..12, cx));
    });
    cx.simulate_keystrokes("backspace");
    assert_eq!(tray_summary(&rig, cx), (1, 0), "the image whose chip went is gone from the tray");
}

#[gpui::test]
fn limits_and_errors_are_reacts(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    // A pasted image of a type the app does not take.
    rig.composer.update_in(cx, |c, window, cx| {
        c.attach_pasted(vec![Image::from_bytes(ImageFormat::Bmp, vec![0; 8])], 0..0, window, cx);
    });
    cx.run_until_parked();
    assert_eq!(rig.composer.read_with(cx, |c, _| c.attachment_error().map(|e| e.to_string())), Some(ERROR_TYPE.to_string()));
    assert!(cx.debug_bounds("composer-attachment-error").is_some());
    // Bytes that are not a picture.
    rig.composer.update_in(cx, |c, window, cx| {
        c.attach_pasted(vec![Image::from_bytes(ImageFormat::Png, vec![1, 2, 3])], 0..0, window, cx);
    });
    assert_eq!(tray_summary(&rig, cx), (0, 0));
    assert_eq!(rig.composer.read_with(cx, |c, _| c.attachment_error().map(|e| e.to_string())), Some(super::ERROR_PASTE.to_string()));
    // A file over 50 MiB (a sparse file: only its length is read).
    let big = scratch("big.bin", b"");
    std::fs::File::options().write(true).open(&big).unwrap().set_len(super::MAX_ATTACHMENT_BYTES + 1).unwrap();
    attach(&rig, cx, vec![big]);
    assert_eq!(tray_summary(&rig, cx), (0, 0));
    assert_eq!(
        rig.composer.read_with(cx, |c, _| c.attachment_error().map(|e| e.to_string())),
        Some("big.bin is larger than 50 MiB.".to_string())
    );
    assert_eq!(ERROR_SIZE, "Each image must be 50 MiB or smaller.");
    // The next good attach clears the error.
    attach(&rig, cx, vec![asset("viewed-checker.png")]);
    assert_eq!(rig.composer.read_with(cx, |c, _| c.attachment_error().cloned()), None);
}

#[gpui::test]
fn the_attach_button_opens_the_file_prompt_and_its_paths_join_the_tray(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    click(cx, "composer-attach");
    assert!(cx.did_prompt_for_paths(), "the platform's file prompt opened");
    let picked = asset("viewed-checker.png");
    cx.simulate_path_prompt_response(|options| {
        assert!(options.files && !options.directories && options.multiple);
        Some(vec![picked.clone()])
    });
    cx.run_until_parked();
    assert_eq!(tray_summary(&rig, cx), (1, 0));
}

#[gpui::test]
fn sending_makes_one_outgoing_message_and_clears_the_draft(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    rig.composer.update_in(cx, |c, _, cx| c.add_quote("a quoted line", Some("Claude reply"), cx));
    attach(&rig, cx, vec![asset("viewed-checker.png"), scratch("notes.txt", b"hi")]);
    cx.simulate_input("look");
    cx.simulate_keystrokes("enter");
    let calls = rig.sink.calls();
    let [SinkCall::Send(message)] = calls.as_slice() else { panic!("one send, got {calls:?}") };
    assert_eq!(message.text, "[Image #1] look");
    assert!(message.prompt.contains("a quoted line") && message.prompt.ends_with("[Image #1] look"), "{}", message.prompt);
    assert_eq!(message.quotes, ["a quoted line"]);
    assert_eq!((message.images.len(), message.files.len()), (1, 1));
    assert_eq!(message.images[0].index, 1);
    assert_eq!(message.files[0].name.to_string(), "notes.txt");
    assert_eq!(message.delivery, SendAction::Send);
    assert_eq!(rig.events.borrow().len(), 1);
    assert_eq!((text(&rig, cx), tray_summary(&rig, cx)), (String::new(), (0, 0)));
    assert!(rig.composer.read_with(cx, |c, _| c.quotes().is_empty()));
    assert!(cx.debug_bounds("composer-tray").is_none(), "the tray is gone");
}

#[gpui::test]
fn a_message_with_only_an_attachment_sends_and_nothing_sends_nothing(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    cx.simulate_keystrokes("enter");
    assert!(rig.sink.calls().is_empty(), "an empty composer sends nothing");
    attach(&rig, cx, vec![scratch("only.txt", b"x")]);
    assert!(rig.composer.read_with(cx, |c, _| c.can_send()));
    cx.simulate_keystrokes("enter");
    assert_eq!(rig.sink.calls().len(), 1);
}

#[gpui::test]
fn while_a_turn_runs_the_send_button_is_stop_and_a_follow_up_steers(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    rig.composer.update(cx, |c, cx| c.set_running(true, cx));
    cx.run_until_parked();
    assert_eq!(rig.composer.read_with(cx, |c, _| c.send_label()), "Stop agent");
    assert!(cx.debug_bounds("composer-stop-square").is_some());
    cx.simulate_keystrokes("enter");
    assert!(rig.sink.calls().is_empty(), "Enter never stops");
    click(cx, "composer-send");
    assert_eq!(rig.sink.calls(), [SinkCall::Stop]);
    assert_eq!(rig.events.borrow().as_slice(), ["stop"]);
    // With text the button sends: the provider steers, so the message goes into the running turn.
    rig.composer.update_in(cx, |c, window, cx| {
        let handle = c.focus_handle(cx);
        window.focus(&handle, cx);
    });
    cx.simulate_input("also this");
    assert_eq!(rig.composer.read_with(cx, |c, _| c.send_label()), "Send now");
    cx.simulate_keystrokes("enter");
    let calls = rig.sink.calls();
    assert!(matches!(calls.last(), Some(SinkCall::Send(OutgoingMessage { delivery: SendAction::Steer, .. }))), "{calls:?}");
    assert!(rig.composer.read_with(cx, |c, _| c.queued().is_empty()));
}

#[gpui::test]
fn the_queue_setting_docks_the_message_above_the_composer_with_send_now_edit_and_remove(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    rig.composer.update(cx, |c, cx| {
        c.set_running(true, cx);
        c.set_follow_ups(Delivery::Queue, cx);
    });
    cx.simulate_input("first");
    assert_eq!(rig.composer.read_with(cx, |c, _| c.send_label()), "Queue message");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("second");
    cx.simulate_keystrokes("enter");
    assert_eq!(rig.composer.read_with(cx, |c, _| c.queued().len()), 2);
    assert_eq!(rig.events.borrow().as_slice(), ["queued:first", "queued:second"]);
    let (queue, composer) = (bounds(cx, "composer-queue"), bounds(cx, "composer"));
    assert!(queue.bottom() <= composer.top(), "docked above the composer's box");
    assert!(bounds(cx, "queued-message-1").size.height > gpui::px(0.0));
    // Edit takes the first back into the empty composer.
    click(cx, "queued-edit-0");
    assert_eq!(text(&rig, cx), "first");
    assert_eq!(rig.composer.read_with(cx, |c, _| c.queued().len()), 1);
    // With a draft in the composer, Edit leaves the queue alone.
    click(cx, "queued-edit-0");
    assert_eq!((text(&rig, cx), rig.composer.read_with(cx, |c, _| c.queued().len())), ("first".to_string(), 1));
    // Send now sends the queued one into the turn (Claude steers, so no stop).
    click(cx, "queued-send-0");
    assert!(rig.events.borrow().iter().any(|e| e == "send:second"));
    assert!(rig.composer.read_with(cx, |c, _| c.queued().is_empty()));
    assert!(cx.debug_bounds("composer-queue").is_none());
    assert!(rig.sink.calls().iter().any(|call| matches!(call, SinkCall::SendQueuedNow(_))));
}

#[gpui::test]
fn remove_drops_a_queued_message_and_a_turn_that_cannot_steer_is_stopped_first(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    rig.composer.update(cx, |c, cx| {
        c.set_model(crate::data::Provider::Kiro, "kiro", "Kiro", None, cx);
        c.set_running(true, cx);
    });
    cx.simulate_input("one");
    assert_eq!(rig.composer.read_with(cx, |c, _| c.send_label()), "Queue message", "a provider that cannot steer always queues");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("two");
    cx.simulate_keystrokes("enter");
    click(cx, "queued-remove-0");
    let remaining = rig.composer.read_with(cx, |c, _| c.queued().iter().map(|q| q.message.body.to_string()).collect::<Vec<_>>());
    assert_eq!(remaining, ["two"]);
    assert!(rig.sink.calls().iter().any(|call| matches!(call, SinkCall::RemoveQueued(_))));
    click(cx, "queued-send-0");
    let calls = rig.sink.calls();
    let stop = calls.iter().position(|c| *c == SinkCall::Stop).expect("stopped first");
    let now = calls.iter().position(|c| matches!(c, SinkCall::SendQueuedNow(_))).expect("then sent");
    assert!(stop < now, "{calls:?}");
}

#[gpui::test]
fn the_chips_open_their_pickers(cx: &mut TestAppContext) {
    let (rig, cx) = mount(cx);
    rig.composer.update(cx, |c, cx| {
        c.set_permission_mode(crate::data::PermissionMode::Full, cx);
        c.set_context_percent(Some(42), cx);
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("composer-permission-chip").is_some() && cx.debug_bounds("composer-model-chip").is_some());
    assert!(bounds(cx, "composer-context-slot").size.width > gpui::px(0.0));
    click(cx, "composer-model-chip");
    assert!(cx.debug_bounds("model-picker").is_some(), "the model chip opens its picker");
}
