//! Ordinary (project Chat) launch planning: what `ClaudeSession.start` gives the SDK for an ordinary
//! Chat in `claude-provider.cjs`, from facts the owner supplies, plus typed turn admission.
//!
//! The session already applies the per-Chat flags every Chat gets (TODO tools env, model, mode,
//! effort, `{fastMode, ultracode}` settings, skip-permissions, partial messages, subagent text,
//! PreToolUse hook, summarized thinking, reply style). This plan adds the rest of Node's ordinary
//! launch: the appended system prompt, `settingSources`, `additionalDirectories`, the QA agents,
//! SubagentStart context and prompt suggestions. Every one is required: a missing one is refused,
//! never silently dropped. Ask/Auto/Full are admitted for Project Chats. Advisor roles,
//! account routing and user MCP extras remain outside this plan and refused (`tests/ordinary.rs`
//! and `tests/modes.rs` compare with the Node traces). Image content uses the separate `prompt_images`
//! helper and the isolated fixture's typed owner input path; this launch plan grants no image
//! storage authority. Real-provider image validation and broader image flows remain gated.
//!
//! Transport difference (kept deliberately): SDK 0.3.288 sends `appendSystemPrompt` in `initialize`;
//! this crate passes the same bytes through `--append-system-prompt-file` (a private 0600 file) and
//! settings through a private `--settings` file. Real-CLI equivalence is not verified here.

use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::launch::SystemPrompt;
use crate::session::{SessionOptions, TurnRequest};

/// Node's `settingSources` for every Chat.
pub const SETTING_SOURCES: [&str; 3] = ["user", "project", "local"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OrdinaryError {
    #[error("Advisor and execution roles need their own launch policy")]
    Role,
    #[error("The ordinary launch needs its system prompt, SubagentStart context and QA agents")]
    Missing,
    #[error("The launch already carries a system prompt, agents or setting sources")]
    Preset,
    #[error("Only the ask, auto and full permission modes are admitted")]
    Mode,
    #[error("The ordinary launch needs an absolute working directory for workspace access")]
    Workspace,
    #[error("Invalid ordinary turn setting: {0}")]
    Setting(&'static str),
}

/// The Node-required ordinary launch facts, computed by the owner (instructions, bundled agents,
/// prompt-suggestion setting, owned roots).
#[derive(Debug, Clone)]
pub struct OrdinaryLaunch {
    /// `sessionInstructions(...)` for an ordinary Chat.
    pub system_append: String,
    /// SubagentStart `additionalContext`.
    pub subagent_context: String,
    /// `QA_AGENTS` (`bundledAgents()`), in Node key order.
    pub agents: Map<String, Value>,
    pub prompt_suggestions: bool,
    /// `access.roots` minus `cwd`.
    pub additional_directories: Vec<PathBuf>,
    /// The bundled-skills directory `WorkspaceAccess` lets the agent read in every mode (Node's
    /// `BUNDLED_SKILLS_DIRECTORY`, supplied explicitly). A missing directory grants nothing.
    pub skills_directory: PathBuf,
}

impl OrdinaryLaunch {
    /// Install this plan into fresh session options. Refuses roles and preexisting overrides.
    pub fn apply(self, options: &mut SessionOptions) -> Result<(), OrdinaryError> {
        if options.analysis_only || options.execution_advisor {
            return Err(OrdinaryError::Role);
        }
        if self.system_append.is_empty() || self.subagent_context.is_empty() || self.agents.is_empty() {
            return Err(OrdinaryError::Missing);
        }
        if options.launch.system_prompt != (SystemPrompt::Preset { append: None })
            || !options.init.agents.is_empty()
            || options.launch.setting_sources.is_some()
            || options.subagent_context.is_some()
            || options.access.is_some()
        {
            return Err(OrdinaryError::Preset);
        }
        let cwd = options.launch.cwd.clone().filter(|cwd| cwd.is_absolute()).ok_or(OrdinaryError::Workspace)?;
        options.access = Some(std::sync::Arc::new(ProjectAccess { cwd, skills_directory: self.skills_directory }));
        options.launch.system_prompt = SystemPrompt::Preset { append: Some(self.system_append) };
        options.launch.setting_sources = Some(SETTING_SOURCES.map(String::from).to_vec());
        options.launch.add_dirs = self.additional_directories;
        options.init.agents = self.agents;
        options.subagent_context = Some(self.subagent_context);
        options.prompt_suggestions = self.prompt_suggestions;
        Ok(())
    }
}

/// The typed ordinary settings of one turn (`ChatSendRequest` fields the owner forwards).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrdinaryTurn {
    pub model: String,
    pub effort: Option<String>,
    pub ultracode: bool,
    pub fast_mode: bool,
    /// `"concise"` or `"normal"`; absent is Normal, as in `applyReplyStyle`.
    pub replies: Option<String>,
    /// `request.tldrEnabled !== false`; only a boolean is admitted.
    pub tldr_enabled: bool,
    /// `"ask"`, `"auto"` or `"full"`; absent or null is Ask (Node `turnMode`, then `CLAUDE_MODES` default).
    pub permission_mode: String,
}

fn flag(request: &Value, key: &'static str) -> Result<Option<bool>, OrdinaryError> {
    match request.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(OrdinaryError::Setting(key)),
    }
}

