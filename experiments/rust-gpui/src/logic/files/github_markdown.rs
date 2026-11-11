//! After `packages/shared/src/github-markdown.ts`: what GitHub writes into a PR description or comment beyond
//! Markdown. A drag-dropped image becomes an `<img>` tag at github.com/user-attachments, which a private
//! repository serves only to a signed-in viewer.

use crate::logic::copy::js;

/// `isGitHubAttachment`: an image GitHub stores for a PR's text; the PR's computer reads it with gh's token.
/// `^https://github\.com/(?:user-attachments/assets|[\w.-]+/[\w.-]+/assets/\d+)/[0-9a-f-]{36}$`
pub fn is_github_attachment(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else { return false };
    let Some((head, id)) = rest.rsplit_once('/') else { return false };
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-') {
        return false;
    }
    if head == "user-attachments/assets" {
        return true;
    }
    let parts: Vec<&str> = head.split('/').collect();
    let name_ok = |part: &str| !part.is_empty() && part.chars().all(|c| js::is_word(c) || c == '.' || c == '-');
    matches!(parts.as_slice(), [owner, repo, assets, number]
        if name_ok(owner) && name_ok(repo) && *assets == "assets" && !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether `text[at..]` starts with `name`, ASCII case-insensitively.
fn starts_with_ci(text: &str, at: usize, name: &str) -> bool {
    text.as_bytes().get(at..at + name.len()).is_some_and(|slice| slice.eq_ignore_ascii_case(name.as_bytes()))
}

/// Whether the byte at `at` is a `\b` boundary after a word char (true at the end).
fn boundary_after_word(text: &str, at: usize) -> bool {
    text[at..].chars().next().is_none_or(|c| !js::is_word(c))
}

/// The end (exclusive) of `[^>]*>` from `from`: the index just past the next `>`.
fn tag_end(text: &str, from: usize) -> Option<usize> {
    text[from..].find('>').map(|at| from + at + 1)
}

/// `attribute(tag, name)`: the value of ` name=...` in a tag, double-quoted, single-quoted or bare; the first
/// match, case-insensitive. An empty quoted value is a value (and so `Some("")`).
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    for (start, c) in tag.char_indices() {
        if !js::is_space(c) {
            continue;
        }
        let mut at = start + c.len_utf8();
        if !starts_with_ci(tag, at, name) {
            continue;
        }
        at += name.len();
        at += tag[at..].chars().take_while(|c| js::is_space(*c)).map(char::len_utf8).sum::<usize>();
        if !tag[at..].starts_with('=') {
            continue;
        }
        at += 1;
        at += tag[at..].chars().take_while(|c| js::is_space(*c)).map(char::len_utf8).sum::<usize>();
        let rest = &tag[at..];
        for quote in ['"', '\''] {
            if let Some(inner) = rest.strip_prefix(quote) {
                if let Some(close) = inner.find(quote) {
                    return Some(&inner[..close]);
                }
            }
        }
        let bare = rest.find(|c: char| js::is_space(c) || c == '>').unwrap_or(rest.len());
        if bare > 0 {
            return Some(&rest[..bare]);
        }
    }
    None
}

/// An `<img>` tag as a Markdown image; an image without a source goes.
fn image_markdown(tag: &str) -> String {
    let Some(src) = attribute(tag, "src").filter(|src| !src.is_empty()) else { return String::new() };
    let alt = attribute(tag, "alt").filter(|alt| !alt.is_empty()).unwrap_or("Image");
    let alt: String = alt.chars().filter(|c| !matches!(c, '[' | ']' | '\\')).collect();
    let src: String = src.chars().filter(|c| !matches!(c, '<' | '>') && !js::is_space(*c)).collect();
    format!("![{alt}](<{src}>)")
}

const WRAPPERS: [&str; 11] = ["p", "div", "span", "center", "details", "summary", "picture", "sub", "sup", "b", "i"];
const WRAPPERS_TAIL: [&str; 3] = ["em", "strong", ""];

/// The wrapper tag starting at `at` (`</?(?:p|div|...|strong)\b[^>]*>`): its end, if there is one.
fn wrapper_end(text: &str, at: usize) -> Option<usize> {
    let mut name_at = at + 1;
    if text[name_at..].starts_with('/') {
        name_at += 1;
    }
    for name in WRAPPERS.iter().chain(WRAPPERS_TAIL.iter()).filter(|name| !name.is_empty()) {
        if starts_with_ci(text, name_at, name) && boundary_after_word(text, name_at + name.len()) {
            if let Some(end) = tag_end(text, name_at + name.len()) {
                return Some(end);
            }
        }
    }
    None
}

