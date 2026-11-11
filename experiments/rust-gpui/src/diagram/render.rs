//! Mermaid text to a picture. `mermaid-rs-renderer` (MIT, pure Rust, no network, no browser) parses and lays the
//! diagram out and writes SVG; GPUI's own SVG rasteriser (resvg, with the system fonts) turns that into an image at
//! twice the pixel density. The desktop's Pele paints from `--pele-*` custom properties; here the same palette is
//! written into the renderer's theme (`THEME` in `MermaidBlock.tsx`): the chat's `inset` for the ground, `ink` for
//! text, `ink-2` for lines, and surfaces and borders as mixes of ink over the ground.

use std::cell::RefCell;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use gpui::{App, RenderImage, Rgba};
use mermaid_rs_renderer::{LayoutConfig, RenderOptions, Theme as MermaidTheme};

use crate::theme::{Appearance, Theme};

/// The scale handed to the rasteriser. GPUI renders every SVG at twice the size it is given ("smooth" SVGs), so 1.0
/// is a picture at twice the pixel density; 2.0 would be four times.
pub const SCALE: f32 = 1.0;

/// A drawn diagram: its image (at twice the pixel density) and its size in logical pixels.
pub struct Drawing {
    pub image: Arc<RenderImage>,
    pub width: f32,
    pub height: f32,
    /// The SVG, for a reader that wants the vector.
    pub svg: Arc<str>,
}

/// `#rrggbb` of an opaque colour.
pub fn hex(color: Rgba) -> String {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(color.r), channel(color.g), channel(color.b))
}

/// `a` over `b` at `amount` (`mix` in `shared/diagram.ts`; `color-mix(in srgb, ...)` in the desktop's CSS).
pub fn mix(a: Rgba, b: Rgba, amount: f32) -> Rgba {
    let blend = |x: f32, y: f32| x * amount + y * (1.0 - amount);
    Rgba { r: blend(a.r, b.r), g: blend(a.g, b.g), b: blend(a.b, b.b), a: 1.0 }
}

/// The renderer's theme in the chat's colours.
pub fn palette(theme: &Theme) -> MermaidTheme {
    let ground = theme.inset;
    let mut out = match theme.appearance {
        Appearance::Light => MermaidTheme::modern(),
        Appearance::Dark => MermaidTheme::dark(),
    };
    let surface = hex(mix(theme.ink, ground, 0.06));
    let surface_alt = hex(mix(theme.ink, ground, 0.11));
    let border = hex(mix(theme.ink, ground, 0.28));
    let ink = hex(theme.ink);
    let line = hex(theme.ink2);
    out.font_family = "Helvetica Neue, Helvetica, Arial, sans-serif".into();
    out.font_size = 14.0;
    out.background = hex(ground);
    out.primary_color = surface.clone();
    out.primary_text_color = ink.clone();
    out.primary_border_color = border.clone();
    out.line_color = line.clone();
    out.secondary_color = surface_alt.clone();
    out.tertiary_color = surface.clone();
    out.edge_label_background = hex(ground);
    out.cluster_background = surface.clone();
    out.cluster_border = border.clone();
    out.text_color = ink.clone();
    out.sequence_actor_fill = surface.clone();
    out.sequence_actor_border = border.clone();
    out.sequence_actor_line = line;
    out.sequence_note_fill = surface_alt.clone();
    out.sequence_note_border = border.clone();
    out.sequence_activation_fill = surface_alt;
    out.sequence_activation_border = border.clone();
    out.git_commit_label_color = ink.clone();
    out.git_commit_label_background = surface.clone();
    out.git_tag_label_color = ink.clone();
    out.git_tag_label_background = surface;
    out.git_tag_label_border = border.clone();
    out.pie_title_text_color = ink.clone();
    out.pie_section_text_color = ink.clone();
    out.pie_legend_text_color = ink;
    out.pie_stroke_color = hex(ground);
    out.pie_outer_stroke_color = border;
    // Slices from the app's own hues, each a tint of the status colour over the ground so the label stays legible.
    let hues = [
        theme.accent,
        theme.green,
        theme.orange,
        theme.purple,
        theme.red,
        theme.accent_ink,
        theme.green_ink,
        theme.orange_ink,
        theme.purple_ink,
        theme.red_ink,
        theme.ink3,
        theme.ink2,
    ];
    for (slot, hue) in out.pie_colors.iter_mut().zip(hues) {
        *slot = hex(mix(hue, ground, 0.55));
    }
    out.pie_opacity = 1.0;
    out
}

/// A diagram's SVG in the chat's colours, or why it did not parse.
pub fn svg(code: &str, theme: &Theme) -> Result<String, String> {
    if !has_header(code) {
        return Err("it does not start with a diagram type such as flowchart or sequenceDiagram".into());
    }
    let options = RenderOptions { theme: palette(theme), layout: LayoutConfig::default() };
    // The layout engine is third-party code on model-written text: a panic is a diagram that did not draw.
    match catch_unwind(AssertUnwindSafe(|| mermaid_rs_renderer::render_strict(code, options))) {
        Ok(Ok(svg)) => Ok(svg),
        Ok(Err(error)) => Err(reason(&error.to_string())),
        Err(_) => Err("the layout failed".into()),
    }
}