impl OrdinaryTurn {
    /// Admit only correctly typed values. Stricter than Node, which coerces: a non-boolean flag, an
    /// unknown reply style or an empty effort is refused rather than reinterpreted.
    pub fn parse(request: &Value) -> Result<Self, OrdinaryError> {
        // Node maps an unknown mode to Ask (`turnMode`); a typed refusal is stricter.
        let permission_mode = match request.get("permissionMode") {
            None | Some(Value::Null) => "ask".to_owned(),
            Some(Value::String(mode)) if ["ask", "auto", "full"].contains(&mode.as_str()) => mode.clone(),
            Some(_) => return Err(OrdinaryError::Mode),
        };
        let model = match request.get("model") {
            Some(Value::String(model)) if !model.is_empty() && model.len() <= 256 => model.clone(),
            _ => return Err(OrdinaryError::Setting("model")),
        };
        let effort = match request.get("effort") {
            None | Some(Value::Null) => None,
            Some(Value::String(effort))
                if !effort.is_empty()
                    && effort.len() <= 32
                    && effort.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_') =>
            {
                Some(effort.clone())
            }
            Some(_) => return Err(OrdinaryError::Setting("effort")),
        };
        let replies = match request.get("replies") {
            None => None,
            Some(Value::String(style)) if style == "concise" || style == "normal" => Some(style.clone()),
            Some(_) => return Err(OrdinaryError::Setting("replies")),
        };
        Ok(Self {
            model,
            effort,
            ultracode: flag(request, "ultracode")?.unwrap_or(false),
            fast_mode: flag(request, "fastMode")?.unwrap_or(false),
            replies,
            tldr_enabled: flag(request, "tldrEnabled")?.unwrap_or(true),
            permission_mode,
        })
    }

