//! The embedded asset table, the stroke variants, and that every icon and logo renders with GPUI's own
//! SVG renderer (resvg), colours included.

use std::sync::Arc;

use gpui::{AssetSource, SvgRenderer};

use super::*;
use crate::data::Provider;
use crate::ui::{IconName, IconSize};

fn load(path: &str) -> Vec<u8> {
    Assets.load(path).unwrap_or_else(|e| panic!("{path}: {e}")).unwrap_or_else(|| panic!("{path} is missing")).into_owned()
}

/// Renders `path` at its own size with GPUI's renderer and returns the BGRA pixels.
fn render(path: &str) -> Vec<u8> {
    let renderer = SvgRenderer::new(Arc::new(Assets));
    let image = renderer.render_single_frame(&load(path), 1.0).unwrap_or_else(|e| panic!("{path} does not render: {e}"));
    image.as_bytes(0).expect("one frame").to_vec()
}

fn painted(pixels: &[u8]) -> usize {
    pixels.as_chunks::<4>().0.iter().filter(|p| p[3] > 0).count()
}

/// Pixels whose colour channels differ by more than `spread`: brand colour, not grey.
fn colourful(pixels: &[u8], spread: u8) -> usize {
    pixels.as_chunks::<4>().0.iter().filter(|p| p[3] > 128 && p[..3].iter().max().unwrap() - p[..3].iter().min().unwrap() > spread).count()
}

#[test]
fn the_table_is_sorted_and_every_file_loads() {
    let paths: Vec<_> = Assets::embedded_paths().collect();
    assert!(paths.windows(2).all(|w| w[0] < w[1]), "embedded.rs is sorted and unique (binary search relies on it)");
    for path in paths {
        assert!(!load(path).is_empty(), "{path}");
    }
}

#[test]
fn every_icon_renders_at_every_size() {
    for (ix, name) in IconName::all().enumerate() {
        assert_eq!(name as usize, ix, "the generated table is in enum order");
        for size in IconSize::ALL {
            let pixels = render(name.path(size));
            assert!(painted(&pixels) > 20, "{name:?} at {size:?} draws something");
        }
    }
}

#[test]
fn a_stroke_suffix_swaps_the_width() {
    let base = String::from_utf8(load("hugeicons/search-01.svg")).unwrap();
    assert!(base.contains("stroke-width=\"1.8\""));
    let small = String::from_utf8(load(IconName::Search01.path(IconSize::S12))).unwrap();
    assert!(small.contains("stroke-width=\"1.6\"") && !small.contains("stroke-width=\"1.8\""), "{small}");
    let large = String::from_utf8(load(IconName::Search01.path(IconSize::S18))).unwrap();
    assert!(large.contains("stroke-width=\"2\"") && !large.contains("stroke-width=\"1.8\""));
    assert_eq!(IconName::Search01.path(IconSize::S14), IconName::Search01.path(IconSize::S16), "14 and 16 share 1.8");
    assert!(Assets.load("hugeicons/search-01.svg@1.6\"/><script").is_err(), "only plain numbers are accepted");
}

#[test]
fn brand_logos_keep_their_colours_and_mono_logos_draw() {
    for provider in Provider::ALL {
        let brand = render(provider.logo_path());
        assert!(painted(&brand) > 200, "{provider:?} brand mark draws");
        assert!(colourful(&brand, 60) > 100, "{provider:?} brand mark is in colour, not grey");
        assert!(painted(&render(provider.mono_logo_path())) > 200, "{provider:?} mono mark draws");
    }
}

#[test]
fn gpui_component_icons_still_load() {
    assert!(Assets.load("icons/arrow-down.svg").unwrap().is_some(), "falls back to gpui-kit-assets for its widgets");
    assert!(Assets.list("hugeicons/").unwrap().len() >= IconName::all().count());
}
