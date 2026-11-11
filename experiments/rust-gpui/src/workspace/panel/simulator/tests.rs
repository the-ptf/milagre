//! Simulator viewer tests: the geometry and touch mapping against the JavaScript receiver's own output
//! (`fixture/vectors.json`, from `fixture/vectors.mjs`), the input queue, frame decoding, and the view in GPUI's
//! headless test platform over the fixture bridge.

use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext, px};
use serde_json::Value;

use super::fixture::{self, FRAME_SIZE, FixtureBridge, Scenario};
use super::geometry::{self, STAGE_INSET};
use super::input::{InputQueue, Overflow, QUEUE_LIMIT};
use super::types::{
    Connection, Device, FrameData, HardwareButton, Input, KeyPhase, Orientation, Platform, ScreenPoint, Status, TouchPhase,
};
use super::{SimulatorEvent, SimulatorView, frames};
use crate::testing;

// -------------------------------------------------------------------------------------------------------------
// Pure functions against the receiver's vectors

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixture/vectors.json")).expect("vectors.json parses")
}

fn orientation(name: &str) -> Orientation {
    match name {
        "portrait" => Orientation::Portrait,
        "landscape-left" => Orientation::LandscapeLeft,
        "landscape-right" => Orientation::LandscapeRight,
        "portrait-upside-down" => Orientation::PortraitUpsideDown,
        other => panic!("unknown orientation {other}"),
    }
}

fn close(a: f32, b: f64, what: &str) {
    assert!((f64::from(a) - b).abs() < 1e-3, "{what}: {a} vs {b}");
}

fn check_point(got: Option<ScreenPoint>, want: &Value, what: &str) {
    match (got, want) {
        (None, Value::Null) => {}
        (Some(p), Value::Object(o)) => {
            close(p.x, o["x"].as_f64().unwrap(), &format!("{what} x"));
            close(p.y, o["y"].as_f64().unwrap(), &format!("{what} y"));
        }
        (got, want) => panic!("{what}: got {got:?}, want {want}"),
    }
}

/// Three device sizes (iPhone 16 Pro, iPhone SE, iPad Air), two stage boxes, four orientations and an
/// already-turned buffer: the layout and every point (outside, inside, corner, captured drag) match the JavaScript.
#[test]
fn geometry_and_touch_mapping_match_the_receiver() {
    let data = vectors();
    let cases = data["out"].as_array().unwrap();
    assert_eq!(cases.len(), 3 * 2 * 4 + 1);
    let points = [(60.0, 120.0), (170.0, 380.0), (5.0, 5.0), (330.0, 700.0), (400.0, 200.0)];
    for case in cases {
        let name = format!("{} {}x{} in {}x{} {}", case["name"], case["w"], case["h"], case["bw"], case["bh"], case["o"]);
        let status = Status {
            width: case["w"].as_u64().unwrap() as u32,
            height: case["h"].as_u64().unwrap() as u32,
            orientation: orientation(case["o"].as_str().unwrap()),
            ..Status::default()
        };
        let g = geometry::geometry(&status, case["bw"].as_f64().unwrap() as f32, case["bh"].as_f64().unwrap() as f32, STAGE_INSET)
            .expect(&name);
        let want = &case["g"];
        for (field, value) in [
            ("left", g.left),
            ("top", g.top),
            ("width", g.width),
            ("height", g.height),
            ("rawWidth", g.raw_width),
            ("rawHeight", g.raw_height),
        ] {
            close(value, want[field].as_f64().unwrap(), &format!("{name} {field}"));
        }
        assert_eq!(i64::from(g.rotation), want["rotation"].as_i64().unwrap(), "{name} rotation");
        for ((x, y), mapped) in points.iter().zip(case["mapped"].as_array().unwrap()) {
            let radius = g.width.min(g.height) * 0.14;
            check_point(geometry::point(*x, *y, &g, false, 0.0), &mapped[0], &format!("{name} ({x},{y}) tap"));
            check_point(geometry::point(*x, *y, &g, true, 0.0), &mapped[1], &format!("{name} ({x},{y}) drag"));
            check_point(geometry::point(*x, *y, &g, false, radius), &mapped[2], &format!("{name} ({x},{y}) rounded"));
        }
    }
}