    /// The session turn for this message's content blocks.
    pub fn request(&self, content: Vec<Value>) -> TurnRequest {
        TurnRequest {
            content,
            model: self.model.clone(),
            permission_mode: Some(self.permission_mode.clone()),
            effort: self.effort.clone(),
            ultracode: self.ultracode,
            fast_mode: self.fast_mode,
            replies: self.replies.clone(),
            can_start: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_admission() {
        let ok = OrdinaryTurn::parse(&json!({"model":"sonnet","permissionMode":"ask","effort":"high","ultracode":false,"fastMode":true,"replies":"concise","tldrEnabled":false})).unwrap();
        assert_eq!((ok.fast_mode, ok.tldr_enabled, ok.replies.as_deref()), (true, false, Some("concise")));
        let defaults = OrdinaryTurn::parse(&json!({"model":"sonnet"})).unwrap();
        assert_eq!((defaults.ultracode, defaults.fast_mode, defaults.tldr_enabled, defaults.replies), (false, false, true, None));
        for (key, value) in [
            ("permissionMode", json!("plan")),
            ("permissionMode", json!("Full")),
            ("permissionMode", json!(true)),
            ("tldrEnabled", json!("no")),
            ("tldrEnabled", json!(null)),
            ("fastMode", json!(1)),
            ("ultracode", json!(null)),
            ("replies", json!("verbose")),
            ("replies", json!([])),
            ("effort", json!("")),
            ("effort", json!("High")),
            ("model", json!(null)),
        ] {
            let mut request = json!({"model":"sonnet"});
            request[key] = value;
            assert!(OrdinaryTurn::parse(&request).is_err(), "{request}");
        }
    }

    #[test]
    fn launch_plan_refuses_roles_missing_facts_and_overrides() {
        let plan = OrdinaryLaunch {
            system_append: "x".into(),
            subagent_context: "y".into(),
            agents: json!({"qa":{"description":"d","prompt":"p"}}).as_object().unwrap().clone(),
            prompt_suggestions: false,
            additional_directories: vec![],
            skills_directory: PathBuf::from("/nonexistent-skills"),
        };
        let fresh = || SessionOptions::new(crate::launch::LaunchOptions::new("/bin/claude"));
        let mut options = fresh();
        options.execution_advisor = true;
        assert_eq!(plan.clone().apply(&mut options), Err(OrdinaryError::Role));
        let mut empty = plan.clone();
        empty.agents.clear();
        assert_eq!(empty.apply(&mut fresh()), Err(OrdinaryError::Missing));
        let mut options = fresh();
        options.launch.setting_sources = Some(vec![]);
        assert_eq!(plan.clone().apply(&mut options), Err(OrdinaryError::Preset));
        let mut options = fresh();
        assert_eq!(plan.clone().apply(&mut options), Err(OrdinaryError::Workspace), "a relative or missing cwd is refused");
        let mut options = fresh();
        options.launch.cwd = Some("/fixture".into());
        plan.apply(&mut options).unwrap();
        assert!(options.access.is_some());
        assert_eq!(options.launch.setting_sources.as_deref(), Some(&SETTING_SOURCES.map(String::from)[..]));
        assert!(!options.prompt_suggestions);
    }
}

/// `WorkspaceAccess` for a Project Chat (packages/core/src/agents/permissions.cjs): no Link roots,
/// no read-only roots, so `answer` only allows reads inside the bundled-skills directory, in every
/// mode. Paths follow Node's `insideWorkspace`: `path.resolve(cwd, file)` lexically, then realpath,
/// a missing tail joined to its resolved parent, any other resolution error refusing. Shared-Link
/// roots, read-only checkouts and late-root learning are not ported; such Chats are refused upstream.
#[derive(Debug, Clone)]
pub struct ProjectAccess {
    pub cwd: PathBuf,
    pub skills_directory: PathBuf,
}

impl crate::session::AccessPolicy for ProjectAccess {
    fn answer(&self, kind: &str, files: &[String], _mode: &str) -> Option<crate::session::AccessDecision> {
        (kind == "read" && inside_workspace(&[self.skills_directory.as_path()], files, &self.cwd))
            .then(|| crate::session::AccessDecision::Allow { learn: vec![] })
    }
}

/// Node `path.resolve(base, file)` on POSIX: lexical, `..` folded, never touching the filesystem.
pub fn js_resolve(base: &std::path::Path, file: &str) -> PathBuf {
    let joined = if file.starts_with('/') { PathBuf::from(file) } else { base.join(file) };
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for component in joined.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_owned()),
            std::path::Component::ParentDir => {
                parts.pop();
            }
            _ => {}
        }
    }
    let mut out = PathBuf::from("/");
    out.extend(parts);
    out
}

