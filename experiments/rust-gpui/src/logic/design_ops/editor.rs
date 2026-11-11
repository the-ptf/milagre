//! What the design page editor builds its operations from, ported from `DesignEditor.tsx`, `DesignTools.tsx` and the
//! preview controller (`design-controller-script.mjs`): which layers a selection moves, whether a layer may move,
//! snapping a drag to the screen and the other layers, the layers a toolbar button adds, duplicates, nudges, the
//! drag's final operations, the layer tree, and the undo history.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::components::{by_id, instance_root, str_field};
use super::schema::Node;
use super::{num, op_delete, op_insert, op_update};

/// A layer's box on the design's screen.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// The smallest box around all of them (`union`).
    pub fn union(boxes: &[Rect]) -> Option<Rect> {
        let first = boxes.first()?;
        let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.right(), first.bottom());
        for b in &boxes[1..] {
            x0 = x0.min(b.x);
            y0 = y0.min(b.y);
            x1 = x1.max(b.right());
            y1 = y1.max(b.bottom());
        }
        Some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    }
}

/// `roundCoordinate`: hundredths, halves up as `Math.round` does.
pub fn round_coordinate(value: f64) -> f64 {
    (value * 100.0 + 0.5).floor() / 100.0
}

fn number(node: &Node, key: &str) -> Option<f64> {
    node.get(key).and_then(Value::as_f64)
}

fn flag(node: &Node, key: &str) -> bool {
    node.get(key).and_then(Value::as_bool) == Some(true)
}

/// `selectableIds`: existing layers, each lifted to its instance root, once each.
pub fn selectable_ids(nodes: &[Node], ids: &[String]) -> Vec<String> {
    let index = by_id(nodes);
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !index.contains_key(id.as_str()) {
            continue;
        }
        let root = instance_root(&index, id).and_then(|n| str_field(n, "id")).unwrap_or(id).to_string();
        if !out.contains(&root) {
            out.push(root);
        }
    }
    out
}

/// `selectionRoots`: a selected frame owns its descendants, so a bulk operation never applies twice to a subtree.
pub fn selection_roots(nodes: &[Node], ids: &[String]) -> Vec<String> {
    let selected: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let index = by_id(nodes);
    ids.iter()
        .filter(|id| {
            let Some(node) = index.get(id.as_str()) else { return false };
            let mut parent = str_field(node, "parentId");
            while let Some(p) = parent {
                if selected.contains(p) {
                    return false;
                }
                parent = index.get(p).and_then(|n| str_field(n, "parentId"));
            }
            true
        })
        .cloned()
        .collect()
}

/// Whether neither the layer nor a frame around it is locked.
pub fn unlocked(nodes: &[Node], id: &str) -> bool {
    let index = by_id(nodes);
    let mut node = index.get(id).copied();
    if node.is_none() {
        return false;
    }
    while let Some(current) = node {
        if flag(current, "locked") {
            return false;
        }
        node = str_field(current, "parentId").and_then(|p| index.get(p).copied());
    }
    true
}

/// `movable`: unlocked, in a free-layout parent (an auto-layout frame places its children itself).
pub fn movable(nodes: &[Node], id: &str) -> bool {
    let index = by_id(nodes);
    let parent = index.get(id).and_then(|n| str_field(n, "parentId")).and_then(|p| index.get(p));
    if parent.and_then(|p| str_field(p, "layout")).is_some_and(|l| l != "free") {
        return false;
    }
    unlocked(nodes, id)
}

/// Where a snap moved the drag, and the guide it draws.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Snap {
    pub delta: f64,
    pub line: Option<f64>,
}