/// The renderer's error on one line.
fn reason(error: &str) -> String {
    let line = error.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("it did not parse");
    line.to_string()
}

/// The size of the SVG's root: its `width` and `height`, or its `viewBox` where those are missing or a percentage
/// (a pie chart writes `width="100%"`).
fn svg_size(svg: &str) -> Option<(f32, f32)> {
    let root = &svg[svg.find("<svg")?..];
    let root = &root[..root.find('>')?];
    let text = |name: &str| -> Option<&str> {
        let key = format!(" {name}=\"");
        let from = root.find(&key)? + key.len();
        Some(&root[from..from + root[from..].find('"')?])
    };
    if let (Some(width), Some(height)) = (text("width").and_then(|v| v.parse().ok()), text("height").and_then(|v| v.parse().ok())) {
        return Some((width, height));
    }
    let mut numbers = text("viewBox")?.split_whitespace().filter_map(|v| v.parse::<f32>().ok()).skip(2);
    Some((numbers.next()?, numbers.next()?))
}

/// The size [`svg_size`] reads, for tests.
#[cfg(test)]
pub fn with_pixel_size_for_test(svg: &str) -> Option<(f32, f32)> {
    let (width, height) = svg_size(svg)?;
    svg_size(&with_pixel_size(svg, width, height))
}

/// The root with a pixel size, so the rasteriser needs no container to resolve a percentage against.
fn with_pixel_size(svg: &str, width: f32, height: f32) -> String {
    let Some(start) = svg.find("<svg") else { return svg.to_string() };
    let end = start + svg[start..].find('>').unwrap_or(0);
    let mut root = svg[start..end].to_string();
    for name in ["width", "height"] {
        let key = format!(" {name}=\"");
        if let Some(at) = root.find(&key) {
            let close = at + key.len() + root[at + key.len()..].find('"').unwrap_or(0) + 1;
            root.replace_range(at..close, "");
        }
    }
    root.insert_str("<svg".len(), &format!(" width=\"{width}\" height=\"{height}\""));
    format!("{}{}{}", &svg[..start], root, &svg[end..])
}

/// The diagram kinds Pele (and so a reply) names on a block's first line, in lower case.
const HEADERS: &[&str] = &[
    "flowchart",
    "graph",
    "sequence",
    "sequencediagram",
    "classdiagram",
    "statediagram",
    "erdiagram",
    "gantt",
    "pie",
    "mindmap",
    "timeline",
    "gitgraph",
    "journey",
    "quadrantchart",
    "xychart",
    "sankey",
    "block",
    "packet",
    "architecture",
    "kanban",
    "radar",
    "treemap",
    "requirement",
    "c4context",
    "c4container",
    "c4component",
    "c4dynamic",
    "c4deployment",
    "zenuml",
];

/// Whether the text opens with a diagram header. The renderer reads any text with arrows as a flowchart; a reply
/// that names no kind is not a diagram, as Pele's `detectType` finds.
fn has_header(code: &str) -> bool {
    super::detect_type(code).is_some_and(|word| {
        let word = word.to_ascii_lowercase();
        HEADERS.iter().any(|header| word == *header || word.starts_with(&format!("{header}-")))
    })
}

type Cache = HashMap<(String, bool), Result<Arc<Drawing>, String>>;

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(HashMap::new());
}

/// How many drawings are kept; more clears them all (a Chat has a handful).
const CACHE_LIMIT: usize = 48;

/// Draws `code` for `theme`, once per text and appearance.
pub fn draw(code: &str, theme: &Theme, cx: &App) -> Result<Arc<Drawing>, String> {
    let key = (code.to_string(), theme.appearance == Appearance::Dark);
    if let Some(found) = CACHE.with(|cache| cache.borrow().get(&key).cloned()) {
        return found;
    }
    let made = rasterise(code, theme, cx);
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, made.clone());
    });
    made
}

fn rasterise(code: &str, theme: &Theme, cx: &App) -> Result<Arc<Drawing>, String> {
    let svg = svg(code, theme)?;
    let (width, height) = svg_size(&svg).ok_or_else(|| "the renderer wrote no size".to_string())?;
    // The renderer writes a 16 by 16 canvas for text that parsed to nothing.
    if !(width.is_finite() && height.is_finite() && width > 24.0 && height > 24.0) {
        return Err("there is nothing in it to draw".into());
    }
    let svg = with_pixel_size(&svg, width, height);
    let renderer = cx.svg_renderer();
    let parsed = renderer.parse_svg(svg.as_bytes()).map_err(|error| format!("the picture could not be read: {error}"))?;
    let image = renderer.render_parsed(&parsed, SCALE).map_err(|error| format!("the picture could not be drawn: {error}"))?;
    Ok(Arc::new(Drawing { image, width, height, svg: svg.into() }))
}
