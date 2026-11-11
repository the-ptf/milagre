//! The component contract of `packages/shared/src/genui.ts` (`GENUI_COMPONENTS`, `genuiLimits`, `parseGenui`,
//! `genuiActionEvents`): the ten components an agent can use, their props in positional order, and Zod's checks
//! after the parser (`visit` in `parseGenui`). A component that fails a check is dropped from its list; a check
//! that fails on size (`too_big`) takes the whole block back to code; a root that is not a `Stack` is no root.

use super::lang::{self, Element, Kind, Param, Step, Value};

/// Caps a block renders under (`genuiLimits`).
pub const MAX_ROWS: usize = 200;
pub const MAX_COLUMNS: usize = 12;
pub const MAX_POINTS: usize = 100;
/// UTF-8 bytes of source.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// The action type a button posts back (`GENUI_ACTION_TYPE`).
pub const ACTION_TYPE: &str = "continue_conversation";

const fn req(name: &'static str, kind: Kind) -> Param {
    Param { name, required: true, kind }
}

const fn opt(name: &'static str, kind: Kind) -> Param {
    Param { name, required: false, kind }
}

const DIRECTIONS: &[&str] = &["column", "row"];
const GAPS: &[&str] = &["s", "m", "l"];
const TONES: &[&str] = &["default", "muted", "strong"];
const CALLOUT_TONES: &[&str] = &["info", "success", "warning", "danger"];
const VARIANTS: &[&str] = &["primary", "secondary"];

const STACK: &[Param] = &[req("children", Kind::Other), opt("direction", Kind::Enum(DIRECTIONS)), opt("gap", Kind::Enum(GAPS))];
const HEADING: &[Param] = &[req("text", Kind::Str), opt("level", Kind::Other)];
const TEXT: &[Param] = &[req("text", Kind::Str), opt("tone", Kind::Enum(TONES))];
const KEY_VALUE: &[Param] = &[req("pairs", Kind::Other)];
const TABLE: &[Param] = &[req("columns", Kind::StrArray), req("rows", Kind::Other)];
const CALLOUT: &[Param] = &[req("body", Kind::Str), opt("tone", Kind::Enum(CALLOUT_TONES)), opt("title", Kind::Str)];
const PROGRESS: &[Param] = &[req("label", Kind::Str), req("value", Kind::Num)];
const CHART: &[Param] = &[req("labels", Kind::StrArray), req("values", Kind::NumArray), opt("title", Kind::Str)];
const BUTTON: &[Param] = &[req("label", Kind::Str), req("action", Kind::Other), opt("variant", Kind::Enum(VARIANTS))];

/// `GENUI_COMPONENTS`' props, in positional order. The kinds are what lang-core's JSON schema lets it check before
/// Zod does (`level` is a union of literals and `action` a union of objects: lang-core skips both).
pub fn params(name: &str) -> Option<&'static [Param]> {
    Some(match name {
        "Stack" => STACK,
        "Heading" => HEADING,
        "Text" => TEXT,
        "KeyValue" => KEY_VALUE,
        "Table" => TABLE,
        "Callout" => CALLOUT,
        "Progress" => PROGRESS,
        "BarChart" | "LineChart" => CHART,
        "Button" => BUTTON,
        _ => return None,
    })
}

