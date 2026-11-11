//! How the Claude Code CLI is started and what the `initialize` control request carries.
//!
//! Argument rules follow the public Python SDK's `SubprocessCLITransport._build_command` and the
//! documented CLI flags (`claude --help`, 2.1.322): always `--output-format stream-json --verbose
//! --input-format stream-json`; a host that answers permission prompts passes `--permission-prompt-tool
//! stdio` (Python `types.py`, the canUseTool path) so `can_use_tool` control requests reach stdin/stdout.
//! Agents, hooks, prompt suggestions and subagent text forwarding travel in `initialize`, as both SDKs do.

use std::ffi::OsString;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

/// The value `CLAUDE_CODE_ENTRYPOINT` gets. Milagre ships with the TS SDK, whose value is `sdk-ts`; the
/// Python SDK uses `sdk-py`. The CLI reads it for telemetry and SDK-specific behavior.
pub const DEFAULT_ENTRYPOINT: &str = "sdk-ts";

#[derive(Debug, Clone, PartialEq)]
pub enum SystemPrompt {
    /// The CLI's own `claude_code` prompt, optionally with text appended (`--append-system-prompt`).
    Preset { append: Option<String> },
    /// Replace the prompt entirely (`--system-prompt`).
    Custom(String),
}

/// Everything decided before the process starts. Defaults match a plain SDK query.
#[derive(Debug, Clone)]
pub struct LaunchOptions {
    /// Absolute path of the CLI executable (Milagre: `pathToClaudeCodeExecutable`).
    pub program: PathBuf,
    pub cwd: Option<PathBuf>,
    /// The complete environment when set; otherwise this process's environment is inherited.
    pub env: Option<Vec<(OsString, OsString)>>,
    /// Extra variables layered on top (Milagre: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`).
    pub env_overrides: Vec<(OsString, OsString)>,
    pub entrypoint: String,
    /// Sets `CLAUDE_AGENT_SDK_VERSION`. Left unset when `None`; the CLI then reports no SDK version.
    pub sdk_version: Option<String>,
    pub model: Option<String>,
    pub fallback_model: Option<String>,
    /// Wire value: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`.
    pub permission_mode: Option<String>,
    pub allow_dangerously_skip_permissions: bool,
    pub effort: Option<String>,
    /// `--settings` JSON (flag-layer settings, e.g. `{"fastMode":false}`).
    pub settings: Option<Value>,
    pub setting_sources: Option<Vec<String>>,
    pub add_dirs: Vec<PathBuf>,
    pub system_prompt: SystemPrompt,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    /// `--mcp-config {"mcpServers": ...}`. In-process servers appear as `{"type":"sdk","name":..}`.
    pub mcp_servers: Map<String, Value>,
    pub strict_mcp_config: bool,
    pub include_partial_messages: bool,
    pub include_hook_events: bool,
    /// `--resume=<id>` (equals form so an id can never be read as a flag).
    pub resume: Option<String>,
    pub session_id: Option<String>,
    pub fork_session: bool,
    pub no_session_persistence: bool,
    pub max_thinking_tokens: Option<u64>,
    pub thinking_display: Option<String>,
    /// Route permission prompts to this host (`--permission-prompt-tool stdio`).
    pub permission_prompts_to_host: bool,
    /// Flags not modelled above: `(flag without --, value)`. A value starting with `-` uses `--flag=value`.
    pub extra_args: Vec<(String, Option<String>)>,
}

