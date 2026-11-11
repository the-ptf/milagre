//! The inspector (`DesignEditor.tsx`'s Layer properties): a raised panel down the viewport's right edge. One layer
//! shows its name and type, then its fields by type: sizing modes, X, Y, width and height, minimums, text and font
//! fields, fill, radius, opacity, stroke, image URL, icon and line weight, a frame's auto layout, hide and lock, the
//! component buttons, Duplicate and Delete; an instance only its place, Edit main and Detach. Several layers show
//! the selection's X and Y; none, a hint.
//!
//! A field keeps what is typed until it loses focus or Return (a textarea only on blur), so typing a number is one
//! undo step; a number outside its range, or not a number, goes back to the layer's value.

use gpui::{AnyElement, App, ClickEvent, Context, Entity, Focusable as _, FontWeight, SharedString, Window, div, prelude::*, px};
use gpui_component::input::{InputEvent, InputState, TextareaState};
use serde_json::{Map, Value};

use super::DesignEditor;
use crate::logic::design_layout::default_fill;
use crate::logic::design_ops::editor::{self as ops, Rect, round_coordinate};
use crate::logic::design_ops::{self, num};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, FieldSize, Input, ScrollArea, Select, SelectOption, TextArea};

/// The panel's width and inset (`w-[248px]`, `inset 16`).
pub const WIDTH: f32 = 248.0;
const INSET: f32 = 16.0;

/// A text field's state: one line, or the text layer's textarea.
#[derive(Clone)]
pub enum FieldState {
    Line(Entity<InputState>),
    Area(Entity<TextareaState>),
}

impl FieldState {
    pub fn focused(&self, window: &Window, cx: &App) -> bool {
        match self {
            FieldState::Line(s) => s.read(cx).focus_handle(cx).is_focused(window),
            FieldState::Area(s) => s.read(cx).focus_handle(cx).is_focused(window),
        }
    }

    pub fn value(&self, cx: &App) -> String {
        match self {
            FieldState::Line(s) => s.read(cx).value().to_string(),
            FieldState::Area(s) => s.read(cx).value().to_string(),
        }
    }

    fn set(&self, value: &str, window: &mut Window, cx: &mut App) {
        let value = value.to_string();
        match self {
            FieldState::Line(s) => s.update(cx, |s, cx| s.set_value(value, window, cx)),
            FieldState::Area(s) => s.update(cx, |s, cx| s.set_value(value, window, cx)),
        }
    }
}

/// What a field edits: the patch key, its range, and the layer's value as the field shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldSpec {
    pub key: &'static str,
    pub number: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub value: String,
    pub area: bool,
}

/// `String(number)`: integral values without a fraction.
pub fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 { format!("{}", value as i64) } else { format!("{value}") }
}

/// Whether a typed value can be committed (`commit`'s check): numbers in range.
pub fn accepts(spec: &FieldSpec, draft: &str) -> bool {
    if !spec.number {
        return true;
    }
    let Ok(value) = draft.trim().parse::<f64>() else { return false };
    !draft.trim().is_empty() && value.is_finite() && spec.min.is_none_or(|m| value >= m) && spec.max.is_none_or(|m| value <= m)
}

