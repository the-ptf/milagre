//! Private fresh-copy fixture storage. No live-path admission or dispatch authority.
#[cfg(test)]
mod crash;
mod io;
mod owner;
#[cfg(test)]
mod tests;
mod writer;
use super::{Model, Stamp, Value};
pub use owner::Copy;
use std::{
    fs::File,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    sync::{Arc, Mutex},
};
pub use writer::Writer;

const MARKER: &str = "MILAGRE-ROUTINE-COPY";
const LOCK: &str = ".routine-writer.lock";
const FILE: &str = "routines.json";
const LIMIT: usize = super::limits::BYTES;
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub enum Error {
    Busy,
    Capacity,
    Ownership,
    Io,
    Uncertain,
    Closed,
    Model(super::Error),
}
impl From<super::Error> for Error {
    fn from(e: super::Error) -> Self {
        Self::Model(e)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("copied routine store is busy"),
            Self::Capacity => f.write_str("copied routine staging budget exhausted"),
            Self::Ownership => f.write_str("copied routine store identity changed"),
            Self::Io => f.write_str("copied routine store I/O failed"),
            Self::Uncertain => f.write_str("copied routine store outcome or cleanup is uncertain"),
            Self::Closed => f.write_str("copied routine writer is closed"),
            Self::Model(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
impl Error {
    pub fn into_model(self) -> super::Error {
        match self {
            Self::Model(e) => e,
            e => super::Error::Refused(e.to_string()),
        }
    }
}

// Closed fixture inputs can request refusal, never report successful durability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Point {
    Child,
    Marker,
    Lock,
    Seed,
    Stage,
    PartialWrite,
    FileSync,
    BeforeRename,
    Rename,
    DirectorySync,
    FinalVerify,
    Cleanup,
}
#[derive(Clone, Copy, Debug, Default)]
pub enum Fault {
    #[default]
    None,
    Io(Point),
    Panic(Point),
    IoAndCleanup(Point),
    #[cfg(test)]
    ChangeStageBytes,
    #[cfg(test)]
    Crash,
    #[cfg(test)]
    CrashIo(Point),
    #[cfg(test)]
    CrashIoAndCleanup(Point),
}
impl Fault {
    fn hit(self, point: Point) -> Result<()> {
        match self {
            #[cfg(test)]
            Self::CrashIo(at) if at == point => Err(Error::Io),
            #[cfg(test)]
            Self::CrashIoAndCleanup(at) if at == point || point == Point::Cleanup => Err(Error::Io),
            Self::Io(at) if at == point => Err(Error::Io),
            Self::IoAndCleanup(at) if at == point || point == Point::Cleanup => Err(Error::Io),
            Self::Panic(at) if at == point => {
                panic!("private copied-store injected panic at {point:?}")
            }
            _ => Ok(()),
        }
    }
}
fn caught<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).unwrap_or(Err(Error::Io))
}
