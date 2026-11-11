//! Test-binary allocation lifetime census. Metadata is fixed static storage.
//! Requested layouts only; realloc overlap is conservative, never measured RSS.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const SLOTS: usize = 8192;
#[derive(Clone, Copy)]
struct Slot {
    address: usize,
    bytes: usize,
}
const EMPTY: Slot = Slot {
    address: 0,
    bytes: 0,
};
#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub total: usize,
    pub calls: usize,
    pub live: usize,
    pub peak: usize,
    pub realloc_overlap: usize,
    pub largest: usize,
    pub executing_total: usize,
    pub lost: usize,
}
struct Table {
    slots: [Slot; SLOTS],
    data: Snapshot,
}
static TABLE: Mutex<Table> = Mutex::new(Table {
    slots: [EMPTY; SLOTS],
    data: Snapshot {
        total: 0,
        calls: 0,
        live: 0,
        peak: 0,
        realloc_overlap: 0,
        largest: 0,
        executing_total: 0,
        lost: 0,
    },
});
static ACTIVE: AtomicBool = AtomicBool::new(false);
static EXECUTING: AtomicBool = AtomicBool::new(false);
struct Meter;
#[global_allocator]
static ALLOCATOR: Meter = Meter;

impl Table {
    fn index(address: usize) -> usize {
        (address >> 4).wrapping_mul(11400714819323198485usize) & (SLOTS - 1)
    }
    fn take(&mut self, address: usize) -> Option<usize> {
        let start = Self::index(address);
        for n in 0..SLOTS {
            let i = (start + n) & (SLOTS - 1);
            if self.slots[i].address == 0 {
                return None;
            }
            if self.slots[i].address == address {
                let bytes = self.slots[i].bytes;
                self.slots[i].address = 1; // tombstone, never an allocated address
                self.data.live -= bytes;
                return Some(bytes);
            }
        }
        None
    }
    fn insert(&mut self, address: usize, bytes: usize) {
        let start = Self::index(address);
        for n in 0..SLOTS {
            let i = (start + n) & (SLOTS - 1);
            if self.slots[i].address <= 1 {
                self.slots[i] = Slot { address, bytes };
                self.data.live += bytes;
                self.data.peak = self.data.peak.max(self.data.live);
                return;
            }
        }
        self.data.lost += 1;
    }
    fn allocation(&mut self, address: usize, bytes: usize) {
        self.data.calls += 1;
        self.data.total += bytes;
        self.data.largest = self.data.largest.max(bytes);
        if EXECUTING.load(Ordering::Relaxed) {
            self.data.executing_total += bytes;
        }
        self.insert(address, bytes);
    }
}
// SAFETY: calls forward the exact pointer/Layout to System. The fixed table only
// records addresses as integers; it never reads/writes user allocation contents.
// Its mutex and arithmetic allocate nothing. Deallocation attribution remains
// active after the capture flag clears and across worker/owner threads.
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // Darwin's std Mutex lazily allocates its pthread backing. Before the
        // first capture, allow that unmeasured initialization without recursion.
        // start() takes TABLE before enabling capture. Every captured System
        // operation is therefore serialized with its lifetime bookkeeping.
        if !ACTIVE.load(Ordering::Relaxed) {
            return unsafe { System.alloc(layout) };
        }
        let mut table = TABLE.lock().unwrap();
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() && ACTIVE.load(Ordering::Relaxed) {
            table.allocation(pointer as usize, layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !ACTIVE.load(Ordering::Relaxed) {
            return unsafe { System.alloc_zeroed(layout) };
        }
        let mut table = TABLE.lock().unwrap();
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() && ACTIVE.load(Ordering::Relaxed) {
            table.allocation(pointer as usize, layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        let mut table = TABLE.lock().unwrap();
        unsafe { System.dealloc(pointer, layout) };
        table.take(pointer as usize);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let mut table = TABLE.lock().unwrap();
        let next = unsafe { System.realloc(pointer, layout, size) };
        if !next.is_null() {
            let live_before = table.data.live;
            let tracked = table.take(pointer as usize).is_some();
            if tracked || ACTIVE.load(Ordering::Relaxed) {
                table.data.realloc_overlap = table.data.realloc_overlap.max(live_before + size);
                table.allocation(next as usize, size);
            }
        }
        next
    }
}
pub fn start() {
    assert!(!ACTIVE.swap(false, Ordering::SeqCst));
    let retained = TABLE.lock().unwrap().data.live;
    assert_eq!(retained, 0, "previous capture retains allocations");
    let mut table = TABLE.lock().unwrap();
    table.slots.fill(EMPTY);
    table.data = Snapshot::default();
    EXECUTING.store(false, Ordering::SeqCst);
    ACTIVE.store(true, Ordering::SeqCst);
}
pub fn executing() {
    EXECUTING.store(true, Ordering::SeqCst);
}
pub fn snapshot() -> Snapshot {
    TABLE.lock().unwrap().data
}
pub fn stop() -> Snapshot {
    ACTIVE.store(false, Ordering::SeqCst);
    EXECUTING.store(false, Ordering::SeqCst);
    snapshot()
}
