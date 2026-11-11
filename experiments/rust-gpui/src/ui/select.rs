//! [`Select`] (DESIGN.md "Rows and lists"; the desktop's `primitives/Select.tsx`): a trigger that opens the shared
//! [`PickerPanel`] in a [`Popover`].
//!
//! Our own composition, not gpui-component's `Select`: that one keeps its options in a delegate entity and draws
//! its own trigger and list, and the picker's rows, groups, descriptions and trailing text are already ours
//! (`picker.rs`). The popover supplies placement, the outside press and Escape; the panel the rows and the arrow
//! keys. Values are strings, as on the desktop.
//!
//! Trigger variants: `Field` (the secondary button's look: `surface` with `shadow-btn`, `hover-2` while open, 32 high
//! or 28 `compact`), `Chip` (the field-filled [`Chip`](super::Chip)) and `Text` (plain text with a chevron, for a
//! heading that is also a choice). A `searchable` select has a search field that filters by label.
//!
//! ```ignore
//! Select::new("run-on", "Run on", "this", [SelectOption::new("this", "This computer"), SelectOption::new("santo", "Santo")])
//!     .on_change(|value, _, _| ...)
//! ```
//!
//! Not built: opening from the trigger with Down/Up, flipping above the trigger when there is no room below, and
//! a fresh search each time it opens.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FontWeight, IntoElement, RenderOnce, SharedString, Subscription, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::{Chip, ChipVariant, Icon, IconName, IconSize, Input, PickerPanel, PickerRow, Popover};
use crate::theme::{ActiveTheme, CONTROL_MD, CONTROL_SM, RADIUS_CHIP, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt};

type Change = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// One choice of a [`Select`].
#[derive(Clone)]
pub struct SelectOption {
    value: SharedString,
    label: SharedString,
    description: Option<SharedString>,
    trailing: Option<SharedString>,
    group: Option<SharedString>,
    disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self { value: value.into(), label: label.into(), description: None, trailing: None, group: None, disabled: false }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Short text before the tick on the same line ("default"), so the row keeps one height.
    pub fn trailing(mut self, trailing: impl Into<SharedString>) -> Self {
        self.trailing = Some(trailing.into());
        self
    }

    /// Consecutive options with the same group sit under one heading.
    pub fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.group = Some(group.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectVariant {
    #[default]
    Field,
    Chip,
    Text,
}

/// What a searchable select keeps in window state: the query field and the subscription that redraws on typing.
struct SearchState {
    input: Entity<InputState>,
    _typing: Subscription,
}

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    value: SharedString,
    options: Vec<SelectOption>,
    on_change: Option<Change>,
    width: f32,
    disabled: bool,
    variant: SelectVariant,
    compact: bool,
    searchable: bool,
    align_start: bool,
}

impl Select {
    pub fn new(id: impl Into<ElementId>, value: impl Into<SharedString>, options: impl IntoIterator<Item = SelectOption>) -> Self {
        Self {
            id: id.into(),
            value: value.into(),
            options: options.into_iter().collect(),
            on_change: None,
            width: 240.0,
            disabled: false,
            variant: SelectVariant::default(),
            compact: false,
            searchable: false,
            align_start: false,
        }
    }

