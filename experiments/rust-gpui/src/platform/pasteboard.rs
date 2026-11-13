//! The files on the general pasteboard as `public.file-url`s. GPUI's clipboard reads the legacy file-names type, then
//! a plain string; an app that copies a file as a URL with its path as text (CleanShot) would paste as that path. The
//! composer asks here when GPUI's read has no files, as Chromium's paste lists such files (`clipboardData.items`).

use std::path::PathBuf;

/// The local files a `file://` URL string names (percent-decoded); `None` for anything else.
pub fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    // `file://localhost/path` and `file:///path`.
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let path = String::from_utf8(out).ok()?;
    Some(PathBuf::from(path))
}

/// Every file URL on the general pasteboard, in its items' order. Empty off macOS and in tests (the test platform has
/// no pasteboard of its own and a test must never read the person's).
pub fn file_urls() -> Vec<PathBuf> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;
        let pasteboard = NSPasteboard::generalPasteboard();
        let Some(items) = pasteboard.pasteboardItems() else { return Vec::new() };
        let kind = NSString::from_str("public.file-url");
        items.iter().filter_map(|item| item.stringForType(&kind)).filter_map(|url| file_url_path(&url.to_string())).collect()
    }
    #[cfg(not(all(target_os = "macos", not(test))))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::file_url_path;
    use std::path::PathBuf;

    #[test]
    fn file_urls_decode_to_paths() {
        assert_eq!(
            file_url_path(
                "file:///Users/v/Library/Application%20Support/CleanShot/media/CleanShot%202026-11-12%20at%209.19.04%20PM@2x.png"
            ),
            Some(PathBuf::from("/Users/v/Library/Application Support/CleanShot/media/CleanShot 2026-11-12 at 9.19.04 PM@2x.png"))
        );
        assert_eq!(file_url_path("file://localhost/tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
        assert_eq!(file_url_path("https://example.com/a.png"), None);
        assert_eq!(file_url_path("file://host/a.png"), None);
    }
}
