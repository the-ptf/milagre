//! The side panel and the Terminals drawer opening and closing (`DockSlide.tsx`, `TerminalSlide.tsx`): the panel comes
//! in from the window's right edge, the drawer rises from its bottom edge, each fading in, and goes the same way, over
//! `--duration-slow` (the drawer closes in `--duration-base`) at the Appearance "Motion" speed (Off lands at once).
//!
//! On the desktop the slot's width springs and the Chat reflows every frame. Here a reflow would lay the transcript out
//! again each frame (a cached view whose bounds change renders again), and a panel that moved would rebuild too. So the
//! columns take their new widths at once, the panel stays where it lands, and a [`SlideCover`] (a small view of its
//! own, over the slot) draws the motion: the page colour drawn back towards the edge it comes from, and over the panel
//! a veil that thins as it comes in. Each frame renders the cover alone; the panel, the transcript and the sidebar's rows
//! are reused (`ui::motion_tests`). Closing keeps the panel laid out under the cover until the cover is done.
//!
//! A Chat switch is not an opening: a panel or drawer the next Chat has open lands at once, as on the desktop.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{AnyElement, AnyView, App, Context, Entity, Global, Hsla, StyleRefinement, Window, div, prelude::*, px, relative};

use crate::theme::ActiveTheme;
use crate::ui::ease::{ease_out, progress};

/// Which way a slide runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Opening,
    Closing,
}

/// The edge a slot comes in from: the right (the panel) or the bottom (the Terminals drawer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Right,
    Bottom,
}

/// What a slot lays out this frame.
pub struct Slide {
    /// The cover over the slot, while a slide runs.
    pub cover: Option<AnyElement>,
    /// A closing slot still on screen under its cover: lay it out as open.
    pub held: bool,
}

/// One slot's last state and its slide in progress.
#[derive(Default)]
struct Slot {
    /// The Chat and whether the slot showed the last time it was laid out.
    last: Option<(String, bool)>,
    running: Option<Running>,
}

struct Running {
    cover: Entity<SlideCover>,
    direction: Direction,
    until: Instant,
}

/// Every slot's state, kept between frames (one window), by slot name.
#[derive(Default)]
struct SlideState(HashMap<&'static str, Slot>);

impl Global for SlideState {}

/// How long a slot's slide takes each way, before the Motion speed.
#[derive(Clone, Copy)]
pub struct Timing {
    pub opening: Duration,
    pub closing: Duration,
}

/// Notes whether `slot` shows now for `chat`, starts a slide when the same Chat's slot opened or closed, and says what
/// to lay out. Called every time the Workspace lays the slot out.
pub fn track(slot: &'static str, chat: &str, shown: bool, edge: Edge, timing: Timing, cx: &mut App) -> Slide {
    let now = Instant::now();
    let state = cx.default_global::<SlideState>().0.entry(slot).or_default();
    let previous = state.last.replace((chat.to_string(), shown));
    if state.running.as_ref().is_some_and(|running| now >= running.until) {
        state.running = None;
    }
    let same_chat = previous.as_ref().is_some_and(|(last, _)| last == chat);
    if !same_chat {
        state.running = None;
    }
    let toggled = same_chat && previous.as_ref().is_some_and(|(_, was)| *was != shown);
    if toggled {
        let direction = if shown { Direction::Opening } else { Direction::Closing };
        let duration = crate::ui::scaled(if shown { timing.opening } else { timing.closing });
        let running = (!duration.is_zero()).then(|| Running {
            cover: cx.new(|_| SlideCover::new(direction, edge, now, duration)),
            direction,
            until: now + duration,
        });
        cx.default_global::<SlideState>().0.entry(slot).or_default().running = running;
    }
    match &cx.default_global::<SlideState>().0.entry(slot).or_default().running {
        Some(running) if (running.direction == Direction::Opening) == shown => Slide {
            cover: Some(
                AnyView::from(running.cover.clone())
                    .cached(StyleRefinement::default().absolute().top_0().left_0().size_full())
                    .into_any_element(),
            ),
            held: running.direction == Direction::Closing,
        },
        _ => Slide { cover: None, held: false },
    }
}

/// The page colour over a slot while it slides: solid from the slot's far side to where the panel has come in, then a
/// veil over the panel that thins to nothing.
pub struct SlideCover {
    direction: Direction,
    edge: Edge,
    start: Instant,
    duration: Duration,
    renders: usize,
}

impl SlideCover {
    fn new(direction: Direction, edge: Edge, start: Instant, duration: Duration) -> Self {
        Self { direction, edge, start, duration, renders: 0 }
    }

    /// How far the panel is in, 0 (gone) to 1 (landed).
    fn shown(&self, now: Instant) -> f32 {
        let t = progress(now.saturating_duration_since(self.start), self.duration, ease_out);
        match self.direction {
            Direction::Opening => t,
            Direction::Closing => 1.0 - t,
        }
    }
}

/// How many times a slot's running cover has rendered (each frame of a slide is one), for the tests.
pub fn cover_renders(slot: &str, cx: &App) -> Option<usize> {
    cx.try_global::<SlideState>()?.0.get(slot)?.running.as_ref().map(|running| running.cover.read(cx).renders)
}

impl Render for SlideCover {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let now = Instant::now();
        let shown = self.shown(now);
        // One more frame after the end, so the Workspace lays the slot out without the cover (and a closed slot goes).
        if now < self.start + self.duration + Duration::from_millis(17) {
            window.request_animation_frame();
        }
        let theme = cx.theme();
        let page: Hsla = theme.page.into();
        let (solid, veil) = (div().flex_none().bg(page), div().flex_1().bg(page.opacity(1.0 - shown)));
        let cover = div().relative().size_full().debug_selector(|| "slide-cover".into()).flex();
        match self.edge {
            Edge::Right => cover
                .flex_row()
                .child(solid.h_full().w(relative(1.0 - shown)))
                .child(veil.h_full())
                // The panel's own hairline, at the edge as it comes in.
                .child(div().absolute().top_0().h_full().w(px(1.0)).left(relative(1.0 - shown)).bg(theme.line)),
            Edge::Bottom => cover.flex_col().child(solid.w_full().h(relative(1.0 - shown))).child(veil.w_full()),
        }
    }
}
