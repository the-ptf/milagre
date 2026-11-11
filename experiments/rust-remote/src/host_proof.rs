//! Exact host proof wire codec and host-ID derivation. Cryptographic signature
//! verification must precede host admission. UnverifiedProof cannot authorize a host.
use crate::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
pub const MAX_PROOF_BYTES: usize = 4096;
fn object(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_PROOF_BYTES {
        return Err(Error::TooLarge);
    }
    if bytes
        .iter()
        .find(|b| !matches!(b, b' ' | b'\r' | b'\n' | b'\t'))
        != Some(&b'{')
    {
        return Err(Error::Schema);
    }
    Ok(())
}
fn decode<const N: usize>(text: &str) -> Result<[u8; N]> {
    if text.len() != (N * 8).div_ceil(6) {
        return Err(Error::Schema);
    }
    let mut bytes = [0; N];
    if URL_SAFE_NO_PAD
        .decode_slice(text, &mut bytes)
        .map_err(|_| Error::Schema)?
        != N
    {
        return Err(Error::Schema);
    }
    Ok(bytes)
}
/// sha512(signPublicKey)[0..16], encoded as unpadded base64url, exactly Node hostIdOf.
pub fn host_id(public_key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(&Sha512::digest(public_key)[..16])
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeWire {
    t: String,
    nonce: String,
}
pub struct Challenge([u8; 32]);
impl Challenge {
    pub fn from_nonce(nonce: [u8; 32]) -> Self {
        Self(nonce)
    }
    pub fn from_wire(bytes: &[u8]) -> Result<Self> {
        object(bytes)?;
        let wire: ChallengeWire = serde_json::from_slice(bytes).map_err(|_| Error::Schema)?;
        if wire.t != "challenge" {
            return Err(Error::Schema);
        }
        Ok(Self(decode(&wire.nonce)?))
    }
    pub fn nonce(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn to_wire(&self) -> Vec<u8> {
        serde_json::to_vec(&ChallengeWire {
            t: "challenge".into(),
            nonce: URL_SAFE_NO_PAD.encode(self.0),
        })
        .unwrap()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProofWire {
    t: String,
    key: String,
    sig: String,
}
/// Only structural parsing and host-ID matching. Never treat this as authentication.
/// There is deliberately no `verified`, `authorize`, or `ready` conversion.
pub struct UnverifiedProof {
    key: [u8; 32],
    signature: [u8; 64],
}
impl UnverifiedProof {
    pub fn from_parts(key: [u8; 32], signature: [u8; 64]) -> Self {
        Self { key, signature }
    }
    pub fn from_wire(bytes: &[u8], expected_host_id: &str) -> Result<Self> {
        object(bytes)?;
        let wire: ProofWire = serde_json::from_slice(bytes).map_err(|_| Error::Schema)?;
        if wire.t != "proof" {
            return Err(Error::Schema);
        }
        let key = decode(&wire.key)?;
        if host_id(&key) != expected_host_id {
            return Err(Error::Authentication);
        }
        Ok(Self {
            key,
            signature: decode(&wire.sig)?,
        })
    }
    pub fn public_key(&self) -> &[u8; 32] {
        &self.key
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }
    pub fn to_wire(&self) -> Vec<u8> {
        serde_json::to_vec(&ProofWire {
            t: "proof".into(),
            key: URL_SAFE_NO_PAD.encode(self.key),
            sig: URL_SAFE_NO_PAD.encode(self.signature),
        })
        .unwrap()
    }
}
