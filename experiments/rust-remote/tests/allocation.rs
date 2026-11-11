//! Single-test binary: allocator instrumentation only, never linked into the library.
//! The production library retains forbid(unsafe_code).
mod support;
use base64::{engine::general_purpose::STANDARD, Engine};
use milagre_remote::{budget::*, peer::*, Error};
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
fn raw_validation_and_fragment_assembly_do_not_amplify_compact_json_into_values() {
    let g = GlobalBudget::new(64 * 1024 * 1024).unwrap();
    let c = g.connection(64 * 1024 * 1024).unwrap();
    let mut w = FrameWriter::with_budget(Direction::Rpc, c.clone());
    // This input would become millions of 32-byte Values in the former writer.
    let dense = format!("[{}0]", "0,".repeat(4_000_000));
    let (result, total, largest) = measure(|| w.write(&dense));
    assert!(matches!(result, Err(Error::TooLarge)));
    assert!(total < 16_384, "allocated {total}, largest {largest}");
    assert_eq!(c.used(), 0);
    // Under the token limit, the reader copies only raw bytes, never an element tree.
    let small = format!("{{\"t\":\"rpc\",\"frame\":[{}0]}}", "0,".repeat(20_000));
    let mut r = FrameReader::with_budget(Direction::Rpc, MAX_FRAME_BYTES, 100, c.clone()).unwrap();
    let (result, total, largest) = measure(|| r.read(small.as_bytes(), 0));
    let frame = result.unwrap().unwrap();
    assert!(
        total < small.len() + 16_384,
        "allocated {total}, largest {largest}"
    );
    assert!(largest <= small.len());
    drop(frame);
    assert_eq!(c.used(), 0);
    // Adversarial pieces bypass the writer, just as a peer could. Reassembly may hold
    // pieces plus one contiguous copy, but token rejection must not allocate a Value tree.
    let parts: Vec<_> = dense
        .as_bytes()
        .chunks(PIECE_BYTES)
        .enumerate()
        .map(|(i, p)| {
            format!(
                "{{\"t\":\"part\",\"id\":1,\"i\":{i},\"n\":{},\"data\":\"{}\"}}",
                dense.len().div_ceil(PIECE_BYTES),
                STANDARD.encode(p)
            )
            .into_bytes()
        })
        .collect();
    let (result, total, largest) = measure(|| {
        let mut result = Ok(None);
        for p in &parts {
            result = r.read(p, 0);
            if result.is_err() {
                break;
            }
        }
        result
    });
    assert_eq!(result, Err(Error::TooLarge));
    assert!(
        total < 2 * dense.len() + 65_536,
        "allocated {total}, largest {largest}"
    );
    assert!(largest <= dense.len());
    assert_eq!(c.used(), 0);
    assert!(!r.pending());
    // Channel's Value convenience path must reject dense plaintext before allocating Values.
    let (mut sender, mut receiver) = support::pair();
    let dense_channel = format!("[{}0]", "0,".repeat(200_000));
    let encrypted = sender.seal_encoded(dense_channel.as_bytes()).unwrap();
    let (result, total, _) = measure(|| receiver.open(&encrypted));
    assert_eq!(result, Err(Error::TooLarge));
    assert!(
        total < 2 * dense_channel.len() + 65_536,
        "allocated {total}"
    );
    // Authenticated rejected JSON still consumes the counter.
    assert_eq!(receiver.open(&encrypted), Err(Error::Order));
    assert_eq!(
        receiver
            .open(&sender.seal_encoded(b"null").unwrap())
            .unwrap(),
        serde_json::Value::Null
    );
    // Many fields in a bounded envelope are rejected without a map allocation.
    let many = format!(
        "{{\"t\":\"rpc\",\"frame\":null,{}}}",
        (0..20_000)
            .map(|i| format!("\"f{i}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let (result, total, _) = measure(|| r.read(many.as_bytes(), 0));
    assert!(result.is_err());
    assert!(total < 16_384, "allocated {total}");
    assert_eq!(g.used(), 0);
}
