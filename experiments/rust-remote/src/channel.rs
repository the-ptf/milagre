//! Byte-compatible with packages/shared/src/relay-crypto.mjs.
//! CryptoBox implements NaCl box.before + secretbox internally; no custom KDF or cipher.
use crate::{envelope::MAX_PAYLOAD, Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use crypto_box::{aead::Aead, PublicKey, SalsaBox, SecretKey};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq;

/// Local input bound, not a negotiated protocol change.
pub const MAX_HELLO_BYTES: usize = 16 * 1024;
pub const MAX_PLAIN_BYTES: usize = MAX_PAYLOAD - 25;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    #[default]
    Phone,
    Desktop,
}

#[derive(Debug, Default)]
pub struct HelloOptions<'a> {
    pub name: Option<&'a str>,
    pub kind: Option<DeviceKind>,
    pub caps: &'a [&'a str],
}
#[derive(Debug, PartialEq, Eq)]
pub struct Device {
    pub key: String,
    pub first_pairing: bool,
    pub kind: DeviceKind,
    pub name: Option<String>,
    pub caps: Vec<String>,
}
// Unknown hello fields are intentionally ignored: old Macs ignore name/kind/caps.
#[derive(Deserialize)]
struct HelloInner {
    #[serde(default)]
    token: Value,
    #[serde(default)]
    eph: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    caps: Value,
    #[serde(default = "default_kind")]
    kind: Value,
}
fn default_kind() -> Value {
    Value::String("phone".into())
}
#[derive(Serialize, Deserialize)]
struct AcceptInner {
    eph: String,
    peer: String,
}
fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
fn seal_box(cipher: &SalsaBox, nonce: &[u8; 24], bytes: &[u8]) -> Result<Vec<u8>> {
    cipher
        .encrypt(nonce.into(), bytes)
        .map_err(|_| Error::Authentication)
}
fn open_box(cipher: &SalsaBox, nonce: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    cipher
        .decrypt(nonce.into(), bytes)
        .map_err(|_| Error::Authentication)
}
fn random_nonce(rng: &mut (impl RngCore + CryptoRng)) -> [u8; 24] {
    let mut n = [0; 24];
    rng.fill_bytes(&mut n);
    n
}
fn public(bytes: &[u8]) -> PublicKey {
    PublicKey::from(<[u8; 32]>::try_from(bytes).unwrap())
}
// JS trim's WhiteSpace/LineTerminator set (Rust trim also removes U+0085, which JS does not).
fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn hello_name(value: &str) -> Option<String> {
    let safe: String = value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let short: String = safe.trim_matches(js_space).chars().take(64).collect();
    let name = short.trim_matches(js_space);
    (!name.is_empty()).then(|| name.to_owned())
}

