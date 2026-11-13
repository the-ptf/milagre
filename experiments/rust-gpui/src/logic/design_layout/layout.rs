//! `designLayout` (`design-layout.mjs`): fixed sizes as stored, hug measures content, fill shares the room left in
//! an auto-layout row or column. Every number is rounded to thousandths where the TS rounds, so the boxes match it
//! exactly (`tests.rs` checks them against the TS run through node).

use std::collections::HashMap;

use super::document::{Align, DesignDocument, DesignNode, Justify, LayoutMode, NodeType, SizeMode};
use super::js_round;
use super::text::text_layout;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x <= self.x + self.width && y <= self.y + self.height
    }
}

/// Every visible layer's box in screen coordinates, in paint order (a parent before its children).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layout {
    pub order: Vec<(usize, Bounds)>,
    index: HashMap<usize, usize>,
}

impl Layout {
    /// The box of node `index` in the document, if it is laid out (not hidden, nor under a hidden frame).
    pub fn get(&self, node: usize) -> Option<Bounds> {
        self.index.get(&node).map(|i| self.order[*i].1)
    }
}

/// `Math.max(1, minimum, Math.min(16000, value))`.
fn bounded(value: f64, minimum: Option<f64>) -> f64 {
    1f64.max(minimum.unwrap_or(0.0)).max(value.min(16000.0))
}

#[derive(Clone, Debug)]
struct Size {
    width: f64,
    height: f64,
    children: Vec<(usize, Size)>,
}

struct Engine<'a> {
    nodes: &'a [DesignNode],
    children: HashMap<Option<&'a str>, Vec<usize>>,
    cache: HashMap<(usize, Option<u64>, Option<u64>), Size>,
}

impl<'a> Engine<'a> {
    fn axis_mode(node: &DesignNode, horizontal: bool) -> SizeMode {
        if horizontal { node.width_mode } else { node.height_mode }
    }

    fn measure(&mut self, index: usize, force_width: Option<f64>, force_height: Option<f64>) -> Size {
        let key = (index, force_width.map(f64::to_bits), force_height.map(f64::to_bits));
        if let Some(size) = self.cache.get(&key) {
            return size.clone();
        }
        let node = &self.nodes[index];
        let nested = self.children.get(&Some(node.id.as_str())).cloned().unwrap_or_default();
        let mode = node.layout;
        let automatic = mode != LayoutMode::Free;
        let horizontal = mode == LayoutMode::Horizontal;
        let padding = if automatic { node.padding.unwrap_or(0.0) } else { 0.0 };
        let gap = if automatic { node.gap.unwrap_or(0.0) } else { 0.0 };
        let mut width = if node.width_mode == SizeMode::Fill { force_width.unwrap_or(node.width) } else { node.width };
        if node.width_mode == SizeMode::Hug {
            if node.kind == NodeType::Text {
                width = text_layout(node, f64::INFINITY).width + 2.0 * node.border();
            }
            if node.kind == NodeType::Frame {
                let sizes: Vec<(usize, Size)> = nested.iter().map(|&child| (child, self.measure(child, None, None))).collect();
                width = 2.0 * padding
                    + if horizontal {
                        sizes.iter().fold(0.0, |sum, (_, size)| sum + size.width) + (sizes.len().saturating_sub(1)) as f64 * gap
                    } else {
                        sizes.iter().fold(0.0, |max: f64, (child, size)| {
                            max.max(size.width + if automatic { 0.0 } else { self.nodes[*child].x.unwrap_or(0.0) })
                        })
                    };
            }
        }
        width = bounded(width, node.min_width);
        let mut height =
            bounded(if node.height_mode == SizeMode::Fill { force_height.unwrap_or(node.height) } else { node.height }, node.min_height);
        let mut sizes = if node.kind == NodeType::Frame {
            self.arrange(index, &nested, width, if node.height_mode == SizeMode::Hug { None } else { Some(height) })
        } else {
            Vec::new()
        };
        if node.height_mode == SizeMode::Hug {
            if node.kind == NodeType::Text {
                let stroke = node.border();
                height = text_layout(node, (width - 2.0 * stroke).max(1.0)).height + 2.0 * stroke;
            }
            if node.kind == NodeType::Frame {
                height = 2.0 * padding
                    + if mode == LayoutMode::Vertical {
                        sizes.iter().fold(0.0, |sum, (_, size)| sum + size.height) + (sizes.len().saturating_sub(1)) as f64 * gap
                    } else {
                        sizes.iter().fold(0.0, |max: f64, (child, size)| {
                            max.max(size.height + if automatic { 0.0 } else { self.nodes[*child].y.unwrap_or(0.0) })
                        })
                    };
            }
            height = bounded(height, node.min_height);
            if node.kind == NodeType::Frame {
                sizes = self.arrange(index, &nested, width, Some(height));
            }
        }
        let size = Size { width: js_round(width), height: js_round(height), children: sizes };
        self.cache.insert(key, size.clone());
        size
    }

