//! Synthetic Node fixture runner. stdin JSON only; no network or local credentials.
use milagre_remote::{
    http_dispatch::{self, Outcome},
    phone::{Headers, Request},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
fn bytes(v: &Value) -> Vec<u8> {
    if let Some(s) = v["hex"].as_str() {
        let (pairs, remainder) = s.as_bytes().as_chunks::<2>();
        assert!(remainder.is_empty());
        pairs
            .iter()
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    } else {
        let size = v["size"].as_u64().unwrap() as usize;
        assert!(size <= 1024 * 1024);
        vec![v["byte"].as_u64().unwrap() as u8; size]
    }
}
fn hash(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn main() {
    let mut input = Vec::new();
    io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_end(&mut input)
        .unwrap();
    let cases: Vec<Value> = serde_json::from_slice(&input).unwrap();
    let observations: Vec<_> = cases.into_iter().map(|case| {
        let r = &case["request"];
        let request = Request { id: r["id"].as_i64().unwrap(), method: serde_json::from_value(r["method"].clone()).unwrap(), path: r["path"].as_str().unwrap().into(), headers: serde_json::from_value(r["headers"].clone()).unwrap(), body: bytes(&r["body"]) };
        let plan = http_dispatch::prepare(&request).unwrap();
        let o = &case["outcome"];
        let outcome = match o["kind"].as_str().unwrap() {
            "timeout" => Outcome::Timeout,
            "unavailable" => Outcome::Unavailable,
            "too-large" => Outcome::TooLarge,
            "response" => Outcome::Response { status: o["status"].as_u64().unwrap() as u16, headers: serde_json::from_value::<Headers>(o["headers"].clone()).unwrap(), body: bytes(&o["body"]) },
            _ => panic!("invalid fixture"),
        };
        let response = http_dispatch::response(request.id, outcome).unwrap();
        let frames = milagre_remote::phone::response_parts(&response).unwrap();
        json!({"plan": {"method": plan.method, "url": plan.url, "headers": plan.headers, "bodyBytes": plan.body.map(<[u8]>::len), "bodySha256": plan.body.map(hash), "timeoutMs": plan.timeout_ms}, "status": response.status, "headers": response.headers, "bodyBytes": response.body.len(), "bodySha256": hash(&response.body), "frames": frames.iter().map(|b| hash(b)).collect::<Vec<_>>()})
    }).collect();
    println!("{}", serde_json::to_string(&observations).unwrap());
}