    /// Called with the new value when a different option is chosen.
    pub fn on_change(mut self, handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// The panel's width (240 by default).
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn variant(mut self, variant: SelectVariant) -> Self {
        self.variant = variant;
        self
    }

    /// The trigger at 28px, beside a toolbar's 28px icon buttons.
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// A search field over a long list.
    pub fn searchable(mut self) -> Self {
        self.searchable = true;
        self
    }

    /// The panel lines up with the trigger's left edge (the default for `Text`).
    pub fn align_start(mut self) -> Self {
        self.align_start = true;
        self
    }
}

impl RenderOnce for Select {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let selected_label =
            self.options.iter().find(|option| option.value == self.value).map(|option| option.label.clone()).unwrap_or_default();
        let (variant, compact, disabled) = (self.variant, self.compact, self.disabled);
        let trigger_id = self.id.clone();
        let selector = self.id.to_string();
        let trigger = move |open: bool| -> AnyElement {
            let chevron = Icon::new(IconName::ArrowDown01).size(IconSize::S14).color(theme.ink3);
            let label = div().flex_1().min_w_0().truncate().text_left().child(selected_label.clone());
            let base = div()
                .id((trigger_id.clone(), "trigger"))
                .debug_selector(move || selector.clone())
                .flex()
                .items_center()
                .when(!disabled, |el| el.cursor_pointer())
                .when(disabled, |el| el.opacity(0.4));
            match variant {
                SelectVariant::Chip => Chip::new((trigger_id.clone(), "chip"))
                    .variant(ChipVariant::Field)
                    .on(open)
                    .chevron()
                    .child(selected_label.clone())
                    .into_any_element(),
                SelectVariant::Text => base
                    .gap(px(4.0))
                    .h(if compact { CONTROL_SM } else { px(24.0) })
                    .px(px(6.0))
                    .rounded(RADIUS_CHIP)
                    .text_step(if compact { TEXT_12 } else { TEXT_13 })
                    .text_color(theme.ink)
                    .when(open, |el| el.bg(theme.hover2))
                    .when(!open && !disabled, |el| el.hover(move |style| style.bg(theme.hover)))
                    .child(label)
                    .child(chevron)
                    .into_any_element(),
                SelectVariant::Field => base
                    .gap(px(8.0))
                    .h(if compact { CONTROL_SM } else { CONTROL_MD })
                    .pl(px(12.0))
                    .pr(px(8.0))
                    .rounded(RADIUS_CONTROL)
                    .text_step(if compact { TEXT_12 } else { TEXT_13 })
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .shadow(theme.shadow_btn())
                    .bg(if open { theme.hover2 } else { theme.surface })
                    .when(!open && !disabled, |el| el.hover(move |style| style.bg(theme.hover)))
                    .child(label)
                    .child(chevron)
                    .into_any_element(),
            }
        };
        let (id, value, options, on_change) = (self.id.clone(), self.value, self.options, self.on_change);
        let (width, searchable) = (self.width, self.searchable);
        let align_start = self.align_start || variant == SelectVariant::Text;
        let popover = Popover::new(self.id).bare().width(px(width)).trigger(trigger).content(move |dismiss, window, cx| {
            let query = searchable.then(|| {
                window
                    .use_keyed_state((id.clone(), "search"), cx, |window, cx| {
                        let input = Input::state("Search", window, cx);
                        let _typing = cx.subscribe_in(&input, window, |_, _, event: &InputEvent, window, _| {
                            if matches!(event, InputEvent::Change) {
                                window.refresh();
                            }
                        });
                        SearchState { input, _typing }
                    })
                    .read(cx)
                    .input
                    .clone()
            });
            let words = query.as_ref().map(|query| query.read(cx).value().to_lowercase()).unwrap_or_default();
            let words = words.trim().to_string();
            let mut panel = PickerPanel::new((id.clone(), "panel")).empty_label("No matches");
            if let Some(query) = &query {
                panel = panel.search(query);
            }
            let mut last_group: Option<SharedString> = None;
            for option in options.iter() {
                if !words.is_empty() && !option.label.to_lowercase().contains(&words) {
                    continue;
                }
                if option.group.is_some() && option.group != last_group {
                    panel = panel.label(option.group.clone().unwrap_or_default());
                }
                last_group = option.group.clone();
                let (value_now, change, dismiss) = (option.value.clone(), on_change.clone(), dismiss.clone());
                let current = value.clone();
                let mut row = PickerRow::new((id.clone(), option.value.clone()), option.label.clone())
                    .selected(option.value == current)
                    .disabled(option.disabled)
                    .on_click(move |window, cx| {
                        if let (true, Some(change)) = (value_now != current, &change) {
                            change(&value_now, window, cx);
                        }
                        dismiss.call(window, cx);
                    });
                if let Some(description) = &option.description {
                    row = row.description(description.clone());
                }
                if let Some(trailing) = &option.trailing {
                    row = row.trailing(trailing.clone());
                }
                panel = panel.row(row);
            }
            div().w_full().child(panel).into_any_element()
        });
        if disabled {
            // A disabled select shows its trigger only: the popover is not mounted.
            return div().child(popover.open(false)).into_any_element();
        }
        if align_start { popover.align_start().into_any_element() } else { popover.into_any_element() }
    }
}
