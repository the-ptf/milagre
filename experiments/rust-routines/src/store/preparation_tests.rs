use super::*;

const START: i64 = 1_767_607_200_000;
fn spec() -> Value {
    json!({"name":"check","prompt":"look","trigger":{"kind":"schedule","cron":"0 * * * *","timezone":"UTC"},"target":{"kind":"new-chat","projectPath":"/synthetic","workspace":"project"},"createdBy":{"kind":"user"}})
}
fn base() -> Model {
    let mut model = Model::open(None, START).unwrap();
    model
        .execute("create", &[spec()], START, Fault::None)
        .unwrap();
    model
}
fn snapshot(model: &Model) -> Value {
    // Includes logical reads, file image, effects, ID calls and successful publications.
    model.observe(Ok(Value::Null))
}
fn pending(model: &Model) -> &Candidate {
    let Phase::Pending(candidate) = &model.phase else {
        panic!("expected retained candidate")
    };
    candidate
}

#[test]
fn prepared_create_is_invisible_until_exact_install() {
    let mut model = Model::open(None, START).unwrap();
    let stamp = model.prepare("create", &[spec()], START).unwrap();
    assert!(model.list().as_array().unwrap().is_empty());
    assert!(model.positions.is_empty());
    assert!(model.tracked.is_empty());
    assert_eq!(model.published, None);
    assert_eq!(model.saves, 0);
    assert_eq!(model.ids.calls, 1);
    let candidate = pending(&model);
    let publication = candidate.publication.as_ref().unwrap();
    assert_eq!(publication.positions.get("id1"), Some(&0));
    assert!(publication.tracked.contains("id1"));
    let image = model.pending_image(stamp).unwrap().unwrap().to_owned();
    assert_eq!(model.install(stamp).unwrap()["id"], "id1");
    assert_eq!(model.get("id1")["name"], "check");
    assert_eq!(model.published.as_deref(), Some(image.as_str()));
    assert_eq!(model.saves, 1);
}

#[test]
fn wrong_origin_cannot_read_install_or_discard_either_candidate() {
    let mut a = base();
    let mut b = base();
    let sa = a.prepare("create", &[spec()], START).unwrap();
    let sb = b.prepare("create", &[spec()], START).unwrap();
    assert_eq!(sa.generation, sb.generation);
    assert_ne!(sa.origin, sb.origin);
    let before = snapshot(&b);
    let image = b.pending_image(sb).unwrap().unwrap().to_owned();
    assert!(b.pending_image(sa).is_err());
    assert!(b.install(sa).is_err());
    assert!(b.discard(sa).is_err());
    assert_eq!(snapshot(&b), before);
    assert_eq!(b.pending_image(sb).unwrap(), Some(image.as_str()));
    assert_eq!(b.install(sb).unwrap()["id"], "id2");
    assert_eq!(a.install(sa).unwrap()["id"], "id2");
}

#[test]
fn stale_and_duplicate_stamps_cannot_consume_a_new_candidate() {
    let mut model = base();
    let old = model.prepare("create", &[spec()], START).unwrap();
    model.discard(old).unwrap();
    let current = model.prepare("create", &[spec()], START).unwrap();
    let before = snapshot(&model);
    assert!(model.install(old).is_err());
    assert!(model.discard(old).is_err());
    assert!(model.pending_image(old).is_err());
    assert_eq!(snapshot(&model), before);
    assert_eq!(model.install(current).unwrap()["id"], "id3");
    let installed = snapshot(&model);
    assert!(model.install(current).is_err());
    assert!(model.discard(current).is_err());
    assert_eq!(snapshot(&model), installed);
}

#[test]
fn pending_blocks_second_prepare_execute_reload_and_direct_mutation() {
    let mut model = base();
    let stamp = model
        .prepare("complete", &[json!("id1"), json!("done")], START)
        .unwrap();
    let before = snapshot(&model);
    let image = model.pending_image(stamp).unwrap().unwrap().to_owned();
    let generation = model.generation;
    assert!(model.prepare("create", &[spec()], START).is_err());
    assert!(model.execute("list", &[], START, Fault::None).is_err());
    assert!(model.execute("reload", &[], START, Fault::None).is_err());
    assert!(model.reload(START).is_err());
    assert!(model.create(&spec(), START).is_err());
    assert_eq!(model.generation, generation);
    assert_eq!(snapshot(&model), before);
    assert_eq!(model.pending_image(stamp).unwrap(), Some(image.as_str()));
    assert_eq!(pending(&model).effects.len(), 1);
    model.install(stamp).unwrap();
    assert_eq!(model.effects[0]["kind"], "ended");
}

#[test]
fn generation_exhaustion_precedes_ids_effects_and_candidate_changes() {
    let mut model = base();
    model
        .execute(
            "complete",
            &[json!("id1"), json!("done")],
            START,
            Fault::None,
        )
        .unwrap();
    model.generation = u64::MAX;
    let before = snapshot(&model);
    assert!(model.prepare("create", &[spec()], START).is_err());
    assert_eq!(model.generation, u64::MAX);
    assert!(matches!(model.phase, Phase::Ready));
    assert_eq!(snapshot(&model), before);
}

#[test]
fn reload_changes_origin_and_preserves_source_id_sequence() {
    let mut model = base();
    let old = model.prepare("create", &[spec()], START).unwrap();
    model.discard(old).unwrap();
    model.reload(START).unwrap();
    assert_ne!(model.origin, old.origin);
    let current = model.prepare("create", &[spec()], START).unwrap();
    assert!(model.install(old).is_err());
    assert_eq!(model.install(current).unwrap()["id"], "id3");
    assert_eq!(model.saves, 2);
}

