//! After `packages/shared/src/file-link.mjs`: local file links in a reply's markdown, including Windows paths.

use crate::logic::copy::js;

/// `isWindowsPath`: a path from its drive: `C:\repo`, `C:/repo`, or `C:%5Crepo` as markdown writes a backslash.
pub fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return false;
    }
    matches!(bytes[2], b'\\' | b'/') || (bytes.len() >= 5 && bytes[2] == b'%' && bytes[3] == b'5' && (bytes[4] == b'c' || bytes[4] == b'C'))
}

fn is_separator(windows: bool) -> impl Fn(char) -> bool {
    move |c| c == '/' || (windows && c == '\\')
}

/// `fileLinkName`: the file name at the end of a path from [`local_file_link`].
pub fn file_link_name(path: &str) -> &str {
    let name = path.rsplit(is_separator(is_windows_path(path))).next().unwrap_or("");
    if name.is_empty() { path } else { name }
}

/// `fileLinkFolder`: the folder holding a path from [`local_file_link`], to resolve the links inside that file.
pub fn file_link_folder(path: &str) -> String {
    let name = file_link_name(path);
    let folder = path.get(..path.len().saturating_sub(name.len() + 1)).unwrap_or("");
    if folder.ends_with(':') {
        format!("{folder}\\")
    } else if folder.is_empty() {
        "/".to_string()
    } else {
        folder.to_string()
    }
}

/// `isMarkdownFile`: markdown files open formatted; the viewer offers the source too.
pub fn is_markdown_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".mdx", ".markdown"].iter().any(|ext| lower.ends_with(ext))
}

/// A local file a link points at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLink {
    pub path: String,
    pub line: Option<u64>,
}