#[test]
fn geometry_needs_a_capture_and_room() {
    let status = Status { width: 390, height: 844, ..Status::default() };
    assert!(geometry::geometry(&Status::default(), 400.0, 800.0, STAGE_INSET).is_none());
    assert!(geometry::geometry(&status, 48.0, 800.0, STAGE_INSET).is_none());
    assert!(geometry::geometry(&status, 49.0, 800.0, STAGE_INSET).is_some());
}

#[test]
fn corner_radius_follows_the_model_like_the_receiver() {
    let data = vectors();
    let want: Vec<f64> = data["app"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let device = |platform, name: &str, device_type: Option<&str>| Device {
        id: "x".into(),
        name: name.to_string().into(),
        platform,
        version: "1".into(),
        device_type: device_type.map(|t| t.to_string().into()),
    };
    let devices = [
        device(Platform::Ios, "iPhone 16 Pro", None),
        device(Platform::Ios, "My phone", Some("com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro")),
        device(Platform::Ios, "iPhone SE (3rd generation)", None),
        device(Platform::Ios, "iPhone 8", None),
        device(Platform::Ios, "iPhone Xs Max", None),
        device(Platform::Ios, "iPhone Air", None),
        device(Platform::Ios, "iPhone 16e", None),
        device(Platform::Ios, "iPad Air 11-inch (M2)", None),
        device(Platform::Android, "Pixel 9", None),
        device(Platform::Ios, "Custom", None),
        device(Platform::Ios, "iPhone 11", None),
    ];
    assert_eq!(devices.len(), want.len());
    for (device, want) in devices.iter().zip(want) {
        close(geometry::corner_share(device), want, &device.name);
    }
}

#[test]
fn keys_map_to_hid_usages() {
    assert_eq!(geometry::hid_usage("a"), Some(4));
    assert_eq!(geometry::hid_usage("z"), Some(29));
    assert_eq!(geometry::hid_usage("1"), Some(30));
    assert_eq!(geometry::hid_usage("0"), Some(39));
    assert_eq!(geometry::hid_usage("enter"), Some(40));
    assert_eq!(geometry::hid_usage("backspace"), Some(42));
    assert_eq!(geometry::hid_usage("space"), Some(44));
    assert_eq!(geometry::hid_usage("/"), Some(56));
    assert_eq!(geometry::hid_usage("up"), Some(82));
    assert_eq!(geometry::hid_usage("f5"), None);
    assert_eq!(geometry::hid_usage("A"), None, "GPUI names keys in lower case; shift is a modifier");
}

// -------------------------------------------------------------------------------------------------------------
// Input queue

fn touch(phase: TouchPhase, x: f32) -> Input {
    Input::Touch { phase, points: vec![ScreenPoint { x, y: 0.5 }] }
}

#[test]
fn queue_sends_one_at_a_time_and_collapses_moves() {
    let mut queue = InputQueue::default();
    queue.push(touch(TouchPhase::Begin, 0.1)).unwrap();
    queue.push(touch(TouchPhase::Move, 0.2)).unwrap();
    queue.push(touch(TouchPhase::Move, 0.3)).unwrap();
    assert_eq!(queue.len(), 2, "consecutive moves collapse");
    assert_eq!(queue.take(), Some(touch(TouchPhase::Begin, 0.1)));
    assert_eq!(queue.take(), None, "one in flight");
    queue.push(touch(TouchPhase::End, 0.3)).unwrap();
    queue.push(touch(TouchPhase::Move, 0.4)).unwrap();
    queue.sent();
    assert_eq!(queue.take(), Some(touch(TouchPhase::Move, 0.3)), "the newest move");
    queue.sent();
    assert_eq!(queue.take(), Some(touch(TouchPhase::End, 0.3)), "a boundary is never dropped");
}

#[test]
fn queue_overflow_ends_the_session() {
    let mut queue = InputQueue::default();
    for _ in 0..QUEUE_LIMIT {
        queue.push(Input::Button(HardwareButton::Home)).unwrap();
    }
    assert_eq!(queue.push(Input::Button(HardwareButton::Home)), Err(Overflow));
    assert_eq!(queue.len(), 0);
}

// -------------------------------------------------------------------------------------------------------------
// Frames

#[test]
fn fixture_frames_decode_and_turn() {
    for bytes in fixture::FRAMES {
        let upright = frames::decode(&FrameData::Png(bytes.to_vec()), 0).expect("decodes");
        let size = upright.image.size(0);
        assert_eq!((size.width.0 as u32, size.height.0 as u32), FRAME_SIZE);
        let turned = frames::decode(&FrameData::Png(bytes.to_vec()), 90).expect("decodes");
        let size = turned.image.size(0);
        assert_eq!((size.width.0 as u32, size.height.0 as u32), (FRAME_SIZE.1, FRAME_SIZE.0), "landscape swaps the axes");
    }
    assert!(frames::decode(&FrameData::Avcc(vec![1, 2, 3]), 0).is_err(), "H.264 is not decoded in this port");
    assert!(frames::decode(&FrameData::Png(vec![0; 16]), 0).is_err());
}

#[test]
fn turning_matches_css_rotate() {
    // A 2x1 image: red then blue. `rotate(90deg)` is clockwise: red ends on top.
    let mut image = image::RgbaImage::new(2, 1);
    image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
    image.put_pixel(1, 0, image::Rgba([0, 0, 255, 255]));
    let turned = frames::turn(image.clone(), 90);
    assert_eq!(turned.dimensions(), (1, 2));
    assert_eq!(turned.get_pixel(0, 0).0, [255, 0, 0, 255]);
    let back = frames::turn(image, -90);
    assert_eq!(back.get_pixel(0, 0).0, [0, 0, 255, 255]);
}

#[gpui::test]
fn rail_glyphs_rasterise(cx: &mut TestAppContext) {
    for glyph in super::render::Glyph::ALL {
        let image = cx.update(|cx| super::render::glyph_image(glyph, gpui::rgb(0x62656b), cx));
        let size = image.expect("the receiver's SVG parses").size(0);
        assert_eq!((size.width.0, size.height.0), (34, 34), "17px at 2x");
    }
}

// -------------------------------------------------------------------------------------------------------------
// The view

struct Mounted<'a> {
    view: Entity<SimulatorView>,
    host: FixtureBridge,
    cx: &'a mut VisualTestContext,
}

