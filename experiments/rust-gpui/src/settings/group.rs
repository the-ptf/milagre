//! Shared Settings section primitives (`SettingsGroup`, `SettingRow`, `CheckboxRow`, `ChoiceCard`,
//! and page headers), matching `apps/desktop/app/src/components/settings/SettingsGroup.tsx` and
//! `ChatDisplayChoices.tsx`.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, IntoElement, ParentElement, RenderOnce, SharedString, Stateful, Styled,
    Window, div, prelude::*, px,
};

use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TEXT_17, TextStepExt};
use crate::ui::Checkbox;

type ChangeHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// Returns a stable, ASCII-clean selector slug for a title or heading (`"Open files in"` -> `"open-files-in"`).
pub fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    out
}

/// Renders a section title + optional description with theme colors.
pub fn page_header(title: impl Into<SharedString>, description: Option<&str>, cx: &App) -> Div {
    let theme = *cx.theme();
    let title: SharedString = title.into();
    let mut col = div()
        .mb(px(20.0))
        .flex()
        .flex_col()
        .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title));
    if let Some(desc) = description {
        col = col.child(div().mt(px(2.0)).text_step(TEXT_13).text_color(theme.ink3).child(SharedString::from(desc.to_owned())));
    }
    col
}

/// A grouped card inside a Settings section (`SettingsGroup` in `SettingsGroup.tsx`).
///
/// Draws an optional 13px medium `ink-2` title (`px-1`, `mb-1.5` or `mb-0.5` with description), an optional
/// 12px `ink-3` description (`mb-2 px-1`), and a `rounded-card border border-line bg-inset` card whose
/// children are separated by 1px `border-line` dividers.
#[derive(IntoElement)]
pub struct SettingsGroup {
    title: Option<SharedString>,
    description: Option<SharedString>,
    highlighted_title: Option<SharedString>,
    rows: Vec<AnyElement>,
}

impl Default for SettingsGroup {
    fn default() -> Self {
        Self::new()
    }
}

impl SettingsGroup {
    pub fn new() -> Self {
        Self { title: None, description: None, highlighted_title: None, rows: Vec::new() }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn highlighted_row(mut self, row_title: Option<SharedString>) -> Self {
        self.highlighted_title = row_title;
        self
    }

    pub fn row(mut self, row: impl IntoElement) -> Self {
        self.rows.push(row.into_any_element());
        self
    }

    pub fn rows(mut self, rows: impl IntoIterator<Item = AnyElement>) -> Self {
        self.rows.extend(rows);
        self
    }
}

impl RenderOnce for SettingsGroup {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let title_matched = match (&self.title, &self.highlighted_title) {
            (Some(title), Some(found)) => title.as_ref() == found.as_ref(),
            _ => false,
        };
        let mut outer = div().mb(px(24.0)).flex().flex_col();
        if let Some(title) = self.title {
            let group_sel = format!("settings-group-{}", slug(&title));
            let has_desc = self.description.is_some();
            outer = outer.child(
                div()
                    .debug_selector(move || group_sel.clone())
                    .px(px(4.0))
                    .mb(if has_desc { px(2.0) } else { px(6.0) })
                    .rounded(RADIUS_CONTROL)
                    .when(title_matched, |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
                    .text_step(TEXT_13)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink2)
                    .child(title),
            );
        }
        if let Some(desc) = self.description {
            outer = outer.child(div().mb(px(8.0)).px(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(desc));
        }

        let mut card = div().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.inset).overflow_hidden().flex().flex_col();
        for (ix, child) in self.rows.into_iter().enumerate() {
            if ix > 0 {
                card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
            }
            card = card.child(child);
        }
        outer.child(card)
    }
}

/// A single horizontal row inside a [`SettingsGroup`] (`SettingRow` in `SettingsGroup.tsx`).
///
/// Label (13px medium `ink`) and optional description (12px `ink-3`) on the left, control on the right.
#[derive(IntoElement)]
pub struct SettingRow {
    label: SharedString,
    description: Option<SharedString>,
    warning: Option<SharedString>,
    highlighted: bool,
    disabled: bool,
    control: Option<AnyElement>,
}

impl SettingRow {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self { label: label.into(), description: None, warning: None, highlighted: false, disabled: false, control: None }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn warning(mut self, warning: impl Into<SharedString>) -> Self {
        self.warning = Some(warning.into());
        self
    }

    pub fn highlighted(mut self, highlighted: Option<&str>) -> Self {
        self.highlighted = highlighted.is_some_and(|h| h == self.label.as_ref());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control = Some(control.into_any_element());
        self
    }
}

impl RenderOnce for SettingRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let row_sel = format!("settings-row-{}", slug(&self.label));
        let highlighted = self.highlighted;
        let mut left = div()
            .min_w_0()
            .flex_1()
            .flex()
            .flex_col()
            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(self.label));
        if let Some(desc) = self.description {
            left = left.child(div().mt(px(2.0)).text_step(TEXT_12).text_color(theme.ink3).child(desc));
        }
        if let Some(warn) = self.warning {
            left = left.child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.orange_ink).child(warn));
        }
        div()
            .debug_selector(move || if highlighted { "settings-found-row".to_string() } else { row_sel.clone() })
            .px(px(16.0))
            .py(px(12.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .when(highlighted, |d| d.bg(theme.hover2))
            .when(self.disabled, |d| d.opacity(0.45))
            .child(left)
            .when_some(self.control, |d, control| d.child(div().flex_shrink_0().child(control)))
    }
}

