use crate::meter;
use crate::owner::OwnedRun;
use crate::transport::{Outcome, Script, Segment, BLOCK, MAX_BODY};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn bytes(value: impl Into<Vec<u8>>) -> Segment {
    Segment::Bytes(value.into().into_boxed_slice())
}
fn script(parts: Vec<Segment>, fragment: usize) -> Script {
    Script {
        parts: parts.into(),
        fragment,
        stall_after: None,
        panic_after: None,
    }
}
fn fixed(length: usize) -> Script {
    script(
        vec![
            bytes(format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
            )),
            Segment::Repeat {
                byte: 3,
                len: length,
            },
        ],
        BLOCK,
    )
}
fn padded_head(length: usize, informational: bool) -> Vec<u8> {
    let prefix = if informational {
        "HTTP/1.1 103 Early Hints\r\nX-Pad: "
    } else {
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Pad: "
    };
    let mut head = prefix.as_bytes().to_vec();
    head.resize(length - 4, b'a');
    head.extend_from_slice(b"\r\n\r\n");
    head
}
fn headers(count: usize, duplicate: bool) -> Script {
    let mut head = b"HTTP/1.1 200 unusual reason phrase\r\n".to_vec();
    for index in 0..count {
        head.extend_from_slice(
            format!("x-{}: value\r\n", if duplicate { 0 } else { index }).as_bytes(),
        );
    }
    head.extend_from_slice(b"\r\n");
    script(vec![bytes(head)], BLOCK)
}
fn chunked(trailer_bytes: usize) -> Script {
    let mut trailer = b"x-pad: ".to_vec();
    trailer.resize(trailer_bytes - 4, b'a');
    trailer.extend_from_slice(b"\r\n\r\n");
    script(
        vec![
            bytes(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n".to_vec()),
            bytes(b"data\r\n0\r\n".to_vec()),
            bytes(trailer),
        ],
        BLOCK,
    )
}
fn check_case(
    name: &str,
    script: Script,
    upload: usize,
    expected: Outcome,
    length: Option<usize>,
    hash: Option<u64>,
) {
    meter::start();
    let mut owner = OwnedRun::spawn(script, upload, false, false);
    assert_eq!(owner.response.lock().unwrap().capacity(), MAX_BODY);
    let prepared = meter::snapshot();
    meter::executing();
    owner.control.start();
    let report = owner.join();
    let retained = meter::snapshot();
    let response = owner.response.lock().unwrap();
    let body_len = response.len;
    let body_hash = response.hash;
    drop(response);
    drop(owner);
    let final_usage = meter::stop();
    // Assertions and output happen after capture, including failures, so their
    // formatting does not contaminate the census or reenter its mutex.
    println!("{name}: {:?} body={body_len} prepared={} peak={} realloc_overlap={} live_after_join={} final={} total={} calls={} executing={} largest={} turns={} raw={} frame={} headers={} trailers={} infos={}",
        report.outcome, prepared.live, final_usage.peak, final_usage.realloc_overlap, retained.live,
        final_usage.live, final_usage.total, final_usage.calls, final_usage.executing_total, final_usage.largest,
        report.stats.turns, report.stats.raw_bytes, report.stats.max_frame, report.stats.headers, report.stats.trailers, report.stats.infos);
    assert_eq!(report.outcome, expected, "{name}");
    if let Some(length) = length {
        assert_eq!(body_len, length, "{name}");
    }
    if let Some(hash) = hash {
        assert_eq!(body_hash, hash, "{name}");
    }
    assert!(body_len <= MAX_BODY, "{name}");
    assert_eq!(
        final_usage.live, 0,
        "{name}: retained allocation after disposal"
    );
    assert_eq!(final_usage.lost, 0, "allocation census overflow");
    assert!(
        retained.live >= MAX_BODY,
        "response storage released before owner disposal"
    );
    assert!(report.stats.read_calls <= report.stats.turns);
    assert!(report.stats.raw_reads <= report.stats.turns);
    assert!(report.stats.incoming_frames <= report.stats.turns);
    assert!(report.stats.write_calls <= report.stats.turns);
    assert!(
        report.stats.max_read <= BLOCK
            && report.stats.max_raw_read <= BLOCK
            && report.stats.max_write <= BLOCK
            && report.stats.max_frame <= BLOCK
    );
    if expected == Outcome::Success {
        assert_eq!(report.status, 200);
        assert_eq!(report.stats.request_body_bytes, upload);
        assert_eq!(report.stats.request_body_hash, upload as u64 * 7);
    }
}
fn ownership_cases() {
    // Results can be ready and the worker can exit, while the owner still has
    // both backing holders and the original real join handle.
    let input = fixed(10);
    meter::start();
    let mut owner = OwnedRun::spawn(input, 17, false, true);
    let request = Arc::downgrade(&owner.request);
    let response = Arc::downgrade(&owner.response);
    let control = Arc::downgrade(&owner.control);
    let stale_waker = owner.control.waker();
    meter::executing();
    owner.control.start();
    owner.control.wait_report();
    owner.control.cancel(); // ready cancellation cannot dispose the retained owner
    assert!(!owner.finished());
    assert!(request.upgrade().is_some() && response.upgrade().is_some());
    let ready = meter::snapshot().live;
    owner.control.release_exit();
    let until = Instant::now() + Duration::from_secs(10);
    while !owner.finished() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(request.upgrade().is_some() && response.upgrade().is_some());
    let exited = meter::snapshot().live;
    assert_eq!(owner.join().outcome, Outcome::Success);
    let joined = meter::snapshot().live;
    drop(owner);
    // Weak handles retain Arc allocations, never the 64 MiB payload. The stale
    // waker retains only WakeState; join cleared its Thread registration.
    assert!(
        request.upgrade().is_none() && response.upgrade().is_none() && control.upgrade().is_none()
    );
    stale_waker.wake_by_ref();
    let stale = meter::snapshot().live;
    drop(stale_waker);
    drop(request);
    drop(response);
    drop(control);
    let usage = meter::stop();
    println!("ownership: ready={ready} exited_before_join={exited} joined={joined} stale_handles={stale} final={}", usage.live);
    assert!(ready >= MAX_BODY && exited >= MAX_BODY && joined >= MAX_BODY);
    assert!(stale < BLOCK);
    assert_eq!(usage.live, 0);
    assert_eq!(usage.lost, 0);

    for mode in 0..4 {
        let mut input = fixed(if mode == 3 { 4 * BLOCK } else { 1 });
        if mode >= 2 {
            input.stall_after = Some(0);
        }
        if mode == 3 {
            input.stall_after = Some(2 * BLOCK);
        }
        meter::start();
        let mut owner = OwnedRun::spawn(input, 0, mode == 1, false);
        meter::executing();
        if mode == 0 {
            owner.control.cancel();
        }
        owner.control.start();
        if mode == 1 {
            owner.control.wait_registered();
            owner.control.cancel();
            owner.control.release_registration();
        }
        if mode >= 2 {
            owner.control.wait_stalled();
            owner.control.wait_parking();
            owner.control.cancel();
        }
        let report = owner.join();
        let partial = owner.response.lock().unwrap().len;
        let wakes = owner.control.wake_counts();
        drop(owner);
        let usage = meter::stop();
        println!(
            "cancel-{mode}: {:?} final={} peak={}",
            report.outcome, usage.live, usage.peak
        );
        assert_eq!(report.outcome, Outcome::Cancelled);
        if mode < 2 {
            assert_eq!(report.stats.written_bytes, 0);
        }
        if mode == 3 {
            assert!(partial > 0 && partial < 4 * BLOCK);
        }
        if mode >= 2 {
            assert!(wakes.0 >= 1 && wakes.1 >= 1);
        }
        assert_eq!(usage.live, 0);
        assert_eq!(usage.lost, 0);
    }

    let mut input = fixed(1);
    input.panic_after = Some(0);
    meter::start();
    let mut owner = OwnedRun::spawn(input, 100, false, false);
    let request = Arc::downgrade(&owner.request);
    let response = Arc::downgrade(&owner.response);
    meter::executing();
    owner.control.start();
    let report = owner.join();
    assert!(request.upgrade().is_some() && response.upgrade().is_some());
    drop(owner);
    drop(request);
    drop(response);
    let usage = meter::stop();
    println!("worker-unwind: {:?} final={}", report.outcome, usage.live);
    assert_eq!(report.outcome, Outcome::Panic);
    assert_eq!(usage.live, 0);
    assert_eq!(usage.lost, 0);

    for unwind in [false, true] {
        let mut input = fixed(1);
        input.stall_after = Some(0);
        meter::start();
        let outcome = std::panic::catch_unwind(|| {
            let owner = OwnedRun::spawn(input, 0, false, false);
            meter::executing();
            owner.control.start();
            owner.control.wait_stalled();
            if unwind {
                panic!("offline owner unwind");
            }
            drop(owner); // cancel + join in Drop, never detached
        });
        let panicked = outcome.is_err();
        drop(outcome);
        let usage = meter::stop();
        println!("owner-drop-unwind-{unwind}: final={}", usage.live);
        assert_eq!(panicked, unwind);
        assert_eq!(usage.live, 0);
        assert_eq!(usage.lost, 0);
    }
    let input = fixed(1);
    meter::start();
    let outcome = std::panic::catch_unwind(|| OwnedRun::spawn_then_unwind(input));
    let panicked = outcome.is_err();
    drop(outcome);
    let usage = meter::stop();
    println!("post-spawn-unwind: final={}", usage.live);
    assert!(panicked);
    assert_eq!(usage.live, 0);
    assert_eq!(usage.lost, 0);
}
pub fn run() {
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    // Initialize thread/panic infrastructure outside all measurements.
    let _ = std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| panic!("warmup"));
    })
    .join();
    println!("offline Hyper 1.12.0; requested allocator layouts, not RSS; response capacity={MAX_BODY}; stack requested={}", crate::transport::STACK);
    for size in [0, 1, BLOCK - 1, BLOCK, BLOCK + 1, 4 * BLOCK + 1, MAX_BODY] {
        check_case(
            &format!("fixed-{size}"),
            fixed(size),
            0,
            Outcome::Success,
            Some(size),
            Some(size as u64 * 3),
        );
    }
    check_case(
        "oversize",
        fixed(MAX_BODY + 1),
        0,
        Outcome::TooLarge,
        None,
        None,
    );
    check_case(
        "upload-8MiB",
        fixed(1),
        8 * 1024 * 1024,
        Outcome::Success,
        Some(1),
        Some(3),
    );
    // Generated wire body avoids a fixture-side 64 MiB input copy. This combines
    // maximum retained upload/response with the largest accepted raw trailer.
    let mut trailer = b"x-pad: ".to_vec();
    trailer.resize(BLOCK - 5, b'a');
    trailer.extend_from_slice(b"\r\n\r\n");
    let full = script(
        vec![
            bytes(format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{MAX_BODY:x}\r\n"
            )),
            Segment::Repeat {
                byte: 3,
                len: MAX_BODY,
            },
            bytes(b"\r\n0\r\n".to_vec()),
            bytes(trailer),
        ],
        BLOCK,
    );
    check_case(
        "full-upload-body-trailer",
        full,
        8 * 1024 * 1024,
        Outcome::Success,
        Some(MAX_BODY),
        Some(MAX_BODY as u64 * 3),
    );
    let mut fragmented = fixed(1024);
    fragmented.fragment = 1;
    check_case(
        "fragment-one",
        fragmented,
        17,
        Outcome::Success,
        Some(1024),
        Some(3072),
    );
    check_case(
        "headers-100",
        headers(100, false),
        0,
        Outcome::Success,
        Some(0),
        Some(0),
    );
    check_case(
        "headers-101",
        headers(101, false),
        0,
        Outcome::Invalid,
        Some(0),
        None,
    );
    check_case(
        "duplicates-100",
        headers(100, true),
        0,
        Outcome::Success,
        Some(0),
        None,
    );
    for size in [BLOCK, BLOCK + 1] {
        check_case(
            &format!("head-{size}"),
            script(vec![bytes(padded_head(size, false))], BLOCK),
            0,
            if size == BLOCK {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            Some(0),
            None,
        );
    }
    for size in [11, BLOCK - 1, BLOCK] {
        check_case(
            &format!("trailer-{size}"),
            chunked(size),
            0,
            if size < BLOCK {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            None,
            None,
        );
    }
    for count in [100, 101] {
        let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n".to_vec();
        for index in 0..count {
            wire.extend_from_slice(format!("x-{index}: a\r\n").as_bytes());
        }
        wire.extend_from_slice(b"\r\n");
        check_case(
            &format!("trailer-count-{count}"),
            script(vec![bytes(wire)], BLOCK),
            0,
            if count == 100 {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            Some(0),
            None,
        );
    }
    for count in [16_383, 16_384] {
        let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;".to_vec();
        wire.resize(wire.len() + count, b'a');
        wire.extend_from_slice(b"\r\nx\r\n0\r\n\r\n");
        check_case(
            &format!("chunk-extension-{count}"),
            script(vec![bytes(wire)], BLOCK),
            0,
            if count < 16_384 {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            None,
            None,
        );
    }
    check_case(
        "bad-chunk",
        script(
            vec![bytes(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ngarbage\r\n".to_vec(),
            )],
            BLOCK,
        ),
        0,
        Outcome::Invalid,
        Some(0),
        None,
    );
    check_case(
        "data-then-eof-error",
        script(
            vec![
                bytes(format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    BLOCK + 1
                )),
                Segment::Repeat {
                    byte: 3,
                    len: BLOCK,
                },
            ],
            BLOCK,
        ),
        0,
        Outcome::Invalid,
        Some(BLOCK),
        Some(BLOCK as u64 * 3),
    );
    for count in [8, 9] {
        let mut parts = Vec::new();
        for _ in 0..count {
            parts.push(bytes(b"HTTP/1.1 103 Early Hints\r\n\r\n".to_vec()));
        }
        parts.push(bytes(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
        ));
        check_case(
            &format!("info-{count}"),
            script(parts, BLOCK),
            0,
            if count == 8 {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            Some(0),
            None,
        );
    }
    for extra in [0, 1] {
        let mut parts = Vec::new();
        for index in 0..8 {
            parts.push(bytes(padded_head(
                8192 + if index == 7 { extra } else { 0 },
                true,
            )));
        }
        parts.push(bytes(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
        ));
        check_case(
            &format!("info-bytes-{}", BLOCK + extra),
            script(parts, BLOCK),
            0,
            if extra == 0 {
                Outcome::Success
            } else {
                Outcome::Invalid
            },
            Some(0),
            None,
        );
    }
    check_case(
        "upgrade",
        script(
            vec![bytes(b"HTTP/1.1 101 Switching Protocols\r\n\r\n".to_vec())],
            BLOCK,
        ),
        0,
        Outcome::Invalid,
        Some(0),
        None,
    );
    ownership_cases();
    std::panic::set_hook(hook);
}
