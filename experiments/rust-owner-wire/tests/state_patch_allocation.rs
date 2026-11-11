//! Separate one-test process so the allocation counter cannot observe parallel tests.
use milagre_owner_wire::state_patch::{diff, Limits, PatchError};
use serde_json::Value;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Counting;
static ENABLED: AtomicBool = AtomicBool::new(false);
static BYTES: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if ENABLED.load(Ordering::Relaxed) {
            BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if ENABLED.load(Ordering::Relaxed) {
            BYTES.fetch_add(size, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, size)
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[test]
fn rejected_replacement_never_copies_the_payload() {
    let next = Value::String("x".repeat(2 * 1024 * 1024));
    ENABLED.store(true, Ordering::Relaxed);
    let result = diff(
        &Value::Null,
        &next,
        Limits {
            depth: 0,
            output_bytes: 64,
            ..Limits::default()
        },
    );
    ENABLED.store(false, Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    assert_eq!(result, Err(PatchError::OutputLimit));
    assert!(bytes < 64 * 1024, "rejection allocated {bytes} bytes");
}
