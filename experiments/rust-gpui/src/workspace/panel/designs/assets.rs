//! What a design draws besides boxes and text: the embedded Inter faces, Lucide icons and inline images.
//!
//! - **Inter** 3.19 (SIL OFL 1.1, `data/INTER-LICENSE.txt`): the Latin subsets the desktop embeds in every design
//!   (`design-font-data.mjs`), registered with the text system once, so a design reads the same on any Mac.
//! - **Lucide** 1.56.0 (ISC, `data/LUCIDE-LICENSE.txt`): every icon a design may name (`design-icons.mjs`), kept apart
//!   from the app's own Hugeicons (`assets/hugeicons/`, `tools/gen-icons.mjs`) because a design's icon is content,
//!   coloured and weighted per layer, not a UI glyph. Each is drawn as an SVG with the layer's colour and stroke,
//!   rasterized once at twice its largest on-screen size at the highest zoom.
//! - **Images**: inline PNG, JPEG, WebP and GIF data URLs, decoded once. HTTPS images, which the desktop loads in a
//!   sandboxed frame, are not fetched here: they show the placeholder grey, as an image still to add does.
//!
//! `data/` is written by `src/logic/design_layout/generate.mjs`.

use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use gpui::{App, Global, Image, ImageFormat, RenderImage};
use serde_json::Value;

const INTER: [&[u8]; 4] = [
    include_bytes!("data/inter-400.ttf"),
    include_bytes!("data/inter-500.ttf"),
    include_bytes!("data/inter-600.ttf"),
    include_bytes!("data/inter-700.ttf"),
];

struct InterRegistered;

impl Global for InterRegistered {}

/// Adds the Inter faces to the text system, once per app.
pub fn register_fonts(cx: &mut App) {
    if cx.has_global::<InterRegistered>() {
        return;
    }
    cx.set_global(InterRegistered);
    if let Err(error) = cx.text_system().add_fonts(INTER.iter().map(|face| Cow::Borrowed(*face)).collect()) {
        eprintln!("designs: could not add the Inter faces: {error:#}");
    }
}

fn icons() -> &'static serde_json::Map<String, Value> {
    static ICONS: OnceLock<serde_json::Map<String, Value>> = OnceLock::new();
    ICONS.get_or_init(|| match serde_json::from_str::<Value>(include_str!("data/lucide.json")) {
        Ok(Value::Object(map)) => map,
        _ => Default::default(),
    })
}

/// Whether Lucide has an icon of this name.
pub fn has_icon(name: &str) -> bool {
    icons().contains_key(name)
}

/// The icon as a standalone SVG `size` px square, drawn as the desktop's markup draws it (`designMarkup`).
pub fn icon_svg(name: &str, color: &str, opacity: f64, stroke_width: f64, size: u32) -> Option<String> {
    let inner = icons().get(name)?.as_str()?;
    Some(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="{color}" stroke-opacity="{opacity}" stroke-width="{stroke_width}" stroke-linecap="round" stroke-linejoin="round" color="{color}">{inner}</svg>"#
    ))
}

/// Rasterizes an SVG now (no asset loading, so the first frame has it).
pub fn render_svg(svg: &str, cx: &App) -> Option<Arc<RenderImage>> {
    Image::from_bytes(ImageFormat::Svg, svg.as_bytes().to_vec()).to_image_data(cx.svg_renderer()).ok()
}

/// Decodes an inline image (`data:image/<type>;base64,...`). `None` for HTTPS sources and AVIF.
pub fn decode_data_url(src: &str, cx: &App) -> Option<Arc<RenderImage>> {
    let rest = src.strip_prefix("data:image/")?;
    let (kind, data) = rest.split_once(";base64,")?;
    let format = match kind {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::Webp,
        "gif" => ImageFormat::Gif,
        _ => return None,
    };
    Image::from_bytes(format, base64(data)?).to_image_data(cx.svg_renderer()).ok()
}

/// Standard base64 with padding, as the document's data URLs are (the host's schema allows nothing else).
pub fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= value(*c)? << (18 - 6 * i);
        }
        let take = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        out.extend_from_slice(&acc.to_be_bytes()[1..1 + take]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(base64("TWFu").as_deref(), Some(&b"Man"[..]));
        assert_eq!(base64("TWE=").as_deref(), Some(&b"Ma"[..]));
        assert_eq!(base64("TQ==").as_deref(), Some(&b"M"[..]));
        assert_eq!(base64("T"), None);
        assert_eq!(base64("T!=="), None);
    }

    #[test]
    fn every_fixture_icon_is_in_lucide() {
        for design in super::super::fixture::designs() {
            for document in &design.versions {
                for node in document.nodes.iter().filter_map(|n| n.icon.as_deref()) {
                    assert!(has_icon(node), "{} names {node}", design.id);
                }
            }
        }
        let svg = icon_svg("check", "#202720", 1.0, 2.0, 48).unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("stroke=\"#202720\"") && svg.contains("<path"));
    }
}
