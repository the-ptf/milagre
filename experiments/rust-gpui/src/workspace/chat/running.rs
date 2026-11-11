//! The running row: the Milagre mark running and how long the turn has run, under the transcript's last item.
//!
//! Ported from the desktop's `ThinkingIndicator.tsx` (`RunningLogo`, `useElapsed`) and the `.running-logo*` rules and
//! `@keyframes running-logo-glow` / `running-logo-twinkle` in `app/src/styles.css`: a 16px mark of three paths (the two
//! legs and the sparkle), 2400 ms a cycle. Each leg glows from 15% to 55% ink (the right one 240 ms behind the left),
//! the sparkle holds at 45%, then swells to 1.3x, turns 45 degrees to full ink, settles at 1.12x and turns on to a
//! quarter turn (its four points make the loop seamless). The keyframes are sampled every 80 ms with `step-end`, as
//! the CSS does; the tables below are those keyframes, verbatim. The label is `formatElapsed` ("29s", "1m 02s"),
//! `ink-3`, 12px, tabular, ticking every second from the turn's start.
//!
//! It is a view of its own, mounted by `ChatView` as a cached view at a fixed size and kept **outside the
//! transcript's list**. An animation asks for a frame every vsync and re-renders the view that draws it
//! and that view's ancestors. Inside the list it re-rendered the transcript, and the list rebuilt every
//! visible item each frame (13 per frame in the spike's measurement). Here a frame re-renders this row and
//! the views above it (`ChatView`, `Workspace`), whose other children are cached and reused. The one-second tick
//! only notifies this view, and only when the label changes.
//!
//! Appearance > Motion Off (and the headless tests, see [`crate::ui::motion`]) draw the mark still: legs at 15%,
//! sparkle at 45%, the CSS's dim resting frame.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    Animation, AnimationExt as _, Context, Hsla, SharedString, Task, Transformation, Window, div, percentage, prelude::*, px, size, svg,
};

use crate::logic::marks::display_clock::format_elapsed;
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt};

/// One cycle of the mark (`running-logo-glow` and `-twinkle`: 2400ms, infinite).
const CYCLE: Duration = Duration::from_millis(2400);
/// The right leg starts a tenth of a cycle after the left (`.running-logo-leg-right { animation-delay: 240ms }`).
const RIGHT_LEG_PHASE: f32 = 0.1;
/// How often the tick checks whether the label changed (`useDisplayValue(250, ...)`).
const TICK: Duration = Duration::from_millis(250);
/// The mark's box (`size-4`).
const MARK: f32 = 16.0;
/// The sparkle's SVG is re-centred on the sparkle (its box sits this far above the legs'): `-31 - -4` of 154 units.
const STAR_LIFT: f32 = -2.8;

