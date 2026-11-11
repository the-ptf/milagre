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
