mod support;
use milagre_remote::{channel::*, envelope::*, peer::*, Error};
use serde_json::{json, Value};
use support::*;

#[test]
fn node_crypto_bytes_in_both_directions() {
    let f = fixtures();
    for c in f["cases"].as_array().unwrap() {
        let (bytes, pending) = hello(c);
        assert_eq!(hex(&bytes), c["hello"]);
        let mut accepted = accept(c, &unhex(c["hello"].as_str().unwrap()));
        assert_eq!(hex(&accepted.reply), c["reply"]);
        assert_eq!(accepted.device.key, c["device"]["key"]);
        assert_eq!(accepted.device.first_pairing, c["device"]["first_pairing"]);
        assert_eq!(
            serde_json::to_value(accepted.device.kind).unwrap(),
            c["device"]["kind"]
        );
        assert_eq!(
            serde_json::to_value(&accepted.device.name).unwrap(),
            c["device"]["name"]
        );
        assert_eq!(
            serde_json::to_value(&accepted.device.caps).unwrap(),
            c["device"]["caps"]
        );
        let mut client = pending
            .finish(&unhex(c["reply"].as_str().unwrap()))
            .unwrap();
        for i in 0..3 {
            let phone_text = f["phoneTexts"][i].as_str().unwrap();
            let host_text = f["hostTexts"][i].as_str().unwrap();
            assert_eq!(
                hex(&client.seal_encoded(phone_text.as_bytes()).unwrap()),
                c["phoneFrames"][i]
            );
            assert_eq!(
                hex(&accepted.channel.seal_encoded(host_text.as_bytes()).unwrap()),
                c["hostFrames"][i]
            );
            assert_eq!(
                accepted
                    .channel
                    .open(&unhex(c["phoneFrames"][i].as_str().unwrap()))
                    .unwrap(),
                serde_json::from_str::<Value>(phone_text).unwrap()
            );
            assert_eq!(
                client
                    .open(&unhex(c["hostFrames"][i].as_str().unwrap()))
                    .unwrap(),
                serde_json::from_str::<Value>(host_text).unwrap()
            );
        }
    }
}
#[test]
fn node_envelope_bytes_including_full_u64_connection() {
    for e in fixtures()["envelopes"].as_array().unwrap() {
        let bytes = unhex(e["encoded"].as_str().unwrap());
        let decoded = Envelope::decode(&bytes).unwrap();
        assert_eq!(decoded.connection.to_string(), e["conn"]);
        assert_eq!(decoded.kind as u8, e["type"].as_u64().unwrap() as u8);
        assert_eq!(hex(decoded.payload), e["payload"]);
        assert_eq!(decoded.encode().unwrap(), bytes);
    }
}
#[test]
fn node_fragmentation_exact_boundaries_and_reassembly() {
    for c in fixtures()["peerCases"].as_array().unwrap() {
        let direction = if c["kind"] == "rpc" {
            Direction::Rpc
        } else {
            Direction::Evt
        };
        let json = format!(
            "\"{}\"",
            "x".repeat(c["size"].as_u64().unwrap() as usize - 2)
        );
        let parts = FrameWriter::new(direction).write(&json).unwrap();
        assert_eq!(
            serde_json::to_value(parts.iter().map(|p| hash(p)).collect::<Vec<_>>()).unwrap(),
            c["hashes"]
        );
        assert!(parts.iter().all(|p| p.len() <= MAX_PLAIN_BYTES));
        assert!(parts.iter().map(Vec::len).sum::<usize>() < PEER_BUDGET);
        let mut reader = FrameReader::new(direction);
        for (i, part) in parts.iter().enumerate() {
            let value = reader.read_value(part).unwrap();
            if i + 1 == parts.len() {
                assert_eq!(value, Some(serde_json::from_str(&json).unwrap()));
            } else {
                assert!(value.is_none());
                assert!(reader.pending());
            }
            assert!(reader.buffered_bytes() <= MAX_FRAME_BYTES);
        }
        assert!(!reader.pending());
    }
}
#[test]
fn corrupt_replay_order_and_reflection_are_rejected_without_advancing() {
    let (mut phone, mut host) = pair();
    let one = phone.seal_encoded(b"{\"t\":\"ping\"}").unwrap();
    let two = phone.seal_encoded(b"{\"t\":\"ping\"}").unwrap();
    assert_eq!(host.open(&two), Err(Error::Order));
    for i in 9..one.len() {
        let mut bad = one.clone();
        bad[i] ^= 1;
        assert_eq!(host.open(&bad), Err(Error::Authentication));
    }
    assert_eq!(phone.open(&one), Err(Error::Authentication));
    assert_eq!(host.open(&one).unwrap(), json!({"t":"ping"}));
    assert_eq!(host.open(&one), Err(Error::Order));
    assert!(host.open(&two).is_ok());
    let mut zero = two;
    zero[1..9].fill(0);
    assert_eq!(host.open(&zero), Err(Error::Order));
}
#[test]
fn invalid_json_consumes_authenticated_counter_like_node() {
    let (mut phone, mut host) = pair();
    let bad = phone.seal_encoded(b"no json").unwrap();
    assert_eq!(host.open(&bad), Err(Error::Schema));
    assert_eq!(host.open(&bad), Err(Error::Order));
    assert!(host.open(&phone.seal_encoded(b"null").unwrap()).is_ok());
}
#[test]
fn bounded_channel_inputs_and_truncation() {
    let (mut phone, mut host) = pair();
    for size in 0..25 {
        assert!(host.open(&vec![3; size]).is_err());
    }
    assert_eq!(host.open(&vec![3; MAX_PAYLOAD + 1]), Err(Error::TooLarge));
    assert_eq!(
        phone.seal_encoded(&vec![0; MAX_PLAIN_BYTES + 1]),
        Err(Error::TooLarge)
    );
    let text = format!("\"{}\"", "x".repeat(MAX_PLAIN_BYTES - 2));
    let good = phone.seal_encoded(text.as_bytes()).unwrap();
    assert_eq!(good.len(), MAX_PAYLOAD);
    assert!(host.open(&good).is_ok());
}
#[test]
fn handshake_auth_policy_binding_and_truncation() {
    let f = fixtures();
    let c = &f["cases"][0];
    let (bytes, _) = hello(c);
    let (host, _) = keys();
    let call = |hello: &[u8], token: &str, known: bool, pair: bool| {
        host_accept(&host, hello, token, |_| known, |_| pair, &mut Sequence(128))
    };
    for size in 0..105 {
        assert!(matches!(
            call(&bytes[..size], f["token"].as_str().unwrap(), false, true),
            Err(Error::BadHello)
        ));
    }
    assert!(matches!(
        call(&bytes, "wrong", false, true),
        Err(Error::BadToken)
    ));
    assert!(matches!(
        call(&bytes, f["token"].as_str().unwrap(), false, false),
        Err(Error::UnknownPhone)
    ));
    assert!(
        !call(&bytes, f["token"].as_str().unwrap(), true, false)
            .unwrap()
            .device()
            .first_pairing
    );
    for pos in [0, 1, 32, 33, 64, 65, 88, 89, bytes.len() - 1] {
        let mut b = bytes.clone();
        b[pos] ^= 1;
        assert!(matches!(
            call(&b, f["token"].as_str().unwrap(), false, true),
            Err(Error::BadHello)
        ));
    }
    assert!(matches!(
        call(&vec![1; MAX_HELLO_BYTES + 1], "x", false, true),
        Err(Error::TooLarge)
    ));
    let accepted = accept(c, &bytes);
    for size in 0..73 {
        assert!(matches!(
            hello(c).1.finish(&accepted.reply[..size]),
            Err(Error::BadHello)
        ));
    }
    for pos in [0, 1, 32, 33, 56, 57, accepted.reply.len() - 1] {
        let mut b = accepted.reply.clone();
        b[pos] ^= 1;
        assert!(hello(c).1.finish(&b).is_err());
    }
    let different = &f["cases"][1];
    assert!(hello(different).1.finish(&accepted.reply).is_err());
}
#[test]
fn envelope_schema_and_size_bounds() {
    for len in 0..9 {
        assert_eq!(Envelope::decode(&vec![0; len]), Err(Error::Envelope));
    }
    let mut bytes = vec![0; 9];
    bytes[8] = 1;
    for kind in [0, 8, 255] {
        bytes[0] = kind;
        assert_eq!(Envelope::decode(&bytes), Err(Error::Envelope));
    }
    bytes[0] = 4;
    assert_eq!(Envelope::decode(&bytes), Err(Error::Envelope));
    bytes[0] = 2;
    bytes[8] = 0;
    assert_eq!(Envelope::decode(&bytes), Err(Error::Envelope));
    assert_eq!(
        Envelope::decode(&vec![0; MAX_PAYLOAD + 10]),
        Err(Error::TooLarge)
    );
}
#[test]
fn fragments_reject_order_interruption_schema_and_release_memory() {
    let mut writer = FrameWriter::new(Direction::Rpc);
    let text = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
    let parts = writer.write(&text).unwrap();
    let mut reader = FrameReader::new(Direction::Rpc);
    assert_eq!(reader.read_value(&parts[1]), Err(Error::BadPart));
    let bads: Vec<Vec<u8>> = vec![
        parts[0].clone(),
        br#"{"t":"rpc","frame":{}}"#.to_vec(),
        br#"{"t":"evt","frame":{}}"#.to_vec(),
        br#"{"t":"part","id":2,"i":1,"n":2,"data":"eA=="}"#.to_vec(),
        br#"{"t":"part","id":1,"i":1,"n":3,"data":"eA=="}"#.to_vec(),
        br#"{"t":"part","id":1,"i":1,"n":2,"data":"!bad"}"#.to_vec(),
    ];
    for bad in bads {
        reader.read_value(&parts[0]).unwrap();
        assert!(reader.buffered_bytes() > 0);
        assert_eq!(reader.read_value(&bad), Err(Error::BadPart));
        assert!(!reader.pending());
        assert_eq!(reader.buffered_bytes(), 0);
    }
    for bad in [
        r#"{"t":"rpc"}"#,
        r#"{"t":"rpc","frame":{},"extra":0}"#,
        r#"{"t":"rpc","t":"evt","frame":{}}"#,
        r#"{"t":"part","id":0,"i":0,"n":2,"data":""}"#,
        r#"{"t":"part","id":9007199254740992,"i":0,"n":2,"data":""}"#,
        r#"{"t":"part","id":1.5,"i":0,"n":2,"data":""}"#,
        r#"{"t":"part","id":1,"i":-1,"n":2,"data":""}"#,
        r#"{"t":"part","id":1,"i":0,"n":1,"data":""}"#,
        r#"{"t":"part","id":1,"i":0,"n":2,"data":"Zh=="}"#,
    ] {
        assert!(reader.read_value(bad.as_bytes()).is_err(), "{bad}");
    }
    assert_eq!(
        reader.read_value(br#"{"t":"part","id":1,"i":0,"n":33,"data":""}"#),
        Err(Error::TooLarge)
    );
    assert_eq!(
        writer.write(&"x".repeat(MAX_FRAME_BYTES + 1)),
        Err(Error::TooLarge)
    );
    assert_eq!(writer.write("not-json"), Err(Error::Schema));
    assert!(reader.read_value(&parts[0]).unwrap().is_none());
    assert!(reader.read_value(&parts[1]).unwrap().is_some());
    let next = writer.write(&text).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&next[0]).unwrap()["id"], 2);
}
#[test]
fn multibyte_splits_mid_codepoint_and_custom_resource_limits() {
    let text = serde_json::to_string(&"🧪".repeat(200000)).unwrap();
    let parts = FrameWriter::new(Direction::Evt).write(&text).unwrap();
    let mut r = FrameReader::new(Direction::Evt);
    for p in &parts[..parts.len() - 1] {
        assert!(r.read_value(p).unwrap().is_none());
    }
    assert_eq!(
        r.read_value(parts.last().unwrap()).unwrap(),
        Some(serde_json::from_str(&text).unwrap())
    );
    let mut small = FrameReader::with_limit(Direction::Evt, PIECE_BYTES + 1).unwrap();
    assert!(small.read_value(&parts[0]).unwrap().is_none());
    assert_eq!(small.read_value(&parts[1]), Err(Error::TooLarge));
    assert_eq!(small.buffered_bytes(), 0);
    assert!(FrameReader::with_limit(Direction::Evt, MAX_FRAME_BYTES + 1).is_err());
    let mut tiny = FrameReader::with_limit(Direction::Rpc, 1).unwrap();
    assert_eq!(
        tiny.read_value(br#"{"t":"rpc","frame":{}}"#),
        Err(Error::TooLarge)
    );
}
#[test]
fn name_sanitization_matches_javascript_codepoints() {
    assert_eq!(
        hello_name("\u{feff} Lab\u{0}\u{202e}\u{2066} \u{feff}"),
        Some("Lab".into())
    );
    assert_eq!(hello_name(&"🧪".repeat(65)).unwrap().chars().count(), 64);
    assert_eq!(hello_name("\u{1}\u{85} "), None);
}

// Forge authenticated invalid metadata using only the fixture's synthetic keys.
// This reaches validation AFTER MAC verification rather than merely failing the MAC.
fn alter_hello(plain: &[u8]) -> Vec<u8> {
    use crypto_box::{aead::Aead, SalsaBox};
    let f = fixtures();
    let (mut message, _) = hello(&f["cases"][0]);
    let (host, phone) = keys();
    let cipher = SalsaBox::new(&host.public_key(), &phone);
    let boxed = cipher.encrypt((&message[65..89]).into(), plain).unwrap();
    message.truncate(89);
    message.extend_from_slice(&boxed);
    message
}
#[test]
fn authenticated_hello_fields_are_validated_strictly() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let f = fixtures();
    let (message, _) = hello(&f["cases"][0]);
    let inner = json!({"token": f["token"], "eph": URL_SAFE_NO_PAD.encode(&message[1..33])});
    for mutation in [
        json!({"eph":"wrong"}),
        json!({"kind":"computer"}),
        json!({"kind":null}),
    ] {
        let mut v = inner.clone();
        for (k, val) in mutation.as_object().unwrap() {
            v[k] = val.clone();
        }
        let bytes = alter_hello(&serde_json::to_vec(&v).unwrap());
        assert!(matches!(
            host_accept(
                &keys().0,
                &bytes,
                f["token"].as_str().unwrap(),
                |_| false,
                |_| true,
                &mut Sequence(128)
            ),
            Err(Error::BadHello)
        ));
    }
    for plain in [
        b"null".as_slice(),
        b"[]",
        b"broken",
        br#"{"token":"a","token":"b","eph":"x"}"#,
    ] {
        let bytes = alter_hello(plain);
        assert!(matches!(
            host_accept(
                &keys().0,
                &bytes,
                f["token"].as_str().unwrap(),
                |_| false,
                |_| true,
                &mut Sequence(128)
            ),
            Err(Error::BadHello)
        ));
    }
    let mut tolerated = inner;
    tolerated["name"] = json!(42);
    tolerated["caps"] = json!([true, "batch", "x".repeat(33), "🧪".repeat(16)]);
    tolerated["future-extension"] = json!("ignored");
    let accepted = accept(
        &f["cases"][0],
        &alter_hello(&serde_json::to_vec(&tolerated).unwrap()),
    );
    assert_eq!(accepted.device.name, None);
    assert_eq!(
        accepted.device.caps,
        vec!["batch".to_owned(), "🧪".repeat(16)]
    );
}
#[test]
fn reply_binds_both_ephemeral_keys_and_expected_host() {
    use crypto_box::{aead::Aead, SalsaBox};
    let f = fixtures();
    let c = &f["cases"][0];
    let (message, _) = hello(c);
    let (host, phone) = keys();
    let good = accept(c, &message);
    let cipher = SalsaBox::new(&phone.public_key(), &host);
    let plain = cipher
        .decrypt((&good.reply[33..57]).into(), &good.reply[57..])
        .unwrap();
    let original: Value = serde_json::from_slice(&plain).unwrap();
    for field in ["eph", "peer"] {
        let mut v = original.clone();
        v[field] = "wrong".into();
        let boxed = cipher
            .encrypt(
                (&good.reply[33..57]).into(),
                serde_json::to_vec(&v).unwrap().as_slice(),
            )
            .unwrap();
        let mut reply = good.reply[..57].to_vec();
        reply.extend_from_slice(&boxed);
        assert!(matches!(hello(c).1.finish(&reply), Err(Error::BadHello)));
    }
    let other = milagre_remote::SecretKey::from([99; 32]);
    assert!(matches!(
        host_accept(
            &other,
            &message,
            f["token"].as_str().unwrap(),
            |_| true,
            |_| false,
            &mut Sequence(128)
        ),
        Err(Error::BadHello)
    ));
}
#[test]
fn fresh_accept_of_replayed_hello_cannot_replay_old_channel_data() {
    let f = fixtures();
    let c = &f["cases"][0];
    let (message, pending) = hello(c);
    let first = accept(c, &message);
    let mut client = pending.finish(&first.reply).unwrap();
    let data = client.seal_encoded(b"null").unwrap();
    let mut second = authorize(
        host_accept(
            &keys().0,
            &message,
            f["token"].as_str().unwrap(),
            |_| true,
            |_| false,
            &mut Sequence(129),
        )
        .unwrap(),
    );
    assert_ne!(first.reply, second.reply);
    assert_eq!(second.channel.open(&data), Err(Error::Authentication));
}
#[test]
fn every_fragment_error_releases_partial_and_invalid_json_is_rejected() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut reader = FrameReader::new(Direction::Rpc);
    let part = |i, data: &str| {
        serde_json::to_vec(&json!({"t":"part","id":1,"i":i,"n":2,"data":data})).unwrap()
    };
    assert_eq!(
        reader.read_value(&part(0, &STANDARD.encode(b"not"))),
        Ok(None)
    );
    assert_eq!(
        reader.read_value(&part(1, &STANDARD.encode(b"json"))),
        Err(Error::Schema)
    );
    assert_eq!(reader.buffered_bytes(), 0);
    assert_eq!(
        reader.read_value(&part(0, &STANDARD.encode(vec![0; PIECE_BYTES + 1]))),
        Err(Error::BadPart)
    );
    let large = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
    let parts = FrameWriter::new(Direction::Rpc).write(&large).unwrap();
    reader.read_value(&parts[0]).unwrap();
    assert_eq!(
        reader.read_value(&vec![b'x'; MAX_PLAIN_BYTES + 1]),
        Err(Error::TooLarge)
    );
    assert!(!reader.pending());
    reader.read_value(&parts[0]).unwrap();
    reader.reset();
    assert_eq!(reader.buffered_bytes(), 0);
    let nested = format!("{}0{}", "[".repeat(200), "]".repeat(200));
    assert_eq!(
        FrameWriter::new(Direction::Rpc).write(&nested),
        Err(Error::TooLarge)
    );
}

#[test]
fn node_authenticated_invalid_hello_fixtures_preserve_error_codes_and_precedence() {
    let f = fixtures();
    for c in f["invalidHellos"].as_array().unwrap() {
        let result = host_accept(
            &keys().0,
            &unhex(c["hello"].as_str().unwrap()),
            f["token"].as_str().unwrap(),
            |_| false,
            |_| true,
            &mut Sequence(128),
        );
        match result {
            Err(e) => assert_eq!(
                e.to_string(),
                c["error"].as_str().unwrap(),
                "{}",
                c["label"]
            ),
            Ok(_) => panic!("accepted invalid hello: {}", c["label"]),
        }
    }
}

// Test-only Value decoding for legacy assertions. Production readers return leased raw bytes.
trait ReadValues {
    fn read_value(&mut self, bytes: &[u8]) -> milagre_remote::Result<Option<Value>>;
}
impl ReadValues for FrameReader {
    fn read_value(&mut self, bytes: &[u8]) -> milagre_remote::Result<Option<Value>> {
        self.read(bytes, 0)?
            .map(|frame| serde_json::from_slice(frame.as_bytes()).map_err(|_| Error::Schema))
            .transpose()
    }
}
