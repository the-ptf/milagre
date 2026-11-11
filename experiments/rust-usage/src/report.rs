//! Pure token-usage:read aggregation, calendar bucketing, pricing and attribution. All inputs supplied by owner.
use crate::{pricing::price_of, util::*};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
const COUNTS: [&str; 6] = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "requests"];
const MONEY: [&str; 4] = ["input", "cacheRead", "cacheWrite", "output"];
pub fn empty_totals() -> Value {
    json!({"input":0,"cacheRead":0,"cacheWrite":0,"output":0,"reasoning":0,"requests":0,"costUsd":0,"cost":{"input":0,"cacheRead":0,"cacheWrite":0,"output":0},"cacheSavingsUsd":0,"unpricedTokens":0})
}
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
fn tokens(v: &Value) -> f64 {
    MONEY.iter().map(|k| n(&v[*k])).sum()
}
fn cost(row: &Value, price: Option<&Value>) -> Option<[f64; 5]> {
    price.map(|p| {
        [
            n(&row["input"]) * n(&p["input"]),
            n(&row["cacheRead"]) * n(&p["cacheRead"]),
            n(&row["cacheWrite"]) * n(&p["cacheWrite"]),
            n(&row["output"]) * n(&p["output"]),
            n(&row["cacheRead"]) * (n(&p["input"]) - n(&p["cacheRead"])).max(0.),
        ]
    })
}
fn tally(t: &mut Value, row: &Value, c: Option<[f64; 5]>) {
    for k in COUNTS {
        add(&mut t[k], n(&row[k]));
    }
    if let Some(c) = c {
        for (i, k) in MONEY.iter().enumerate() {
            add(&mut t["cost"][*k], c[i]);
        }
        add(&mut t["costUsd"], c[..4].iter().sum());
        add(&mut t["cacheSavingsUsd"], c[4]);
    } else {
        add(&mut t["unpricedTokens"], tokens(row));
    }
}
fn merge(t: &mut Value, from: &Value) {
    for k in COUNTS.into_iter().chain(["costUsd", "cacheSavingsUsd", "unpricedTokens"]) {
        add(&mut t[k], n(&from[k]));
    }
    for k in MONEY {
        add(&mut t["cost"][k], n(&from["cost"][k]));
    }
}
fn split(s: &mut Value, p: &str, t: f64, c: f64) {
    if s.get(p).is_none() {
        s[p] = json!({"tokens":0,"costUsd":0});
    }
    add(&mut s[p]["tokens"], t);
    add(&mut s[p]["costUsd"], c);
}
fn by_cost(a: &Value, b: &Value) -> std::cmp::Ordering {
    n(&b["totals"]["costUsd"]).total_cmp(&n(&a["totals"]["costUsd"])).then_with(|| tokens(&b["totals"]).total_cmp(&tokens(&a["totals"])))
}
fn base(s: &str) -> &str {
    s.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}
