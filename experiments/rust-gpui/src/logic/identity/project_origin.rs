//! The same repository cloned on two computers is one Project in the new-chat picker: its Git origin, read as one
//! id, says which copies belong together (`packages/shared/src/project-origin.mjs`).

use std::collections::HashMap;

use crate::logic::lists::jsstr::{is_js_whitespace, js_trim};

/// Whether `value` starts with `scheme://` (`/^[a-z][a-z0-9+.-]*:\/\//i`); the scheme, lowercased, and the rest.
fn split_scheme(value: &str) -> Option<(String, &str)> {
    let end = value.find("://")?;
    let scheme = &value[..end];
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic() || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), &value[end + 3..]))
}

fn is_special(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp" | "file")
}

/// The path-segment characters the URL parser percent-encodes (the path percent-encode set, as UTF-8 bytes).
fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte <= 0x20 || byte >= 0x7f || matches!(byte, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'#' | b'?') {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(byte as char);
        }
    }
    out
}

/// A special scheme's path with its `.` and `..` segments resolved and backslashes read as slashes.
fn normalize_special_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let last = index == parts.len() - 1;
        match part.to_ascii_lowercase().as_str() {
            "." | "%2e" => {
                if last {
                    segments.push("");
                }
            }
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                segments.pop();
                if last {
                    segments.push("");
                }
            }
            _ => segments.push(part),
        }
    }
    format!("/{}", segments.join("/"))
}

/// What `new URL(value)` gives for `hostname` and `pathname` of a `scheme://` URL: `None` where it throws or the
/// scheme is `file:` (which has no origin). A subset of the URL standard: no IDNA or IPv4 normalisation of the
/// host, which the caller lowercases anyway.
fn parse_url(scheme: &str, rest: &str) -> Option<(String, String)> {
    let special = is_special(scheme);
    // A special scheme ignores any number of slashes after `scheme:`: `https:///a/b` is `https://a/b`.
    let rest = if special { rest.trim_start_matches(['/', '\\']) } else { rest };
    let end = rest.find(|c: char| matches!(c, '/' | '?' | '#') || (special && c == '\\')).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let (host, port) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let rest = &host_port[close + 1..];
        (&host_port[..=close], rest.strip_prefix(':'))
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        }
    };
    if let Some(port) = port
        && !port.is_empty()
        && (!port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u32>().map_or(true, |value| value > 65535))
    {
        return None;
    }
    if host.chars().any(|c| is_js_whitespace(c) || matches!(c, '<' | '>' | '^' | '|' | '\u{0}')) && special {
        return None;
    }
    if special && host.is_empty() {
        return None;
    }
    let pathname = if special { normalize_special_path(&encode_path(path)) } else { encode_path(path) };
    Some((host.to_owned(), pathname))
}

/// The scp-like `user@host:owner/repo` form: `^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/)(.+)$`. A one-letter host is a
/// Windows drive, not a server.
fn parse_scp(value: &str) -> Option<(String, String)> {
    let host_and_path = |rest: &str| -> Option<(String, String)> {
        let host_len = rest.chars().take_while(|c| *c != ':' && *c != '/' && !is_js_whitespace(*c)).map(char::len_utf8).sum::<usize>();
        let host = &rest[..host_len];
        let path = rest[host_len..].strip_prefix(':')?;
        let is_line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        if host.chars().count() < 2 || path.is_empty() || path.starts_with('/') || path.chars().any(is_line_end) {
            return None;
        }
        Some((host.to_owned(), path.to_owned()))
    };
    if let Some(at) = value.find('@') {
        let user = &value[..at];
        if !user.is_empty()
            && !user.chars().any(|c| c == '/' || is_js_whitespace(c))
            && let Some(found) = host_and_path(&value[at + 1..])
        {
            return Some(found);
        }
    }
    host_and_path(value)
}

/// A remote URL as "host/owner/repo", lowercased: "git@github.com:Owner/Repo.git", "https://github.com/owner/repo"
/// and "ssh://git@github.com/owner/repo/" all read "github.com/owner/repo". A local-path remote names a folder only
/// that computer has, so it reads `None`, as does no remote.
pub fn origin_id(url: Option<&str>) -> Option<String> {
    let value = js_trim(url?);
    let (host, pathname) = match split_scheme(value) {
        Some((scheme, rest)) => {
            if scheme == "file" {
                return None;
            }
            parse_url(&scheme, rest)?
        }
        None => parse_scp(value)?,
    };
    // `.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")`
    let trimmed = pathname.trim_matches('/');
    let repo = match trimmed.len().checked_sub(4) {
        Some(cut) if trimmed.is_char_boundary(cut) && trimmed[cut..].eq_ignore_ascii_case(".git") => &trimmed[..cut],
        _ => trimmed,
    };
    if host.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{host}/{repo}").to_lowercase())
}

/// One origin on several computers, as one entry: the first copy's own fields and every computer's copy.
#[derive(Clone, Debug, PartialEq)]
pub struct OriginGroup<T> {
    /// The first copy, which keeps its place and its fields.
    pub first: T,
    /// Every computer's copy in the order given, the first included.
    pub copies: Vec<T>,
}