/// Node `insideWorkspace(roots, files, cwd)`.
pub fn inside_workspace(roots: &[&std::path::Path], files: &[String], cwd: &std::path::Path) -> bool {
    fn resolve(path: &std::path::Path) -> std::io::Result<PathBuf> {
        match std::fs::canonicalize(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(error) };
                Ok(resolve(parent)?.join(name))
            }
            other => other,
        }
    }
    let Ok(roots) = roots.iter().map(std::fs::canonicalize).collect::<Result<Vec<_>, _>>() else { return false };
    !files.is_empty()
        && files.iter().all(|file| {
            if !cwd.is_absolute() {
                return false;
            }
            let Ok(resolved) = resolve(&js_resolve(cwd, file)) else { return false };
            roots.iter().any(|root| resolved != *root && resolved.starts_with(root))
        })
}

/// Expected native CLI frames for a recorded Node `sdk.query` call (the ordinary trace from
/// `scripts/generate-session.cjs`), as fake-claude script steps. Each Node option key must be mapped
/// to a CLI flag, an `initialize` field or an explicit exclusion; an unmapped key is an error, so a
/// new Node option cannot be dropped silently. The mapping mirrors `launch.rs` (`cwd` and the
/// executable path are the caller's own process facts, compared separately).
pub mod node_trace {
    use serde_json::{json, Map, Value};

    use crate::session::{PRE_TOOL_USE_HOOK, SUBAGENT_START_HOOK};

    const MAPPED: [&str; 16] = [
        "env",
        "cwd",
        "model",
        "permissionMode",
        "effort",
        "settings",
        "allowDangerouslySkipPermissions",
        "includePartialMessages",
        "forwardSubagentText",
        "promptSuggestions",
        "pathToClaudeCodeExecutable",
        "settingSources",
        "systemPrompt",
        "hooks",
        "agents",
        "resume",
    ];
    const FUNCTIONS: [&str; 2] = ["canUseTool", "spawnClaudeCodeProcess"];