fn mount(cx: &mut TestAppContext, scenario: Scenario) -> Mounted<'_> {
    let bridge = FixtureBridge::new(scenario, |chat| chat == "chat-a");
    let host = bridge.clone();
    let (view, cx) = testing::mount_in_root(cx, move |_, cx| SimulatorView::new(Rc::new(bridge), cx));
    view.update(cx, |view, cx| view.set_chat("chat-a", cx));
    settle(cx);
    Mounted { view, host, cx }
}

/// Two passes: the stage measures itself as it paints, then lays out the device from that size.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.run_until_parked();
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
    }
}

fn tick(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

fn connection(m: &mut Mounted) -> Connection {
    m.view.read_with(m.cx, |v, _| v.connection())
}

fn inputs(m: &Mounted) -> Vec<Input> {
    m.host.host.borrow().inputs.iter().map(|(_, _, input)| input.clone()).collect()
}

#[gpui::test]
fn the_only_attached_device_opens_live(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.selected().map(|d| d.name.clone())), Some("iPhone 16 Pro".into()));
    assert_eq!(m.view.read_with(m.cx, |v, _| v.connection()), Connection::Live);
    let stage = testing::bounds(m.cx, "simulator-stage");
    let screen = testing::bounds(m.cx, "simulator-screen");
    assert!(m.cx.debug_bounds("simulator-picture").is_some(), "the first frame is up");
    assert!(stage.contains(&screen.origin) && stage.contains(&screen.bottom_right()), "screen {screen:?} inside stage {stage:?}");
    // Letterboxed at the capture's aspect, centred with the 24px inset on the tight side.
    let aspect = f32::from(screen.size.width) / f32::from(screen.size.height);
    assert!((aspect - FRAME_SIZE.0 as f32 / FRAME_SIZE.1 as f32).abs() < 0.01, "aspect {aspect}");
    let side = (screen.left() - stage.left()).min(stage.top() + stage.size.height - screen.bottom());
    assert!(side >= px(STAGE_INSET - 0.5), "inset kept: {side:?}");
}

