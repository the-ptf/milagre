use super::*;
impl Model {
    pub(super) fn create(&mut self, input: &Value, at: i64) -> Result<Candidate> {
        self.preparing()?;
        if !input.is_object() {
            return error("A Routine needs its settings");
        }
        if input["target"]["kind"] == "chat"
            && matches!(
                input["trigger"]["kind"].as_str(),
                Some("linear" | "webhook")
            )
        {
            return error("Only schedule triggers can target an existing Chat");
        }
        let name = check::text(get(input, "name"), "name", 80)?;
        if nonnull(input, "flow") {
            return refuse("flow Routine outside schedule checkpoint");
        }
        let prompt = check::text(get(input, "prompt"), "prompt", 4000)?;
        let trigger = check::trigger(get(input, "trigger"))?;
        let target = check::target(get(input, "target"))?;
        let creator = check::creator(get(input, "createdBy"))?;
        let mut routine = object([
            ("id", json!(self.ids.next())),
            ("name", name),
            ("prompt", prompt),
            ("trigger", trigger),
            ("target", target),
            ("enabled", json!(true)),
            ("createdBy", creator),
            ("runCount", json!(0)),
            ("createdAt", json!(at)),
            ("updatedAt", json!(at)),
        ]);
        for key in ["provider", "model", "permissionMode"] {
            if nonnull(input, key) {
                routine[key] = check::text(get(input, key), key, usize::MAX)?;
            }
        }
        if nonnull(input, "fallback") {
            routine["fallback"] = check::fallback(&input["fallback"])?;
        }
        if nonnull(input, "maxRuns") {
            routine["maxRuns"] = check::max_runs(&input["maxRuns"])?;
        }
        if nonnull(input, "signingHeader") {
            return error("Only a webhook Routine has a signature header");
        }
        if nonnull(input, "expiresAt") {
            routine["expiresAt"] = check::expires(&input["expiresAt"], at)?;
        } else if routine["target"]["kind"] == "chat" && !defined(&routine, "maxRuns") {
            routine["expiresAt"] = json!(future_time(&json!(at + 7 * DAY))?);
        }
        routine["nextRunAt"] = json!(check::next(&routine["trigger"], at)?);
        self.transact(at, move |state, _, tx| {
            rows_mut(state).push(routine.clone());
            tx.changed = true;
            Ok(routine)
        })
    }

    pub(super) fn upsert(&mut self, input: &Value, at: i64) -> Result<Candidate> {
        self.preparing()?;
        if !input.is_object() {
            return refuse("heartbeat settings outside typed domain");
        }
        if defined(input, "cron") == defined(input, "every") {
            return error("Give exactly one of cron or every");
        }
        if !input["timezone"].as_str().is_some_and(|s| !s.is_empty()) {
            return error("A Heartbeat needs a timezone");
        }
        for key in ["name", "prompt"] {
            if check::text(get(input, key), key, usize::MAX).is_err() {
                return error(format!("A Heartbeat needs a {key}"));
            }
        }
        if check::text(get(input, "chatId"), "chatId", usize::MAX).is_err()
            || check::creator(get(input, "createdBy")).is_err()
        {
            return refuse("heartbeat identity/creator outside typed domain");
        }
        if defined(input, "maxRuns") && check::max_runs(&input["maxRuns"]).is_err() {
            return refuse("heartbeat maxRuns outside typed domain");
        }
        for key in ["provider", "model", "permissionMode"] {
            if defined(input, key) && !input[key].is_string() {
                return refuse("heartbeat settings outside typed domain");
            }
        }
        let expression = if nonnull(input, "cron") {
            input["cron"].clone()
        } else {
            let every = get(input, "every");
            let Some(s) = jsjson::defined(Some(every)).and_then(Value::as_str) else {
                return error(format!(
                    "Invalid every: {} (use e.g. 15m or 2h)",
                    show(every)
                ));
            };
            let s = check::plain(s)?;
            if s.len() > crate::MAX_INPUT_BYTES {
                return refuse("every exceeds supported cron bounds");
            }
            json!(crate::every_to_cron(&s)
                .map_err(|e| Error::Node(jsjson::js_string(&e.to_string())))?)
        };
        if !expression.is_string() {
            return error("Invalid cron: expected a string");
        }
        let trigger = object([
            ("kind", json!("schedule")),
            ("cron", expression),
            ("timezone", input["timezone"].clone()),
        ]);
        let next = check::next(&trigger, at)?;
        self.transact(at, |state, ids, tx| {
            let existing = rows(state).iter().position(|r| {
                !truth(r, "completedAt")
                    && r["name"] == input["name"]
                    && r["target"]["chatId"] == input["chatId"]
            });
            let old = existing
                .map(|i| rows(state)[i].clone())
                .unwrap_or(Value::Null);
            let keep_end = !defined(input, "expiresIn")
                && !defined(input, "maxRuns")
                && existing.is_some()
                && (defined(&old, "expiresAt") || defined(&old, "maxRuns"));
            let cap = if keep_end {
                get(&old, "maxRuns").clone()
            } else {
                get(input, "maxRuns").clone()
            };
            let expires = if keep_end {
                get(&old, "expiresAt").clone()
            } else if defined(input, "expiresIn") {
                json!(future_time(&json!(
                    at + check::expires_in(&input["expiresIn"])?
                ))?)
            } else if jsjson::is_undefined(&cap) {
                json!(future_time(&json!(at + 7 * DAY))?)
            } else {
                jsjson::undefined()
            };
            let mut routine = object([
                (
                    "id",
                    if existing.is_some() {
                        old["id"].clone()
                    } else {
                        json!(ids.next())
                    },
                ),
                ("name", input["name"].clone()),
                ("prompt", input["prompt"].clone()),
                ("trigger", trigger),
                (
                    "target",
                    object([("kind", json!("chat")), ("chatId", input["chatId"].clone())]),
                ),
                ("enabled", json!(true)),
                ("createdBy", input["createdBy"].clone()),
                ("nextRunAt", json!(next)),
                (
                    "runCount",
                    if existing.is_some() {
                        old["runCount"].clone()
                    } else {
                        json!(0)
                    },
                ),
                (
                    "createdAt",
                    if existing.is_some() {
                        old["createdAt"].clone()
                    } else {
                        json!(at)
                    },
                ),
                ("updatedAt", json!(at)),
            ]);
            for key in ["provider", "model", "permissionMode"] {
                if defined(input, key) {
                    routine[key] = input[key].clone();
                }
            }
            if !jsjson::is_undefined(&cap) {
                routine["maxRuns"] = cap;
            }
            if !jsjson::is_undefined(&expires) {
                routine["expiresAt"] = expires;
            }
            if defined(&old, "lastRunAt") {
                routine["lastRunAt"] = old["lastRunAt"].clone();
            }
            if let Some(i) = existing {
                rows_mut(state)[i] = routine.clone();
            } else {
                rows_mut(state).push(routine.clone());
            }
            tx.changed = true;
            Ok(routine)
        })
    }

