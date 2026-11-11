//! Codec-only reciprocity until an approved maintained Ed25519 dependency is available.
use milagre_remote::host_proof::{Challenge, UnverifiedProof};
fn main() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/host-proof.json")).unwrap();
    let output: Vec<_> = fixture["cases"].as_array().unwrap().iter().map(|c| {
        let challenge = Challenge::from_wire(c["challenge"].as_str().unwrap().as_bytes()).unwrap();
        let proof = UnverifiedProof::from_wire(c["proof"].as_str().unwrap().as_bytes(), c["hostId"].as_str().unwrap()).unwrap();
        serde_json::json!({"hostId":milagre_remote::host_proof::host_id(proof.public_key()), "challenge":String::from_utf8(challenge.to_wire()).unwrap(), "proof":String::from_utf8(proof.to_wire()).unwrap()})
    }).collect();
    println!("{}", serde_json::to_string(&output).unwrap());
}