/// `convert`: images, `<br>` and wrapper tags in a stretch of prose with no code span in it.
fn convert(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let c = text[at..].chars().next().expect("at < len");
        if c != '<' {
            out.push(c);
            at += c.len_utf8();
            continue;
        }
        // The three replacements run one after another in TypeScript (images, then `<br>`, then wrappers). A
        // replacement never creates text another one would match, so one left-to-right pass gives the same result.
        if starts_with_ci(text, at + 1, "img") && boundary_after_word(text, at + 4) {
            if let Some(end) = tag_end(text, at + 4) {
                out.push_str(&image_markdown(&text[at..end]));
                at = end;
                continue;
            }
        }
        if starts_with_ci(text, at + 1, "br") {
            let mut next = at + 3;
            next += text[next..].chars().take_while(|c| js::is_space(*c)).map(char::len_utf8).sum::<usize>();
            if text[next..].starts_with('/') {
                next += 1;
            }
            if text[next..].starts_with('>') {
                out.push(' ');
                at = next + 1;
                continue;
            }
        }
        if let Some(end) = wrapper_end(text, at) {
            at = end;
            continue;
        }
        out.push('<');
        at += 1;
    }
    out
}

/// Splits a line at its code spans (`/(`+[^`]*`+)/`) and converts only the text between them.
fn convert_outside_code(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut text_start = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'`' {
            at += 1;
            continue;
        }
        let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
        let after = at + run;
        let next_tick = line[after..].find('`').map(|found| after + found);
        let end = match next_tick {
            Some(tick) => Some(tick + bytes[tick..].iter().take_while(|b| **b == b'`').count()),
            // No closing run: backticks alone still match from two on (the regex backtracks into the run).
            None if run >= 2 => Some(after),
            None => None,
        };
        match end {
            Some(end) => {
                out.push_str(&convert(&line[text_start..at]));
                out.push_str(&line[at..end]);
                text_start = end;
                at = end;
            }
            None => at += run,
        }
    }
    out.push_str(&convert(&line[text_start..]));
    out
}

/// `<!--[\s\S]*?(?:-->|$)` removed: comments, a template's hints, across lines too; an unclosed one runs to the end.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// The run of backticks or tildes that opens or closes a fence on this line: `^\s{0,3}(`{3,}|~{3,})`.
fn fence_marker(line: &str) -> Option<&str> {
    let indent: usize = line.chars().take_while(|c| js::is_space(*c)).count();
    if indent > 3 {
        return None;
    }
    let start: usize = line.chars().take(indent).map(char::len_utf8).sum();
    let rest = &line[start..];
    let first = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest.chars().take_while(|c| *c == first).count();
    (run >= 3).then(|| &rest[..run])
}