impl DesignEditor {
    /// The field for a label, made once with its commit on blur and Return.
    fn field(&mut self, label: &'static str, area: bool, window: &mut Window, cx: &mut Context<Self>) -> FieldState {
        if let Some(field) = self.fields.get(label) {
            return field.clone();
        }
        let field = if area {
            let state = TextArea::state("", (3, 8), window, cx);
            self.subscriptions.push(cx.subscribe_in(&state, window, move |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Blur) {
                    this.commit(label, window, cx);
                }
            }));
            FieldState::Area(state)
        } else {
            let state = Input::state("", window, cx);
            self.subscriptions.push(cx.subscribe_in(&state, window, move |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. }) {
                    this.commit(label, window, cx);
                }
            }));
            FieldState::Line(state)
        };
        self.fields.insert(label, field.clone());
        field
    }

    /// Commits a field's draft as a patch to the selected layer, or puts the layer's value back.
    pub fn commit(&mut self, label: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(field), Some(spec)) = (self.fields.get(label).cloned(), self.specs.get(label).cloned()) else { return };
        let draft = field.value(cx);
        if draft == spec.value {
            return;
        }
        if !accepts(&spec, &draft) {
            field.set(&spec.value, window, cx);
            return;
        }
        let number = draft.trim().parse::<f64>().unwrap_or(0.0);
        match spec.key {
            "selection-x" | "selection-y" => {
                let from = spec.value.parse::<f64>().unwrap_or(0.0);
                let (dx, dy) = if spec.key == "selection-x" { (number - from, 0.0) } else { (0.0, number - from) };
                self.nudge(dx, dy, cx);
            }
            "icon" => {
                let name = draft.trim().to_lowercase();
                if design_ops::has_icon(&name) {
                    self.patch(Map::from_iter([("icon".to_string(), Value::String(name))]), cx);
                } else {
                    self.notice = Some(format!("No Lucide icon named \"{name}\". Try a name from lucide.dev/icons."));
                    field.set(&spec.value, window, cx);
                    cx.notify();
                }
            }
            key => {
                let value = if spec.number { num(number) } else { Value::String(draft) };
                self.patch(Map::from_iter([(key.to_string(), value)]), cx);
            }
        }
    }

    /// A labelled field (`Field`): the label over a 28px input, or a textarea for a text layer's text.
    fn field_element(
        &mut self,
        label: &'static str,
        spec: FieldSpec,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let field = self.field(label, spec.area, window, cx);
        // Show the layer's value unless the field is being edited (a new layer, an undo, a drag).
        if !field.focused(window, cx) && field.value(cx) != spec.value {
            field.set(&spec.value, window, cx);
        }
        self.specs.insert(label, spec);
        let theme = *cx.theme();
        let selector = format!("design-field-{}", label.to_lowercase().replace(' ', "-"));
        let control: AnyElement = match &field {
            FieldState::Line(state) => {
                Input::new(SharedString::from(selector), state).size(FieldSize::S28).disabled(disabled).into_any_element()
            }
            FieldState::Area(state) => TextArea::new(SharedString::from(selector), state).disabled(disabled).into_any_element(),
        };
        div().flex().flex_col().min_w_0().gap_1().text_step(TEXT_11).text_color(theme.ink3).child(label).child(control).into_any_element()
    }
}

fn text_spec(key: &'static str, value: impl Into<String>) -> FieldSpec {
    FieldSpec { key, number: false, min: None, max: None, value: value.into(), area: false }
}

fn number_spec(key: &'static str, value: f64, min: Option<f64>, max: Option<f64>) -> FieldSpec {
    FieldSpec { key, number: true, min, max, value: js_number(value), area: false }
}

fn pair(a: AnyElement, b: AnyElement) -> AnyElement {
    div().grid().grid_cols(2).gap_2().child(a).child(b).into_any_element()
}

fn rule(theme: &Theme) -> gpui::Div {
    div().border_t_1().border_color(theme.line).pt_3()
}

fn button(id: String, label: impl Into<SharedString>, variant: ButtonVariant) -> Button {
    Button::new(SharedString::from(id), label).variant(variant).size(ButtonSize::S28)
}

/// A select that patches one field of the selected layer.
fn select(id: &str, key: &'static str, value: &str, options: &[(&str, &str)], cx: &mut Context<DesignEditor>) -> Select {
    let editor = cx.weak_entity();
    Select::new(
        SharedString::from(format!("design-select-{id}")),
        value.to_string(),
        options.iter().map(|(v, l)| SelectOption::new(v.to_string(), l.to_string())),
    )
    .compact()
    .width(180.0)
    .on_change(move |value, _, cx| {
        let value = value.to_string();
        editor.update(cx, |this, cx| this.patch(Map::from_iter([(key.to_string(), Value::String(value))]), cx)).ok();
    })
}

fn labelled(label: &'static str, control: impl IntoElement, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .gap_1()
        .child(div().text_step(TEXT_11).text_color(theme.ink3).child(label))
        .child(control)
        .into_any_element()
}

const SIZING: [(&str, &str); 3] = [("fixed", "Fixed"), ("hug", "Hug"), ("fill", "Fill")];

pub fn panel(editor: &mut DesignEditor, theme: &Theme, window: &mut Window, cx: &mut Context<DesignEditor>) -> AnyElement {
    let body = content(editor, theme, window, cx);
    div()
        .debug_selector(|| "design-editor-inspector".to_string())
        .absolute()
        .top(px(INSET))
        .right(px(INSET))
        .bottom(px(INSET))
        .w(px(WIDTH))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(RADIUS_WINDOW)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_scroll(|_, _, cx| cx.stop_propagation())
        .child(ScrollArea::new("design-inspector-scroll", &editor.inspector_scroll).child(body))
        .into_any_element()
}