#[test]
fn discard_consumes_ids_but_never_publishes_or_releases_effects() {
    let mut model = base();
    let before = (
        model.data.clone(),
        model.published.clone(),
        model.maintained_at,
        model.saves,
    );
    let stamp = model
        .prepare("startRun", &[json!("id1"), json!(START)], START)
        .unwrap();
    assert!(pending(&model)
        .publication
        .as_ref()
        .unwrap()
        .run_index
        .contains_key("id2"));
    model.discard(stamp).unwrap();
    assert_eq!(
        (
            model.data.clone(),
            model.published.clone(),
            model.maintained_at,
            model.saves
        ),
        before
    );
    assert_eq!(model.ids.calls, 2);
    assert!(model.effects.is_empty());
    assert!(model.run_index.is_empty());
    let next = model
        .prepare("startRun", &[json!("id1"), json!(START)], START)
        .unwrap();
    assert_eq!(model.install(next).unwrap()["run"]["id"], "id3");
}

#[test]
fn no_write_maintenance_waits_for_install_and_ignores_write_faults() {
    let mut model = Model::open(None, START).unwrap();
    let stamp = model
        .prepare("remove", &[json!("missing")], START + HOUR)
        .unwrap();
    assert_eq!(model.pending_image(stamp).unwrap(), None);
    assert_eq!(model.maintained_at, START);
    model.discard(stamp).unwrap();
    assert_eq!(model.maintained_at, START);
    let stamp = model
        .prepare("remove", &[json!("missing")], START + HOUR)
        .unwrap();
    assert_eq!(model.install(stamp).unwrap(), false);
    assert_eq!(model.maintained_at, START + HOUR);
    assert_eq!(model.published, None);
    assert_eq!(model.saves, 0);
    assert_eq!(
        model
            .execute(
                "remove",
                &[json!("missing")],
                START + 2 * HOUR,
                Fault::Rename
            )
            .unwrap(),
        false
    );
    assert_eq!(model.maintained_at, START + 2 * HOUR);
}

#[test]
fn no_due_fast_paths_and_reads_do_not_invent_upkeep_or_file_writes() {
    let mut model = base();
    let file = model.published.clone();
    let stamp = model.prepare("claimDue", &[json!(START)], START).unwrap();
    assert!(model.pending_image(stamp).unwrap().is_none());
    assert_eq!(model.install(stamp).unwrap(), json!([]));
    let stamp = model.prepare("expireDue", &[json!(START)], START).unwrap();
    assert!(jsjson::is_undefined(&model.install(stamp).unwrap()));
    let stamp = model.prepare("list", &[], START + HOUR).unwrap();
    assert_eq!(model.install(stamp).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(model.maintained_at, START);
    assert_eq!(model.published, file);
    assert_eq!(model.saves, 1);
}

#[test]
fn removal_prebuilds_indexes_tracking_and_dropped_effects() {
    let mut model = base();
    model
        .execute(
            "startRun",
            &[json!("id1"), json!(START)],
            START,
            Fault::None,
        )
        .unwrap();
    model
        .execute(
            "attachChat",
            &[json!("id2"), json!({"chatId":"c1"})],
            START,
            Fault::None,
        )
        .unwrap();
    let stamp = model.prepare("remove", &[json!("id1")], START).unwrap();
    let candidate = pending(&model);
    let publication = candidate.publication.as_ref().unwrap();
    assert!(publication.positions.is_empty());
    assert!(publication.run_index.is_empty());
    assert!(publication.tracked.contains("id1"));
    assert_eq!(candidate.effects[0]["kind"], "dropped");
    assert!(model.effects.is_empty());
    assert!(model.run_index.contains_key("id2"));
    assert_eq!(model.install(stamp).unwrap(), true);
    assert!(model.run_index.is_empty());
    assert!(model.tracked.contains("id1"));
    assert_eq!(model.effects[0]["value"][0]["chatId"], "c1");
}

#[test]
fn failed_batch_never_becomes_pending_and_preserves_consumed_ids() {
    let mut model = base();
    model
        .execute("create", &[spec()], START, Fault::None)
        .unwrap();
    let due = integer(&model.data["routines"][0]["nextRunAt"]).unwrap();
    model.data["runs"]["id1"] = Value::Array((0..limits::RUNS - 1).map(|n| json!({"id":format!("held{n}"),"routineId":"id1","status":"running","startedAt":START})).collect());
    let mut model = Model::open(Some(jsjson::to_string(&model.data)), START).unwrap();
    let before = (
        model.data.clone(),
        model.published.clone(),
        model.run_index.clone(),
        model.maintained_at,
    );
    assert!(model.prepare("claimDue", &[json!(due)], due).is_err());
    assert!(matches!(model.phase, Phase::Ready));
    assert_eq!(
        (
            model.data.clone(),
            model.published.clone(),
            model.run_index.clone(),
            model.maintained_at
        ),
        before
    );
    assert_eq!(model.ids.calls, 2);
    assert!(model.effects.is_empty());
    let stamp = model.prepare("list", &[], START).unwrap();
    assert_eq!(model.install(stamp).unwrap().as_array().unwrap().len(), 2);
}

#[test]
fn failure_after_early_create_id_keeps_generation_and_source_order() {
    let mut model = Model::open(None, START).unwrap();
    let mut bad = spec();
    bad["provider"] = json!("");
    assert!(model.prepare("create", &[bad], START).is_err());
    assert!(matches!(model.phase, Phase::Ready));
    assert_eq!(model.ids.calls, 1);
    assert_eq!(model.generation, 1);
    let stamp = model.prepare("create", &[spec()], START).unwrap();
    assert_eq!(stamp.generation, 2);
    assert_eq!(model.install(stamp).unwrap()["id"], "id2");
}
