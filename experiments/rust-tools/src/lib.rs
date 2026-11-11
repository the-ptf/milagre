//! Native retained-content MCP tools. No listener, credentials, live-profile discovery or provider launch.
mod feedback;
mod schema;
use milagre_content_store::{
    design::{self, raster::RasterRenderer, DesignKits},
    ActiveCheck, ArtifactStore, Error, Result, Runtime,
};
use milagre_owner_store::{jsjson, Isolation};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, OnceLock},
};

const MAX_BODY: usize = 1024 * 1024;
const MAX_DESIGN_BODY: usize = 6_000_000 + 64 * 1024;
const MAX_REPLY: usize = 32 * 1024 * 1024;
/// Immutable resource grant supplied by the owner, never parsed from MCP input.
#[derive(Clone)]
pub enum DesignScope {
    All,
    Ids(BTreeSet<String>),
}
#[derive(Clone)]
pub struct Caller {
    pub chat_id: String,
    pub project_id: String,
    pub roots: Vec<PathBuf>,
    pub read: bool,
    pub write: bool,
    pub html: bool,
    pub designs: bool,
    pub kits: bool,
    pub design_scope: DesignScope,
    pub bundled_skills: PathBuf,
    pub assert_active: ActiveCheck,
}
struct State {
    artifacts: ArtifactStore,
    kits: RefCell<DesignKits>,
}
/// One owner serializes calls through this value. Recheck the caller's active
/// grant on each request and each write; the stores retain their own lock guard.
pub struct Dispatcher {
    caller: Caller,
    state: State,
    raster: Option<Arc<RasterRenderer>>,
    fault: Option<String>,
}
fn contract() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        jsjson::parse(include_str!("contract.json")).expect("generated tool contract")
    })
}
fn remove(value: &mut Value, key: &str) {
    if let Some(o) = value.as_object_mut() {
        o.shift_remove(key);
    }
}
fn text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":jsjson::to_string(&value)}],"isError":false})
}
fn tool_error(message: impl Into<String>) -> Value {
    json!({"content":[{"type":"text","text":message.into()}],"isError":true})
}
fn protocol_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
impl Dispatcher {
    pub fn open(
        isolation: Isolation,
        artifacts: PathBuf,
        kits: PathBuf,
        mut caller: Caller,
        runtime: Arc<dyn Runtime>,
        raster: Option<Arc<RasterRenderer>>,
    ) -> Result<Self> {
        if caller.chat_id.is_empty()
            || caller.project_id.is_empty()
            || !caller.bundled_skills.is_absolute()
        {
            return Err(Error::new(
                "Content tools need an explicit Chat, Project and bundled skill directory.",
            ));
        }
        for root in &mut caller.roots {
            let canonical = std::fs::canonicalize(&*root)?;
            if !canonical.starts_with(isolation.root()) || canonical == isolation.root() {
                return Err(Error::new(
                    "Tool Worktrees must be inside the isolated copy.",
                ));
            }
            if !canonical.is_dir() {
                return Err(Error::new("Tool Worktrees must be directories."));
            }
            *root = canonical;
        }
        let grant = caller.assert_active.clone();
        let roots = caller.roots.clone();
        caller.assert_active = Arc::new(move || {
            grant()?;
            for root in &roots {
                if std::fs::canonicalize(root)? != *root {
                    return Err(Error::new(
                        "An admitted Tool Worktree changed its location.",
                    ));
                }
            }
            Ok(())
        });
        (caller.assert_active)()?;
        let chat = caller.chat_id.clone();
        let validate = Arc::new(move |id: &str| {
            if id == chat {
                Ok(())
            } else {
                Err(Error::new("Chat outside the caller's scope."))
            }
        });
        let chat = caller.chat_id.clone();
        let project = caller.project_id.clone();
        let project_for = Arc::new(move |id: &str| {
            if id == chat {
                Ok(project.clone())
            } else {
                Err(Error::new("Chat outside the caller's scope."))
            }
        });
        let store = ArtifactStore::open(
            isolation.clone(),
            &artifacts,
            validate,
            caller.assert_active.clone(),
            runtime,
        )?;
        let kits = DesignKits::open(isolation, &kits, project_for, caller.assert_active.clone())?;
        Ok(Self {
            caller,
            state: State {
                artifacts: store,
                kits: RefCell::new(kits),
            },
            raster,
            fault: None,
        })
    }
    fn active(&self) -> Result<()> {
        if let Some(fault) = &self.fault {
            return Err(Error::new(fault));
        }
        (self.caller.assert_active)()
    }
    fn available(&self, tool: &Value) -> bool {
        let name = tool["name"].as_str().unwrap();
        if name == "design_delete" {
            return false;
        }
        if tool["annotations"]["readOnlyHint"] == true {
            if !self.caller.read {
                return false;
            }
        } else if !self.caller.write {
            return false;
        }
        if name.starts_with("design_kit_") {
            return self.caller.kits;
        }
        if name.starts_with("design_") {
            return self.caller.designs;
        }
        if ["artifact_comments", "artifact_resolve_comment"].contains(&name) {
            return self.caller.html || self.caller.designs;
        }
        self.caller.html
    }
    pub fn list(&self) -> Result<Value> {
        self.active()?;
        Ok(
            json!({"tools":contract()["tools"].as_array().unwrap().iter().filter(|t|self.available(t)).map(|t|{let mut t=t.clone();t["description"]=json!(t["description"].as_str().unwrap().replace("$BUNDLED_SKILLS",&self.caller.bundled_skills.to_string_lossy()));t}).collect::<Vec<_>>()}),
        )
    }
    /// One complete in-process JSON-RPC frame. Notifications produce no reply.
    /// Transport adapters enforce framing/authentication before passing a frame.
    pub async fn dispatch(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        let value = if bytes.len() > MAX_DESIGN_BODY {
            protocol_error(
                Value::Null,
                -32000,
                &format!("Request exceeds the {MAX_DESIGN_BODY}-byte MCP limit."),
            )
        } else {
            match jsjson::parse_bytes(bytes) {
                Err(_) => protocol_error(Value::Null, -32700, "Parse error"),
                Ok(message) => {
                    let large = message["method"] == "tools/call"
                        && matches!(
                            message["params"]["name"].as_str(),
                            Some("design_show" | "design_apply")
                        );
                    if bytes.len() > MAX_BODY && !large {
                        protocol_error(
                            Value::Null,
                            -32000,
                            &format!("Request exceeds the {MAX_BODY}-byte MCP limit."),
                        )
                    } else if !message.is_object()
                        || message["jsonrpc"] != "2.0"
                        || !message["method"].is_string()
                        || message
                            .get("id")
                            .is_some_and(|id| !id.is_string() && !id.is_number())
                    {
                        protocol_error(Value::Null, -32600, "Invalid Request")
                    } else if message.get("id").is_none() {
                        return None;
                    } else {
                        let id = message["id"].clone();
                        match self.active() {
                            Err(e) => protocol_error(id, -32000, &e.message),
                            Ok(()) => {
                                let result = match message["method"].as_str().unwrap() {
                                    "initialize" => {
                                        let requested = message["params"]["protocolVersion"]
                                            .as_str()
                                            .unwrap_or("");
                                        json!({"protocolVersion":if ["2025-03-26","2025-06-18"].contains(&requested){requested}else{"2025-06-18"},"capabilities":{"tools":{}},"serverInfo":{"name":"milagre","version":"1"}})
                                    }
                                    "ping" => json!({}),
                                    "tools/list" => match self.list() {
                                        Ok(v) => v,
                                        Err(e) => {
                                            return Some(
                                                jsjson::to_string(&protocol_error(
                                                    id, -32000, &e.message,
                                                ))
                                                .into_bytes(),
                                            )
                                        }
                                    },
                                    "tools/call" => {
                                        self.call(
                                            message["params"]["name"].as_str().unwrap_or(""),
                                            message["params"]
                                                .get("arguments")
                                                .unwrap_or(&json!({})),
                                        )
                                        .await
                                    }
                                    _ => {
                                        return Some(
                                            jsjson::to_string(&protocol_error(
                                                id,
                                                -32601,
                                                "Method not found",
                                            ))
                                            .into_bytes(),
                                        )
                                    }
                                };
                                json!({"jsonrpc":"2.0","id":id,"result":result})
                            }
                        }
                    }
                }
            }
        };
        let encoded = jsjson::to_string(&value);
        if encoded.len() > MAX_REPLY {
            Some(
                jsjson::to_string(&protocol_error(
                    value["id"].clone(),
                    -32000,
                    "MCP reply exceeds the 33554432-byte limit.",
                ))
                .into_bytes(),
            )
        } else {
            Some(encoded.into_bytes())
        }
    }
    pub fn storage_fault(&self) -> Option<&str> {
        self.fault.as_deref()
    }
    pub async fn call(&mut self, name: &str, args: &Value) -> Value {
        let limit = if ["design_show", "design_apply"].contains(&name) {
            MAX_DESIGN_BODY
        } else {
            MAX_BODY
        };
        if jsjson::to_string(args).len() > limit {
            return tool_error(format!("Request exceeds the {limit}-byte MCP limit."));
        }
        let Some(tool) = contract()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name && self.available(t))
        else {
            return tool_error("Tool unavailable for this connection");
        };
        if let Err(e) = self.active() {
            return tool_error(e.message);
        }
        let empty = json!({});
        let args = match schema::parse(
            &contract()["parsing"][name],
            if args.is_null() { &empty } else { args },
        ) {
            Ok(v) => v,
            Err(e) => return tool_error(e),
        };
        let readonly = tool["annotations"]["readOnlyHint"] == true;
        match self.run(name, &args).await {
            Ok(result) => {
                if readonly {
                    if let Err(e) = self.active() {
                        return tool_error(e.message);
                    }
                }
                result
            }
            Err(error) => {
                if ["INVALID_CONTENT_STORAGE", "UNSAFE_FILE", "IO_ERROR"]
                    .contains(&error.code.as_str())
                {
                    self.fault = Some(format!("Content storage stopped: {}", error.message));
                }
                tool_error(if name.starts_with("design_") {
                    concise(&error)
                } else {
                    error.message
                })
            }
        }
    }
    fn permit(&self, id: Option<&str>) -> Result<()> {
        match &self.caller.design_scope {
            DesignScope::All => Ok(()),
            DesignScope::Ids(ids) if id.is_some_and(|id| ids.contains(id)) => Ok(()),
            _ => Err(Error::new("This design is outside the connection's scope.")),
        }
    }
    fn request(&self, args: &Value, format: Option<&str>) -> Value {
        let mut r = json!({"chatId":self.caller.chat_id});
        for (key, value) in args.as_object().unwrap() {
            r[key] = value.clone();
        }
        if let Some(format) = format {
            r["format"] = json!(format);
        }
        r
    }
    fn filtered_comments(&mut self) -> Result<Value> {
        let mut query = json!({"chatId":self.caller.chat_id});
        if !self.caller.html {
            query["format"] = json!("design");
        } else if !self.caller.designs {
            query["format"] = json!("html");
        }
        let designs = self
            .state
            .artifacts
            .list(&json!({"chatId":self.caller.chat_id,"format":"design"}))?;
        let design_ids = designs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|d| d["id"].as_str())
            .collect::<BTreeSet<_>>();
        let mut comments = self.state.artifacts.comments(&query)?;
        comments.as_array_mut().unwrap().retain(|c| {
            let id = c["design"]["id"].as_str();
            if id.is_some_and(|id| design_ids.contains(id)) {
                self.caller.designs && self.permit(id).is_ok()
            } else {
                self.caller.html
            }
        });
        Ok(comments)
    }
    async fn run(&mut self, name: &str, args: &Value) -> Result<Value> {
        if name.starts_with("design_")
            && !name.starts_with("design_kit_")
            && name != "design_list"
            && !(name == "design_validate"
                && args.get("document").is_some()
                && args.get("id").is_none())
        {
            self.permit(args["id"].as_str())?;
            if args.get("from").is_some() {
                self.permit(args["from"]["id"].as_str())?;
            }
        }
        let request = self.request(args, None);
        match name {
            "artifact_show" => Ok(text(
                self.state.artifacts.show(&request, &self.caller.roots)?,
            )),
            "artifact_read" => Ok(text(self.state.artifacts.artifact_read(&request)?)),
            "artifact_list" | "design_list" => {
                let mut list = self.state.artifacts.list(&self.request(
                    args,
                    Some(if name == "design_list" {
                        "design"
                    } else {
                        "html"
                    }),
                ))?;
                if name == "design_list" {
                    list.as_array_mut()
                        .unwrap()
                        .retain(|d| self.permit(d["id"].as_str()).is_ok());
                }
                Ok(text(list))
            }
            "artifact_comments" => {
                let mut comments = self.filtered_comments()?;
                if args["all"] != true {
                    comments
                        .as_array_mut()
                        .unwrap()
                        .retain(|c| !jsjson::truthy(c.get("resolved")));
                }
                Ok(text(comments))
            }
            "artifact_resolve_comment" => {
                if !(self.caller.html
                    && self.caller.designs
                    && matches!(self.caller.design_scope, DesignScope::All))
                    && !self
                        .filtered_comments()?
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["id"] == args["id"])
                {
                    return Err(Error::new(
                        "This comment is outside the connection's scope or is unavailable.",
                    ));
                }
                self.active()?;
                Ok(text(self.state.artifacts.resolve_comment(&request)?))
            }
            "design_kit_read" => Ok(text(self.state.kits.borrow_mut().read(&request)?)),
            "design_kit_save" => Ok(text(self.state.kits.borrow_mut().save(&request)?)),
            "design_read" => {
                let mut saved = self
                    .state
                    .artifacts
                    .get(&self.request(args, Some("design")))?;
                remove(&mut saved, "html");
                Ok(text(saved))
            }
            "design_export" => Ok(text(self.state.artifacts.export_design(&request)?)),
            "design_validate" => Ok(text(self.validate(args))),
            "design_show" | "design_apply" => {
                if name == "design_show"
                    && args.get("document").is_some() == args.get("from").is_some()
                {
                    return Err(Error::new("Send document OR from (with operations)."));
                }
                let (saved, document) = {
                    let state = &mut self.state;
                    let kit = |r: &Value| state.kits.borrow_mut().read(r);
                    let prepared = if name == "design_show" {
                        state.artifacts.prepare_design_show(&request, &kit)?
                    } else {
                        state.artifacts.prepare_design_apply(&request, &kit)?
                    };
                    let document = prepared.document().clone();
                    let mut saved =
                        state
                            .artifacts
                            .commit_design(prepared, &kit, &design::render_html)?;
                    remove(&mut saved, "html");
                    remove(&mut saved, "document");
                    (saved, document)
                };
                feedback::feedback(
                    saved,
                    &document,
                    self.raster.as_deref(),
                    None,
                    args.get("intent"),
                )
                .await
            }
            "design_inspect" => {
                let mut saved = self
                    .state
                    .artifacts
                    .get(&self.request(args, Some("design")))?;
                let document = saved["document"].clone();
                remove(&mut saved, "html");
                remove(&mut saved, "document");
                let bounds = design::layout(&document)?;
                let crop = args["nodeId"]
                    .as_str()
                    .map(|id| {
                        bounds.get(id).ok_or_else(|| {
                            Error::new(format!("Layer \"{id}\" is missing or hidden."))
                        })
                    })
                    .transpose()?;
                let crop = crop.map(|b| json!({"x":b.x,"y":b.y,"width":b.width,"height":b.height}));
                let version = saved["version"].clone();
                let mut result = feedback::feedback(
                    saved,
                    &document,
                    self.raster.as_deref(),
                    crop.as_ref(),
                    None,
                )
                .await?;
                let diagnostics = match design::diagnostics(&document) {
                    Ok(mut d) => {
                        let mut out = json!({"status":"checked"});
                        for (k, v) in d.as_object_mut().unwrap() {
                            out[k] = v.clone();
                        }
                        out
                    }
                    Err(e) => json!({"status":"failed","error":e.message}),
                };
                let mut inspection = json!({"version":version,"bounds":bounds.into_iter().map(|(k,b)|(k,json!({"x":b.x,"y":b.y,"width":b.width,"height":b.height}))).collect::<serde_json::Map<_,_>>(),"diagnostics":diagnostics,"preview":{"renderer":"resvg","remoteImages":"placeholder","unbundledFonts":feedback::families(&document),"undrawableText":feedback::undrawable(&document)}});
                if let Some(id) = args.get("nodeId") {
                    inspection["nodeId"] = id.clone();
                }
                if let Some(crop) = crop {
                    inspection["preview"]["crop"] = crop;
                }
                let line = result["content"][0]["text"].as_str().unwrap();
                result["content"][0]["text"] = json!(format!(
                    "{line}\n{}",
                    jsjson::to_string(&json!({"inspection":inspection}))
                ));
                Ok(result)
            }
            _ => Err(Error::new("Tool unavailable for this connection")),
        }
    }
    fn validate(&mut self, args: &Value) -> Value {
        let attempt = (|| -> Result<Value> {
            let document = if let Some(document) = args.get("document") {
                if ["id", "operations", "expectedVersion", "intent"]
                    .iter()
                    .any(|key| args.get(key).is_some())
                {
                    return Err(Error::new(
                        "Send document OR id, expectedVersion and operations.",
                    ));
                }
                design::validate_document(document)?
            } else {
                if ["id", "expectedVersion", "operations"]
                    .iter()
                    .any(|key| args.get(key).is_none())
                {
                    return Err(Error::new(
                        "Send document OR id, expectedVersion and operations.",
                    ));
                }
                let current = self
                    .state
                    .artifacts
                    .get(&self.request(&json!({"id":args["id"]}), Some("design")))?;
                if !jsjson::strict_equals(&current["version"], &args["expectedVersion"]) {
                    return Err(Error::new(format!(
                        "Design version conflict: expected {}, latest {}. Read again.",
                        args["expectedVersion"], current["version"]
                    )));
                }
                design::apply_operations(
                    &current["document"],
                    &args["operations"],
                    args.get("intent"),
                )?
            };
            if let Some(kit) = document.get("kit") {
                let saved = self.state.kits.borrow_mut().read(
                    &json!({"chatId":self.caller.chat_id,"id":kit["id"],"version":kit["version"]}),
                )?;
                if saved != *kit {
                    return Err(Error::new("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot."));
                }
            }
            if let Err(e) = design::validate_consistency(&document) {
                let mut error = validation_error(&e);
                if e.code == "DESIGN_KIT_DRIFT" {
                    error["diagnostics"] = design::diagnostics(&document)?;
                }
                return Ok(error);
            }
            Ok(
                json!({"valid":true,"document":document,"diagnostics":design::diagnostics(&document)?}),
            )
        })();
        match attempt {
            Ok(value) => value,
            Err(e) => validation_error(&e),
        }
    }
}
fn validation_error(e: &Error) -> Value {
    let mut value = json!({"valid":false,"errors":e.issues.as_deref().cloned().unwrap_or_else(||json!([{"path":[],"message":e.message}]))});
    if !["CONTENT_ERROR", "ENOENT"].contains(&e.code.as_str()) {
        value["code"] = json!(e.code);
    }
    if let Some(d) = e.diagnostics.as_deref() {
        value["diagnostics"] = d.clone();
    }
    value
}
fn concise(e: &Error) -> String {
    if let Some(issues) = e.issues.as_deref().and_then(Value::as_array) {
        issues
            .iter()
            .take(10)
            .map(|i| {
                let path = i["path"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|v| jsjson::property_key(Some(v)))
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                format!(
                    "{}{}",
                    if path.is_empty() {
                        path
                    } else {
                        format!("{path}: ")
                    },
                    i["message"].as_str().unwrap_or("Invalid Design")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        e.message.clone()
    }
}
