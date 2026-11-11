//! Single-test binary: allocator instrumentation only, never linked into the library.
//! The production library retains forbid(unsafe_code).
use milagre_remote::synthetic_store::{StoreFault, StoreLimits};
#[path = "../src/synthetic_store/snapshot.rs"]
mod snapshot;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
struct Count;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
fn record(n: usize) {
    if ACTIVE.load(Ordering::Relaxed) {
        TOTAL.fetch_add(n, Ordering::Relaxed);
        LARGEST.fetch_max(n, Ordering::Relaxed);
    }
}
// SAFETY: all allocator calls are forwarded unchanged to System; the counters never
// allocate, inspect pointers, or affect allocation/deallocation behavior.
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        record(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        record(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        record(n);
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static ALLOCATOR: Count = Count;
fn measure<T>(f: impl FnOnce() -> T) -> (T, usize, usize) {
    TOTAL.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    ACTIVE.store(true, Ordering::SeqCst);
    let result = f();
    ACTIVE.store(false, Ordering::SeqCst);
    (
        result,
        TOTAL.load(Ordering::Relaxed),
        LARGEST.load(Ordering::Relaxed),
    )
}
#[test]
fn snapshot_decode_has_bounded_serialized_and_parsed_allocations() {
    let limits = StoreLimits::default();
    let state = snapshot::Snapshot {
        profile: [1; 16],
        revision: 1,
        identity: 1,
        boot: 1,
        policy: 1,
        retired: false,
        running: false,
        secret: [2; 32],
        token: [3; 32],
        devices: (0..4096u16)
            .map(|i| {
                let mut key = [0; 32];
                key[..2].copy_from_slice(&i.to_be_bytes());
                snapshot::Device {
                    key,
                    kind: snapshot::Kind::Phone,
                    epoch: 1,
                    removed: Some(1),
                }
            })
            .collect(),
    };
    let bytes = state.encode(limits).unwrap();
    let (decoded, total, largest) = measure(|| snapshot::Snapshot::decode(&bytes, limits));
    assert_eq!(decoded.unwrap().devices.len(), 4096);
    assert!(
        total < limits.parsed_bytes,
        "total={total} largest={largest}"
    );
    assert!(largest < limits.parsed_bytes);
    let dense = format!("{{\"devices\":[{}0]}}", "0,".repeat(500_000));
    let (result, total, _) = measure(|| snapshot::Snapshot::decode(dense.as_bytes(), limits));
    assert!(result.is_err());
    assert!(total < limits.parsed_bytes);
    let huge = format!(
        "{{\"SECRET_SENTINEL{}\":0}}",
        "x".repeat(limits.snapshot_bytes)
    );
    let (result, total, _) = measure(|| snapshot::Snapshot::decode(huge.as_bytes(), limits));
    assert!(matches!(result, Err(StoreFault::TooLarge)));
    assert_eq!(total, 0);
    let (result, total, _) = measure(|| {
        state.encode(StoreLimits {
            snapshot_bytes: 1024,
            ..limits
        })
    });
    assert!(matches!(result, Err(StoreFault::TooLarge)));
    assert!(total < 64 * 1024);
}
