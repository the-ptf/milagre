use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
pub const HOUR: i64 = 3_600_000;
pub fn date(v: &Value) -> Option<i64> {
    date_str(v.as_str()?)
}
pub fn date_str(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| DateTime::parse_from_rfc2822(s).map(|d| d.timestamp_millis()).ok())
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0).map(|d| d.and_utc().timestamp_millis()))
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok().map(|d| d.and_utc().timestamp_millis()))
}
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).expect("timestamp in calendar range").to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn positive(v: &Value) -> f64 {
    v.as_f64().filter(|n| n.is_finite() && *n > 0.).unwrap_or(0.)
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "".into(),
        _ => v.to_string(),
    }
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn values(v: &Value) -> Vec<&Value> {
    match v {
        Value::Object(m) => m.values().collect(),
        Value::Array(a) => a.iter().collect(),
        _ => vec![],
    }
}
pub fn add(v: &mut Value, n: f64) {
    *v = json!(v.as_f64().unwrap_or(0.) + n);
}
pub fn utf16_prefix(s: &str, count: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(count).collect::<Vec<_>>())
}
pub fn live(w: &Value, now: i64) -> bool {
    !truthy(&w["resetsAt"]) || date(&w["resetsAt"]).is_some_and(|ms| ms > now)
}
