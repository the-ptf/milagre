//! The first Changes click, timed on the main thread: opening the tab, then picking a file, each time first in the
//! process (the cold path: grammars, fonts, icons). Runs in the headless app (the real text system and the window's
//! whole tree, no window on screen):
//!
//! ```sh
//! cargo test --release first_changes_clicks -- --ignored --nocapture
//! ```
//!
//! For each click it prints the time from the click to the end of its first frame (the click's own work and the
//! frame's render, layout and paint), then the frames of the next second of simulated time: each frame's draw, and the
//! main-thread tasks run before it. The headless executor runs background tasks on its one thread too, so they are
//! counted apart (`background`), as work a real window does on another thread.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{AnyWindowHandle, Entity, HeadlessAppContext};

use super::Source;
use super::data::Section;
use crate::snapshot::headless::{FRAME, context, pump};
use crate::workspace::Workspace;
use crate::workspace::panel::PanelTab;

const PANEL: &str = "apps/desktop/app/src/components/changes/ChangesPanel.tsx";

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn draw(cx: &mut HeadlessAppContext, window: AnyWindowHandle) -> Duration {
    let start = Instant::now();
    cx.update_window(window, |_, window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    })
    .ok();
    start.elapsed()
}

/// One click: `act`, its first frame, then a second of frames. Prints and returns (first frame, worst later frame).
fn measure(label: &str, cx: &mut HeadlessAppContext, window: AnyWindowHandle, act: impl FnOnce(&mut HeadlessAppContext)) -> (f64, f64) {
    let start = Instant::now();
    act(cx);
    let first = start.elapsed() + draw(cx, window);
    let mut frames = Vec::new();
    let mut tasks = Duration::ZERO;
    for _ in 0..60 {
        cx.advance_clock(FRAME);
        let t = Instant::now();
        cx.run_until_parked();
        tasks += t.elapsed();
        frames.push(ms(draw(cx, window)));
    }
    let worst = frames.iter().copied().fold(0.0, f64::max);
    let mean = frames.iter().sum::<f64>() / frames.len() as f64;
    eprintln!(
        "{label}: first frame {:.1} ms; next second: mean frame {mean:.2} ms, worst {worst:.2} ms, over 16.7 ms: {}; tasks {:.1} ms",
        ms(first),
        frames.iter().filter(|f| **f > 16.7).count(),
        ms(tasks),
    );
    (ms(first), worst)
}

#[test]
#[ignore = "timing on the real text system; run explicitly with --release"]
fn first_changes_clicks() {
    super::WARM_IN_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut cx = context(Arc::new(crate::assets::Assets));
    cx.update(crate::app::init);
    let root = cx.update(crate::app::open_main_window);
    let window: AnyWindowHandle = root.into();
    pump(&mut cx, 10);
    let workspace: Entity<Workspace> = cx
        .update(|cx| root.read(cx).map(|root| root.view().clone().downcast::<Workspace>().ok()))
        .ok()
        .flatten()
        .expect("the window's root holds the Workspace");
    let panel = cx.update(|cx| workspace.read(cx).panel.clone());
    // The panel open on another tab, settled.
    cx.update(|cx| panel.update(cx, |panel, cx| panel.activate(PanelTab::Details, cx)));
    pump(&mut cx, 30);

    measure("open the Changes tab", &mut cx, window, |cx| {
        cx.update(|cx| panel.update(cx, |panel, cx| panel.activate(PanelTab::Changes, cx)));
    });
    let changes = cx.update(|cx| panel.read(cx).changes().clone());
    measure("pick a file (TSX)", &mut cx, window, |cx| {
        cx.update(|cx| changes.update(cx, |c, cx| c.select_file(Source::Section(Section::Uncommitted), PANEL.to_string(), cx)));
    });
    measure("close the diff", &mut cx, window, |cx| cx.update(|cx| changes.update(cx, |c, cx| c.close_diff(cx))));
    measure("pick it again", &mut cx, window, |cx| {
        cx.update(|cx| changes.update(cx, |c, cx| c.select_file(Source::Section(Section::Uncommitted), PANEL.to_string(), cx)));
    });
}

/// What the first file costs, piece by piece, in a fresh process:
/// `cargo test --release cold_highlight_costs -- --ignored --nocapture`.
#[test]
#[ignore = "timing; run explicitly with --release"]
fn cold_highlight_costs() {
    use crate::logic::diff::parse_patch;
    use crate::workspace::panel::diff::highlight::{HunkHighlighter, syntax_for};
    let changes = super::fixture::worktree();
    let result = changes.patches.get(PANEL).expect("the fixture has the file");
    let t = Instant::now();
    let syntax = syntax_for(PANEL).expect("TSX is highlighted");
    let load = t.elapsed();
    let t = Instant::now();
    let hunks = parse_patch(&result.patch);
    let parse = t.elapsed();
    let t = Instant::now();
    let mut lines = 0;
    for hunk in &hunks {
        let mut highlighter = HunkHighlighter::new(syntax, hunk);
        for ix in 0..hunk.lines.len() {
            let _ = highlighter.runs(hunk, ix);
            lines += 1;
        }
    }
    let first = t.elapsed();
    let t = Instant::now();
    for hunk in &hunks {
        let mut highlighter = HunkHighlighter::new(syntax, hunk);
        for ix in 0..hunk.lines.len() {
            let _ = highlighter.runs(hunk, ix);
        }
    }
    let again = t.elapsed();
    eprintln!(
        "grammars load {:.1} ms; patch parse {:.2} ms; first highlight of {lines} lines {:.1} ms; same lines again {:.2} ms",
        ms(load),
        ms(parse),
        ms(first),
        ms(again)
    );
}
