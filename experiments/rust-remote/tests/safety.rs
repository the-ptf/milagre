mod support;
use milagre_remote::{budget::*, channel::*, peer::*, Error};
use serde_json::json;
use std::cell::RefCell;
use support::*;
fn pending(known: bool, kind: DeviceKind) -> Accepted {
    let f = fixtures();
    let c = &f["cases"][if kind == DeviceKind::Desktop { 2 } else { 0 }];
    let (bytes, _) = hello(c);
    host_accept(
        &keys().0,
        &bytes,
        f["token"].as_str().unwrap(),
        |_| known,
        |_| true,
        &mut Sequence(128),
    )
    .unwrap()
}
fn decision(a: &Accepted) -> ServiceDecision {
    let d = a.device();
    ServiceDecision::Allow {
        device_key: d.key.clone(),
        identity: IdentityStatus::Current,
        stored: if d.first_pairing {
            StoredDevice::New
        } else {
            StoredDevice::Known(d.kind)
        },
        owner: OwnerApproval::Granted,
        persistence: Persistence::Committed,
        desktop: DesktopAccess::Enabled,
    }
}
#[test]
fn authorization_consumes_and_checks_each_service_obligation() {
    for kind in [DeviceKind::Phone, DeviceKind::Desktop] {
        for known in [false, true] {
            let a = pending(known, kind);
            let d = decision(&a);
            assert!(a.authorize(d).is_ok());
        }
    }
    assert!(matches!(
        pending(false, DeviceKind::Phone).authorize(ServiceDecision::Deny),
        Err(Error::Unauthorized)
    ));
    for case in 0..8 {
        let a = pending(false, DeviceKind::Desktop);
        let mut d = decision(&a);
        if let ServiceDecision::Allow {
            device_key,
            identity,
            stored,
            owner,
            persistence,
            desktop,
        } = &mut d
        {
            match case {
                0 => *device_key = "another-device".into(),
                1 => *identity = IdentityStatus::Retired,
                2 => *stored = StoredDevice::Known(DeviceKind::Desktop),
                3 => *owner = OwnerApproval::NotRequired,
                4 => *owner = OwnerApproval::Denied,
                5 => *persistence = Persistence::NotRequired,
                6 => *persistence = Persistence::Failed,
                7 => *desktop = DesktopAccess::Disabled,
                _ => unreachable!(),
            }
        }
        assert!(
            matches!(a.authorize(d), Err(Error::Unauthorized)),
            "case {case}"
        );
    }
    for stored in [StoredDevice::New, StoredDevice::Known(DeviceKind::Desktop)] {
        let a = pending(true, DeviceKind::Phone);
        let mut d = decision(&a);
        if let ServiceDecision::Allow { stored: s, .. } = &mut d {
            *s = stored;
        }
        assert!(matches!(a.authorize(d), Err(Error::Unauthorized)));
    }
    let a = pending(false, DeviceKind::Phone);
    let mut d = decision(&a);
    if let ServiceDecision::Allow { owner, desktop, .. } = &mut d {
        *owner = OwnerApproval::NotRequired;
        *desktop = DesktopAccess::Disabled;
    }
    assert!(a.authorize(d).is_ok());
}
#[test]
fn node_callback_oracle_calls_pairability_even_for_known_devices() {
    let f = fixtures();
    let (bytes, _) = hello(&f["cases"][0]);
    for c in f["callbacks"].as_array().unwrap() {
        let calls = RefCell::new(Vec::new());
        let result = host_accept(
            &keys().0,
            &bytes,
            f["token"].as_str().unwrap(),
            |key| {
                calls.borrow_mut().push(json!(["known", key]));
                c["known"].as_bool().unwrap()
            },
            |key| {
                calls.borrow_mut().push(json!(["pair", key]));
                c["pairable"].as_bool().unwrap()
            },
            &mut Sequence(128),
        );
        assert_eq!(json!(calls.into_inner()), c["calls"]);
        match result {
            Ok(a) => {
                assert!(c["error"].is_null());
                assert_eq!(json!(a.device().first_pairing), c["firstPairing"]);
            }
            Err(e) => assert_eq!(e.to_string(), c["error"]),
        }
    }
}
#[test]
fn populated_array_handshakes_rejected_before_callbacks() {
    let f = fixtures();
    let c = f["invalidHellos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["label"] == "populated-positional-array")
        .unwrap();
    assert!(matches!(
        host_accept(
            &keys().0,
            &unhex(c["hello"].as_str().unwrap()),
            f["token"].as_str().unwrap(),
            |_| panic!("must not query known"),
            |_| panic!("must not query pairing"),
            &mut Sequence(128)
        ),
        Err(Error::BadHello)
    ));
    for c in f["invalidAccepts"].as_array().unwrap() {
        assert!(matches!(
            hello(&f["cases"][0])
                .1
                .finish(&unhex(c["reply"].as_str().unwrap())),
            Err(Error::BadHello)
        ));
    }
}
#[test]
fn raw_frame_lossless_surrogates_pua_and_null() {
    for text in [
        r#"null"#.to_string(),
        r#"{"x":"\ud800"}"#.to_string(),
        format!("{{\"x\":\"{}{}\"}}", '\u{10fffe}', '\u{f0000}'),
        format!("{{\"x\":\"{}\\udfff\"}}", "a".repeat(PART_THRESHOLD)),
    ] {
        let frames = FrameWriter::new(Direction::Rpc).write(&text).unwrap();
        let mut reader = FrameReader::new(Direction::Rpc);
        let mut result = None;
        for frame in frames.iter() {
            result = reader.read(frame, 0).unwrap();
        }
        assert_eq!(result.unwrap().as_bytes(), text.as_bytes());
    }
}
fn part(i: usize, n: usize, bytes: &[u8]) -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    serde_json::to_vec(&json!({"t":"part","id":1,"i":i,"n":n,"data":STANDARD.encode(bytes)}))
        .unwrap()
}
#[test]
fn incomplete_deadline_is_absolute_and_releases_budget_without_input() {
    let g = GlobalBudget::new(4 * 1024 * 1024).unwrap();
    let c = g.connection(2 * 1024 * 1024).unwrap();
    let mut r = FrameReader::with_budget(Direction::Rpc, MAX_FRAME_BYTES, 10, c.clone()).unwrap();
    r.read(&part(0, 3, b"["), 5).unwrap();
    assert!(c.used() > 0);
    assert!(!r.expire(14));
    r.read(&part(1, 3, b"0"), 14).unwrap();
    assert!(r.expire(15));
    assert_eq!(c.used(), 0);
    assert_eq!(g.used(), 0);
    assert!(!r.pending());
    r.read(&part(0, 2, b"["), 20).unwrap();
    assert_eq!(r.read(&part(1, 2, b"]"), 30), Err(Error::Timeout));
    assert_eq!(g.used(), 0);
    assert_eq!(r.read(&part(0, 2, b"["), u64::MAX), Err(Error::Exhausted));
    assert_eq!(g.used(), 0);
}
#[test]
fn shared_connection_and_global_budgets_hold_across_completed_handoffs() {
    let g = GlobalBudget::new(1500).unwrap();
    let c = g.connection(1000).unwrap();
    let other = g.connection(1000).unwrap();
    let message = format!("{{\"t\":\"rpc\",\"frame\":\"{}\"}}", "x".repeat(600));
    let mut r = FrameReader::with_budget(Direction::Rpc, MAX_FRAME_BYTES, 10, c.clone()).unwrap();
    let mut r2 = FrameReader::with_budget(Direction::Rpc, MAX_FRAME_BYTES, 10, c.clone()).unwrap();
    let frame = r.read(message.as_bytes(), 0).unwrap().unwrap();
    let held = c.used();
    assert!(held >= 602);
    assert_eq!(r2.read(message.as_bytes(), 0), Err(Error::Budget));
    assert_eq!(c.used(), held);
    let global_lease = other.reserve(800).unwrap();
    assert!(other.reserve(101).is_err());
    assert_eq!(other.used(), 800);
    assert_eq!(g.used(), held + 800);
    drop(global_lease);
    drop(frame);
    assert_eq!(g.used(), 0);
    let held = r2.read(message.as_bytes(), 0).unwrap().unwrap();
    drop(r2);
    assert!(g.used() > 0);
    drop(held);
    assert_eq!(g.used(), 0);
}
#[test]
fn writer_budget_precedes_allocation_and_output_remains_charged() {
    let g = GlobalBudget::new(2 * 1024 * 1024).unwrap();
    let c = g.connection(2 * 1024 * 1024).unwrap();
    let mut w = FrameWriter::with_budget(Direction::Evt, c.clone());
    let large = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
    let output = w.write(&large).unwrap();
    assert!(c.used() > large.len());
    assert!(matches!(w.write(&large), Err(Error::Budget)));
    drop(output);
    assert_eq!(c.used(), 0);
    let next = w.write(&large).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&next[0]).unwrap()["id"],
        2
    );
    drop(next);
    assert_eq!(g.used(), 0);
}
#[test]
fn budget_failure_during_final_contiguous_copy_releases_all_pieces() {
    let g = GlobalBudget::new(1024 * 1024).unwrap();
    let c = g.connection(1024 * 1024).unwrap();
    let mut r = FrameReader::with_budget(Direction::Rpc, MAX_FRAME_BYTES, 100, c.clone()).unwrap();
    let bytes = vec![b' '; 400_000];
    r.read(&part(0, 2, &bytes), 0).unwrap();
    assert!(c.used() > 400_000);
    assert_eq!(r.read(&part(1, 2, &bytes), 1), Err(Error::Budget));
    assert_eq!(c.used(), 0);
    assert!(!r.pending());
    r.read(&part(0, 2, b"["), 2).unwrap();
    assert_eq!(r.read(&part(1, 2, b"invalid]"), 3), Err(Error::Schema));
    assert_eq!(c.used(), 0);
    r.read(&part(0, 2, b"["), 4).unwrap();
    drop(r);
    assert_eq!(g.used(), 0);
}
#[test]
fn concurrent_global_reservations_never_overcommit_or_leak() {
    let g = GlobalBudget::new(1000).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let g = g.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                let c = g.connection(1000).unwrap();
                let lease = c.reserve(600);
                b.wait();
                assert!(g.used() <= 1000);
                b.wait();
                lease.is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap() as usize)
            .sum::<usize>(),
        1
    );
    assert_eq!(g.used(), 0);
}

#[test]
fn payload_limits_roundtrip_without_counting_envelope_overhead() {
    // A JSON array has two bracket tokens, n primitive tokens and n-1 commas.
    let at_tokens = format!("[{}0]", "0,".repeat((MAX_TOKENS - 3) / 2));
    let at_depth = format!("{}0{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
    for text in [at_tokens, at_depth] {
        let output = FrameWriter::new(Direction::Rpc).write(&text).unwrap();
        assert_eq!(output.len(), 1);
        let raw = FrameReader::new(Direction::Rpc)
            .read(&output[0], 0)
            .unwrap()
            .unwrap();
        assert_eq!(raw.as_bytes(), text.as_bytes());
    }
    for text in [
        format!("[{}0]", "0,".repeat(MAX_TOKENS / 2)),
        format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        ),
    ] {
        assert!(matches!(
            FrameWriter::new(Direction::Rpc).write(&text),
            Err(Error::TooLarge)
        ));
        let encoded = format!("{{\"t\":\"rpc\",\"frame\":{text}}}");
        assert_eq!(
            FrameReader::new(Direction::Rpc).read(encoded.as_bytes(), 0),
            Err(Error::TooLarge)
        );
    }
}