    fn hook_id(name: &str) -> Result<&'static str, String> {
        match name {
            "SubagentStart" => Ok(SUBAGENT_START_HOOK),
            "PreToolUse" => Ok(PRE_TOOL_USE_HOOK),
            other => Err(format!("unmapped Node hook {other}")),
        }
    }

    /// `expect_launch` plus the `initialize` check and its reply, for one recorded query.
    pub fn launch_steps(query: &Value) -> Result<Vec<Value>, String> {
        let options = query["options"].as_object().ok_or("query without options")?;
        if let Some(key) = options.keys().find(|key| !MAPPED.contains(&key.as_str())) {
            return Err(format!("unmapped Node option {key}"));
        }
        let functions: Vec<&str> = query["functions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if functions != FUNCTIONS {
            return Err(format!("unmapped Node callbacks {functions:?}"));
        }
        let prompt = &options["systemPrompt"];
        if prompt["type"] != "preset" || prompt["preset"] != "claude_code" || !prompt["append"].is_string() {
            return Err("only the claude_code preset with appended text is mapped".into());
        }
        let text = |key: &str| options.get(key).and_then(Value::as_str);
        let mut pairs = vec![json!(["--permission-prompt-tool", "stdio"])];
        for (key, flag) in [("model", "--model"), ("permissionMode", "--permission-mode"), ("effort", "--effort")] {
            match options.get(key) {
                Some(Value::String(value)) => pairs.push(json!([flag, value])),
                None => {}
                Some(_) => return Err(format!("non-string {key}")),
            }
        }
        let mut flags = Vec::new();
        let mut absent = vec![json!("--append-system-prompt"), json!("--system-prompt")];
        for (key, flag) in [
            ("allowDangerouslySkipPermissions", "--allow-dangerously-skip-permissions"),
            ("includePartialMessages", "--include-partial-messages"),
        ] {
            if options.get(key) == Some(&Value::Bool(true)) {
                flags.push(json!(flag));
            } else {
                absent.push(json!(flag));
            }
        }
        let sources: Vec<&str> = options["settingSources"].as_array().ok_or("settingSources")?.iter().filter_map(Value::as_str).collect();
        flags.push(json!(format!("--setting-sources={}", sources.join(","))));
        match text("resume") {
            Some(id) => flags.push(json!(format!("--resume={id}"))),
            None => absent.push(json!("--resume")),
        }
        let settings = query["settingsText"].as_str().ok_or("settingsText")?;
        let launch = json!({"expect_launch": {
            "pairs": pairs,
            "flags": flags,
            "absent": absent,
            "env": options["env"],
            "files": {"--append-system-prompt-file": prompt["append"], "--settings": settings},
        }});
        let mut fields = Map::new();
        fields.insert("/request/agents".into(), options["agents"].clone());
        fields.insert("/request/promptSuggestions".into(), options["promptSuggestions"].clone());
        fields.insert("/request/forwardSubagentText".into(), options["forwardSubagentText"].clone());
        for (name, matchers) in options["hooks"].as_object().ok_or("hooks")? {
            if matchers.as_array().map(Vec::len) != Some(1) {
                return Err(format!("{name}: one matcher expected"));
            }
            fields.insert(format!("/request/hooks/{name}/0/hookCallbackIds/0"), json!(hook_id(name)?));
        }
        Ok(vec![launch, json!({"expect": {"type": "control_request", "subtype": "initialize", "fields": fields}}), json!({"reply": {}})])
    }

    /// Hook callbacks answered exactly as Node's recorded hook functions answered.
    pub fn hook_steps(query: &Value) -> Result<Vec<Value>, String> {
        let mut steps = Vec::new();
        for (name, output, input) in [
            ("SubagentStart", &query["subagentStart"], json!({"hook_event_name": "SubagentStart"})),
            (
                "PreToolUse",
                &query["preToolUse"],
                json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}}),
            ),
        ] {
            let id = format!("node-{name}");
            steps.push(
                json!({"request": {"id": id, "request": {"subtype": "hook_callback", "callback_id": hook_id(name)?, "input": input}}}),
            );
            steps.push(
                json!({"expect": {"type": "control_response", "fields": {"/response/request_id": id, "/response/response": output}}}),
            );
        }
        Ok(steps)
    }

    /// The recorded control calls and user messages, in order. `turn(index)` supplies the CLI's
    /// frames after the index-th user message.
    pub fn control_steps(controls: &[Value], mut turn: impl FnMut(usize) -> Vec<Value>) -> Result<Vec<Value>, String> {
        let mut steps = Vec::new();
        let mut users = 0;
        for control in controls {
            let (name, args) = control.as_object().and_then(|o| o.iter().next()).ok_or("empty control")?;
            let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
            let expect = |subtype: &str, fields: Value| {
                [json!({"expect": {"type": "control_request", "subtype": subtype, "fields": fields}}), json!({"reply": {}})]
            };
            match name.as_str() {
                "setMaxThinkingTokens" => steps.extend(expect(
                    "set_max_thinking_tokens",
                    json!({"/request/max_thinking_tokens": arg(0), "/request/thinking_display": arg(1)}),
                )),
                "applyFlagSettings" => steps.extend(expect("apply_flag_settings", json!({"/request/settings": arg(0)}))),
                "setModel" => steps.extend(expect("set_model", json!({"/request/model": arg(0)}))),
                "setPermissionMode" => steps.extend(expect("set_permission_mode", json!({"/request/mode": arg(0)}))),
                "toggleMcpServer" => steps.extend(expect("mcp_toggle", json!({"/request/serverName": arg(0), "/request/enabled": arg(1)}))),
                "user" => {
                    steps.push(json!({"expect": {"type": "user", "fields": {"/message/content": args}}}));
                    steps.extend(turn(users));
                    users += 1;
                }
                other => return Err(format!("unmapped Node control {other}")),
            }
        }
        Ok(steps)
    }
}