/// A full-row clickable checkbox row inside a [`SettingsGroup`], using the [`Checkbox`] primitive
/// (DESIGN.md forbids toggle switches: every boolean row uses a checkbox).
#[derive(IntoElement)]
pub struct CheckboxRow {
    id: ElementId,
    label: SharedString,
    description: Option<SharedString>,
    warning: Option<SharedString>,
    checked: bool,
    disabled: bool,
    indented: bool,
    highlighted: bool,
    on_change: Option<ChangeHandler>,
}

impl CheckboxRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, checked: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: None,
            warning: None,
            checked,
            disabled: false,
            indented: false,
            highlighted: false,
            on_change: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn warning(mut self, warning: impl Into<SharedString>) -> Self {
        self.warning = Some(warning.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn indented(mut self, indented: bool) -> Self {
        self.indented = indented;
        self
    }

    pub fn highlighted(mut self, highlighted: Option<&str>) -> Self {
        self.highlighted = highlighted.is_some_and(|h| h == self.label.as_ref());
        self
    }

    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for CheckboxRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let row_sel = format!("settings-row-{}", slug(&self.label));
        let check_id = ElementId::Name(SharedString::from(format!("{}-check", self.id)));
        let checked = self.checked;
        let disabled = self.disabled;
        let highlighted = self.highlighted;

        let mut left = div()
            .min_w_0()
            .flex_1()
            .flex()
            .flex_col()
            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(self.label));
        if let Some(desc) = self.description {
            left = left.child(div().mt(px(2.0)).text_step(TEXT_12).text_color(theme.ink3).child(desc));
        }
        if let Some(warn) = self.warning {
            left = left.child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.orange_ink).child(warn));
        }

        let mut checkbox = Checkbox::new(check_id, checked).disabled(disabled);
        if let Some(handler) = self.on_change.clone() {
            checkbox = checkbox.on_toggle(move |next, window, cx| handler(next, window, cx));
        }

        let mut row: Stateful<Div> = div()
            .id(self.id)
            .debug_selector(move || if highlighted { "settings-found-row".to_string() } else { row_sel.clone() })
            .pl(if self.indented { px(32.0) } else { px(16.0) })
            .pr(px(16.0))
            .py(px(12.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .when(highlighted, |d| d.bg(theme.hover2))
            .when(!disabled, |d| d.cursor_pointer().hover(move |s| s.bg(theme.hover)))
            .when(disabled, |d| d.opacity(0.45))
            .child(left)
            .child(div().flex_shrink_0().child(checkbox));

        if !disabled && let Some(handler) = self.on_change {
            row = row.on_click(move |_, window, cx| handler(!checked, window, cx));
        }
        row
    }
}

/// A two-up visual choice card (`ChoiceCard` in `ChatDisplayChoices.tsx`):
/// `rounded-card border bg-inset p-3`, with a `border-line bg-surface p-2.5` preview box at top,
/// 13px medium `ink` title and 12px `ink-3` description underneath, and a 2px `ink` border when selected.
#[derive(IntoElement)]
pub struct ChoiceCard {
    id: ElementId,
    label: SharedString,
    description: SharedString,
    selected: bool,
    highlighted: bool,
    preview: Option<AnyElement>,
    on_click: Option<ClickHandler>,
}

impl ChoiceCard {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, description: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: description.into(),
            selected,
            highlighted: false,
            preview: None,
            on_click: None,
        }
    }

    pub fn highlighted(mut self, highlighted: Option<&str>) -> Self {
        self.highlighted = highlighted.is_some_and(|h| h == self.label.as_ref());
        self
    }

    pub fn preview(mut self, preview: impl IntoElement) -> Self {
        self.preview = Some(preview.into_any_element());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ChoiceCard {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let card_sel = format!("choice-card-{}", slug(&self.label));
        let highlighted = self.highlighted;
        let selected = self.selected;

        let preview_box = div()
            .h(px(86.0))
            .w_full()
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .p(px(10.0))
            .overflow_hidden()
            .flex()
            .flex_col()
            .justify_center()
            .when_some(self.preview, |d, p| d.child(p));

        let mut card = div()
            .id(self.id)
            .debug_selector(move || if highlighted { "settings-found-row".to_string() } else { card_sel.clone() })
            .flex_1()
            .min_w_0()
            .cursor_pointer()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(if selected { theme.ink } else { theme.line })
            .bg(if highlighted { theme.hover2 } else { theme.inset })
            .p(px(12.0))
            .relative()
            .flex()
            .flex_col()
            .hover(move |s| s.bg(if selected { theme.inset } else { theme.hover }))
            .child(preview_box)
            .child(div().mt(px(10.0)).text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(self.label))
            .child(div().mt(px(2.0)).text_step(TEXT_12).text_color(theme.ink3).child(self.description));

        if selected {
            card = card.child(div().absolute().inset_0().rounded(RADIUS_CARD).border_2().border_color(theme.ink));
        }

        if let Some(handler) = self.on_click {
            card = card.on_click(move |ev, window, cx| handler(ev, window, cx));
        }

        card
    }
}
