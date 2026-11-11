use super::*;

#[test]
fn source_copy_is_exact() {
    assert_eq!(
        include_bytes!("jsjson.rs").as_slice(),
        include_bytes!("../../../rust-owner/src/jsjson.rs").as_slice()
    );
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!("{:x}", Sha256::digest(include_bytes!("jsjson.rs"))),
        "518c89cfdad784818b2431d25fb580a85de32949716fecf41aa5cc9ba86097f3"
    );
}

const START: i64 = 1_767_607_200_000;
fn spec() -> Value {
    json!({"name":"check","prompt":"look","trigger":{"kind":"schedule","cron":"0 * * * *","timezone":"UTC"},"target":{"kind":"new-chat","projectPath":"/synthetic","workspace":"project"},"createdBy":{"kind":"user"}})
}
fn heartbeat() -> Value {
    json!({"name":"check","prompt":"look","every":"15m","timezone":"UTC","chatId":"synthetic-chat","createdBy":{"kind":"user"}})
}
fn call(m: &mut Model, op: &str, args: &[Value], at: i64) -> Value {
    m.execute(op, args, at, Fault::None).unwrap()
}
fn base() -> Model {
    let mut m = Model::open(None, START).unwrap();
    call(&mut m, "create", &[spec()], START);
    m
}

#[test]
fn transaction_failure_retains_every_publication_component_but_consumes_ids() {
    for fault in [Fault::Write, Fault::Rename] {
        let mut m = base();
        let before = (
            m.data.clone(),
            m.published.clone(),
            m.positions.clone(),
            m.run_index.clone(),
            m.maintained_at,
            m.saves,
        );
        let at = integer(&m.data["routines"][0]["nextRunAt"]).unwrap();
        assert!(matches!(
            m.execute("claimDue", &[json!(at)], at, fault),
            Err(Error::Node(_))
        ));
        assert_eq!(
            (
                m.data.clone(),
                m.published.clone(),
                m.positions.clone(),
                m.run_index.clone(),
                m.maintained_at,
                m.saves
            ),
            before
        );
        assert!(m.effects.is_empty());
        assert_eq!(m.ids.calls, 2);
        let claim = call(&mut m, "claimDue", &[json!(at)], at);
        assert_eq!(claim[0]["run"]["id"], "id3");
        assert_eq!(m.saves, 2);
        assert_eq!(call(&mut m, "claimDue", &[json!(at)], at), json!([]));
    }
}

#[test]
fn failed_finish_remove_and_upkeep_do_not_emit_or_partially_commit() {
    let mut m = base();
    call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
    call(
        &mut m,
        "attachChat",
        &[json!("id2"), json!({"chatId":"c"})],
        START,
    );
    for (op, args) in [
        ("finishRun", vec![json!("id2"), json!({"status":"acted"})]),
        ("remove", vec![json!("id1")]),
    ] {
        let before = (
            m.data.clone(),
            m.published.clone(),
            m.maintained_at,
            m.saves,
        );
        assert!(m.execute(op, &args, START + HOUR, Fault::Write).is_err());
        assert_eq!(
            (
                m.data.clone(),
                m.published.clone(),
                m.maintained_at,
                m.saves
            ),
            before
        );
        assert!(m.effects.is_empty());
    }
    call(&mut m, "complete", &[json!("id1"), json!("done")], START);
    let before = m.data.clone();
    assert!(m
        .execute(
            "remove",
            &[json!("missing")],
            START + MAX_EXPIRY,
            Fault::Rename
        )
        .is_err());
    assert_eq!(m.data, before);
    assert!(m.effects.is_empty());
    assert_eq!(m.maintained_at, START);
    call(&mut m, "remove", &[json!("missing")], START + MAX_EXPIRY);
    assert_eq!(m.effects[0]["kind"], "purged");
    assert_eq!(m.effects[1]["kind"], "dropped");
    assert!(m.run_index.is_empty());
    assert_eq!(m.data["removed"]["id1"], START + MAX_EXPIRY);
}

