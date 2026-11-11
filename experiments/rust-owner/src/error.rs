use std::fmt;
use std::path::{Path, PathBuf};

/// Errors from the repositories. `Display` repeats the daemon's message where Node has a fixed one, so a command
/// answered by Rust fails with the text a client already shows.
#[derive(Debug)]
pub enum StoreError {
    /// A file operation failed. `code` is Node's `error.code` (ENOENT, EACCES, …) when it maps to one; `dest` is the
    /// second path of a rename or link, which Node's message names too.
    Io {
        code: Option<&'static str>,
        syscall: &'static str,
        path: PathBuf,
        dest: Option<PathBuf>,
        message: String,
    },
    /// coordination.json points at chats.db, which is gone (project-store.cjs readProjectState).
    MissingChatsDb(PathBuf),
    /// coordination.json, a sidecar or a chats.db payload isn't JSON.
    Json {
        context: String,
        message: String,
    },
    Sqlite(String),
    /// A rollback journal or WAL next to chats.db while reading read-only: a writer was mid-transaction when this
    /// copy was taken. An immutable read would see half of it, and a recovery would write, so the read is refused.
    HotJournal(PathBuf),
    /// chat-db.cjs findRow: `Messages can't be looked up by ${field}`.
    BadLookup(String),
    /// runtime.cjs chat:message.
    MessageGone,
    /// chat-host.cjs sendStatus input check, via runtime.cjs chat:send-status.
    BadSendStatus,
    /// A value a command can't take (not from Node; Node would coerce or throw a TypeError).
    Invalid(String),
    /// project-content.cjs writeContent: a content-addressed file exists with other bytes.
    ContentMismatch(PathBuf),
    /// An owner lock already exists. Never taken over here, whatever its state (see ownership.rs).
    LockRefused {
        lock: PathBuf,
        state: &'static str,
        owner: Option<String>,
    },
    /// ownership.cjs release: the lock's owner record holds another token.
    OwnershipChanged(PathBuf),
    /// A write or content callback found this process no longer owns the Project (see OwnerGuard::verify). Nothing
    /// was written.
    OwnershipLost {
        lock: PathBuf,
        why: String,
    },
    /// A write outside an isolated copy, or an isolated copy that isn't safe to write (see isolation.rs).
    NotIsolated(String),
    /// An answer whose delivery to the agent is unknown, or a retry it blocks (`ANSWER_DELIVERY_UNKNOWN`).
    AnswerDeliveryUnknown(String),
    /// Every answer slot is taken (`ANSWERS_AT_CAPACITY`): nothing was shown or handed over.
    AnswersAtCapacity(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn node_code(error: &std::io::Error) -> Option<&'static str> {
    match error.kind() {
        std::io::ErrorKind::NotFound => Some("ENOENT"),
        std::io::ErrorKind::PermissionDenied => Some("EACCES"),
        std::io::ErrorKind::AlreadyExists => Some("EEXIST"),
        _ => match error.raw_os_error() {
            Some(libc::EISDIR) => Some("EISDIR"),
            Some(libc::ENOTDIR) => Some("ENOTDIR"),
            Some(libc::ELOOP) => Some("ELOOP"),
            Some(libc::ENOTEMPTY) => Some("ENOTEMPTY"),
            Some(libc::EPERM) => Some("EPERM"),
            Some(libc::EXDEV) => Some("EXDEV"),
            Some(libc::ENOSPC) => Some("ENOSPC"),
            _ => None,
        },
    }
}

impl StoreError {
    pub fn io(error: std::io::Error, syscall: &'static str, path: &Path) -> Self {
        StoreError::Io {
            code: node_code(&error),
            syscall,
            path: path.to_path_buf(),
            dest: None,
            message: error.to_string(),
        }
    }

    /// A two-path operation (rename, link), named like Node: `CODE: text, rename 'a' -> 'b'`.
    pub fn io2(error: std::io::Error, syscall: &'static str, path: &Path, dest: &Path) -> Self {
        StoreError::Io {
            code: node_code(&error),
            syscall,
            path: path.to_path_buf(),
            dest: Some(dest.to_path_buf()),
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
            StoreError::Io { code, syscall, path, dest, message } => {
                match code {
                    Some(code) => {
                        let text = match *code {
                            "ENOENT" => "no such file or directory",
                            "EACCES" => "permission denied",
                            "EEXIST" => "file already exists",
                            "EISDIR" => "illegal operation on a directory",
                            "ENOTDIR" => "not a directory",
                            "ELOOP" => "too many symbolic links encountered",
                            "ENOTEMPTY" => "directory not empty",
                            "EPERM" => "operation not permitted",
                            "EXDEV" => "cross-device link not permitted",
                            "ENOSPC" => "no space left on device",
                            other => other,
                        };
                        write!(f, "{code}: {text}, {syscall} '{}'", path.display())?;
                    }
                    None => write!(f, "{message}, {syscall} '{}'", path.display())?,
                }
                if let Some(dest) = dest {
                    write!(f, " -> '{}'", dest.display())?;
                }
                Ok(())
            }
            StoreError::MissingChatsDb(path) => write!(
                f,
                "This Project's messages are kept in {}, which is missing.",
                path.display()
            ),
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
            StoreError::ContentMismatch(_) => {
                write!(f, "Stored Project content does not match its reference")
            }
            StoreError::LockRefused { lock, state, owner } => {
                let record = lock.join("owner.json");
                match *state {
                    "stale" => write!(
                        f,
                        "Milagre state is owned by a process that has exited ({}). This owner never takes a lock over: verify the process in {} has exited, then remove {} yourself.",
                        owner.as_deref().unwrap_or("no record"),
                        record.display(),
                        lock.display()
                    ),
                    "abandoned" => write!(
                        f,
                        "Milagre state has an empty owner lock left by a crash. This owner never takes a lock over: remove {} yourself after checking no runtime is starting.",
                        lock.display()
                    ),
                    _ => write!(
                        f,
                        "Milagre state is already owned. Close its other runtime. If it crashed, verify the process in {} has exited before removing {}.",
                        record.display(),
                        lock.display()
                    ),
                }
            }
            StoreError::OwnershipChanged(lock) => {
                write!(f, "Milagre ownership changed: {}", lock.display())
            }
            StoreError::NotIsolated(message) => write!(f, "{message}"),
            StoreError::AnswerDeliveryUnknown(message) => write!(f, "{message}"),
            StoreError::AnswersAtCapacity(message) => write!(f, "{message}"),
            StoreError::OwnershipLost { lock, why } => write!(
                f,
                "This process no longer owns the Project ({why}: {}); nothing was written.",
                lock.display()
            ),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(_, Some(message)) => StoreError::Sqlite(message),
            other => StoreError::Sqlite(other.to_string()),
        }
    }
}