    pub(super) fn update(&mut self, id: &str, patch: &Value, at: i64) -> Result<Candidate> {
        self.preparing()?;
        self.transact(at, |state, _, tx| {
            let Some(i) = position(state, id) else {
                return error(format!("Routine not found: {id}"));
            };
            let routine = &rows(state)[i];
            if truth(routine, "completedAt") {
                return error(format!("Routine is completed: {id}"));
            }
            let Some(patch_map) = patch.as_object() else {
                return error("A Routine change must be an object");
            };
            const KEYS: &[&str] = &[
                "name",
                "prompt",
                "cron",
                "timezone",
                "maxRuns",
                "expiresAt",
                "enabled",
                "provider",
                "model",
                "permissionMode",
                "fallback",
                "trigger",
                "target",
                "signingHeader",
                "flowDraft",
                "publishFlow",
            ];
            for (key, _) in jsjson::js_entries(patch_map) {
                if !KEYS.contains(&key.as_str()) {
                    return error(format!("Cannot update {key}"));
                }
            }
            let mut next = routine.clone();
            for (key, max) in [("name", 80), ("prompt", 4000)] {
                if defined(patch, key) {
                    next[key] = check::text(&patch[key], key, max)?;
                }
            }
            if defined(patch, "enabled") {
                next["enabled"] = check::flag(&patch["enabled"], "enabled")?;
            }
            for key in ["provider", "model", "permissionMode"] {
                if patch.get(key) == Some(&Value::Null) {
                    delete(&mut next, key);
                } else if defined(patch, key) {
                    next[key] = check::text(&patch[key], key, usize::MAX)?;
                }
            }
            if patch.get("fallback") == Some(&Value::Null) {
                delete(&mut next, "fallback");
            } else if defined(patch, "fallback") {
                next["fallback"] = check::fallback(&patch["fallback"])?;
            }
            if patch.get("maxRuns") == Some(&Value::Null) {
                delete(&mut next, "maxRuns");
            } else if defined(patch, "maxRuns") {
                next["maxRuns"] = check::max_runs(&patch["maxRuns"])?;
            }
            if patch.get("expiresAt") == Some(&Value::Null) {
                delete(&mut next, "expiresAt");
            } else if defined(patch, "expiresAt") {
                next["expiresAt"] = check::expires(&patch["expiresAt"], at)?;
            }
            if defined(patch, "trigger") {
                if !patch["trigger"].is_object() {
                    return error("trigger must be an object");
                }
                if patch["trigger"]["kind"] != routine["trigger"]["kind"] {
                    return error("Can't change a Routine's trigger kind");
                }
                next["trigger"] = check::trigger(&patch["trigger"])?;
            }
            if defined(patch, "target") {
                if !patch["target"].is_object() {
                    return error("target must be an object");
                }
                if patch["target"]["kind"] != routine["target"]["kind"] {
                    return error("Can't change a Routine's target kind");
                }
                next["target"] = check::target(&patch["target"])?;
            }
            if defined(patch, "flowDraft") || defined(patch, "publishFlow") {
                return error("This Routine isn't a flow");
            }
            if patch.get("signingHeader") == Some(&Value::Null) {
                delete(&mut next, "signingHeader");
            } else if defined(patch, "signingHeader") {
                return error("Only a webhook Routine has a signature header");
            }
            for key in ["cron", "timezone"] {
                if defined(patch, key) {
                    next["trigger"][key] = check::text(&patch[key], key, usize::MAX)?;
                }
            }
            if next["target"]["kind"] == "chat"
                && !defined(&next, "maxRuns")
                && !defined(&next, "expiresAt")
            {
                return error("Heartbeats need an end: keep maxRuns or expiresAt");
            }
            let switched = patch["enabled"] == true && routine["enabled"] == false;
            if switched {
                if routine["pausedReason"] == NO_NEXT {
                    delete(&mut next, "lastError");
                }
                delete(&mut next, "pausedReason");
                delete(&mut next, "failedStreak");
            }
            if switched
                || ["trigger", "cron", "timezone"]
                    .into_iter()
                    .any(|k| defined(patch, k))
            {
                next["nextRunAt"] = json!(check::next(&next["trigger"], at)?);
            }
            next["updatedAt"] = json!(at);
            rows_mut(state)[i] = next.clone();
            tx.changed = true;
            Ok(next)
        })
    }
}
