use std::time::{Duration, Instant};

use gpui::{Keystroke, Modifiers, bounds, point, px, size};

use super::bridge::{BrowserBridge, BrowserFrame, BrowserInput, Button, Phase};
use super::spike::{CdpSpike, block_on, test_page};
use super::{decode, keys, picture_rect};

fn keystroke(text: &'static str) -> Keystroke {
    Keystroke::parse(text).unwrap()
}

#[test]
fn printable_keys_type_their_text_on_key_down_only() {
    let mut a = keystroke("a");
    a.key_char = Some("a".into());
    let Some(BrowserInput::Key { key, code, key_code, text, .. }) = keys::key_event(&a, true) else { panic!("a key event") };
    assert_eq!((key.as_str(), code.as_str(), key_code, text.as_deref()), ("a", "KeyA", 65, Some("a")));
    let Some(BrowserInput::Key { text, .. }) = keys::key_event(&a, false) else { panic!("a key event") };
    assert_eq!(text, None);
}

#[test]
fn named_keys_carry_dom_names_and_enter_types_a_return() {
    let Some(BrowserInput::Key { key, key_code, text, .. }) = keys::key_event(&keystroke("enter"), true) else { panic!() };
    assert_eq!((key.as_str(), key_code, text.as_deref()), ("Enter", 13, Some("\r")));
    let Some(BrowserInput::Key { key, key_code, text, .. }) = keys::key_event(&keystroke("backspace"), true) else { panic!() };
    assert_eq!((key.as_str(), key_code, text), ("Backspace", 8, None));
}

#[test]
fn command_shortcuts_become_editing_commands_and_others_stay_the_apps() {
    let Some(BrowserInput::Key { commands, modifiers, .. }) = keys::key_event(&keystroke("cmd-a"), true) else { panic!() };
    assert_eq!((commands, modifiers), (vec!["selectAll"], 4));
    let Some(BrowserInput::Key { commands, .. }) = keys::key_event(&keystroke("cmd-shift-z"), true) else { panic!() };
    assert_eq!(commands, vec!["redo"]);
    assert_eq!(keys::key_event(&keystroke("cmd-k"), true), None);
    assert_eq!(keys::key_event(&keystroke("ctrl-c"), true), None);
}

#[test]
fn modifier_bits_follow_cdp() {
    let all = Modifiers { alt: true, control: true, platform: true, shift: true, function: false };
    assert_eq!(keys::modifiers(&all), 15);
    assert_eq!(keys::modifiers(&Modifiers::shift()), 8);
}

#[test]
fn the_picture_sits_top_left_and_only_scales_down() {
    let stage = bounds(point(px(100.0), px(50.0)), size(px(400.0), px(300.0)));
    assert_eq!(picture_rect(stage, (400, 300)), Some(stage));
    let smaller = picture_rect(stage, (200, 100)).unwrap();
    assert_eq!((smaller.origin, smaller.size), (stage.origin, size(px(200.0), px(100.0))));
    let larger = picture_rect(stage, (800, 300)).unwrap();
    assert_eq!(larger.size, size(px(400.0), px(150.0)));
    assert_eq!(picture_rect(stage, (0, 0)), None);
}

// ---------------------------------------------------------------------------------------------------------------
// The bench: a real headless Chrome, so it runs only on request.
//
//   cargo test browser_spike_bench -- --ignored --nocapture

const OUT: &str = "/tmp/milagre-browser-spike";

/// The corner flag's colour in a frame: 'r', 'g', 'b' or '?'.
fn flag(frame: &BrowserFrame) -> char {
    let image = image::load_from_memory_with_format(&frame.jpeg, image::ImageFormat::Jpeg).unwrap().into_rgb8();
    let per_css = image.width() as f32 / frame.viewport.0 as f32;
    let [r, g, b] = image.get_pixel(image.width() - (16.0 * per_css) as u32, (16.0 * per_css) as u32).0;
    match (r > 150, g > 150, b > 150) {
        (true, false, false) => 'r',
        (false, true, false) => 'g',
        (false, false, true) => 'b',
        _ => '?',
    }
}

fn next_frame(spike: &CdpSpike, after: u64) -> BrowserFrame {
    block_on(spike.frame("spike", after), Duration::from_secs(5)).expect("a frame").expect("a frame")
}

