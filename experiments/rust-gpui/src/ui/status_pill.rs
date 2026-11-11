//! [`StatusPill`] (the desktop's `primitives/StatusPill.tsx`): one slot of the composer's chip row (the PR fix, Ports,
//! to-dos, Browser, Simulators, Subagents): 28px, fully round, 12px, an optional 12px icon, a label and a count
//! (`count` or `count/total`, tabular figures), tinted by tone: `ink` (`ink-2` text), or `orange`, `green`, `red` with
//! the `-ink` text shade and a 25% ring of the tone.
//!
//! The desktop draws it as frosted glass over the transcript (`.status-pill`: a blur behind it); GPUI has no
//! backdrop blur, so it is the `surface` at 76% (the composer's own fill, DESIGN.md "Composer") with the ring.
//! `.bare()` is the pill inside a morphing surface: no fill or ring, `hover` on hover. Not built: the rolling digits
//! and the letters rising in when the label changes (motion, WP-10), the slot's grow-in. Our own.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, Hsla, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::{Icon, IconName, IconSize};
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
            PillTone::Ink => (theme.ink2.into(), theme.line_strong.into()),
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
    on_click: Option<PillClick>,
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
            on_click: None,
        }
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
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (text, ring) = self.tone.colors(&theme);
        let selector = self.id.to_string();
        let enabled = !self.disabled;
        let hover = theme.hover;
        let glass: Hsla = Hsla::from(theme.surface).opacity(0.76);
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.0))
            .h(CONTROL_SM)
            .px(px(10.0))
            .rounded_full()
            .whitespace_nowrap()
            .text_step(TEXT_12)
            .text_color(text)
            .when(!self.bare, |el| el.bg(glass).shadow(vec![gpui::BoxShadow::new(px(0.0), px(0.0), ring).spread_radius(px(1.0))]))
            .when(self.bare && enabled, |el| el.hover(move |style| style.bg(hover)))
            .when(enabled, |el| el.cursor_pointer())
            .when(!enabled, |el| el.opacity(0.4))
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |event, window, cx| handler(event, window, cx)))
            .when_some(self.icon, |el, icon| el.child(Icon::new(icon).size(IconSize::S12).color(text)))
            .when_some(self.label, |el, label| el.child(label))
            .when_some(self.count, |el, count| {
                el.child(div().flex().child(match self.total {
                    Some(total) => format!("{count}/{total}"),
                    None => count.to_string(),
                }))
            })
    }
}
