//! The document an Artifact page runs as, ported from `packages/shared/src/artifact-document.mjs` and
//! `artifact-assets.mjs`: the content security policy, the policy and helper put ahead of the page's own HTML, the
//! page's `assets/<name>` pointed at the preview's address, a file's media type and one `bytes=` range of it.
//!
//! Plain string work with no regular expressions; `tests.rs` holds the cases the JavaScript's own tests cover.

/// The page helper (`ARTIFACT_PAGE_SCRIPT`), generated from the shared module so both apps run the same code:
///
/// ```sh
/// node --input-type=module -e "import('./packages/shared/src/artifact-document.mjs').then(m=>process.stdout.write(m.ARTIFACT_PAGE_SCRIPT))" \
///   > experiments/rust-gpui/src/workspace/panel/artifacts/page_helper.js
/// ```
pub const PAGE_HELPER: &str = include_str!("page_helper.js");

/// The key every message between a page's helper and its viewer carries, as `milagre` (`ARTIFACT_PAGE`).
pub const PAGE_KEY: &str = "milagre:artifact-page";

/// `ARTIFACT_CSP`: inline scripts and styles run, images, fonts and media come from data, blob and https, and
/// nothing else loads. No `connect-src`, so `fetch`, XHR, WebSocket and EventSource fall back to `default-src
/// 'none'`; no host in `script-src`, so a remote script never runs.
pub const ARTIFACT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; \
                                img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; \
                                form-action 'none'; base-uri 'none'";

/// The policy with `assets` (the preview scheme, `milagre-artifact:`) also allowed for images, media and fonts:
/// where the viewer keeps the page's files (`artifactCsp`).
pub fn artifact_csp(assets: &str) -> String {
    if assets.is_empty() {
        return ARTIFACT_CSP.to_string();
    }
    ARTIFACT_CSP
        .split("; ")
        .map(|directive| {
            let name = directive.split(' ').next().unwrap_or_default();
            if matches!(name, "img-src" | "media-src" | "font-src") { format!("{directive} {assets}") } else { directive.to_string() }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// `artifactDocument`: the page's HTML with the policy as the first thing the parser meets after the doctype, so
/// nothing the page wrote comes before it. A bare fragment also gets a charset and a viewport; a page (`page`)
/// gets the helper its viewer drives. `assets` is the source its files load from.
pub fn artifact_document(html: &str, page: bool, assets: &str) -> String {
    let policy = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">", artifact_csp(assets));
    let at = doctype_end(html);
    let bare = if has_html_tag(html) {
        ""
    } else {
        "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    };
    let helper = if page { format!("<script>{PAGE_HELPER}</script>") } else { String::new() };
    let head = match at {
        Some(at) => &html[..at],
        None => "<!doctype html>",
    };
    let rest = &html[at.unwrap_or(0)..];
    format!("{head}{policy}{bare}{helper}{rest}")
}

/// Where a leading doctype ends: after any whitespace and comments, `<!doctype ...>` in any case.
fn doctype_end(html: &str) -> Option<usize> {
    let mut at = 0;
    loop {
        let rest = &html[at..];
        let trimmed = rest.trim_start();
        at += rest.len() - trimmed.len();
        if trimmed.starts_with("<!--") {
            let end = trimmed.find("-->")? + 3;
            at += end;
            continue;
        }
        if trimmed.len() >= 9 && trimmed.as_bytes()[..9].eq_ignore_ascii_case(b"<!doctype") {
            return Some(at + trimmed.find('>')? + 1);
        }
        return None;
    }
}

/// Whether the HTML has an `<html>` element of its own (`/<html[\s>]/i`).
fn has_html_tag(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.match_indices("<html").any(|(at, _)| lower[at + 5..].chars().next().is_some_and(|c| c == '>' || c.is_whitespace()))
}

/// A file's name on the page (`ASSET_NAME`): a letter or digit, then up to 99 of letters, digits, `.`, `_`, `-`.
pub fn valid_asset_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `rewriteAssetUrls`: each whole `assets/<name>` (or `./assets/<name>`) reference points at `url_for(name)`. A
/// reference inside a longer path or name is left alone.
pub fn rewrite_asset_urls(html: &str, names: &[&str], url_for: impl Fn(&str) -> String) -> String {
    let mut out = html.to_string();
    for name in names {
        let needle = format!("assets/{name}");
        let mut result = String::with_capacity(out.len());
        let mut last = 0;
        for (at, _) in out.match_indices(&needle) {
            let end = at + needle.len();
            let mut start = at;
            if out[..at].ends_with("./") {
                start -= 2;
            }
            let before = out[..start].chars().next_back();
            let after = out[end..].chars().next();
            let joined_before = before.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
            let joined_after = after.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            if joined_before || joined_after || start < last {
                continue;
            }
            result.push_str(&out[last..start]);
            result.push_str(&url_for(name));
            last = end;
        }
        result.push_str(&out[last..]);
        out = result;
    }
    out
}

/// `assetType`: the media type from the file's extension; any other file is plain bytes.
pub fn asset_type(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    match extension.as_str() {
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

/// One `bytes=` range of a file of `size` bytes (`byteRange`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Range {
    /// No usable range header: the whole file.
    Whole,
    /// `length` bytes from `offset`.
    Part { offset: usize, length: usize },
    /// A range the file cannot satisfy (416).
    Unsatisfiable,
}

pub fn byte_range(header: Option<&str>, size: usize) -> Range {
    let Some(spec) = header.and_then(|h| h.strip_prefix("bytes=")) else { return Range::Whole };
    let Some((first, last)) = spec.split_once('-') else { return Range::Whole };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(first) || !digits(last) || (first.is_empty() && last.is_empty()) {
        return Range::Whole;
    }
    let number = |s: &str| s.parse::<usize>().unwrap_or(usize::MAX);
    if first.is_empty() {
        let length = number(last).min(size);
        return if length > 0 { Range::Part { offset: size - length, length } } else { Range::Unsatisfiable };
    }
    let offset = number(first);
    let end = if last.is_empty() { size.saturating_sub(1) } else { number(last).min(size.saturating_sub(1)) };
    if offset >= size || end < offset { Range::Unsatisfiable } else { Range::Part { offset, length: end - offset + 1 } }
}