/// Sends `events`, then waits for the first frame whose corner flag is `expected`. Returns input-to-frame and the
/// decode of that frame, in milliseconds, and the frame.
fn round_trip(spike: &CdpSpike, after: &mut u64, events: Vec<BrowserInput>, expected: char) -> (f32, f32) {
    let sent = Instant::now();
    for event in events {
        block_on(spike.input("spike", 0, 0, event), Duration::from_secs(1)).unwrap();
    }
    loop {
        let frame = next_frame(spike, *after);
        *after = frame.sequence;
        let started = Instant::now();
        let seen = flag(&frame);
        let _ = decode(&frame.jpeg).unwrap();
        let decode_ms = started.elapsed().as_secs_f32() * 1000.0 / 2.0;
        if seen == expected {
            return (frame.received.duration_since(sent).as_secs_f32() * 1000.0, decode_ms);
        }
        assert!(sent.elapsed() < Duration::from_secs(5), "the page never showed the input");
    }
}

fn percentile(samples: &[f32], p: f32) -> f32 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted[((sorted.len() - 1) as f32 * p).round() as usize]
}

/// CPU seconds used so far by `root` and every process under it (`ps` cumulative time).
fn tree_cpu(root: u32) -> f64 {
    let out = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,time="]).output().unwrap();
    let rows: Vec<(u32, u32, f64)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let time = parts.next()?;
            let seconds = time.split(':').fold(0.0, |total, part| total * 60.0 + part.parse::<f64>().unwrap_or(0.0));
            Some((pid, ppid, seconds))
        })
        .collect();
    let mut tree = vec![root];
    let mut ix = 0;
    while ix < tree.len() {
        let parent = tree[ix];
        tree.extend(rows.iter().filter(|row| row.1 == parent).map(|row| row.0));
        ix += 1;
    }
    rows.iter().filter(|row| tree.contains(&row.0)).map(|row| row.2).sum()
}

fn own_cpu() -> f64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `usage` is a valid rusage for getrusage to fill.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

fn save(frame: &BrowserFrame, name: &str) {
    std::fs::create_dir_all(OUT).unwrap();
    std::fs::write(format!("{OUT}/{name}.jpg"), &frame.jpeg).unwrap();
}

fn open(page: String, scale: f32) -> (CdpSpike, u64) {
    let spike = CdpSpike::default();
    block_on(spike.open("bench", &page), Duration::from_secs(20)).expect("Chrome starts");
    block_on(spike.input("spike", 0, 0, BrowserInput::Viewport { width: 800, height: 600, scale }), Duration::from_secs(1)).unwrap();
    let mut after = 0;
    loop {
        let frame = next_frame(&spike, after);
        after = frame.sequence;
        let pixels = image::load_from_memory(&frame.jpeg).unwrap();
        eprintln!(
            "frame {}: viewport {:?}, JPEG {}x{}, {} KB",
            frame.sequence,
            frame.viewport,
            pixels.width(),
            pixels.height(),
            frame.jpeg.len() / 1024
        );
        if frame.viewport == (800, 600) {
            return (spike, after);
        }
    }
}

/// Counts frames over `window` while `drive` runs every `every`; returns fps, mean decode ms, browser and own CPU %.
fn rate(spike: &CdpSpike, after: &mut u64, window: Duration, every: Duration, mut drive: impl FnMut(&CdpSpike)) -> (f32, f32, f64, f64) {
    let pid = spike.browser_pid().unwrap();
    let (browser_before, own_before) = (tree_cpu(pid), own_cpu());
    let started = Instant::now();
    let (mut frames, mut decode_total, mut next_drive) = (0u32, 0f32, Instant::now());
    while started.elapsed() < window {
        if Instant::now() >= next_drive {
            drive(spike);
            next_drive += every;
        }
        let wait = next_drive.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        if let Ok(Some(frame)) = block_on(spike.frame("spike", *after), wait) {
            *after = frame.sequence;
            frames += 1;
            let decoding = Instant::now();
            let _ = decode(&frame.jpeg).unwrap();
            decode_total += decoding.elapsed().as_secs_f32() * 1000.0;
        }
    }
    let seconds = started.elapsed().as_secs_f64();
    let browser = (tree_cpu(pid) - browser_before) / seconds * 100.0;
    let own = (own_cpu() - own_before) / seconds * 100.0;
    (frames as f32 / seconds as f32, decode_total / frames.max(1) as f32, browser, own)
}

