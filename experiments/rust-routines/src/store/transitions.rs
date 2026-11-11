use super::*;

pub(super) fn maintain(state: &mut Value, at: i64) -> Vec<String> {
    let purged = rows(state)
        .iter()
        .filter(|r| integer(get(r, "completedAt")).is_some_and(|ended| ended + MAX_EXPIRY <= at))
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    rows_mut(state).retain(|r| !purged.iter().any(|id| r["id"] == *id));
    for id in &purged {
        state["removed"][id] = json!(at);
        for key in ["runs", "queues", "seen", "rejections", "pullRequests"] {
            delete(&mut state[key], id);
        }
    }
    purged
}
fn completed(state: &mut Value, i: usize, at: i64) {
    let routine = &mut rows_mut(state)[i];
    routine["completedAt"] = json!(at);
    routine["enabled"] = json!(false);
    routine["nextRunAt"] = Value::Null;
    routine["updatedAt"] = json!(at);
    let id = routine["id"].as_str().unwrap().to_owned();
    for key in ["queues", "seen", "pullRequests"] {
        delete(&mut state[key], &id);
    }
}
fn append(state: &mut Value, id: &str, run: Value) {
    if !state["runs"].get(id).is_some_and(Value::is_array) {
        state["runs"][id] = json!([]);
    }
    let runs = state["runs"][id].as_array_mut().unwrap();
    runs.push(run);
    let bucket = |run: &Value| match run["status"].as_str() {
        Some("missed" | "skipped-busy") => 0,
        Some("acted") => 1,
        _ => 2,
    };
    let mut over = [-50i64; 3];
    for run in runs.iter() {
        over[bucket(run)] += 1;
    }
    if over.iter().all(|n| *n <= 0) {
        return;
    }
    runs.retain(|run| {
        if run["status"] == "running" {
            return true;
        }
        let n = &mut over[bucket(run)];
        let keep = *n <= 0;
        *n -= 1;
        keep
    });
}
fn next_or_pause(state: &mut Value, i: usize, at: i64) -> Result<Option<i64>> {
    match check::next(&rows(state)[i]["trigger"], at) {
        Ok(next) => Ok(Some(next)),
        Err(Error::Refused(s)) => refuse(s),
        Err(Error::Node(message)) => {
            let routine = &mut rows_mut(state)[i];
            routine["enabled"] = json!(false);
            routine["pausedReason"] = json!(NO_NEXT);
            routine["lastError"] = json!(message);
            routine["nextRunAt"] = Value::Null;
            routine["updatedAt"] = json!(at);
            Ok(None)
        }
    }
}
fn due(row: &Value, at: i64) -> bool {
    truth(row, "enabled")
        && !truth(row, "completedAt")
        && integer(get(row, "nextRunAt")).is_some_and(|n| n <= at)
}
fn expired(row: &Value, at: i64) -> bool {
    !truth(row, "completedAt") && integer(get(row, "expiresAt")).is_some_and(|n| n <= at)
}
// String(value) for the admitted JSON error metadata that Node interpolates.
// JSON cannot contain a callable own toString/valueOf. An own toString therefore
// suppresses Object.prototype.toString and ordinary conversion must throw.
fn error_text(value: &Value) -> Result<String> {
    match value {
        Value::Object(map) if map.contains_key("toString") => {
            error("Cannot convert object to primitive value")
        }
        Value::Object(_) => Ok("[object Object]".into()),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() || jsjson::is_undefined(item) {
                    Ok(String::new())
                } else {
                    error_text(item)
                }
            })
            .collect::<Result<Vec<_>>>()
            .map(|items| items.join(",")),
        other => Ok(text_of(other)),
    }
}
fn finish(
    state: &mut Value,
    location: (usize, &str, usize),
    status: &str,
    extra: &Value,
    at: i64,
    counts_to_failures: bool,
) -> Result<()> {
    let (i, rid, n) = location;
    let mut run = state["runs"][rid][n].clone();
    run["status"] = json!(status);
    run["endedAt"] = json!(at);
    for key in ["summary", "title", "error", "chatId"] {
        if defined(extra, key) {
            run[key] = extra[key].clone();
        }
    }
    let routine = &mut rows_mut(state)[i];
    routine["updatedAt"] = json!(at);
    routine["lastRunAt"] = get(&run, "startedAt").clone();
    let counted = matches!(status, "acted" | "quiet" | "failed" | "ended");
    if counted {
        routine["runCount"] = json!(routine["runCount"].as_f64().unwrap() + 1.);
    }
    if status == "failed" {
        if counts_to_failures {
            routine["failedStreak"] = json!(routine["failedStreak"].as_f64().unwrap_or(0.) + 1.);
        }
    } else if counted {
        routine["failedStreak"] = json!(0);
    }
    let mut end = false;
    if !truth(routine, "completedAt") {
        if routine["maxRuns"]
            .as_f64()
            .is_some_and(|cap| routine["runCount"].as_f64().unwrap() >= cap)
        {
            end = true;
        } else if routine["failedStreak"].as_f64().is_some_and(|n| n >= 3.) {
            if routine["target"]["kind"] == "new-chat" {
                if truth(routine, "enabled") {
                    routine["enabled"] = json!(false);
                    routine["pausedReason"] = json!(format!(
                        "3 failed runs in a row{}",
                        if truth(&run, "error") {
                            format!(": {}", error_text(&run["error"])?)
                        } else {
                            String::new()
                        }
                    ));
                }
            } else {
                let message = match jsjson::nullish(run.get("error"), None) {
                    Some(error) => error_text(error)?,
                    None => "failed".into(),
                };
                run["error"] = json!(format!("{message} · 3 failed beats in a row"));
                end = true;
            }
        }
    }
    state["runs"][rid][n] = run;
    if end {
        completed(state, i, at);
    }
    Ok(())
}