/// The controller's `snap`: the nearest of the screen's edges and middle, and every other layer's edges and middle,
/// within 6px of one of `values`. `bounds` are the laid-out boxes in paint order; layers in `excluded` or under one
/// are not targets.
pub fn snap(axis_x: bool, values: &[f64], excluded: &HashSet<String>, size: (f64, f64), nodes: &[Node], bounds: &[(String, Rect)]) -> Snap {
    let index = by_id(nodes);
    let mut best = Snap { delta: 0.0, line: None };
    let mut distance = 6.0;
    let extent = if axis_x { size.0 } else { size.1 };
    let mut candidates = vec![0.0, extent / 2.0, extent];
    for (id, rect) in bounds {
        let mut node = index.get(id.as_str()).copied();
        let mut skip = false;
        while let Some(current) = node {
            if str_field(current, "id").is_some_and(|i| excluded.contains(i)) {
                skip = true;
                break;
            }
            node = str_field(current, "parentId").and_then(|p| index.get(p).copied());
        }
        if skip {
            continue;
        }
        let (start, length) = if axis_x { (rect.x, rect.width) } else { (rect.y, rect.height) };
        candidates.extend([start, start + length / 2.0, start + length]);
    }
    for candidate in candidates {
        for value in values {
            let delta = candidate - value;
            if delta.abs() < distance {
                distance = delta.abs();
                best = Snap { delta, line: Some(candidate) };
            }
        }
    }
    best
}

/// A drag on the canvas, in design pixels from where it started.
#[derive(Clone, Debug, PartialEq)]
pub struct DragResult {
    pub dx: f64,
    pub dy: f64,
    pub guides: (Option<f64>, Option<f64>),
}

/// The controller's move step: the pointer's offset, rounded, then snapped on each axis unless Option is held. A
/// move snaps the selection's left, middle and right (top, middle, bottom); a resize its far edges.
#[allow(clippy::too_many_arguments)]
pub fn drag_step(
    box_: Rect,
    raw: (f64, f64),
    resizing: bool,
    no_snap: bool,
    excluded: &HashSet<String>,
    size: (f64, f64),
    nodes: &[Node],
    bounds: &[(String, Rect)],
) -> DragResult {
    let (mut dx, mut dy) = (js_round(raw.0), js_round(raw.1));
    if no_snap {
        return DragResult { dx, dy, guides: (None, None) };
    }
    let xs: Vec<f64> =
        if resizing { vec![box_.right() + dx] } else { vec![box_.x + dx, box_.x + box_.width / 2.0 + dx, box_.right() + dx] };
    let ys: Vec<f64> =
        if resizing { vec![box_.bottom() + dy] } else { vec![box_.y + dy, box_.y + box_.height / 2.0 + dy, box_.bottom() + dy] };
    let sx = snap(true, &xs, excluded, size, nodes, bounds);
    let sy = snap(false, &ys, excluded, size, nodes, bounds);
    dx += sx.delta;
    dy += sy.delta;
    DragResult { dx, dy, guides: (sx.line, sy.line) }
}

/// `Math.round`: halves toward positive infinity.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Whether a drag has gone far enough to count (`|dx| + |dy| > 2`).
pub fn drag_moved(dx: f64, dy: f64) -> bool {
    dx.abs() + dy.abs() > 2.0
}

/// The controller's `finish`: a move updates each target's x and y; a resize its fixed width and height.
pub fn drag_operations(nodes: &[Node], targets: &[(String, Rect)], dx: f64, dy: f64, resizing: bool) -> Vec<Value> {
    let index = by_id(nodes);
    targets
        .iter()
        .filter_map(|(id, rect)| {
            let node = index.get(id.as_str())?;
            let mut patch = Map::new();
            if resizing {
                let min_w = number(node, "minWidth").unwrap_or(1.0);
                let min_h = number(node, "minHeight").unwrap_or(1.0);
                patch.insert("width".into(), num(1f64.max(min_w).max(16000f64.min(rect.width + dx))));
                patch.insert("height".into(), num(1f64.max(min_h).max(16000f64.min(rect.height + dy))));
                patch.insert("widthMode".into(), "fixed".into());
                patch.insert("heightMode".into(), "fixed".into());
            } else {
                patch.insert("x".into(), num((number(node, "x").unwrap_or(0.0) + dx).clamp(-32000.0, 32000.0)));
                patch.insert("y".into(), num((number(node, "y").unwrap_or(0.0) + dy).clamp(-32000.0, 32000.0)));
            }
            Some(op_update(id, patch))
        })
        .collect()
}

