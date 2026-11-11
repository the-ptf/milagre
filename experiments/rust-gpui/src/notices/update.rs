//! The update pill and its card (O-16; `UpdateNotice.tsx`, `motion/morph.ts`).
//!
//! One surface is either a pill (the title, a dot while an update waits) or the 360px card (title, Dismiss,
//! description, download progress, error, What's new and Install & restart). A downloaded update, or a failed one that
//! names a version, opens its card once per version; Escape or a click on the pill toggles back to the pill; Dismiss
//! hides it until the next version. Installing cannot be closed.
//!
//! The swap morphs (`morph.ts`): the surface grows from the pill's measured size to the card's (or back), its corners
//! from round to `RADIUS_WINDOW`, over `--duration-slow` on the enter curve at the Appearance "Motion" speed, while the
//! new face fades in. Each face measures itself as it paints; the surface's size, corners, fill and shadow are drawn
//! by a clip around the face for as long as the morph runs. The frames notify this view alone (it is one of its own),
//! never the Chat column. The pill hangs from the Chat column's bottom left (the desktop's fallback without a Chat's
//! composer to sit above); `NoticesLayer` places it, and the surface grows up and right from that corner.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    App, Context, FocusHandle, Focusable, FontWeight, IntoElement, KeyDownEvent, Pixels, Render, Size, Task, Window, canvas, div,
    prelude::*, px, size,
};

use super::model::{AppUpdate, Presentation, UpdateStatus};
use crate::overlays::dialogs::{Host, release_notes};
use crate::theme::{ActiveTheme, RADIUS_WINDOW, TEXT_12, TEXT_13, TEXT_15, TextStepExt};
use crate::ui::{Button, ButtonVariant, Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError, ProgressBar};

/// The card's width.
pub const CARD_WIDTH: f32 = 360.0;
/// How long a fixture call takes, so "Restarting\u{2026}" is seen.
const STEP: Duration = Duration::from_millis(300);

pub struct UpdateNotice {
    host: Host,
    state: Option<AppUpdate>,
    presentation: Presentation,
    request_error: String,
    pending: bool,
    /// The morph between pill and card while it runs.
    morph: Option<Morph>,
    /// The face's size as last painted (the morph starts from it and grows to the new face's).
    measured: Rc<Cell<Option<Size<Pixels>>>>,
    focus: FocusHandle,
    _task: Option<Task<()>>,
}

impl UpdateNotice {
    pub fn new(host: Host, cx: &mut Context<Self>) -> Self {
        Self {
            host,
            state: None,
            presentation: Presentation::default(),
            request_error: String::new(),
            pending: false,
            morph: None,
            measured: Rc::default(),
            focus: cx.focus_handle(),
            _task: None,
        }
    }

    pub fn state(&self) -> Option<&AppUpdate> {
        self.state.as_ref()
    }

    pub fn presentation(&self) -> &Presentation {
        &self.presentation
    }

    pub fn is_open(&self) -> bool {
        self.state.as_ref().is_some_and(|state| self.presentation.is_open(state))
    }

    pub fn is_visible(&self) -> bool {
        self.state.as_ref().is_some_and(|state| self.presentation.visible(state))
    }

    pub fn request_error(&self) -> &str {
        &self.request_error
    }

    pub fn is_pending(&self) -> bool {
        self.pending
    }

    /// `update:state` (read at start, then pushed): the notice reacts as `UpdateNotice` does.
    pub fn set_state(&mut self, state: Option<AppUpdate>, cx: &mut Context<Self>) {
        if let Some(state) = &state
            && self.presentation.observe(state)
        {
            self.request_error.clear();
        }
        // A state that arrives shows its face at once; only a person's toggle fades.
        self.state = state;
        cx.notify();
    }

