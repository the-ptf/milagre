//! `toDetail` and helper semantics from Milagre's pull-request-review.cjs.
use serde_json::{json, Value};
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn login(v: &Value) -> &str {
    let s = text(&v["login"]);
    if s.is_empty() {
        "ghost"
    } else {
        s
    }
}
fn nodes(v: &Value) -> &[Value] {
    v["nodes"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn number(v: &Value) -> Value {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.),
        Value::String(s) => s.trim().parse().unwrap_or(0.),
        Value::Bool(true) => 1.,
        _ => 0.,
    };
    if !n.is_finite() {
        json!(0)
    } else if n.fract() == 0. && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn truth(v: &Value) -> bool {
    milagre_owner_store::jsjson::truthy(Some(v))
}
pub(crate) fn file(v: &Value) -> Value {
    json!({"path":text(&v["path"]),"additions":number(&v["additions"]),"deletions":number(&v["deletions"]),
        "status":match text(&v["changeType"]) {"ADDED"|"COPIED"=>"added","DELETED"=>"deleted","RENAMED"=>"renamed",_=>"modified"}})
}
fn comment(v: &Value) -> Value {
    let mut out = json!({"id":text(&v["id"]),"author":login(&v["author"]),"body":text(&v["body"]),"createdAt":text(&v["createdAt"])});
    if v["pullRequestReview"]["state"] == "PENDING" {
        out["pending"] = json!(true);
    }
    out
}
fn failed(s: &str) -> bool {
    matches!(
        s,
        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "ERROR"
    )
}
fn check(v: &Value) -> Value {
    let status = v["kind"] == "StatusContext";
    let outcome = if status {
        let s = text(&v["state"]);
        if failed(s) {
            "fail"
        } else if s == "SUCCESS" {
            "pass"
        } else {
            "running"
        }
    } else if v["status"] != "COMPLETED" {
        "running"
    } else {
        match text(&v["conclusion"]) {
            s if failed(s) => "fail",
            "SKIPPED" => "skipped",
            "NEUTRAL" | "STALE" => "neutral",
            _ => "pass",
        }
    };
    let mut out = json!({"name":text(&v[if status{"context"}else{"name"}]),"outcome":outcome});
    if !status {
        let flow = text(&v["checkSuite"]["workflowRun"]["workflow"]["name"]);
        if !flow.is_empty() {
            out["workflow"] = json!(flow);
        }
    }
    let url = &v[if status { "targetUrl" } else { "detailsUrl" }];
    if truth(url) {
        out["url"] = url.clone();
    }
    out
}
pub(crate) fn detail(pr: &Value, files: Vec<Value>) -> Value {
    let mut checks = nodes(&pr["checks"])
        .first()
        .map(|v| nodes(&v["commit"]["statusCheckRollup"]["contexts"]))
        .unwrap_or(&[])
        .iter()
        .filter(|v| truth(v))
        .map(check)
        .filter(|v| !text(&v["name"]).is_empty())
        .collect::<Vec<_>>();
    checks.sort_by_key(|v| match text(&v["outcome"]) {
        "fail" => 0,
        "running" => 1,
        "pass" => 2,
        "neutral" => 3,
        _ => 4,
    });
    let mut reviewers: Vec<Value> = Vec::new();
    let mut put = |v: Value| {
        if let Some(old) = reviewers.iter_mut().find(|old| old["login"] == v["login"]) {
            *old = v;
        } else {
            reviewers.push(v);
        }
    };
    for v in nodes(&pr["latestReviews"]) {
        let state = text(&v["state"]);
        if !matches!(
            state,
            "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"
        ) {
            continue;
        }
        let mut r = json!({"login":login(&v["author"]),"state":state});
        if state != "COMMENTED"
            && truth(&v["commit"]["oid"])
            && v["commit"]["oid"] != pr["headRefOid"]
        {
            r["stale"] = json!(true);
        }
        put(r);
    }
    for v in nodes(&pr["reviewRequests"]) {
        let who = &v["requestedReviewer"];
        let team = text(&who["combinedSlug"]);
        let user = text(&who["login"]);
        let name = if user.is_empty() { team } else { user };
        if !name.is_empty() {
            let mut r = json!({"login":name,"state":"REQUESTED"});
            if !team.is_empty() && !truth(&who["login"]) {
                r["team"] = json!(true);
            }
            put(r);
        }
    }
    let method = text(&pr["autoMergeRequest"]["mergeMethod"]).to_lowercase();
    let pending = nodes(&pr["pending"]).first();
    let mut out = json!({"url":text(&pr["url"]),"title":text(&pr["title"]),"body":text(&pr["body"]),
        "state":if matches!(text(&pr["state"]),"OPEN"|"MERGED"|"CLOSED"){text(&pr["state"])}else{"OPEN"},
        "isDraft":pr["isDraft"]==true,"author":login(&pr["author"]),"createdAt":text(&pr["createdAt"]),"updatedAt":text(&pr["updatedAt"]),
        "baseRefName":text(&pr["baseRefName"]),"headRefName":text(&pr["headRefName"]),"headRefOid":text(&pr["headRefOid"]),"baseRefOid":text(&pr["baseRefOid"]),
        "additions":number(&pr["additions"]),"deletions":number(&pr["deletions"]),"changedFiles":number(&pr["changedFiles"]),
        "mergeStateStatus":if text(&pr["mergeStateStatus"]).is_empty(){"UNKNOWN"}else{text(&pr["mergeStateStatus"])},
        "reviewDecision":if matches!(text(&pr["reviewDecision"]),"APPROVED"|"CHANGES_REQUESTED"|"REVIEW_REQUIRED"){pr["reviewDecision"].clone()}else{Value::Null},
        "autoMerge":if matches!(method.as_str(),"squash"|"merge"|"rebase"){json!({"method":method})}else{Value::Null},
        "viewerCanMergeAsAdmin":pr["viewerCanMergeAsAdmin"]==true,"viewerIsAuthor":pr["viewerDidAuthor"]==true,
        "checks":checks,"reviewers":reviewers,
        "labels":nodes(&pr["labels"]).iter().filter(|v|truth(v)).map(|v|json!({"name":text(&v["name"]),"color":text(&v["color"])})).collect::<Vec<_>>(),
        "commits":nodes(&pr["commits"]).iter().map(|v|json!({"oid":text(&v["commit"]["oid"]),"headline":text(&v["commit"]["messageHeadline"])})).filter(|v|!text(&v["oid"]).is_empty()).collect::<Vec<_>>(),
        "files":files,
        "threads":nodes(&pr["reviewThreads"]).iter().filter(|v|truth(v)).map(|v|json!({"id":text(&v["id"]),"path":text(&v["path"]),
            "line":if v["line"].is_i64(){v["line"].clone()}else if v["originalLine"].is_i64()&&!truth(&v["isOutdated"]){v["originalLine"].clone()}else{Value::Null},
            "side":if v["diffSide"]=="LEFT"{"LEFT"}else{"RIGHT"},"resolved":v["isResolved"]==true,"outdated":v["isOutdated"]==true,
            "comments":nodes(&v["comments"]).iter().filter(|v|truth(v)).map(comment).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "comments":nodes(&pr["comments"]).iter().filter(|v|truth(v)).map(comment).collect::<Vec<_>>(),
        "pendingReview":pending.filter(|v|truth(&v["id"])).map(|v|json!({"id":v["id"],"count":number(&v["comments"]["totalCount"])}))});
    if let Some(n) = pr.get("number") {
        out["number"] = n.clone();
    }
    out
}
