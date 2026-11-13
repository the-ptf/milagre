//! The slice of Node's `path` / `path.win32` that terminals.cjs uses, so shell discovery gives the same strings on
//! every host (the Node tests run Windows and Linux cases on a Mac).

pub mod posix {
    pub fn is_absolute(path: &str) -> bool {
        path.starts_with('/')
    }

    pub fn basename(path: &str) -> &str {
        let trimmed = path.trim_end_matches('/');
        match trimmed.rfind('/') {
            Some(index) => &trimmed[index + 1..],
            None => trimmed,
        }
    }

    /// `path.posix.join`: joins the non-empty parts with `/`, then normalizes.
    pub fn join(parts: &[&str]) -> String {
        let joined = parts.iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("/");
        if joined.is_empty() {
            return ".".into();
        }
        normalize(&joined)
    }

    pub fn normalize(path: &str) -> String {
        if path.is_empty() {
            return ".".into();
        }
        let absolute = is_absolute(path);
        let trailing = path.ends_with('/');
        let mut out: Vec<&str> = Vec::new();
        for segment in path.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    if out.last().is_some_and(|last| *last != "..") {
                        out.pop();
                    } else if !absolute {
                        out.push("..");
                    }
                }
                other => out.push(other),
            }
        }
        let mut result = out.join("/");
        if result.is_empty() && !absolute {
            result = ".".into();
        }
        if trailing && !result.is_empty() && result != "." {
            result.push('/');
        }
        if absolute {
            format!("/{result}")
        } else {
            result
        }
    }
}

pub mod win32 {
    fn is_sep(c: char) -> bool {
        c == '\\' || c == '/'
    }

    fn drive_len(path: &str) -> usize {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            2
        } else {
            0
        }
    }

    pub fn is_absolute(path: &str) -> bool {
        let mut chars = path.chars();
        match chars.next() {
            None => false,
            Some(first) if is_sep(first) => true,
            Some(_) => drive_len(path) == 2 && path[2..].chars().next().is_some_and(is_sep),
        }
    }

    pub fn basename(path: &str) -> &str {
        let rest = &path[drive_len(path)..];
        let trimmed = rest.trim_end_matches(is_sep);
        match trimmed.rfind(is_sep) {
            Some(index) => &trimmed[index + 1..],
            None => trimmed,
        }
    }

    /// `path.win32.join` for drive-letter and relative paths (UNC prefixes are not needed here).
    pub fn join(parts: &[&str]) -> String {
        let joined = parts.iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("\\");
        if joined.is_empty() {
            return ".".into();
        }
        normalize(&joined)
    }

    pub fn normalize(path: &str) -> String {
        let drive = &path[..drive_len(path)];
        let rest = &path[drive.len()..];
        let absolute = rest.chars().next().is_some_and(is_sep);
        let trailing = rest.chars().last().is_some_and(is_sep);
        let mut out: Vec<&str> = Vec::new();
        for segment in rest.split(is_sep) {
            match segment {
                "" | "." => {}
                ".." => {
                    if out.last().is_some_and(|last| *last != "..") {
                        out.pop();
                    } else if !absolute {
                        out.push("..");
                    }
                }
                other => out.push(other),
            }
        }
        let mut tail = out.join("\\");
        if tail.is_empty() && !absolute {
            tail = ".".into();
        }
        if trailing && !tail.is_empty() && tail != "." {
            tail.push('\\');
        }
        format!("{drive}{}{tail}", if absolute { "\\" } else { "" })
    }
}

/// `path.basename` on the host this owner runs on.
pub fn host_basename(path: &str) -> &str {
    if cfg!(windows) {
        win32::basename(path)
    } else {
        posix::basename(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_matches_node() {
        assert_eq!(posix::join(&["/opt/bin/", "zsh"]), "/opt/bin/zsh");
        assert_eq!(posix::join(&["/usr/bin/.", "zsh"]), "/usr/bin/zsh");
        assert_eq!(posix::join(&["/a/b/..", "c"]), "/a/c");
        assert_eq!(posix::basename("/bin/zsh"), "zsh");
        assert_eq!(posix::basename("/bin/"), "bin");
        assert_eq!(posix::basename("-zsh"), "-zsh");
        assert!(!posix::is_absolute("relative"));
    }

    #[test]
    fn win32_matches_node() {
        assert_eq!(win32::join(&["C:\\Tools", "pwsh.exe"]), "C:\\Tools\\pwsh.exe");
        assert_eq!(win32::join(&["C:\\Windows", "System32", "cmd.exe"]), "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(win32::join(&["C:/Tools/", "x.exe"]), "C:\\Tools\\x.exe");
        assert_eq!(win32::basename("C:\\Windows\\System32\\cmd.exe"), "cmd.exe");
        assert!(win32::is_absolute("C:\\x"));
        assert!(win32::is_absolute("\\x"));
        assert!(!win32::is_absolute("C:x"));
        assert!(!win32::is_absolute("Tools"));
    }
}