/// The editor's `move` (arrow keys, the selection's X and Y): every selection root by the same offset, or nothing when
/// one of them can't move.
pub fn move_operations(nodes: &[Node], selected: &[String], dx: f64, dy: f64) -> Vec<Value> {
    let roots = selection_roots(nodes, selected);
    if !roots.iter().all(|id| movable(nodes, id)) {
        return Vec::new();
    }
    let index = by_id(nodes);
    roots
        .iter()
        .filter_map(|id| {
            let node = index.get(id.as_str())?;
            let mut patch = Map::new();
            patch.insert("x".into(), num(round_coordinate(number(node, "x").unwrap_or(0.0) + dx)));
            patch.insert("y".into(), num(round_coordinate(number(node, "y").unwrap_or(0.0) + dy)));
            Some(op_update(id, patch))
        })
        .collect()
}

/// The layer types the tool rail adds, in its order, with their labels.
pub const TOOLS: [(&str, &str); 6] = [
    ("frame", "Add frame"),
    ("rectangle", "Add rectangle"),
    ("ellipse", "Add ellipse"),
    ("text", "Add text"),
    ("image", "Add image"),
    ("icon", "Add icon"),
];

/// The default name of a new layer of a type.
pub fn type_name(kind: &str) -> &'static str {
    match kind {
        "text" => "Text",
        "frame" => "Frame",
        "image" => "Image",
        "icon" => "Icon",
        "ellipse" => "Ellipse",
        _ => "Rectangle",
    }
}

/// The editor's `add`: a new layer at 32, 32 with the desktop's defaults.
pub fn new_node(kind: &str, id: &str) -> Value {
    let mut node = Map::new();
    node.insert("id".into(), id.into());
    node.insert("name".into(), type_name(kind).into());
    node.insert("type".into(), kind.into());
    node.insert("x".into(), 32.into());
    node.insert("y".into(), 32.into());
    let (w, h) = match kind {
        "text" => (240, 44),
        "icon" => (24, 24),
        _ => (160, 120),
    };
    node.insert("width".into(), w.into());
    node.insert("height".into(), h.into());
    match kind {
        "text" => {
            node.insert("text".into(), "New text".into());
            node.insert("fontSize".into(), 24.into());
            node.insert("fill".into(), "#1f2937".into());
        }
        "icon" => {
            node.insert("icon".into(), "star".into());
            node.insert("fill".into(), "#1f2937".into());
            node.insert("strokeWidth".into(), 2.into());
        }
        _ => {
            node.insert("fill".into(), "#dce6df".into());
            node.insert("radius".into(), 12.into());
        }
    }
    if kind == "frame" {
        node.insert("layout".into(), "free".into());
    }
    Value::Object(node)
}

/// The editor's `duplicate`: inserts copying each selection root and its subtree (not an instance's generated
/// layers), the roots named "… copy" 16px down and right. `new_id` makes an id for a layer type. Returns the
/// operations and the copies of the roots, to select.
pub fn duplicate_operations(nodes: &[Node], selected: &[String], mut new_id: impl FnMut(&str) -> String) -> (Vec<Value>, Vec<String>) {
    let roots = selection_roots(nodes, selected);
    if roots.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let index = by_id(nodes);
    let root_set: HashSet<&str> = roots.iter().map(String::as_str).collect();
    let mut descendants: HashSet<String> = roots.iter().cloned().collect();
    let mut added = true;
    while added {
        added = false;
        for node in nodes {
            let id = str_field(node, "id").unwrap_or("");
            if let Some(parent) = str_field(node, "parentId")
                && descendants.contains(parent)
                && !index.get(parent).is_some_and(|p| p.get("componentId").is_some_and(|c| !c.is_null()))
                && !descendants.contains(id)
            {
                descendants.insert(id.to_string());
                added = true;
            }
        }
    }
    let mut ids: HashMap<String, String> = HashMap::new();
    for node in nodes {
        let id = str_field(node, "id").unwrap_or("");
        if descendants.contains(id) {
            ids.insert(id.to_string(), new_id(str_field(node, "type").unwrap_or("frame")));
        }
    }
    let operations = nodes
        .iter()
        .filter(|n| descendants.contains(str_field(n, "id").unwrap_or("")))
        .map(|node| {
            let id = str_field(node, "id").unwrap_or("");
            let mut copy = node.clone();
            copy.insert("id".into(), ids[id].clone().into());
            if root_set.contains(id) {
                let name = str_field(node, "name").or_else(|| str_field(node, "type")).unwrap_or("");
                copy.insert("name".into(), format!("{name} copy").into());
                copy.insert("x".into(), num(number(node, "x").unwrap_or(0.0) + 16.0));
                copy.insert("y".into(), num(number(node, "y").unwrap_or(0.0) + 16.0));
            }
            for key in ["parentId", "componentId", "componentSourceId"] {
                if let Some(v) = str_field(node, key) {
                    copy.insert(key.into(), ids.get(v).cloned().unwrap_or_else(|| v.to_string()).into());
                }
            }
            op_insert(Value::Object(copy), None)
        })
        .collect();
    (operations, roots.iter().map(|r| ids[r].clone()).collect())
}

