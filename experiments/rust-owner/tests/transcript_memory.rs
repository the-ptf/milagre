//! Memory bounds of transcript jobs, measured with a counting allocator: a Chat too large to hand over is refused
//! before anything is copied, only the Chat's own session and messages are copied, the reserved jobs' inputs share
//! one byte budget, and rendering stops at its limit instead of holding the whole transcript. One test, run in order:
//! the allocator counts every thread of this binary.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use milagre_owner_store::handover::{render_transcript_bounded, Clock, Zone};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::transcripts::{
    TranscriptJobs, TranscriptSource, MAX_TRANSCRIPT_BUDGET_BYTES, MAX_TRANSCRIPT_INPUT_BYTES,
};
use milagre_owner_store::StoreError;
use serde_json::{json, Value};

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = CURRENT.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(now, Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT.fetch_sub(layout.size(), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size > layout.size() {
            let now = CURRENT.fetch_add(new_size - layout.size(), Ordering::SeqCst) + new_size
                - layout.size();
            PEAK.fetch_max(now, Ordering::SeqCst);
        } else {
            CURRENT.fetch_sub(layout.size() - new_size, Ordering::SeqCst);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const MIB: usize = 1 << 20;
const CLOCK: Clock = Clock {
    zone: Zone::Utc,
    now_ms: 0.0,
};

/// What `run` allocated at its peak above what was live before it.
fn peak_of<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let before = CURRENT.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    let out = run();
    (out, PEAK.load(Ordering::SeqCst) - before)
}

fn source(state: &Value, session: u64) -> TranscriptSource<'_> {
    TranscriptSource {
        state: state.into(),
        session,
        before: None,
        provider: Some("claude"),
        catch_up_after: None,
        clock: CLOCK,
    }
}

/// Sessions 1 to `sizes.len()`, each with one message of that many bytes.
fn state(sizes: &[usize]) -> Value {
    let sessions: serde_json::Map<String, Value> = (1..=sizes.len())
        .map(|id| {
            (
                id.to_string(),
                json!({ "title": format!("Chat {id}"), "worktree_id": 1 }),
            )
        })
        .collect();
    let messages: Vec<Value> = sizes
        .iter()
        .enumerate()
        .map(|(index, size)| {
            json!({ "id": index + 1, "session_id": index + 1, "role": "user", "body": "x".repeat(*size) })
        })
        .collect();
    json!({ "sessions": sessions, "worktrees": { "1": { "path": "/tmp/wt" } }, "messages": messages })
}

#[test]
fn transcript_jobs_stay_within_their_byte_bounds() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    let mut jobs = TranscriptJobs::new(&isolation).unwrap();

    // 1. A Chat over the input cap: refused before anything is copied.
    let huge = state(&[MAX_TRANSCRIPT_INPUT_BYTES + 8 * MIB]);
    let (refused, peak) = peak_of(|| jobs.job(&project, source(&huge, 1)).err());
    assert!(
        matches!(refused, Some(StoreError::Invalid(ref why)) if why.contains("too large")),
        "{refused:?}"
    );
    assert!(peak < MIB, "refusing a 40 MiB Chat allocated {peak} bytes");
    drop(huge);

    // 2. Only the Chat's own session and messages are copied: a 40 MiB neighbour costs nothing.
    let mixed = state(&[1_000, MAX_TRANSCRIPT_INPUT_BYTES + 8 * MIB]);
    let (job, peak) = peak_of(|| jobs.job(&project, source(&mixed, 1)).unwrap());
    assert!(
        peak < MIB,
        "copying a 1 KB Chat beside a 40 MiB one allocated {peak} bytes"
    );
    drop(job);
    drop(mixed);
    for outcome in jobs.take_outcomes() {
        jobs.finish(outcome.id());
    }
    assert_eq!(jobs.charged_bytes(), 0);

    // 3. One budget for every reserved job's input: the third 25 MiB Chat is refused without a copy, and fits once a
    //    reservation ends.
    let big = state(&[25 * MIB, 25 * MIB, 25 * MIB]);
    let first = jobs.job(&project, source(&big, 1)).unwrap();
    let second = jobs.job(&project, source(&big, 2)).unwrap();
    assert!(jobs.charged_bytes() <= MAX_TRANSCRIPT_BUDGET_BYTES);
    let (refused, peak) = peak_of(|| jobs.job(&project, source(&big, 3)).err());
    assert_eq!(
        refused.and_then(|error| error.code()),
        Some("TRANSCRIPTS_AT_CAPACITY")
    );
    assert!(peak < MIB, "refusing over budget allocated {peak} bytes");
    let first_id = first.id();
    drop(first);
    jobs.take_outcomes();
    jobs.finish(first_id);
    let third = jobs.job(&project, source(&big, 3)).unwrap();
    drop((second, third));
    drop(big);
    for outcome in jobs.take_outcomes() {
        jobs.finish(outcome.id());
    }

    // 4. Rendering stops at its limit: a 5 MiB transcript rendered with a 1 MiB limit never holds much more.
    let messages: Vec<Value> = (0..80)
        .map(|id| json!({ "id": id, "session_id": 1, "role": "user", "body": "y".repeat(64 * 1024) }))
        .collect();
    let long = json!({ "sessions": { "1": { "title": "T" } }, "messages": messages });
    let (rendered, peak) =
        peak_of(|| render_transcript_bounded(&long, &json!(1), None, &CLOCK, MIB).err());
    assert!(
        rendered.is_some(),
        "a 5 MiB transcript passed a 1 MiB limit"
    );
    assert!(
        peak < 3 * MIB,
        "rendering with a 1 MiB limit allocated {peak} bytes"
    );

    // 5. One message's body, a 25 MiB string, against a 1 MiB limit: refused before it is copied.
    let body = json!({ "sessions": { "1": { "title": "T" } }, "messages": [
        { "id": 1, "session_id": 1, "role": "assistant", "body": "z".repeat(25 * MIB) },
    ] });
    let (rendered, peak) =
        peak_of(|| render_transcript_bounded(&body, &json!(1), None, &CLOCK, MIB).err());
    assert!(rendered.is_some());
    assert!(
        peak < MIB,
        "a 25 MiB body against a 1 MiB limit allocated {peak} bytes"
    );
    drop(body);

    // 6. A body that isn't text: String([0, 0, ...]) of two million elements is written element by element, never
    //    collected, and stops at the limit.
    let zeros = json!({ "sessions": { "1": { "title": "T" } }, "messages": [
        { "id": 1, "session_id": 1, "role": "assistant", "body": vec![0; 2_000_000] },
    ] });
    let (rendered, peak) =
        peak_of(|| render_transcript_bounded(&zeros, &json!(1), None, &CLOCK, MIB).err());
    assert!(rendered.is_some());
    assert!(
        peak < 3 * MIB,
        "String(array) against a 1 MiB limit allocated {peak} bytes"
    );
    drop(zeros);

    // 7. A real job whose input fits (about 6 MiB) but whose transcript doesn't: three million steps, each written as
    //    "- undefined" (about 36 MiB). The job fails at the 32 MiB transcript cap, holding at most about that.
    let steps = json!({ "sessions": { "1": { "title": "T" } }, "messages": [
        { "id": 1, "session_id": 1, "role": "assistant", "body": "", "steps": vec![0; 3_000_000] },
    ] });
    let job = jobs.job(&project, source(&steps, 1)).unwrap();
    let id = job.id();
    drop(steps);
    let ((), peak) = peak_of(|| job.run());
    let outcomes = jobs.take_outcomes();
    assert!(
        matches!(&outcomes[..], [milagre_owner_store::transcripts::JobOutcome::Failed { error, leftover: None, .. }] if error.contains("larger than")),
        "the oversized transcript wasn't refused"
    );
    jobs.finish(id);
    assert!(
        peak < 40 * MIB,
        "a job refusing a 36 MiB transcript allocated {peak} bytes"
    );

    // 8. The owner's in-memory state as the source (what a staged restore uses): a 1 KB Chat beside a 40 MiB one is
    //    read in place and copied alone, without first turning the Project state into JSON.
    let project_state = milagre_owner_store::message_store::ProjectState::from_value(&state(&[
        1_000,
        MAX_TRANSCRIPT_INPUT_BYTES + 8 * MIB,
    ]));
    let in_place = TranscriptSource {
        state: (&project_state).into(),
        session: 1,
        before: None,
        provider: Some("claude"),
        catch_up_after: None,
        clock: CLOCK,
    };
    let (job, peak) = peak_of(|| jobs.job(&project, in_place).unwrap());
    assert!(peak < MIB, "a Project-state source copied {peak} bytes");
    let id = job.id();
    drop(job);
    jobs.take_outcomes();
    jobs.finish(id);
}