/// The names, in the contract's order (the skill lists them the same way).
pub const COMPONENTS: [&str; 10] =
    ["Stack", "Heading", "Text", "KeyValue", "Table", "Callout", "Progress", "BarChart", "LineChart", "Button"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Direction {
    #[default]
    Column,
    Row,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Gap {
    S,
    #[default]
    M,
    L,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextTone {
    #[default]
    Default,
    Muted,
    Strong,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CalloutTone {
    #[default]
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    #[default]
    Primary,
    Secondary,
}

/// What a button does when pressed: the messages it posts, in order (`genuiActionEvents`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Action {
    pub messages: Vec<String>,
}

/// A validated tree.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Stack { children: Vec<Node>, direction: Direction, gap: Gap },
    Heading { text: String, level: u8 },
    Text { text: String, tone: TextTone },
    KeyValue { pairs: Vec<(String, String)> },
    Table { columns: Vec<String>, rows: Vec<Vec<String>> },
    Callout { body: String, tone: CalloutTone, title: Option<String> },
    Progress { label: String, value: f64 },
    BarChart { labels: Vec<String>, values: Vec<f64>, title: Option<String> },
    LineChart { labels: Vec<String>, values: Vec<f64>, title: Option<String> },
    Button { label: String, action: Action, variant: ButtonVariant },
}

/// The outcome of `parseGenui`.
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub root: Option<Node>,
    /// The parser had to close the text (a block still being written).
    pub incomplete: bool,
}

/// `genuiTextOverLimit`.
pub fn text_over_limit(code: &str) -> bool {
    code.len() > MAX_TEXT_BYTES
}

/// `parseGenui`: parse, then check every element against the contract. Over a cap, or no `Stack` at the root,
/// there is no root and the block is shown as code.
pub fn parse_block(code: &str) -> Block {
    if text_over_limit(code) {
        return Block { root: None, incomplete: false };
    }
    let parsed = lang::parse(code, params);
    let mut over_cap = false;
    let root = parsed.root.as_ref().and_then(|element| check(element, &mut over_cap));
    let root = if over_cap { None } else { root.filter(|node| matches!(node, Node::Stack { .. })) };
    Block { root, incomplete: parsed.incomplete }
}

/// Zod's `string().max(n)` counts UTF-16 units.
fn too_long(text: &str, max: usize) -> bool {
    text.encode_utf16().count() > max
}

/// A string prop within its cap; over it the block is over the cap.
fn string(value: Option<&Value>, max: usize, over: &mut bool) -> Option<String> {
    match value {
        Some(Value::Str(text)) => {
            if too_long(text, max) {
                *over = true;
                return None;
            }
            Some(text.clone())
        }
        _ => None,
    }
}

fn strings(value: Option<&Value>, item_max: usize, max_items: usize, over: &mut bool) -> Option<Vec<String>> {
    let Some(Value::Arr(items)) = value else { return None };
    if items.len() > max_items {
        *over = true;
        return None;
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(string(Some(item), item_max, over)?);
    }
    Some(out)
}

fn numbers(value: Option<&Value>, max_items: usize, over: &mut bool) -> Option<Vec<f64>> {
    let Some(Value::Arr(items)) = value else { return None };
    if items.len() > max_items {
        *over = true;
        return None;
    }
    items
        .iter()
        .map(|item| match item {
            Value::Num(number) if number.is_finite() => Some(*number),
            _ => None,
        })
        .collect()
}

/// An optional prop: absent is fine, present must pass (a null is not a string, Zod's `.optional()`).
fn optional<T>(value: Option<&Value>, parse: impl FnOnce(&Value) -> Option<T>) -> Result<Option<T>, ()> {
    match value {
        None => Ok(None),
        Some(value) => parse(value).map(Some).ok_or(()),
    }
}

fn enum_of<T: Copy>(value: &Value, table: &[(&str, T)]) -> Option<T> {
    match value {
        Value::Str(text) => table.iter().find(|(name, _)| name == text).map(|(_, value)| *value),
        _ => None,
    }
}

/// The Zod check of one element (the `definition.props.safeParse` of `visit`), children first. `None` drops it.
fn check(element: &Element, over: &mut bool) -> Option<Node> {
    let prop = |name: &str| element.prop(name);
    match element.name.as_str() {
        "Stack" => {
            let Some(Value::Arr(items)) = prop("children") else { return None };
            let children = items
                .iter()
                .filter_map(|item| match item {
                    Value::Element(child) => check(child, over),
                    _ => None,
                })
                .collect();
            let direction = optional(prop("direction"), |v| enum_of(v, &[("column", Direction::Column), ("row", Direction::Row)])).ok()?;
            let gap = optional(prop("gap"), |v| enum_of(v, &[("s", Gap::S), ("m", Gap::M), ("l", Gap::L)])).ok()?;
            Some(Node::Stack { children, direction: direction.unwrap_or_default(), gap: gap.unwrap_or_default() })
        }
        "Heading" => {
            let text = string(prop("text"), 200, over)?;
            let level = optional(prop("level"), |v| match v {
                Value::Num(n) if *n == 1.0 || *n == 2.0 || *n == 3.0 => Some(*n as u8),
                _ => None,
            })
            .ok()?;
            Some(Node::Heading { text, level: level.unwrap_or(2) })
        }
        "Text" => {
            let text = string(prop("text"), 4000, over)?;
            let tone = optional(prop("tone"), |v| {
                enum_of(v, &[("default", TextTone::Default), ("muted", TextTone::Muted), ("strong", TextTone::Strong)])
            })
            .ok()?;
            Some(Node::Text { text, tone: tone.unwrap_or_default() })
        }
        "KeyValue" => {
            let Some(Value::Arr(items)) = prop("pairs") else { return None };
            if items.len() > MAX_ROWS {
                *over = true;
                return None;
            }
            let mut pairs = Vec::with_capacity(items.len());
            for item in items {
                // `z.tuple([label, cell])`: exactly two strings.
                let Value::Arr(pair) = item else { return None };
                if pair.len() != 2 {
                    return None;
                }
                pairs.push((string(pair.first(), 200, over)?, string(pair.get(1), 2000, over)?));
            }
            Some(Node::KeyValue { pairs })
        }
        "Table" => {
            let columns = strings(prop("columns"), 200, MAX_COLUMNS, over)?;
            if columns.is_empty() {
                return None;
            }
            let Some(Value::Arr(rows)) = prop("rows") else { return None };
            // `squareRows` first: a row wider than the cap is over it; then every row is one string per column.
            if rows.iter().all(|row| matches!(row, Value::Arr(_)))
                && rows.iter().any(|row| matches!(row, Value::Arr(cells) if cells.len() > MAX_COLUMNS))
            {
                *over = true;
            }
            if rows.len() > MAX_ROWS {
                *over = true;
                return None;
            }
            let mut squared = Vec::with_capacity(rows.len());
            for row in rows {
                let Value::Arr(cells) = row else { return None };
                let mut out = Vec::with_capacity(columns.len());
                for at in 0..columns.len() {
                    let text = match cells.get(at) {
                        None | Some(Value::Null) => String::new(),
                        Some(cell) => lang::to_text(cell),
                    };
                    if too_long(&text, 2000) {
                        *over = true;
                        return None;
                    }
                    out.push(text);
                }
                squared.push(out);
            }
            Some(Node::Table { columns, rows: squared })
        }
        "Callout" => {
            let body = string(prop("body"), 4000, over)?;
            let tone = optional(prop("tone"), |v| {
                enum_of(
                    v,
                    &[
                        ("info", CalloutTone::Info),
                        ("success", CalloutTone::Success),
                        ("warning", CalloutTone::Warning),
                        ("danger", CalloutTone::Danger),
                    ],
                )
            })
            .ok()?;
            let title = optional(prop("title"), |v| string(Some(v), 200, over)).ok()?;
            Some(Node::Callout { body, tone: tone.unwrap_or_default(), title })
        }
        "Progress" => {
            let label = string(prop("label"), 200, over)?;
            match prop("value") {
                Some(Value::Num(value)) if value.is_finite() => Some(Node::Progress { label, value: *value }),
                _ => None,
            }
        }
        "BarChart" | "LineChart" => {
            let labels = strings(prop("labels"), 200, MAX_POINTS, over)?;
            let values = numbers(prop("values"), MAX_POINTS, over)?;
            let title = optional(prop("title"), |v| string(Some(v), 200, over)).ok()?;
            Some(if element.name == "BarChart" {
                Node::BarChart { labels, values, title }
            } else {
                Node::LineChart { labels, values, title }
            })
        }
        "Button" => {
            let label = string(prop("label"), 200, over)?;
            let action = action_of(&label, prop("action")?)?;
            let variant =
                optional(prop("variant"), |v| enum_of(v, &[("primary", ButtonVariant::Primary), ("secondary", ButtonVariant::Secondary)]))
                    .ok()?;
            Some(Node::Button { label, action, variant: variant.unwrap_or_default() })
        }
        _ => None,
    }
}

/// The action union (a plan, `{type: "continue_conversation"}`, or any `{type, params?}`) and what it posts
/// (`genuiActionEvents`): only `continue_conversation` steps with a message do anything; the legacy object posts
/// the button's label.
fn action_of(label: &str, value: &Value) -> Option<Action> {
    match value {
        Value::Plan(steps) => Some(Action {
            messages: steps
                .iter()
                .filter_map(|step| match step {
                    Step::ToAssistant { message, .. } if !message.is_empty() => Some(message.clone()),
                    _ => None,
                })
                .collect(),
        }),
        Value::Obj(entries) => {
            let get = |name: &str| entries.iter().find(|(key, _)| key == name).map(|(_, value)| value);
            if let Some(Value::Arr(steps)) = get("steps") {
                let messages = steps
                    .iter()
                    .filter_map(|step| {
                        let Value::Obj(fields) = step else { return None };
                        let field = |name: &str| fields.iter().find(|(key, _)| key == name).map(|(_, value)| value);
                        match (field("type"), field("message")) {
                            (Some(Value::Str(kind)), Some(Value::Str(message))) if kind == ACTION_TYPE && !message.is_empty() => {
                                Some(message.clone())
                            }
                            _ => None,
                        }
                    })
                    .collect();
                return Some(Action { messages });
            }
            match get("type") {
                Some(Value::Str(kind)) if kind == ACTION_TYPE => Some(Action { messages: vec![label.to_string()] }),
                Some(Value::Str(_)) => Some(Action::default()),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Where each value sits on a `CHART_WIDTH` by `CHART_HEIGHT` canvas (`chartGeometry`).
pub const CHART_WIDTH: f32 = 320.0;
pub const CHART_HEIGHT: f32 = 140.0;
pub const CHART_PAD_TOP: f32 = 8.0;
pub const CHART_PAD_RIGHT: f32 = 8.0;
pub const CHART_PAD_BOTTOM: f32 = 22.0;
pub const CHART_PAD_LEFT: f32 = 8.0;

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub slot: f32,
    pub min: f32,
    pub span: f32,
    pub inner_height: f32,
}

impl Geometry {
    /// `chartGeometry`: zero is on the baseline, the largest value at the top, a flat series on the baseline.
    pub fn of(values: &[f64]) -> Self {
        let max = values.iter().copied().fold(0.0_f64, f64::max) as f32;
        let min = values.iter().copied().fold(0.0_f64, f64::min) as f32;
        let span = if max - min == 0.0 { 1.0 } else { max - min };
        let inner_width = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
        let inner_height = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
        let slot = if values.is_empty() { inner_width } else { inner_width / values.len() as f32 };
        Self { slot, min, span, inner_height }
    }

    pub fn y(&self, value: f64) -> f32 {
        CHART_PAD_TOP + self.inner_height - ((value as f32 - self.min) / self.span) * self.inner_height
    }

    pub fn zero(&self) -> f32 {
        self.y(0.0)
    }
}
