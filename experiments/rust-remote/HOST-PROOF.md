# Synthetic Ed25519 host proof

Rust now signs and verifies the existing Node host proof with pinned `ed25519-dalek = 3.0.0`. Public Cargo downloads and official documentation access were explicitly permitted; no live Milagre endpoint, profile, credential, identity file, phone, relay socket or daemon was accessed. Mobile source and its native fingerprint remain unchanged.

## Library and primary-source verification

The crate is the Dalek implementation in the maintained [dalek-cryptography/curve25519-dalek repository](https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek), not the archived standalone repository. Version 3.0.0 was resolved through Cargo and pinned exactly in Cargo.toml; Cargo.lock records its archive checksum and transitive versions. Its published MSRV is Rust 1.85.

Primary references checked on 2026-11-11:

- [Published signing source](https://docs.rs/ed25519-dalek/3.0.0/src/ed25519_dalek/signing.rs.html): `SigningKey::from_bytes` derives its public key from the seed; `Signer::try_sign` performs standard Ed25519 signing over the given message. No caller-supplied detached public key is used for signing.
- [VerifyingKey API](https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/struct.VerifyingKey.html#method.verify_strict): `verify_strict` applies scalar/point malleability checks, including weak-key rejection. This is intentionally stricter than accepting all TweetNaCl inputs.
- [Maintainer README](https://github.com/dalek-cryptography/curve25519-dalek/blob/main/ed25519-dalek/README.md): documents weak-key behavior, warns against legacy compatibility, and describes key zeroization. Only `zeroize` is enabled; default features are disabled. No `legacy_compatibility`, `hazmat`, batch verification, prehash or context mode is enabled.

The downloaded primary source was inspected locally too: `signing.rs` contains seed derivation, `Signer::try_sign`, and zeroizing Drop; `verifying.rs::verify_strict` contains the library's checks. `.cargo_vcs_info.json` identifies commit `07bef73ff85998a206cd2cea7f2605c801d0d1c9`, path `ed25519-dalek`. No custom curve arithmetic, signature equation, KDF or cryptographic validation algorithm was implemented. The NaCl channel dependencies remain unchanged; the lockfile retains curve25519-dalek 4.1.3 for crypto_box and adds 5.0.0 for the Ed25519 library.

## APIs and wire contract

`HostSigner::from_seed(&[u8;32])` owns a library signing key. It exposes only `public_key()`, `host_id()` and `proof(&Challenge)`. No Debug/Clone, private-key export, identity import, profile read or persistence is provided. The library wipes its owned signing key on drop; the caller still owns its original seed bytes.

`proof` signs exactly the 32 raw nonce bytes, then emits `{t:"proof",key,sig}` with unpadded base64url and Node's field order. It does not sign the challenge JSON, prehash the nonce, or add a context string. Host ID remains base64url(SHA-512(public key)[0..16]). Four synthetic Node seeds produce byte-identical public keys, host IDs and signatures in Rust.

`UnverifiedProof::from_wire` performs only structural checks and expected host-ID binding. `verify_signature(&Challenge)` performs library strict signature verification; it does not establish challenge freshness. Parsing alone still grants nothing.

`PendingProof::issue(expected_host_id, generation, now_ms, rng)` generates a fresh random 32-byte challenge using `CryptoRng`, with a checked 15-second deadline. `challenge_wire()` emits Node's challenge shape. `verify(self, bytes, current)` consumes it on success or failure. After signature verification it invokes `current()` once to read `(current_generation, monotonic_now_ms)`, refusing replacement, clock rollback, or exact/past expiry before returning private-field `VerifiedHost`. A compile-fail doctest prevents verifying the same pending object twice. Different pending challenges cannot accept the same signed response.

`VerifiedHost` exposes the public key, host ID and carrier generation. It proves signing-key possession for that challenge, not device pairing approval, a ready socket, host replacement authorization, or a running relay. The service must supply a truthful current-generation/monotonic clock callback, bound pending hosts and drop idle expired values. No timer, websocket, challenge persistence/hibernation restore, host replacement, reconnection or live session registry is wired.

## Compatibility limits and evidence

Synthetic fixtures come from the exact daemon proof statement and the actual relay `createRoom` implementation. Node supplies four signatures that Rust verifies. Rust independently signs those challenges; Node verifies the emitted bytes through its actual room code with in-memory fake sockets. Both directions are asserted, not inferred from codec roundtrip alone.

An explicit adversarial fixture records a weak identity-point public key/signature that TweetNaCl and Node's room accept but the Rust library's strict verifier rejects. This is a deliberate admission difference with maintained-library enforcement. No claim is made that all Node-accepted malformed/weak signatures are accepted. Honest keys generated by the Node implementation match the recorded vectors. Object schemas, canonical base64 and the 4096-byte bound remain stricter as described in HOST-POLICY.md.

Tests flip each of the 64 signature bytes for each positive vector; reject wrong nonces, all-255 scalar/signature bytes, wrong host IDs, malformed/oversized schemas, weak keys, replay against a fresh challenge, stale generation, clock rollback, deadline equality and timestamp overflow. The existing phone lossless-byte, policy, shared-budget and allocation tests still run.

Current total: **62 Rust tests and four compile-fail doctests**. Run the commands in HOST-POLICY.md, including `host-proof-node.mjs` against the `host_proof` example. All tests after dependency acquisition run with Cargo `--offline --locked`. Real-frame token census and actual phone/relay interoperability remain future service work.
