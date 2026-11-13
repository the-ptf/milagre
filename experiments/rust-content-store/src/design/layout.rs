//! Browser-independent layout and measured line wrapping from the shared model.
use super::*;
use std::{cell::RefCell, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

pub(super) fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("render-data.json")).expect("Design renderer data")
    })
}
pub(super) fn number(node: &Value, field: &str, default: f64) -> f64 {
    node[field].as_f64().unwrap_or(default)
}
pub(super) fn round(value: f64) -> f64 {
    (value * 1000.0 + 0.5).floor() / 1000.0
}
pub(super) fn inter(node: &Value) -> bool {
    node["fontFamily"]
        .as_str()
        .unwrap_or("Inter, Arial, sans-serif")
        .split(',')
        .next()
        .unwrap()
        .trim()
        .eq_ignore_ascii_case("inter")
}
pub(super) fn catalog(node: &Value) -> Option<&'static Value> {
    data()["catalog"].get(
        node["fontFamily"]
            .as_str()?
            .split(',')
            .next()?
            .trim()
            .to_lowercase(),
    )
}
pub(super) fn nearest(weights: &[f64], requested: f64) -> f64 {
    weights
        .iter()
        .copied()
        .min_by(|a, b| {
            (a - requested)
                .abs()
                .total_cmp(&(b - requested).abs())
                .then(a.total_cmp(b))
        })
        .unwrap()
}
#[derive(Debug, Clone)]
pub struct TextLayout {
    pub lines: Vec<String>,
    pub width: f64,
    pub height: f64,
    pub line_height: f64,
}
fn clusters(text: &str) -> Vec<&str> {
    UnicodeSegmentation::graphemes(text, true).collect()
}
pub fn text_layout(node: &Value, width: f64) -> TextLayout {
    let family = node["fontFamily"]
        .as_str()
        .unwrap_or("Inter")
        .to_lowercase();
    let entry = if inter(node) { None } else { catalog(node) };
    let kind = if inter(node) {
        "inter"
    } else if entry.is_some() {
        "catalog"
    } else if family.contains("courier") || family.contains("mono") {
        "mono"
    } else if family.contains("times") {
        "times"
    } else if family.contains("georgia")
        || family
            .match_indices("serif")
            .any(|(at, _)| !family[..at].ends_with("sans-"))
    {
        "serif"
    } else {
        "sans"
    };
    let measured = entry
        .map(|entry| &entry["advances"])
        .unwrap_or(&data()["metrics"][kind]);
    let weights = object(measured)
        .keys()
        .filter_map(|key| key.parse::<f64>().ok())
        .collect::<Vec<_>>();
    let weight = nearest(&weights, number(node, "fontWeight", 400.0));
    let weight = jsjson::to_string(&json!(weight));
    let advances = &measured[&weight];
    let size = number(node, "fontSize", 16.0);
    let extras = data()["extra"]
        .as_str()
        .unwrap()
        .chars()
        .collect::<Vec<_>>();
    static MARKS: OnceLock<regex::Regex> = OnceLock::new();
    let marks = MARKS.get_or_init(|| regex::Regex::new(r"\p{M}").unwrap());
    let mut cache = BTreeMap::<String, f64>::new();
    let mut advance = |character: &str| -> f64 {
        if let Some(value) = cache.get(character) {
            return *value;
        }
        let first = character.chars().next();
        let extra = if character.chars().count() == 1 {
            if let Some(entry) = entry {
                extras
                    .iter()
                    .position(|point| Some(*point) == first)
                    .and_then(|index| entry["advances"][&weight][95 + index].as_f64())
            } else {
                first.and_then(|first| {
                    data()["metrics"][kind]["extra"][&weight][(first as u32).to_string()].as_f64()
                })
            }
        } else {
            None
        };
        let value = if let Some(value) = extra {
            value * size
        } else {
            let decomposed = character.nfd().collect::<String>();
            let plain = marks.replace_all(&decomposed, "");
            match plain.chars().next() {
                None => 0.0,
                Some(base) if (' '..='~').contains(&base) => {
                    advances[base as usize - 32].as_f64().unwrap() * size
                }
                Some(base) => {
                    if base as u32 >= 0x2e80 {
                        size
                    } else {
                        0.65 * size
                    }
                }
            }
        };
        cache.insert(character.to_owned(), value);
        value
    };
    let source = utf8(node["text"].as_str().unwrap_or(""))
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', "    ")
        .nfc()
        .collect::<String>();
    let limit = width.max(1.0);
    let mut lines = Vec::new();
    for paragraph in source.split('\n') {
        let mut parts = Vec::new();
        let mut start = 0;
        let mut previous = None;
        for (index, c) in paragraph.char_indices() {
            let space = crate::validation::whitespace(c);
            if previous.is_some_and(|previous| previous != space) {
                parts.push(&paragraph[start..index]);
                start = index;
            }
            previous = Some(space);
        }
        if !paragraph.is_empty() {
            parts.push(&paragraph[start..]);
        }
        let mut line = String::new();
        let mut used = 0.0;
        for part in parts {
            let part_width = clusters(part).into_iter().map(&mut advance).sum::<f64>();
            if part.chars().any(|c| !crate::validation::whitespace(c))
                && !trim(&line).is_empty()
                && used + part_width > limit + 0.001
            {
                lines.push(
                    line.trim_end_matches(crate::validation::whitespace)
                        .to_owned(),
                );
                line.clear();
                used = 0.0;
            }
            for character in clusters(part) {
                let next = advance(character);
                if !line.is_empty() && used + next > limit + 0.001 {
                    lines.push(
                        line.trim_end_matches(crate::validation::whitespace)
                            .to_owned(),
                    );
                    line.clear();
                    used = 0.0;
                    if character.chars().any(crate::validation::whitespace) {
                        continue;
                    }
                }
                line.push_str(character);
                used += next;
            }
        }
        lines.push(line);
    }
    let measured_width = lines
        .iter()
        .map(|line| clusters(line).into_iter().map(&mut advance).sum::<f64>())
        .fold(0.0, f64::max);
    let line_height = size * number(node, "lineHeight", 1.35);
    TextLayout {
        width: round(measured_width),
        height: round(lines.len() as f64 * line_height),
        lines,
        line_height,
    }
}
#[derive(Clone)]
struct Size {
    width: f64,
    height: f64,
    children: Vec<(usize, Size)>,
}
#[derive(Debug, Clone)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    pub fn value(&self) -> Value {
        json!({"x":self.x,"y":self.y,"width":self.width,"height":self.height})
    }
}
type MeasureKey = (usize, Option<u64>, Option<u64>);
struct Layout<'a> {
    nodes: &'a [Value],
    children: BTreeMap<String, Vec<usize>>,
    cache: RefCell<BTreeMap<MeasureKey, Size>>,
}
fn bounded(value: f64, minimum: f64) -> f64 {
    1.0f64.max(minimum).max(value.min(16000.0))
}
impl Layout<'_> {
    fn arrange(
        &self,
        node: &Value,
        nested: &[usize],
        width: f64,
        height: Option<f64>,
    ) -> Vec<(usize, Size)> {
        let mode = node["layout"].as_str().unwrap_or("free");
        let horizontal = mode == "horizontal";
        let automatic = mode != "free";
        let padding = if automatic {
            number(node, "padding", 0.0)
        } else {
            0.0
        };
        let gap = if automatic {
            number(node, "gap", 0.0)
        } else {
            0.0
        };
        let content_width = (width - 2.0 * padding).max(1.0);
        let content_height = height.map(|height| (height - 2.0 * padding).max(1.0));
        let cross_width = |child: &Value| {
            if child["widthMode"] == "fill" && !horizontal {
                Some(content_width)
            } else {
                None
            }
        };
        let cross_height = |child: &Value| {
            if child["heightMode"] == "fill" && mode != "vertical" {
                content_height
            } else {
                None
            }
        };
        let mut sizes = nested
            .iter()
            .map(|&index| {
                let child = &self.nodes[index];
                (
                    index,
                    self.measure(index, cross_width(child), cross_height(child)),
                )
            })
            .collect::<Vec<_>>();
        let axis = if horizontal {
            "widthMode"
        } else {
            "heightMode"
        };
        let room = if horizontal {
            Some(content_width)
        } else {
            content_height
        };
        if let Some(room) = room.filter(|_| automatic && node[axis] != "hug") {
            let mut pending = sizes
                .iter()
                .filter(|(index, _)| self.nodes[*index][axis] == "fill")
                .map(|(index, _)| *index)
                .collect::<Vec<_>>();
            let fixed = sizes
                .iter()
                .filter(|(index, _)| self.nodes[*index][axis] != "fill")
                .map(|(_, size)| if horizontal { size.width } else { size.height })
                .sum::<f64>();
            let mut remaining =
                (room - fixed - sizes.len().saturating_sub(1) as f64 * gap).max(0.0);
            let mut allocation = BTreeMap::new();
            while !pending.is_empty() {
                let share = remaining / pending.len() as f64;
                let constrained = pending
                    .iter()
                    .copied()
                    .filter(|&index| {
                        number(
                            &self.nodes[index],
                            if horizontal { "minWidth" } else { "minHeight" },
                            1.0,
                        ) > share
                    })
                    .collect::<Vec<_>>();
                if constrained.is_empty() {
                    for index in pending {
                        allocation.insert(index, share.max(1.0));
                    }
                    break;
                }
                for index in constrained {
                    let minimum = number(
                        &self.nodes[index],
                        if horizontal { "minWidth" } else { "minHeight" },
                        1.0,
                    );
                    allocation.insert(index, minimum);
                    remaining = (remaining - minimum).max(0.0);
                }
                pending.retain(|index| !allocation.contains_key(index));
            }
            for (index, size) in &mut sizes {
                if let Some(allocation) = allocation.get(index) {
                    let child = &self.nodes[*index];
                    *size = self.measure(
                        *index,
                        if horizontal {
                            Some(*allocation)
                        } else {
                            cross_width(child)
                        },
                        if horizontal {
                            cross_height(child)
                        } else {
                            Some(*allocation)
                        },
                    );
                }
            }
        }
        sizes
    }
    fn measure(&self, index: usize, force_width: Option<f64>, force_height: Option<f64>) -> Size {
        let key = (
            index,
            force_width.map(f64::to_bits),
            force_height.map(f64::to_bits),
        );
        if let Some(size) = self.cache.borrow().get(&key) {
            return size.clone();
        }
        let node = &self.nodes[index];
        let nested = self
            .children
            .get(&sid(node, "id"))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mode = node["layout"].as_str().unwrap_or("free");
        let automatic = mode != "free";
        let horizontal = mode == "horizontal";
        let padding = if automatic {
            number(node, "padding", 0.0)
        } else {
            0.0
        };
        let gap = if automatic {
            number(node, "gap", 0.0)
        } else {
            0.0
        };
        let mut width = if node["widthMode"] == "fill" {
            force_width.unwrap_or(number(node, "width", 1.0))
        } else {
            number(node, "width", 1.0)
        };
        if node["widthMode"] == "hug" {
            if node["type"] == "text" {
                width = text_layout(node, f64::INFINITY).width
                    + 2.0
                        * if yes(node, "stroke") {
                            number(node, "strokeWidth", 1.0)
                        } else {
                            0.0
                        };
            }
            if node["type"] == "frame" {
                let sizes = nested
                    .iter()
                    .map(|&index| (index, self.measure(index, None, None)))
                    .collect::<Vec<_>>();
                width = 2.0 * padding
                    + if horizontal {
                        sizes.iter().map(|(_, size)| size.width).sum::<f64>()
                            + sizes.len().saturating_sub(1) as f64 * gap
                    } else {
                        sizes
                            .iter()
                            .map(|(index, size)| {
                                size.width
                                    + if automatic {
                                        0.0
                                    } else {
                                        number(&self.nodes[*index], "x", 0.0)
                                    }
                            })
                            .fold(0.0, f64::max)
                    };
            }
        }
        width = bounded(width, number(node, "minWidth", 0.0));
        let mut height = bounded(
            if node["heightMode"] == "fill" {
                force_height.unwrap_or(number(node, "height", 1.0))
            } else {
                number(node, "height", 1.0)
            },
            number(node, "minHeight", 0.0),
        );
        let mut children = if node["type"] == "frame" {
            self.arrange(
                node,
                nested,
                width,
                if node["heightMode"] == "hug" {
                    None
                } else {
                    Some(height)
                },
            )
        } else {
            vec![]
        };
        if node["heightMode"] == "hug" {
            if node["type"] == "text" {
                let stroke = if yes(node, "stroke") {
                    number(node, "strokeWidth", 1.0)
                } else {
                    0.0
                };
                height = text_layout(node, (width - 2.0 * stroke).max(1.0)).height + 2.0 * stroke;
            }
            if node["type"] == "frame" {
                height = 2.0 * padding
                    + if mode == "vertical" {
                        children.iter().map(|(_, size)| size.height).sum::<f64>()
                            + children.len().saturating_sub(1) as f64 * gap
                    } else {
                        children
                            .iter()
                            .map(|(index, size)| {
                                size.height
                                    + if automatic {
                                        0.0
                                    } else {
                                        number(&self.nodes[*index], "y", 0.0)
                                    }
                            })
                            .fold(0.0, f64::max)
                    };
            }
            height = bounded(height, number(node, "minHeight", 0.0));
            if node["type"] == "frame" {
                children = self.arrange(node, nested, width, Some(height));
            }
        }
        let size = Size {
            width: round(width),
            height: round(height),
            children,
        };
        self.cache.borrow_mut().insert(key, size.clone());
        size
    }
    fn place(
        &self,
        index: usize,
        size: &Size,
        x: f64,
        y: f64,
        bounds: &mut BTreeMap<String, Bounds>,
    ) {
        let node = &self.nodes[index];
        bounds.insert(
            sid(node, "id"),
            Bounds {
                x: round(x),
                y: round(y),
                width: size.width,
                height: size.height,
            },
        );
        let mode = node["layout"].as_str().unwrap_or("free");
        let horizontal = mode == "horizontal";
        let automatic = mode != "free";
        let padding = if automatic {
            number(node, "padding", 0.0)
        } else {
            0.0
        };
        let mut gap = number(node, "gap", 0.0);
        let mut cursor = padding;
        if automatic {
            let occupied = size
                .children
                .iter()
                .map(|(_, size)| if horizontal { size.width } else { size.height })
                .sum::<f64>()
                + size.children.len().saturating_sub(1) as f64 * gap;
            let available = if horizontal { size.width } else { size.height } - 2.0 * padding;
            let remainder = (available - occupied).max(0.0);
            if node["justify"] == "center" {
                cursor += remainder / 2.0;
            }
            if node["justify"] == "end" {
                cursor += remainder;
            }
            if node["justify"] == "space-between" && size.children.len() > 1 {
                gap += remainder / (size.children.len() - 1) as f64;
            }
        }
        for (index, size) in &size.children {
            let child = &self.nodes[*index];
            let (mut left, mut top) = (number(child, "x", 0.0), number(child, "y", 0.0));
            if automatic {
                let space = (if horizontal {
                    number_from_size(node, "height", bounds) - size.height
                } else {
                    number_from_size(node, "width", bounds) - size.width
                }) - 2.0 * padding;
                let cross = padding
                    + if node["align"] == "center" {
                        space / 2.0
                    } else if node["align"] == "end" {
                        space
                    } else {
                        0.0
                    };
                left = if horizontal { cursor } else { cross };
                top = if horizontal { cross } else { cursor };
                cursor += if horizontal { size.width } else { size.height } + gap;
            }
            self.place(*index, size, x + left, y + top, bounds);
        }
    }
}
fn number_from_size(node: &Value, field: &str, bounds: &BTreeMap<String, Bounds>) -> f64 {
    let bounds = &bounds[&sid(node, "id")];
    if field == "width" {
        bounds.width
    } else {
        bounds.height
    }
}
pub fn layout(document: &Value) -> Result<BTreeMap<String, Bounds>> {
    let document = validate_document(document)?;
    let mut children = BTreeMap::<String, Vec<usize>>::new();
    for (index, node) in nodes(&document).iter().enumerate() {
        if !yes(node, "hidden") {
            children
                .entry(sid(node, "parentId"))
                .or_default()
                .push(index);
        }
    }
    let engine = Layout {
        nodes: nodes(&document),
        children,
        cache: RefCell::new(BTreeMap::new()),
    };
    let mut bounds = BTreeMap::new();
    for &index in engine.children.get("").map(Vec::as_slice).unwrap_or(&[]) {
        let node = &engine.nodes[index];
        let size = engine.measure(
            index,
            Some(number(&document, "width", 1.0)),
            Some(number(&document, "height", 1.0)),
        );
        engine.place(
            index,
            &size,
            number(node, "x", 0.0),
            number(node, "y", 0.0),
            &mut bounds,
        );
    }
    Ok(bounds)
}