impl Model {
    pub(super) fn transition(
        &mut self,
        op: &str,
        args: &[Value],
        now: i64,
        fault: Fault,
    ) -> Result<Value> {
        let id = text_of(arg(args, 0));
        let at = if matches!(op, "claimDue" | "expireDue") {
            time(arg(args, 0))?
        } else if op == "startRun" {
            time(arg(args, 1))?
        } else {
            now
        };
        let extra = arg(args, 1);
        if op == "finishRun" && jsjson::is_undefined(extra) {
            return error(
                "Cannot destructure property 'status' of 'undefined' as it is undefined.",
            );
        }
        if op == "finishRun" && extra.is_null() {
            return error("Cannot destructure property 'status' of 'object null' as it is null.");
        }
        if op == "finishRun"
            && !matches!(
                extra["status"].as_str(),
                Some("acted" | "quiet" | "failed" | "skipped-busy" | "ended")
            )
        {
            return error(format!(
                "Invalid run status: {}",
                show(get(extra, "status"))
            ));
        }
        if matches!(op, "pause" | "setRunTitle") {
            check::text(
                extra,
                if op == "pause" { "reason" } else { "title" },
                usize::MAX,
            )?;
        }
        if op == "setLastError"
            && !(extra.is_null()
                || jsjson::defined(Some(extra))
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()))
        {
            return error("lastError must be a message or null");
        }
        if op == "attachChat" {
            check::text(get(extra, "chatId"), "chatId", usize::MAX)?;
            if defined(extra, "worktreeId") {
                check::text(get(extra, "worktreeId"), "worktreeId", usize::MAX)?;
            }
        }
        if now - self.maintained_at < HOUR {
            if op == "claimDue" && !rows(&self.data).iter().any(|r| due(r, at)) {
                return Ok(json!([]));
            }
            if op == "expireDue" && !rows(&self.data).iter().any(|r| expired(r, at)) {
                return Ok(jsjson::undefined());
            }
        }
        self.transact(now, fault, |state, ids, tx| match op {
            "remove" => {
                let Some(i) = position(state, &id) else {
                    return Ok(json!(false));
                };
                rows_mut(state).remove(i);
                for key in ["runs", "queues", "seen", "rejections", "pullRequests"] {
                    delete(&mut state[key], &id);
                }
                state["removed"][&id] = json!(now);
                tx.changed = true;
                Ok(json!(true))
            }
            "claimDue" => {
                let mut claims = Vec::new();
                for i in 0..rows(state).len() {
                    if !due(&rows(state)[i], at) {
                        continue;
                    }
                    tx.changed = true;
                    let Some(next) = next_or_pause(state, i, at)? else {
                        continue;
                    };
                    let row = &rows(state)[i];
                    let rid = row["id"].as_str().unwrap().to_owned();
                    let scheduled = integer(&row["nextRunAt"]).unwrap();
                    let late = scheduled < at - 60_000;
                    let mut run = object([
                        ("id", json!(ids.next())),
                        ("routineId", json!(rid)),
                        ("scheduledFor", json!(scheduled)),
                        ("startedAt", json!(at)),
                        ("status", json!(if late { "missed" } else { "running" })),
                    ]);
                    if late {
                        run["endedAt"] = json!(at);
                    }
                    append(state, &rid, run.clone());
                    let row = &mut rows_mut(state)[i];
                    row["nextRunAt"] = json!(next);
                    row["updatedAt"] = json!(at);
                    if !late {
                        claims.push(object([("routine", row.clone()), ("run", run)]));
                    }
                }
                Ok(Value::Array(claims))
            }
            "startRun" => {
                let Some(i) = position(state, &id) else {
                    return Ok(Value::Null);
                };
                if truth(&rows(state)[i], "completedAt") {
                    return Ok(Value::Null);
                }
                let run = object([
                    ("id", json!(ids.next())),
                    ("routineId", json!(id)),
                    ("scheduledFor", json!(at)),
                    ("startedAt", json!(at)),
                    ("status", json!("running")),
                ]);
                append(state, &id, run.clone());
                tx.changed = true;
                Ok(object([("routine", rows(state)[i].clone()), ("run", run)]))
            }
            "finishRun" => {
                let Some((i, rid, n)) = run_position(state, &id) else {
                    return Ok(Value::Null);
                };
                if state["runs"][&rid][n]["status"] != "running" {
                    return Ok(Value::Null);
                }
                finish(
                    state,
                    (i, &rid, n),
                    extra["status"].as_str().unwrap(),
                    extra,
                    now,
                    true,
                )?;
                tx.changed = true;
                Ok(rows(state)[i].clone())
            }
            "attachChat" | "setRunTitle" => {
                let Some((_, rid, n)) = run_position(state, &id) else {
                    return Ok(json!(false));
                };
                let run = &mut state["runs"][rid][n];
                if op == "setRunTitle" {
                    run["title"] = extra.clone();
                } else {
                    run["chatId"] = extra["chatId"].clone();
                    if defined(extra, "worktreeId") {
                        run["worktreeId"] = extra["worktreeId"].clone();
                    }
                }
                tx.changed = true;
                Ok(json!(true))
            }
            "pause" => {
                let Some(i) = position(state, &id) else {
                    return Ok(Value::Null);
                };
                let row = &mut rows_mut(state)[i];
                if truth(row, "completedAt") {
                    return Ok(Value::Null);
                }
                row["enabled"] = json!(false);
                row["pausedReason"] = extra.clone();
                row["updatedAt"] = json!(now);
                tx.changed = true;
                Ok(row.clone())
            }
            "setLastError" => {
                let Some(i) = position(state, &id) else {
                    return Ok(Value::Null);
                };
                let row = &mut rows_mut(state)[i];
                let desired = if extra.is_null() { undef() } else { extra };
                if jsjson::strict_equals(get(row, "lastError"), desired) {
                    return Ok(row.clone());
                }
                if extra.is_null() {
                    delete(row, "lastError");
                } else {
                    row["lastError"] = extra.clone();
                }
                row["updatedAt"] = json!(now);
                tx.changed = true;
                Ok(row.clone())
            }
            "complete" => {
                let Some(i) = position(state, &id) else {
                    return Ok(Value::Null);
                };
                let first = !truth(&rows(state)[i], "completedAt");
                completed(state, i, now);
                let row = &mut rows_mut(state)[i];
                if first
                    && jsjson::defined(Some(extra))
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                {
                    row["completedReason"] = extra.clone();
                }
                if first {
                    tx.ended.push(object([
                        ("routine", row.clone()),
                        ("reason", get(row, "completedReason").clone()),
                    ]));
                }
                tx.changed = true;
                Ok(row.clone())
            }
            "expireDue" => {
                for i in 0..rows(state).len() {
                    if !expired(&rows(state)[i], at) {
                        continue;
                    }
                    completed(state, i, at);
                    rows_mut(state)[i]["completedReason"] = json!("expired");
                    tx.ended.push(object([
                        ("routine", rows(state)[i].clone()),
                        ("reason", json!("expired")),
                    ]));
                    tx.changed = true;
                }
                Ok(jsjson::undefined())
            }
            "recoverInterrupted" => {
                for i in 0..rows(state).len() {
                    let rid = rows(state)[i]["id"].as_str().unwrap().to_owned();
                    let count = state["runs"]
                        .get(&rid)
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    let mut cut = 0;
                    for n in 0..count {
                        if state["runs"][&rid][n]["status"] != "running" {
                            continue;
                        }
                        finish(
                            state,
                            (i, &rid, n),
                            "failed",
                            &json!({"error":"daemon restarted"}),
                            now,
                            cut == 0,
                        )?;
                        cut += 1;
                        tx.changed = true;
                    }
                    if due(&rows(state)[i], now) {
                        if let Some(next) = next_or_pause(state, i, now)? {
                            rows_mut(state)[i]["nextRunAt"] = json!(next);
                        }
                        tx.changed = true;
                    }
                }
                Ok(jsjson::undefined())
            }
            _ => unreachable!("closed transition set"),
        })
    }
}
