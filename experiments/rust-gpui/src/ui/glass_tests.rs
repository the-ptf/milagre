//! [`Glass`]: the renderer's marker, the layer taking no layout room, and a frame-time probe (ignored by default).

use gpui::{Bounds, Hsla, Pixels, Quad, TestAppContext, div, prelude::*, px};

use super::Glass;
use crate::testing::{bounds, mount_element};
use crate::theme::Theme;

#[test]
fn the_marker_carries_its_sigma_through_element_opacity() {
    let mut quad = Quad::default();
    assert_eq!(gpui_apple::backdrop_blur_sigma(&quad), None, "an ordinary quad is not glass");
    quad.border_color = gpui_apple::backdrop_blur_marker(48.0);
    let sigma = gpui_apple::backdrop_blur_sigma(&quad).expect("marked");
    assert!((sigma - 48.0).abs() < 0.01);
    // `Window::paint_quad` scales the border alpha by the element's opacity; zero stays zero, so the mark survives.
    quad.border_color = gpui_apple::backdrop_blur_marker(48.0).opacity(0.4);
    assert!(gpui_apple::backdrop_blur_sigma(&quad).is_some());
    // Grain rides along in the marker, signed (white specks positive, black negative), and leaves the sigma alone.
    for grain in [0.0_f32, 0.06, -0.06, 1.0, -1.0] {
        quad.border_color = gpui_apple::backdrop_blur_marker_grained(48.0, grain).opacity(0.4);
        let sigma = gpui_apple::backdrop_blur_sigma(&quad).expect("marked");
        assert!((sigma - 48.0).abs() < 0.01);
        assert!((gpui_apple::backdrop_blur_grain(&quad) - grain).abs() < 1e-5, "grain {grain}");
    }
    // A real transparent border (a background quad's) is not taken for one.
    quad.border_color = Hsla::transparent_black();
    assert_eq!(gpui_apple::backdrop_blur_sigma(&quad), None);
}

#[gpui::test]
fn the_glass_layer_takes_no_room(cx: &mut TestAppContext) {
    let theme = Theme::dark();
    let (_, cx) = mount_element(cx, move |_, _| {
        div().w(px(300.0)).child(
            div()
                .debug_selector(|| "glassy".into())
                .relative()
                .p(px(10.0))
                .child(Glass::surface(&theme, 0.62).radius(px(14.0)))
                .child(div().debug_selector(|| "content".into()).w(px(100.0)).h(px(20.0))),
        )
    });
    let outer: Bounds<Pixels> = bounds(cx, "glassy");
    let content = bounds(cx, "content");
    assert_eq!(outer.size.height, px(40.0), "only the content and padding size the box");
    assert_eq!(content.origin.y - outer.origin.y, px(10.0), "the glass does not push the content");
}

