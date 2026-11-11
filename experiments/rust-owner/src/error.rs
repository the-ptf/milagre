use std::fmt;
use std::path::{Path, PathBuf};

/// Errors from the read-only repositories. `Display` repeats the daemon's message where Node has a fixed one, so a
/// command answered by Rust fails with the text a client already shows.
#[derive(Debug)]
pub enum StoreError {
    /// A file read failed. `code` is Node's `error.code` (ENOENT, EACCES, …) when it maps to one.
    Io {
        code: Option<&'static str>,
        syscall: &'static str,
        path: PathBuf,
        message: String,
    },
    /// coordination.json points at chats.db, which is gone (project-store.cjs readProjectState).
    MissingChatsDb(PathBuf),
    /// coordination.json or a chats.db payload isn't JSON serde can read (see README: lone surrogates).
    Json {
        context: String,
        message: String,
    },
    Sqlite(String),
    /// A rollback journal or WAL next to chats.db: a writer was mid-transaction when this copy was taken. An immutable
    /// read would see half of it, and a recovery would write, so the read is refused.
    HotJournal(PathBuf),
    /// chat-db.cjs findRow: `Messages can't be looked up by ${field}`.
    BadLookup(String),
    /// runtime.cjs chat:message.
    MessageGone,
    /// chat-host.cjs sendStatus input check, via runtime.cjs chat:send-status.
    BadSendStatus,
    /// A value a command can't take (not from Node; Node would coerce or throw a TypeError).
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

impl StoreError {
    pub fn io(error: std::io::Error, syscall: &'static str, path: &Path) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => Some("ENOENT"),
            std::io::ErrorKind::PermissionDenied => Some("EACCES"),
            _ => match error.raw_os_error() {
                Some(libc::EISDIR) => Some("EISDIR"),
                Some(libc::ENOTDIR) => Some("ENOTDIR"),
                Some(libc::ELOOP) => Some("ELOOP"),
                _ => None,
            },
        };
        StoreError::Io {
            code,
            syscall,
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    }

    /// Node's `error.code`, when there is one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            StoreError::Io { code, .. } => *code,
            _ => None,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io { code: Some(code), syscall, path, .. } => {
                let text = match *code {
                    "ENOENT" => "no such file or directory",
                    "EACCES" => "permission denied",
                    "EISDIR" => "illegal operation on a directory",
                    "ENOTDIR" => "not a directory",
                    "ELOOP" => "too many symbolic links encountered",
                    other => other,
                };
                write!(f, "{code}: {text}, {syscall} '{}'", path.display())
            }
            StoreError::Io { code: None, syscall, path, message } => write!(f, "{message}, {syscall} '{}'", path.display()),
            StoreError::MissingChatsDb(path) => {
                write!(f, "This Project's messages are kept in {}, which is missing.", path.display())
            }
            StoreError::Json { context, message } => write!(f, "{context}: {message}"),
            StoreError::Sqlite(message) => write!(f, "{message}"),
            StoreError::HotJournal(path) => write!(
                f,
                "{} has an unfinished transaction beside it; copy the Project again while Milagre is idle.",
                path.display()
            ),
            StoreError::BadLookup(field) => write!(f, "Messages can't be looked up by {field}"),
            StoreError::MessageGone => write!(f, "That message is no longer in this Project."),
            StoreError::BadSendStatus => write!(f, "Choose an open Chat and message identity."),
            StoreError::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error.to_string())
    }
}
