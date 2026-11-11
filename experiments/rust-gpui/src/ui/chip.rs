//! [`Chip`] (DESIGN.md "Chips and badges", the desktop's `primitives/Chip.tsx`): 28px, fully round, 12
//! medium, 10px side inset.
//!
//! - `Trigger` (composer chips: Run on, Isolation, model, permission): transparent `ink-2`; `hover` fill and
//!   ink on hover; `hover-2` and ink while open.
//! - `Field`: a trigger on the `field` fill.
//! - `Filter`: one of a radio group's choices: surface with `shadow-btn`, or checked, an ink fill with an
//!   on-ink semibold label.
//! - `Static`: a `field` tag that does nothing.
//!
//! Children follow the label (`.child(...)`), so a chip can lead with a dot or a logo.

use gpui::{AnyElement, App, Div, ElementId, FontWeight, IntoElement, ParentElement, RenderOnce, Window, div, prelude::*, px};

use super::focus::{focus_ring, item_focus};
use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_SM, TEXT_12, TextStepExt};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChipVariant {
    #[default]
    Trigger,
    Field,
    Filter,
    Static,
}

#[derive(IntoElement)]
pub struct Chip {
    id: ElementId,
    variant: ChipVariant,
    /// Open (a trigger) or checked (a filter).
    on: bool,
    chevron: bool,
    children: Vec<AnyElement>,
}

impl Chip {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self { id: id.into(), variant: ChipVariant::default(), on: false, chevron: false, children: Vec::new() }
    }

    pub fn variant(mut self, variant: ChipVariant) -> Self {
        self.variant = variant;
        self
    }

    /// A trigger's menu is open, or a filter is the checked choice.
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    /// Ends with the 12px `ink-3` chevron a trigger that opens a menu shows.
    pub fn chevron(mut self) -> Self {
        self.chevron = true;
        self
    }
}

impl ParentElement for Chip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Chip {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = item_focus(&self.id, window, cx);
        let selector = self.id.to_string();
        let base: gpui::Stateful<Div> = div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .when(self.variant != ChipVariant::Static, |el| el.track_focus(&handle))
            .relative()
            .flex()
            .flex_none()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .h(CONTROL_SM)
            .pl(px(10.0))
            .pr(px(if self.chevron { 8.0 } else { 10.0 }))
            .rounded_full()
            .text_step(TEXT_12)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap();
        let (hover, ink, hover2) = (theme.hover, theme.ink, theme.hover2);
        let styled = match (self.variant, self.on) {
            (ChipVariant::Trigger, false) => {
                base.text_color(theme.ink2).cursor_pointer().hover(move |style| style.bg(hover).text_color(ink))
            }
            (ChipVariant::Trigger, true) | (ChipVariant::Field, true) => base.bg(hover2).text_color(ink).cursor_pointer(),
            (ChipVariant::Field, false) => {
                base.bg(theme.field).text_color(theme.ink2).cursor_pointer().hover(move |style| style.text_color(ink))
            }
            (ChipVariant::Filter, false) => base
                .bg(theme.surface)
                .shadow(theme.shadow_btn())
                .text_color(theme.ink2)
                .cursor_pointer()
                .hover(move |style| style.text_color(ink)),
            (ChipVariant::Filter, true) => base.bg(theme.ink).text_color(theme.on_ink).font_weight(FontWeight::SEMIBOLD).cursor_pointer(),
            (ChipVariant::Static, _) => base.bg(theme.field).text_color(theme.ink2),
        };
        styled
            .children(self.children)
            .when(self.chevron, |el| el.child(Icon::new(IconName::ArrowDown01).size(IconSize::S12).color(theme.ink3)))
            .child(focus_ring(&handle, CONTROL_SM / 2.0))
    }
}
