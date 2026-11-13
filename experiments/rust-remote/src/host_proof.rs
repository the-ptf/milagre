//! Exact host proof wire codec and host-ID derivation. Cryptographic signature
//! verification precedes a consuming challenge/generation admission check.
use crate::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::{CryptoRng, RngCore};
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
/// Use verify_signature for cryptographic testing only; PendingProof also checks freshness.
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

/// Ed25519 seed-based signer. No Debug, Clone, independent public-key input, key export,
/// profile loading or persistence. The selected library zeroizes its key on drop.
pub struct HostSigner(SigningKey);
impl HostSigner {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }
    pub fn public_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }
    pub fn host_id(&self) -> String {
        host_id(&self.public_key())
    }
    /// Sign exactly the raw 32-byte nonce, as Node does. No prehash or custom context.
    pub fn proof(&self, challenge: &Challenge) -> Result<Vec<u8>> {
        let signature = self
            .0
            .try_sign(challenge.nonce())
            .map_err(|_| Error::Authentication)?;
        Ok(UnverifiedProof::from_parts(self.public_key(), signature.to_bytes()).to_wire())
    }
}
impl UnverifiedProof {
    /// Crypto verification only. It does not prove this challenge is current, random,
    /// unexpired or unused. Admission must go through the consuming PendingProof.
    pub fn verify_signature(&self, challenge: &Challenge) -> Result<()> {
        let key = VerifyingKey::from_bytes(&self.key).map_err(|_| Error::Authentication)?;
        key.verify_strict(challenge.nonce(), &Signature::from_bytes(&self.signature))
            .map_err(|_| Error::Authentication)
    }
}
pub const PROOF_LIFETIME_MS: u64 = 15_000;
/// One pending carrier generation. No Clone or public field construction.
pub struct PendingProof {
    expected_host_id: String,
    challenge: Challenge,
    generation: u64,
    created: u64,
    deadline: u64,
}
/// Proof of signing-key possession for one fresh carrier challenge, not device-pairing
/// approval, a ready socket, or permission to replace an existing host.
pub struct VerifiedHost {
    public_key: [u8; 32],
    host_id: String,
    generation: u64,
}
impl VerifiedHost {
    pub fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }
    pub fn host_id(&self) -> &str {
        &self.host_id
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
}
impl PendingProof {
    pub fn issue(
        expected_host_id: &str,
        generation: u64,
        now_ms: u64,
        rng: &mut (impl RngCore + CryptoRng),
    ) -> Result<Self> {
        decode::<16>(expected_host_id)?;
        let deadline = now_ms
            .checked_add(PROOF_LIFETIME_MS)
            .ok_or(Error::Exhausted)?;
        let mut nonce = [0; 32];
        rng.fill_bytes(&mut nonce);
        Ok(Self {
            expected_host_id: expected_host_id.into(),
            challenge: Challenge::from_nonce(nonce),
            generation,
            created: now_ms,
            deadline,
        })
    }
    pub fn challenge_wire(&self) -> Vec<u8> {
        self.challenge.to_wire()
    }
    pub fn deadline_ms(&self) -> u64 {
        self.deadline
    }
    /// The callback reads (current carrier generation, monotonic time) LAST, after
    /// signature verification. Both success and failure consume the pending proof.
    /// The service must drop idle expired challenges and bound pending connections.
    /// ```compile_fail
    /// use milagre_remote::host_proof::PendingProof;
    /// fn twice(p: PendingProof, bytes: &[u8]) {
    ///     p.verify(bytes, || (1, 0)); p.verify(bytes, || (1, 0));
    /// }
    /// ```
    pub fn verify(
        self,
        bytes: &[u8],
        current: impl FnOnce() -> (u64, u64),
    ) -> Result<VerifiedHost> {
        let proof = UnverifiedProof::from_wire(bytes, &self.expected_host_id)?;
        proof.verify_signature(&self.challenge)?;
        let (generation, now) = current();
        if now < self.created || now >= self.deadline || generation != self.generation {
            return Err(Error::Unauthorized);
        }
        Ok(VerifiedHost {
            public_key: proof.key,
            host_id: self.expected_host_id,
            generation,
        })
    }
}