    /// `milagre:show-update`: opens the card (from Settings' About or the pill) and takes focus.
    pub fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let was_open = self.is_open();
        self.presentation.open = true;
        self.presentation.dismissed = false;
        if !was_open {
            self.begin_morph();
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Opens the card without taking focus (a snapshot or a test starts from it).
    pub fn open_without_focus(&mut self) {
        self.presentation.open = true;
        self.presentation.dismissed = false;
    }

    /// Back to the pill; not while installing or working.
    pub fn close(&mut self, cx: &mut Context<Self>) {
        let installing = self.state.as_ref().is_some_and(AppUpdate::installing);
        if installing || self.pending || !self.presentation.open {
            return;
        }
        self.presentation.open = false;
        self.begin_morph();
        cx.notify();
    }

    /// Hide until the next version.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        let installing = self.state.as_ref().is_some_and(AppUpdate::installing);
        if installing || self.pending {
            return;
        }
        self.presentation.open = false;
        self.presentation.dismissed = true;
        self.morph = None;
        cx.notify();
    }

    /// What's new: the release notes of this version, as a dialog.
    pub fn open_notes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(version) = self.state.as_ref().map(|state| state.version_str().to_string()).filter(|v| !v.is_empty()) else { return };
        release_notes::open(&version, self.host.clone(), window, cx);
    }

    /// Install & restart (a downloaded update) or Try again (a failed one). The fixture answers at once.
    pub fn act(&mut self, cx: &mut Context<Self>) {
        let Some(state) = self.state.clone() else { return };
        if self.pending || state.installing() {
            return;
        }
        self.pending = true;
        self.request_error.clear();
        cx.notify();
        let ready = state.ready();
        self._task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STEP).await;
            this.update(cx, |this, cx| {
                this.pending = false;
                let mut next = this.state.clone().unwrap_or_else(|| AppUpdate::new(UpdateStatus::Idle));
                next.status = if ready { UpdateStatus::Installing } else { UpdateStatus::Checking };
                next.error = None;
                this.set_state(Some(next), cx);
            })
            .ok();
        }));
    }

    /// Starts the size morph from the face on screen; nothing to morph from before it has painted, or with motion off.
    fn begin_morph(&mut self) {
        let duration = crate::ui::scaled(crate::ui::ease::DURATION_SLOW);
        self.morph = match self.measured.get() {
            Some(from) if !duration.is_zero() => Some(Morph { start: Instant::now(), duration, from, renders: 0 }),
            _ => None,
        };
    }

    /// How many frames the running morph has drawn, for the tests.
    pub fn morph_frames(&self) -> Option<usize> {
        self.morph.as_ref().map(|morph| morph.renders)
    }

    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && self.is_open() && !self.pending {
            self.close(cx);
            cx.stop_propagation();
        }
    }
}

