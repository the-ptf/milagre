use milagre_remote::{host_proof::*, Error};
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/host-proof.json")).unwrap()
}
#[test]
fn node_challenge_proof_shape_and_host_id_bytes_match() {
    for c in fixture()["cases"].as_array().unwrap() {
        let challenge = c["challenge"].as_str().unwrap().as_bytes();
        let proof = c["proof"].as_str().unwrap().as_bytes();
        let id = c["hostId"].as_str().unwrap();
        assert_eq!(
            Challenge::from_wire(challenge).unwrap().to_wire(),
            challenge
        );
        let p = UnverifiedProof::from_wire(proof, id).unwrap();
        assert_eq!(p.to_wire(), proof);
        assert_eq!(host_id(p.public_key()), id);
        assert!(matches!(
            UnverifiedProof::from_wire(proof, "wrong"),
            Err(Error::Authentication)
        ));
    }
}
#[test]
fn malformed_oversized_duplicate_array_and_noncanonical_fields_refused() {
    let c = &fixture()["cases"][0];
    let id = c["hostId"].as_str().unwrap();
    for bytes in [
        b"[]".to_vec(),
        b"null".to_vec(),
        vec![b' '; MAX_PROOF_BYTES + 1],
        b"{\"t\":\"challenge\",\"nonce\":\"\"}".to_vec(),
    ] {
        assert!(Challenge::from_wire(&bytes).is_err());
        assert!(UnverifiedProof::from_wire(&bytes, id).is_err());
    }
    let valid = c["proof"].as_str().unwrap();
    for bad in [
        valid.replacen("{", "{\"t\":\"proof\",", 1),
        valid.replacen("{", "{\"extra\":null,", 1),
        valid.replace("\"sig\":\"", "\"sig\":\"="),
        valid.replace("\"key\":\"", "\"key\":\"="),
    ] {
        assert!(UnverifiedProof::from_wire(bad.as_bytes(), id).is_err());
    }
}
#[test]
fn structural_decode_never_claims_to_verify_signature() {
    let c = &fixture()["cases"][0];
    let p = UnverifiedProof::from_wire(
        c["proof"].as_str().unwrap().as_bytes(),
        c["hostId"].as_str().unwrap(),
    )
    .unwrap();
    let changed = UnverifiedProof::from_parts(*p.public_key(), [0; 64]);
    let parsed =
        UnverifiedProof::from_wire(&changed.to_wire(), c["hostId"].as_str().unwrap()).unwrap();
    assert_eq!(parsed.signature(), &[0; 64]); // remains UNVERIFIED, never an admission result
}
fn unhex<const N: usize>(s: &str) -> [u8; N] {
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap()
}
#[test]
fn rust_signs_exact_node_bytes_and_verifies_actual_node_signatures() {
    for c in fixture()["cases"].as_array().unwrap() {
        let signer = HostSigner::from_seed(&unhex(c["seed"].as_str().unwrap()));
        assert_eq!(
            signer.public_key(),
            unhex::<32>(c["publicKey"].as_str().unwrap())
        );
        assert_eq!(signer.host_id(), c["hostId"].as_str().unwrap());
        let challenge = Challenge::from_wire(c["challenge"].as_str().unwrap().as_bytes()).unwrap();
        let node_bytes = c["proof"].as_str().unwrap().as_bytes();
        let proof = UnverifiedProof::from_wire(node_bytes, &signer.host_id()).unwrap();
        proof.verify_signature(&challenge).unwrap();
        assert_eq!(signer.proof(&challenge).unwrap(), node_bytes);
        for i in 0..64 {
            let mut signature = *proof.signature();
            signature[i] ^= 1;
            assert!(UnverifiedProof::from_parts(*proof.public_key(), signature)
                .verify_signature(&challenge)
                .is_err());
        }
        let mut other_nonce = *challenge.nonce();
        other_nonce[31] ^= 1;
        assert!(proof
            .verify_signature(&Challenge::from_nonce(other_nonce))
            .is_err());
        assert!(UnverifiedProof::from_parts(*proof.public_key(), [255; 64])
            .verify_signature(&challenge)
            .is_err());
    }
}
#[test]
fn strict_library_verifier_refuses_node_accepted_weak_key_proof() {
    let f = fixture();
    let c = &f["weakKeyCase"];
    assert_eq!(c["nodeAccepted"], true);
    let p = UnverifiedProof::from_wire(
        c["proof"].as_str().unwrap().as_bytes(),
        c["hostId"].as_str().unwrap(),
    )
    .unwrap();
    assert!(p
        .verify_signature(&Challenge::from_nonce(unhex(c["nonce"].as_str().unwrap())))
        .is_err());
}
#[test]
fn pending_proof_checks_final_generation_deadline_and_replayed_nonce() {
    use rand_core::OsRng;
    let signer = HostSigner::from_seed(&[19; 32]);
    let issue = || PendingProof::issue(&signer.host_id(), 5, 100, &mut OsRng).unwrap();
    let pending = issue();
    assert_eq!(pending.deadline_ms(), 100 + PROOF_LIFETIME_MS);
    let bytes = signer
        .proof(&Challenge::from_wire(&pending.challenge_wire()).unwrap())
        .unwrap();
    let verified = pending.verify(&bytes, || (5, 101)).unwrap();
    assert_eq!(verified.public_key(), &signer.public_key());
    assert_eq!(verified.host_id(), signer.host_id());
    assert_eq!(verified.generation(), 5);
    let next = issue();
    assert!(next
        .verify(&bytes, || panic!(
            "old nonce must fail before service guard"
        ))
        .is_err());
    for guard in [(4, 101), (5, 99), (5, 100 + PROOF_LIFETIME_MS)] {
        let p = issue();
        let bytes = signer
            .proof(&Challenge::from_wire(&p.challenge_wire()).unwrap())
            .unwrap();
        assert!(matches!(
            p.verify(&bytes, || guard),
            Err(Error::Unauthorized)
        ));
    }
    assert!(PendingProof::issue("not-a-host-id", 1, 0, &mut OsRng).is_err());
    assert!(matches!(
        PendingProof::issue(&signer.host_id(), 1, u64::MAX, &mut OsRng),
        Err(Error::Exhausted)
    ));
    let p = issue();
    assert!(p
        .verify(&vec![b'x'; MAX_PROOF_BYTES + 1], || panic!(
            "must reject oversize before guard"
        ))
        .is_err());
}
