//! Trusted fixture-only check/commit boundary. Never install from renderer input.
use crate::accounts::{MetadataFuture, Selection};
use serde_json::Value;
#[derive(Clone, Debug)]
pub enum Target {
    Command { all_accounts: bool },
    Provider { selection: Selection, provider: String },
}
pub type Apply = Box<dyn FnOnce() -> Value + Send>;
/// `commit` must serialize validation and `apply` with authority mutations. On denial it must
/// drop `apply` without running it. Checks alone cannot authorize a later mutation or delivery.
pub trait Admission: Send + Sync {
    fn check(&self, target: Target) -> MetadataFuture<()>;
    fn commit(&self, target: Target, apply: Apply) -> MetadataFuture<Value>;
}
