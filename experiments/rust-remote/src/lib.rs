//! No sockets, live profiles, credentials, or production service ownership. Synthetic policy records use a new marked temporary directory only. See README for integration gates.
#![forbid(unsafe_code)]
pub mod admission;
pub mod budget;
pub mod channel;
pub mod envelope;
pub mod host_proof;
pub mod peer;
pub mod phone;
pub mod policy;
mod raw_json;
pub mod registry;
pub mod supervisor;
pub use crypto_box::{PublicKey, SecretKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("service authorization refused")]
    Unauthorized,
    #[error("incomplete frame expired")]
    Timeout,
    #[error("memory budget exhausted")]
    Budget,
    #[error("bad-hello")]
    BadHello,
    #[error("bad-token")]
    BadToken,
    #[error("unknown-phone")]
    UnknownPhone,
    #[error("invalid schema or JSON")]
    Schema,
    #[error("frame too large")]
    TooLarge,
    #[error("invalid envelope")]
    Envelope,
    #[error("bad part")]
    BadPart,
    #[error("out of order or replayed frame")]
    Order,
    #[error("authentication failed")]
    Authentication,
    #[error("counter exhausted")]
    Exhausted,
}
pub type Result<T> = std::result::Result<T, Error>;
/// JSON numeric identifiers must round-trip through JavaScript safely.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
