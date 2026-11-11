//! Isolated copied-store writer. No live profiles, discovery or runtime endpoint.
mod storage;
use crate::*;
use serde_json::Map;
pub use storage::{RegistryCopy, Seeds};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteError {
    pub message: String,
    pub committed: bool,
}
impl WriteError {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            committed: false,
        }
    }
    fn uncertain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            committed: true,
        }
    }
}
impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for WriteError {}
pub type WResult<T> = std::result::Result<T, WriteError>;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fault {
    #[default]
    None,
    BeforeStage,
    BeforeRename,
    AfterRename,
}
pub struct Writer {
    store: storage::Store,
    registry: Registry,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    uuid: Arc<dyn Fn() -> String + Send + Sync>,
    fault: Fault,
}
impl RegistryCopy {
    pub fn writer(
        &self,
        active: Active,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> WResult<Writer> {
        self.writer_with_ids(active, now, Arc::new(|| uuid::Uuid::new_v4().to_string()))
    }
    /// Deterministic UUID source for Node conformance fixtures, supplied by owner
    /// code, not renderer input. Every generated id still passes UUID validation.
    pub fn writer_with_ids(
        &self,
        active: Active,
        now: Arc<dyn Fn() -> String + Send + Sync>,
        uuid: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> WResult<Writer> {
        let store = self.acquire(active.clone())?;
        let registry = self.reader(active)?;
        Ok(Writer {
            store,
            registry,
            now,
            uuid,
            fault: Fault::None,
        })
    }
}
impl Writer {
    pub fn fault_once(&mut self, fault: Fault) {
        self.fault = fault;
    }
    fn read_registry(&self) -> WResult<(Option<Vec<u8>>, Value)> {
        let bytes = self.store.read("project-registry.json")?;
        let raw = bytes
            .as_deref()
            .and_then(|b| jsjson::parse_bytes(b).ok())
            .unwrap_or(Value::Null);
        let snapshot = self.registry.snapshot().map_err(WriteError::refused)?;
        let mut data = Map::new();
        data.insert(
            "scanned".into(),
            json!(raw["scanned"] == true && raw["projects"].is_array()),
        );
        for key in ["projects", "links"] {
            data.insert(key.into(), snapshot.value()[key].clone());
        }
        if raw["projects"].is_array() {
            data.insert(
                "projectGroups".into(),
                snapshot.value()["projectGroups"].clone(),
            );
        }
        data.insert(
            "worktreePositions".into(),
            snapshot.value()["worktreePositions"].clone(),
        );
        Ok((bytes, Value::Object(data)))
    }
    fn save(&mut self, path: &str, previous: Option<&[u8]>, value: &Value) -> WResult<()> {
        if ["projects", "links", "projectGroups"].iter().any(|key| {
            value[*key]
                .as_array()
                .is_some_and(|entries| entries.len() > MAX_ENTRIES)
        }) {
            return Err(WriteError::refused("Registry output entry limit exceeded."));
        }
        let fault = std::mem::take(&mut self.fault);
        self.store
            .replace(path, previous, pretty(value).as_bytes(), fault)
    }
    /// The public mutation boundary holds &mut self across discovery and performs
    /// staging/rename synchronously, without an await inside the commit.
    pub async fn call(&mut self, method: &str, args: &Value) -> WResult<Value> {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.call_inner(method, args),
        )
        .await
        .map_err(|_| {
            WriteError::refused("Registry mutation discovery timed out; no mutation committed.")
        })?
    }
    async fn call_inner(&mut self, method: &str, args: &Value) -> WResult<Value> {
        self.store.verify()?;
        if method.starts_with("recent:") {
            return self.recent(method, args).await;
        }
        let (bytes, previous) = self.read_registry()?;
        if method == "register" {
            return self.register(args, bytes, previous).await;
        }
        let mut data = previous.clone();
        let mut retained = Vec::new();
        for entry in previous["projects"].as_array().unwrap() {
            match self
                .registry
                .inspect_saved(entry)
                .await
                .map_err(WriteError::refused)?
            {
                RecordProbe::Present(_) | RecordProbe::Outside => retained.push(entry.clone()),
                RecordProbe::Gone | RecordProbe::Mismatch => (),
            }
        }
        data["projects"] = json!(retained);
        self.prune_absent(&mut data)?;
        let result = self.change(method, args, &mut data).await?;
        self.store.verify()?;
        if jsjson::to_string(&data) != jsjson::to_string(&previous) {
            self.save("project-registry.json", bytes.as_deref(), &data)?;
        }
        Ok(result.unwrap_or_else(|| data["projects"].clone()))
    }
    async fn register(
        &mut self,
        args: &Value,
        bytes: Option<Vec<u8>>,
        mut data: Value,
    ) -> WResult<Value> {
        let path = args["path"]
            .as_str()
            .ok_or_else(|| WriteError::refused("Choose a folder."))?;
        let identity = self
            .registry
            .identify(path)
            .await
            .map_err(WriteError::refused)?
            .value;
        let rows = data["projects"].as_array().unwrap();
        if rows.first().is_some_and(|top| {
            identity
                .as_object()
                .unwrap()
                .iter()
                .all(|(key, value)| top.get(key) == Some(value))
        }) {
            self.store.verify()?;
            return Ok(data["projects"].clone());
        }
        let prior = rows.iter().find(|entry| entry["id"] == identity["id"]);
        let mut first = identity.clone();
        first["position"] = prior
            .and_then(|p| p.get("position"))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null);
        first["openedAt"] = json!((self.now)());
        let mut next = vec![first];
        for entry in rows {
            if self
                .registry
                .entry_outside(entry)
                .map_err(WriteError::refused)?
            {
                if entry["id"] == identity["id"] {
                    return Err(WriteError::refused(
                        "Project id conflicts with preserved outside-copy metadata.",
                    ));
                }
                next.push(entry.clone());
                continue;
            }
            if entry["id"] == identity["id"] || entry["path"] == identity["path"] {
                continue;
            }
            let path = Path::new(entry["path"].as_str().unwrap());
            let id = Path::new(entry["id"].as_str().unwrap());
            match self
                .registry
                .probe(path)
                .await
                .map_err(WriteError::refused)?
            {
                Probe::Outside => next.push(entry.clone()),
                Probe::Present(_) => {
                    if id == path
                        || self.registry.outside(id).map_err(WriteError::refused)?
                        || !self
                            .registry
                            .definitely_gone(id)
                            .map_err(WriteError::refused)?
                    {
                        next.push(entry.clone());
                    }
                }
                Probe::Gone => (),
            }
        }
        data["projects"] = json!(next);
        self.prune_absent(&mut data)?;
        self.save("project-registry.json", bytes.as_deref(), &data)?;
        Ok(data["projects"].clone())
    }
    async fn recent(&mut self, method: &str, args: &Value) -> WResult<Value> {
        let timestamp = if method == "recent:add" {
            Some((self.now)())
        } else {
            None
        };
        let requested = args["path"].as_str().filter(|p| Path::new(p).is_absolute());
        if method == "recent:add" && requested.is_none() {
            return Err(WriteError::refused("An absolute project path is required"));
        }
        let bytes = self.store.read("recent-projects.json")?;
        let mut rows = self
            .registry
            .recent()
            .map_err(WriteError::refused)?
            .as_array()
            .unwrap()
            .clone();
        match method {
            "recent:add" => {
                let path = requested
                    .ok_or_else(|| WriteError::refused("An absolute project path is required"))?;
                let canonical = self
                    .registry
                    .contained(Path::new(path))
                    .map_err(WriteError::refused)?;
                let identity = self
                    .registry
                    .identify(&canonical)
                    .await
                    .map_err(WriteError::refused)?;
                if !identity.worktrees.iter().any(|w| {
                    std::fs::canonicalize(w["path"].as_str().unwrap()).is_ok_and(|p| p == canonical)
                }) {
                    return Err(WriteError::refused(
                        "Choose an exact Project Worktree root.",
                    ));
                }
                let path = lexical(Path::new(path));
                if rows
                    .first()
                    .is_some_and(|entry| entry["path"] == json!(path))
                {
                    self.store.verify()?;
                    return Ok(json!(rows));
                }
                rows.retain(|entry| entry["path"] != json!(path));
                rows.insert(0,json!({"path":path,"name":path.file_name().and_then(|s|s.to_str()).unwrap_or(""),"openedAt":timestamp.unwrap()}));
                rows.truncate(10);
            }
            "recent:forget" => {
                if let Some(path) = requested {
                    let path = lexical(Path::new(path));
                    rows.retain(|entry| entry["path"] != json!(path));
                }
            }
            _ => return Err(WriteError::refused("Unsupported registry mutation.")),
        }
        let result = json!(rows);
        self.save("recent-projects.json", bytes.as_deref(), &result)?;
        Ok(result)
    }
}
fn pretty(value: &Value) -> String {
    let compact = jsjson::to_string(value);
    let chars = compact.chars().collect::<Vec<_>>();
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        if quoted {
            out.push(*c);
            if escaped {
                escaped = false
            } else if *c == '\\' {
                escaped = true
            } else if *c == '"' {
                quoted = false
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                out.push(*c)
            }
            '{' | '[' => {
                out.push(*c);
                depth += 1;
                if chars.get(i + 1) != Some(&if *c == '{' { '}' } else { ']' }) {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if i > 0 && chars[i - 1] != if *c == '}' { '{' } else { '[' } {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
                out.push(*c)
            }
            ',' => {
                out.push_str(",\n");
                out.push_str(&"  ".repeat(depth));
            }
            ':' => out.push_str(": "),
            _ => out.push(*c),
        }
    }
    out
}
impl Writer {
    async fn active_worktrees(&self, data: &Value) -> WResult<Value> {
        let mut active = json!({});
        for project in data["projects"].as_array().unwrap() {
            if let RecordProbe::Present(identity) = self
                .registry
                .inspect_saved(project)
                .await
                .map_err(WriteError::refused)?
            {
                active[project["id"].as_str().unwrap()] = json!(identity
                    .worktrees
                    .iter()
                    .map(|tree| &tree["path"])
                    .collect::<Vec<_>>());
            }
        }
        Ok(active)
    }
    fn next_id(&self) -> WResult<String> {
        let id = (self.uuid)();
        if scopes::valid_link_id(&json!(id)) {
            Ok(id)
        } else {
            Err(WriteError::refused("Owner generated an invalid Link id."))
        }
    }
    fn prune_absent(&self, data: &mut Value) -> WResult<()> {
        let ids = data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].clone())
            .collect::<Vec<_>>();
        let mut kept = Vec::new();
        for link in data["links"].as_array().unwrap() {
            if self.edge_outside(link, data)?
                || (ids.contains(&link["a"]["project_id"])
                    && ids.contains(&link["b"]["project_id"]))
            {
                kept.push(link.clone());
            }
        }
        data["links"] = json!(kept);
        Ok(())
    }
    fn admitted_projects(&self, data: &Value) -> WResult<Vec<Value>> {
        data["projects"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|project| match self.registry.entry_outside(project) {
                Ok(false) => Some(Ok(project.clone())),
                Ok(true) => None,
                Err(error) => Some(Err(WriteError::refused(error))),
            })
            .collect()
    }
    fn edge_outside(&self, link: &Value, data: &Value) -> WResult<bool> {
        for side in ["a", "b"] {
            if let Some(id) = link[side]["project_id"].as_str() {
                if self
                    .registry
                    .outside(Path::new(id))
                    .map_err(WriteError::refused)?
                {
                    return Ok(true);
                }
                if let Some(project) = data["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["id"] == id)
                {
                    if self
                        .registry
                        .entry_outside(project)
                        .map_err(WriteError::refused)?
                    {
                        return Ok(true);
                    }
                }
            }
            if let Some(path) = link[side]["worktree_path"].as_str() {
                if self
                    .registry
                    .outside(Path::new(path))
                    .map_err(WriteError::refused)?
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    async fn change(&self, method: &str, args: &Value, data: &mut Value) -> WResult<Option<Value>> {
        match method {
            "position" => {
                let position = &args["position"];
                if !args["id"].is_string() || !valid_position(position) {
                    return Err(WriteError::refused("Invalid Project position."));
                }
                let row = data["projects"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|p| p["id"] == args["id"])
                    .ok_or_else(|| WriteError::refused("Project is not in the registry."))?;
                if self
                    .registry
                    .entry_outside(row)
                    .map_err(WriteError::refused)?
                {
                    return Err(WriteError::refused(
                        "Project is outside the isolated registry capability.",
                    ));
                }
                row["position"] = json!({"x":position["x"],"y":position["y"]});
            }
            "worktree-position" => {
                let position = &args["position"];
                let active = self.active_worktrees(data).await?;
                let id = args["id"].as_str().unwrap_or("");
                let path = args["path"].as_str().unwrap_or("");
                if !data["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["id"] == id)
                    || !Path::new(path).is_absolute()
                    || !valid_position(position)
                    || !active[id]
                        .as_array()
                        .is_some_and(|paths| paths.contains(&json!(path)))
                {
                    return Err(WriteError::refused("Invalid Worktree position."));
                }
                if !data["worktreePositions"].is_object() {
                    return Err(WriteError::refused(
                        "Unsupported saved Worktree positions shape.",
                    ));
                }
                if data["worktreePositions"].get(id).is_none_or(Value::is_null) {
                    data["worktreePositions"][id] = json!({});
                }
                if !data["worktreePositions"][id].is_object() {
                    return Err(WriteError::refused(
                        "Unsupported saved Worktree positions shape.",
                    ));
                }
                data["worktreePositions"][id][path] = json!({"x":position["x"],"y":position["y"]});
            }
            "group:create" | "group:update" => {
                if data.get("projectGroups").is_none() {
                    data["projectGroups"] = json!([]);
                }
                let previous_index = if method == "group:update" {
                    Some(
                        data["projectGroups"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .position(|group| group["id"] == args["id"])
                            .ok_or_else(|| WriteError::refused("Link no longer exists"))?,
                    )
                } else {
                    None
                };
                let previous = previous_index.map(|index| data["projectGroups"][index].clone());
                let created_id = if method == "group:create" {
                    Some(self.next_id()?)
                } else {
                    None
                };
                let mut membership_data = data.clone();
                membership_data["projects"] = json!(self.admitted_projects(data)?);
                let member = membership(&membership_data, args, previous_index)?;
                let result = if let Some(mut previous) = previous {
                    for (key, value) in member.as_object().unwrap() {
                        previous[key] = value.clone();
                    }
                    if member.get("hidden").is_none() {
                        previous.as_object_mut().unwrap().shift_remove("hidden");
                    }
                    previous
                } else {
                    let mut created = json!({"id":created_id.unwrap()});
                    for (key, value) in member.as_object().unwrap() {
                        created[key] = value.clone();
                    }
                    created["createdAt"] = json!((self.now)());
                    created
                };
                if method == "group:create" {
                    data["projectGroups"]
                        .as_array_mut()
                        .unwrap()
                        .push(result.clone());
                } else {
                    for group in data["projectGroups"].as_array_mut().unwrap() {
                        if group["id"] == result["id"] {
                            *group = result.clone();
                        }
                    }
                }
                return Ok(Some(result));
            }
            "group:delete" => {
                let groups = data
                    .get_mut("projectGroups")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| WriteError::refused("Link no longer exists"))?;
                if !groups.iter().any(|group| group["id"] == args["id"]) {
                    return Err(WriteError::refused("Link no longer exists"));
                }
                groups.retain(|group| group["id"] != args["id"]);
                return Ok(Some(jsjson::undefined()));
            }
            "link:add" | "link:restore" => {
                let active = self.active_worktrees(data).await?;
                let saved = if method == "link:restore" {
                    &args["link"]
                } else {
                    args
                };
                let (a, b) = (&saved["a"], &saved["b"]);
                if method == "link:restore"
                    && (!saved["id"].as_str().is_some_and(|s| !s.is_empty())
                        || !saved["created_at"].is_string())
                {
                    return Err(WriteError::refused("That Link is no longer valid."));
                }
                if !links::can_link(a, b, &self.admitted_projects(data)?, &active) {
                    return Err(WriteError::refused("These endpoints cannot be linked."));
                }
                let same = |x: &Value, y: &Value| {
                    x["project_id"] == y["project_id"]
                        && x.get("worktree_path") == y.get("worktree_path")
                };
                if data["links"].as_array().unwrap().iter().any(|link| {
                    (method == "link:restore" && link["id"] == saved["id"])
                        || ((same(&link["a"], a) || same(&link["b"], a))
                            && (same(&link["a"], b) || same(&link["b"], b)))
                }) {
                    return Err(WriteError::refused("Link already exists."));
                }
                let normalized = |end: &Value| {
                    let mut value = json!({"project_id":end["project_id"]});
                    if let Some(path) = end.get("worktree_path") {
                        value["worktree_path"] = path.clone();
                    }
                    value
                };
                let link = if method == "link:restore" {
                    json!({"id":saved["id"],"a":normalized(a),"b":normalized(b),"created_at":saved["created_at"]})
                } else {
                    json!({"id":self.next_id()?,"a":a,"b":b,"created_at":(self.now)()})
                };
                data["links"].as_array_mut().unwrap().push(link);
            }
            "link:remove" => {
                let links = data["links"].as_array_mut().unwrap();
                if !links.iter().any(|link| link["id"] == args["id"]) {
                    return Err(WriteError::refused("Link does not exist."));
                }
                links.retain(|link| link["id"] != args["id"]);
            }
            "link:prune" => {
                let active = self.active_worktrees(data).await?;
                let admitted = self.admitted_projects(data)?;
                let mut kept = Vec::new();
                for link in data["links"].as_array().unwrap() {
                    if self.edge_outside(link, data)?
                        || links::can_link(&link["a"], &link["b"], &admitted, &active)
                    {
                        kept.push(link.clone());
                    }
                }
                let mut preserved_positions = std::collections::BTreeSet::new();
                let mut preserved_paths =
                    std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
                if let Some(positions) = data["worktreePositions"].as_object() {
                    for (id, entries) in positions {
                        if let Some(entries) = entries.as_object() {
                            for path in entries.keys().filter(|path| Path::new(path).is_absolute())
                            {
                                if self
                                    .registry
                                    .outside(Path::new(path))
                                    .map_err(WriteError::refused)?
                                {
                                    preserved_paths
                                        .entry(id.clone())
                                        .or_default()
                                        .insert(path.clone());
                                }
                            }
                        }
                        if Path::new(id).is_absolute()
                            && self
                                .registry
                                .outside(Path::new(id))
                                .map_err(WriteError::refused)?
                            || data["projects"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|project| project["id"] == *id && !admitted.contains(project))
                        {
                            preserved_positions.insert(id.clone());
                        }
                    }
                }
                let removed = data["links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|link| !kept.contains(link))
                    .cloned()
                    .collect::<Vec<_>>();
                data["links"] = json!(kept);
                if let Some(positions) = data["worktreePositions"].as_object_mut() {
                    positions.retain(|id, positions| {
                        if preserved_positions.contains(id) {
                            return true;
                        }
                        let Some(paths) = active[id].as_array() else {
                            return false;
                        };
                        if let Some(positions) = positions.as_object_mut() {
                            positions.retain(|path, _| {
                                paths.contains(&json!(path))
                                    || preserved_paths
                                        .get(id)
                                        .is_some_and(|saved| saved.contains(path))
                            });
                        }
                        true
                    });
                }
                return Ok(Some(json!(removed)));
            }
            _ => return Err(WriteError::refused("Unsupported registry mutation.")),
        }
        Ok(None)
    }
}
fn valid_position(position: &Value) -> bool {
    ["x", "y"]
        .iter()
        .all(|key| position[*key].as_f64().is_some_and(f64::is_finite))
}
fn membership(data: &Value, request: &Value, previous_index: Option<usize>) -> WResult<Value> {
    let previous = previous_index.map(|index| &data["projectGroups"][index]);
    let name=request["name"].as_str().unwrap_or("").trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|' '| '\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
    if name.is_empty() || jsjson::utf16_len(name) > 100 || name.chars().any(|c| c <= '\u{001f}') {
        return Err(WriteError::refused(
            "Give the Link a name of 1 to 100 characters.",
        ));
    }
    let ids = request["projectIds"]
        .as_array()
        .ok_or_else(|| WriteError::refused("Choose at least two distinct Projects."))?;
    let mut seen = Vec::new();
    if ids.len() < 2
        || ids.iter().any(|id| {
            if seen.iter().any(|prior| jsjson::strict_equals(prior, id)) {
                true
            } else {
                seen.push(id.clone());
                false
            }
        })
    {
        return Err(WriteError::refused(
            "Choose at least two distinct Projects.",
        ));
    }
    if ids.iter().any(|id| {
        !id.is_string()
            || !(data["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == *id)
                || previous.is_some_and(|p| p["projectIds"].as_array().unwrap().contains(id)))
    }) {
        return Err(WriteError::refused(
            "Open each member Project in Milagre first.",
        ));
    }
    if data["projectGroups"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .any(|(index, group)| {
            previous_index != Some(index)
                && group["projectIds"].as_array().unwrap().len() == ids.len()
                && ids
                    .iter()
                    .all(|id| group["projectIds"].as_array().unwrap().contains(id))
        })
    {
        return Err(WriteError::refused(
            "A Link with these Projects already exists.",
        ));
    }
    let hidden = request["hidden"]
        .as_bool()
        .unwrap_or_else(|| previous.is_some_and(|p| p["hidden"] == true));
    let mut result = json!({"name":name,"projectIds":ids});
    if hidden {
        result["hidden"] = json!(true);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn probe_capacity_is_unverifiable_and_never_removes_a_saved_project() {
        let temp = tempfile::tempdir().unwrap();
        let isolation =
            Isolation::create(temp.path(), &milagre_owner_store::Policy::default()).unwrap();
        let project = isolation.root().join("project");
        std::fs::create_dir(&project).unwrap();
        let copy = RegistryCopy::create(isolation, Seeds::default()).unwrap();
        let mut writer = copy
            .writer(
                Arc::new(|| Ok(())),
                Arc::new(|| "2026-01-01T00:00:00.000Z".into()),
            )
            .unwrap();
        writer
            .call("register", &json!({"path":project}))
            .await
            .unwrap();
        let before = std::fs::read(copy.path().join("project-registry.json")).unwrap();
        let _all_slots = writer
            .registry
            .probes
            .clone()
            .acquire_many_owned(8)
            .await
            .unwrap();
        let error = writer
            .call("position", &json!({"id":project,"position":{"x":1,"y":2}}))
            .await
            .unwrap_err();
        assert!(!error.committed);
        assert!(error.message.contains("capacity"));
        assert_eq!(
            std::fs::read(copy.path().join("project-registry.json")).unwrap(),
            before
        );
    }
}
