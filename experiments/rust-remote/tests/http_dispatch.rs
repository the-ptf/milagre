use milagre_remote::{
    http_dispatch::{self, MemoryHttp, Outcome},
    phone::{Headers, Method, Request},
    Error,
};
fn reply(headers: Headers, body: Vec<u8>) -> Outcome {
    Outcome::Response {
        status: 200,
        headers,
        body,
    }
}
#[test]
fn retained_header_allocations_and_invalid_http_shapes_are_bounded() {
    let headers = Headers::with_capacity(1000);
    assert!(matches!(
        MemoryHttp::new(reply(headers, vec![])),
        Err(Error::TooLarge)
    ));
    let mut headers = Headers::new();
    headers.insert("etag".into(), String::with_capacity(70_000));
    assert!(matches!(
        MemoryHttp::new(reply(headers, vec![])),
        Err(Error::TooLarge)
    ));
    for (name, value) in [
        ("", "x"),
        ("bad name", "x"),
        ("etag", "x\r\ny"),
        ("etag", "\0"),
        ("etag", "\u{100}"),
    ] {
        assert!(matches!(
            MemoryHttp::new(reply(Headers::from([(name.into(), value.into())]), vec![])),
            Err(Error::Schema)
        ));
    }
    assert!(matches!(
        MemoryHttp::new(Outcome::Response {
            status: 600,
            headers: Headers::new(),
            body: vec![]
        }),
        Err(Error::Schema)
    ));
}
#[test]
fn request_plan_preserves_body_and_enforces_route_and_metadata_limits() {
    let mut r = Request {
        id: 1,
        method: Method::POST,
        path: "/rpc".into(),
        headers: Headers::new(),
        body: b"{\"lone\":\"\\ud800\"}".to_vec(),
    };
    assert_eq!(http_dispatch::prepare(&r).unwrap().body.unwrap(), r.body);
    r.method = Method::GET;
    assert!(http_dispatch::prepare(&r).unwrap().body.is_none());
    for route in ["//elsewhere", "https://example.invalid", "rpc", ""] {
        r.path = route.into();
        assert!(matches!(http_dispatch::prepare(&r), Err(Error::Schema)));
    }
    r.path = format!("/{}", "x".repeat(16 * 1024));
    assert!(matches!(http_dispatch::prepare(&r), Err(Error::Schema)));
    r.path = "/rpc".into();
    r.headers.insert("x".into(), "x".repeat(64 * 1024));
    assert!(matches!(http_dispatch::prepare(&r), Err(Error::TooLarge)));
}
#[test]
fn errors_are_exact_node_json_bytes_and_forward_only_two_response_headers() {
    for (outcome, status, message) in [
        (Outcome::TooLarge, 502, "Response too large"),
        (
            Outcome::Timeout,
            504,
            "The computer took too long to answer",
        ),
        (
            Outcome::Unavailable,
            502,
            "The computer could not be reached",
        ),
    ] {
        let r = http_dispatch::response(7, outcome).unwrap();
        assert_eq!(r.id, 7);
        assert_eq!(r.status, status);
        assert_eq!(
            r.body,
            format!("{{\"v\":1,\"error\":{{\"message\":\"{message}\"}}}}").as_bytes()
        );
    }
    let headers = Headers::from([
        ("ETag".into(), " one\t".into()),
        ("etag".into(), "two".into()),
        ("set-cookie".into(), "drop".into()),
    ]);
    let r = http_dispatch::response(1, reply(headers, vec![255, 0])).unwrap();
    assert_eq!(
        r.headers,
        Headers::from([("etag".into(), "one, two".into())])
    );
    assert_eq!(r.body, [255, 0]);
}
