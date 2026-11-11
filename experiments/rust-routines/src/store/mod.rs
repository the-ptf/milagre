//! Private schedule-only state fixture. No files, clock, thread, host or dispatch.
//! JSON values are encoded once through the pinned owner's pure codec copy.
#![allow(dead_code)]
mod check;
#[cfg(unix)]
pub mod copied;
pub mod jsjson;
pub mod limits;
mod mutations;
mod preparation;
#[cfg(test)]
mod preparation_tests;
#[cfg(test)]
mod tests;
mod transitions;

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
const DAY: i64 = 86_400_000;
const MAX_EXPIRY: i64 = 30 * DAY;
const HOUR: i64 = 3_600_000;
const NO_NEXT: &str = "schedule has no next run";
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Node(String),
    Refused(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Node(s) | Self::Refused(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for Error {}
fn error<T>(s: impl Into<String>) -> Result<T> {
    Err(Error::Node(s.into()))
}
fn refuse<T>(s: impl Into<String>) -> Result<T> {
    Err(Error::Refused(s.into()))
}
fn object<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Object(items.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}
fn undef() -> &'static Value {
    static UNDEFINED: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    UNDEFINED.get_or_init(jsjson::undefined)
}
fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or_else(|| undef())
}
fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or_else(|| undef())
}
fn defined(v: &Value, key: &str) -> bool {
    jsjson::defined(v.get(key)).is_some()
}
fn nonnull(v: &Value, key: &str) -> bool {
    jsjson::nullish(v.get(key), None).is_some()
}
fn truth(v: &Value, key: &str) -> bool {
    jsjson::truthy(v.get(key))
}
fn show(v: &Value) -> String {
    if jsjson::is_undefined(v) {
        "undefined".into()
    } else {
        jsjson::js_string(&jsjson::to_string(v))
    }
}
fn text_of(v: &Value) -> String {
    jsjson::property_key(Some(v))
}
fn integer(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.)
        .map(|n| n as i64)
}
pub fn time(v: &Value) -> Result<i64> {
    integer(v)
        .filter(|at| (crate::MIN_AFTER_MS..=crate::MAX_AFTER_MS).contains(at))
        .ok_or_else(|| Error::Refused("timestamp outside bounded integer-ms domain".into()))
}
fn future_time(v: &Value) -> Result<i64> {
    integer(v)
        .filter(|at| (crate::MIN_AFTER_MS..=253_402_300_799_999).contains(at))
        .ok_or_else(|| {
            Error::Refused("stored future timestamp outside bounded integer-ms domain".into())
        })
}
fn delete(v: &mut Value, key: &str) {
    v.as_object_mut()
        .expect("private object invariant")
        .shift_remove(key);
}
fn rows(v: &Value) -> &Vec<Value> {
    v["routines"].as_array().expect("validated rows")
}
fn rows_mut(v: &mut Value) -> &mut Vec<Value> {
    v["routines"].as_array_mut().expect("validated rows")
}
fn position(v: &Value, id: &str) -> Option<usize> {
    rows(v).iter().position(|r| r["id"] == id)
}
fn run_position(v: &Value, run_id: &str) -> Option<(usize, String, usize)> {
    for (rid, list) in v["runs"].as_object()? {
        if let Some(i) = list.as_array()?.iter().position(|r| r["id"] == run_id) {
            return position(v, rid).map(|r| (r, rid.clone(), i));
        }
    }
    None
}
fn empty() -> Value {
    object([
        ("version", json!(1)),
        ("routines", json!([])),
        ("runs", json!({})),
        ("queues", json!({})),
        ("seen", json!({})),
        ("rejections", json!({})),
        ("linear", json!({})),
        ("removed", json!({})),
        ("pullRequests", json!({})),
    ])
}
#[derive(Clone, Copy, Default)]
pub enum Fault {
    #[default]
    None,
    Write,
    Rename,
}
impl Fault {
    fn check(self) -> Result<()> {
        match self {
            Self::None => Ok(()),
            Self::Write => error("EIO: injected writeFileSync failure"),
            Self::Rename => error("EIO: injected renameSync failure"),
        }
    }
}
#[derive(Default)]
struct Ids {
    calls: u64,
    forced: Option<String>,
}
impl Ids {
    fn next(&mut self) -> String {
        self.calls += 1;
        self.forced
            .take()
            .unwrap_or_else(|| format!("id{}", self.calls))
    }
}
#[derive(Default)]
struct Tx {
    changed: bool,
    ended: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    origin: u64,
    generation: u64,
}
enum Phase {
    Ready,
    Preparing(Stamp),
    Pending(Box<Candidate>),
}
// Never leaves its originating Model. A stamp identifies it but carries no result or proof.
struct Candidate {
    stamp: Stamp,
    publication: Option<Publication>,
    maintained_at: i64,
    result: Value,
    effects: Vec<Value>,
}
struct Publication {
    data: Value,
    image: String,
    positions: HashMap<String, usize>,
    run_index: HashMap<String, (String, usize)>,
    tracked: HashSet<String>,
    saves: u64,
}