#[test]
fn load_upkeep_keeps_the_last_file_image_until_a_later_write() {
    let mut m = base();
    call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
    call(
        &mut m,
        "attachChat",
        &[json!("id2"), json!({"chatId":"c"})],
        START,
    );
    call(&mut m, "complete", &[json!("id1"), json!("done")], START);
    let bytes = m.published.clone();
    let mut loaded = Model::open(bytes.clone(), START + MAX_EXPIRY).unwrap();
    assert_eq!(loaded.published, bytes);
    assert_eq!(loaded.saves, 0);
    assert!(rows(&loaded.data).is_empty());
    assert_eq!(loaded.effects.len(), 2);
    assert!(loaded.run_index.is_empty());
    call(
        &mut loaded,
        "remove",
        &[json!("missing")],
        START + MAX_EXPIRY,
    );
    assert_eq!(loaded.published, bytes);
    call(&mut loaded, "create", &[spec()], START + MAX_EXPIRY);
    assert_ne!(loaded.published, bytes);
}

#[test]
fn late_boundary_and_recovery_never_replay_missed_periods() {
    for (lag, count, status) in [
        (60_000, 1, "running"),
        (60_001, 0, "missed"),
        (7 * DAY, 0, "missed"),
    ] {
        let mut m = base();
        let due = integer(&m.data["routines"][0]["nextRunAt"]).unwrap();
        let claims = call(&mut m, "claimDue", &[json!(due + lag)], due + lag);
        assert_eq!(claims.as_array().unwrap().len(), count);
        assert_eq!(m.data["runs"]["id1"][0]["status"], status);
        assert_eq!(m.data["runs"]["id1"].as_array().unwrap().len(), 1);
        assert!(integer(&m.data["routines"][0]["nextRunAt"]).unwrap() > due + lag);
        assert_eq!(
            call(&mut m, "claimDue", &[json!(due + lag)], due + lag),
            json!([])
        );
    }
    let mut m = base();
    for _ in 0..3 {
        call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
    }
    call(&mut m, "reload", &[], START + DAY);
    call(&mut m, "recoverInterrupted", &[], START + DAY);
    assert_eq!(m.data["routines"][0]["runCount"], 3.);
    assert_eq!(m.data["routines"][0]["failedStreak"], 1.);
    assert_eq!(m.running_count(), 0);
    assert_eq!(m.data["runs"]["id1"].as_array().unwrap().len(), 3);
    let saved = m.published.clone();
    call(&mut m, "recoverInterrupted", &[], START + DAY);
    assert_eq!(m.published, saved);
}

#[test]
fn import_refuses_unsupported_whole_images_and_duplicate_ids() {
    let m = base();
    for kind in ["flow", "event", "systemv", "duplicate", "prototype"] {
        let mut state = m.data.clone();
        match kind {
            "flow" => state["routines"][0]["flow"] = json!({"revision":1,"steps":[]}),
            "event" => state["queues"]["id1"] = json!([{"event":{"key":"x"},"enqueuedAt":START}]),
            "systemv" => state["routines"][0]["trigger"]["timezone"] = json!("SystemV/EST5"),
            "duplicate" => {
                let row = state["routines"][0].clone();
                rows_mut(&mut state).push(row);
            }
            _ => state["routines"][0]["id"] = json!("__proto__"),
        }
        assert!(
            matches!(
                Model::open(Some(jsjson::to_string(&state)), START),
                Err(Error::Refused(_))
            ),
            "{kind}"
        );
    }
    for bytes in [
        "{",
        r#"{"version":2,"routines":[],"runs":{}}"#,
        r#"{"routines":{},"runs":{}}"#,
    ] {
        assert!(Model::open(Some(bytes.into()), START).is_err());
    }
}

