//! `designTextLayout` (`design-layout.mjs`): line breaking from measured advance tables, with no text system, so
//! the desktop, the phone, the host and this port break a design's text at the same places.
//!
//! Known gap: the TS normalizes text to NFC first. Text stored decomposed (a letter then a combining accent) is
//! measured here as the cluster's base letter, which the TS also does for every precomposed letter it has no
//! measured advance for; only a letter Inter or the catalog measured (Latin-1) can then differ.

use unicode_segmentation::UnicodeSegmentation;

use super::data::{Family, find_range, tables};
use super::document::DesignNode;
use super::js_round;

pub const DEFAULT_FONT_FAMILY: &str = "Inter, Arial, sans-serif";

#[derive(Clone, Debug, PartialEq)]
pub struct TextLayout {
    pub lines: Vec<String>,
    pub width: f64,
    pub height: f64,
    pub line_height: f64,
}

/// The first family of a font list, trimmed.
pub fn first_family(font_family: &str) -> &str {
    font_family.split(',').next().unwrap_or("").trim()
}

/// `designUsesInter`: Inter only counts as the first family.
pub fn uses_inter(font_family: Option<&str>) -> bool {
    first_family(font_family.unwrap_or(DEFAULT_FONT_FAMILY)).eq_ignore_ascii_case("inter")
}

/// `designCatalogFont`: the catalog family named first in the list.
pub fn catalog_family(font_family: Option<&str>) -> Option<&'static Family> {
    tables().catalog.get(&first_family(font_family?).to_lowercase())
}

/// `nearestDesignWeight`: the closest of `weights` (ascending), ties to the lighter.
pub fn nearest_weight(weights: impl IntoIterator<Item = u32>, requested: f64) -> u32 {
    let mut iter = weights.into_iter();
    let first = iter.next().unwrap_or(400);
    iter.fold(first, |best, weight| if (weight as f64 - requested).abs() < (best as f64 - requested).abs() { weight } else { best })
}

/// The weight a text layer draws with: the nearest measured Inter or catalog face, as requested otherwise
/// (`designDrawnWeight`).
pub fn drawn_weight(node: &DesignNode) -> f64 {
    let requested = node.font_weight.unwrap_or(400.0);
    let family = node.font_family.as_deref();
    if uses_inter(family) {
        return nearest_weight([400, 500, 600, 700], requested) as f64;
    }
    match catalog_family(family) {
        Some(entry) => nearest_weight(entry.weights.iter().map(|(w, _)| *w), requested) as f64,
        None => requested,
    }
}

/// `/\s/u` in JavaScript: White_Space plus U+FEFF, without U+0085.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(js_space)
}

/// Grapheme clusters; printable ASCII is split by character, as the TS does without segmenting it.
fn graphemes(text: &str) -> Vec<&str> {
    if text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        (0..text.len()).map(|i| &text[i..i + 1]).collect()
    } else {
        text.graphemes(true).collect()
    }
}

/// `/\s+|\S+/gu`: alternating runs of spaces and of everything else.
fn runs(paragraph: &str) -> Vec<&str> {
    let mut runs = Vec::new();
    let mut start = 0;
    let mut space = None;
    for (index, c) in paragraph.char_indices() {
        let is_space = js_space(c);
        if space.is_some_and(|s| s != is_space) {
            runs.push(&paragraph[start..index]);
            start = index;
        }
        space = Some(is_space);
    }
    if start < paragraph.len() {
        runs.push(&paragraph[start..]);
    }
    runs
}

