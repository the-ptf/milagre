//! Project pictures on Milagre's daemon: `project:image [path]`, as Electron's `lib/project-images.ts` reads it, once
//! per Project per run. The daemon answers the icon the user chose in Settings, else the Project's own icon or favicon
//! (`packages/core/src/project-image.cjs`: a `data:` URL of the file), else the GitHub organization's or the signed-in
//! profile's avatar (an `https://avatars.githubusercontent.com/…` URL), else `null`. A `data:` URL is decoded here; an
//! avatar URL is fetched with `/usr/bin/curl` (https only, that host only, 5 MiB, 5 s), where Electron's `<img>`
//! would load it. Anything else, or a picture that does not decode, leaves the letter tile.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use base64::Engine as _;
use gpui::{Image, ImageFormat};
use serde_json::Value;

/// The daemon's own limit on a Project image file (`MAX_BYTES` in `project-image.cjs`), and the avatar fetch's.
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

/// The only host an avatar is fetched from (`avatar()` in `project-image.cjs` allows no other).
pub const AVATAR_HOST: &str = "https://avatars.githubusercontent.com/";

/// What `project:image` answered.
#[derive(Debug, PartialEq)]
pub enum Answer {
    /// No picture: the letter tile.
    None,
    /// A picture's bytes and, when the answer named it, its MIME type.
    Bytes(Vec<u8>, Option<String>),
    /// A GitHub avatar to fetch.
    Avatar(String),
}

/// Reads `project:image`'s answer. A `data:` URL that is not base64, or a URL off [`AVATAR_HOST`], is refused.
pub fn answer(value: &Value) -> Result<Answer> {
    let Some(src) = value.as_str() else {
        return if value.is_null() { Ok(Answer::None) } else { Err(anyhow!("project:image: expected a string or null")) };
    };
    if let Some(rest) = src.strip_prefix("data:") {
        let (head, body) = rest.split_once(',').ok_or_else(|| anyhow!("project:image: a data URL without data"))?;
        let mime = head.strip_suffix(";base64").ok_or_else(|| anyhow!("project:image: a data URL that is not base64"))?;
        if body.len() > MAX_BYTES * 4 / 3 + 4 {
            return Err(anyhow!("project:image: over {MAX_BYTES} bytes"));
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(body).map_err(|e| anyhow!("project:image: {e}"))?;
        return Ok(Answer::Bytes(bytes, Some(mime.to_owned())));
    }
    if src.starts_with(AVATAR_HOST) && !src.contains(char::is_whitespace) {
        return Ok(Answer::Avatar(src.to_owned()));
    }
    Err(anyhow!("project:image: neither a data URL nor a GitHub avatar"))
}

/// The picture's format: from its MIME type, else from its first bytes. `None` for anything GPUI does not draw.
pub fn format(bytes: &[u8], mime: Option<&str>) -> Option<ImageFormat> {
    let by_mime = match mime {
        Some("image/png") => Some(ImageFormat::Png),
        Some("image/jpeg") => Some(ImageFormat::Jpeg),
        Some("image/webp") => Some(ImageFormat::Webp),
        Some("image/gif") => Some(ImageFormat::Gif),
        Some("image/svg+xml") => Some(ImageFormat::Svg),
        Some("image/x-icon" | "image/vnd.microsoft.icon") => Some(ImageFormat::Ico),
        _ => None,
    };
    let by_bytes = match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some(ImageFormat::Png),
        [0xff, 0xd8, 0xff, ..] => Some(ImageFormat::Jpeg),
        [b'G', b'I', b'F', b'8', ..] => Some(ImageFormat::Gif),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(ImageFormat::Webp),
        [0, 0, 1, 0, ..] => Some(ImageFormat::Ico),
        _ => None,
    };
    by_mime.or(by_bytes)
}

/// The picture GPUI draws, or `None` (empty, unknown format, or bytes that do not decode as it).
pub fn image(bytes: Vec<u8>, mime: Option<&str>) -> Option<Arc<Image>> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let format = format(&bytes, mime)?;
    // GPUI decodes when it draws and draws nothing for bytes that fail; check raster formats now so the letter shows.
    if format != ImageFormat::Svg && image_decodes(&bytes, format).is_none() {
        return None;
    }
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

fn image_decodes(bytes: &[u8], format: ImageFormat) -> Option<()> {
    let format = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::Webp => image::ImageFormat::WebP,
        ImageFormat::Gif => image::ImageFormat::Gif,
        ImageFormat::Ico => image::ImageFormat::Ico,
        _ => return None,
    };
    image::load_from_memory_with_format(bytes, format).ok().map(|_| ())
}

/// A GitHub avatar's bytes: `/usr/bin/curl` over https only, no redirects off https, at most [`MAX_BYTES`] and 5 s.
/// Blocking: run it off the UI thread.
pub fn fetch_avatar(url: &str) -> Result<Vec<u8>> {
    if !url.starts_with(AVATAR_HOST) {
        return Err(anyhow!("not a GitHub avatar: {url}"));
    }
    let output = std::process::Command::new("/usr/bin/curl")
        .args(["--silent", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-time", "5"])
        .args(["--max-filesize", &MAX_BYTES.to_string(), "--", url])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| anyhow!("curl: {e}"))?;
    if !output.status.success() {
        return Err(anyhow!("curl exited with {}", output.status));
    }
    Ok(output.stdout)
}

/// One Project's picture end to end, off the UI thread: the answer, then the bytes (fetched for an avatar).
pub fn resolve(value: &Value) -> Result<Option<Arc<Image>>> {
    Ok(match answer(value)? {
        Answer::None => None,
        Answer::Bytes(bytes, mime) => image(bytes, mime.as_deref()),
        Answer::Avatar(url) => image(fetch_avatar(&url)?, None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A 1×1 PNG.
    pub const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    #[test]
    fn answers() {
        assert_eq!(answer(&Value::Null).unwrap(), Answer::None);
        let Answer::Bytes(bytes, mime) = answer(&json!(format!("data:image/png;base64,{PNG}"))).unwrap() else { panic!() };
        assert_eq!(mime.as_deref(), Some("image/png"));
        let decoded = image(bytes, mime.as_deref()).expect("a PNG");
        assert_eq!(decoded.format, ImageFormat::Png);
        assert_eq!(
            answer(&json!("https://avatars.githubusercontent.com/u/1?v=4&s=80")).unwrap(),
            Answer::Avatar("https://avatars.githubusercontent.com/u/1?v=4&s=80".into())
        );
        assert!(answer(&json!("https://example.com/a.png")).is_err(), "only GitHub's avatar host");
        assert!(answer(&json!("data:image/png,raw")).is_err(), "only base64");
        assert!(answer(&json!(3)).is_err());
        // Bytes that are not the picture they claim leave the letter.
        assert!(image(b"not a png".to_vec(), Some("image/png")).is_none());
        assert!(image(Vec::new(), None).is_none());
        assert_eq!(format(b"<svg xmlns='http://www.w3.org/2000/svg'/>", Some("image/svg+xml")), Some(ImageFormat::Svg));
        assert!(fetch_avatar("https://example.com/a.png").is_err(), "never fetched off GitHub's avatar host");
    }
}