fn content(editor: &mut DesignEditor, theme: &Theme, window: &mut Window, cx: &mut Context<DesignEditor>) -> AnyElement {
    let Some(session) = editor.active() else { return div().into_any_element() };
    let nodes = session.nodes();
    let selected = session.selected();
    let scope = if selected.len() == 1 { selected[0].clone() } else { "selection".into() };
    if scope != editor.field_scope {
        // Another layer: drafts of the last one are dropped, as the desktop's keyed inspector drops them.
        editor.field_scope = scope;
        editor.specs.clear();
        for field in editor.fields.values() {
            if !field.focused(window, cx) {
                field.set("", window, cx);
            }
        }
    }
    if selected.len() > 1 {
        return selection_content(editor, &nodes, &selected, theme, window, cx);
    }
    let Some(node) = selected.first().and_then(|id| nodes.iter().find(|n| n["id"].as_str() == Some(id))).cloned() else {
        return div()
            .p_4()
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child("Select a layer to edit its properties. Shift-click to select more.")
            .into_any_element();
    };
    let id = node["id"].as_str().unwrap_or("").to_string();
    let kind = node["type"].as_str().unwrap_or("frame").to_string();
    let s = |key: &str| node.get(key).and_then(Value::as_str).map(str::to_string);
    let n = |key: &str| node.get(key).and_then(Value::as_f64);
    let flag = |key: &str| node.get(key).and_then(Value::as_bool) == Some(true);
    let name = s("name").unwrap_or_else(|| id.clone());
    let instance = node.get("componentId").is_some_and(|c| !c.is_null());
    let mut rows: Vec<AnyElement> = vec![
        div()
            .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child(name.clone()))
            .child(div().mt(px(2.0)).text_step(TEXT_11).text_color(theme.ink3).child(capitalize(&kind)))
            .into_any_element(),
    ];
    rows.push(editor.field_element("Layer name", text_spec("name", name), false, window, cx));
    if instance {
        rows.push(
            div()
                .rounded(RADIUS_CONTROL)
                .bg(theme.field)
                .p_2()
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child("Linked instance. Edit the main component to update every instance.")
                .into_any_element(),
        );
        let x = editor.field_element("X", number_spec("x", round_coordinate(n("x").unwrap_or(0.0)), None, None), false, window, cx);
        let y = editor.field_element("Y", number_spec("y", round_coordinate(n("y").unwrap_or(0.0)), None, None), false, window, cx);
        rows.push(pair(x, y));
        let main = s("componentId").unwrap_or_default();
        rows.push(
            div()
                .flex()
                .gap_2()
                .child(
                    button("design-edit-main".into(), "Edit main", ButtonVariant::Secondary)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_selection(vec![main.clone()], cx))),
                )
                .child(
                    button("design-detach".into(), "Detach", ButtonVariant::Secondary)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.detach(cx))),
                )
                .into_any_element(),
        );
    } else {
        let width_mode = s("widthMode").unwrap_or_else(|| "fixed".into());
        let height_mode = s("heightMode").unwrap_or_else(|| "fixed".into());
        rows.push(pair(
            labelled("Width sizing", select("width-mode", "widthMode", &width_mode, &SIZING, cx), theme),
            labelled("Height sizing", select("height-mode", "heightMode", &height_mode, &SIZING, cx), theme),
        ));
        if width_mode != "fixed" || height_mode != "fixed" {
            rows.push(
                div()
                    .text_step(TEXT_11)
                    .text_color(theme.ink3)
                    .child("Hug follows content. Fill uses available space. Width and height are fallback sizes.")
                    .into_any_element(),
            );
        }
        let x = editor.field_element("X", number_spec("x", round_coordinate(n("x").unwrap_or(0.0)), None, None), false, window, cx);
        let y = editor.field_element("Y", number_spec("y", round_coordinate(n("y").unwrap_or(0.0)), None, None), false, window, cx);
        rows.push(pair(x, y));
        let w = editor.field_element(
            "Width",
            number_spec("width", round_coordinate(n("width").unwrap_or(1.0)), Some(1.0), None),
            false,
            window,
            cx,
        );
        let h = editor.field_element(
            "Height",
            number_spec("height", round_coordinate(n("height").unwrap_or(1.0)), Some(1.0), None),
            false,
            window,
            cx,
        );
        rows.push(pair(w, h));
        let mw =
            editor.field_element("Min width", number_spec("minWidth", n("minWidth").unwrap_or(0.0), Some(0.0), None), false, window, cx);
        let mh =
            editor.field_element("Min height", number_spec("minHeight", n("minHeight").unwrap_or(0.0), Some(0.0), None), false, window, cx);
        rows.push(pair(mw, mh));
        if kind == "text" {
            let mut text = text_spec("text", s("text").unwrap_or_default());
            text.area = true;
            rows.push(editor.field_element("Text", text, false, window, cx));
            let family = s("fontFamily").unwrap_or_else(|| "Arial, sans-serif".into());
            rows.push(editor.field_element("Font family", text_spec("fontFamily", family), false, window, cx));
            let size = editor.field_element(
                "Font size",
                number_spec("fontSize", n("fontSize").unwrap_or(16.0), Some(1.0), None),
                false,
                window,
                cx,
            );
            let weight = editor.field_element(
                "Font weight",
                number_spec("fontWeight", n("fontWeight").unwrap_or(400.0), Some(100.0), Some(900.0)),
                false,
                window,
                cx,
            );
            rows.push(pair(size, weight));
            rows.push(editor.field_element(
                "Line height",
                number_spec("lineHeight", n("lineHeight").unwrap_or(1.35), Some(0.5), Some(5.0)),
                false,
                window,
                cx,
            ));
            let align = s("textAlign").unwrap_or_else(|| "left".into());
            rows.push(
                select("text-align", "textAlign", &align, &[("left", "Left"), ("center", "Center"), ("right", "Right")], cx)
                    .into_any_element(),
            );
        }
        let parsed = crate::logic::design_layout::DesignDocument::from_json(&serde_json::json!({
            "width": 1, "height": 1, "nodes": [Value::Object(node.clone())]
        }))
        .ok();
        let fallback = parsed.as_ref().map(|d| default_fill(&d.nodes[0])).unwrap_or("transparent");
        let fill_label = if kind == "text" { "Text color" } else { "Fill" };
        rows.push(editor.field_element(fill_label, text_spec("fill", s("fill").unwrap_or_else(|| fallback.into())), false, window, cx));
        let opacity =
            editor.field_element("Opacity", number_spec("opacity", n("opacity").unwrap_or(1.0), Some(0.0), Some(1.0)), false, window, cx);
        if kind != "icon" {
            let radius =
                editor.field_element("Radius", number_spec("radius", n("radius").unwrap_or(0.0), Some(0.0), None), false, window, cx);
            rows.push(pair(radius, opacity));
            rows.push(editor.field_element(
                "Stroke",
                text_spec("stroke", s("stroke").unwrap_or_else(|| "transparent".into())),
                false,
                window,
                cx,
            ));
            let stroked = if node.contains_key("stroke") { 1.0 } else { 0.0 };
            rows.push(editor.field_element(
                "Stroke width",
                number_spec("strokeWidth", n("strokeWidth").unwrap_or(stroked), Some(0.0), None),
                false,
                window,
                cx,
            ));
        } else {
            rows.push(div().grid().grid_cols(2).gap_2().child(opacity).into_any_element());
        }
        if kind == "image" {
            rows.push(editor.field_element("Image URL", text_spec("src", s("src").unwrap_or_default()), false, window, cx));
        }
        if kind == "icon" {
            rows.push(editor.field_element("Icon", text_spec("icon", s("icon").unwrap_or_default()), false, window, cx));
            rows.push(editor.field_element(
                "Line weight",
                number_spec("strokeWidth", n("strokeWidth").unwrap_or(2.0), Some(0.5), Some(4.0)),
                false,
                window,
                cx,
            ));
        }
        if kind == "frame" {
            rows.push(rule(theme).text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child("Layout").into_any_element());
            let layout = s("layout").unwrap_or_else(|| "free".into());
            rows.push(
                select(
                    "layout",
                    "layout",
                    &layout,
                    &[("free", "Free position"), ("horizontal", "Horizontal"), ("vertical", "Vertical")],
                    cx,
                )
                .into_any_element(),
            );
            let gap = editor.field_element("Gap", number_spec("gap", n("gap").unwrap_or(0.0), Some(0.0), None), false, window, cx);
            let padding =
                editor.field_element("Padding", number_spec("padding", n("padding").unwrap_or(0.0), Some(0.0), None), false, window, cx);
            rows.push(pair(gap, padding));
            let align = s("align").unwrap_or_else(|| "start".into());
            rows.push(
                select("align", "align", &align, &[("start", "Align start"), ("center", "Align center"), ("end", "Align end")], cx)
                    .into_any_element(),
            );
            let justify = s("justify").unwrap_or_else(|| "start".into());
            rows.push(
                select(
                    "justify",
                    "justify",
                    &justify,
                    &[("start", "Pack start"), ("center", "Pack center"), ("end", "Pack end"), ("space-between", "Space between")],
                    cx,
                )
                .into_any_element(),
            );
        }
        let (hidden, locked) = (flag("hidden"), flag("locked"));
        rows.push(
            rule(theme)
                .flex()
                .gap_2()
                .child(button("design-hide".into(), if hidden { "Show layer" } else { "Hide layer" }, ButtonVariant::Secondary).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.patch(Map::from_iter([("hidden".to_string(), Value::Bool(!hidden))]), cx)
                    }),
                ))
                .child(button("design-lock".into(), if locked { "Unlock layer" } else { "Lock layer" }, ButtonVariant::Secondary).on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.patch(Map::from_iter([("locked".to_string(), Value::Bool(!locked))]), cx)
                    }),
                ))
                .into_any_element(),
        );
        if kind == "frame" {
            let component = flag("component");
            let target = id.clone();
            rows.push(
                rule(theme)
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child(if component {
                        "Main component"
                    } else {
                        "Component"
                    }))
                    .child(
                        button(
                            "design-component".into(),
                            if component { "Create instance" } else { "Make component" },
                            ButtonVariant::Secondary,
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            if component {
                                this.insert_instance(&target, cx);
                            } else {
                                this.patch(Map::from_iter([("component".to_string(), Value::Bool(true))]), cx);
                            }
                        })),
                    )
                    .into_any_element(),
            );
        }
    }
    rows.push(actions(theme, cx));
    div().flex().flex_col().gap_4().p_3().children(rows).into_any_element()
}