impl LaunchOptions {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            cwd: None,
            env: None,
            env_overrides: Vec::new(),
            entrypoint: DEFAULT_ENTRYPOINT.into(),
            sdk_version: None,
            model: None,
            fallback_model: None,
            permission_mode: None,
            allow_dangerously_skip_permissions: false,
            effort: None,
            settings: None,
            setting_sources: None,
            add_dirs: Vec::new(),
            system_prompt: SystemPrompt::Preset { append: None },
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            mcp_servers: Map::new(),
            strict_mcp_config: false,
            include_partial_messages: false,
            include_hook_events: false,
            resume: None,
            session_id: None,
            fork_session: false,
            no_session_persistence: false,
            max_thinking_tokens: None,
            thinking_display: None,
            permission_prompts_to_host: true,
            extra_args: Vec::new(),
        }
    }

    /// Register an in-process MCP server: the CLI reaches it through `mcp_message` control requests.
    pub fn sdk_mcp_server(mut self, name: &str) -> Self {
        self.mcp_servers.insert(name.into(), json!({ "type": "sdk", "name": name }));
        self
    }

    pub fn sdk_mcp_server_names(&self) -> Vec<String> {
        self.mcp_servers
            .iter()
            .filter(|(_, config)| config.get("type").and_then(Value::as_str) == Some("sdk"))
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// The argument vector after the program.
    pub fn args(&self) -> Vec<String> {
        let mut args: Vec<String> = ["--output-format", "stream-json", "--verbose"].map(String::from).to_vec();
        let mut pair = |flag: &str, value: String| {
            args.push(flag.into());
            args.push(value);
        };
        match &self.system_prompt {
            SystemPrompt::Preset { append: Some(text) } => pair("--append-system-prompt", text.clone()),
            SystemPrompt::Preset { append: None } => {}
            SystemPrompt::Custom(text) => pair("--system-prompt", text.clone()),
        }
        if !self.allowed_tools.is_empty() {
            pair("--allowedTools", self.allowed_tools.join(","));
        }
        if !self.disallowed_tools.is_empty() {
            pair("--disallowedTools", self.disallowed_tools.join(","));
        }
        if let Some(model) = &self.model {
            pair("--model", model.clone());
        }
        if let Some(model) = &self.fallback_model {
            pair("--fallback-model", model.clone());
        }
        if self.permission_prompts_to_host {
            pair("--permission-prompt-tool", "stdio".into());
        }
        if let Some(mode) = &self.permission_mode {
            pair("--permission-mode", mode.clone());
        }
        if let Some(settings) = &self.settings {
            pair("--settings", settings.to_string());
        }
        for dir in &self.add_dirs {
            pair("--add-dir", dir.to_string_lossy().into_owned());
        }
        if !self.mcp_servers.is_empty() {
            pair("--mcp-config", json!({ "mcpServers": self.mcp_servers }).to_string());
        }
        if let Some(effort) = &self.effort {
            pair("--effort", effort.clone());
        }
        if let Some(tokens) = self.max_thinking_tokens {
            pair("--max-thinking-tokens", tokens.to_string());
        }
        if let Some(display) = &self.thinking_display {
            pair("--thinking-display", display.clone());
        }
        let mut flags: Vec<String> = Vec::new();
        if self.allow_dangerously_skip_permissions {
            flags.push("--allow-dangerously-skip-permissions".into());
        }
        if self.include_partial_messages {
            flags.push("--include-partial-messages".into());
        }
        if self.include_hook_events {
            flags.push("--include-hook-events".into());
        }
        if self.strict_mcp_config {
            flags.push("--strict-mcp-config".into());
        }
        if let Some(id) = &self.resume {
            flags.push(format!("--resume={id}"));
        }
        if let Some(id) = &self.session_id {
            flags.push(format!("--session-id={id}"));
        }
        if self.fork_session {
            flags.push("--fork-session".into());
        }
        if self.no_session_persistence {
            flags.push("--no-session-persistence".into());
        }
        if let Some(sources) = &self.setting_sources {
            flags.push(format!("--setting-sources={}", sources.join(",")));
        }
        for (flag, value) in &self.extra_args {
            match value {
                None => flags.push(format!("--{flag}")),
                Some(value) if value.starts_with('-') => flags.push(format!("--{flag}={value}")),
                Some(value) => {
                    flags.push(format!("--{flag}"));
                    flags.push(value.clone());
                }
            }
        }
        args.extend(flags);
        // Streaming input always; the CLI then waits for `initialize` and user frames on stdin.
        args.push("--input-format".into());
        args.push("stream-json".into());
        args
    }

    /// The environment the CLI gets: base (inherited or explicit) minus `CLAUDECODE` (so the CLI does not
    /// think it runs inside a Claude Code parent), plus the entrypoint, overrides and SDK version.
    pub fn environment(&self) -> Vec<(OsString, OsString)> {
        let base: Vec<(OsString, OsString)> = match &self.env {
            Some(env) => env.clone(),
            None => std::env::vars_os().collect(),
        };
        let mut env: Vec<(OsString, OsString)> = base.into_iter().filter(|(key, _)| key != "CLAUDECODE").collect();
        let mut set = |key: &str, value: OsString| {
            env.retain(|(existing, _)| existing != key);
            env.push((key.into(), value));
        };
        set("CLAUDE_CODE_ENTRYPOINT", self.entrypoint.clone().into());
        for (key, value) in &self.env_overrides {
            set(&key.to_string_lossy(), value.clone());
        }
        if let Some(version) = &self.sdk_version {
            set("CLAUDE_AGENT_SDK_VERSION", version.clone().into());
        }
        if let Some(cwd) = &self.cwd {
            set("PWD", cwd.clone().into_os_string());
        }
        env
    }
}