#[test]
#[ignore = "launches a headless Chrome; run with --ignored --nocapture"]
fn browser_spike_bench() {
    if crate::platform::cdp::find_browser().is_none() {
        eprintln!("no Chrome or Chromium installed; skipping");
        return;
    }
    for scale in [1.0f32, 2.0] {
        eprintln!("\n== scale {scale}, JPEG quality {} ==", super::spike::QUALITY);
        let (spike, mut after) = open(test_page(false), scale);
        // Click latency: each press flips the corner flag between blue and red.
        let click = |phase| BrowserInput::Mouse { phase, x: 0.5, y: 0.9, button: Button::Left, click_count: 1, modifiers: 0 };
        let mut clicks = vec![];
        let mut decodes = vec![];
        for ix in 0..30 {
            let (ms, decode_ms) =
                round_trip(&spike, &mut after, vec![click(Phase::Down), click(Phase::Up)], if ix % 2 == 0 { 'b' } else { 'r' });
            clicks.push(ms);
            decodes.push(decode_ms);
            std::thread::sleep(Duration::from_millis(50));
        }
        // Key latency: click into the field, then type; each key flips the flag between green and red.
        let field = |phase| BrowserInput::Mouse { phase, x: 0.2, y: 0.17, button: Button::Left, click_count: 1, modifiers: 0 };
        for event in [field(Phase::Down), field(Phase::Up)] {
            block_on(spike.input("spike", 0, 0, event), Duration::from_secs(1)).unwrap();
        }
        std::thread::sleep(Duration::from_millis(200));
        let mut typed = vec![];
        for (ix, letter) in "hello gpui".chars().enumerate() {
            let name: &'static str = if letter == ' ' { "space" } else { String::leak(letter.to_string()) };
            let mut stroke = Keystroke::parse(name).unwrap();
            stroke.key_char = Some(letter.to_string());
            let down = keys::key_event(&stroke, true).unwrap();
            let up = keys::key_event(&stroke, false).unwrap();
            // keydown counts were reset by nothing: k starts at 0, odd counts are green.
            let (ms, _) = round_trip(&spike, &mut after, vec![down, up], if ix % 2 == 0 { 'g' } else { 'r' });
            typed.push(ms);
        }
        let value = spike.evaluate("document.getElementById('field').value").unwrap();
        let clicks_seen = spike.evaluate("document.getElementById('clicks').textContent").unwrap();
        save(&next_frame_or_latest(&spike, after), &format!("typed-{scale}x"));
        // Scrolling: a wheel event every 8 ms (a trackpad's rate) for two seconds.
        let (scroll_fps, scroll_decode, scroll_browser, scroll_own) =
            rate(&spike, &mut after, Duration::from_secs(2), Duration::from_millis(8), |spike| {
                let wheel = BrowserInput::Wheel { x: 0.5, y: 0.5, delta_x: 0.0, delta_y: 12.0, modifiers: 0 };
                let _ = block_on(spike.input("spike", 0, 0, wheel), Duration::from_secs(1));
            });
        let scrolled = spike.evaluate("scrollY").unwrap();
        save(&next_frame_or_latest(&spike, after), &format!("scrolled-{scale}x"));
        // Idle: nothing changes, so the screencast should send nothing.
        let (idle_fps, _, idle_browser, _) = rate(&spike, &mut after, Duration::from_secs(2), Duration::from_secs(10), |_| {});
        drop(spike);
        // Animation: a canvas redrawn every display frame.
        let (spike, mut after) = open(test_page(true), scale);
        let (anim_fps, anim_decode, anim_browser, anim_own) =
            rate(&spike, &mut after, Duration::from_secs(3), Duration::from_secs(10), |_| {});
        save(&next_frame_or_latest(&spike, after), &format!("animation-{scale}x"));
        drop(spike);

        eprintln!("page state: field={value} clicks={clicks_seen} scrollY={scrolled}");
        eprintln!(
            "click→frame  p50 {:.1} ms  p90 {:.1} ms  max {:.1} ms  (decode {:.1} ms)",
            percentile(&clicks, 0.5),
            percentile(&clicks, 0.9),
            percentile(&clicks, 1.0),
            percentile(&decodes, 0.5)
        );
        eprintln!(
            "key→frame    p50 {:.1} ms  p90 {:.1} ms  max {:.1} ms",
            percentile(&typed, 0.5),
            percentile(&typed, 0.9),
            percentile(&typed, 1.0)
        );
        eprintln!(
            "scroll       {scroll_fps:.1} fps, decode {scroll_decode:.1} ms, Chrome {scroll_browser:.0}% CPU, viewer {scroll_own:.0}% CPU"
        );
        eprintln!("animation    {anim_fps:.1} fps, decode {anim_decode:.1} ms, Chrome {anim_browser:.0}% CPU, viewer {anim_own:.0}% CPU");
        eprintln!("idle         {idle_fps:.1} fps, Chrome {idle_browser:.0}% CPU");
        assert_eq!(value.as_str(), Some("hello gpui"), "typing reached the field");
    }
}