/// Which advance table a font list measures with.
enum Kind {
    Inter,
    Catalog(&'static Family),
    Generic(&'static Family),
}

fn kind(font_family: Option<&str>) -> Kind {
    if uses_inter(font_family) {
        return Kind::Inter;
    }
    if let Some(entry) = catalog_family(font_family) {
        return Kind::Catalog(entry);
    }
    let family = font_family.unwrap_or("Inter").to_lowercase();
    let tables = tables();
    // `/georgia|(?<!sans-)serif/`: "serif" anywhere not right after "sans-".
    let serif = family.contains("georgia") || family.match_indices("serif").any(|(i, _)| !family[..i].ends_with("sans-"));
    Kind::Generic(if family.contains("courier") || family.contains("mono") {
        &tables.mono
    } else if family.contains("times") {
        &tables.times
    } else if serif {
        &tables.serif
    } else {
        &tables.sans
    })
}

struct Measure<'a> {
    table: &'a Family,
    weight: u32,
    ascii: &'a [f64],
    size: f64,
    cache: std::collections::HashMap<String, f64>,
}

impl Measure<'_> {
    fn advance(&mut self, character: &str) -> f64 {
        if let Some(width) = self.cache.get(character) {
            return *width;
        }
        let width = self.compute(character);
        self.cache.insert(character.to_string(), width);
        width
    }

    fn compute(&self, character: &str) -> f64 {
        let mut chars = character.chars();
        let first = chars.next();
        let single = chars.next().is_none();
        if let (Some(first), true) = (first, single)
            && let Some(advance) = self.table.extra.get(&self.weight).and_then(|extra| extra.get(&(first as u32)))
        {
            return advance * self.size;
        }
        // The NFD base with every combining mark removed: the first code point left, if any.
        let tables = tables();
        let base = character.chars().find_map(|c| {
            let point = c as u32;
            if find_range(&tables.marks, point, |r| *r).is_some() {
                return None;
            }
            match find_range(&tables.bases, point, |r| (r.0, r.1)) {
                Some((_, _, -1)) => None,
                Some((_, _, base)) => Some(base as u32),
                None => Some(point),
            }
        });
        match base {
            None => 0.0,
            Some(base @ 32..=126) => self.ascii[(base - 32) as usize] * self.size,
            Some(base) => (if base >= 0x2e80 { 1.0 } else { 0.65 }) * self.size,
        }
    }

    fn measure(&mut self, text: &str) -> f64 {
        graphemes(text).into_iter().fold(0.0, |total, character| total + self.advance(character))
    }
}

/// `designTextLayout(node, width)`: `width` is `f64::INFINITY` for the natural width.
pub fn text_layout(node: &DesignNode, width: f64) -> TextLayout {
    let family = node.font_family.as_deref();
    let tables = tables();
    let table: &Family = match kind(family) {
        Kind::Inter => &tables.inter,
        Kind::Catalog(entry) | Kind::Generic(entry) => entry,
    };
    let weight = nearest_weight(table.weights.iter().map(|(w, _)| *w), node.font_weight.unwrap_or(400.0));
    let ascii = table.weights.iter().find(|(w, _)| *w == weight).map(|(_, a)| a.as_slice()).unwrap_or(&[]);
    let size = node.font_size();
    let mut measure = Measure { table, weight, ascii, size, cache: Default::default() };
    let limit = width.max(1.0);
    let source = node.text.as_deref().unwrap_or("").replace("\r\n", "\n").replace('\r', "\n").replace('\t', "    ");
    let mut lines: Vec<String> = Vec::new();
    for paragraph in source.split('\n') {
        let mut line = String::new();
        let mut used = 0.0;
        for part in runs(paragraph) {
            let part_width = measure.measure(part);
            let has_text = part.chars().any(|c| !js_space(c));
            if has_text && line.chars().any(|c| !js_space(c)) && used + part_width > limit + 0.001 {
                lines.push(js_trim_end(&line).to_string());
                line.clear();
                used = 0.0;
            }
            for character in graphemes(part) {
                let next = measure.advance(character);
                if !line.is_empty() && used + next > limit + 0.001 {
                    lines.push(js_trim_end(&line).to_string());
                    line.clear();
                    used = 0.0;
                    if character.chars().any(js_space) {
                        continue;
                    }
                }
                line.push_str(character);
                used += next;
            }
        }
        lines.push(line);
    }
    let line_height = size * node.line_height();
    let widest = lines.iter().map(|line| measure.measure(line)).fold(0.0, f64::max);
    TextLayout { width: js_round(widest), height: js_round(lines.len() as f64 * line_height), line_height, lines }
}
