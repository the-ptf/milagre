use super::*;

pub fn whitespace(u: u16) -> bool {
    matches!(u, 9..=13 | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub fn text(v: &Value, field: &str, max: usize) -> Result<Value> {
    if jsjson::defined(Some(v))
        .and_then(Value::as_str)
        .is_some_and(|s| {
            jsjson::utf16_len(s) <= max && jsjson::to_utf16(s).into_iter().any(|u| !whitespace(u))
        })
    {
        return Ok(v.clone());
    }
    error(format!(
        "{field} must be a non-empty string{}",
        if max == usize::MAX {
            String::new()
        } else {
            format!(" of at most {max} characters")
        }
    ))
}
pub fn flag(v: &Value, field: &str) -> Result<Value> {
    if v.is_boolean() {
        Ok(v.clone())
    } else {
        error(format!("{field} must be true or false"))
    }
}
pub fn max_runs(v: &Value) -> Result<Value> {
    if integer(v).is_some_and(|n| (1..=1000).contains(&n)) {
        Ok(v.clone())
    } else {
        error("maxRuns must be a whole number from 1 to 1000")
    }
}
pub fn expires(v: &Value, at: i64) -> Result<Value> {
    if !v.is_number() {
        return error("expiresAt must be a time in milliseconds");
    }
    let value = future_time(v)?;
    if value > at + MAX_EXPIRY {
        return error("A Routine ends at most 30d from now");
    }
    Ok(v.clone())
}
pub fn expires_in(v: &Value) -> Result<i64> {
    let bad = || {
        Error::Node(format!(
            "Invalid expiresIn: {} (use e.g. 30m, 6h or 7d)",
            show(v)
        ))
    };
    let s = v.as_str().ok_or_else(bad)?;
    let Some((digits, unit)) = s
        .get(..s.len().saturating_sub(1))
        .zip(s.get(s.len().saturating_sub(1)..))
    else {
        return Err(bad());
    };
    let multiple = match unit {
        "m" => 60_000.,
        "h" => 3_600_000.,
        "d" => 86_400_000.,
        _ => return Err(bad()),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let n = digits.parse::<f64>().unwrap_or(f64::INFINITY);
    if n < 1. {
        return Err(bad());
    }
    if n * multiple > MAX_EXPIRY as f64 {
        return error(format!(
            "expiresIn {} is too long: a Heartbeat runs for at most 30d",
            show(v)
        ));
    }
    Ok((n * multiple) as i64)
}
pub fn plain(s: &str) -> Result<String> {
    String::from_utf16(&jsjson::to_utf16(s))
        .map_err(|_| Error::Refused("cron strings containing unpaired UTF-16 surrogates".into()))
}
pub fn schedule_domain(trigger: &Value) -> Result<()> {
    for (key, cap) in [
        ("cron", crate::MAX_INPUT_BYTES),
        ("timezone", crate::MAX_ZONE_BYTES),
    ] {
        if let Some(s) = trigger[key].as_str() {
            let s = plain(s)?;
            if s.len() > cap {
                return refuse(format!("{key} exceeds supported cron bounds"));
            }
            if key == "timezone" && s.to_ascii_lowercase().starts_with("systemv/") {
                return refuse("ICU-only SystemV timezone");
            }
        }
    }
    Ok(())
}
pub fn next(trigger: &Value, at: i64) -> Result<i64> {
    schedule_domain(trigger)?;
    let cron = plain(
        trigger["cron"]
            .as_str()
            .ok_or_else(|| Error::Refused("non-string cron".into()))?,
    )?;
    let zone = plain(
        trigger["timezone"]
            .as_str()
            .ok_or_else(|| Error::Refused("non-string timezone".into()))?,
    )?;
    crate::next_run(&cron, &zone, at).map_err(|e| match e {
        crate::Error::Bounds(_) | crate::Error::Timestamp | crate::Error::TimeZoneData => {
            Error::Refused(e.to_string())
        }
        _ => Error::Node(jsjson::js_string(&e.to_string())),
    })
}
pub fn trigger(v: &Value) -> Result<Value> {
    if !v.is_object() {
        return error("A Routine needs a trigger");
    }
    match v["kind"].as_str() {
        Some("schedule") => {
            let t = object([
                ("kind", json!("schedule")),
                ("cron", text(get(v, "cron"), "cron", usize::MAX)?),
                (
                    "timezone",
                    text(get(v, "timezone"), "timezone", usize::MAX)?,
                ),
            ]);
            schedule_domain(&t)?;
            Ok(t)
        }
        Some("linear" | "webhook" | "pull-request") => refuse("non-schedule Routine"),
        _ => error("trigger kind must be schedule, linear, webhook or pull-request"),
    }
}
pub fn target(v: &Value) -> Result<Value> {
    if !v.is_object() {
        return error("A Routine needs a target");
    }
    match v["kind"].as_str() {
        Some("chat") => Ok(object([
            ("kind", json!("chat")),
            ("chatId", text(get(v, "chatId"), "chatId", usize::MAX)?),
        ])),
        Some("new-chat") => {
            if !matches!(v["workspace"].as_str(), Some("worktree" | "project")) {
                return error("target workspace must be worktree or project");
            }
            Ok(object([
                ("kind", json!("new-chat")),
                (
                    "projectPath",
                    text(get(v, "projectPath"), "projectPath", usize::MAX)?,
                ),
                ("workspace", v["workspace"].clone()),
            ]))
        }
        _ => error("target kind must be chat or new-chat"),
    }
}
pub fn creator(v: &Value) -> Result<Value> {
    if v["kind"] == "user" {
        return Ok(json!({"kind":"user"}));
    }
    if v["kind"] == "agent" {
        return Ok(object([
            ("kind", json!("agent")),
            (
                "chatId",
                text(get(v, "chatId"), "createdBy chatId", usize::MAX)?,
            ),
        ]));
    }
    error("createdBy must be the user or an agent Chat")
}
pub fn fallback(v: &Value) -> Result<Value> {
    if !v.is_object() {
        return error("fallback must be an object with a provider and a model");
    }
    let mut out = object([
        (
            "provider",
            text(get(v, "provider"), "fallback provider", 40)?,
        ),
        ("model", text(get(v, "model"), "fallback model", 200)?),
    ]);
    if nonnull(v, "effort") {
        out["effort"] = text(get(v, "effort"), "fallback effort", 40)?;
    }
    Ok(out)
}

pub fn state(v: &Value) -> Result<()> {
    limits::values(&[v])?;
    let rows = v["routines"]
        .as_array()
        .ok_or_else(|| Error::Refused("snapshot routines shape".into()))?;
    let runs = v["runs"]
        .as_object()
        .ok_or_else(|| Error::Refused("snapshot runs shape".into()))?;
    if rows.len() > limits::ROUTINES {
        return refuse("more than 64 Routines");
    }
    let removed = v["removed"]
        .as_object()
        .ok_or_else(|| Error::Refused("snapshot removed shape".into()))?;
    if removed.len() > limits::TOMBSTONES {
        return refuse("more than 4096 tombstones");
    }
    for (id, at) in removed {
        safe_id(id)?;
        time(at)?;
    }
    for name in ["queues", "seen", "rejections", "linear", "pullRequests"] {
        if !v[name].as_object().is_some_and(|o| o.is_empty()) {
            return refuse("event state outside schedule checkpoint");
        }
    }
    let mut ids = HashSet::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Refused("invalid Routine identity".into()))?;
        safe_id(id)?;
        if !ids.insert(id) {
            return refuse("duplicate Routine identity");
        }
        if !row["name"].is_string() || !row["prompt"].is_string() || !row["enabled"].is_boolean() {
            return refuse("invalid Routine shape");
        }
        if row.get("flow").is_some() {
            return refuse("flow Routine outside schedule checkpoint");
        }
        if row["trigger"]["kind"] != "schedule" {
            return refuse("non-schedule Routine");
        }
        if !row["trigger"]["cron"].is_string() || !row["trigger"]["timezone"].is_string() {
            return refuse("invalid schedule shape");
        }
        schedule_domain(&row["trigger"])?;
        match row["target"]["kind"].as_str() {
            Some("chat") if row["target"]["chatId"].is_string() => (),
            Some("new-chat") if row["target"]["projectPath"].is_string() => (),
            _ => return refuse("invalid target shape"),
        }
        for key in ["createdAt", "updatedAt"] {
            time(get(row, key))?;
        }
        if defined(row, "expiresAt") {
            future_time(get(row, "expiresAt"))?;
        }
        for key in ["completedAt", "lastRunAt"] {
            if defined(row, key) {
                time(get(row, key))?;
            }
        }
        if nonnull(row, "nextRunAt") {
            future_time(get(row, "nextRunAt"))?;
        }
        for key in ["runCount", "maxRuns", "failedStreak"] {
            if (key == "runCount" || defined(row, key))
                && !get(row, key)
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.)
            {
                return refuse("invalid bounded Routine counter");
            }
        }
    }
    let mut run_ids = HashSet::new();
    let mut count = 0;
    for (rid, list) in runs {
        safe_id(rid)?;
        let list = list
            .as_array()
            .ok_or_else(|| Error::Refused("invalid Runs list".into()))?;
        count += list.len();
        if count > limits::RUNS {
            return refuse("more than 4096 Runs");
        }
        for run in list {
            let id = run["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::Refused("invalid Run identity".into()))?;
            safe_id(id)?;
            if !run_ids.insert(id) {
                return refuse("duplicate Run identity");
            }
            if run["routineId"].as_str() != Some(rid)
                || !matches!(
                    run["status"].as_str(),
                    Some(
                        "running"
                            | "acted"
                            | "quiet"
                            | "failed"
                            | "skipped-busy"
                            | "missed"
                            | "ended"
                    )
                )
            {
                return refuse("invalid Run shape");
            }
            if run.get("event").is_some()
                || run.get("flow").is_some()
                || run.get("rejected").is_some()
            {
                return refuse("event or flow Run outside schedule checkpoint");
            }
            for key in ["scheduledFor", "startedAt", "endedAt"] {
                if defined(run, key) {
                    time(get(run, key))?;
                }
            }
        }
    }
    Ok(())
}
pub fn safe_id(id: &str) -> Result<()> {
    if matches!(
        id,
        "__proto__"
            | "constructor"
            | "prototype"
            | "__defineGetter__"
            | "__defineSetter__"
            | "hasOwnProperty"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toString"
            | "valueOf"
            | "toLocaleString"
    ) {
        refuse("prototype-sensitive identity outside checkpoint")
    } else {
        Ok(())
    }
}
