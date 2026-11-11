#![allow(dead_code)]
use milagre_remote::phone::*;
use serde_json::{json, Value};
pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/phone.json")).unwrap()
}
pub fn body(size: usize) -> Vec<u8> {
    (0..size).map(|i| (i % 251) as u8).collect()
}
pub fn request(s: &Value) -> Request {
    Request {
        id: s["id"].as_i64().unwrap(),
        method: Method::POST,
        path: s["path"].as_str().unwrap().into(),
        headers: serde_json::from_value(s["headers"].clone()).unwrap(),
        body: body(s["size"].as_u64().unwrap() as usize),
    }
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn event(e: Event) -> String {
    match e {
        Event::Response(r) => {
            json!({"t":"res","id":r.id,"status":r.status,"headers":r.headers,"body":hex(&r.body)})
                .to_string()
        }
        Event::Live { id, data } => {
            format!("{{\"t\":\"live\",\"id\":{id},\"data\":{}}}", data.as_json())
        }
        Event::LiveClosed { id } => json!({"t":"live-close","id":id}).to_string(),
        Event::SendPong => "{\"t\":\"pong\"}".into(),
        Event::Failed { id, reason } => {
            json!({"t":"failed","id":id,"reason":format!("{reason:?}")}).to_string()
        }
    }
}
pub fn trace() -> String {
    let mut d = Dispatcher::new(MAX_RESPONSE).unwrap();
    assert_eq!(d.begin(1000).unwrap(), 1);
    assert_eq!(d.begin(1000).unwrap(), 2);
    assert_eq!(d.subscribe().unwrap(), 3);
    let mut events = Vec::new();
    for msg in fixture()["messages"].as_array().unwrap() {
        let (out, result) = d.receive(msg.as_str().unwrap().as_bytes(), 0);
        result.unwrap();
        events.extend(out.into_iter().map(event));
    }
    assert_eq!(d.pending(), 0);
    assert_eq!(d.live_count(), 0);
    assert_eq!(d.buffered_bytes(), 0);
    format!("[{}]", events.join(","))
}
pub fn output() -> String {
    let f = fixture();
    let mut requests = Vec::new();
    let mut responses = Vec::new();
    for s in f["requests"].as_array().unwrap() {
        let r = request(s);
        let texts = |v: Vec<Vec<u8>>| {
            v.into_iter()
                .map(|b| String::from_utf8(b).unwrap())
                .collect::<Vec<_>>()
        };
        requests.push(texts(request_parts(&r).unwrap()));
        responses.push(texts(
            response_parts(&Response {
                id: r.id,
                status: 200,
                headers: r.headers,
                body: r.body,
            })
            .unwrap(),
        ));
    }
    format!(
        "{{\"events\":{},\"requests\":{},\"responses\":{}}}",
        trace(),
        serde_json::to_string(&requests).unwrap(),
        serde_json::to_string(&responses).unwrap()
    )
}
