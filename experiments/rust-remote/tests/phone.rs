mod phone_support;
mod support;
use milagre_remote::{phone::*, Error};
use phone_support::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn part(id: i64, chunk: &str, more: bool) -> Vec<u8> {
    serde_json::to_vec(&json!({"t":"req","id":id,"method":"POST","path":"/rpc","headers":{},"chunk":chunk,"more":more})).unwrap()
}
fn response(id: i64, chunk: &str, more: bool) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"t":"res","id":id,"status":200,"headers":{},"chunk":chunk,"more":more}),
    )
    .unwrap()
}
fn defaults() -> RequestAssembler {
    RequestAssembler::new(AssemblyLimits::default()).unwrap()
}
#[test]
fn actual_node_request_bytes_assembly_and_response_roundtrip() {
    for s in fixture()["requests"].as_array().unwrap() {
        let r = request(s);
        let parts = request_parts(&r).unwrap();
        let hashes: Vec<_> = parts.iter().map(|p| hex(&Sha256::digest(p))).collect();
        assert_eq!(json!(hashes), s["hashes"]);
        let mut a = defaults();
        let mut done = None;
        for p in &parts {
            done = a.receive(p, 0).unwrap();
        }
        assert_eq!(done, Some(r.clone()));
        assert_eq!(a.buffered_bytes(), 0);
        let mut d = Dispatcher::new(MAX_RESPONSE).unwrap();
        let id = d.begin(100).unwrap();
        let mut events = Vec::new();
        for p in response_parts(&Response {
            id,
            status: 200,
            headers: r.headers,
            body: r.body.clone(),
        })
        .unwrap()
        {
            let (out, result) = d.receive(&p, 0);
            result.unwrap();
            events.extend(out);
        }
        assert_eq!(events.len(), 1);
        match &events[0] {
            Event::Response(got) => assert_eq!(got.body, r.body),
            _ => panic!(),
        };
        assert_eq!(d.buffered_bytes(), 0);
    }
}
#[test]
fn actual_mobile_batch_dispatch_order_and_surrogate_pua_preservation() {
    assert_eq!(trace(), fixture()["eventsJson"].as_str().unwrap());
}
#[test]
fn interleaved_uploads_use_first_metadata_and_clear_on_completion() {
    let mut a = defaults();
    a.receive(&part(1, "YQ==", true), 0).unwrap();
    a.receive(&part(2, "eA==", true), 0).unwrap();
    let mut second: Value = serde_json::from_slice(&part(1, "Yg==", false)).unwrap();
    second["method"] = "GET".into();
    second["path"] = "/ignored".into();
    let got = a
        .receive(&serde_json::to_vec(&second).unwrap(), 1)
        .unwrap()
        .unwrap();
    assert_eq!(got.body, b"ab");
    assert_eq!(got.method, Method::POST);
    assert_eq!(got.path, "/rpc");
    assert_eq!(
        a.receive(&part(2, "eQ==", false), 1).unwrap().unwrap().body,
        b"xy"
    );
    assert_eq!(a.pending(), 0);
    assert_eq!(a.buffered_bytes(), 0);
}
#[test]
fn upload_cancel_deadline_disconnect_release_and_ignore_late_tail() {
    let mut a = RequestAssembler::new(AssemblyLimits {
        timeout_ms: 10,
        ..AssemblyLimits::default()
    })
    .unwrap();
    a.receive(&part(1, "YQ==", true), 0).unwrap();
    assert!(a.cancel(1).unwrap());
    assert_eq!(a.buffered_bytes(), 0);
    assert!(a.receive(&part(1, "Yg==", false), 1).unwrap().is_none());
    a.receive(&part(2, "YQ==", true), 5).unwrap();
    assert!(a.expire(14).unwrap().is_empty());
    assert_eq!(a.expire(15).unwrap(), vec![2]);
    assert_eq!(a.buffered_bytes(), 0);
    assert!(a.receive(&part(2, "Yg==", false), 16).unwrap().is_none());
    a.receive(&part(3, "YQ==", true), 20).unwrap();
    assert_eq!(a.disconnect(), vec![3]);
    assert_eq!(a.buffered_bytes(), 0);
    assert!(a.is_closed());
    assert!(a.receive(&part(4, "", false), 20).is_err());
}
#[test]
fn upload_enforces_estimated_padding_size_metadata_aggregate_and_count() {
    let mut a = RequestAssembler::new(AssemblyLimits {
        body_bytes: 2,
        ..AssemblyLimits::default()
    })
    .unwrap();
    // Node estimates three bytes for 'a' encoded as YQ==. Preserve this quirk.
    assert_eq!(a.receive(&part(1, "YQ==", false), 0), Err(Error::TooLarge));
    assert!(a.is_closed());
    let mut a = RequestAssembler::new(AssemblyLimits {
        pending: 1,
        ..AssemblyLimits::default()
    })
    .unwrap();
    a.receive(&part(1, "", true), 0).unwrap();
    assert_eq!(a.receive(&part(2, "", true), 0), Err(Error::TooLarge));
    assert_eq!(a.buffered_bytes(), 0);
    let mut a = RequestAssembler::new(AssemblyLimits {
        total_bytes: 4,
        ..AssemblyLimits::default()
    })
    .unwrap();
    assert_eq!(a.receive(&part(1, "YQ==", true), 0), Err(Error::TooLarge));
    assert_eq!(a.buffered_bytes(), 0);
    let mut a = defaults();
    for id in 1..=64 {
        a.receive(&part(id, "", true), 0).unwrap();
        a.cancel(id).unwrap();
    }
    a.receive(&part(65, "", true), 0).unwrap();
    assert_eq!(a.cancel(65), Err(Error::TooLarge));
    assert!(a.is_closed());
}
#[test]
fn strict_request_schema_and_oversize_do_not_leave_partial_state() {
    for mutation in [
        json!({"method":"DELETE"}),
        json!({"path":"//elsewhere"}),
        json!({"id":9007199254740992u64}),
        json!({"chunk":"Zh=="}),
        json!({"more":"yes"}),
        json!({"extra":1}),
    ] {
        let mut a = defaults();
        a.receive(&part(1, "YQ==", true), 0).unwrap();
        let mut bad: Value = serde_json::from_slice(&part(2, "", false)).unwrap();
        for (k, v) in mutation.as_object().unwrap() {
            bad[k] = v.clone();
        }
        assert!(a.receive(&serde_json::to_vec(&bad).unwrap(), 0).is_err());
        assert_eq!(a.buffered_bytes(), 0);
        assert!(a.is_closed());
    }
    let mut a = defaults();
    assert_eq!(
        a.receive(&vec![0; milagre_remote::channel::MAX_PLAIN_BYTES + 1], 0),
        Err(Error::TooLarge)
    );
    assert!(RequestAssembler::new(AssemblyLimits {
        pending: 81,
        ..AssemblyLimits::default()
    })
    .is_err());
}
#[test]
fn response_cancel_timeout_and_disconnect_have_no_wire_cancel_or_id_reuse() {
    let mut d = Dispatcher::new(1024).unwrap();
    let a = d.begin(10).unwrap();
    let b = d.begin(20).unwrap();
    let live = d.subscribe().unwrap();
    d.receive(&response(a, "YQ==", true), 0).1.unwrap();
    assert!(d.buffered_bytes() > 0);
    assert!(matches!(
        d.cancel(a),
        Some(Event::Failed {
            reason: Failure::Cancelled,
            ..
        })
    ));
    assert_eq!(d.buffered_bytes(), 0);
    assert!(d.receive(&response(a, "Yg==", false), 1).0.is_empty());
    assert!(d.cancel(a).is_none());
    assert!(d.expire(19).is_empty());
    assert!(
        matches!(d.expire(20).as_slice(),[Event::Failed{id,reason:Failure::Timeout}] if *id==b)
    );
    let new = d.begin(100).unwrap();
    assert!(new > live);
    let events = d.disconnect();
    assert_eq!(events.len(), 2);
    assert!(d.is_closed());
    assert_eq!(d.pending(), 0);
    assert_eq!(d.live_count(), 0);
    assert_eq!(d.buffered_bytes(), 0);
    assert!(d.begin(200).is_err());
    assert!(d.receive(&response(new, "", false), 0).1.is_err());
}
#[test]
fn malformed_response_isolated_from_next_batch_item_and_late_responses_ignored() {
    let mut d = Dispatcher::new(1024).unwrap();
    d.begin(100).unwrap();
    d.begin(100).unwrap();
    let batch = json!({"t":"batch","items":[{"t":"res","id":1,"status":200,"headers":{},"chunk":"!bad","more":false},{"t":"res","id":2,"status":200,"headers":{},"chunk":"YQ==","more":false}]});
    let (events, result) = d.receive(batch.to_string().as_bytes(), 0);
    result.unwrap();
    assert!(matches!(
        events.as_slice(),
        [
            Event::Failed {
                id: 1,
                reason: Failure::InvalidResponse
            },
            Event::Response(_)
        ]
    ));
    assert_eq!(d.buffered_bytes(), 0);
    assert!(!d.is_closed());
    assert!(d
        .receive(br#"{"t":"res","id":100,"nonsense":null}"#, 0)
        .0
        .is_empty());
}
#[test]
fn batches_reject_depth_item_and_size_floods_before_any_dispatch() {
    let mut nested = "{\"t\":\"ping\"}".to_string();
    for _ in 0..18 {
        nested = format!("{{\"t\":\"batch\",\"items\":[{nested}]}}");
    }
    for bytes in [
        nested.into_bytes(),
        json!({"t":"batch","items":vec![json!({"t":"ping"});MAX_BATCH_ITEMS]})
            .to_string()
            .into_bytes(),
        vec![b' '; milagre_remote::channel::MAX_PLAIN_BYTES + 1],
        br#"{"t":"batch","items":[{"t":"ping"},null]}"#.to_vec(),
    ] {
        let mut d = Dispatcher::new(1024).unwrap();
        let id = d.begin(100).unwrap();
        let (events, result) = d.receive(&bytes, 0);
        assert!(result.is_err());
        assert!(
            matches!(events.as_slice(),[Event::Failed{id:n,reason:Failure::Disconnected}] if *n==id)
        );
        assert!(d.is_closed());
        assert_eq!(d.buffered_bytes(), 0);
    }
}
#[test]
fn dispatcher_bounds_pending_live_and_aggregate_metadata() {
    let mut d = Dispatcher::new(4).unwrap();
    for _ in 0..MAX_PENDING {
        d.begin(100).unwrap();
    }
    assert!(d.begin(100).is_err());
    for _ in 0..MAX_LIVE {
        d.subscribe().unwrap();
    }
    assert!(d.subscribe().is_err());
    let (events, result) = d.receive(
        br#"{"t":"res","id":1,"status":200,"headers":{"etag":"long"},"chunk":"","more":false}"#,
        0,
    );
    result.unwrap();
    assert!(matches!(
        events.as_slice(),
        [Event::Failed {
            reason: Failure::Limit,
            ..
        }]
    ));
    assert_eq!(d.buffered_bytes(), 0);
}
#[test]
fn authenticated_raw_json_preserves_lone_surrogates_and_pua_without_marker_collision() {
    let (mut client, mut host) = support::pair();
    for text in [
        r#"{"value":"\ud800"}"#.to_string(),
        format!("{{\"value\":\"{}{}\"}}", '\u{10fffe}', '\u{f0000}'),
        r#"{"value":"\udbff\udffe\ud800"}"#.to_string(),
    ] {
        let sealed = client.seal_encoded(text.as_bytes()).unwrap();
        assert_eq!(host.open_encoded(&sealed).unwrap(), text.as_bytes());
        assert_eq!(host.open_encoded(&sealed), Err(Error::Order));
    }
    let raw = br#"{"t":"live","id":1,"data":"\ud800"}"#;
    let mut d = Dispatcher::new(1024).unwrap();
    d.subscribe().unwrap();
    let (events, result) = d.receive(raw, 0);
    result.unwrap();
    match &events[0] {
        Event::Live { data, .. } => {
            assert_eq!(data.as_json(), r#""\ud800""#);
            assert!(data.to_unicode().is_err());
        }
        _ => panic!(),
    };
}

#[test]
fn real_body_limits_and_full_response_release() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let chunk = STANDARD.encode(vec![7; CHUNK]);
    let mut a = defaults();
    for _ in 0..31 {
        a.receive(&part(1, &chunk, true), 0).unwrap();
    }
    assert_eq!(a.receive(&part(1, &chunk, false), 0), Err(Error::TooLarge));
    assert_eq!(a.buffered_bytes(), 0);
    let mut d = Dispatcher::new(MAX_RESPONSE).unwrap();
    let id = d.begin(100).unwrap();
    for _ in 0..255 {
        let (out, r) = d.receive(&response(id, &chunk, true), 0);
        r.unwrap();
        assert!(out.is_empty());
    }
    let (out, r) = d.receive(&response(id, &chunk, false), 0);
    r.unwrap();
    assert_eq!(d.buffered_bytes(), 0);
    match &out[0] {
        Event::Response(r) => {
            assert_eq!(r.body.len(), MAX_RESPONSE);
            assert!(r.body.iter().all(|b| *b == 7));
        }
        _ => panic!(),
    }
}
#[test]
fn encrypted_in_memory_carrier_preserves_dispatch_trace_and_disconnect_generation() {
    let (mut client, mut host) = support::pair();
    let mut d = Dispatcher::new(MAX_RESPONSE).unwrap();
    d.begin(100).unwrap();
    d.begin(100).unwrap();
    d.subscribe().unwrap();
    let mut events = Vec::new();
    for message in fixture()["messages"].as_array().unwrap() {
        let packet = host
            .seal_encoded(message.as_str().unwrap().as_bytes())
            .unwrap();
        let plain = client.open_encoded(&packet).unwrap();
        let (out, r) = d.receive(&plain, 0);
        r.unwrap();
        events.extend(out.into_iter().map(event));
        assert_eq!(client.open_encoded(&packet), Err(Error::Order));
    }
    assert_eq!(
        format!("[{}]", events.join(",")),
        fixture()["eventsJson"].as_str().unwrap()
    );
    d.disconnect();
    assert!(d.receive(br#"{"t":"ping"}"#, 0).1.is_err());
}
