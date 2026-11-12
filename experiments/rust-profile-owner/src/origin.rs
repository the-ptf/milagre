//! runtime.cjs `withOrigins`: each listed Project's Git origin as one id, so a picker shows one repository cloned on
//! several computers as one Project. Read once per folder while the owner runs, as Node's `projectOrigin` reads it:
//! the remote URL (`git remote get-url origin`, here through the registry's verified identity and locked-down Git:
//! no global or system config, so a global `insteadOf` doesn't apply as it does for Node), then
//! `packages/shared/src/project-origin.mjs` originId. A folder without Git, without an origin, outside the copy or with
//! a local-path remote has none.
use std::{collections::HashMap, sync::Mutex};

/// The origins read so far, by folder.
#[derive(Default)]
pub struct Origins {
    known: Mutex<HashMap<String, Option<String>>>,
}

impl Origins {
    /// The origin id of `folder`, from `remote_url` the first time it is asked.
    pub fn of(&self, folder: &str, remote_url: impl FnOnce() -> Option<String>) -> Option<String> {
        if let Some(known) = self
            .known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(folder)
        {
            return known.clone();
        }
        let origin = remote_url().and_then(|url| origin_id(&url));
        self.known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(folder.to_owned(), origin.clone());
        origin
    }
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JavaScript's `.` in a regular expression: anything but a line terminator.
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `^[a-z][a-z0-9+.-]*:\/\/` (case-insensitive): the scheme, lowercased.
fn scheme(value: &str) -> Option<String> {
    let end = value.find("://")?;
    let scheme = &value[..end];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
    .then(|| scheme.to_ascii_lowercase())
}

/// `new URL(value)`'s hostname and pathname, for the forms a Git remote takes. None where URL parsing throws.
fn url_parts(value: &str, scheme: &str) -> Option<(String, String)> {
    let special = matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp");
    let mut rest = &value[scheme.len() + 3..];
    if special {
        // The special-authority states skip any further slashes.
        rest = rest.trim_start_matches(['/', '\\']);
    }
    let end = rest
        .find(|c: char| matches!(c, '/' | '?' | '#') || (special && c == '\\'))
        .unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        let close = inner.find(']')?;
        let port = &inner[close + 1..];
        if !(port.is_empty()
            || port
                .strip_prefix(':')
                .is_some_and(|p| p.chars().all(|c| c.is_ascii_digit())))
        {
            return None;
        }
        &host_port[..close + 2]
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
            Some(_) => return None,
            None => host_port,
        }
    };
    if special && host.is_empty() {
        return None;
    }
    let tail = &rest[end..];
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let mut pathname = tail[..path_end].to_owned();
    if special {
        pathname = pathname.replace('\\', "/");
        if pathname.is_empty() {
            pathname = "/".into();
        }
    }
    Some((host.to_owned(), pathname))
}

/// `^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/)(.+)$`: an scp-like `user@host:owner/repo`.
fn scp(value: &str) -> Option<(String, String)> {
    let stop = |c: char| c == ':' || c == '/' || c.is_whitespace();
    let from = |start: usize| -> Option<(String, String)> {
        let rest = &value[start..];
        let end = rest.find(stop)?;
        let host = &rest[..end];
        let path = rest[end..].strip_prefix(':')?;
        if host.chars().count() < 2
            || path.is_empty()
            || path.starts_with('/')
            || path.contains(line_terminator)
        {
            return None;
        }
        Some((host.to_owned(), path.to_owned()))
    };
    let user_end = value.find(|c: char| c == '@' || c == '/' || c.is_whitespace());
    if let Some(at) = user_end.filter(|at| *at > 0 && value[*at..].starts_with('@')) {
        if let Some(found) = from(at + 1) {
            return Some(found);
        }
    }
    from(0)
}

/// originId: a remote URL as "host/owner/repo", lowercased; None for a local path or no remote.
pub fn origin_id(url: &str) -> Option<String> {
    let value = js_trim(url);
    let (host, pathname) = match scheme(value) {
        Some(scheme) if scheme == "file" => return None,
        Some(scheme) => url_parts(value, &scheme)?,
        None => scp(value)?,
    };
    let trimmed = pathname.trim_matches('/');
    let repo = match trimmed
        .len()
        .checked_sub(4)
        .and_then(|at| trimmed.get(at..).map(|end| (at, end)))
    {
        Some((at, end)) if end.eq_ignore_ascii_case(".git") => &trimmed[..at],
        _ => trimmed,
    };
    (!host.is_empty() && !repo.is_empty()).then(|| format!("{host}/{repo}").to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forms_project_origin_documents() {
        for url in [
            "git@github.com:Owner/Repo.git",
            "https://github.com/owner/repo",
            "ssh://git@github.com/owner/repo/",
            "  https://user:token@GitHub.com:443/owner/repo.GIT\n",
        ] {
            assert_eq!(
                origin_id(url).as_deref(),
                Some("github.com/owner/repo"),
                "{url}"
            );
        }
        assert_eq!(
            origin_id("https:///github.com/o/r").as_deref(),
            Some("github.com/o/r")
        );
        for url in [
            "/srv/repo.git",
            "file:///srv/repo",
            "C:\\repo",
            "",
            "x:/abs",
            "https:///nohost",
        ] {
            assert_eq!(origin_id(url), None, "{url}");
        }
    }
}
