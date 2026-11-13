//! [`StatusPill`] (the desktop's `primitives/StatusPill.tsx`): one slot of the composer's chip row (the PR fix, Ports,
//! to-dos, Browser, Simulators, Subagents): 28px, fully round, 12px, an optional 12px icon, a label and a count
//! (`count` or `count/total`, tabular figures), tinted by tone: `ink` (`ink-2` text), or `orange`, `green`, `red` with
//! the `-ink` text shade and a 25% ring of the tone.
//!
//! Frosted glass over the transcript, as the desktop's `.status-pill`: a [`Glass`] layer blurs what is behind it under
//! the `surface` at 68% (the CSS's own mix), with the 1px tone ring just outside; hover lays `hover` over the whole
//! pill, above the glass. The pill hugs its content: [`StatusPill::width`] measures it.
//! `.bare()` is the pill inside a morphing surface: no fill or ring, `hover` on hover. Not built: the rolling digits
//! and the letters rising in when the label changes (motion, WP-10), the slot's grow-in. Our own.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, Hsla, IntoElement, RenderOnce, SharedString, TextRun, Window, div, font,
    prelude::*, px,
};

use super::glass::GLASS_BLUR;
use super::press::Press;
use super::{Glass, Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_SM, TEXT_12, TextStepExt, Theme};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PillTone {
    #[default]
    Ink,
    Orange,
    Green,
    Red,
}

impl PillTone {
    /// The text colour and the ring colour.
    fn colors(self, theme: &Theme) -> (Hsla, Hsla) {
        let tone = |ink: gpui::Rgba, plain: gpui::Rgba| (Hsla::from(ink), Hsla::from(plain).opacity(0.25));
        match self {
            PillTone::Ink => (theme.ink2.into(), theme.line.into()),
            PillTone::Orange => tone(theme.orange_ink, theme.orange),
            PillTone::Green => tone(theme.green_ink, theme.green),
            PillTone::Red => tone(theme.red_ink, theme.red),
        }
    }
}

type PillClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct StatusPill {
    id: ElementId,
    icon: Option<IconName>,
    label: Option<SharedString>,
    count: Option<u32>,
    total: Option<u32>,
    tone: PillTone,
    bare: bool,
    disabled: bool,
    medium: bool,
    tooltip: Option<SharedString>,
    /// Something before the icon and label (a spinner, an icon and a count), and its width, for [`Self::width`].
    leading: Option<(AnyElement, f32)>,
    gap: f32,
    on_click: Option<PillClick>,
}

/// `.status-pill`'s fill: the surface at 68% (`color-mix(... var(--surface) 68%, transparent)`).
const FILL: f32 = 0.68;
/// `px-2.5`: the pill's horizontal padding.
const PAD: f32 = 10.0;

/// The width of `text` at 12px in the UI font.
pub(crate) fn text_width(window: &Window, text: &str) -> f32 {
    let text: SharedString = text.to_string().into();
    let run = TextRun {
        len: text.len(),
        font: font(crate::theme::ui_font()),
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window.text_system().shape_line(text, px(12.0), &[run], None).width.into()
}

impl StatusPill {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            label: None,
            count: None,
            total: None,
            tone: PillTone::default(),
            bare: false,
            disabled: false,
            medium: false,
            tooltip: None,
            leading: None,
            gap: 6.0,
            on_click: None,
        }
    }

    /// The hover label ("Subagents"), as the desktop's `<Tooltip label>` around the pill.
    pub fn tooltip(mut self, label: impl Into<SharedString>) -> Self {
        self.tooltip = Some(label.into());
        self
    }

    /// `font-medium` (the PR action).
    pub fn medium(mut self) -> Self {
        self.medium = true;
        self
    }

    /// `leading`: an element of `width` px before the icon and label (the Subagents pill's ring).
    pub fn leading(mut self, element: impl IntoElement, width: f32) -> Self {
        self.leading = Some((element.into_any_element(), width));
        self
    }

    /// `gap-2` instead of the default `gap-1.5`.
    pub fn gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }

    fn count_text(&self) -> Option<String> {
        self.count.map(|count| match self.total {
            Some(total) => format!("{count}/{total}"),
            None => count.to_string(),
        })
    }

    /// The width the pill takes: padding, its parts and the gaps between them (a flex row hugging its content).
    pub fn width(&self, window: &Window) -> f32 {
        let mut parts: Vec<f32> = Vec::new();
        parts.extend(self.leading.as_ref().map(|(_, width)| *width));
        parts.extend(self.icon.map(|_| 12.0));
        parts.extend(self.label.as_ref().map(|label| text_width(window, label)));
        parts.extend(self.count_text().map(|count| text_width(window, &count)));
        (2.0 * PAD + parts.iter().sum::<f32>() + self.gap * parts.len().saturating_sub(1) as f32).ceil()
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }

    /// With a count: shows `count/total`.
    pub fn total(mut self, total: u32) -> Self {
        self.total = Some(total);
        self
    }

    pub fn tone(mut self, tone: PillTone) -> Self {
        self.tone = tone;
        self
    }

    /// Inside a morphing surface that draws the glass and ring.
    pub fn bare(mut self) -> Self {
        self.bare = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for StatusPill {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (text, ring) = self.tone.colors(&theme);
        let selector = self.id.to_string();
        let enabled = !self.disabled;
        let hover = theme.hover;
        // The glass (blur, tint, ring) is the first child; the hover is translucent ink over it, over the whole pill.
        let glass = Glass::new(GLASS_BLUR, Hsla::from(theme.surface).opacity(FILL)).edge(ring).outset().radius(px(f32::MAX));
        let group: SharedString = format!("{selector}-glass").into();
        let count = self.count_text();
        let leading = self.leading;
        // The composer's pills press to 0.97. The glass and its ring are one blurred quad that cannot shrink, so the
        // hover tint is what presses: it shrinks and the ring stays.
        let press = enabled.then(|| Press::new(self.id.clone(), window, cx));
        let engaged = press.as_ref().is_some_and(Press::engaged);
        let face = press.as_ref().filter(|_| engaged).map(|press| press.face(Some(hover.into()), px(f32::MAX)));
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .map(|el| match &press {
                Some(press) => press.wire(el),
                None => el,
            })
            .flex()
            .flex_none()
            .items_center()
            .gap(px(self.gap))
            .h(CONTROL_SM)
            .px(px(PAD))
            .rounded_full()
            .whitespace_nowrap()
            .text_step(TEXT_12)
            .text_color(text)
            .when(self.medium, |el| el.font_weight(FontWeight::MEDIUM))
            .when(!self.bare, |el| {
                el.relative().group(group.clone()).child(glass).child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .rounded_full()
                        .when(enabled && !engaged, |el| el.group_hover(group, move |style| style.bg(hover))),
                )
            })
            .when(self.bare && enabled && !engaged, |el| el.hover(move |style| style.bg(hover)))
            .children(face)
            .when(enabled, |el| el.cursor_pointer())
            .when_some(self.tooltip, |el, label| el.tooltip(super::Tooltip::text(label)))
            .when(!enabled, |el| el.opacity(0.4))
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |event, window, cx| handler(event, window, cx)))
            .when_some(leading, |el, (element, _)| el.child(element))
            .when_some(self.icon, |el, icon| el.child(Icon::new(icon).size(IconSize::S12).color(text)))
            .when_some(self.label, |el, label| el.child(label))
            .when_some(count, |el, count| el.child(div().flex().child(count)))
    }
}
