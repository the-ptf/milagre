//! Synthetic Rust/Node signing and verification reciprocity. No live identity or network.
use milagre_remote::host_proof::{Challenge, HostSigner, UnverifiedProof};
fn main() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/host-proof.json")).unwrap();
    let output: Vec<_> = fixture["cases"].as_array().unwrap().iter().map(|c| {
        let challenge = Challenge::from_wire(c["challenge"].as_str().unwrap().as_bytes()).unwrap();
        let proof = UnverifiedProof::from_wire(c["proof"].as_str().unwrap().as_bytes(), c["hostId"].as_str().unwrap()).unwrap();
        proof.verify_signature(&challenge).unwrap();
        let seed: Vec<u8> = c["seed"].as_str().unwrap().as_bytes().as_chunks::<2>().0.iter()
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect();
        let signer = HostSigner::from_seed(&seed.try_into().unwrap());
        let signed = signer.proof(&challenge).unwrap();
        assert_eq!(signed, proof.to_wire());
        serde_json::json!({"hostId":milagre_remote::host_proof::host_id(proof.public_key()), "challenge":String::from_utf8(challenge.to_wire()).unwrap(), "proof":String::from_utf8(signed).unwrap()})
    }).collect();
    println!("{}", serde_json::to_string(&output).unwrap());
}