/// One hook matcher: the CLI sends `hook_callback` with one of `callback_ids` when it fires.
#[derive(Debug, Clone, PartialEq)]
pub struct HookMatcher {
    pub matcher: Option<String>,
    /// Ids chosen by the owner; the HookHandler is called with them.
    pub callback_ids: Vec<String>,
    /// Seconds.
    pub timeout: Option<u64>,
}

/// The `initialize` control request (`SDKControlInitializeRequest`).
#[derive(Debug, Clone, Default)]
pub struct InitializeOptions {
    /// Hook event name (`PreToolUse`, `SubagentStart`, ...) to matchers, in order.
    pub hooks: Vec<(String, Vec<HookMatcher>)>,
    /// Names of in-process MCP servers (also listed in `LaunchOptions::mcp_servers` with type `sdk`).
    pub sdk_mcp_servers: Vec<String>,
    /// `AgentDefinition`s by name, raw.
    pub agents: Map<String, Value>,
    pub prompt_suggestions: Option<bool>,
    pub forward_subagent_text: Option<bool>,
    pub agent_progress_summaries: Option<bool>,
    pub exclude_dynamic_sections: Option<bool>,
    pub system_prompt_snapshot: Option<bool>,
    pub skills: Option<Vec<String>>,
    pub title: Option<String>,
    /// Fields not modelled above, merged last.
    pub extra: Map<String, Value>,
}