pub struct Model {
    origin: u64,
    generation: u64,
    phase: Phase,
    data: Value,
    maintained_at: i64,
    pub published: Option<String>,
    ids: Ids,
    pub saves: u64,
    pub effects: Vec<Value>,
    tracked: HashSet<String>,
    positions: HashMap<String, usize>,
    run_index: HashMap<String, (String, usize)>,
}
impl Model {
    pub fn open(seed: Option<String>, now: i64) -> Result<Self> {
        let origin = preparation::identity()?;
        time(&json!(now))?;
        let mut data = match &seed {
            None => empty(),
            Some(seed) => {
                let mut parsed = limits::parse(seed)?;
                if !parsed.is_object()
                    || !parsed["routines"].is_array()
                    || !parsed["runs"].is_object()
                {
                    return refuse("snapshot shape is not supported");
                }
                if defined(&parsed, "version") && integer(&parsed["version"]) != Some(1) {
                    return refuse("snapshot version is not supported");
                }
                let mut out = empty();
                for key in [
                    "routines",
                    "runs",
                    "queues",
                    "seen",
                    "rejections",
                    "linear",
                    "removed",
                    "pullRequests",
                ] {
                    if let Some(v) = parsed.as_object_mut().unwrap().shift_remove(key) {
                        out[key] = v;
                    }
                }
                out
            }
        };
        check::state(&data)?;
        limits::image(&data)?;
        let mut model = Self {
            origin,
            generation: 0,
            phase: Phase::Ready,
            data: empty(),
            maintained_at: now,
            published: seed,
            ids: Ids::default(),
            saves: 0,
            effects: Vec::new(),
            tracked: HashSet::new(),
            positions: HashMap::new(),
            run_index: HashMap::new(),
        };
        model.track(&data);
        let before = chat_runs(&data);
        let purged = transitions::maintain(&mut data, now);
        check::state(&data)?;
        model.data = data;
        model.reindex();
        if !purged.is_empty() {
            model.effects.push(effect("purged", json!(purged)));
        }
        let dropped = dropped(&model.data, before);
        if !dropped.is_empty() {
            model.effects.push(effect("dropped", Value::Array(dropped)));
        }
        limits::values(&[&model.data, &Value::Array(model.effects.clone())])?;
        Ok(model)
    }
    pub fn reload(&mut self, now: i64) -> Result<Value> {
        self.ready()?;
        // Build before replacing; an invalid import never empties an existing model.
        let mut next = Self::open(self.published.clone(), now)?;
        next.tracked.extend(self.tracked.iter().cloned());
        next.ids = std::mem::take(&mut self.ids);
        next.saves = self.saves;
        *self = next;
        Ok(Value::Null)
    }
    fn indexes(data: &Value) -> (HashMap<String, usize>, HashMap<String, (String, usize)>) {
        let positions = rows(data)
            .iter()
            .enumerate()
            .map(|(i, r)| (r["id"].as_str().unwrap().to_owned(), i))
            .collect();
        let run_index = data["runs"]
            .as_object()
            .unwrap()
            .iter()
            .flat_map(|(rid, runs)| {
                runs.as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(move |(i, r)| (r["id"].as_str().unwrap().to_owned(), (rid.clone(), i)))
            })
            .collect();
        (positions, run_index)
    }
    fn reindex(&mut self) {
        (self.positions, self.run_index) = Self::indexes(&self.data);
    }
    fn track(&mut self, data: &Value) {
        self.tracked.extend(
            rows(data)
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_owned()),
        );
        self.tracked
            .extend(data["removed"].as_object().unwrap().keys().cloned());
        self.tracked
            .extend(data["runs"].as_object().unwrap().keys().cloned());
    }
    fn transact(
        &mut self,
        now: i64,
        change: impl FnOnce(&mut Value, &mut Ids, &mut Tx) -> Result<Value>,
    ) -> Result<Candidate> {
        let stamp = self.preparing()?;
        check::state(&self.data)?; // Before candidate cloning, including unknown metadata.
        let mut draft = self.data.clone();
        let mut tx = Tx::default();
        let result = change(&mut draft, &mut self.ids, &mut tx)?;
        let upkeep = now - self.maintained_at >= HOUR;
        let purged = if upkeep {
            transitions::maintain(&mut draft, now)
        } else {
            Vec::new()
        };
        if !purged.is_empty() {
            tx.changed = true;
        }
        check::state(&draft)?;
        let mut effects = Vec::new();
        if !purged.is_empty() {
            effects.push(effect("purged", json!(purged)));
        }
        if tx.changed {
            let dropped = dropped(&draft, chat_runs(&self.data));
            if !dropped.is_empty() {
                effects.push(effect("dropped", json!(dropped)));
            }
        }
        if !tx.ended.is_empty() {
            effects.push(effect("ended", json!(tx.ended)));
        }
        limits::values(&[&draft, &result, &Value::Array(effects.clone())])?;
        let image = if tx.changed {
            Some(limits::image(&draft)?)
        } else {
            None
        };
        let publication = image
            .map(|image| {
                let (positions, run_index) = Self::indexes(&draft);
                let mut tracked = self.tracked.clone();
                tracked.extend(
                    rows(&draft)
                        .iter()
                        .map(|r| r["id"].as_str().unwrap().to_owned()),
                );
                tracked.extend(draft["removed"].as_object().unwrap().keys().cloned());
                tracked.extend(draft["runs"].as_object().unwrap().keys().cloned());
                let saves = self
                    .saves
                    .checked_add(1)
                    .ok_or_else(|| Error::Refused("publication counter exhausted".into()))?;
                Ok(Publication {
                    data: draft,
                    image,
                    positions,
                    run_index,
                    tracked,
                    saves,
                })
            })
            .transpose()?;
        Ok(Candidate {
            stamp,
            publication,
            maintained_at: if upkeep { now } else { self.maintained_at },
            result,
            effects,
        })
    }
    pub fn execute(&mut self, op: &str, args: &[Value], now: i64, fault: Fault) -> Result<Value> {
        if op == "reload" {
            self.ready()?;
            self.effects.clear();
            time(&json!(now))?;
            limits::values(&args.iter().collect::<Vec<_>>())?;
            return self.reload(now);
        }
        let stamp = self.prepare(op, args, now)?;
        if self.pending_image(stamp)?.is_some() {
            if let Err(error) = fault.check() {
                self.discard(stamp)?;
                return Err(error);
            }
        }
        self.install(stamp)
    }
    fn dispatch(&mut self, op: &str, args: &[Value], now: i64) -> Result<Candidate> {
        time(&json!(now))?;
        limits::values(&args.iter().collect::<Vec<_>>())?;
        if matches!(
            op,
            "get"
                | "runs"
                | "getRun"
                | "hasRun"
                | "hasPending"
                | "wasRemoved"
                | "update"
                | "remove"
                | "startRun"
                | "finishRun"
                | "complete"
                | "pause"
                | "setLastError"
                | "attachChat"
                | "setRunTitle"
        ) {
            let id = jsjson::defined(Some(arg(args, 0)))
                .and_then(Value::as_str)
                .ok_or_else(|| Error::Refused("Routine/Run id must be a string".into()))?;
            check::safe_id(id)?;
        }
        match op {
            "list" => self.no_write(self.list()),
            "get" => self.no_write(self.get(&text_of(arg(args, 0)))),
            "runs" => self.no_write(self.runs(&text_of(arg(args, 0)))),
            "getRun" => self.no_write(self.get_run(&text_of(arg(args, 0)))),
            "hasRun" => self.no_write(json!(self.run_index.contains_key(&text_of(arg(args, 0))))),
            "runningCount" => self.no_write(json!(self.running_count())),
            "hasPending" => self.no_write(json!(self.pending(&text_of(arg(args, 0))))),
            "wasRemoved" => self.no_write(json!(self.data["removed"]
                .get(text_of(arg(args, 0)))
                .is_some())),
            "create" => self.create(arg(args, 0), now),
            "upsertHeartbeat" => self.upsert(arg(args, 0), now),
            "update" => self.update(&text_of(arg(args, 0)), arg(args, 1), now),
            "remove" | "claimDue" | "startRun" | "finishRun" | "expireDue" | "complete"
            | "recoverInterrupted" | "pause" | "setLastError" | "attachChat" | "setRunTitle" => {
                self.transition(op, args, now)
            }
            _ => refuse("method outside schedule checkpoint"),
        }
    }
    fn get(&self, id: &str) -> Value {
        self.positions
            .get(id)
            .map(|i| self.data["routines"][*i].clone())
            .unwrap_or(Value::Null)
    }
    fn list(&self) -> Value {
        let mut list = rows(&self.data)
            .iter()
            .filter(|r| !truth(r, "completedAt"))
            .collect::<Vec<_>>();
        list.sort_by(|a, b| {
            b["createdAt"]
                .as_f64()
                .unwrap()
                .partial_cmp(&a["createdAt"].as_f64().unwrap())
                .expect("validated finite timestamps")
        });
        Value::Array(list.into_iter().cloned().collect())
    }
    fn runs(&self, id: &str) -> Value {
        Value::Array(
            self.data["runs"]
                .get(id)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .rev()
                .cloned()
                .collect(),
        )
    }
    fn get_run(&self, id: &str) -> Value {
        let Some((rid, i)) = self.run_index.get(id) else {
            return Value::Null;
        };
        let routine = self.get(rid);
        if routine.is_null() {
            return Value::Null;
        }
        object([
            ("routine", routine),
            ("run", self.data["runs"][rid][*i].clone()),
        ])
    }
    fn running_count(&self) -> usize {
        self.data["runs"]
            .as_object()
            .unwrap()
            .values()
            .flat_map(|v| v.as_array().unwrap())
            .filter(|r| r["status"] == "running")
            .count()
    }
    fn pending(&self, id: &str) -> bool {
        self.data["runs"]
            .get(id)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|r| r["status"] == "running"))
    }
    pub fn observe(&self, result: Result<Value>) -> Value {
        let mut ids = self.tracked.iter().collect::<Vec<_>>();
        ids.sort_by_key(|id| jsjson::to_utf16(id));
        let views = ids
            .into_iter()
            .map(|id| {
                object([
                    ("id", json!(id)),
                    ("routine", self.get(id)),
                    ("runs", self.runs(id)),
                    ("pending", json!(self.pending(id))),
                    ("removed", json!(self.data["removed"].get(id).is_some())),
                ])
            })
            .collect();
        object([
            ("result", outcome(result)),
            (
                "file",
                self.published
                    .as_ref()
                    .map(|s| Value::String(jsjson::js_string(s)))
                    .unwrap_or(Value::Null),
            ),
            ("list", self.list()),
            ("views", Value::Array(views)),
            ("runningCount", json!(self.running_count())),
            ("effects", json!(self.effects)),
            ("saves", json!(self.saves)),
            ("idCalls", json!(self.ids.calls)),
        ])
    }
}
pub fn outcome(result: Result<Value>) -> Value {
    match result {
        Ok(v) if jsjson::is_undefined(&v) => {
            object([("ok", Value::Null), ("undefined", json!(true))])
        }
        Ok(v) => object([("ok", v)]),
        Err(Error::Node(s)) => object([("error", Value::String(s))]),
        Err(Error::Refused(s)) => object([("refused", Value::String(s))]),
    }
}
fn effect(kind: &str, value: Value) -> Value {
    object([("kind", json!(kind)), ("value", value)])
}
fn chat_runs(data: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for (rid, runs) in jsjson::js_entries(data["runs"].as_object().unwrap()) {
        for run in runs.as_array().unwrap() {
            if run["chatId"].as_str().is_some_and(|s| !s.is_empty()) {
                out.push(object([
                    ("routineId", json!(rid)),
                    ("runId", run["id"].clone()),
                    ("chatId", run["chatId"].clone()),
                ]));
            }
        }
    }
    out
}
fn dropped(data: &Value, before: Vec<Value>) -> Vec<Value> {
    let ids = data["runs"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|r| r.as_array().unwrap())
        .filter_map(|r| r["id"].as_str())
        .collect::<HashSet<_>>();
    before
        .into_iter()
        .filter(|r| !ids.contains(r["runId"].as_str().unwrap()))
        .collect()
}