/// Consumed by finish so an ephemeral handshake cannot reset channel counters twice.
/// Neither this object nor Channel exposes Clone or Debug (key material).
pub struct PendingHello {
    ephemeral: SecretKey,
    long_term: SalsaBox,
}
pub fn phone_hello(
    phone: &SecretKey,
    host: &PublicKey,
    token: &str,
    options: HelloOptions<'_>,
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<(Vec<u8>, PendingHello)> {
    // Bound before serializing untrusted caller strings.
    if token.len() > MAX_HELLO_BYTES
        || options.name.is_some_and(|n| n.len() > MAX_HELLO_BYTES)
        || options
            .caps
            .iter()
            .take(8)
            .any(|c| c.len() > MAX_HELLO_BYTES)
    {
        return Err(Error::TooLarge);
    }
    let ephemeral = SecretKey::generate(&mut *rng);
    let nonce = random_nonce(rng);
    let eph = ephemeral.public_key();
    let mut inner = serde_json::json!({ "token": token, "eph": b64(eph.as_bytes()) });
    if let Some(name) = options.name.filter(|n| !n.is_empty()) {
        inner["name"] = name.into();
    }
    if let Some(kind) = options.kind {
        inner["kind"] = serde_json::to_value(kind).map_err(|_| Error::Schema)?;
    }
    if !options.caps.is_empty() {
        inner["caps"] = serde_json::to_value(options.caps.iter().take(8).collect::<Vec<_>>())
            .map_err(|_| Error::Schema)?;
    }
    let plain = serde_json::to_vec(&inner).map_err(|_| Error::Schema)?;
    if plain.len() + 105 > MAX_HELLO_BYTES {
        return Err(Error::TooLarge);
    }
    let long_term = SalsaBox::new(host, phone);
    let boxed = seal_box(&long_term, &nonce, &plain)?;
    let mut message = vec![1];
    message.extend_from_slice(eph.as_bytes());
    message.extend_from_slice(phone.public_key().as_bytes());
    message.extend_from_slice(&nonce);
    message.extend_from_slice(&boxed);
    Ok((
        message,
        PendingHello {
            ephemeral,
            long_term,
        },
    ))
}
impl PendingHello {
    pub fn finish(self, reply: &[u8]) -> Result<Channel> {
        if reply.len() < 73 || reply.first() != Some(&2) {
            return Err(Error::BadHello);
        }
        if reply.len() > MAX_HELLO_BYTES {
            return Err(Error::TooLarge);
        }
        let peer = public(&reply[1..33]);
        let plain = open_box(&self.long_term, &reply[33..57], &reply[57..])?;
        let inner: AcceptInner = serde_json::from_slice(&plain).map_err(|_| Error::BadHello)?;
        if inner.eph != b64(peer.as_bytes())
            || inner.peer != b64(self.ephemeral.public_key().as_bytes())
        {
            return Err(Error::BadHello);
        }
        Ok(Channel::new(SalsaBox::new(&peer, &self.ephemeral), 1))
    }
}
/// Crypto and token validation only. The caller must enforce stored device kind,
/// desktop owner approval, identity retirement, and persistence BEFORE releasing reply/channel.
pub struct Accepted {
    pub reply: Vec<u8>,
    pub device: Device,
    pub channel: Channel,
}
pub fn host_accept(
    host: &SecretKey,
    hello: &[u8],
    token: &str,
    is_known: impl FnOnce(&str) -> bool,
    can_pair: impl FnOnce(&str) -> bool,
    rng: &mut (impl RngCore + CryptoRng),
) -> Result<Accepted> {
    if hello.len() < 105 || hello.first() != Some(&1) {
        return Err(Error::BadHello);
    }
    if hello.len() > MAX_HELLO_BYTES || token.len() > MAX_HELLO_BYTES {
        return Err(Error::TooLarge);
    }
    let eph = public(&hello[1..33]);
    let phone = public(&hello[33..65]);
    let long_term = SalsaBox::new(&phone, host);
    let plain = open_box(&long_term, &hello[65..89], &hello[89..]).map_err(|_| Error::BadHello)?;
    let inner: HelloInner = serde_json::from_slice(&plain).map_err(|_| Error::BadHello)?;
    if inner.eph != b64(eph.as_bytes()) {
        return Err(Error::BadHello);
    }
    let supplied_token = inner.token.as_str().ok_or(Error::BadToken)?;
    if !bool::from(supplied_token.as_bytes().ct_eq(token.as_bytes())) {
        return Err(Error::BadToken);
    }
    let kind = serde_json::from_value(inner.kind).map_err(|_| Error::BadHello)?;
    let key = b64(phone.as_bytes());
    let first_pairing = !is_known(&key);
    let pairable = can_pair(&key);
    if first_pairing && !pairable {
        return Err(Error::UnknownPhone);
    }
    let mine = SecretKey::generate(&mut *rng);
    let nonce = random_nonce(rng);
    let mine_public = mine.public_key();
    let plain = serde_json::to_vec(&AcceptInner {
        eph: b64(mine_public.as_bytes()),
        peer: b64(eph.as_bytes()),
    })
    .map_err(|_| Error::Schema)?;
    let boxed = seal_box(&long_term, &nonce, &plain)?;
    let mut reply = vec![2];
    reply.extend_from_slice(mine_public.as_bytes());
    reply.extend_from_slice(&nonce);
    reply.extend_from_slice(&boxed);
    let name = inner.name.as_str().and_then(hello_name);
    let caps = inner
        .caps
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|c| c.encode_utf16().count() <= 32)
        .take(8)
        .map(str::to_owned)
        .collect();
    Ok(Accepted {
        reply,
        device: Device {
            key,
            first_pairing,
            kind,
            name,
            caps,
        },
        channel: Channel::new(SalsaBox::new(&eph, &mine), 2),
    })
}