    fn arrange(&mut self, index: usize, nested: &[usize], width: f64, frame_height: Option<f64>) -> Vec<(usize, Size)> {
        let node = &self.nodes[index];
        let mode = node.layout;
        let automatic = mode != LayoutMode::Free;
        let horizontal = mode == LayoutMode::Horizontal;
        let padding = if automatic { node.padding.unwrap_or(0.0) } else { 0.0 };
        let gap = if automatic { node.gap.unwrap_or(0.0) } else { 0.0 };
        let content_width = (width - 2.0 * padding).max(1.0);
        let content_height = frame_height.map(|h| (h - 2.0 * padding).max(1.0));
        let nodes = self.nodes;
        let cross_width = |child: usize| (nodes[child].width_mode == SizeMode::Fill && !horizontal).then_some(content_width);
        let cross_height =
            |child: usize| (nodes[child].height_mode == SizeMode::Fill && mode != LayoutMode::Vertical).then_some(content_height).flatten();
        let mut sizes: Vec<(usize, Size)> =
            nested.iter().map(|&child| (child, self.measure(child, cross_width(child), cross_height(child)))).collect();
        if !automatic {
            return sizes;
        }
        let room = if horizontal { Some(content_width) } else { content_height };
        let along = |size: &Size| if horizontal { size.width } else { size.height };
        let fills: Vec<usize> =
            sizes.iter().filter(|(child, _)| Self::axis_mode(&nodes[*child], horizontal) == SizeMode::Fill).map(|(c, _)| *c).collect();
        // Fill inside a hug parent uses the stored fallback, avoiding a circular size dependency.
        let Some(room) = room else { return sizes };
        if Self::axis_mode(node, horizontal) == SizeMode::Hug || fills.is_empty() {
            return sizes;
        }
        let fixed = sizes
            .iter()
            .filter(|(child, _)| Self::axis_mode(&nodes[*child], horizontal) != SizeMode::Fill)
            .fold(0.0, |sum, (_, size)| sum + along(size));
        let mut remaining = (room - fixed - (sizes.len().saturating_sub(1)) as f64 * gap).max(0.0);
        let minimum = |child: usize| if horizontal { nodes[child].min_width } else { nodes[child].min_height }.unwrap_or(1.0);
        let mut pending = fills;
        let mut allocation: HashMap<usize, f64> = HashMap::new();
        while !pending.is_empty() {
            let share = remaining / pending.len() as f64;
            let constrained: Vec<usize> = pending.iter().copied().filter(|child| minimum(*child) > share).collect();
            if constrained.is_empty() {
                for child in &pending {
                    allocation.insert(*child, share.max(1.0));
                }
                break;
            }
            for child in &constrained {
                allocation.insert(*child, minimum(*child));
                remaining = (remaining - minimum(*child)).max(0.0);
            }
            pending.retain(|child| !allocation.contains_key(child));
        }
        for entry in &mut sizes {
            let child = entry.0;
            if let Some(&allocated) = allocation.get(&child) {
                let (w, h) = if horizontal { (Some(allocated), cross_height(child)) } else { (cross_width(child), Some(allocated)) };
                entry.1 = self.measure(child, w, h);
            }
        }
        sizes
    }

