//! After `packages/shared/src/file-kinds.mjs`: the badge letters or icon, and the tint, of a path.

/// Images' identity colour, the same in every theme: an image file's icon and a pasted image's chip.
pub const IMAGE_COLOR: &str = "#8250df";

/// What `fileKind` returns: either badge letters or an icon name, and the tint to draw them in (`#rrggbb`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileKind {
    pub badge: Option<&'static str>,
    pub icon: Option<&'static str>,
    pub color: &'static str,
}

/// `BADGES`: extension, letters, colour.
const BADGES: [(&str, &str, &str); 12] = [
    ("ts", "TS", "#3178c6"),
    ("js", "JS", "#c9a400"),
    ("py", "PY", "#3776ab"),
    ("go", "GO", "#00a7c7"),
    ("rs", "RS", "#c4562a"),
    ("md", "MD", "#6b7280"),
    ("json", "JSON", "#b8860b"),
    ("css", "CSS", "#2965f1"),
    ("html", "HTML", "#e34f26"),
    ("sh", "SH", "#4e9a06"),
    ("swift", "SWIFT", "#f05138"),
    ("kt", "KT", "#7f52ff"),
];

const GREY: &str = "#8a8f98";

/// `fileKind`: badge letters or an icon name for a path, with the tint to draw it in.
pub fn file_kind(path: &str) -> FileKind {
    if path.ends_with('/') {
        return FileKind { badge: None, icon: Some("folder"), color: GREY };
    }
    let name = &path[path.rfind('/').map_or(0, |at| at + 1)..];
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    };
    match ext.as_str() {
        "tsx" | "jsx" => return FileKind { badge: None, icon: Some("react"), color: "#00a6c8" },
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => return FileKind { badge: None, icon: Some("image"), color: IMAGE_COLOR },
        _ => {}
    }
    match BADGES.iter().find(|(id, _, _)| *id == ext) {
        Some((_, badge, color)) => FileKind { badge: Some(badge), icon: None, color },
        None => FileKind { badge: None, icon: Some("file"), color: GREY },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_kind_maps_extensions_to_badges_and_icons() {
        assert_eq!(file_kind("x.tsx").icon, Some("react"));
        assert_eq!(file_kind("x.ts").badge, Some("TS"));
        assert_eq!(file_kind("x.ts").icon, None);
        assert_eq!(file_kind("dir/").icon, Some("folder"));
        assert_eq!(file_kind("a/logo.PNG").icon, Some("image"));
        assert_eq!(file_kind("README").icon, Some("file"));
        assert_eq!(file_kind("x.kt").badge, Some("KT"));
        let color = file_kind("x.py").color;
        assert!(color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn dotfiles_and_dotted_folders_have_no_extension() {
        assert_eq!(file_kind(".ts").icon, Some("file"));
        assert_eq!(file_kind("a.b/Makefile").icon, Some("file"));
        assert_eq!(file_kind("a/.hidden.rs").badge, Some("RS"));
        assert_eq!(file_kind("x.JSON").badge, Some("JSON"));
        // An object key such as `constructor` is never an extension.
        assert_eq!(file_kind("x.constructor").icon, Some("file"));
    }

    #[test]
    fn the_table_matches_the_typescript_source() {
        let Some(ts) = crate::logic::copy::source::shared("file-kinds.mjs") else { return };
        for (ext, badge, color) in BADGES {
            let line = format!("  {ext}: [\"{badge}\", \"{color}\"],");
            assert!(ts.contains(&line), "{line}");
        }
        for text in [IMAGE_COLOR, GREY, "#00a6c8"] {
            assert!(ts.contains(text), "{text}");
        }
    }
}
