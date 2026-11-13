//! Bounded typed policy materialization, shared with allocator observation tests.
use super::snapshot::{Kind, Snapshot};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::collections::{BTreeMap, BTreeSet};
pub(crate) struct Hydrated<R> {
    pub records: BTreeMap<String, R>,
    pub epochs: BTreeMap<String, u64>,
    pub from_previous_boot: BTreeSet<String>,
}
/// Input has already passed the strict snapshot count/capacity bounds. The three
/// maps have at most one entry per decoded record; no network strings are copied.
pub(crate) fn hydrate<R>(
    s: &Snapshot,
    active: impl Fn(Kind) -> R,
    removed: impl Fn() -> R,
) -> Hydrated<R> {
    let mut records = BTreeMap::new();
    let mut epochs = BTreeMap::new();
    let mut from_previous_boot = BTreeSet::new();
    for d in &s.devices {
        let key = URL_SAFE_NO_PAD.encode(d.key);
        epochs.insert(key.clone(), d.epoch);
        let record = if d.removed.is_some() {
            from_previous_boot.insert(key.clone());
            removed()
        } else {
            active(d.kind)
        };
        records.insert(key, record);
    }
    Hydrated {
        records,
        epochs,
        from_previous_boot,
    }
}
