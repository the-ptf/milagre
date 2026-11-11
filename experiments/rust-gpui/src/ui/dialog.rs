//! [`Dialog`] (DESIGN.md "Dialogs and Settings"; the desktop's `primitives/Dialog.tsx`): a modal over the window.
//!
//! Wraps gpui-component's `Dialog` (a gpui-base `Dialog` underneath), opened with `window.open_dialog`: that brings
//! the scrim layer over the window (the bridge's `overlay` is `scrim`: black at 20% in light, 40% in dark), the
//! focus trap, Escape and backdrop-press closing, focus restore and the entrance. What is ours: `rounded-window`,
//! a 17 semibold title with an optional 13 `ink-2` description, 20px padding, and the actions bottom right in our
//! [`Button`] variants (Cancel `ghost` first, the primary last).
//!
//! ```ignore
//! Dialog::new("Remove Project?")
//!     .description("Its Chats stay in Done.")
//!     .action(DialogAction::new("cancel", "Cancel").variant(ButtonVariant::Ghost))
//!     .action(DialogAction::new("remove", "Remove").variant(ButtonVariant::Danger).on_click(|window, cx| ..))
//!     .open(window, cx);
//! ```
//!
//! `Root` must be the window root (it hosts the dialog layer). A must-answer dialog is `.must_answer()`: no
//! Escape, no scrim press; it closes through its own actions.
//!
//! What gpui-component's dialog does not let us match: the surface shadow is applied after our style (a fixed
//! black 10% pair, not `shadow-overlay` with its ring), so the edge is a 1px `line` border instead of the shadow's
//! ring; and there is no backdrop blur (`backdrop-blur-overlay`: GPUI has no backdrop filter). Not built: the
//! 28px close button, `footer="bar"`, a scrolling body (the body takes the height it needs up to the window).

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, FontWeight, SharedString, Window, div, prelude::*, px};
use gpui_component::WindowExt as _;
use gpui_component::dialog::Dialog as WidgetDialog;

use super::{Button, ButtonSize, ButtonVariant};
use crate::theme::{ActiveTheme, RADIUS_WINDOW, TEXT_13, TEXT_17, TextStepExt};

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
type Body = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// One button of a dialog's action row.
#[derive(Clone)]
pub struct DialogAction {
    id: ElementId,
    label: SharedString,
    variant: ButtonVariant,
    on_click: Option<Handler>,
    closes: bool,
}

impl DialogAction {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self { id: id.into(), label: label.into(), variant: ButtonVariant::Primary, on_click: None, closes: true }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    /// The dialog stays open after this action (a form that keeps its own state).
    pub fn keeps_open(mut self) -> Self {
        self.closes = false;
        self
    }
}

/// A modal dialog; see the module docs.
#[derive(Clone)]
pub struct Dialog {
    title: SharedString,
    description: Option<SharedString>,
    body: Option<Body>,
    actions: Vec<DialogAction>,
    width: f32,
    must_answer: bool,
    on_close: Option<Handler>,
}

impl Dialog {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self { title: title.into(), description: None, body: None, actions: Vec::new(), width: 440.0, must_answer: false, on_close: None }
    }

    /// A line under the title in `ink-2`.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The content between header and actions; called on every render of the dialog.
    pub fn body(mut self, body: impl Fn(&mut Window, &mut App) -> AnyElement + 'static) -> Self {
        self.body = Some(Rc::new(body));
        self
    }

    /// An action button; the row is right-aligned in the order given (Cancel first, the primary last).
    pub fn action(mut self, action: DialogAction) -> Self {
        self.actions.push(action);
        self
    }

    /// 440 by default.
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// Only its own actions close it: Escape and a press on the scrim do nothing.
    pub fn must_answer(mut self) -> Self {
        self.must_answer = true;
        self
    }

    /// Called when the dialog closes by Escape, a scrim press or an action.
    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }

    /// Opens it over the window (`Root` must be the window root).
    pub fn open(self, window: &mut Window, cx: &mut App) {
        let spec = Rc::new(self);
        window.open_dialog(cx, move |dialog, _, cx| spec.apply(dialog, cx));
    }

    /// Closes the topmost dialog.
    pub fn close(window: &mut Window, cx: &mut App) {
        window.close_dialog(cx);
    }

    /// Dresses the widget's dialog: called on every render, so it only builds.
    fn apply(&self, dialog: WidgetDialog, cx: &mut App) -> WidgetDialog {
        let theme = *cx.theme();
        let header = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(self.title.clone()))
            .when_some(self.description.clone(), |el, text| {
                el.child(div().text_step(TEXT_13).font_weight(FontWeight::NORMAL).text_color(theme.ink2).child(text))
            });
        let actions = self.actions.clone();
        let footer = div().flex().flex_none().justify_end().gap(px(8.0)).children(actions.into_iter().map(|action| {
            let handler = action.on_click.clone();
            let closes = action.closes;
            Button::new(action.id, action.label).variant(action.variant).size(ButtonSize::S32).on_click(move |_, window, cx| {
                if let Some(handler) = &handler {
                    handler(window, cx);
                }
                if closes {
                    window.close_dialog(cx);
                }
            })
        }));
        let body = self.body.clone();
        let on_close = self.on_close.clone();
        dialog
            .width(px(self.width))
            .close_button(false)
            .overlay_closable(!self.must_answer)
            .keyboard(!self.must_answer)
            // The surface: our fill, 14px corners, a `line` hairline where the shadow would paint its ring.
            .bg(theme.surface)
            .border_color(theme.line)
            .rounded(RADIUS_WINDOW)
            .text_color(theme.ink)
            .p(px(20.0))
            .gap(px(12.0))
            .title(header)
            .when_some(body, |dialog, body| dialog.content(move |content, window, cx| content.child(body(window, cx))))
            .footer(footer)
            .when_some(on_close, |dialog, handler| dialog.on_close(move |_, window, cx| handler(window, cx)))
    }
}