/// `decodeURIComponent`; `None` where it throws.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `^#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$` (case-insensitive): the first number of a line anchor.
fn anchor_line(anchor: &str) -> Option<u64> {
    let bytes = anchor.as_bytes();
    let digits = |at: usize| bytes[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    if bytes.len() < 3 || bytes[0] != b'#' || !bytes[1].eq_ignore_ascii_case(&b'L') {
        return None;
    }
    let first = digits(2);
    if first == 0 {
        return None;
    }
    let line = anchor[2..2 + first].parse().unwrap_or(u64::MAX);
    let mut at = 2 + first;
    let column = |at: &mut usize| {
        if bytes.get(*at).is_some_and(|b| b.eq_ignore_ascii_case(&b'C')) {
            let n = digits(*at + 1);
            if n > 0 {
                *at += 1 + n;
            }
        }
    };
    column(&mut at);
    if bytes.get(at) == Some(&b'-') {
        let mut next = at + 1;
        if bytes.get(next).is_some_and(|b| b.eq_ignore_ascii_case(&b'L')) {
            next += 1;
        }
        let n = digits(next);
        if n > 0 {
            next += n;
            column(&mut next);
            at = next;
        }
    }
    (at == bytes.len()).then_some(line)
}

/// `/:(\d+)(?::\d+|-\d+)?$/` on the text: the index of the leftmost match and its first number.
fn line_suffix(text: &str) -> Option<(usize, u64)> {
    let bytes = text.as_bytes();
    for (index, _) in text.match_indices(':') {
        let rest = &bytes[index + 1..];
        let first = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if first == 0 {
            continue;
        }
        let tail = &rest[first..];
        let ok = match tail.first() {
            None => true,
            Some(b':') | Some(b'-') => tail.len() > 1 && tail[1..].iter().all(u8::is_ascii_digit),
            Some(_) => false,
        };
        if ok {
            return Some((index, text[index + 1..index + 1 + first].parse().unwrap_or(u64::MAX)));
        }
    }
    None
}

/// `/^[a-z][a-z\d+.-]*:/i`: a URL scheme at the start.
fn has_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// `localFileLink`: the file a reply's markdown link points at, or `None` when it is a web link or nothing a file
/// viewer can show. Agents link files as absolute paths or paths relative to the chat's folder (`root`, the chat's
/// worktree), sometimes with `:12`, `#L12` or `#L12-L20` after them; `..` segments are folded. URLs with a scheme,
/// `file:` included, are not files here. A line of 0 is dropped, as in TypeScript. A line too long for `u64`
/// saturates (JavaScript keeps a float).
pub fn local_file_link(href: &str, root: Option<&str>) -> Option<FileLink> {
    let mut text = js::trim(href).to_string();
    if text.is_empty() || text.contains(['\0', '\r', '\n']) || text.starts_with("//") || text.starts_with('#') {
        return None;
    }
    let mut line: Option<u64> = None;
    if has_scheme(&text) && !is_windows_path(&text) {
        return None;
    }
    if let Some(hash) = text.find('#') {
        if let Some(found) = anchor_line(&text[hash..]) {
            line = Some(found);
        }
        text.truncate(hash);
    }
    if let Some(query) = text.find('?') {
        text.truncate(query);
    }
    text = decode_uri_component(&text)?;
    if let Some((at, found)) = line_suffix(&text) {
        line.get_or_insert(found);
        text.truncate(at);
    }
    if text.is_empty() || text.ends_with('/') {
        return None;
    }
    let windows = is_windows_path(&text) || (!text.starts_with('/') && is_windows_path(root.unwrap_or("")));
    if windows && text.ends_with('\\') {
        return None;
    }
    if windows && !is_windows_path(&text) {
        text = format!("{}\\{text}", root.unwrap_or("undefined"));
    } else if !windows && !text.starts_with('/') {
        let root = root.filter(|root| root.starts_with('/'))?;
        text = format!("{root}/{text}");
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split(is_separator(windows)) {
        if part == ".." {
            // A Windows path keeps its drive, however many `..` a link has.
            if parts.len() > usize::from(windows) {
                parts.pop();
            }
        } else if !part.is_empty() && part != "." {
            parts.push(part);
        }
    }
    if parts.len() < if windows { 2 } else { 1 } {
        return None;
    }
    let path = if windows { parts.join("\\") } else { format!("/{}", parts.join("/")) };
    Some(FileLink { path, line: line.filter(|line| *line != 0) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(path: &str, line: Option<u64>) -> Option<FileLink> {
        Some(FileLink { path: path.into(), line })
    }

    #[test]
    fn absolute_paths_open_in_the_viewer() {
        assert_eq!(local_file_link("/Users/me/repo/docs/spec.md", None), link("/Users/me/repo/docs/spec.md", None));
        assert_eq!(local_file_link("/Users/me/repo/a%20b.md", None), link("/Users/me/repo/a b.md", None));
    }

    #[test]
    fn relative_paths_resolve_against_the_chats_folder() {
        assert_eq!(local_file_link("docs/spec.md", Some("/repo")), link("/repo/docs/spec.md", None));
        assert_eq!(local_file_link("./src/../README.md", Some("/repo")), link("/repo/README.md", None));
        assert_eq!(local_file_link("docs/spec.md", None), None);
        assert_eq!(local_file_link("docs/spec.md", Some("")), None);
    }

    #[test]
    fn line_suffixes_and_anchors_become_the_line() {
        assert_eq!(local_file_link("/repo/a.ts:42", None), link("/repo/a.ts", Some(42)));
        assert_eq!(local_file_link("/repo/a.ts:42:7", None), link("/repo/a.ts", Some(42)));
        assert_eq!(local_file_link("src/a.ts#L10-L20", Some("/repo")), link("/repo/src/a.ts", Some(10)));
        assert_eq!(local_file_link("/repo/spec.md#goals", None), link("/repo/spec.md", None));
        assert_eq!(local_file_link("/repo/a.ts#L5C3-L6C9", None), link("/repo/a.ts", Some(5)));
        assert_eq!(local_file_link("/repo/a.ts#l7", None), link("/repo/a.ts", Some(7)));
        assert_eq!(local_file_link("/repo/a.ts:3-9", None), link("/repo/a.ts", Some(3)));
        // The anchor wins over the suffix; a line of 0 is dropped.
        assert_eq!(local_file_link("/repo/a.ts:3#L8", None), link("/repo/a.ts", Some(8)));
        assert_eq!(local_file_link("/repo/a.ts:0", None), link("/repo/a.ts", None));
        assert_eq!(local_file_link("/repo/a.ts?plain=1#L2", None), link("/repo/a.ts", Some(2)));
    }

    #[test]
    fn windows_paths_open_in_the_viewer_with_either_slash() {
        assert_eq!(local_file_link("C:\\Users\\me\\repo\\spec.md", None), link("C:\\Users\\me\\repo\\spec.md", None));
        assert_eq!(local_file_link("C:/Users/me/repo/spec.md:12", None), link("C:\\Users\\me\\repo\\spec.md", Some(12)));
        assert_eq!(local_file_link("C:%5CUsers%5Cme%5Cmy%20spec.md#L4", None), link("C:\\Users\\me\\my spec.md", Some(4)));
        assert_eq!(local_file_link("C:\\Users\\me\\", None), None);
        assert_eq!(local_file_link("C:\\", None), None);
    }

    #[test]
    fn relative_links_resolve_against_a_windows_folder_and_never_climb_past_its_drive() {
        let root = Some("C:\\Users\\me\\repo");
        assert_eq!(local_file_link("docs/spec.md", root), link("C:\\Users\\me\\repo\\docs\\spec.md", None));
        assert_eq!(local_file_link("docs\\spec.md:7", root), link("C:\\Users\\me\\repo\\docs\\spec.md", Some(7)));
        assert_eq!(local_file_link("../shared%20report.md:12", root), link("C:\\Users\\me\\shared report.md", Some(12)));
        assert_eq!(local_file_link("../../../../../a.md", root), link("C:\\a.md", None));
    }

    #[test]
    fn a_drive_letter_is_the_only_colon_a_windows_path_gets_past_the_scheme_check() {
        assert!(is_windows_path("C:\\repo"));
        assert!(is_windows_path("c:/repo"));
        assert!(is_windows_path("C:%5Crepo"));
        assert!(is_windows_path("C:%5crepo"));
        assert!(!is_windows_path("C:repo"));
        assert!(!is_windows_path("mailto:a@b.c"));
        assert_eq!(local_file_link("C:repo", None), None);
        assert_eq!(local_file_link("ab:\\repo", None), None);
    }

    #[test]
    fn names_and_folders_read_both_kinds_of_path() {
        assert_eq!(file_link_name("/repo/docs/spec.md"), "spec.md");
        assert_eq!(file_link_name("C:\\repo\\docs\\spec.md"), "spec.md");
        assert_eq!(file_link_folder("/repo/docs/spec.md"), "/repo/docs");
        assert_eq!(file_link_folder("/spec.md"), "/");
        assert_eq!(file_link_folder("C:\\repo\\docs\\spec.md"), "C:\\repo\\docs");
        assert_eq!(file_link_folder("C:\\spec.md"), "C:\\");
        assert_eq!(file_link_folder("spec.md"), "/");
    }

    #[test]
    fn web_links_and_anchors_stay_links() {
        for href in ["https://example.com/a.md", "mailto:a@b.c", "#section", "//example.com/a.md", "file:///etc/passwd", "/repo/docs/", "javascript:alert(1)", "", "  ", "/a\nb", "/a%zz.md", "/a%ff.md"] {
            assert_eq!(local_file_link(href, None), None, "{href}");
        }
    }

    #[test]
    fn markdown_files_are_recognized_by_extension() {
        assert!(is_markdown_file("spec.md"));
        assert!(is_markdown_file("README.MDX"));
        assert!(is_markdown_file("notes.markdown"));
        assert!(!is_markdown_file("main.ts"));
    }
}