/// The editor's `remove`: one delete per selection root.
pub fn delete_operations(nodes: &[Node], selected: &[String]) -> Vec<Value> {
    selection_roots(nodes, selected).iter().map(|id| op_delete(id)).collect()
}

/// One row of the layer tree (`DesignTools`): parents before children, collapsed subtrees left out.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub depth: usize,
    pub has_children: bool,
    pub hidden: bool,
    pub component: bool,
    pub instance: bool,
}

/// The layer tree's rows: each root in document order, then its children.
pub fn layer_rows(nodes: &[Node], collapsed: &HashSet<String>) -> Vec<LayerRow> {
    let mut children: HashMap<Option<&str>, Vec<&Node>> = HashMap::new();
    for node in nodes {
        children.entry(str_field(node, "parentId")).or_default().push(node);
    }
    let mut rows = Vec::new();
    fn visit<'a>(
        node: &'a Node,
        depth: usize,
        children: &HashMap<Option<&'a str>, Vec<&'a Node>>,
        collapsed: &HashSet<String>,
        rows: &mut Vec<LayerRow>,
    ) {
        let id = str_field(node, "id").unwrap_or("");
        let nested = children.get(&Some(id)).map(Vec::as_slice).unwrap_or(&[]);
        rows.push(LayerRow {
            id: id.to_string(),
            name: str_field(node, "name").unwrap_or(id).to_string(),
            kind: str_field(node, "type").unwrap_or("").to_string(),
            depth,
            has_children: !nested.is_empty(),
            hidden: flag(node, "hidden"),
            component: flag(node, "component"),
            instance: node.get("componentId").is_some_and(|c| c.as_str().is_some_and(|c| !c.is_empty())),
        });
        if !collapsed.contains(id) {
            for child in nested {
                visit(child, depth + 1, children, collapsed, rows);
            }
        }
    }
    for root in children.get(&None).map(Vec::as_slice).unwrap_or(&[]) {
        visit(root, 0, &children, collapsed, &mut rows);
    }
    rows
}

/// The glyph before a layer's name in the tree.
pub fn layer_glyph(row: &LayerRow) -> &'static str {
    if row.component {
        "◆"
    } else if row.instance {
        "◇"
    } else {
        match row.kind.as_str() {
            "text" => "T",
            "frame" => "#",
            "image" => "▧",
            "icon" => "✦",
            "ellipse" => "○",
            _ => "□",
        }
    }
}

/// A draft's undo history (`DesignHistory`): at most 100 steps back.
#[derive(Clone, Debug, PartialEq)]
pub struct History {
    pub past: Vec<Value>,
    pub present: Value,
    pub future: Vec<Value>,
}

impl History {
    pub const LIMIT: usize = 100;

    pub fn new(present: Value) -> Self {
        Self { past: Vec::new(), present, future: Vec::new() }
    }

    /// A new document after an edit: the old one goes on the past (keeping the last 100), the future is dropped.
    pub fn push(&mut self, next: Value) {
        let present = std::mem::replace(&mut self.present, next);
        self.past.push(present);
        if self.past.len() > Self::LIMIT {
            let drop = self.past.len() - Self::LIMIT;
            self.past.drain(..drop);
        }
        self.future.clear();
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.past.pop() else { return false };
        let present = std::mem::replace(&mut self.present, previous);
        self.future.insert(0, present);
        true
    }

    pub fn redo(&mut self) -> bool {
        if self.future.is_empty() {
            return false;
        }
        let next = self.future.remove(0);
        let present = std::mem::replace(&mut self.present, next);
        self.past.push(present);
        true
    }
}