pub struct Channel {
    cipher: SalsaBox,
    direction: u8,
    sent: u64,
    seen: u64,
}
impl Channel {
    fn new(cipher: SalsaBox, direction: u8) -> Self {
        Self {
            cipher,
            direction,
            sent: 0,
            seen: 0,
        }
    }
    fn nonce(direction: u8, counter: u64) -> [u8; 24] {
        let mut n = [0; 24];
        n[0] = direction;
        n[16..].copy_from_slice(&counter.to_be_bytes());
        n
    }
    /// Accepts already serialized UTF-8 JSON, as Node sealEncoded does.
    pub fn seal_encoded(&mut self, plain: &[u8]) -> Result<Vec<u8>> {
        if plain.len() > MAX_PLAIN_BYTES {
            return Err(Error::TooLarge);
        }
        let next = self.sent.checked_add(1).ok_or(Error::Exhausted)?;
        let boxed = seal_box(&self.cipher, &Self::nonce(self.direction, next), plain)?;
        let mut frame = Vec::with_capacity(9 + boxed.len());
        frame.push(3);
        frame.extend_from_slice(&next.to_be_bytes());
        frame.extend_from_slice(&boxed);
        self.sent = next;
        Ok(frame)
    }
    /// Authenticate and advance the counter without interpreting JSON. Pass these bytes
    /// directly to the owner's lossless jsjson parser; never encode its internal PUA markers.
    pub fn open_encoded(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        if frame.len() < 25 || frame.first() != Some(&3) {
            return Err(Error::Envelope);
        }
        if frame.len() > MAX_PAYLOAD {
            return Err(Error::TooLarge);
        }
        let counter = u64::from_be_bytes(frame[1..9].try_into().unwrap());
        if counter != self.seen.checked_add(1).ok_or(Error::Exhausted)? {
            return Err(Error::Order);
        }
        let plain = open_box(
            &self.cipher,
            &Self::nonce(3 - self.direction, counter),
            &frame[9..],
        )?;
        // Match Node: authenticated malformed JSON consumes the receive counter.
        self.seen = counter;
        Ok(plain)
    }
    /// Convenience decoder for Unicode scalar JSON only. For lossless JS strings use open_encoded.
    pub fn open(&mut self, frame: &[u8]) -> Result<Value> {
        serde_json::from_slice(&self.open_encoded(frame)?).map_err(|_| Error::Schema)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_never_wrap_or_reuse_nonces() {
        let a = SecretKey::from([17; 32]);
        let b = SecretKey::from([29; 32]);
        let mut sender = Channel::new(SalsaBox::new(&b.public_key(), &a), 1);
        let mut receiver = Channel::new(SalsaBox::new(&a.public_key(), &b), 2);
        sender.sent = u64::MAX - 1;
        receiver.seen = u64::MAX - 1;
        let last = sender.seal_encoded(b"null").unwrap();
        assert_eq!(receiver.open(&last).unwrap(), Value::Null);
        assert_eq!(sender.seal_encoded(b"null"), Err(Error::Exhausted));
        assert_eq!(receiver.open(&last), Err(Error::Exhausted));
    }
}