#[gpui::test]
fn frames_cycle_every_pull(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Live);
    let after = |m: &mut Mounted| m.view.read_with(m.cx, |v, _| v.after);
    assert_eq!(after(&mut m), 1);
    tick(m.cx, 67);
    tick(m.cx, 67);
    assert_eq!(after(&mut m), 3);
    assert_eq!(connection(&mut m), Connection::Live);
}

#[gpui::test]
fn a_click_on_the_screen_is_a_tap(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let screen = testing::bounds(m.cx, "simulator-screen");
    m.cx.simulate_click(screen.center(), Modifiers::none());
    settle(m.cx);
    let sent = inputs(&m);
    assert_eq!(sent.len(), 2, "{sent:?}");
    let Input::Touch { phase: TouchPhase::Begin, points } = &sent[0] else { panic!("begin first: {sent:?}") };
    assert!((points[0].x - 0.5).abs() < 0.01 && (points[0].y - 0.5).abs() < 0.01, "{points:?}");
    assert!(matches!(&sent[1], Input::Touch { phase: TouchPhase::End, .. }));
}

#[gpui::test]
fn a_click_on_the_bezel_or_outside_is_ignored(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let screen = testing::bounds(m.cx, "simulator-screen");
    let stage = testing::bounds(m.cx, "simulator-stage");
    m.cx.simulate_click(gpui::point(stage.left() + px(4.0), stage.top() + px(4.0)), Modifiers::none());
    // The rounded corner of the screen is outside it.
    m.cx.simulate_click(screen.origin + gpui::point(px(1.0), px(1.0)), Modifiers::none());
    settle(m.cx);
    assert!(inputs(&m).is_empty());
}

#[gpui::test]
fn a_drag_out_of_the_screen_clamps_at_the_edge(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let screen = testing::bounds(m.cx, "simulator-screen");
    m.cx.simulate_mouse_down(screen.center(), MouseButton::Left, Modifiers::none());
    settle(m.cx);
    let outside = gpui::point(screen.right() + px(200.0), screen.center().y);
    m.cx.simulate_mouse_move(outside, Some(MouseButton::Left), Modifiers::none());
    settle(m.cx);
    m.cx.simulate_mouse_up(outside, MouseButton::Left, Modifiers::none());
    settle(m.cx);
    let sent = inputs(&m);
    let phases: Vec<TouchPhase> =
        sent.iter().filter_map(|i| if let Input::Touch { phase, .. } = i { Some(*phase) } else { None }).collect();
    assert_eq!(phases, [TouchPhase::Begin, TouchPhase::Move, TouchPhase::End], "{sent:?}");
    let Input::Touch { points, .. } = &sent[1] else { unreachable!() };
    assert_eq!(points[0].x, 1.0, "held at the right edge");
}

#[gpui::test]
fn home_sends_the_button(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let home = testing::bounds(m.cx, "simulator-home");
    m.cx.simulate_click(home.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(inputs(&m), [Input::Button(HardwareButton::Home)]);
    assert!(m.cx.debug_bounds("simulator-back").is_none(), "Back is Android only");
}

#[gpui::test]
fn rotate_waits_for_the_next_display_generation(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Live);
    let portrait = testing::bounds(m.cx, "simulator-screen");
    let rotate = testing::bounds(m.cx, "simulator-rotate");
    m.cx.simulate_click(rotate.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(inputs(&m), [Input::Rotate(Orientation::LandscapeLeft)]);
    assert_eq!(connection(&mut m), Connection::Rotating, "no touches in the old geometry");
    // The next frame carries the new generation.
    tick(m.cx, 67);
    tick(m.cx, 0);
    assert_eq!(connection(&mut m), Connection::Live);
    let landscape = testing::bounds(m.cx, "simulator-screen");
    assert!(landscape.size.width > landscape.size.height, "sideways: {landscape:?}");
    assert!(portrait.size.height > portrait.size.width);
    let picture = testing::bounds(m.cx, "simulator-picture");
    assert_eq!(picture.size, landscape.size, "the turned picture fills the screen");
}

#[gpui::test]
fn a_rotate_the_host_never_finishes_fails_after_eight_seconds(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Live);
    // The host takes the rotate but keeps reporting the old generation.
    m.view.update(m.cx, |v, cx| v.rotate(cx));
    m.host.host.borrow_mut().generation = 1;
    m.host.host.borrow_mut().orientation = Orientation::Portrait;
    tick(m.cx, 8_000);
    assert_eq!(connection(&mut m), Connection::Error);
    assert_eq!(
        m.view.read_with(m.cx, |v, _| v.error().map(str::to_string)).as_deref(),
        Some("The simulator did not finish changing its display. Retry to reconnect.")
    );
}

