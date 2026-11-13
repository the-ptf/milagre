use super::*;
use std::sync::OnceLock;

fn matches(pattern: &str, input: &str) -> bool {
    regex::Regex::new(pattern)
        .expect("color pattern")
        .is_match(input)
}
fn byte(value: f64) -> u8 {
    value.clamp(0.0, 255.0).round() as u8
}
fn opacity(value: Option<&str>) -> f64 {
    value
        .map(|value| {
            value.trim_end_matches('%').parse::<f64>().unwrap()
                / if value.ends_with('%') { 100.0 } else { 1.0 }
        })
        .unwrap_or(1.0)
        .clamp(0.0, 1.0)
}
pub fn paint(input: &str) -> Option<(String, f64)> {
    let source = trim(input);
    let value = source.to_ascii_lowercase();
    if value == "transparent" {
        return Some(("none".into(), 1.0));
    }
    if value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return match value.len() {
            4 | 7 => Some((source.to_owned(), 1.0)),
            5 => Some((
                format!(
                    "#{}{}{}",
                    source[1..2].repeat(2),
                    source[2..3].repeat(2),
                    source[3..4].repeat(2)
                ),
                u8::from_str_radix(&value[4..5], 16).ok()? as f64 / 15.0,
            )),
            9 => Some((
                source[..7].into(),
                u8::from_str_radix(&value[7..9], 16).ok()? as f64 / 255.0,
            )),
            _ => None,
        };
    }
    if let Some(channels) = schema::contract()["colors"]
        .get(&value)
        .and_then(Value::as_array)
    {
        return Some((
            format!(
                "#{:02x}{:02x}{:02x}",
                channels[0].as_u64()?,
                channels[1].as_u64()?,
                channels[2].as_u64()?
            ),
            1.0,
        ));
    }
    static FUNCTION: OnceLock<regex::Regex> = OnceLock::new();
    let captures = FUNCTION
        .get_or_init(|| regex::Regex::new(r"^(rgba?|hsla?)\(([^)]+)\)$").unwrap())
        .captures(&value)?;
    let raw = trim(&captures[2]);
    if raw
        .chars()
        .any(|c| c.is_whitespace() && !crate::validation::whitespace(c))
    {
        return None;
    }
    let normalized = raw
        .chars()
        .map(|c| {
            if crate::validation::whitespace(c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let content = normalized.as_str();
    let number = r"[-+]?(?:[0-9]*\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?%?";
    let comma = content.contains(',');
    let expression = if comma {
        format!(r"^{number}\s*,\s*{number}\s*,\s*{number}(?:\s*,\s*{number})?$")
    } else {
        format!(r"^{number}\s+{number}\s+{number}(?:\s*/\s*{number})?$")
    };
    if !matches(&expression, content) {
        return None;
    }
    let parts = content
        .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let numbers = parts
        .iter()
        .map(|part| {
            part.trim_end_matches('%')
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
        })
        .collect::<Option<Vec<_>>>()?;
    let alpha = opacity(parts.get(3).copied());
    if captures[1].starts_with("rgb") {
        if comma
            && parts[..3]
                .iter()
                .any(|part| part.ends_with('%') != parts[0].ends_with('%'))
        {
            return None;
        }
        let c = (0..3)
            .map(|i| byte(numbers[i] * if parts[i].ends_with('%') { 2.55 } else { 1.0 }))
            .collect::<Vec<_>>();
        return Some((format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]), alpha));
    }
    if parts[0].ends_with('%') || !parts[1].ends_with('%') || !parts[2].ends_with('%') {
        return None;
    }
    let hue = ((numbers[0] % 360.0) + 360.0) % 360.0;
    let saturation = (numbers[1] / 100.0).clamp(0.0, 1.0);
    let light = (numbers[2] / 100.0).clamp(0.0, 1.0);
    let chroma = (1.0 - (2.0 * light - 1.0).abs()) * saturation;
    let second = chroma * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let channels = if hue < 60.0 {
        [chroma, second, 0.0]
    } else if hue < 120.0 {
        [second, chroma, 0.0]
    } else if hue < 180.0 {
        [0.0, chroma, second]
    } else if hue < 240.0 {
        [0.0, second, chroma]
    } else if hue < 300.0 {
        [second, 0.0, chroma]
    } else {
        [chroma, 0.0, second]
    };
    let offset = light - chroma / 2.0;
    Some((
        format!(
            "#{:02x}{:02x}{:02x}",
            byte((channels[0] + offset) * 255.0),
            byte((channels[1] + offset) * 255.0),
            byte((channels[2] + offset) * 255.0)
        ),
        alpha,
    ))
}
pub fn key(input: &str) -> Option<(String, f64)> {
    let (color, alpha) = paint(input)?;
    let color = color.to_ascii_lowercase();
    Some((
        if color.len() == 4 && color.starts_with('#') {
            format!(
                "#{}{}{}",
                color[1..2].repeat(2),
                color[2..3].repeat(2),
                color[3..4].repeat(2)
            )
        } else {
            color
        },
        alpha,
    ))
}