#[test]
fn parser_and_retained_metadata_enforce_node_depth_byte_and_string_caps() {
    let boundary = format!("[{}]", vec!["null"; limits::NODES - 1].join(","));
    assert!(limits::parse(&boundary).is_ok());
    assert!(limits::parse(&boundary.replacen('[', "[null,", 1)).is_err());
    assert!(limits::parse(&format!("{}0{}", "[".repeat(32), "]".repeat(32))).is_ok());
    assert!(limits::parse(&format!("{}0{}", "[".repeat(33), "]".repeat(33))).is_err());
    assert!(limits::parse(&format!("\"{}\"", "x".repeat(limits::STRING))).is_ok());
    assert!(limits::parse(&format!("\"{}\"", "x".repeat(limits::STRING + 1))).is_err());
    assert!(limits::decode(&format!("{}0", " ".repeat(limits::BYTES))).is_err());
    assert!(limits::parse("1e999").is_err());
    // Keys do not count as value nodes, but retained values in unknown metadata do.
    assert!(limits::parse(r#"{"a":{"b":["key: value",{},true]}}"#).is_ok());
    let mut m = base();
    m.data["routines"][0]["unknown"] = json!(vec![Value::Null; limits::NODES]);
    let before = m.data.clone();
    assert!(m
        .execute("remove", &[json!("id1")], START, Fault::None)
        .is_err());
    assert_eq!(m.data, before);
}

#[test]
fn aggregate_results_and_effects_are_charged_before_publication() {
    let mut m = base();
    m.data["routines"][0]["unknown"] = json!(vec![Value::Null; limits::NODES / 2 + 1]);
    let before = (m.data.clone(), m.published.clone());
    assert!(matches!(
        m.execute(
            "update",
            &[json!("id1"), json!({"name":"changed"})],
            START,
            Fault::None
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!((m.data.clone(), m.published.clone()), before);
    assert!(m.effects.is_empty());
}

#[test]
fn never_trim_running_and_capacity_refusal_does_not_lose_tombstones() {
    let mut m = base();
    for _ in 0..61 {
        call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
    }
    assert_eq!(m.running_count(), 61);
    for n in 0..limits::TOMBSTONES {
        m.data["removed"][format!("old{n}")] = json!(START);
    }
    let before = (m.data.clone(), m.published.clone());
    assert!(m
        .execute("remove", &[json!("id1")], START, Fault::None)
        .is_err());
    assert_eq!((m.data.clone(), m.published.clone()), before);
    assert_eq!(m.running_count(), 61);
}

#[test]
fn upsert_replacement_and_finish_are_distinct_from_validated_create_and_idempotent() {
    let mut m = Model::open(None, START).unwrap();
    let mut h = heartbeat();
    h["name"] = json!("a".repeat(81));
    let first = call(&mut m, "upsertHeartbeat", &[h.clone()], START);
    call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
    call(
        &mut m,
        "finishRun",
        &[json!("id2"), json!({"status":"acted"})],
        START,
    );
    assert_eq!(
        call(
            &mut m,
            "finishRun",
            &[json!("id2"), json!({"status":"failed"})],
            START
        ),
        Value::Null
    );
    call(&mut m, "pause", &[json!("id1"), json!("busy")], START);
    let again = call(&mut m, "upsertHeartbeat", &[h], START + DAY);
    assert_eq!(again["expiresAt"], first["expiresAt"]);
    assert_eq!(again["runCount"], 1.);
    assert!(again.get("pausedReason").is_none());
    assert!(again.get("failedStreak").is_none());
}

#[test]
fn node_whitespace_utf16_and_order_are_preserved() {
    assert!(check::text(&json!("\u{feff}"), "name", 80).is_err());
    assert!(check::text(&json!("\u{85}"), "name", 80).is_ok());
    assert!(check::text(&json!("😀".repeat(40)), "name", 80).is_ok());
    assert!(check::text(&json!("😀".repeat(41)), "name", 80).is_err());
    let lone = limits::parse(r#""\ud800""#).unwrap();
    assert!(check::text(&lone, "name", 80).is_ok());
    let mut m = base();
    let patch = limits::parse(r#"{"z":1,"a":1}"#).unwrap();
    assert_eq!(
        m.execute("update", &[json!("id1"), patch], START, Fault::None),
        Err(Error::Node("Cannot update z".into()))
    );
}

#[test]
fn future_schedule_outputs_do_not_inherit_the_narrower_after_input_bound() {
    let mut m = Model::open(None, crate::MAX_AFTER_MS).unwrap();
    let made = call(&mut m, "create", &[spec()], crate::MAX_AFTER_MS);
    assert!(integer(&made["nextRunAt"]).unwrap() > crate::MAX_AFTER_MS);
    assert!(Model::open(m.published.clone(), crate::MAX_AFTER_MS).is_ok());
    assert!(m
        .execute(
            "claimDue",
            &[made["nextRunAt"].clone()],
            crate::MAX_AFTER_MS,
            Fault::None
        )
        .is_err());
}

#[test]
fn routine_and_run_caps_refuse_whole_mutations_at_the_exact_boundary() {
    let mut m = Model::open(None, START).unwrap();
    for _ in 0..limits::ROUTINES {
        call(&mut m, "create", &[spec()], START);
    }
    let before = (m.data.clone(), m.published.clone(), m.saves);
    assert!(matches!(
        m.execute("create", &[spec()], START, Fault::None),
        Err(Error::Refused(_))
    ));
    assert_eq!((m.data.clone(), m.published.clone(), m.saves), before);
    assert_eq!(m.ids.calls, 65);
    let mut seeded = base().data;
    seeded["runs"]["id1"] = Value::Array((0..limits::RUNS).map(|n| json!({"id":format!("run{n}"),"routineId":"id1","status":"running","startedAt":START})).collect());
    let mut m = Model::open(Some(jsjson::to_string(&seeded)), START).unwrap();
    assert_eq!(m.running_count(), limits::RUNS);
    let before = (m.data.clone(), m.published.clone(), m.run_index.clone());
    assert!(matches!(
        m.execute(
            "startRun",
            &[json!("id1"), json!(START)],
            START,
            Fault::None
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(
        (m.data.clone(), m.published.clone(), m.run_index.clone()),
        before
    );
    assert_eq!(m.ids.calls, 1);
}

#[test]
fn exact_serialized_image_limit_is_independent_of_node_and_string_limits() {
    let mut data = base().data;
    data["routines"][0]["unknown"] =
        json!({"values":vec!["x".repeat(limits::STRING);255],"padding":""});
    let left = limits::BYTES - jsjson::to_string(&data).len();
    assert!(left < limits::STRING);
    data["routines"][0]["unknown"]["padding"] = json!("x".repeat(left));
    let image = limits::image(&data).unwrap();
    assert_eq!(image.len(), limits::BYTES);
    let mut m = Model::open(Some(image.clone()), START).unwrap();
    assert!(matches!(
        m.execute(
            "update",
            &[json!("id1"), json!({"name":"checks"})],
            START,
            Fault::None
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(m.published.as_deref(), Some(image.as_str()));
    assert_eq!(m.data["routines"][0]["name"], "check");
    assert!(m.effects.is_empty());
}

#[test]
fn duplicate_generated_identity_refuses_after_id_consumption_without_index_loss() {
    let mut m = base();
    m.ids.forced = Some("id1".into());
    let before = (m.data.clone(), m.published.clone(), m.positions.clone());
    assert!(matches!(
        m.execute("create", &[spec()], START, Fault::None),
        Err(Error::Refused(_))
    ));
    assert_eq!(
        (m.data.clone(), m.published.clone(), m.positions.clone()),
        before
    );
    assert_eq!(m.ids.calls, 2);
}

#[test]
fn retained_unknown_metadata_and_orphan_run_observations_survive_reload() {
    let mut data = base().data;
    data["routines"][0]["unknown"] =
        limits::parse(r#"{"10":"ten","1":"one","a":"\ud800"}"#).unwrap();
    data["runs"]["orphan"] = json!([{"id":"unclaimed","routineId":"orphan","status":"running"}]);
    let mut m = Model::open(Some(jsjson::to_string(&data)), START).unwrap();
    assert_eq!(
        call(&mut m, "getRun", &[json!("unclaimed")], START),
        Value::Null
    );
    assert!(m.tracked.contains("orphan"));
    assert_eq!(m.running_count(), 1);
    call(
        &mut m,
        "update",
        &[json!("id1"), json!({"prompt":"next"})],
        START,
    );
    call(&mut m, "reload", &[], START);
    assert_eq!(
        m.data["routines"][0]["unknown"],
        data["routines"][0]["unknown"]
    );
    assert!(m.run_index.contains_key("unclaimed"));
}

#[test]
fn cron_errors_cross_the_encoded_json_boundary_once() {
    let mut input = spec();
    input["trigger"]["timezone"] = json!("\u{10fffe}\u{10fffe}");
    let input = jsjson::RawJson(input).into_encoded();
    let mut m = base();
    let result = m.execute("create", &[input], START, Fault::None);
    let wire = jsjson::to_string(&outcome(result));
    let raw: Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(
        raw["error"],
        "Invalid cron: unknown timezone \u{10fffe}\u{10fffe}"
    );
    let mut input = heartbeat();
    input["expiresIn"] = json!("\u{10fffe}\u{10fffe}");
    let input = jsjson::RawJson(input).into_encoded();
    let result = m.execute("upsertHeartbeat", &[input], START, Fault::None);
    let raw: Value = serde_json::from_str(&jsjson::to_string(&outcome(result))).unwrap();
    assert_eq!(
        raw["error"],
        "Invalid expiresIn: \"\u{10fffe}\u{10fffe}\" (use e.g. 30m, 6h or 7d)"
    );
}

#[test]
fn batch_run_capacity_refuses_all_claims_without_losing_an_earlier_candidate() {
    let mut m = base();
    call(&mut m, "create", &[spec()], START);
    let at = integer(&m.data["routines"][0]["nextRunAt"]).unwrap();
    let mut seed = m.data;
    seed["runs"]["id1"] = Value::Array((0..limits::RUNS - 1).map(|n| json!({"id":format!("held{n}"),"routineId":"id1","status":"running","startedAt":START})).collect());
    let mut m = Model::open(Some(jsjson::to_string(&seed)), START).unwrap();
    let before = (
        m.data.clone(),
        m.published.clone(),
        m.maintained_at,
        m.run_index.clone(),
    );
    assert!(matches!(
        m.execute("claimDue", &[json!(at)], at, Fault::None),
        Err(Error::Refused(_))
    ));
    assert_eq!(
        (
            m.data.clone(),
            m.published.clone(),
            m.maintained_at,
            m.run_index.clone()
        ),
        before
    );
    assert_eq!(m.ids.calls, 2);
    assert_eq!(m.running_count(), limits::RUNS - 1);
    assert!(m.effects.is_empty());
}

#[test]
fn missing_and_null_finish_outcomes_keep_the_actual_node_error_precedence() {
    let mut m = base();
    assert_eq!(
        m.execute("finishRun", &[json!("missing")], START, Fault::None),
        Err(Error::Node(
            "Cannot destructure property 'status' of 'undefined' as it is undefined.".into()
        ))
    );
    assert_eq!(
        m.execute(
            "finishRun",
            &[json!("missing"), Value::Null],
            START,
            Fault::None
        ),
        Err(Error::Node(
            "Cannot destructure property 'status' of 'object null' as it is null.".into()
        ))
    );
    assert_eq!(m.saves, 1);
}

#[test]
fn every_identity_method_refuses_non_strings_without_aliasing_a_string_identity() {
    let mut data = base().data;
    data["routines"][0]["id"] = json!("1");
    data["runs"]["1"] = json!([{"id":"1","routineId":"1","status":"running","startedAt":START}]);
    let seed = jsjson::to_string(&data);
    let methods = [
        ("get", vec![]),
        ("runs", vec![]),
        ("getRun", vec![]),
        ("hasRun", vec![]),
        ("hasPending", vec![]),
        ("wasRemoved", vec![]),
        ("update", vec![json!({"name":"changed"})]),
        ("remove", vec![]),
        ("startRun", vec![json!(START)]),
        ("finishRun", vec![json!({"status":"acted"})]),
        ("complete", vec![json!("done")]),
        ("pause", vec![json!("paused")]),
        ("setLastError", vec![json!("message")]),
        ("attachChat", vec![json!({"chatId":"c"})]),
        ("setRunTitle", vec![json!("title")]),
    ];
    assert_eq!(methods.len(), 15);
    for (op, tail) in methods {
        for id in [
            json!(1),
            Value::Null,
            json!(true),
            json!({"id":"1"}),
            json!(["1"]),
            jsjson::undefined(),
        ] {
            let mut m = Model::open(Some(seed.clone()), START).unwrap();
            let before = (
                m.data.clone(),
                m.published.clone(),
                m.maintained_at,
                m.ids.calls,
                m.positions.clone(),
                m.run_index.clone(),
            );
            let mut args = vec![id];
            args.extend(tail.clone());
            assert_eq!(
                m.execute(op, &args, START + HOUR, Fault::None),
                Err(Error::Refused("Routine/Run id must be a string".into())),
                "{op}"
            );
            assert_eq!(
                (
                    m.data.clone(),
                    m.published.clone(),
                    m.maintained_at,
                    m.ids.calls,
                    m.positions.clone(),
                    m.run_index.clone()
                ),
                before,
                "{op}"
            );
            assert!(m.effects.is_empty());
            assert_eq!(m.saves, 0);
        }
        let mut m = Model::open(Some(seed.clone()), START).unwrap();
        let mut args = vec![json!("1")];
        args.extend(tail);
        assert!(
            !m.execute(op, &args, START, Fault::None).unwrap().is_null(),
            "valid string control {op}"
        );
    }
}

#[test]
fn imported_signed_zero_creation_times_keep_stable_source_order() {
    let mut data = base().data;
    data["routines"][0]["createdAt"] = json!(-0.0);
    let mut second = data["routines"][0].clone();
    second["id"] = json!("second");
    second["createdAt"] = json!(0.0);
    rows_mut(&mut data).push(second);
    // The Node-compatible stringifier normalizes -0; raw saved input may retain it.
    let text = serde_json::to_string(&data).unwrap();
    assert!(text.contains("-0.0"));
    let m = Model::open(Some(text), START).unwrap();
    assert_eq!(m.list()[0]["id"], "id1");
    assert_eq!(m.list()[1]["id"], "second");
}

#[test]
fn prototype_name_refusals_cover_records_maps_tombstones_and_queries() {
    let names = [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "__proto__",
        "toLocaleString",
        "prototype",
    ];
    for name in names {
        for location in ["routine", "run", "runs-key", "removed"] {
            let mut data = base().data;
            match location {
                "routine" => data["routines"][0]["id"] = json!(name),
                "run" => {
                    data["runs"]["id1"] = json!([{"id":name,"routineId":"id1","status":"running"}])
                }
                "runs-key" => data["runs"][name] = json!([]),
                _ => data["removed"][name] = json!(START),
            }
            assert!(
                matches!(
                    Model::open(Some(jsjson::to_string(&data)), START),
                    Err(Error::Refused(_))
                ),
                "{name} at {location}"
            );
        }
        let mut m = base();
        assert!(matches!(
            m.execute("get", &[json!(name)], START, Fault::None),
            Err(Error::Refused(_))
        ));
        assert!(matches!(
            m.execute("startRun", &[json!(name), json!(START)], START, Fault::None),
            Err(Error::Refused(_))
        ));
    }
}

#[test]
fn nonconvertible_error_metadata_rolls_back_only_when_node_interpolates_it() {
    for make in ["create", "upsertHeartbeat"] {
        for malformed in [json!({"toString":null}), json!([{"toString":0}])] {
            let mut m = Model::open(None, START).unwrap();
            call(
                &mut m,
                make,
                &[if make == "create" {
                    spec()
                } else {
                    heartbeat()
                }],
                START,
            );
            for n in 2..=3 {
                call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
                call(
                    &mut m,
                    "finishRun",
                    &[
                        json!(format!("id{n}")),
                        json!({"status":"failed","error":malformed}),
                    ],
                    START,
                );
            }
            call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
            let before = (m.data.clone(), m.published.clone(), m.saves, m.ids.calls);
            assert_eq!(
                m.execute(
                    "finishRun",
                    &[json!("id4"), json!({"status":"failed","error":malformed})],
                    START,
                    Fault::None
                ),
                Err(Error::Node(
                    "Cannot convert object to primitive value".into()
                ))
            );
            assert_eq!(
                (m.data.clone(), m.published.clone(), m.saves, m.ids.calls),
                before
            );
            assert!(m.effects.is_empty());
            assert_eq!(m.running_count(), 1);
            if make == "create" {
                call(
                    &mut m,
                    "pause",
                    &[json!("id1"), json!("already paused")],
                    START,
                );
            } else {
                call(
                    &mut m,
                    "complete",
                    &[json!("id1"), json!("already ended")],
                    START,
                );
            }
            call(
                &mut m,
                "finishRun",
                &[json!("id4"), json!({"status":"failed","error":malformed})],
                START,
            );
            assert_eq!(m.running_count(), 0);
        }
    }
}

#[test]
fn max_run_completion_precedes_error_interpolation() {
    for make in ["create", "upsertHeartbeat"] {
        let mut m = Model::open(None, START).unwrap();
        let mut input = if make == "create" {
            spec()
        } else {
            heartbeat()
        };
        input["maxRuns"] = json!(3);
        call(&mut m, make, &[input], START);
        for n in 2..=4 {
            call(&mut m, "startRun", &[json!("id1"), json!(START)], START);
            call(
                &mut m,
                "finishRun",
                &[
                    json!(format!("id{n}")),
                    json!({"status":"failed","error":{"toString":null}}),
                ],
                START,
            );
        }
        assert_eq!(m.data["routines"][0]["completedAt"], START);
        assert_eq!(m.data["routines"][0]["runCount"], 3.);
        assert_eq!(m.data["runs"]["id1"][2]["error"], json!({"toString":null}));
    }
}

#[test]
fn internal_undefined_never_satisfies_a_node_string_check() {
    let mut m = base();
    assert_eq!(
        m.execute("create", &[json!({})], START, Fault::None),
        Err(Error::Node(
            "name must be a non-empty string of at most 80 characters".into()
        ))
    );
    for (field, message) in [
        (
            "name",
            "name must be a non-empty string of at most 80 characters",
        ),
        (
            "prompt",
            "prompt must be a non-empty string of at most 4000 characters",
        ),
    ] {
        let mut input = spec();
        delete(&mut input, field);
        assert_eq!(
            m.execute("create", &[input], START, Fault::None),
            Err(Error::Node(message.into()))
        );
    }
    assert_eq!(
        m.execute(
            "update",
            &[json!("id1"), json!({"fallback":{"provider":"p"}})],
            START,
            Fault::None
        ),
        Err(Error::Node(
            "fallback model must be a non-empty string of at most 200 characters".into()
        ))
    );
    assert_eq!(
        m.execute("setLastError", &[json!("id1")], START, Fault::None),
        Err(Error::Node("lastError must be a message or null".into()))
    );
    assert_eq!(
        m.execute("pause", &[json!("id1")], START, Fault::None),
        Err(Error::Node("reason must be a non-empty string".into()))
    );
    assert_eq!(
        m.execute("setRunTitle", &[json!("missing")], START, Fault::None),
        Err(Error::Node("title must be a non-empty string".into()))
    );
    assert_eq!(
        m.execute(
            "attachChat",
            &[json!("missing"), json!({})],
            START,
            Fault::None
        ),
        Err(Error::Node("chatId must be a non-empty string".into()))
    );
    let mut h = heartbeat();
    delete(&mut h, "every");
    h["cron"] = Value::Null;
    assert_eq!(
        m.execute("upsertHeartbeat", &[h], START, Fault::None),
        Err(Error::Node(
            "Invalid every: undefined (use e.g. 15m or 2h)".into()
        ))
    );
    assert_eq!(m.ids.calls, 1);
    let mut m = Model::open(None, 0).unwrap();
    call(&mut m, "create", &[spec()], 0);
    call(&mut m, "complete", &[json!("id1")], 0);
    assert!(m.data["routines"][0].get("completedReason").is_none());
}
