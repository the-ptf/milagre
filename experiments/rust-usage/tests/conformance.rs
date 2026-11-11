use milagre_usage::{
    limits, pricing, report,
    scan::{CopiedRoot, ScanCache, Scanner},
    store::{UsageState, UsageStore},
    transcript::Entry,
};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance.json")).unwrap()
}
// JS has one numeric type; JSON integers and floats represent the same number. Floating arithmetic allows 1 ulp drift.
fn equal(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!((a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.), "{path}: {a} != {b}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array lengths");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equal(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: keys {:?} != {:?}", a.keys(), b.keys());
            for (k, v) in a {
                assert!(b.contains_key(k), "{path}.{k} missing");
                equal(v, &b[k], &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}
#[test]
fn provider_mappers_match_node() {
    for (i, c) in fixture()["limits"].as_array().unwrap().iter().enumerate() {
        let v = &c["input"];
        let result = match v["fn"].as_str().unwrap() {
            "claude" => limits::claude_windows(&v["body"]),
            "codex" => limits::codex_windows(&v["body"]),
            "gemini" => limits::gemini_windows(&v["body"]),
            "kiro" => limits::parse_kiro_usage(v["text"].as_str().unwrap()),
            "retry" => json!(limits::retry_after_ms(&v["header"], v["now"].as_i64().unwrap())),
            _ => panic!(),
        };
        equal(&result, &c["expected"], &format!("limits {i}"));
    }
}
#[test]
fn pricing_matches_node() {
    for c in fixture()["pricing"].as_array().unwrap() {
        let v = &c["input"];
        let result = if v["fn"] == "slim" {
            pricing::slim_prices(&v["catalog"])
        } else {
            pricing::price_of(&v["models"], v["model"].as_str().unwrap()).cloned().unwrap_or(Value::Null)
        };
        equal(&result, &c["expected"], "pricing");
    }
}
#[test]
fn incremental_parsers_match_node() {
    let mut key = String::new();
    let mut entry = Entry::new("claude");
    for (i, c) in fixture()["transcripts"].as_array().unwrap().iter().enumerate() {
        let v = &c["input"];
        let p = v["provider"].as_str().unwrap();
        let next = format!("{p}:{}", v["sequence"]);
        if key != next {
            key = next;
            entry = Entry::new(p);
        }
        entry.feed(format!("{}\n", v["line"].as_str().unwrap()).as_bytes());
        equal(&serde_json::to_value(&entry).unwrap(), &c["expected"], &format!("transcript {i}"));
    }
}
#[test]
fn store_whitelist_and_snapshot_match_node() {
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    let mut store = UsageStore::default();
    for c in f["stores"].as_array().unwrap() {
        let v = &c["input"];
        match v["op"].as_str().unwrap() {
            "last" => store.set_last(v["provider"].as_str().unwrap(), &v["value"]),
            "blocked" => store.set_blocked(v["provider"].as_str().unwrap(), &v["value"]),
            _ => {}
        }
        equal(&json!({"state":store.to_json(),"snapshot":store.snapshot(v["now"].as_i64().unwrap_or(now))}), &c["expected"], "store");
    }
}
#[test]
fn reader_backoff_last_good_and_checked_time_match_node() {
    let mut state = UsageState::default();
    let mut calls = 0;
    for c in fixture()["reader"].as_array().unwrap() {
        let v = &c["input"];
        let now = v["at"].as_i64().unwrap();
        let blocked = state.begin("claude", now);
        let was_blocked = blocked.is_some();
        let result = blocked.unwrap_or_else(|| {
            calls += 1;
            v["result"].clone()
        });
        let result = state.complete("claude", result, now, was_blocked);
        equal(
            &json!({"result":result,"cached":state.cached("claude",now),"checkedAt":state.checked_at("claude"),"calls":calls}),
            &c["expected"],
            "reader",
        );
    }
}
#[test]
fn reports_match_node_including_dst_attribution_and_overflow() {
    for (i, c) in fixture()["reports"].as_array().unwrap().iter().enumerate() {
        let result = report::build_report(&c["input"]).unwrap();
        equal(&result, &c["expected"], &format!("report {i}"));
    }
}
#[test]
fn copied_profile_incremental_scan_matches_node() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let roots = vec![
        CopiedRoot::new("claude", root.join("claude")).unwrap(),
        CopiedRoot::new("codex", root.join("codex")).unwrap(),
        CopiedRoot::new("codex", root.join("archive")).unwrap(),
    ];
    let mut scan = Scanner::new(roots.clone(), ScanCache::default());
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    for (i, c) in f["scans"].as_array().unwrap().iter().enumerate() {
        let v = &c["input"];
        let file = root.join(v["file"].as_str().unwrap_or("unused"));
        let mut changed = Value::Null;
        match v["op"].as_str().unwrap() {
            "write" => {
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, v["text"].as_str().unwrap()).unwrap();
            }
            "append" => {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().append(true).open(file).unwrap();
                file.write_all(v["text"].as_str().unwrap().as_bytes()).unwrap();
            }
            "move" => {
                let to = root.join(v["to"].as_str().unwrap());
                std::fs::create_dir_all(to.parent().unwrap()).unwrap();
                std::fs::rename(file, to).unwrap();
            }
            "remove" => std::fs::remove_file(file).unwrap(),
            "reopen" => scan = Scanner::new(roots.clone(), ScanCache::from_json(scan.cache().to_json())),
            "scan" => changed = json!(scan.scan(now).unwrap()),
            _ => panic!(),
        }
        equal(
            &json!({"changed":changed,"rows":scan.rows(),"finished":scan.finished(),"scannedAt":scan.scanned_at()}),
            &c["expected"],
            &format!("scan {i}"),
        );
    }
}

#[test]
fn claude_http_status_mapping_matches_node() {
    for c in fixture()["claudeResponses"].as_array().unwrap() {
        let v = &c["input"];
        equal(
            &limits::claude_response(v["status"].as_u64().unwrap() as u16, Some(&v["body"]), &v["retry"], v["now"].as_i64().unwrap()),
            &c["expected"],
            "claude response",
        );
    }
}
#[test]
fn codex_chunked_exchange_matches_node_without_a_process() {
    for c in fixture()["codex"].as_array().unwrap() {
        let mut protocol = limits::CodexUsage::new();
        let mut sent = protocol.outgoing();
        for chunk in c["input"]["chunks"].as_array().unwrap() {
            protocol.feed(chunk.as_str().unwrap().as_bytes(), c["input"]["now"].as_i64().unwrap());
            sent.extend(protocol.outgoing());
        }
        equal(&json!(sent), &c["expected"]["sent"], "codex sent");
        equal(protocol.result().unwrap(), &c["expected"]["result"], "codex result");
        assert_eq!(c["expected"]["kills"], json!(["SIGTERM"]), "runtime must stop after result");
    }
}
#[test]
fn price_refresh_boundaries_and_retry_match_node() {
    let mut pricing = pricing::Pricing::default();
    let mut downloads = 0;
    let catalog = json!({"model":{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6}});
    for c in fixture()["priceState"].as_array().unwrap() {
        let now = c["input"]["at"].as_i64().unwrap();
        let current = pricing.current().cloned();
        let starts = pricing.begin_refresh(now);
        let during = pricing.status(now);
        if starts {
            downloads += 1;
            pricing.complete((c["input"]["ok"] == true).then_some(&catalog), now);
        }
        equal(
            &json!({"current":current,"during":during,"status":pricing.status(now),"downloads":downloads}),
            &c["expected"],
            "pricing refresh",
        );
    }
}