#[gpui::test]
fn keys_go_to_the_focused_simulator(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let screen = testing::bounds(m.cx, "simulator-screen");
    m.cx.simulate_click(screen.center(), Modifiers::none());
    settle(m.cx);
    m.host.host.borrow_mut().inputs.clear();
    m.cx.simulate_keystrokes("a shift-b enter");
    settle(m.cx);
    let keys: Vec<(KeyPhase, u8, bool)> = inputs(&m)
        .into_iter()
        .filter_map(|i| if let Input::Key { phase, usage, shifted } = i { Some((phase, usage, shifted)) } else { None })
        .collect();
    let downs: Vec<(u8, bool)> = keys.iter().filter(|(p, ..)| *p == KeyPhase::Down).map(|(_, u, s)| (*u, *s)).collect();
    assert_eq!(downs, [(4, false), (5, true), (40, false)], "{keys:?}");
}

#[gpui::test]
fn view_only_until_take_control(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::ViewOnly);
    assert_eq!(connection(&mut m), Connection::ViewOnly);
    let screen = testing::bounds(m.cx, "simulator-screen");
    m.cx.simulate_click(screen.center(), Modifiers::none());
    settle(m.cx);
    assert!(inputs(&m).is_empty(), "no input without control");
    let take = testing::bounds(m.cx, "simulator-control");
    m.cx.simulate_click(take.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(connection(&mut m), Connection::Live);
    assert!(m.cx.debug_bounds("simulator-control").is_none(), "Take control leaves once in control");
}

#[gpui::test]
fn connecting_until_the_host_answers(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Connecting);
    assert_eq!(connection(&mut m), Connection::Connecting);
    assert!(m.cx.debug_bounds("simulator-device").is_some(), "the frame waits with Connecting...");
    assert!(m.cx.debug_bounds("simulator-picture").is_none());
    tick(m.cx, 45_000);
    assert_eq!(connection(&mut m), Connection::Error, "the 45 s deadline");
}

#[gpui::test]
fn an_error_shows_the_reason_and_retries_with_backoff(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Error);
    assert_eq!(connection(&mut m), Connection::Error);
    assert!(m.cx.debug_bounds("simulator-failure").is_some());
    assert!(m.view.read_with(m.cx, |v, _| v.extras_open()), "More opens with Retry");
    assert!(m.cx.debug_bounds("simulator-reconnect").is_some());
    // Back off 1 s, then 2 s: the second attempt comes after three seconds, not two.
    tick(m.cx, 999);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.reconnects), 1);
    tick(m.cx, 1);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.reconnects), 2);
    tick(m.cx, 1_999);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.reconnects), 2);
    tick(m.cx, 1);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.reconnects), 3);
    // A working host on Retry: live again.
    m.host.host.borrow_mut().scenario = Scenario::Live;
    let retry = testing::bounds(m.cx, "simulator-reconnect");
    m.cx.simulate_click(retry.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(connection(&mut m), Connection::Live);
}

#[gpui::test]
fn a_stopped_device_is_offline(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Offline);
    assert_eq!(connection(&mut m), Connection::Offline);
    assert!(m.host.host.borrow().open.is_empty(), "nothing to open");
    // It boots again: the next list read reconnects.
    m.host.host.borrow_mut().scenario = Scenario::Live;
    tick(m.cx, 5_000);
    assert_eq!(connection(&mut m), Connection::Live);
}