fn within(cwd: &str, folder: &str) -> bool {
    cwd == folder || cwd.strip_prefix(folder).is_some_and(|tail| tail.starts_with('/'))
}
fn is_link(s: &str) -> bool {
    s.strip_prefix("milagre-link:").is_some_and(|tail| {
        regex::Regex::new(r"(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
            .unwrap()
            .is_match(tail.rsplit('|').next().unwrap_or(tail))
    })
}
#[derive(Clone)]
struct Day {
    start: i64,
    key: String,
    hours: Vec<i64>,
}
fn calendar(tz: &jiff::tz::TimeZone, now: i64) -> Result<Vec<Day>, String> {
    let current = now.div_euclid(HOUR);
    let mut days: Vec<Day> = vec![];
    for hour in current - 91 * 24..=current {
        let stamp = jiff::Timestamp::from_millisecond(hour * HOUR).map_err(|e| e.to_string())?;
        let key = stamp.to_zoned(tz.clone()).strftime("%Y-%m-%d").to_string();
        if days.last().is_none_or(|d| d.key != key) {
            days.push(Day { start: hour * HOUR, key, hours: vec![] });
        }
        days.last_mut().unwrap().hours.push(hour);
    }
    Ok(days.into_iter().rev().take(90).collect::<Vec<_>>().into_iter().rev().collect())
}
fn hourly(hours: impl IntoIterator<Item = i64>) -> Vec<Day> {
    hours.into_iter().map(|h| Day { start: h * HOUR, key: iso(h * HOUR), hours: vec![h] }).collect()
}
fn chat_title(session: &Value, messages: &Value) -> String {
    for k in ["title", "generatedTitle"] {
        let s = text(&session[k]).trim();
        if !s.is_empty() {
            return s.into();
        }
    }
    let first = array(messages)
        .iter()
        .find(|m| m["session_id"] == session["id"] && m["role"] != "assistant" && !text(&m["body"]).trim().is_empty());
    let (line, images) = if truthy(&session["summary"]) {
        (text(&session["summary"]["titleLine"]).to_owned(), session["summary"]["titleImages"].as_u64())
    } else {
        (
            first.map(|m| text(&m["body"]).trim().split('\n').next().unwrap_or("").to_owned()).unwrap_or_default(),
            Some(first.map(|m| array(&m["images"]).len() as u64).unwrap_or(0)),
        )
    };
    let mut found = std::collections::HashSet::new();
    let images_re = regex::Regex::new(r"\[Image #([1-9]\d*)\]").unwrap();
    let replaced = images_re.replace_all(&line, |caps: &regex::Captures| {
        let index = caps[1].parse::<u64>().unwrap_or(u64::MAX);
        if images.is_none_or(|count| index <= count) {
            found.insert(index);
            String::new()
        } else {
            caps[0].to_owned()
        }
    });
    let mut line = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() && !found.is_empty() {
        line = if found.len() == 1 { "Image".into() } else { format!("{} images", found.len()) };
    }

    if line.is_empty() {
        return text(&session["agent_name"]).into();
    }
    if line.encode_utf16().count() > 60 {
        format!("{}…", utf16_prefix(&line, 57))
    } else {
        line
    }
}
struct Attribution {
    sessions: HashMap<String, Value>,
    folders: Vec<(String, Value)>,
    names: HashMap<String, Value>,
    worktree_root: String,
}
impl Attribution {
    fn new(projects: &Value, worktree_root: &str) -> Self {
        let mut a = Self { sessions: HashMap::new(), folders: vec![], names: HashMap::new(), worktree_root: worktree_root.into() };
        for p in array(projects) {
            let entry = json!({"path":p["path"],"name":p["name"]});
            let path = text(&p["path"]);
            if !is_link(path) {
                a.folders.push((path.into(), entry.clone()));
                a.names.entry(base(path).into()).or_insert(entry.clone());
            }
            let state = &p["state"];
            for w in values(&state["worktrees"]) {
                if let Some(path) = w["path"].as_str() {
                    if path != text(&p["path"]) {
                        a.folders.push((path.into(), entry.clone()));
                    }
                }
            }
            for s in values(&state["sessions"]) {
                if !s["id"].is_number() {
                    continue;
                }
                let chat = json!({"project":entry,"sessionId":s["id"],"title":chat_title(s,&state["messages"])});
                if let Some(path) = s["workspacePath"].as_str() {
                    a.folders.push((path.into(), entry.clone()));
                }
                for id in std::iter::once(&s["native_session_id"]).chain(values(&s["native_sessions"])) {
                    if let Some(id) = id.as_str().filter(|s| !s.is_empty()) {
                        a.sessions.insert(id.into(), chat.clone());
                    }
                }
            }
        }
        a.folders.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| is_link(text(&a.1["path"])).cmp(&is_link(text(&b.1["path"])))));
        a
    }
    fn project(&self, cwd: &str) -> Option<Value> {
        if cwd.is_empty() {
            return None;
        }
        for (folder, entry) in &self.folders {
            if within(cwd, folder) {
                return Some(entry.clone());
            }
        }
        if !self.worktree_root.is_empty() {
            if let Some(tail) = cwd.strip_prefix(&format!("{}/", self.worktree_root)) {
                return self.names.get(tail.split('/').next().unwrap_or("")).cloned();
            }
        }
        None
    }
}
fn worktree_title(cwd: &str, root: &str) -> String {
    if root.is_empty() || !cwd.starts_with(&format!("{root}/")) {
        return String::new();
    }
    let name = regex::Regex::new(r"-[a-z0-9]{4}$").unwrap().replace(base(cwd), "").replace('-', " ").trim().to_owned();
    let mut chars = name.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
        None => name,
    }
}
/// `input` has Node buildReport's fields plus explicit `home` and `defaultTimeZone` (UTC default).
/// No environment or user profile reads. Invalid `now`/out-of-range calendars return an error.
pub fn build_report(input: &Value) -> Result<Value, String> {
    let now = input["now"].as_i64().ok_or("now must be integer milliseconds")?;
    let range = match text(&input["range"]) {
        "24h" => "24h",
        "30d" => "30d",
        "90d" => "90d",
        _ => "7d",
    };
    static ZONES: std::sync::LazyLock<HashMap<String, Option<String>>> =
        std::sync::LazyLock::new(|| serde_json::from_str(include_str!("timezones.json")).expect("generated timezone map"));
    let resolve = |name: &str| ZONES.get(&name.to_lowercase()).and_then(Option::as_deref);
    let fallback = input["defaultTimeZone"].as_str().unwrap_or("UTC");
    let tz_name = resolve(text(&input["timeZone"])).or_else(|| resolve(fallback)).unwrap_or("UTC");
    let tz = jiff::tz::TimeZone::get(tz_name).map_err(|_| "unknown timezone in bundled database")?;
    let calendar = calendar(&tz, now)?;
    let mut days = None;
    let day_key = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
    let from = text(&input["days"]["from"]);
    let to = text(&input["days"]["to"]);
    let mut picked = vec![];
    if day_key.is_match(from) && day_key.is_match(to) {
        let (from, to) = if from <= to { (from, to) } else { (to, from) };
        picked = calendar.iter().filter(|d| d.key.as_str() >= from && d.key.as_str() <= to).cloned().collect();
        if !picked.is_empty() {
            days = Some(json!({"from":from,"to":to}));
        }
    }
    let (resolution, buckets) = if picked.len() == 1 {
        ("hour", hourly(picked[0].hours.clone()))
    } else if picked.len() > 1 {
        ("day", picked)
    } else if range == "24h" {
        let h = now.div_euclid(HOUR);
        ("hour", hourly(h - 23..=h))
    } else {
        let count = match range {
            "30d" => 30,
            "90d" => 90,
            _ => 7,
        };
        ("day", calendar[calendar.len() - count..].to_vec())
    };
    let bucket_of: HashMap<_, _> = buckets.iter().enumerate().flat_map(|(i, b)| b.hours.iter().map(move |h| (*h, i))).collect();
    let day_of: HashMap<_, _> = calendar.iter().enumerate().flat_map(|(i, b)| b.hours.iter().map(move |h| (*h, i))).collect();
    let index = Attribution::new(&input["projects"], text(&input["worktreeRoot"]));
    let mut totals = empty_totals();
    let mut series: Vec<Value> = buckets.iter().map(|b| json!({"start":b.start,"key":b.key,"providers":{}})).collect();
    let mut days90: Vec<Value> = calendar.iter().map(|d| json!({"key":d.key,"start":d.start,"tokens":0,"costUsd":0})).collect();
    let mut providers: IndexMap<String, Value> = IndexMap::new();
    let mut models: IndexMap<String, Value> = IndexMap::new();
    let mut groups: IndexMap<String, Value> = IndexMap::new();
    for row in array(&input["rows"]) {
        let Some(hour) = row["hour"].as_i64().or_else(|| row["hour"].as_f64().map(|n| n as i64)) else { continue };
        let at = bucket_of.get(&hour);
        let day = day_of.get(&hour);
        if at.is_none() && day.is_none() {
            continue;
        }
        let price = price_of(&input["prices"], text(&row["model"]));
        let cost = cost(row, price);
        let cost_usd = cost.map(|c| c[..4].iter().sum()).unwrap_or(0.);
        let token = tokens(row);
        if let Some(day) = day {
            add(&mut days90[*day]["tokens"], token);
            add(&mut days90[*day]["costUsd"], cost_usd);
        }
        let Some(at) = at else { continue };
        tally(&mut totals, row, cost);
        let provider = text(&row["provider"]);
        split(&mut series[*at]["providers"], provider, token, cost_usd);
        let p = providers.entry(provider.into()).or_insert_with(|| json!({"provider":provider,"totals":empty_totals()}));
        tally(&mut p["totals"], row, cost);
        let model = models
            .entry(format!("{provider}\t{}", text(&row["model"])))
            .or_insert_with(|| json!({"provider":provider,"model":row["model"],"priced":price.is_some(),"totals":empty_totals()}));
        tally(&mut model["totals"], row, cost);
        let chat = index.sessions.get(text(&row["session"]));
        let project = chat.map(|c| c["project"].clone()).or_else(|| index.project(text(&row["cwd"])));
        let group_key = project.as_ref().map(|p| format!("project:{}", text(&p["path"]))).unwrap_or("outside".into());
        let group=groups.entry(group_key).or_insert_with(||json!({"path":project.as_ref().map(|p|text(&p["path"])).unwrap_or(""),"name":project.as_ref().map(|p|text(&p["name"])).unwrap_or("Outside Milagre"),"milagre":project.is_some(),"totals":empty_totals(),"providers":{},"chats":{}}));
        tally(&mut group["totals"], row, cost);
        split(&mut group["providers"], provider, token, cost_usd);
        let key = if let Some(c) = chat {
            format!("chat:{}", c["sessionId"])
        } else if project.is_some() {
            format!("session:{}", text(&row["session"]))
        } else {
            format!("folder:{}", text(&row["cwd"]))
        };
        if group["chats"].get(&key).is_none() {
            let cwd = text(&row["cwd"]);
            let title = if let Some(c) = chat {
                [text(&c["title"]), text(&row["title"]), "Untitled Chat"].into_iter().find(|s| !s.is_empty()).unwrap().to_owned()
            } else if project.is_some() {
                let wt = worktree_title(cwd, text(&input["worktreeRoot"]));
                let title = [text(&row["title"]), wt.as_str(), "Untitled session"].into_iter().find(|s| !s.is_empty()).unwrap().to_owned();
                title
            } else if cwd.is_empty() {
                "Unknown folder".into()
            } else if cwd == text(&input["home"]) {
                "~".into()
            } else {
                let b = base(cwd);
                if b.is_empty() {
                    cwd.into()
                } else {
                    b.into()
                }
            };
            let mut entry = json!({"kind":if chat.is_some(){"chat"}else if project.is_none(){"folder"}else if truthy(&row["milagre"]){"archived"}else{"outside"},"title":title,"providers":[],"totals":empty_totals(),"lastAt":0});
            if let Some(c) = chat {
                entry["sessionId"] = c["sessionId"].clone();
            }
            if project.is_none() && !cwd.is_empty() {
                let home = text(&input["home"]);
                entry["detail"] = json!(if !home.is_empty() && cwd.starts_with(&format!("{home}/")) {
                    format!("~{}", &cwd[home.len()..])
                } else {
                    cwd.into()
                });
            }
            group["chats"][&key] = entry;
        }
        let entry = &mut group["chats"][&key];
        tally(&mut entry["totals"], row, cost);
        let list = entry["providers"].as_array_mut().unwrap();
        if !list.iter().any(|p| p == provider) {
            list.push(json!(provider));
        }
        entry["lastAt"] = json!(entry["lastAt"].as_i64().unwrap_or(0).max(now.min((hour + 1) * HOUR)));
    }
    let mut projects: Vec<_> = groups
        .into_values()
        .map(|mut group| {
            let mut chats: Vec<_> = group["chats"].as_object().unwrap().values().cloned().collect();
            chats.sort_by(by_cost);
            group["count"] = json!(chats.len());
            if chats.len() > 20 {
                let mut total = empty_totals();
                for c in &chats[20..] {
                    merge(&mut total, &c["totals"]);
                }
                group["more"] = json!({"count":chats.len()-20,"totals":total});
                chats.truncate(20);
            }
            group["chats"] = json!(chats);
            group
        })
        .collect();
    projects.sort_by(by_cost);
    let mut names = HashMap::new();
    for p in &projects {
        if p["milagre"] == true {
            *names.entry(text(&p["name"]).to_owned()).or_insert(0) += 1;
        }
    }
    for p in &mut projects {
        if p["milagre"] == true && names.get(text(&p["name"])).copied().unwrap_or(0) > 1 {
            let parent = text(&p["path"]).rsplit_once('/').map(|(p, _)| base(p)).unwrap_or("");
            p["name"] = json!(format!("{} · {parent}", text(&p["name"])));
        }
    }
    let mut result = json!({"range":range,"timeZone":tz_name,"resolution":resolution,"since":buckets[0].start,"until":(buckets.last().unwrap().hours.last().unwrap()+1)*HOUR,"generatedAt":now,"totals":totals,"series":series,"calendar":days90});
    if let Some(days) = days {
        result["days"] = days;
    }
    for (key, map) in [("providers", providers), ("models", models)] {
        let mut list: Vec<_> = map.into_values().collect();
        list.sort_by(by_cost);
        result[key] = json!(list);
    }
    if projects.len() > 25 {
        let mut total = empty_totals();
        for p in &projects[25..] {
            merge(&mut total, &p["totals"]);
        }
        result["moreProjects"] = json!({"count":projects.len()-25,"totals":total});
        projects.truncate(25);
    }
    result["projects"] = json!(projects);
    Ok(result)
}
