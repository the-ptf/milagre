//! Whether files are inside a Chat's own folders: what Auto edits without asking. Port of
//! packages/core/src/agents/permissions.cjs `insideWorkspace`, used for every root (Node uses the
//! lexical `insideRoot` for a Project Chat's lone cwd; this always takes the canonical path).
//!
//! - Requested files containing `..` fail closed before normalization: a symlink followed by
//!   `..` has different kernel and lexical meanings. This deliberately differs from Node.
//! - Empty paths fail closed; other files are resolved against `cwd`.
//! - Roots are canonicalized (`realpath`); a root that can't be is an error, and every error fails
//!   closed (`false`).
//! - A file is canonicalized; one that doesn't exist yet takes its nearest existing ancestor's
//!   canonical path plus the missing rest, so a symlinked ancestor can't alias out of a root.
//! - A path that exists but can't be canonicalized (a dangling symlink, a loop) fails closed; Node
//!   would treat a dangling symlink as a new file, which could write through it.
//! - A file equal to a root is not inside it; no files is `false`.

use std::io;
use std::path::{Component, Path, PathBuf};

/// `true` when every file is strictly inside one of `roots`. Any I/O error is `false`.
pub fn inside_workspace<R: AsRef<Path>, F: AsRef<Path>>(roots: &[R], files: &[F], cwd: &Path) -> bool {
    check(roots, files, cwd).unwrap_or(false)
}

fn check<R: AsRef<Path>, F: AsRef<Path>>(roots: &[R], files: &[F], cwd: &Path) -> io::Result<bool> {
    if files.is_empty() || roots.is_empty() {
        return Ok(false);
    }
    let cwd = absolute(cwd)?;
    let canonical: Vec<PathBuf> =
        roots.iter().map(|root| std::fs::canonicalize(absolute_from(&cwd, root.as_ref()))).collect::<io::Result<_>>()?;
    for file in files {
        let file = file.as_ref();
        if file.as_os_str().is_empty() || file.components().any(|c| c == Component::ParentDir) {
            return Ok(false);
        }
        let resolved = resolve(&absolute_from(&cwd, file))?;
        let inside = canonical.iter().any(|root| match resolved.strip_prefix(root) {
            Ok(rest) => rest.components().next().is_some(),
            Err(_) => false,
        });
        if !inside {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `path.resolve(process.cwd(), path)`.
fn absolute(path: &Path) -> io::Result<PathBuf> {
    Ok(normalize(&std::env::current_dir()?.join(path)))
}

/// `path.resolve(cwd, file)`: joined (an absolute file replaces cwd), then `.` and `..` folded lexically.
fn absolute_from(cwd: &Path, file: &Path) -> PathBuf {
    normalize(&cwd.join(file))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            // `/..` stays `/`, as in Node.
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// The canonical path, or for a missing file its nearest existing ancestor's canonical path plus
/// the rest. Errors other than "not found" (permission, not a directory) are returned.
fn resolve(path: &Path) -> io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(real),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Something is there (a dangling or looping symlink): writing could follow it anywhere.
            if std::fs::symlink_metadata(path).is_ok() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "unresolvable link"));
            }
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(error) };
            Ok(resolve(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}