impl InitializeOptions {
    pub fn request(&self) -> Value {
        let mut request = Map::new();
        request.insert("subtype".into(), "initialize".into());
        let hooks: Map<String, Value> = self
            .hooks
            .iter()
            .filter(|(_, matchers)| !matchers.is_empty())
            .map(|(event, matchers)| {
                let list = matchers
                    .iter()
                    .map(|m| {
                        let mut entry = Map::new();
                        entry.insert("matcher".into(), m.matcher.clone().map(Value::from).unwrap_or(Value::Null));
                        entry.insert("hookCallbackIds".into(), json!(m.callback_ids));
                        if let Some(timeout) = m.timeout {
                            entry.insert("timeout".into(), json!(timeout));
                        }
                        Value::Object(entry)
                    })
                    .collect();
                (event.clone(), Value::Array(list))
            })
            .collect();
        request.insert("hooks".into(), if hooks.is_empty() { Value::Null } else { Value::Object(hooks) });
        if !self.sdk_mcp_servers.is_empty() {
            request.insert("sdkMcpServers".into(), json!(self.sdk_mcp_servers));
        }
        if !self.agents.is_empty() {
            request.insert("agents".into(), Value::Object(self.agents.clone()));
        }
        let mut opt = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                request.insert(key.into(), value);
            }
        };
        opt("promptSuggestions", self.prompt_suggestions.map(Value::from));
        opt("forwardSubagentText", self.forward_subagent_text.map(Value::from));
        opt("agentProgressSummaries", self.agent_progress_summaries.map(Value::from));
        opt("excludeDynamicSections", self.exclude_dynamic_sections.map(Value::from));
        opt("systemPromptSnapshot", self.system_prompt_snapshot.map(Value::from));
        opt("skills", self.skills.as_ref().map(|skills| json!(skills)));
        opt("title", self.title.clone().map(Value::from));
        for (key, value) in &self.extra {
            request.insert(key.clone(), value.clone());
        }
        Value::Object(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_args_are_streaming_both_ways_with_host_prompts() {
        let args = LaunchOptions::new("/bin/claude").args();
        assert_eq!(
            args,
            ["--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--input-format", "stream-json"]
        );
    }

    #[test]
    fn milagre_like_args() {
        let mut options = LaunchOptions::new("/bin/claude").sdk_mcp_server("milagre");
        options.model = Some("opus".into());
        options.permission_mode = Some("default".into());
        options.allow_dangerously_skip_permissions = true;
        options.include_partial_messages = true;
        options.setting_sources = Some(vec!["user".into(), "project".into(), "local".into()]);
        options.system_prompt = SystemPrompt::Preset { append: Some("be brief".into()) };
        options.settings = Some(json!({"fastMode": false}));
        options.resume = Some("-weird".into());
        options.add_dirs = vec!["/a".into()];
        options.allowed_tools = vec!["mcp__milagre__tasks_read".into()];
        options.extra_args = vec![("debug".into(), None), ("x".into(), Some("-y".into()))];
        let args = options.args();
        let joined = args.join(" ");
        for expected in [
            "--append-system-prompt be brief",
            "--model opus",
            "--permission-mode default",
            "--settings {\"fastMode\":false}",
            "--add-dir /a",
            "--allowedTools mcp__milagre__tasks_read",
            "--mcp-config {\"mcpServers\":{\"milagre\":{\"type\":\"sdk\",\"name\":\"milagre\"}}}",
            "--allow-dangerously-skip-permissions",
            "--include-partial-messages",
            "--resume=-weird",
            "--setting-sources=user,project,local",
            "--debug",
            "--x=-y",
        ] {
            assert!(joined.contains(expected), "missing {expected} in {joined}");
        }
        assert_eq!(&args[args.len() - 2..], ["--input-format", "stream-json"]);
        assert_eq!(options.sdk_mcp_server_names(), ["milagre"]);
    }

    #[test]
    fn environment_drops_claudecode_and_sets_entrypoint() {
        let mut options = LaunchOptions::new("/bin/claude");
        options.env =
            Some(vec![("CLAUDECODE".into(), "1".into()), ("CLAUDE_CODE_ENTRYPOINT".into(), "cli".into()), ("A".into(), "1".into())]);
        options.env_overrides = vec![("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())];
        let env = options.environment();
        assert!(!env.iter().any(|(k, _)| k == "CLAUDECODE"));
        assert!(env.contains(&("CLAUDE_CODE_ENTRYPOINT".into(), "sdk-ts".into())));
        assert!(env.contains(&("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())));
        assert!(env.contains(&("A".into(), "1".into())));
    }

    #[test]
    fn initialize_request_shape() {
        let mut options = InitializeOptions::default();
        assert_eq!(options.request(), json!({"subtype":"initialize","hooks":null}));
        options.hooks =
            vec![("PreToolUse".into(), vec![HookMatcher { matcher: None, callback_ids: vec!["guard".into()], timeout: Some(30) }])];
        options.sdk_mcp_servers = vec!["milagre".into()];
        options.prompt_suggestions = Some(true);
        options.forward_subagent_text = Some(true);
        options.agents.insert("qa".into(), json!({"description":"d","prompt":"p"}));
        assert_eq!(
            options.request(),
            json!({"subtype":"initialize",
                   "hooks":{"PreToolUse":[{"matcher":null,"hookCallbackIds":["guard"],"timeout":30}]},
                   "sdkMcpServers":["milagre"],"agents":{"qa":{"description":"d","prompt":"p"}},
                   "promptSuggestions":true,"forwardSubagentText":true})
        );
    }
}
