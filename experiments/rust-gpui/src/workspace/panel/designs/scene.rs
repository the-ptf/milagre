//! One version of a design, prepared to draw: every visible layer's box from the ported layout, its paint resolved
//! (tokens, CSS colours, the default fills), its text broken into lines, its icon and image decoded. Built once per
//! design and version; [`render`](super::render) draws it at any zoom.
//!
//! The paint follows `designMarkup` and `nodeStyles` (`design.mjs`), the HTML the desktop shows in its frames.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use gpui::{App, RenderImage, Rgba, SharedString};

use super::assets;
use crate::logic::design_layout::{
    self as design, Bounds, DESIGN_INK, DesignDocument, DesignNode, Layout, NodeType, TextAlign, default_fill, drawn_weight, paint,
    text_layout, uses_inter, visible_lines,
};

/// The family the embedded Inter faces register as.
pub const INTER: &str = "Inter";

/// A CSS colour as GPUI's, or `None` for transparent or a value CSS would drop.
pub fn rgba(value: &str) -> Option<Rgba> {
    let p = paint(value)?;
    (p.a > 0.0).then(|| Rgba { r: (p.r / 255.0) as f32, g: (p.g / 255.0) as f32, b: (p.b / 255.0) as f32, a: p.a as f32 })
}

#[derive(Clone, Debug)]
pub struct TextPaint {
    pub lines: Vec<SharedString>,
    pub font_size: f64,
    pub line_height: f64,
    pub family: SharedString,
    pub weight: f32,
    pub color: Option<Rgba>,
    pub align: TextAlign,
    /// The stroke inside the box: the lines start after it.
    pub inset: f64,
}

#[derive(Clone, Debug)]
pub enum Content {
    None,
    Text(TextPaint),
    /// A Lucide icon, drawn centred in the box (`preserveAspectRatio="xMidYMid meet"`).
    Icon(Option<Arc<RenderImage>>),
    /// An image covering the box (`object-fit: cover`); `None` paints the placeholder.
    Image(Option<Arc<RenderImage>>),
}

#[derive(Clone, Debug)]
pub struct Layer {
    pub id: String,
    pub bounds: Bounds,
    pub fill: Option<Rgba>,
    /// Width and colour of the border drawn inside the box.
    pub stroke: Option<(f64, Rgba)>,
    pub radius: f64,
    pub ellipse: bool,
    pub opacity: f32,
    pub content: Content,
    pub children: Vec<usize>,
}

pub struct Scene {
    pub width: f64,
    pub height: f64,
    pub background: Option<Rgba>,
    pub layers: Vec<Layer>,
    pub roots: Vec<usize>,
    pub document: Arc<DesignDocument>,
    pub layout: Layout,
}

/// Decoded icons by name, colour, weight and size, shared by every scene of the view.
pub type IconCache = HashMap<String, Option<Arc<RenderImage>>>;

/// The families installed on this Mac, lower case, read once.
fn installed(cx: &App) -> &'static std::collections::HashSet<String> {
    static FAMILIES: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    FAMILIES.get_or_init(|| cx.text_system().all_font_names().into_iter().map(|name| name.to_lowercase()).collect())
}

/// The family to ask the text system for: Inter as embedded, else the first family in the list this Mac has, CSS's
/// generic names as Chromium resolves them on macOS.
pub fn text_family(node: &DesignNode, cx: &App) -> SharedString {
    if uses_inter(node.font_family.as_deref()) {
        return INTER.into();
    }
    let list = node.font_family.as_deref().unwrap_or(design::text::DEFAULT_FONT_FAMILY);
    for family in list.split(',').map(str::trim) {
        let generic = match family.to_lowercase().as_str() {
            "sans-serif" | "ui-sans-serif" | "system-ui" => Some("Helvetica"),
            "serif" | "ui-serif" => Some("Times"),
            "monospace" | "ui-monospace" => Some("Menlo"),
            "cursive" => Some("Apple Chancery"),
            "fantasy" => Some("Papyrus"),
            "ui-rounded" => Some(".SystemUIFont"),
            _ => None,
        };
        if let Some(generic) = generic {
            return generic.into();
        }
        if family.eq_ignore_ascii_case("inter") || installed(cx).contains(&family.to_lowercase()) {
            return if family.eq_ignore_ascii_case("inter") { INTER.into() } else { SharedString::from(family.to_string()) };
        }
    }
    "Helvetica".into()
}