    fn place(&self, index: usize, size: &Size, x: f64, y: f64, out: &mut Vec<(usize, Bounds)>) {
        out.push((index, Bounds { x: js_round(x), y: js_round(y), width: size.width, height: size.height }));
        let node = &self.nodes[index];
        let mode = node.layout;
        let horizontal = mode == LayoutMode::Horizontal;
        let automatic = mode != LayoutMode::Free;
        let padding = if automatic { node.padding.unwrap_or(0.0) } else { 0.0 };
        let mut gap = node.gap.unwrap_or(0.0);
        let mut cursor = padding;
        let count = size.children.len();
        if automatic {
            let occupied = size.children.iter().fold(0.0, |sum, (_, child)| sum + if horizontal { child.width } else { child.height })
                + (count.saturating_sub(1)) as f64 * gap;
            let available = (if horizontal { size.width } else { size.height }) - 2.0 * padding;
            let remainder = (available - occupied).max(0.0);
            match node.justify {
                Justify::Center => cursor += remainder / 2.0,
                Justify::End => cursor += remainder,
                Justify::SpaceBetween if count > 1 => gap += remainder / (count - 1) as f64,
                _ => {}
            }
        }
        for (child, child_size) in &size.children {
            let child_node = &self.nodes[*child];
            let (mut left, mut top) = (child_node.x.unwrap_or(0.0), child_node.y.unwrap_or(0.0));
            if automatic {
                let space = (if horizontal { size.height - child_size.height } else { size.width - child_size.width }) - padding * 2.0;
                let cross = padding
                    + match node.align {
                        Align::Center => space / 2.0,
                        Align::End => space,
                        Align::Start => 0.0,
                    };
                left = if horizontal { cursor } else { cross };
                top = if horizontal { cross } else { cursor };
                cursor += (if horizontal { child_size.width } else { child_size.height }) + gap;
            }
            self.place(*child, child_size, x + left, y + top, out);
        }
    }
}

/// `designLayout(document)`.
pub fn layout(document: &DesignDocument) -> Layout {
    let mut children: HashMap<Option<&str>, Vec<usize>> = HashMap::new();
    for (index, node) in document.nodes.iter().enumerate() {
        if node.hidden {
            continue;
        }
        children.entry(node.parent_id.as_deref()).or_default().push(index);
    }
    let roots = children.get(&None).cloned().unwrap_or_default();
    let mut engine = Engine { nodes: &document.nodes, children, cache: HashMap::new() };
    let mut order = Vec::new();
    for root in roots {
        let size = engine.measure(root, Some(document.width), Some(document.height));
        let node = &document.nodes[root];
        engine.place(root, &size, node.x.unwrap_or(0.0), node.y.unwrap_or(0.0), &mut order);
    }
    let index = order.iter().enumerate().map(|(position, (node, _))| (*node, position)).collect();
    Layout { order, index }
}

/// `designNodeAt`: the frontmost visible layer at a point on the screen, skipping layers a parent frame cuts off.
/// (The TS then names an instance's root for a generated child; this port has no instances.)
pub fn node_at(document: &DesignDocument, layout: &Layout, x: f64, y: f64) -> Option<usize> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x > document.width || y > document.height {
        return None;
    }
    let by_id: HashMap<&str, usize> = document.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    for (index, bounds) in layout.order.iter().rev() {
        if !bounds.contains(x, y) {
            continue;
        }
        let mut parent = document.nodes[*index].parent_id.as_deref();
        let mut clipped = false;
        while let Some(id) = parent {
            let Some(&parent_index) = by_id.get(id) else { break };
            if !layout.get(parent_index).is_some_and(|b| b.contains(x, y)) {
                clipped = true;
                break;
            }
            parent = document.nodes[parent_index].parent_id.as_deref();
        }
        if !clipped {
            return Some(*index);
        }
    }
    None
}
