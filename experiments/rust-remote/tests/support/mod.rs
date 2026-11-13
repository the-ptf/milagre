#![allow(dead_code)]
use milagre_remote::{channel::*, peer::*, SecretKey};
use rand_core::{CryptoRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
// Synthetic deterministic randomness ONLY in tests and this fixture example.
pub struct Sequence(pub u8);
impl CryptoRng for Sequence {}
impl RngCore for Sequence {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        for b in out {
            *b = self.0;
            self.0 = self.0.wrapping_add(1);
        }
    }
    fn try_fill_bytes(&mut self, out: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(out);
        Ok(())
    }
}
pub fn fixtures() -> Value {
    serde_json::from_str(include_str!("../fixtures/node.json")).unwrap()
}
pub fn unhex(s: &str) -> Vec<u8> {
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
        .collect()
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn keys() -> (SecretKey, SecretKey) {
    let f = fixtures();
    (
        SecretKey::from_slice(&unhex(f["hostSecret"].as_str().unwrap())).unwrap(),
        SecretKey::from_slice(&unhex(f["phoneSecret"].as_str().unwrap())).unwrap(),
    )
}
pub fn hello(c: &Value) -> (Vec<u8>, PendingHello) {
    let (host, phone) = keys();
    let caps = c["options"]["caps"]
        .as_array()
        .map(|v| v.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>())
        .unwrap_or_default();
    phone_hello(
        &phone,
        &host.public_key(),
        fixtures()["token"].as_str().unwrap(),
        HelloOptions {
            name: c["options"]["name"].as_str(),
            kind: c["options"]
                .get("kind")
                .map(|k| serde_json::from_value(k.clone()).unwrap()),
            caps: &caps,
        },
        &mut Sequence(c["clientSeed"].as_u64().unwrap() as u8),
    )
    .unwrap()
}
pub fn accept(c: &Value, hello: &[u8]) -> Authorized {
    authorize(
        host_accept(
            &keys().0,
            hello,
            fixtures()["token"].as_str().unwrap(),
            |_| false,
            |_| true,
            &mut Sequence(c["hostSeed"].as_u64().unwrap() as u8),
        )
        .unwrap(),
    )
}
pub fn authorize(a: Accepted) -> Authorized {
    let d = a.device();
    let decision = ServiceDecision::Allow {
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
    };
    a.authorize(decision, || true).unwrap()
}
pub fn pair() -> (Channel, Channel) {
    let f = fixtures();
    let c = &f["cases"][0];
    let (bytes, pending) = hello(c);
    let accepted = accept(c, &bytes);
    (pending.finish(&accepted.reply).unwrap(), accepted.channel)
}
pub fn output() -> Value {
    let f = fixtures();
    let cases: Vec<_> = f["cases"].as_array().unwrap().iter().map(|c| {
        let (bytes, pending) = hello(c); let mut accepted = accept(c, &bytes);
        let mut phone = pending.finish(&accepted.reply).unwrap();
        let phone_frames: Vec<_> = f["phoneTexts"].as_array().unwrap().iter().map(|t| hex(&phone.seal_encoded(t.as_str().unwrap().as_bytes()).unwrap())).collect();
        let host_frames: Vec<_> = f["hostTexts"].as_array().unwrap().iter().map(|t| hex(&accepted.channel.seal_encoded(t.as_str().unwrap().as_bytes()).unwrap())).collect();
        json!({"hello": hex(&bytes), "reply": hex(&accepted.reply), "phoneFrames": phone_frames, "hostFrames": host_frames})
    }).collect();
    let peer_hashes: Vec<_> = f["peerCases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let direction = if c["kind"] == "rpc" {
                Direction::Rpc
            } else {
                Direction::Evt
            };
            let json = format!(
                "\"{}\"",
                "x".repeat(c["size"].as_u64().unwrap() as usize - 2)
            );
            FrameWriter::new(direction)
                .write(&json)
                .unwrap()
                .iter()
                .map(|p| hash(p))
                .collect::<Vec<_>>()
        })
        .collect();
    let envelopes: Vec<_> = f["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let payload = unhex(e["payload"].as_str().unwrap());
            hex(&milagre_remote::envelope::Envelope {
                kind: milagre_remote::envelope::Kind::try_from(e["type"].as_u64().unwrap() as u8)
                    .unwrap(),
                connection: e["conn"].as_str().unwrap().parse().unwrap(),
                payload: &payload,
            }
            .encode()
            .unwrap())
        })
        .collect();
    let large = serde_json::to_string(&"🧪".repeat(200000)).unwrap();
    let parts = |d| {
        FrameWriter::new(d)
            .write(&large)
            .unwrap()
            .iter()
            .map(|p| String::from_utf8(p.clone()).unwrap())
            .collect::<Vec<_>>()
    };
    json!({"cases": cases, "envelopes": envelopes, "peerHashes": peer_hashes, "parts": { "rpc": parts(Direction::Rpc), "evt": parts(Direction::Evt) }})
}
