//! [`Segmented`] (DESIGN.md "Decided calls": Files / Commits and PR Summary / Files are segmented controls; the
//! desktop's `primitives/Segmented.tsx`): one picked option raised on a `field` track.
//!
//! The track is `field` with `rounded-control` and 2px padding; the picked segment is `surface` with `shadow-btn`
//! and an ink label (in dark, where `surface` is darker than the track, the track mixed 14% toward ink, about 1.3:1
//! against it, as the desktop does), the rest `ink-2`, ink on hover. 28px tall with 24px segments (`.large()`: 32 and
//! 28). One Tab stop; the arrow keys, Home and End move the choice (`focus::roving_keys`); the accent focus ring
//! shows on keyboard focus. A segment may have a 14px icon, a count and a 6px status dot. Our own for the same
//! reason as [`RadioGroup`](super::RadioGroup).

use std::rc::Rc;

use gpui::{App, ElementId, FocusHandle, FontWeight, IntoElement, RenderOnce, Rgba, SharedString, Window, div, prelude::*, px};

use super::focus::{RovingAxis, focus_ring, item_focus, roving_keys};
use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, Appearance, RADIUS_CHIP, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};

type Change = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// The status dot before a segment's label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentDot {
    Orange,
    Accent,
    Green,
    Red,
}

#[derive(Clone)]
pub struct SegmentedOption {
    value: SharedString,
    label: SharedString,
    icon: Option<IconName>,
    count: Option<u32>,
    dot: Option<SegmentDot>,
    icon_only: bool,
    disabled: bool,
}

impl SegmentedOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self { value: value.into(), label: label.into(), icon: None, count: None, dot: None, icon_only: false, disabled: false }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Only the icon shows; the label is its name.
    pub fn icon_only(mut self) -> Self {
        self.icon_only = true;
        self
    }

    pub fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }

    pub fn dot(mut self, dot: SegmentDot) -> Self {
        self.dot = Some(dot);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// `a` moved `t` of the way to `b`.
fn mix(a: Rgba, b: Rgba, t: f32) -> Rgba {
    Rgba { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a }
}

/// The picked segment's fill: `surface`, or in dark the track mixed 14% toward ink.
pub fn picked_fill(theme: &Theme) -> Rgba {
    match theme.appearance {
        Appearance::Light => theme.surface,
        Appearance::Dark => mix(theme.field, theme.ink, 0.14),
    }
}

#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    value: Option<SharedString>,
    options: Vec<SegmentedOption>,
    large: bool,
    on_change: Option<Change>,
}

impl Segmented {
    pub fn new(id: impl Into<ElementId>, value: Option<&str>, options: impl IntoIterator<Item = SegmentedOption>) -> Self {
        Self {
            id: id.into(),
            value: value.map(|value| SharedString::from(value.to_string())),
            options: options.into_iter().collect(),
            large: false,
            on_change: None,
        }
    }

    /// A 32px track with 28px segments and 13px text.
    pub fn large(mut self) -> Self {
        self.large = true;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let enabled: Vec<usize> = (0..self.options.len()).filter(|&ix| !self.options[ix].disabled).collect();
        let handles: Vec<FocusHandle> =
            self.options.iter().map(|option| item_focus(&ElementId::from((self.id.clone(), option.value.clone())), window, cx)).collect();
        let stop =
            enabled.iter().copied().find(|&ix| Some(&self.options[ix].value) == self.value.as_ref()).or_else(|| enabled.first().copied());
        let keys = {
            let (options, change) = (self.options.clone(), self.on_change.clone());
            roving_keys(
                enabled.iter().map(|&ix| handles[ix].clone()).collect(),
                enabled.clone(),
                RovingAxis::Both,
                move |ix, window, cx| {
                    if let Some(change) = &change {
                        change(&options[ix].value, window, cx);
                    }
                },
            )
        };
        let large = self.large;
        let selector = self.id.to_string();
        let picked = picked_fill(&theme);
        div()
            .id(self.id.clone())
            .debug_selector(move || selector.clone())
            .flex()
            .gap(px(2.0))
            .p(px(2.0))
            .rounded(RADIUS_CONTROL)
            .bg(theme.field)
            .on_key_down(keys)
            .children(self.options.iter().enumerate().map(|(ix, option)| {
                let on = Some(&option.value) == self.value.as_ref();
                let handle = handles[ix].clone().tab_stop(stop == Some(ix));
                let item_id = ElementId::from((self.id.clone(), option.value.clone()));
                let selector = item_id.to_string();
                let (value, change) = (option.value.clone(), self.on_change.clone());
                let usable = !option.disabled;
                let dot = option.dot.map(|dot| match dot {
                    SegmentDot::Orange => theme.orange,
                    SegmentDot::Accent => theme.accent,
                    SegmentDot::Green => theme.green,
                    SegmentDot::Red => theme.red,
                });
                let (ink, hover_ink) = (if on { theme.ink } else { theme.ink2 }, theme.ink);
                div()
                    .id(item_id)
                    .debug_selector(move || selector.clone())
                    .track_focus(&handle)
                    .relative()
                    .flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .h(px(if large { 28.0 } else { 24.0 }))
                    .px(px(if option.icon_only {
                        6.0
                    } else if large {
                        12.0
                    } else {
                        10.0
                    }))
                    .rounded(RADIUS_CHIP)
                    .text_step(if large { TEXT_13 } else { TEXT_12 })
                    .font_weight(FontWeight::MEDIUM)
                    .whitespace_nowrap()
                    .text_color(ink)
                    .when(on, |el| el.bg(picked).shadow(theme.shadow_btn()))
                    .when(!on && usable, |el| el.hover(move |style| style.text_color(hover_ink)))
                    .when(!usable, |el| el.opacity(0.4))
                    .when(usable, |el| {
                        el.cursor_pointer().on_click(move |_, window, cx| {
                            if let Some(change) = &change {
                                change(&value, window, cx);
                            }
                        })
                    })
                    .when_some(dot, |el, color| el.child(div().flex_none().size(px(6.0)).rounded_full().bg(color)))
                    .when_some(option.icon, |el, icon| el.child(Icon::new(icon).size(IconSize::S14).color(ink)))
                    .when(!option.icon_only, |el| el.child(option.label.clone()))
                    .when_some(option.count, |el, count| {
                        el.child(div().text_color(if on { theme.ink2 } else { theme.ink3 }).child(count.to_string()))
                    })
                    .child(focus_ring(&handle, RADIUS_CHIP))
            }))
    }
}
