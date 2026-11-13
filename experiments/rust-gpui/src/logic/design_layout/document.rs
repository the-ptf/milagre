//! The design document (`DesignDocument` and `DesignNode` in `packages/shared/src/design.d.mts`), read from its JSON,
//! with the pinned kit resolved as `resolveDesignKit` (`design-kit.mjs`) does before anything lays it out.
//!
//! Reading is lenient where the host is strict: the host has already validated every saved version, so a field of the
//! wrong type is dropped instead of failing the document. Component instances (`componentId`) are not synchronized
//! here; the host stores their generated children, which lay out like any other layer.

use std::collections::HashMap;

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NodeType {
    #[default]
    Frame,
    Text,
    Rectangle,
    Ellipse,
    Image,
    Icon,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SizeMode {
    #[default]
    Fixed,
    Hug,
    Fill,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LayoutMode {
    #[default]
    Free,
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Justify {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// One layer. Optional fields stay `None` when the document leaves them out: the layout reads several defaults
/// differently by context (`padding` only counts in auto layout, `minWidth` only as a floor).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DesignNode {
    pub id: String,
    pub name: Option<String>,
    pub kind: NodeType,
    pub parent_id: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub width_mode: SizeMode,
    pub height_mode: SizeMode,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f64>,
    pub radius: Option<f64>,
    pub opacity: Option<f64>,
    pub text: Option<String>,
    pub font_size: Option<f64>,
    pub font_family: Option<String>,
    pub font_weight: Option<f64>,
    pub line_height: Option<f64>,
    pub text_align: TextAlign,
    pub src: Option<String>,
    pub icon: Option<String>,
    pub layout: LayoutMode,
    pub gap: Option<f64>,
    pub padding: Option<f64>,
    pub align: Align,
    pub justify: Justify,
    pub hidden: bool,
    pub text_style: Option<String>,
    pub bindings: Vec<(String, String)>,
}

impl DesignNode {
    /// The width of the border a stroked text or shape draws inside its box (`strokeWidth`, 1 when unset).
    pub fn border(&self) -> f64 {
        if self.stroke.is_some() { self.stroke_width.unwrap_or(1.0) } else { 0.0 }
    }

    pub fn font_size(&self) -> f64 {
        self.font_size.unwrap_or(16.0)
    }

    pub fn line_height(&self) -> f64 {
        self.line_height.unwrap_or(1.35)
    }
}

/// A text style in a kit (`DesignKit.textStyles`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextStyle {
    pub font_family: Option<String>,
    pub font_size: f64,
    pub font_weight: Option<f64>,
    pub line_height: Option<f64>,
}

/// The pinned visual kit, as far as the layout and the paint need it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DesignKit {
    pub id: String,
    pub version: u32,
    pub title: String,
    pub colors: Vec<(String, String)>,
    pub text_styles: HashMap<String, TextStyle>,
    pub spacing: HashMap<String, f64>,
    pub radii: HashMap<String, f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DesignDocument {
    pub width: f64,
    pub height: f64,
    pub background: Option<String>,
    pub kit: Option<DesignKit>,
    /// `consistency.mode == "strict"`.
    pub strict: bool,
    pub tokens: HashMap<String, String>,
    pub nodes: Vec<DesignNode>,
}

impl DesignDocument {
    /// Reads a document and resolves its kit. Errors name what is missing, as the host's validation would.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("A design document is a JSON object.")?;
        let width = number(object, "width").ok_or("A design document needs a width.")?;
        let height = number(object, "height").ok_or("A design document needs a height.")?;
        let nodes = object
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or("A design document needs nodes.")?
            .iter()
            .map(node_from_json)
            .collect::<Result<Vec<_>, _>>()?;
        let tokens = object
            .get("tokens")
            .and_then(Value::as_object)
            .map(|tokens| tokens.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        let strict = object.get("consistency").and_then(|c| c.get("mode")).and_then(Value::as_str) == Some("strict");
        let mut document = DesignDocument {
            width,
            height,
            background: string(object, "background"),
            kit: object.get("kit").and_then(Value::as_object).map(kit_from_json),
            strict,
            tokens,
            nodes,
        };
        document.resolve_kit()?;
        Ok(document)
    }

    pub fn parse(json: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        Self::from_json(&value)
    }

    /// `resolveDesignKit`: a text style replaces the layer's font fields, bindings set spacing and radius from the
    /// kit, and the kit's colours become tokens the document's own override.
    fn resolve_kit(&mut self) -> Result<(), String> {
        let kit = self.kit.clone();
        for node in &mut self.nodes {
            if (node.text_style.is_some() || !node.bindings.is_empty()) && kit.is_none() {
                return Err(format!("Layer \"{}\" needs a design kit for its style bindings.", node.id));
            }
            let Some(kit) = &kit else { continue };
            if let Some(name) = &node.text_style {
                let style =
                    kit.text_styles.get(name).ok_or_else(|| format!("Text style \"{name}\" does not exist in kit \"{}\".", kit.id))?;
                node.font_family = style.font_family.clone();
                node.font_size = Some(style.font_size);
                node.font_weight = style.font_weight;
                node.line_height = style.line_height;
            }
            for (field, token) in &node.bindings {
                let table = if field == "radius" { &kit.radii } else { &kit.spacing };
                let value = *table.get(token).ok_or_else(|| format!("Kit token \"{token}\" for {}.{field} does not exist.", node.id))?;
                match field.as_str() {
                    "padding" => node.padding = Some(value),
                    "gap" => node.gap = Some(value),
                    "minWidth" => node.min_width = Some(value),
                    "minHeight" => node.min_height = Some(value),
                    "radius" => node.radius = Some(value),
                    _ => {}
                }
            }
        }
        if let Some(kit) = &kit {
            for (name, color) in &kit.colors {
                self.tokens.entry(name.clone()).or_insert_with(|| color.clone());
            }
        }
        Ok(())
    }

    /// `designColor`: a `$token` reads the document's tokens (the fallback when it names none), else the value as is.
    pub fn color<'a>(&'a self, value: Option<&'a str>, fallback: &'a str) -> &'a str {
        match value {
            Some(token) if token.starts_with('$') => self.tokens.get(&token[1..]).map(String::as_str).unwrap_or(fallback),
            Some(value) => value,
            None => fallback,
        }
    }

    /// The kit's label on a design card (`designKitLabel`), or "" without one.
    pub fn kit_label(&self) -> String {
        self.kit
            .as_ref()
            .map(|kit| format!("{}{} · kit v{}", if self.strict { "Strict · " } else { "" }, kit.title, kit.version))
            .unwrap_or_default()
    }

    pub fn node(&self, id: &str) -> Option<&DesignNode> {
        self.nodes.iter().find(|node| node.id == id)
    }
}