#[gpui::test]
fn pause_closes_the_viewer_and_resume_reopens_it(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Live);
    m.view.update(m.cx, |v, cx| v.toggle_extras(cx));
    settle(m.cx);
    let pause = testing::bounds(m.cx, "simulator-pause");
    m.cx.simulate_click(pause.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(connection(&mut m), Connection::Paused);
    assert!(m.host.host.borrow().open.is_empty(), "the viewer is closed");
    let after = m.view.read_with(m.cx, |v, _| v.after);
    tick(m.cx, 500);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.after), after, "no pulls while paused");
    let resume = testing::bounds(m.cx, "simulator-pause");
    m.cx.simulate_click(resume.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(connection(&mut m), Connection::Live);
}

#[gpui::test]
fn copy_screenshot_puts_the_frame_on_the_clipboard(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    m.view.update(m.cx, |v, cx| v.toggle_extras(cx));
    settle(m.cx);
    let button = testing::bounds(m.cx, "simulator-screenshot");
    m.cx.simulate_click(button.center(), Modifiers::none());
    settle(m.cx);
    let item = m.cx.read_from_clipboard().expect("something was copied");
    let image =
        item.entries().iter().find_map(|entry| if let gpui::ClipboardEntry::Image(image) = entry { Some(image.clone()) } else { None });
    let image = image.expect("an image");
    assert_eq!(image.format(), gpui::ImageFormat::Png);
    assert!(fixture::FRAMES.contains(&image.bytes()));
}

#[gpui::test]
fn reset_input_asks_first(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    m.view.update(m.cx, |v, cx| v.toggle_extras(cx));
    settle(m.cx);
    let repair = testing::bounds(m.cx, "simulator-repair");
    m.cx.simulate_click(repair.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(m.host.host.borrow().repairs, 0, "the first press only explains");
    let repair = testing::bounds(m.cx, "simulator-repair");
    m.cx.simulate_click(repair.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(m.host.host.borrow().repairs, 1);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.connection()), Connection::Live, "reopened after the repair");
}

#[gpui::test]
fn detach_leaves_the_viewer_and_reports_none_attached(cx: &mut TestAppContext) {
    let m = mount(cx, Scenario::Live);
    let events = Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    m.cx.update(|_, cx| {
        cx.subscribe(&m.view, move |_, event: &SimulatorEvent, _| seen.borrow_mut().push(*event)).detach();
    });
    m.view.update(m.cx, |v, cx| v.toggle_extras(cx));
    settle(m.cx);
    let detach = testing::bounds(m.cx, "simulator-detach");
    m.cx.simulate_click(detach.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.attached_count()), 0);
    assert!(m.view.read_with(m.cx, |v, _| v.selected().is_none()));
    assert_eq!(events.borrow().last(), Some(&SimulatorEvent::Attached(0)));
    assert!(m.host.host.borrow().open.is_empty(), "the viewer was closed");
}

#[gpui::test]
fn the_list_attaches_another_device(cx: &mut TestAppContext) {
    let mut m = mount(cx, Scenario::Live);
    let name = testing::bounds(m.cx, "simulator-device-name");
    m.cx.simulate_click(name.center(), Modifiers::none());
    settle(m.cx);
    assert!(m.view.read_with(m.cx, |v, _| v.selected().is_none()), "the chevron shows the list");
    let attach = testing::bounds(m.cx, "simulator-attach");
    m.cx.simulate_click(attach.center(), Modifiers::none());
    settle(m.cx);
    // The available list: Pixel 9, then the iPad.
    let pixel = testing::bounds(m.cx, "simulator-device-0");
    m.cx.simulate_click(pixel.center(), Modifiers::none());
    settle(m.cx);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.attached_count()), 2);
    assert_eq!(m.view.read_with(m.cx, |v, _| v.selected().map(|d| d.platform)), Some(Platform::Android));
    assert_eq!(connection(&mut m), Connection::Live);
    assert!(m.cx.debug_bounds("simulator-back").is_some(), "Android has Back");
    assert!(m.cx.debug_bounds("simulator-repair").is_none());
}

