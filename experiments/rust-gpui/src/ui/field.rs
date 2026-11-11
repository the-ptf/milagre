//! [`Input`] and [`TextArea`]: Milagre's text fields (DESIGN.md "Sizes": 36 inputs; "States": text fields show no
//! focus mark, the caret is enough; the desktop's `primitives/Field.tsx`).
//!
//! Both wrap gpui-component's `Input` and `Textarea`, which bring the editing (IME, undo, word movement, paste,
//! clipboard, caret blink, password mask). What is ours is the look, set per call because the widgets' defaults do
//! not match DESIGN.md (`COMPONENT-FIT.md`): a fixed 28, 32 or 36px height, `field` fill, a 1px `line-strong`
//! border with a 10px inset (8 at 28), 13px text (12 at 28; the widget's default is 14), no focus border, the
//! placeholder in `ink-3` (the bridge's `muted-foreground`), `red` border while invalid and not focused, 40%
//! when disabled.
//!
//! The widgets keep their text in a state entity, made with [`Input::state`] / [`TextArea::state`] (a view
//! creates it once, in its constructor) and read with `state.read(cx).value()`:
//!
//! ```ignore
//! let name = Input::state("Chat name", window, cx);          // in ProjectDialog::new
//! Input::new("name", &name).size(FieldSize::S36)                // in render
//! TextArea::new("note", &note).invalid(error.is_some())
//! ```

use gpui::{App, AppContext as _, Context, Entity, Focusable as _, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};
use gpui_component::Sizable as _;
use gpui_component::input::{Input as WidgetInput, InputState, Textarea as WidgetTextarea, TextareaState};

use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_LG, CONTROL_MD, CONTROL_SM, RADIUS_CONTROL, TEXT_12, TEXT_13};

/// Disabled controls are 40% (DESIGN.md "States").
const DISABLED_OPACITY: f32 = 0.4;

/// A field's density: 36 in forms and dialogs, 32 in a toolbar or beside 32px buttons, 28 in a compact row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FieldSize {
    S28,
    S32,
    #[default]
    S36,
}

impl FieldSize {
    pub fn height(self) -> gpui::Pixels {
        match self {
            FieldSize::S28 => CONTROL_SM,
            FieldSize::S32 => CONTROL_MD,
            FieldSize::S36 => CONTROL_LG,
        }
    }

    /// 12px text at 28, 13px otherwise.
    fn text_size(self) -> gpui::Pixels {
        px(match self {
            FieldSize::S28 => TEXT_12.size,
            _ => TEXT_13.size,
        })
    }

    /// The widget size whose input padding is DESIGN.md's: 8 at 28 (`px-2`), 10 otherwise (`px-2.5`).
    fn widget_size(self) -> gpui_component::Size {
        match self {
            FieldSize::S28 => gpui_component::Size::Small,
            _ => gpui_component::Size::Medium,
        }
    }
}

/// A single-line text field.
#[derive(IntoElement)]
pub struct Input {
    id: SharedString,
    state: Entity<InputState>,
    size: FieldSize,
    invalid: bool,
    disabled: bool,
    masked_toggle: bool,
    cleanable: bool,
    leading: Option<IconName>,
}