impl Focusable for UpdateNotice {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// A swap between pill and card in progress.
struct Morph {
    start: Instant,
    duration: Duration,
    /// The old face's size.
    from: Size<Pixels>,
    renders: usize,
}

/// A face's corner radius at its size: the pill is round, the card `RADIUS_WINDOW`.
fn corner(open: bool, height: Pixels) -> Pixels {
    if open { RADIUS_WINDOW } else { height / 2.0 }
}

impl Render for UpdateNotice {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(state) = self.state.clone().filter(|state| self.presentation.visible(state)) else {
            return div().into_any_element();
        };
        let theme = *cx.theme();
        let open = self.presentation.is_open(&state);
        let this = cx.entity();
        let surface = div()
            .id("update-notice")
            .debug_selector(|| "update-notice".into())
            .key_context("UpdateNotice")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.on_key(event, cx)))
            .overflow_hidden()
            .text_color(theme.ink)
            // While the morph runs the clip around the face draws the fill, corners and shadow.
            .when(self.morph.is_none(), |surface| surface.bg(theme.surface));
        let face = if open {
            let busy = self.pending || state.installing() || state.downloading() || state.status == UpdateStatus::Checking;
            let error = if self.request_error.is_empty() { state.error.clone().unwrap_or_default() } else { self.request_error.clone() };
            let (dismiss, notes, install) = (this.clone(), this.clone(), this.clone());
            let action = if state.installing() || self.pending {
                "Restarting\u{2026}"
            } else if state.ready() {
                "Install & restart"
            } else {
                "Try again"
            };
            surface
                .w(px(CARD_WIDTH))
                .p(px(20.0))
                .rounded(RADIUS_WINDOW)
                .when(self.morph.is_none(), |card| card.shadow(theme.shadow_raised()))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .child(Icon::new(IconName::Gift).size(IconSize::S18).color(theme.ink2))
                        .child(div().flex_1().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).child(state.title()))
                        .when(!state.installing() && !self.pending, |row| {
                            row.child(
                                div().mr(px(-4.0)).child(
                                    IconButton::new("update-dismiss", IconName::Cancel01)
                                        .size(IconButtonSize::S28)
                                        .on_click(move |_, _, cx| dismiss.update(cx, |this, cx| this.dismiss(cx))),
                                ),
                            )
                        }),
                )
                .child(
                    div()
                        .mt(px(12.0))
                        .text_step(TEXT_13)
                        .text_color(theme.ink2)
                        .child(div().child(state.description()))
                        .when_some(state.restart_note(), |col, note| col.child(div().mt(px(8.0)).child(note))),
                )
                .when(state.downloading(), |card| {
                    card.child(
                        div()
                            .mt(px(16.0))
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(div().flex_1().child(ProgressBar::new(state.percent() as f32 / 100.0).thick()))
                            .child(div().text_step(TEXT_12).text_color(theme.ink2).child(format!("{}%", state.percent()))),
                    )
                })
                .when(!error.is_empty(), |card| card.child(div().mt(px(12.0)).child(InlineError::new(error))))
                .child(
                    div()
                        .mt(px(20.0))
                        .flex()
                        .gap(px(8.0))
                        .when(!state.version_str().is_empty(), |row| {
                            row.child(
                                div().flex_1().child(
                                    Button::new("update-notes", "What\u{2019}s new")
                                        .variant(ButtonVariant::Secondary)
                                        .on_click(move |_, window, cx| notes.update(cx, |this, cx| this.open_notes(window, cx))),
                                ),
                            )
                        })
                        .when(state.ready() || state.failed() || state.installing(), |row| {
                            row.child(
                                div().flex_1().child(
                                    Button::new("update-install", action)
                                        .disabled(busy)
                                        .on_click(move |_, _, cx| install.update(cx, |this, cx| this.act(cx))),
                                ),
                            )
                        }),
                )
                .into_any_element()
        } else {
            let show = this.clone();
            surface
                .flex()
                .items_center()
                .gap(px(8.0))
                .px(px(12.0))
                .py(px(8.0))
                .rounded_full()
                .when(self.morph.is_none(), |pill| pill.shadow(theme.shadow_btn()))
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .whitespace_nowrap()
                .cursor_pointer()
                .hover(|pill| pill.bg(theme.hover))
                .on_click(move |_, window, cx| show.update(cx, |this, cx| this.show(window, cx)))
                .child(Icon::new(IconName::Gift).size(IconSize::S18).color(theme.ink))
                .child(state.pill_text())
                .when(state.ready(), |pill| pill.child(div().size(px(6.0)).rounded_full().bg(theme.ink)))
                .into_any_element()
        };
        // Each face measures itself as it paints: where the next morph starts, and where this one is going.
        let measured = self.measured.clone();
        let measure = canvas(move |bounds, _, _| measured.set(Some(bounds.size)), |_, _, _, _| {}).absolute().size_full();
        let face = div().relative().child(face).child(measure);
        let Some(morph) = self.morph.as_mut() else { return face.into_any_element() };
        morph.renders += 1;
        let t = crate::ui::ease::progress(morph.start.elapsed(), morph.duration, crate::ui::ease::ease_out);
        if t >= 1.0 {
            // Landed: one more frame draws the face with its own fill and shadow.
            self.morph = None;
            window.request_animation_frame();
            return face.into_any_element();
        }
        window.request_animation_frame();
        // The first frame has not measured the new face yet: it holds the old size.
        let to = self.measured.get().unwrap_or(morph.from);
        let lerp = |a: Pixels, b: Pixels| a + (b - a) * t;
        let now = size(lerp(morph.from.width, to.width), lerp(morph.from.height, to.height));
        let radius = lerp(corner(!open, morph.from.height), corner(open, to.height));
        div()
            .debug_selector(|| "update-morph".into())
            .relative()
            .w(now.width)
            .h(now.height)
            .overflow_hidden()
            .rounded(radius)
            .bg(theme.surface)
            .shadow(if open { theme.shadow_raised() } else { theme.shadow_btn() })
            .child(div().absolute().bottom_0().left_0().opacity(t).child(face))
            .into_any_element()
    }
}