/// Opens the workspace on a Chat that has a simulator (clicking its sidebar row) and shows the Simulator tab.
fn workspace_with_simulator(cx: &mut TestAppContext) -> (Entity<crate::workspace::panel::Panel>, &mut VisualTestContext) {
    use crate::workspace::panel::PanelTab;
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.panel.clone()));
    assert!(!panel.read_with(cx, |p, _| p.visible_tabs().contains(&PanelTab::Simulator)), "the startup Chat has none");
    let seeded = panel.read_with(cx, |p, _| p.chat().to_string());
    let ix = (0..12)
        .find(|ix| {
            let key = sidebar.read_with(cx, |s, _| s.row(*ix).map(|r| r.key.to_string()));
            key.is_some_and(|key| fixture::attached_at_start(&key, Some(&seeded), false))
        })
        .expect("a visible fixture Chat has a simulator");
    let row = testing::bounds(cx, testing::leak(format!("chat-row-{ix}")));
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    assert!(panel.read_with(cx, |p, _| p.visible_tabs().contains(&PanelTab::Simulator)), "its tab shows");
    panel.update(cx, |p, cx| p.activate(PanelTab::Simulator, cx));
    settle(cx);
    (panel, cx)
}

#[gpui::test]
fn the_panel_shows_the_tab_only_while_a_simulator_is_attached(cx: &mut TestAppContext) {
    use crate::workspace::panel::PanelTab;
    let (panel, cx) = workspace_with_simulator(cx);
    assert_eq!(panel.read_with(cx, |p, _| p.width()), 320.0, "the shared width");
    assert!(cx.debug_bounds("panel-body-Simulator").is_some());
    assert!(cx.debug_bounds("simulator-picture").is_some());
    assert!(cx.debug_bounds("toggle-terminal").is_none(), "the corner is one panel toggle");
    // Detaching the last device drops the tab and goes back to Changes.
    let simulator = panel.read_with(cx, |p, _| p.simulator().clone());
    simulator.update(cx, |v, cx| {
        let device = v.selected().cloned().expect("open");
        v.detach(device, cx);
    });
    settle(cx);
    assert!(!panel.read_with(cx, |p, _| p.visible_tabs().contains(&PanelTab::Simulator)));
    assert_eq!(panel.read_with(cx, |p, _| p.active()), PanelTab::Changes);
}

#[gpui::test]
fn a_hidden_viewer_pauses_and_reconnects_when_shown(cx: &mut TestAppContext) {
    use crate::workspace::panel::PanelTab;
    let (panel, cx) = workspace_with_simulator(cx);
    let simulator = panel.read_with(cx, |p, _| p.simulator().clone());
    simulator.update(cx, |v, _| v.set_pause_when_hidden(true));
    assert_eq!(simulator.read_with(cx, |v, _| v.connection()), Connection::Live);
    // Another tab: frames arrive and are never painted, so the viewer pauses and closes.
    panel.update(cx, |p, cx| p.activate(PanelTab::Changes, cx));
    settle(cx);
    for _ in 0..3 {
        tick(cx, 67);
    }
    assert_eq!(simulator.read_with(cx, |v, _| (v.hidden_paused, v.active)), (true, false));
    let after = simulator.read_with(cx, |v, _| v.after);
    tick(cx, 1_000);
    assert_eq!(simulator.read_with(cx, |v, _| v.after), after, "no pulls while hidden");
    // Shown again: it reconnects on its own.
    panel.update(cx, |p, cx| p.activate(PanelTab::Simulator, cx));
    settle(cx);
    assert_eq!(simulator.read_with(cx, |v, _| v.connection()), Connection::Live);
}

// -------------------------------------------------------------------------------------------------------------
// Fixture frames

