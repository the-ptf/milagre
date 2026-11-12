//! runtime.cjs `withOrigins`: each listed Project's Git origin as one id, so a picker shows one repository cloned on
//! several computers as one Project. Read once per folder while the owner runs, as Node's `projectOrigin` reads it:
//! `git -C <folder> remote get-url origin` in this process's environment (no prompt), then
//! `packages/shared/src/project-origin.mjs` originId. A folder without Git, without an origin, or with a local-path
//! remote has none.
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(15);
const OUTPUT_LIMIT: u64 = 64 * 1024;

/// The origins read so far, by folder.
#[derive(Default)]
pub struct Origins {
    known: Mutex<HashMap<String, Option<String>>>,
}

impl Origins {
    pub fn of(&self, folder: &str) -> Option<String> {
        if let Some(known) = self
            .known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(folder)
        {
            return known.clone();
        }
        let origin = remote_url(folder).and_then(|url| origin_id(&url));
        self.known
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(folder.to_owned(), origin.clone());
        origin
    }
}

/// `git -C folder remote get-url origin`, as git/client.cjs runs a read: the process's environment, no terminal prompt,
/// SSH in batch mode. None when it fails or takes too long.
fn remote_url(folder: &str) -> Option<String> {
    let ssh = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| "ssh -o BatchMode=yes".into());
    let mut child = Command::new("git")
        .args(["-C", folder, "remote", "get-url", "origin"])
        .current_dir(folder)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", ssh)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        stdout.take(OUTPUT_LIMIT).read_to_string(&mut text).ok()?;
        Some(text)
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let text = reader.join().ok().flatten()?;
    status.success().then_some(text)
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