/// Frame time of the whole window in the headless Metal renderer, typing into the composer and wheel-scrolling the
/// transcript behind it. Prints the numbers. Run it in release, with the blur on and then off (tint only):
/// `cargo test --release glass_frame_time -- --ignored --nocapture`, then again with `MILAGRE_GPUI_GLASS=0`.
#[test]
#[ignore = "needs a Metal device; a measurement, not a check"]
fn glass_frame_time() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use gpui::{Keystroke, Modifiers, PlatformInput, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase, point};

    use crate::snapshot::headless::{context, pump};

    const STEPS: usize = 60;
    let stats = |label: &str, samples: &mut Vec<Duration>| {
        samples.sort();
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let mean = samples.iter().map(|d| ms(*d)).sum::<f64>() / samples.len() as f64;
        println!(
            "{label:<34} mean {mean:6.2} ms  p50 {:6.2}  p95 {:6.2}  max {:6.2}",
            ms(samples[samples.len() / 2]),
            ms(samples[samples.len() * 95 / 100]),
            ms(*samples.last().expect("samples"))
        );
    };
    {
        let blur = super::glass::blur_enabled();
        let mut cx = context(Arc::new(crate::assets::Assets));
        cx.update(crate::app::init);
        let window = cx.update(crate::app::open_main_window);
        pump(&mut cx, 30);
        // Warm the renderer (pipelines, kernels, scratch textures).
        for _ in 0..3 {
            cx.capture_screenshot(window.into()).expect("a frame");
        }
        let (mut type_cpu, mut type_gpu, mut scroll_cpu, mut scroll_gpu) = (vec![], vec![], vec![], vec![]);
        for step in 0..STEPS * 2 {
            let typing = step < STEPS;
            let start = Instant::now();
            cx.update_window(window.into(), |_, window, cx| {
                if typing {
                    window.dispatch_keystroke(Keystroke::parse("a").expect("a key"), cx);
                } else {
                    window.dispatch_event(
                        PlatformInput::Scroll(ScrollEvent {
                            position: point(px(760.0), px(500.0)),
                            delta: ScrollDelta::Pixels(point(px(0.0), px(if step % 2 == 0 { -40.0 } else { 40.0 }))),
                            modifiers: Modifiers::none(),
                            touch_phase: TouchPhase::Moved,
                            source: ScrollSource::Pointer,
                        }),
                        cx,
                    );
                }
                window.simulate_next_frame(cx);
            })
            .expect("window");
            cx.run_until_parked();
            let cpu = start.elapsed();
            // Encode, run on the GPU and wait (plus a constant 2880x1800 readback).
            let start = Instant::now();
            cx.capture_screenshot(window.into()).expect("a frame");
            let gpu = start.elapsed();
            if typing {
                type_cpu.push(cpu);
                type_gpu.push(gpu);
            } else {
                scroll_cpu.push(cpu);
                scroll_gpu.push(gpu);
            }
        }
        let mode = if blur { "glass (blur)" } else { "tint only" };
        stats(&format!("{mode}: typing, update+layout+paint"), &mut type_cpu);
        stats(&format!("{mode}: typing, render+readback"), &mut type_gpu);
        stats(&format!("{mode}: scroll, update+layout+paint"), &mut scroll_cpu);
        stats(&format!("{mode}: scroll, render+readback"), &mut scroll_gpu);
        cx.update(|cx| cx.quit());
    }
}

/// The composer's glass over transcript text, for checking the blur for banding: scrolls the transcript up so text
/// passes behind the composer, then writes the frame to `MILAGRE_GPUI_BAND_PNG` (theme from `MILAGRE_GPUI_THEME`).
/// `MILAGRE_GPUI_BAND_PNG=/tmp/band.png cargo test --release glass_band_snapshot -- --ignored`.
#[test]
#[ignore = "needs a Metal device; writes a PNG for inspection"]
fn glass_band_snapshot() {
    use std::sync::Arc;

    use gpui::{Modifiers, PlatformInput, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase, point};

    use crate::snapshot::headless::{context, pump, save_png};

    let path = std::env::var("MILAGRE_GPUI_BAND_PNG").unwrap_or_else(|_| "/tmp/gpui-band.png".into());
    let scroll: f32 = std::env::var("MILAGRE_GPUI_BAND_SCROLL").ok().and_then(|v| v.parse().ok()).unwrap_or(150.0);
    let mut cx = context(Arc::new(crate::assets::Assets));
    cx.update(crate::app::init);
    for _ in 0..100 {
        if cx.update(crate::ui::preload_logos) {
            break;
        }
        cx.advance_clock(std::time::Duration::from_millis(20));
        cx.run_until_parked();
    }
    let window = cx.update(crate::app::open_main_window);
    pump(&mut cx, 30);
    cx.update_window(window.into(), |_, window, cx| {
        window.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(px(700.0), px(400.0)),
                delta: ScrollDelta::Pixels(point(px(0.0), px(scroll))),
                modifiers: Modifiers::none(),
                touch_phase: TouchPhase::Moved,
                source: ScrollSource::Pointer,
            }),
            cx,
        );
    })
    .expect("window");
    pump(&mut cx, 30);
    save_png(&mut cx, window.into(), std::path::Path::new(&path)).expect("png");
    cx.update(|cx| cx.quit());
}