fn next_frame_or_latest(spike: &CdpSpike, after: u64) -> BrowserFrame {
    block_on(spike.frame("spike", after.saturating_sub(1)), Duration::from_secs(2)).unwrap().unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The view over a fake bridge: what the GPUI side sends, with no browser.

mod view {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Instant;

    use gpui::{Modifiers, ScrollDelta, ScrollEvent, TestAppContext, TouchPhase, point, px};

    use super::super::BrowserView;
    use super::super::bridge::{
        BridgeFuture, BrowserBridge, BrowserFrame, BrowserInput, BrowserOpen, BrowserStatus, BrowserTarget, Button, Phase,
    };
    use crate::testing;

    /// Answers one 400 × 300 frame, then nothing; records every input.
    struct Fake {
        inputs: Rc<RefCell<Vec<BrowserInput>>>,
        jpeg: Vec<u8>,
    }

    impl BrowserBridge for Fake {
        fn open(&self, _: &str, target: &str) -> BridgeFuture<BrowserOpen> {
            let target = BrowserTarget { id: "fake:1".into(), title: String::new(), url: target.into(), browser: "Fake".into() };
            Box::pin(async move { Ok(BrowserOpen { viewer: "v1".into(), target }) })
        }
        fn frame(&self, _: &str, after: u64) -> BridgeFuture<Option<BrowserFrame>> {
            if after > 0 {
                return Box::pin(std::future::pending());
            }
            let frame =
                BrowserFrame { sequence: 1, jpeg: self.jpeg.clone(), viewport: (400, 300), generation: 0, received: Instant::now() };
            Box::pin(async move { Ok(Some(frame)) })
        }
        fn status(&self, _: &str) -> BridgeFuture<BrowserStatus> {
            Box::pin(async { Ok(BrowserStatus { ready: true, url: "https://example.test/".into(), ..Default::default() }) })
        }
        fn input(&self, _: &str, _: u64, _: u64, event: BrowserInput) -> BridgeFuture<bool> {
            self.inputs.borrow_mut().push(event);
            Box::pin(async { Ok(true) })
        }
        fn close(&self, _: &str) -> BridgeFuture<()> {
            Box::pin(async { Ok(()) })
        }
    }

    fn jpeg() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(400, 300, image::Rgb([200, 210, 220])).write_to(&mut bytes, image::ImageFormat::Jpeg).unwrap();
        bytes.into_inner()
    }

    #[gpui::test]
    fn clicks_wheel_and_keys_reach_the_page_as_fractions_of_the_picture(cx: &mut TestAppContext) {
        let inputs = Rc::new(RefCell::new(vec![]));
        let bridge = Rc::new(Fake { inputs: inputs.clone(), jpeg: jpeg() });
        let (view, cx) = testing::mount_in_root(cx, move |_, cx| {
            let mut view = BrowserView::with_bridge(bridge, "https://example.test/".into(), cx);
            view.ensure_started(cx);
            view
        });
        cx.run_until_parked();
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        assert!(view.read_with(cx, |view, _| view.picture.is_some()), "the frame is on screen");
        let stage = testing::bounds(cx, "browser-stage");
        // The page was asked to lay out at the stage's size, at the window's scale.
        let viewport = inputs.borrow().iter().find_map(|input| match input {
            BrowserInput::Viewport { width, height, .. } => Some((*width, *height)),
            _ => None,
        });
        assert_eq!(viewport, Some((f32::from(stage.size.width).round() as u32, f32::from(stage.size.height).round() as u32)));
        inputs.borrow_mut().clear();

        // The picture is 400 × 300 at the stage's top left (smaller than the stage, so unscaled).
        let target = stage.origin + point(px(100.0), px(75.0));
        cx.simulate_click(target, Modifiers::none());
        let clicks: Vec<_> = inputs
            .borrow()
            .iter()
            .filter(|input| matches!(input, BrowserInput::Mouse { phase: Phase::Down | Phase::Up, .. }))
            .cloned()
            .collect();
        assert_eq!(
            clicks,
            vec![
                BrowserInput::Mouse { phase: Phase::Down, x: 0.25, y: 0.25, button: Button::Left, click_count: 1, modifiers: 0 },
                BrowserInput::Mouse { phase: Phase::Up, x: 0.25, y: 0.25, button: Button::Left, click_count: 1, modifiers: 0 },
            ]
        );
        inputs.borrow_mut().clear();

        cx.simulate_event(ScrollEvent {
            position: target,
            delta: ScrollDelta::Pixels(point(px(0.0), px(-30.0))),
            modifiers: Modifiers::none(),
            touch_phase: TouchPhase::Moved,
            source: Default::default(),
        });
        assert_eq!(inputs.borrow().as_slice(), [BrowserInput::Wheel { x: 0.25, y: 0.25, delta_x: 0.0, delta_y: 30.0, modifiers: 0 }]);
        inputs.borrow_mut().clear();

        // The click focused the stage, so keys go to the page.
        cx.simulate_keystrokes("h enter");
        let downs: Vec<String> = inputs
            .borrow()
            .iter()
            .filter_map(|input| match input {
                BrowserInput::Key { down: true, key, .. } => Some(key.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(downs, ["h", "Enter"]);
    }
}