/// `githubHtmlToMarkdown`: GitHub's HTML in a PR's text as the Markdown a renderer without HTML shows: images
/// become Markdown images, and comments and wrapper tags go, outside code. Code spans and fences keep their text.
pub fn github_html_to_markdown(text: &str) -> String {
    if !text.contains('<') {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let flush = |prose: &mut Vec<&str>, out: &mut Vec<String>| {
        if prose.is_empty() {
            return;
        }
        let joined = strip_comments(&prose.join("\n"));
        out.extend(joined.split('\n').map(convert_outside_code));
        prose.clear();
    };
    let mut fence: Option<&str> = None;
    for line in text.split('\n') {
        let marker = fence_marker(line);
        if let Some(open) = fence {
            if marker.is_some_and(|marker| marker.as_bytes()[0] == open.as_bytes()[0] && marker.len() >= open.len()) {
                fence = None;
            }
            out.push(line.to_string());
        } else if let Some(marker) = marker {
            flush(&mut prose, &mut out);
            fence = Some(marker);
            out.push(line.to_string());
        } else {
            prose.push(line);
        }
    }
    flush(&mut prose, &mut out);
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET: &str = "https://github.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da";

    #[test]
    fn a_drag_dropped_image_tag_becomes_a_markdown_image_inside_a_table_too() {
        assert_eq!(github_html_to_markdown(&format!("<img width=\"250\" alt=\"Screen\" src=\"{ASSET}\" />")), format!("![Screen](<{ASSET}>)"));
        assert_eq!(github_html_to_markdown(&format!("| <img src='{ASSET}'> | b |")), format!("| ![Image](<{ASSET}>) | b |"));
        assert_eq!(github_html_to_markdown("<img alt=x>"), "", "An image without a source goes");
    }

    #[test]
    fn wrapper_tags_and_line_breaks_go_their_text_stays() {
        assert_eq!(github_html_to_markdown("<details><summary>Notes</summary>\n\nBody<br/>more\n</details>"), "Notes\n\nBody more\n");
        assert_eq!(github_html_to_markdown("a <kbd>K</kbd> b"), "a <kbd>K</kbd> b", "Other tags stay as written");
    }

    #[test]
    fn comments_go_across_lines_too_but_not_inside_code() {
        assert_eq!(github_html_to_markdown("<!-- triage:v1 -->\nBug fix"), "\nBug fix");
        assert_eq!(github_html_to_markdown("a\n<!-- Describe\nthe change -->\nb"), "a\n\nb");
        assert_eq!(github_html_to_markdown("```\n<!-- kept -->\n```"), "```\n<!-- kept -->\n```");
        assert_eq!(github_html_to_markdown("a <!-- never closed\nb"), "a ");
    }

    #[test]
    fn code_keeps_its_tags() {
        let fenced = ["```html", &format!("<img src=\"{ASSET}\">"), "```", "`<br>` and <br>"].join("\n");
        let expected = ["```html", &format!("<img src=\"{ASSET}\">"), "```", "`<br>` and  "].join("\n");
        assert_eq!(github_html_to_markdown(&fenced), expected);
    }

    #[test]
    fn text_without_a_tag_is_returned_as_is() {
        assert_eq!(github_html_to_markdown("plain `code` text"), "plain `code` text");
    }

    #[test]
    fn tag_edge_cases() {
        // `\b` after the tag name: <bx> and <pre> are not wrappers; <br > with a space is a break.
        assert_eq!(github_html_to_markdown("<bx>t</bx> <pre>x</pre>"), "<bx>t</bx> <pre>x</pre>");
        assert_eq!(github_html_to_markdown("a<br >b<BR/>c"), "a b c");
        assert_eq!(github_html_to_markdown("<P ALIGN=\"center\">Hi</P><picture>x</picture><sub>2</sub>"), "Hix2");
        // An unterminated tag stays; alt text loses brackets and backslashes; src loses angle brackets and spaces.
        assert_eq!(github_html_to_markdown("a <div"), "a <div");
        assert_eq!(github_html_to_markdown("<img alt=\"a[b]\\c\" src=\"x y.png\">"), "![abc](<xy.png>)");
        // A `>` inside a quoted value ends the tag, as `[^>]*>` does in TypeScript: the quote never closes, so the
        // bare-value rule takes `"x` and the rest of the attribute stays as text.
        assert_eq!(github_html_to_markdown("<img src=\"x<z>.png\">"), "![Image](<\"xz>).png\">");
        assert_eq!(github_html_to_markdown("<img src=a.png>"), "![Image](<a.png>)");
        assert_eq!(github_html_to_markdown("<img alt=\"\" src=\"a.png\">"), "![Image](<a.png>)");
        assert_eq!(github_html_to_markdown("<img data-src=\"x.png\" src=\"y.png\">"), "![Image](<y.png>)");
        assert_eq!(github_html_to_markdown("<img src=\"\">"), "");
        // Fences: a shorter or different closing marker does not close; tildes work.
        assert_eq!(github_html_to_markdown("````\n<br>\n```\n<br>\n````\n<br>"), "````\n<br>\n```\n<br>\n````\n ");
        assert_eq!(github_html_to_markdown("~~~\n<br>\n~~~\nx<br>y"), "~~~\n<br>\n~~~\nx y");
        // Double backticks pair with their own closer.
        assert_eq!(github_html_to_markdown("``a<br>b`` c<br>d"), "``a<br>b`` c d");
    }

    #[test]
    fn only_githubs_attachment_addresses_count_as_attachments() {
        assert!(is_github_attachment(ASSET));
        assert!(is_github_attachment("https://github.com/acme/app/assets/12/1a75943a-4133-4d9d-8fa3-99d4a0b689da"));
        assert!(!is_github_attachment("https://example.com/user-attachments/assets/1a75943a-4133-4d9d-8fa3-99d4a0b689da"));
        assert!(!is_github_attachment(&format!("{ASSET}?x=1")));
        assert!(!is_github_attachment("https://github.com/user-attachments/assets/1A75943A-4133-4D9D-8FA3-99D4A0B689DA"));
        assert!(!is_github_attachment("https://github.com/acme/app/assets/x/1a75943a-4133-4d9d-8fa3-99d4a0b689da"));
        assert!(!is_github_attachment("https://github.com/user-attachments/assets/short"));
    }
}
