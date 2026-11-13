use crate::error::{Error, Result};
use milagre_owner_store::jsjson;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock};

pub const MAX_HTML: usize = 1_000_000;
pub const MAX_ASSET: u64 = 95 * 1024 * 1024;
pub const MAX_PAGE_BYTES: u64 = 1024 * 1024 * 1024;
pub const ASSET_CHUNK: usize = 256 * 1024;
pub const FORMAT_MISMATCH: &str =
    "Artifacts and Designs use separate formats. Create a new id instead of changing formats.";
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase_or_digit()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase_or_digit() || byte == b'-')
}
trait LowerDigit {
    fn is_ascii_lowercase_or_digit(&self) -> bool;
}
impl LowerDigit for u8 {
    fn is_ascii_lowercase_or_digit(&self) -> bool {
        self.is_ascii_lowercase() || self.is_ascii_digit()
    }
}
pub fn id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| valid_id(id) && *id != "comments")
        .ok_or_else(|| Error::new("Artifact ids are lowercase letters, digits and dashes."))
}
pub fn asset_name(name: &str) -> bool {
    (1..=100).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
pub fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
pub fn slice(value: &str, length: usize) -> String {
    let units = jsjson::to_utf16(value);
    jsjson::from_utf16(&units[..units.len().min(length)])
}
pub fn utf8(value: &str) -> String {
    String::from_utf16_lossy(&jsjson::to_utf16(value))
}
pub fn integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}
pub fn format(value: Option<&Value>) -> Result<()> {
    if value.is_some_and(|value| !matches!(value.as_str(), Some("design" | "html"))) {
        return Err(Error::new("Choose design or html format."));
    }
    Ok(())
}
pub fn format_of(entry: &Value) -> &'static str {
    if entry["format"] == "design" {
        "design"
    } else {
        "html"
    }
}
pub fn tabs(input: &Value, current: Option<&Value>) -> Result<Vec<Value>> {
    let input = input
        .as_array()
        .filter(|tabs| !tabs.is_empty() && tabs.len() <= 20)
        .ok_or_else(|| Error::new("A page has between 1 and 20 tabs."))?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    let mut total = 0;
    for tab in input {
        let id = tab["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| Error::new("Tab ids are lowercase letters, digits and dashes."))?;
        if !seen.insert(id) {
            return Err(Error::new(format!("Two tabs have the id {id}.")));
        }
        let title = tab["title"]
            .as_str()
            .map(trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| Error::new(format!("The tab {id} needs a title.")))?;
        let old = current
            .and_then(Value::as_array)
            .and_then(|tabs| tabs.iter().find(|tab| tab["id"] == id))
            .map(|tab| &tab["html"]);
        let html = if tab["html"].is_null() { old } else { Some(&tab["html"]) }.and_then(Value::as_str)
            .filter(|html| !trim(html).is_empty()).ok_or_else(|| Error::new(format!("The tab {id} needs its HTML: only a tab the page already has keeps its HTML when you leave it out.")))?;
        total += jsjson::utf16_len(html);
        result.push(json!({"id":id,"title":slice(title,60),"html":html}));
    }
    if total > MAX_HTML {
        return Err(Error::new(
            "A page's tabs are limited to 1000000 characters together.",
        ));
    }
    Ok(result)
}
pub fn mentions(html: &str, name: &str) -> bool {
    let needle = format!("assets/{name}");
    html.match_indices(&needle).any(|(index, _)| {
        let start = if html[..index].ends_with("./") {
            index - 2
        } else {
            index
        };
        let previous = html[..start].bytes().next_back();
        let next = html[index + needle.len()..].bytes().next();
        !previous.is_some_and(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
            && !next.is_some_and(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    })
}
pub fn asset_type(name: &str) -> &'static str {
    match name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "apng" => "image/apng",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "m4v" | "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "webm" => "video/webm",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "oga" | "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "csv" => "text/csv",
        "json" => "application/json",
        "md" => "text/markdown",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "vtt" => "text/vtt",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}
pub fn anchor(value: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^(?:#[A-Za-z][A-Za-z0-9_-]{0,63}|[A-Za-z][A-Za-z0-9-]{0,40}:[0-9]{1,5})(?:/[A-Za-z][A-Za-z0-9-]{0,40}:[0-9]{1,5}){0,40}@(?:0|1|0?\.[0-9]{1,4}),(?:0|1|0?\.[0-9]{1,4})$").unwrap()).is_match(value)
}