/// `running-logo-glow`: (keyframe %, opacity) for a leg.
const GLOW: &[(f32, f32)] = &[
    (0.0, 0.15),
    (3.33333, 0.21409),
    (6.66667, 0.38801),
    (10.0, 0.52755),
    (12.0, 0.55),
    (13.33333, 0.55),
    (16.66667, 0.55),
    (20.0, 0.55),
    (22.0, 0.55),
    (23.33333, 0.54572),
    (26.66667, 0.49434),
    (30.0, 0.38801),
    (33.33333, 0.26429),
    (36.66667, 0.17788),
    (40.0, 0.15),
    (43.33333, 0.15),
    (46.66667, 0.15),
    (50.0, 0.15),
    (53.33333, 0.15),
    (56.66667, 0.15),
    (60.0, 0.15),
    (63.33333, 0.15),
    (66.66667, 0.15),
    (70.0, 0.15),
    (73.33333, 0.15),
    (76.66667, 0.15),
    (80.0, 0.15),
    (83.33333, 0.15),
    (86.66667, 0.15),
    (90.0, 0.15),
    (93.33333, 0.15),
    (96.66667, 0.15),
    (100.0, 0.15),
];
/// `running-logo-twinkle`: (keyframe %, opacity, scale, rotate degrees) for the sparkle.
const TWINKLE: &[(f32, f32, f32, f32)] = &[
    (0.0, 0.45, 1.0, 0.0),
    (3.33333, 0.45, 1.0, 0.0),
    (6.66667, 0.45, 1.0, 0.0),
    (10.0, 0.45, 1.0, 0.0),
    (13.33333, 0.45, 1.0, 0.0),
    (16.66667, 0.45, 1.0, 0.0),
    (20.0, 0.45, 1.0, 0.0),
    (23.33333, 0.45, 1.0, 0.0),
    (26.66667, 0.45, 1.0, 0.0),
    (30.0, 0.45, 1.0, 0.0),
    (33.33333, 0.45, 1.0, 0.0),
    (36.66667, 0.45, 1.0, 0.0),
    (40.0, 0.45, 1.0, 0.0),
    (43.33333, 0.45, 1.0, 0.0),
    (46.66667, 0.45, 1.0, 0.0),
    (50.0, 0.45, 1.0, 0.0),
    (53.33333, 0.46504, 1.00821, 1.2309),
    (56.66667, 0.53199, 1.04472, 6.70836),
    (60.0, 0.725, 1.15, 22.5),
    (63.33333, 0.91801, 1.25528, 38.29164),
    (66.66667, 0.98496, 1.29179, 43.7691),
    (70.0, 1.0, 1.3, 45.0),
    (73.33333, 1.0, 1.29042, 46.86329),
    (76.66667, 1.0, 1.23715, 57.22021),
    (80.0, 1.0, 1.14683, 74.78238),
    (83.33333, 1.0, 1.12202, 79.60766),
    (85.0, 1.0, 1.12, 80.0),
    (86.66667, 0.99383, 1.11865, 80.1121),
    (90.0, 0.91801, 1.10211, 81.49075),
    (93.33333, 0.64203, 1.0419, 86.50851),
    (96.66667, 0.47928, 1.00639, 89.46763),
    (100.0, 0.45, 1.0, 90.0),
];
/// The last keyframe at or before `phase` (0..1): `step-end` between keyframes.
fn step<T: Copy>(table: &[(f32, T)], phase: f32) -> T {
    let pct = phase.rem_euclid(1.0) * 100.0;
    table.iter().rev().find(|(at, _)| *at <= pct).map_or(table[0].1, |(_, value)| *value)
}

/// A leg's opacity at `phase` of the cycle.
fn leg_opacity(phase: f32) -> f32 {
    step(GLOW, phase)
}

/// The sparkle's (opacity, scale, rotate degrees) at `phase` of the cycle.
fn star_state(phase: f32) -> (f32, f32, f32) {
    let pct = phase.rem_euclid(1.0) * 100.0;
    let (_, opacity, scale, rotate) = TWINKLE.iter().rev().find(|(at, ..)| *at <= pct).copied().unwrap_or(TWINKLE[0]);
    (opacity, scale, rotate)
}

pub struct RunningRow {
    started: Instant,
    shown: SharedString,
    renders: Rc<Cell<usize>>,
    tick: Option<Task<()>>,
}

impl RunningRow {
    /// A row for a turn that started `ago` ago.
    pub fn new(ago: Duration) -> Self {
        let started = Instant::now().checked_sub(ago).unwrap_or_else(Instant::now);
        Self { started, shown: label(started).into(), renders: Rc::new(Cell::new(0)), tick: None }
    }

    /// How many times this row has rendered (each animation frame is one).
    pub fn renders(&self) -> usize {
        self.renders.get()
    }

    /// The label as drawn ("29s", "1m 02s").
    pub fn elapsed_label(&self) -> &str {
        &self.shown
    }

    fn ensure_tick(&mut self, cx: &mut Context<Self>) {
        if self.tick.is_some() {
            return;
        }
        self.tick = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let alive = this
                    .update(cx, |row, cx| {
                        let now = label(row.started);
                        if now != row.shown.as_ref() {
                            row.shown = now.into();
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        }));
    }
}

fn label(started: Instant) -> String {
    format_elapsed(started.elapsed().as_millis() as f64)
}

/// A path of the mark in `color` at `opacity`, in the 16px box, `lift` px from its top.
fn part(path: &'static str, color: Hsla, opacity: f32, lift: f32) -> gpui::Svg {
    svg().path(path).absolute().top(px(lift)).left(px(0.0)).size(px(MARK)).text_color(color.opacity(opacity))
}

