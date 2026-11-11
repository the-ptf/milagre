//! The running row: the turn's timer and its breathing mark, under the transcript's last item.
//!
//! It is a view of its own, mounted by `ChatView` as a cached view at a fixed size and kept **outside the
//! transcript's list**. An animation asks for a frame every vsync and re-renders the view that draws it
//! and that view's ancestors. Inside the list it re-rendered the transcript, and the list rebuilt every
//! visible item each frame (13 per frame in the spike's measurement). Here a frame re-renders this row and
//! the views above it (`ChatView`, `Workspace`), whose other children are cached and reused.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Animation, AnimationExt as _, Context, SharedString, Window, div, prelude::*, px};

use crate::theme::{ActiveTheme, CONTROL_XS, TEXT_12, TextStepExt};

pub struct RunningRow {
    elapsed: SharedString,
    renders: Rc<Cell<usize>>,
}

impl RunningRow {
    pub fn new(elapsed: impl Into<SharedString>) -> Self {
        Self { elapsed: elapsed.into(), renders: Rc::new(Cell::new(0)) }
    }

    /// How many times this row has rendered (each animation frame is one).
    pub fn renders(&self) -> usize {
        self.renders.get()
    }
}

impl Render for RunningRow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.set(self.renders.get() + 1);
        let theme = cx.theme();
        let mark = div().flex_none().size(px(10.0)).rounded_full().border_2().border_color(theme.ink3);
        let mark = if crate::ui::motion() {
            mark.with_animation(
                "running-mark",
                Animation::new(Duration::from_millis(1600)).repeat().with_easing(gpui::pulsating_between(0.35, 1.0)),
                |mark, delta| mark.opacity(delta),
            )
            .into_any_element()
        } else {
            mark.into_any_element()
        };
        div()
            .debug_selector(|| "running-row".into())
            .flex()
            .items_center()
            .gap_2()
            .h(CONTROL_XS)
            .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).child(mark))
            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(self.elapsed.clone()))
    }
}