impl Scene {
    pub fn build(document: Arc<DesignDocument>, icons: &mut IconCache, cx: &App) -> Self {
        let layout = design::layout(&document);
        let mut layers: Vec<Layer> = Vec::with_capacity(layout.order.len());
        let mut roots = Vec::new();
        let mut by_node: HashMap<usize, usize> = HashMap::new();
        for (index, bounds) in &layout.order {
            let node = &document.nodes[*index];
            let parent = node
                .parent_id
                .as_deref()
                .and_then(|id| document.nodes.iter().position(|n| n.id == id))
                .and_then(|p| by_node.get(&p).copied());
            let layer = Self::layer(&document, node, *bounds, icons, cx);
            let position = layers.len();
            layers.push(layer);
            by_node.insert(*index, position);
            match parent {
                Some(parent) => layers[parent].children.push(position),
                None => roots.push(position),
            }
        }
        Self {
            width: document.width,
            height: document.height,
            background: rgba(document.color(document.background.as_deref(), "#ffffff")),
            layers,
            roots,
            layout,
            document,
        }
    }

    fn layer(document: &DesignDocument, node: &DesignNode, bounds: Bounds, icons: &mut IconCache, cx: &App) -> Layer {
        let fallback = default_fill(node);
        let fill = match node.kind {
            NodeType::Text | NodeType::Icon => None,
            _ => rgba(document.color(node.fill.as_deref(), fallback)),
        };
        let stroke = (node.stroke.is_some() && node.kind != NodeType::Icon)
            .then(|| rgba(document.color(node.stroke.as_deref(), "transparent")).map(|color| (node.stroke_width.unwrap_or(1.0), color)))
            .flatten()
            .filter(|(width, _)| *width > 0.0);
        let content = match node.kind {
            NodeType::Text => {
                let width = (bounds.width - 2.0 * node.border()).max(1.0);
                let text = text_layout(node, width);
                Content::Text(TextPaint {
                    lines: visible_lines(node, &bounds, &text).iter().map(|line| SharedString::from(line.clone())).collect(),
                    font_size: node.font_size(),
                    line_height: text.line_height,
                    family: text_family(node, cx),
                    weight: drawn_weight(node) as f32,
                    color: rgba(document.color(node.fill.as_deref(), DESIGN_INK)),
                    align: node.text_align,
                    inset: node.border(),
                })
            }
            NodeType::Icon => {
                let color = document.color(node.fill.as_deref(), DESIGN_INK);
                let paint = paint(color);
                let name = node.icon.clone().unwrap_or_default();
                let weight = node.stroke_width.unwrap_or(2.0);
                // Twice the box at the highest zoom, so it stays sharp on a Retina screen.
                let size = (bounds.width.max(bounds.height) * 2.0).ceil().clamp(16.0, 512.0) as u32;
                let image = paint.filter(|p| p.a > 0.0).and_then(|p| {
                    let hex = format!("#{:06x}", p.rgb_hex());
                    let key = format!("{name}|{hex}|{}|{weight}|{size}", p.a);
                    icons
                        .entry(key)
                        .or_insert_with(|| assets::icon_svg(&name, &hex, p.a, weight, size).and_then(|svg| assets::render_svg(&svg, cx)))
                        .clone()
                });
                Content::Icon(image)
            }
            NodeType::Image => Content::Image(node.src.as_deref().and_then(|src| assets::decode_data_url(src, cx))),
            _ => Content::None,
        };
        // An image whose source can't be shown here paints the grey an image still to add paints.
        let fill = match (&content, node.kind) {
            (Content::Image(None), NodeType::Image) if node.fill.is_none() => rgba(design::DESIGN_PLACEHOLDER),
            _ => fill,
        };
        Layer {
            id: node.id.clone(),
            bounds,
            fill,
            stroke,
            radius: node.radius.unwrap_or(0.0),
            ellipse: node.kind == NodeType::Ellipse,
            opacity: node.opacity.unwrap_or(1.0) as f32,
            content,
            children: Vec::new(),
        }
    }

    /// The layer under a point of the design's screen (`designNodeAt`), for a comment's anchor.
    pub fn layer_at(&self, x: f64, y: f64) -> Option<&str> {
        design::node_at(&self.document, &self.layout, x, y).map(|index| self.document.nodes[index].id.as_str())
    }
}