fn running_mark(ink: Hsla, animated: bool) -> impl IntoElement {
    let left = part("ui/running-leg-left.svg", ink, leg_opacity(0.0), 0.0);
    let right = part("ui/running-leg-right.svg", ink, leg_opacity(0.0), 0.0);
    let star = part("ui/running-star.svg", ink, star_state(0.0).0, STAR_LIFT);
    let (left, right, star) = if animated {
        (
            left.with_animation("running-leg-left", Animation::new(CYCLE).repeat(), move |leg, delta| {
                leg.text_color(ink.opacity(leg_opacity(delta)))
            })
            .into_any_element(),
            right
                .with_animation("running-leg-right", Animation::new(CYCLE).repeat(), move |leg, delta| {
                    leg.text_color(ink.opacity(leg_opacity(delta - RIGHT_LEG_PHASE)))
                })
                .into_any_element(),
            star.with_animation("running-star", Animation::new(CYCLE).repeat(), move |star, delta| {
                let (opacity, scale, degrees) = star_state(delta);
                star.text_color(ink.opacity(opacity))
                    .with_transformation(Transformation::rotate(percentage(degrees / 360.0)).with_scaling(size(scale, scale)))
            })
            .into_any_element(),
        )
    } else {
        (left.into_any_element(), right.into_any_element(), star.into_any_element())
    };
    div().relative().flex_none().size(px(MARK)).debug_selector(|| "running-mark".into()).child(left).child(right).child(star)
}

impl Render for RunningRow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.set(self.renders.get() + 1);
        self.ensure_tick(cx);
        // A frame draws the clock too: the label is always the current second's.
        let now = label(self.started);
        if now != self.shown.as_ref() {
            self.shown = now.into();
        }
        let theme = cx.theme();
        let animated = crate::ui::motion_scale() > 0.0;
        div()
            .debug_selector(|| "running-row".into())
            .flex()
            .items_center()
            .gap_2()
            .px_1()
            .py_1()
            .child(running_mark(theme.ink.into(), animated))
            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(self.shown.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;
    use crate::ui::set_test_motion;
    use gpui::{TestAppContext, VisualTestContext};

    fn frame(cx: &mut VisualTestContext) -> usize {
        let asked = cx.update(|window, cx| window.simulate_next_frame(cx));
        cx.run_until_parked();
        asked
    }

    /// Ten animation frames render the running row ten times and rebuild no transcript item.
    #[gpui::test]
    fn the_running_mark_animates_without_rebuilding_the_transcript(cx: &mut TestAppContext) {
        set_test_motion(true);
        let (workspace, cx) = testing::mount_workspace(cx);
        let chat = workspace.read_with(cx, |w, _| w.chat.clone());
        let (transcript, running) = chat.read_with(cx, |c, _| (c.transcript.clone(), c.running.clone().expect("a turn runs")));
        frame(cx);
        assert!(frame(cx) > 0, "the mark asks for frames");
        let before = (transcript.read_with(cx, |t, _| t.item_renders()), running.read_with(cx, |r, _| r.renders()));
        const FRAMES: usize = 10;
        for _ in 0..FRAMES {
            frame(cx);
        }
        let after = (transcript.read_with(cx, |t, _| t.item_renders()), running.read_with(cx, |r, _| r.renders()));
        assert_eq!(after.0, before.0, "no transcript item rebuilt in {FRAMES} frames");
        assert!(after.1 - before.1 >= FRAMES, "the row rendered every frame ({} renders)", after.1 - before.1);
        set_test_motion(false);
    }

    #[test]
    fn the_keyframes_hold_between_samples_and_the_right_leg_trails_the_left() {
        // Legs: dim at the start, lit at 12% (the 55% peak), dim again after the beat.
        assert_eq!(leg_opacity(0.0), 0.15);
        assert_eq!(leg_opacity(0.12), 0.55);
        assert_eq!(leg_opacity(0.99), 0.15);
        // Step-end: a phase between two samples keeps the earlier one.
        assert_eq!(leg_opacity(0.0334), leg_opacity(0.0366));
        // The sparkle holds at 45%, peaks at 1.3x turned 45 degrees at 70%, and ends a quarter turn round.
        assert_eq!(star_state(0.2), (0.45, 1.0, 0.0));
        assert_eq!(star_state(0.70), (1.0, 1.3, 45.0));
        assert_eq!(star_state(0.99).2, 89.46763);
        // A negative phase (the right leg in its first 240 ms) wraps to the end of the cycle.
        assert_eq!(leg_opacity(0.0 - RIGHT_LEG_PHASE), leg_opacity(0.9));
    }

    #[test]
    fn the_label_is_formatted_like_the_desktops() {
        assert_eq!(RunningRow::new(Duration::from_secs(29)).elapsed_label(), "29s");
        assert_eq!(RunningRow::new(Duration::from_secs(62)).elapsed_label(), "1m 02s");
    }
}
