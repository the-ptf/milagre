//! Whether files are inside a Chat's own folders: what Auto edits without asking. Port of
//! packages/core/src/agents/permissions.cjs `insideWorkspace`, used for every root (Node uses the
//! lexical `insideRoot` for a Project Chat's lone cwd; this always takes the canonical path).
//!
//! - Requested files containing `..` fail closed before normalization: a symlink followed by
//!   `..` has different kernel and lexical meanings. This deliberately differs from Node.
//! - Empty paths fail closed; other files are resolved against `cwd`.
//! - Cwd and roots are canonicalized as supplied, before any lexical folding, so `link/..`
//!   follows the same directory as the child process. Any resolution error fails closed (`false`).
//!   On Windows, cwd/roots containing `..` fail closed too: joining a canonical verbatim path
//!   can fold parent components before filesystem resolution.
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
    #[cfg(windows)]
    if cwd.components().any(|c| c == Component::ParentDir)
        || roots.iter().any(|root| root.as_ref().components().any(|c| c == Component::ParentDir))
    {
        return Ok(false);
    }
    let cwd = std::fs::canonicalize(cwd)?;
    let canonical: Vec<PathBuf> = roots.iter().map(|root| std::fs::canonicalize(cwd.join(root.as_ref()))).collect::<io::Result<_>>()?;
    for file in files {
        let file = file.as_ref();
        if file.as_os_str().is_empty() || file.components().any(|c| c == Component::ParentDir) {
            return Ok(false);
        }
        let resolved = resolve(&cwd.join(file))?;
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