/// The choices with one origin on several computers as one entry, in the place of its first copy, which it keeps as
/// its own fields; `copies` lists every computer's copy in the order given. A choice with no origin, or a second
/// clone on a computer that already has one, stays on its own.
pub fn group_by_origin<T: Clone>(
    choices: &[T],
    origin_of: impl Fn(&T) -> Option<&str>,
    computer_of: impl Fn(&T) -> &str,
) -> Vec<OriginGroup<T>> {
    let mut groups: Vec<OriginGroup<T>> = Vec::new();
    let mut by_origin: HashMap<String, usize> = HashMap::new();
    for choice in choices {
        let origin = origin_of(choice).filter(|origin| !origin.is_empty());
        let group = origin.and_then(|origin| by_origin.get(origin).copied());
        if let Some(at) = group
            && !groups[at].copies.iter().any(|copy| computer_of(copy) == computer_of(choice))
        {
            groups[at].copies.push(choice.clone());
            continue;
        }
        groups.push(OriginGroup { first: choice.clone(), copies: vec![choice.clone()] });
        if let (Some(origin), None) = (origin, group) {
            by_origin.insert(origin.to_owned(), groups.len() - 1);
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_id_reads_ssh_scp_like_and_https_remotes_of_one_repo_the_same() {
        for url in [
            "git@github.com:the-ptf/milagre-ade.git",
            "https://github.com/the-ptf/milagre-ade",
            "https://victor@github.com/The-PTF/milagre-ade.git/",
            "ssh://git@github.com/the-ptf/milagre-ade.git",
        ] {
            assert_eq!(origin_id(Some(url)).as_deref(), Some("github.com/the-ptf/milagre-ade"), "{url}");
        }
    }

    #[test]
    fn origin_id_a_local_path_a_drive_letter_or_nothing_has_no_origin() {
        for url in [
            Some("/Users/victor/repos/app.git"),
            Some("file:///Users/victor/repos/app.git"),
            Some("C:\\repos\\app"),
            Some(""),
            None,
            Some("not a url"),
        ] {
            assert_eq!(origin_id(url), None, "{url:?}");
        }
    }

    #[test]
    fn origin_id_handles_ports_userinfo_case_and_nested_paths() {
        let id = |url| origin_id(Some(url));
        assert_eq!(id("ssh://git@host.example:2222/Group/Sub/Repo.GIT").as_deref(), Some("host.example/group/sub/repo"));
        assert_eq!(id("  https://GitHub.com/Owner/Repo  ").as_deref(), Some("github.com/owner/repo"));
        assert_eq!(id("git@gitlab.com:group/sub/repo.git").as_deref(), Some("gitlab.com/group/sub/repo"));
        assert_eq!(id("gitlab.com:group/repo").as_deref(), Some("gitlab.com/group/repo"));
        assert_eq!(id("https://github.com/a/b/../c").as_deref(), Some("github.com/a/c"));
        assert_eq!(id("https://github.com/a b/c").as_deref(), Some("github.com/a%20b/c"));
        // No repo, no host, a bad port, an empty scp path or a path starting with a slash have no origin.
        assert_eq!(id("https://github.com"), None);
        assert_eq!(id("https://github.com/"), None);
        assert_eq!(id("https:///owner/repo").as_deref(), Some("owner/repo"), "a special scheme skips extra slashes");
        assert_eq!(id("https:///"), None);
        assert_eq!(id("https://github.com:99999/o/r"), None);
        assert_eq!(id("https://github.com:abc/o/r"), None);
        assert_eq!(id("github.com:"), None);
        assert_eq!(id("github.com://o/r").as_deref(), Some("o/r"), "\"github.com\" reads as a URL scheme");
        assert_eq!(id("https://github.com/.git"), None);
        assert_eq!(id("https://[::1]:8080/o/r").as_deref(), Some("[::1]/o/r"));
        // The userinfo of an scp-like remote may be absent, and the host may hold an `@` when it has no user.
        assert_eq!(id("a@b:c/d").as_deref(), Some("a@b/c/d"));
    }

    #[derive(Clone, Debug, PartialEq)]
    struct Choice {
        key: &'static str,
        computer_id: &'static str,
        origin: Option<&'static str>,
    }

    fn choice(key: &'static str, computer_id: &'static str, origin: Option<&'static str>) -> Choice {
        Choice { key, computer_id, origin }
    }

    fn group(choices: &[Choice]) -> Vec<OriginGroup<Choice>> {
        group_by_origin(choices, |choice| choice.origin, |choice| choice.computer_id)
    }

    #[test]
    fn group_by_origin_one_entry_per_origin_across_computers_in_its_first_copys_place() {
        let groups = group(&[
            choice("/a", "local", Some("github.com/x/a")),
            choice("/b", "local", Some("github.com/x/b")),
            choice("m1|/a", "m1", Some("github.com/x/a")),
            choice("m2|/a", "m2", Some("github.com/x/a")),
        ]);
        assert_eq!(groups.iter().map(|group| group.first.key).collect::<Vec<_>>(), ["/a", "/b"]);
        assert_eq!(groups[0].copies.iter().map(|copy| copy.key).collect::<Vec<_>>(), ["/a", "m1|/a", "m2|/a"]);
    }

    #[test]
    fn group_by_origin_no_origin_or_a_second_clone_on_the_same_computer_stays_its_own_row() {
        let groups = group(&[
            choice("/a", "local", Some("github.com/x/a")),
            choice("/a-2", "local", Some("github.com/x/a")),
            choice("/plain", "local", None),
            choice("m1|/plain", "m1", None),
            choice("/empty", "local", Some("")),
        ]);
        assert_eq!(groups.iter().map(|group| group.copies.len()).collect::<Vec<_>>(), [1, 1, 1, 1, 1]);
        // The second clone is not remembered as a copy target: a later computer's copy joins the first.
        let later = group(&[choice("/a", "local", Some("o")), choice("/a-2", "local", Some("o")), choice("m1|/a", "m1", Some("o"))]);
        assert_eq!(later.iter().map(|group| group.copies.len()).collect::<Vec<_>>(), [2, 1]);
    }
}
