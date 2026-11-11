use crate::*;
pub fn valid_group(group: &Value) -> bool {
    scopes::valid_link_id(group.get("id").unwrap_or(&Value::Null))
        && group["name"].as_str().is_some_and(|s| !s.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')).is_empty())
        && group["projectIds"].as_array().is_some_and(|ids| {
            ids.len() >= 2
                && ids.iter().all(Value::is_string)
                && ids
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == ids.len()
        })
}
fn active_has(active: &Value, id: &Value, path: &Value) -> bool {
    id.as_str()
        .and_then(|id| active[id].as_array())
        .is_some_and(|paths| paths.contains(path))
}
fn endpoint_valid(endpoint: &Value, projects: &[Value], active: &Value) -> bool {
    endpoint["project_id"].is_string()
        && projects.iter().any(|p| p["id"] == endpoint["project_id"])
        && (endpoint.get("worktree_path").is_none()
            || endpoint["worktree_path"].is_string()
                && active_has(active, &endpoint["project_id"], &endpoint["worktree_path"]))
}
fn same(a: &Value, b: &Value) -> bool {
    a["project_id"] == b["project_id"] && a.get("worktree_path") == b.get("worktree_path")
}
pub fn can_link(a: &Value, b: &Value, projects: &[Value], active: &Value) -> bool {
    endpoint_valid(a, projects, active)
        && endpoint_valid(b, projects, active)
        && !same(a, b)
        && !(a["project_id"] == b["project_id"]
            && (a.get("worktree_path").is_none() || b.get("worktree_path").is_none()))
}
pub fn prune(links: &[Value], projects: &[Value], active: &Value) -> Vec<Value> {
    links
        .iter()
        .filter(|link| can_link(&link["a"], &link["b"], projects, active))
        .cloned()
        .collect()
}
/// Pure one-hop reachability. Inputs are evidence, not filesystem grants. Runtime
/// admission must use a verified active catalog and registered Project identities.
pub fn linked_worktrees(source: &Value, links: &[Value], active: &Value) -> Result<Vec<Value>> {
    if links.len() > MAX_ENTRIES {
        return Err("Registry Link limit exceeded.".into());
    }
    if !active_has(active, &source["project_id"], &source["worktree_path"]) {
        return Ok(vec![]);
    }
    let mut found: Vec<Value> = Vec::new();
    for link in links {
        let a = &link["a"];
        let b = &link["b"];
        if !a.is_object() || !b.is_object() {
            return Err("Malformed saved canvas Link.".into());
        }
        let matches = |endpoint: &Value| {
            endpoint["project_id"] == source["project_id"]
                && (endpoint.get("worktree_path").is_none()
                    || endpoint["worktree_path"] == source["worktree_path"])
        };
        let target = if matches(a) {
            b
        } else if matches(b) {
            a
        } else {
            continue;
        };
        let paths = if target.get("worktree_path").is_some() {
            vec![target["worktree_path"].clone()]
        } else {
            target["project_id"]
                .as_str()
                .and_then(|id| active[id].as_array())
                .cloned()
                .unwrap_or_default()
        };
        for path in paths {
            if !active_has(active, &target["project_id"], &path)
                || target["project_id"] == source["project_id"] && path == source["worktree_path"]
            {
                continue;
            }
            if let Some(previous) = found.iter_mut().find(|item| {
                item["project_id"] == target["project_id"] && item["worktree_path"] == path
            }) {
                previous["link_ids"]
                    .as_array_mut()
                    .unwrap()
                    .push(link["id"].clone());
            } else {
                if found.len() >= MAX_ENTRIES {
                    return Err("Linked Worktree limit exceeded.".into());
                }
                found.push(json!({"project_id":target["project_id"],"worktree_path":path,"link_id":link["id"],"link_ids":[link["id"]]}));
            }
        }
    }
    Ok(found)
}

/// Node membersAvailable membership lookup without filesystem admission. Returned
/// saved records are not ProjectGrant values and cannot authorize file access.
pub fn member_entries(group: &Value, projects: &[Value]) -> Result<Vec<Value>> {
    let ids = group["projectIds"]
        .as_array()
        .ok_or("Invalid Link membership.")?;
    if ids.len() > MAX_ENTRIES {
        return Err("Link member limit exceeded.".into());
    }
    ids.iter()
        .map(|id| {
            projects
                .iter()
                .find(|entry| entry["id"] == *id)
                .cloned()
                .ok_or_else(|| {
                    let name = id
                        .as_str()
                        .and_then(|s| Path::new(s).parent())
                        .and_then(Path::file_name)
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    format!(
                        "Link Project {name} is unavailable. Restore its folder before sending."
                    )
                })
        })
        .collect()
}