fn actions(theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    rule(theme)
        .flex()
        .gap_2()
        .child(
            button("design-duplicate".into(), "Duplicate", ButtonVariant::Secondary)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.duplicate(cx))),
        )
        .child(
            button("design-delete".into(), "Delete", ButtonVariant::DangerGhost)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.remove(cx))),
        )
        .into_any_element()
}

fn selection_content(
    editor: &mut DesignEditor,
    nodes: &[crate::logic::design_ops::schema::Node],
    selected: &[String],
    theme: &Theme,
    window: &mut Window,
    cx: &mut Context<DesignEditor>,
) -> AnyElement {
    let id = editor.active.clone();
    let bounds = editor.bounds(&id, cx);
    let roots = ops::selection_roots(nodes, selected);
    let boxes: Vec<Rect> = roots.iter().filter_map(|r| bounds.iter().find(|(b, _)| b == r).map(|(_, rect)| *rect)).collect();
    let movable = !roots.is_empty() && roots.iter().all(|r| ops::movable(nodes, r));
    let mut rows: Vec<AnyElement> = vec![
        div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child(format!("{} layers selected", selected.len())).into_any_element(),
        div()
            .text_step(TEXT_11)
            .text_color(theme.ink3)
            .child("Drag to move them together. Arrow keys move 1 px; Shift + arrows move 10 px.")
            .into_any_element(),
    ];
    if !boxes.is_empty() {
        let x = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
        let y = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
        let fx = editor.field_element("Selection X", number_spec("selection-x", round_coordinate(x), None, None), !movable, window, cx);
        let fy = editor.field_element("Selection Y", number_spec("selection-y", round_coordinate(y), None, None), !movable, window, cx);
        rows.push(pair(fx, fy));
    }
    if !movable {
        rows.push(
            div()
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child("Unlock layers and select their automatic-layout frame to move this selection.")
                .into_any_element(),
        );
    }
    rows.push(actions(theme, cx));
    div().flex().flex_col().gap_4().p_3().children(rows).into_any_element()
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}