impl Input {
    /// The text state for a field: create it once and keep it on the view.
    pub fn state<V: 'static>(placeholder: impl Into<SharedString>, window: &mut Window, cx: &mut Context<V>) -> Entity<InputState> {
        let placeholder = placeholder.into();
        cx.new(|cx| InputState::new(window, cx).placeholder(placeholder))
    }

    /// The text state of a password field (masked, with the show/hide toggle `.mask_toggle()` draws).
    pub fn password_state<V: 'static>(
        placeholder: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Entity<InputState> {
        let placeholder = placeholder.into();
        cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).masked(true))
    }

    pub fn new(id: impl Into<SharedString>, state: &Entity<InputState>) -> Self {
        Self {
            id: id.into(),
            state: state.clone(),
            size: FieldSize::default(),
            invalid: false,
            disabled: false,
            masked_toggle: false,
            cleanable: false,
            leading: None,
        }
    }

    pub fn size(mut self, size: FieldSize) -> Self {
        self.size = size;
        self
    }

    /// A red border while the field is not focused (`aria-invalid`); put an `InlineError` under it.
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// For a password field: the eye toggle at the field's end.
    pub fn mask_toggle(mut self) -> Self {
        self.masked_toggle = true;
        self
    }

    /// A 14px `ink-3` glyph inside the field's start (the search field's magnifier).
    pub fn leading(mut self, icon: IconName) -> Self {
        self.leading = Some(icon);
        self
    }

    /// A clear button once there is text.
    pub fn cleanable(mut self) -> Self {
        self.cleanable = true;
        self
    }
}

/// The border colour a field wears: `line-strong`, or red while invalid and not focused.
fn edge(invalid: bool, focused: bool, cx: &App) -> gpui::Rgba {
    let theme = cx.theme();
    if invalid && !focused { theme.red } else { theme.line_strong }
}

impl RenderOnce for Input {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let focused = self.state.focus_handle(cx).is_focused(window);
        let selector = self.id.clone();
        let widget = WidgetInput::new(&self.state)
            .with_size(self.size.widget_size())
            .focus_bordered(false)
            .disabled(self.disabled)
            .cleanable(self.cleanable)
            .when_some(self.leading, |input, icon| input.prefix(Icon::new(icon).size(IconSize::S14).color(theme.ink3)))
            .when(self.masked_toggle, |input| input.mask_toggle())
            .h(self.size.height())
            .bg(theme.field)
            .border_color(edge(self.invalid, focused, cx))
            .text_size(self.size.text_size())
            .text_color(theme.ink);
        div()
            .debug_selector(move || selector.to_string())
            .w_full()
            .h(self.size.height())
            .flex_none()
            .rounded(RADIUS_CONTROL)
            .when(self.disabled, |el| el.opacity(DISABLED_OPACITY))
            .child(widget)
    }
}

/// A multi-line text field that grows with its text.
#[derive(IntoElement)]
pub struct TextArea {
    id: SharedString,
    state: Entity<TextareaState>,
    invalid: bool,
    disabled: bool,
}

impl TextArea {
    /// The text state: `min_rows` tall at rest, growing to `max_rows`, then scrolling. Create it once and keep it
    /// on the view.
    pub fn state<V: 'static>(
        placeholder: impl Into<SharedString>,
        (min_rows, max_rows): (usize, usize),
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Entity<TextareaState> {
        let placeholder = placeholder.into();
        cx.new(|cx| TextareaState::new(window, cx).auto_grow(min_rows, max_rows).placeholder(placeholder))
    }

    pub fn new(id: impl Into<SharedString>, state: &Entity<TextareaState>) -> Self {
        Self { id: id.into(), state: state.clone(), invalid: false, disabled: false }
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl RenderOnce for TextArea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let focused = self.state.focus_handle(cx).is_focused(window);
        let selector = self.id.clone();
        // The widget's own frame (`appearance(false)` drops it) would draw a focus border the textarea cannot
        // turn off, so the field's box is ours: the widget adds the 10px by 8px padding inside it, and the 1px
        // border puts the text 11px in, as `FIELD_AREA` does.
        div()
            .debug_selector(move || selector.to_string())
            .w_full()
            .rounded(RADIUS_CONTROL)
            .bg(theme.field)
            .border_1()
            .border_color(edge(self.invalid, focused, cx))
            .when(self.disabled, |el| el.opacity(DISABLED_OPACITY))
            .child(
                WidgetTextarea::new(&self.state)
                    .appearance(false)
                    .disabled(self.disabled)
                    .text_size(px(TEXT_13.size))
                    .text_color(theme.ink),
            )
    }
}
