//! Inline code that names a file: `apps/desktop/app/src/lib/file-links.ts` `fileLinkTarget`, ported with its test
//! vectors. A reply's markdown links (`[x](path)`) go through `logic::files::local_file_link` instead (see
//! [`super::LinkTarget::of`]).

/// The file a bit of inline code names, relative to the Chat's folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLinkTarget {
    pub path: String,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

/// Extensions that make a bit of inline code read as a file. A list rather than any `.word`, so `console.log`,
/// `Math.max` and `example.com` stay code.
const EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "md", "mdx", "css", "scss", "sass", "less", "html", "htm",
    "yml", "yaml", "toml", "ini", "cfg", "conf", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
    "php", "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "proto", "lock", "txt", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp",
    "ico", "plist", "gradle", "vue", "svelte", "astro", "dart", "lua", "ex", "exs", "hs", "scala", "clj", "tf", "env", "csv", "tsv",
    "ipynb",
];
const DOTFILES: &[&str] =
    &["gitignore", "gitattributes", "env", "npmrc", "nvmrc", "prettierrc", "eslintrc", "editorconfig", "dockerignore"];

/// `[\w.@+()[\]-]`: a character a path segment may hold.
fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '+' | '(' | ')' | '[' | ']' | '-')
}

/// `/^[\w.@+()[\]-]+(\/[\w.@+()[\]-]+)*$/`: segments of path characters joined by single slashes.
fn is_path(path: &str) -> bool {
    path.split('/').all(|segment| !segment.is_empty() && segment.chars().all(is_path_char))
}

/// `(?::(\d+)(?::(\d+)|-\d+)?)?$` against what follows the path: `None` when it does not match, else the line and
/// column digits.
fn line_suffix(rest: &str) -> Option<(Option<&str>, Option<&str>)> {
    if rest.is_empty() {
        return Some((None, None));
    }
    let after_colon = rest.strip_prefix(':')?;
    let digits = after_colon.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let (line, tail) = after_colon.split_at(digits);
    if tail.is_empty() {
        return Some((Some(line), None));
    }
    let (sign, number) = tail.split_at(1);
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match sign {
        ":" => Some((Some(line), Some(number))),
        "-" => Some((Some(line), None)),
        _ => None,
    }
}

/// `Number(digits)` for a line or column: saturates where JavaScript would keep a float.
fn number(digits: &str) -> u64 {
    digits.parse().unwrap_or(u64::MAX)
}

/// `fileLinkTarget`: the file a bit of inline code names, or `None` when it reads as something else: a relative path
/// with a known extension, optionally ending in `:line`, `:line:column` or `:line-line`. Commands, words, versions,
/// URLs and absolute or parent-relative paths are not files. The renderer can't tell whether the file exists.
pub fn file_link_target(code: &str) -> Option<FileLinkTarget> {
    // `/^(.+?)(…)?$/`: the shortest path (`.` matches no line terminator) whose remainder is a line suffix.
    if code.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let (path, (line, column)) = code
        .char_indices()
        .skip(1)
        .map(|(at, _)| at)
        .chain(std::iter::once(code.len()))
        .find_map(|at| line_suffix(&code[at..]).map(|suffix| (&code[..at], suffix)))?;
    if !is_path(path) || path.starts_with('-') || path.ends_with('/') {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.iter().enumerate().any(|(index, segment)| *segment == ".." || (*segment == "." && index > 0)) {
        return None;
    }
    let name = segments.last().filter(|name| !name.is_empty())?;
    let dot = name.rfind('.')?;
    if dot == name.len() - 1 {
        return None;
    }
    let extension = name[dot + 1..].to_lowercase();
    let known = if dot == 0 { DOTFILES.contains(&extension.as_str()) } else { EXTENSIONS.contains(&extension.as_str()) };
    if !known {
        return None;
    }
    let line = line.map(number);
    if line == Some(0) {
        return None;
    }
    Some(FileLinkTarget { path: path.to_string(), line, column: column.map(number) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(path: &str, line: Option<u64>, column: Option<u64>) -> Option<FileLinkTarget> {
        Some(FileLinkTarget { path: path.into(), line, column })
    }

    /// `file-links.test.ts`: "relative file paths, with or without a line, are links".
    #[test]
    fn relative_file_paths_with_or_without_a_line_are_links() {
        assert_eq!(file_link_target("README.md"), target("README.md", None, None));
        assert_eq!(file_link_target("app/src/App.tsx:42"), target("app/src/App.tsx", Some(42), None));
        assert_eq!(file_link_target("app/src/App.tsx:42:7"), target("app/src/App.tsx", Some(42), Some(7)));
        assert_eq!(file_link_target("./electron/main.cjs"), target("./electron/main.cjs", None, None));
        assert_eq!(file_link_target("package.json"), target("package.json", None, None));
        assert_eq!(file_link_target("src/index.d.ts:3"), target("src/index.d.ts", Some(3), None));
        assert_eq!(file_link_target("app/src/lib/settings.ts:10-20"), target("app/src/lib/settings.ts", Some(10), None));
        assert_eq!(file_link_target("app/(group)/[id].tsx"), target("app/(group)/[id].tsx", None, None));
        assert_eq!(file_link_target(".gitignore"), target(".gitignore", None, None));
        assert_eq!(file_link_target("styles.CSS"), target("styles.CSS", None, None));
    }

    /// `file-links.test.ts`: "plain words, commands, versions and URLs stay code".
    #[test]
    fn plain_words_commands_versions_and_urls_stay_code() {
        for code in [
            "npm test",
            "useState",
            "v1.2.3",
            "1.2.3",
            "https://example.com/a.ts",
            "http://localhost:5180",
            "console.log",
            "Math.max",
            "example.com",
            "e.g.",
            "foo.bar",
            "git status",
            "--flag",
            "a.ts b.ts",
            "",
            "src/",
            "src/utils",
            "file.ts:",
            "file.ts:0",
            "file.ts:x",
            "file.ts:1:2:3",
            "C:\\Users\\a.ts",
            "$HOME/a.ts",
            "~/a.ts",
            "/etc/hosts",
            "/abs/path/a.ts",
            "../outside.ts",
            "a/../b.ts",
            "mailto:a@b.co",
            "foo.tsx()",
            "name@1.2.0",
            "a.ts\nb.ts",
        ] {
            assert_eq!(file_link_target(code), None, "{code:?}");
        }
    }
}
