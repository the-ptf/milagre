//! One clock for every looping animation in the window: the sidebar's and the pills' spinners, the running mark and
//! the running steps' title shimmer.
//!
//! GPUI's `with_animation` asks for a frame every vsync (60 to 120 a second), and any view it notifies re-renders
//! with the views above it, so the whole window was laid out, prepainted and painted every vsync while anything
//! turned: a running turn kept the main thread at 75% (Victor's sample: taffy layout and Div prepaint/paint of the
//! whole window). The desktop's motion here is coarse anyway: the running mark's CSS samples its keyframes every 80 ms
//! (`step-end`), the ring turns in 24 steps. So these animations take their phase from this clock instead
//! ([`phase`]), and a view that animates [`observe`]s it: one tick every [`FRAME`], all users notified in the same
//! effect cycle, so one frame draws them all. Nothing runs while no view observes it: an idle window draws nothing.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext as _, Context, Entity, Global, Subscription, Task};

/// The tick: the running mark's keyframe step (`running-logo-*`, sampled every 80 ms).
pub const FRAME: Duration = Duration::from_millis(80);

/// The clock's entity: observing it is being told of each tick.
pub struct FrameClock {
    origin: Instant,
    users: Rc<Cell<usize>>,
    task: Option<Task<()>>,
}

struct Shared(Entity<FrameClock>);
impl Global for Shared {}

fn clock(cx: &mut App) -> Entity<FrameClock> {
    if let Some(shared) = cx.try_global::<Shared>() {
        return shared.0.clone();
    }
    let origin = cx.background_executor().now();
    let entity = cx.new(|_| FrameClock { origin, users: Rc::new(Cell::new(0)), task: None });
    cx.set_global(Shared(entity.clone()));
    entity
}

/// How long the clock has run: what [`phase`] reads (the executor's clock, so tests can move it).
pub fn elapsed(cx: &App) -> Duration {
    let now = cx.background_executor().now();
    cx.try_global::<Shared>().map_or(Duration::ZERO, |shared| now.saturating_duration_since(shared.0.read(cx).origin))
}

/// Where a loop of `period` is now, in `0.0..1.0`, on the shared clock.
pub fn phase(period: Duration, cx: &App) -> f32 {
    let period = period.as_secs_f64().max(f64::EPSILON);
    (elapsed(cx).as_secs_f64() / period).fract() as f32
}

/// A view's hold on the clock: ticks reach it while this lives.
pub struct ClockUse {
    users: Rc<Cell<usize>>,
    _subscription: Subscription,
}

impl Drop for ClockUse {
    fn drop(&mut self) {
        self.users.set(self.users.get().saturating_sub(1));
    }
}

/// Calls `on_tick` on the view each tick until the returned hold is dropped. `on_tick` notifies only when what it draws
/// changed (a keyframe step, a ring step), so a tick with nothing new draws nothing.
pub fn observe<V: 'static>(cx: &mut Context<V>, mut on_tick: impl FnMut(&mut V, &mut Context<V>) + 'static) -> ClockUse {
    let entity = clock(cx);
    let users = entity.read(cx).users.clone();
    users.set(users.get() + 1);
    let subscription = cx.observe(&entity, move |view, _, cx| on_tick(view, cx));
    entity.update(cx, |clock, cx| {
        if clock.task.is_none() {
            clock.task = Some(cx.spawn(async move |clock, cx| {
                loop {
                    cx.background_executor().timer(FRAME).await;
                    let going = clock
                        .update(cx, |clock, cx| {
                            if clock.users.get() == 0 {
                                clock.task = None;
                                return false;
                            }
                            cx.notify();
                            true
                        })
                        .unwrap_or(false);
                    if !going {
                        break;
                    }
                }
            }));
        }
    });
    ClockUse { users, _subscription: subscription }
}

/// Whether the clock is ticking (some view observes it), for tests.
pub fn ticking(cx: &App) -> bool {
    cx.try_global::<Shared>().is_some_and(|shared| shared.0.read(cx).task.is_some())
}