fn number(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object.get(key).and_then(Value::as_f64).filter(|value| value.is_finite())
}

fn string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

fn node_from_json(value: &Value) -> Result<DesignNode, String> {
    let object = value.as_object().ok_or("A layer is a JSON object.")?;
    let id = string(object, "id").ok_or("A layer needs an id.")?;
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("frame") => NodeType::Frame,
        Some("text") => NodeType::Text,
        Some("rectangle") => NodeType::Rectangle,
        Some("ellipse") => NodeType::Ellipse,
        Some("image") => NodeType::Image,
        Some("icon") => NodeType::Icon,
        other => return Err(format!("Layer \"{id}\" has an unknown type {other:?}.")),
    };
    let size_mode = |key| match object.get(key).and_then(Value::as_str) {
        Some("hug") => SizeMode::Hug,
        Some("fill") => SizeMode::Fill,
        _ => SizeMode::Fixed,
    };
    Ok(DesignNode {
        name: string(object, "name"),
        kind,
        parent_id: string(object, "parentId"),
        x: number(object, "x"),
        y: number(object, "y"),
        width: number(object, "width").ok_or_else(|| format!("Layer \"{id}\" needs a width."))?,
        height: number(object, "height").ok_or_else(|| format!("Layer \"{id}\" needs a height."))?,
        width_mode: size_mode("widthMode"),
        height_mode: size_mode("heightMode"),
        min_width: number(object, "minWidth"),
        min_height: number(object, "minHeight"),
        fill: string(object, "fill"),
        stroke: string(object, "stroke"),
        stroke_width: number(object, "strokeWidth"),
        radius: number(object, "radius"),
        opacity: number(object, "opacity"),
        text: string(object, "text"),
        font_size: number(object, "fontSize"),
        font_family: string(object, "fontFamily"),
        font_weight: number(object, "fontWeight"),
        line_height: number(object, "lineHeight"),
        text_align: match object.get("textAlign").and_then(Value::as_str) {
            Some("center") => TextAlign::Center,
            Some("right") => TextAlign::Right,
            _ => TextAlign::Left,
        },
        src: string(object, "src"),
        icon: string(object, "icon"),
        layout: match object.get("layout").and_then(Value::as_str) {
            Some("horizontal") => LayoutMode::Horizontal,
            Some("vertical") => LayoutMode::Vertical,
            _ => LayoutMode::Free,
        },
        gap: number(object, "gap"),
        padding: number(object, "padding"),
        align: match object.get("align").and_then(Value::as_str) {
            Some("center") => Align::Center,
            Some("end") => Align::End,
            _ => Align::Start,
        },
        justify: match object.get("justify").and_then(Value::as_str) {
            Some("center") => Justify::Center,
            Some("end") => Justify::End,
            Some("space-between") => Justify::SpaceBetween,
            _ => Justify::Start,
        },
        hidden: object.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        text_style: string(object, "textStyle"),
        bindings: object
            .get("bindings")
            .and_then(Value::as_object)
            .map(|b| b.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
            .unwrap_or_default(),
        id,
    })
}

fn kit_from_json(object: &Map<String, Value>) -> DesignKit {
    let numbers = |key: &str| -> HashMap<String, f64> {
        object
            .get(key)
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect())
            .unwrap_or_default()
    };
    DesignKit {
        id: string(object, "id").unwrap_or_default(),
        version: object.get("version").and_then(Value::as_u64).unwrap_or(1) as u32,
        title: string(object, "title").unwrap_or_default(),
        colors: object
            .get("colors")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
            .unwrap_or_default(),
        text_styles: object
            .get("textStyles")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| {
                        let style = v.as_object()?;
                        Some((
                            k.clone(),
                            TextStyle {
                                font_family: string(style, "fontFamily"),
                                font_size: number(style, "fontSize")?,
                                font_weight: number(style, "fontWeight"),
                                line_height: number(style, "lineHeight"),
                            },
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        spacing: numbers("spacing"),
        radii: numbers("radii"),
    }
}