/// Writes `fixture/frame-{1,2,3}.png`: a plain app screen at an iPhone's 390 by 844 points, 2x, whose progress
/// bar and highlighted row change from frame to frame. `cargo test write_fixture_frames -- --ignored`.
#[test]
#[ignore]
fn write_fixture_frames() {
    use image::{Rgba, RgbaImage};
    let (w, h) = FRAME_SIZE;
    let fill = |img: &mut RgbaImage, x: u32, y: u32, rw: u32, rh: u32, r: u32, color: [u8; 4]| {
        let r = r.min((rw - 1) / 2).min((rh - 1) / 2);
        for py in y..(y + rh).min(h) {
            for px in x..(x + rw).min(w) {
                // Rounded corners: skip pixels outside the corner circles.
                let cx = px.clamp(x + r, x + rw - r - 1);
                let cy = py.clamp(y + r, y + rh - r - 1);
                let (dx, dy) = (px as i64 - cx as i64, py as i64 - cy as i64);
                if dx * dx + dy * dy <= (r * r) as i64 {
                    img.put_pixel(px, py, Rgba(color));
                }
            }
        }
    };
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/workspace/panel/simulator/fixture");
    for frame in 0..3u32 {
        let mut img = RgbaImage::from_pixel(w, h, Rgba([242, 242, 247, 255]));
        // Status bar: time and the battery.
        fill(&mut img, 64, 40, 100, 30, 15, [20, 20, 22, 255]);
        fill(&mut img, 610, 44, 96, 24, 8, [20, 20, 22, 255]);
        // Large title and a search field.
        fill(&mut img, 40, 190, 380, 60, 12, [20, 20, 22, 255]);
        fill(&mut img, 40, 290, 700, 72, 20, [227, 227, 232, 255]);
        // A card with a progress bar that fills over the frames.
        fill(&mut img, 40, 400, 700, 220, 28, [255, 255, 255, 255]);
        fill(&mut img, 80, 440, 260, 28, 10, [60, 60, 67, 255]);
        fill(&mut img, 80, 500, 620, 24, 12, [229, 229, 234, 255]);
        fill(&mut img, 80, 500, 160 + 220 * frame, 24, 12, [2, 133, 255, 255]);
        fill(&mut img, 80, 556, 180, 24, 10, [174, 174, 178, 255]);
        // A list of rows; one is highlighted, moving down a row each frame.
        fill(&mut img, 40, 660, 700, 600, 28, [255, 255, 255, 255]);
        let colors = [[255, 149, 0, 255], [52, 199, 89, 255], [175, 82, 222, 255], [255, 59, 48, 255], [0, 199, 190, 255]];
        for (row, color) in colors.iter().enumerate() {
            let y = 660 + row as u32 * 120;
            if row as u32 == frame + 1 {
                fill(&mut img, 40, y, 700, 120, 0, [235, 244, 255, 255]);
            }
            fill(&mut img, 72, y + 32, 56, 56, 14, *color);
            fill(&mut img, 152, y + 38, 300 - row as u32 * 30, 22, 8, [60, 60, 67, 255]);
            fill(&mut img, 152, y + 72, 200, 16, 8, [174, 174, 178, 255]);
        }
        // Tab bar and the home indicator.
        fill(&mut img, 0, 1500, w, 188, 0, [249, 249, 249, 255]);
        for tab in 0..4u32 {
            let color = if tab == frame % 4 { [2, 133, 255, 255] } else { [174, 174, 178, 255] };
            fill(&mut img, 100 + tab * 170, 1530, 52, 52, 26, color);
        }
        fill(&mut img, 250, 1650, 280, 10, 5, [20, 20, 22, 255]);
        img.save_with_format(dir.join(format!("frame-{}.png", frame + 1)), image::ImageFormat::Png).expect("saved");
    }
}

#[gpui::test]
fn the_simulator_shortcut_shows_and_hides_its_tab_only_where_a_simulator_is_attached(cx: &mut TestAppContext) {
    let (panel, cx) = workspace_with_simulator(cx);
    assert!(panel.read_with(cx, |p, _| p.is_open()));
    cx.simulate_keystrokes("shift-cmd-s");
    settle(cx);
    assert!(!panel.read_with(cx, |p, _| p.is_open()), "simulator.toggle hides the open Simulator tab");
    cx.simulate_keystrokes("shift-cmd-s");
    settle(cx);
    assert!(panel.read_with(cx, |p, _| p.is_open() && p.active() == crate::workspace::panel::PanelTab::Simulator));
}

#[gpui::test]
fn the_simulator_shortcut_does_nothing_without_a_simulator(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    let before = panel.read_with(cx, |p, _| (p.is_open(), p.active()));
    cx.simulate_keystrokes("shift-cmd-s");
    settle(cx);
    assert_eq!(panel.read_with(cx, |p, _| (p.is_open(), p.active())), before);
}
