//! The GPUI edge: the client's raw `serde_json::Value` bodies decoded into the GPUI crate's domain types.
//!
//! The client preserves bodies as JSON; the GPUI types are not client DTOs, so every field is read here by its wire
//! name (`packages/shared/src/model.ts`, `agent-runs.d.mts`). A field that is present with the wrong type is an
//! error naming its path, never a default. An absent optional field is `None`/`false`/empty, as the TypeScript reads
//! it. Nested shapes this stage does not decode yet are listed in README.md ("Daemon adapter"); where dropping one
//! would change what a screen shows (a subagent's transcript, a run step's artifact), the shape is kept out
//! explicitly and named there, never invented.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result, anyhow, bail};
use gpui::SharedString;
use milagre_gpui_spike::data::{
    AgentQuestion, AgentRun, AgentTask, AnsweredQuestion, ArtifactRef, BackgroundTask, BugReport, Chat, ChatContext, ChatId, ChatMessage,
    ChatRuns, ChatStep, ChatSummary, ContextUsage, DelegationTarget, DiffStat, FormerWorktree, ImageAttachment, LOCAL, MessagePage,
    OpenProject, Outcome, PermissionKind, PermissionMode, PermissionRequest, PersistenceFailure, Project, ProjectKind, Provider,
    QuestionOption, QuestionRequest, QueuedMessage, Role, RoutineRef, ScopeState, SecretRequest, SentAnswer, SessionStatus, SharedChat,
    StateRead, StateStamp, StepKind, StepStatus, Subagent, SubagentStatus, Suggestion, TaskStatus, Worktree, WorktreeId,
};
use serde_json::{Map, Value};

/// One JSON object and the path it sits at, for error messages.
struct Obj<'a> {
    map: &'a Map<String, Value>,
    path: String,
}

fn obj<'a>(value: &'a Value, path: &str) -> Result<Obj<'a>> {
    value.as_object().map(|map| Obj { map, path: path.to_owned() }).ok_or_else(|| anyhow!("{path}: expected an object"))
}

impl<'a> Obj<'a> {
    /// The field, `None` when absent or `null`.
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|value| !value.is_null())
    }
    fn err(&self, key: &str, what: &str) -> anyhow::Error {
        anyhow!("{}.{key}: expected {what}", self.path)
    }
    fn opt_str(&self, key: &str) -> Result<Option<SharedString>> {
        self.get(key)
            .map(|value| value.as_str().map(|s| SharedString::from(s.to_owned())).ok_or_else(|| self.err(key, "a string")))
            .transpose()
    }
    fn str(&self, key: &str) -> Result<SharedString> {
        self.opt_str(key)?.ok_or_else(|| self.err(key, "a string"))
    }
    fn opt_u64(&self, key: &str) -> Result<Option<u64>> {
        self.get(key).map(|value| value.as_u64().ok_or_else(|| self.err(key, "an unsigned integer"))).transpose()
    }
    fn u64(&self, key: &str) -> Result<u64> {
        self.opt_u64(key)?.ok_or_else(|| self.err(key, "an unsigned integer"))
    }
    fn opt_i64(&self, key: &str) -> Result<Option<i64>> {
        self.get(key).map(|value| value.as_i64().ok_or_else(|| self.err(key, "an integer"))).transpose()
    }
    fn i64(&self, key: &str) -> Result<i64> {
        self.opt_i64(key)?.ok_or_else(|| self.err(key, "an integer"))
    }
    fn opt_f64(&self, key: &str) -> Result<Option<f64>> {
        self.get(key).map(|value| value.as_f64().ok_or_else(|| self.err(key, "a number"))).transpose()
    }
    fn flag(&self, key: &str) -> Result<bool> {
        self.get(key).map(|value| value.as_bool().ok_or_else(|| self.err(key, "a boolean"))).transpose().map(|v| v.unwrap_or(false))
    }
    fn opt_flag(&self, key: &str) -> Result<Option<bool>> {
        self.get(key).map(|value| value.as_bool().ok_or_else(|| self.err(key, "a boolean"))).transpose()
    }
    fn array(&self, key: &str) -> Result<&'a [Value]> {
        match self.get(key) {
            None => Ok(&[]),
            Some(value) => value.as_array().map(Vec::as_slice).ok_or_else(|| self.err(key, "an array")),
        }
    }
    fn strings(&self, key: &str) -> Result<Vec<SharedString>> {
        self.array(key)?
            .iter()
            .map(|value| value.as_str().map(|s| SharedString::from(s.to_owned())).ok_or_else(|| self.err(key, "strings")))
            .collect()
    }
    fn child(&self, key: &str) -> Result<Option<Obj<'a>>> {
        self.get(key).map(|value| obj(value, &format!("{}.{key}", self.path))).transpose()
    }
    /// Each element of an array field, decoded with its index in the path.
    fn each<T>(&self, key: &str, decode: impl Fn(&Value, &str) -> Result<T>) -> Result<Vec<T>> {
        self.array(key)?.iter().enumerate().map(|(ix, value)| decode(value, &format!("{}.{key}[{ix}]", self.path))).collect()
    }
}

fn enum_of<T>(value: Option<SharedString>, path: &str, key: &str, parse: impl Fn(&str) -> Option<T>) -> Result<Option<T>> {
    value.map(|v| parse(&v).ok_or_else(|| anyhow!("{path}.{key}: unknown value {v:?}"))).transpose()
}

fn outcome(value: &str) -> Option<Outcome> {
    Some(match value {
        "completed" => Outcome::Completed,
        "failed" => Outcome::Failed,
        "cancelled" => Outcome::Cancelled,
        _ => return None,
    })
}

fn permission_mode(value: &str) -> Option<PermissionMode> {
    Some(match value {
        "ask" => PermissionMode::Ask,
        "auto" => PermissionMode::Auto,
        "full" => PermissionMode::Full,
        _ => return None,
    })
}

fn provider(value: &str) -> Option<Provider> {
    Provider::from_id(value)
}

// ---- Projects and state ----

/// `project:current`, `project:open`, `project:read`: `OpenProject` (or `ProjectRead` without `state`) on this
/// computer. `version`/`epoch` are the stamp; absent ones stay `None` (the fixture's `project:current` has none).
pub fn open_project(body: &Value) -> Result<OpenProject> {
    let o = obj(body, "project")?;
    let project = Project {
        path: o.str("path")?,
        name: o.str("name")?,
        git: o.opt_flag("git")?.unwrap_or(true),
        kind: ProjectKind::from_wire(o.opt_str("kind")?.as_deref()),
        hidden: o.flag("hidden")?,
        origin: o.opt_str("origin")?,
        opened_at: o.opt_str("openedAt")?,
        computer: LOCAL.into(),
        tile: None,
    };
    let state = o.get("state").map(|state| scope_state(state, "project.state")).transpose()?;
    Ok(OpenProject { project, state, stamp: stamp(o.get("version"), o.get("epoch"), "project")? })
}

pub(crate) fn stamp(version: Option<&Value>, epoch: Option<&Value>, path: &str) -> Result<StateStamp> {
    let version = version.map(|v| v.as_u64().ok_or_else(|| anyhow!("{path}.version: expected an unsigned integer"))).transpose()?;
    let epoch = epoch
        .map(|v| v.as_str().map(|s| SharedString::from(s.to_owned())).ok_or_else(|| anyhow!("{path}.epoch: expected a string")))
        .transpose()?;
    Ok(StateStamp { version, epoch })
}

/// `state:read` as the client returns it (`StateRead { state, version, epoch }`).
pub fn state_read(read: &milagre_daemon_client::StateRead) -> Result<StateRead> {
    Ok(StateRead { state: scope_state(&read.state, "state")?, stamp: stamp(Some(&read.version), Some(&read.epoch), "state")? })
}

/// `CoordinatorState`, lean. `projects`, `tasks`, `name` and the legacy `messages` array are not read by any screen.
pub fn scope_state(value: &Value, path: &str) -> Result<ScopeState> {
    let o = obj(value, path)?;
    let persistence = o
        .child("persistence")?
        .map(|p| -> Result<_> { Ok(PersistenceFailure { error: p.str("error")?, code: p.opt_str("code")?, saving: p.flag("saving")? }) })
        .transpose()?;
    let mut worktrees = BTreeMap::new();
    if let Some(map) = o.child("worktrees")? {
        for (key, value) in map.map {
            let worktree = worktree(value, &format!("state.worktrees.{key}"))?;
            check_key(key, worktree.id, "state.worktrees")?;
            worktrees.insert(worktree.id, worktree);
        }
    }
    let mut sessions = BTreeMap::new();
    if let Some(map) = o.child("sessions")? {
        for (key, value) in map.map {
            let chat = chat(value, &format!("state.sessions.{key}"))?;
            check_key(key, chat.id, "state.sessions")?;
            sessions.insert(chat.id, chat);
        }
    }
    Ok(ScopeState { persistence, messages_in_chats: o.flag("messagesInChats")?, next_id: o.u64("next_id")?, worktrees, sessions })
}

fn check_key(key: &str, id: u64, path: &str) -> Result<()> {
    if key.parse::<u64>().ok() != Some(id) {
        bail!("{path}.{key}: key does not match its id {id}");
    }
    Ok(())
}

fn worktree(value: &Value, path: &str) -> Result<Worktree> {
    let o = obj(value, path)?;
    let mut worktree = Worktree::new(o.u64("id")? as WorktreeId, o.u64("project_id")?, o.str("path")?, o.str("name")?);
    worktree.base = o.opt_str("base")?;
    worktree.generated_branch = o.opt_str("generatedBranch")?;
    worktree.linear_unlinked = o.map.get("linearIssue").is_some_and(Value::is_null);
    worktree.linear_issue = o.opt_str("linearIssue")?;
    worktree.linear_workspace = o.opt_str("linearWorkspace")?;
    worktree.diff =
        o.child("diff")?.map(|d| -> Result<_> { Ok(DiffStat { added: d.u64("added")?, removed: d.u64("removed")? }) }).transpose()?;
    worktree.shared_chat = o
        .child("sharedChat")?
        .map(|s| -> Result<_> { Ok(SharedChat { link_id: s.str("linkId")?, session_id: s.u64("sessionId")? }) })
        .transpose()?;
    Ok(worktree)
}

/// `AgentSession`.
pub fn chat(value: &Value, path: &str) -> Result<Chat> {
    let o = obj(value, path)?;
    let mut chat = Chat::new(o.u64("id")? as ChatId, o.u64("worktree_id")?, o.str("agent_name")?);
    chat.status = enum_of(o.opt_str("status")?, path, "status", |s| {
        Some(match s {
            "Created" => SessionStatus::Created,
            "Running" => SessionStatus::Running,
            "Stopped" => SessionStatus::Stopped,
            _ => return None,
        })
    })?
    .unwrap_or_default();
    chat.summary = o.child("summary")?.map(summary).transpose()?;
    chat.provider_id = o.opt_str("provider")?;
    chat.native_session_id = o.opt_str("native_session_id")?;
    chat.subagents = o.each("subagents", subagent)?;
    chat.background_tasks = o.each("backgroundTasks", |value, path| {
        let t = obj(value, path)?;
        Ok(BackgroundTask { id: t.str("id")?, kind: t.str("kind")?, title: t.str("title")?, started_at: t.i64("startedAt")? })
    })?;
    chat.generated_title = o.opt_str("generatedTitle")?;
    chat.title_pending = o.flag("titlePending")?;
    chat.title = o.opt_str("title")?;
    chat.unread = o.flag("unread")?;
    chat.archived = o.flag("archived")?;
    chat.pinned = o.flag("pinned")?;
    chat.pin_order = o.opt_f64("pin_order")?;
    chat.done_at = o.opt_i64("done_at")?;
    chat.handed_over_to = o.opt_u64("handedOverTo")?;
    chat.handed_over_from = o.opt_u64("handedOverFrom")?;
    chat.handover_pending = o.flag("handoverPending")?;
    chat.handover_draft = o.opt_str("handoverDraft")?;
    chat.resume_turn = o.child("resumeTurn")?.map(|r| r.opt_i64("stoppedAt")).transpose()?;
    chat.context_usage = o.child("contextUsage")?.map(context_usage).transpose()?;
    chat.suggestion =
        o.child("suggestion")?.map(|s| -> Result<_> { Ok(Suggestion { text: s.str("text")?, turn_id: s.str("turnId")? }) }).transpose()?;
    chat.routine = o
        .child("routine")?
        .map(|r| -> Result<_> {
            Ok(RoutineRef { routine_id: r.str("routineId")?, run_id: r.str("runId")?, hidden: r.opt_flag("hidden")? })
        })
        .transpose()?;
    chat.former_worktree = o
        .child("formerWorktree")?
        .map(|w| -> Result<_> { Ok(FormerWorktree { path: w.str("path")?, name: w.str("name")?, branch: w.opt_str("branch")? }) })
        .transpose()?;
    chat.permission_mode = enum_of(o.opt_str("permissionMode")?, path, "permissionMode", permission_mode)?;
    chat.parent = o.opt_u64("parent")?;
    chat.queued = o.each("queued", |value, path| {
        let q = obj(value, path)?;
        Ok(QueuedMessage {
            id: q.str("id")?,
            body: q.str("body")?,
            files: q.strings("files")?,
            model: q.str("model")?,
            provider: enum_of(q.opt_str("provider")?, path, "provider", provider)?.ok_or_else(|| anyhow!("{path}.provider: missing"))?,
            queued_at: q.i64("queuedAt")?,
            client_message_id: q.opt_str("clientMessageId")?,
        })
    })?;
    chat.queue_held = o.flag("queueHeld")?;
    Ok(chat)
}

fn summary(s: Obj<'_>) -> Result<ChatSummary> {
    Ok(ChatSummary {
        count: s.u64("count")? as usize,
        first_id: s.opt_u64("firstId")?,
        last_id: s.opt_u64("lastId")?,
        last_at: s.opt_i64("lastAt")?,
        first_at: s.opt_i64("firstAt")?,
        title_line: s.opt_str("titleLine")?,
        title_images: s.opt_u64("titleImages")?.map(|n| n as usize),
        last_outcome: enum_of(s.opt_str("lastOutcome")?, &s.path, "lastOutcome", outcome)?,
        pull_requests: s.strings("pullRequests")?,
        last_model: s.opt_str("lastModel")?,
        open_handoff: s.opt_u64("openHandoff")?,
        linear_issue: s.opt_str("linearIssue")?,
        linear_workspace: s.opt_str("linearWorkspace")?,
    })
}

fn context_usage(c: Obj<'_>) -> Result<ContextUsage> {
    Ok(ContextUsage {
        used: c.opt_f64("used")?.ok_or_else(|| c.err("used", "a number"))?,
        size: c.opt_f64("size")?.ok_or_else(|| c.err("size", "a number"))?,
    })
}

/// `Subagent`, without its transcript entries and progress (not decoded in this stage: a non-empty `transcript`
/// is an error rather than a silently empty one).
fn subagent(value: &Value, path: &str) -> Result<Subagent> {
    let o = obj(value, path)?;
    if !o.array("transcript")?.is_empty() || o.get("progress").is_some() {
        bail!("{path}: subagent transcript/progress are not decoded in this adapter stage");
    }
    Ok(Subagent {
        id: o.str("id")?,
        source: o.opt_str("source")?,
        mode: o.opt_str("mode")?,
        provider: enum_of(o.opt_str("provider")?, path, "provider", provider)?,
        model: o.opt_str("model")?,
        retryable: o.flag("retryable")?,
        archived: o.flag("archived")?,
        parent_id: o.opt_str("parentId")?,
        background: o.flag("background")?,
        agent_type: o.opt_str("agentType")?,
        title: o.str("title")?,
        prompt: o.opt_str("prompt")?,
        status: enum_of(o.opt_str("status")?, path, "status", |s| {
            Some(match s {
                "initializing" => SubagentStatus::Initializing,
                "running" => SubagentStatus::Running,
                "waiting" => SubagentStatus::Waiting,
                "completed" => SubagentStatus::Completed,
                "failed" => SubagentStatus::Failed,
                "cancelled" => SubagentStatus::Cancelled,
                "unknown" => SubagentStatus::Unknown,
                _ => return None,
            })
        })?
        .unwrap_or_default(),
        started_at: o.i64("startedAt")?,
        updated_at: o.i64("updatedAt")?,
        ended_at: o.opt_i64("endedAt")?,
        latest_activity: o.opt_str("latestActivity")?,
        tasks: o.each("tasks", |value, path| {
            let t = obj(value, path)?;
            Ok(AgentTask {
                id: t.str("id")?,
                content: t.str("content")?,
                active_form: t.opt_str("activeForm")?,
                status: enum_of(t.opt_str("status")?, path, "status", |s| {
                    Some(match s {
                        "pending" => TaskStatus::Pending,
                        "in_progress" => TaskStatus::InProgress,
                        "completed" => TaskStatus::Completed,
                        _ => return None,
                    })
                })?
                .ok_or_else(|| anyhow!("{path}.status: missing"))?,
            })
        })?,
        progress: None,
        transcript: Vec::new(),
        transcript_length: o.opt_u64("transcriptLength")?.map(|n| n as usize),
        details_on_demand: o.flag("detailsOnDemand")?,
    })
}

// ---- Runs ----

/// `chat:runs` as the client returns it (`ChatRuns { runs, seq }`), keys as sent (this computer's: unqualified).
pub fn chat_runs(runs: &milagre_daemon_client::ChatRuns) -> Result<ChatRuns> {
    let map = obj(&runs.runs, "runs")?;
    let mut out = BTreeMap::new();
    for (key, value) in map.map {
        out.insert(key.clone(), agent_run(value, &format!("runs.{key}")).with_context(|| format!("run {key}"))?);
    }
    Ok(ChatRuns { runs: out, seq: runs.seq })
}

fn agent_run(value: &Value, path: &str) -> Result<AgentRun> {
    let o = obj(value, path)?;
    let mut answered = BTreeMap::new();
    if let Some(map) = o.child("answered")? {
        for (key, value) in map.map {
            let sent = value.as_str().and_then(|s| {
                Some(match s {
                    "allow" => SentAnswer::Allow,
                    "allow-for-chat" => SentAnswer::AllowForChat,
                    "deny" => SentAnswer::Deny,
                    "answered" => SentAnswer::Answered,
                    "dismissed" => SentAnswer::Dismissed,
                    _ => return None,
                })
            });
            answered.insert(SharedString::from(key.clone()), sent.ok_or_else(|| anyhow!("{path}.answered.{key}: unknown answer"))?);
        }
    }
    Ok(AgentRun {
        turn_id: o.opt_str("turnId")?,
        text: o.str("text")?,
        model: o.str("model")?,
        permission_mode: enum_of(o.opt_str("permissionMode")?, path, "permissionMode", permission_mode)?,
        started_at: o.opt_i64("startedAt")?,
        steps: o.each("steps", step)?,
        approvals: o.each("approvals", permission_request)?,
        questions: o.each("questions", question_request)?,
        answered,
        split: o.flag("split")?,
        steered: o.flag("steered")?,
        waiting_for_subagents: o.flag("waitingForSubagents")?,
        context_usage: o.child("contextUsage")?.map(context_usage).transpose()?,
    })
}

pub(crate) fn permission_request(value: &Value, path: &str) -> Result<PermissionRequest> {
    let o = obj(value, path)?;
    Ok(PermissionRequest {
        request_id: o.str("requestId")?,
        kind: enum_of(o.opt_str("kind")?, path, "kind", |s| {
            Some(match s {
                "command" => PermissionKind::Command,
                "edit" => PermissionKind::Edit,
                "other" => PermissionKind::Other,
                "delegation" => PermissionKind::Delegation,
                "setup" => PermissionKind::Setup,
                _ => return None,
            })
        })?
        .ok_or_else(|| anyhow!("{path}.kind: missing"))?,
        tool: o.str("tool")?,
        title: o.str("title")?,
        description: o.opt_str("description")?,
        command: o.opt_str("command")?,
        cwd: o.opt_str("cwd")?,
        diff: o.opt_str("diff")?,
        files: o.strings("files")?,
        detail: o.opt_str("detail")?,
        reason: o.opt_str("reason")?,
        allow_for_chat: o.flag("allowForChat")?,
        step_id: o.opt_str("stepId")?,
        delegation: o
            .child("delegation")?
            .map(|d| -> Result<_> {
                Ok(DelegationTarget {
                    target: d.str("target")?,
                    message: d.str("message")?,
                    negotiation: d.flag("negotiation")?,
                    computer: d.opt_str("computer")?,
                })
            })
            .transpose()?,
    })
}

pub(crate) fn question_request(value: &Value, path: &str) -> Result<QuestionRequest> {
    let o = obj(value, path)?;
    Ok(QuestionRequest {
        request_id: o.str("requestId")?,
        secret_request: o
            .child("secretRequest")?
            .map(|s| -> Result<_> { Ok(SecretRequest { description: s.str("description")?, expires_at: s.opt_i64("expiresAt")? }) })
            .transpose()?,
        bug_report: o
            .child("bugReport")?
            .map(|b| -> Result<_> {
                Ok(BugReport {
                    repo: b.str("repo")?,
                    title: b.str("title")?,
                    body: b.str("body")?,
                    expires_at: b.opt_i64("expiresAt")?,
                    redactions: b.opt_u64("redactions")?.map(|n| n as u32),
                    recheck: b.flag("recheck")?,
                })
            })
            .transpose()?,
        questions: o.each("questions", |value, path| {
            let q = obj(value, path)?;
            Ok(AgentQuestion {
                id: q.str("id")?.to_string(),
                header: q.opt_str("header")?.map(|s| s.to_string()).unwrap_or_default(),
                question: q.str("question")?.to_string(),
                options: q.each("options", |value, path| {
                    let option = obj(value, path)?;
                    Ok(QuestionOption {
                        label: option.str("label")?.to_string(),
                        description: option.opt_str("description")?.map(|s| s.to_string()),
                    })
                })?,
                multi_select: q.flag("multiSelect")?,
                allow_other: q.flag("allowOther")?,
                secret: q.flag("secret")?,
            })
        })?,
    })
}

pub(crate) fn step(value: &Value, path: &str) -> Result<ChatStep> {
    let o = obj(value, path)?;
    let source = o.child("source")?;
    Ok(ChatStep {
        id: o.str("id")?,
        kind: enum_of(o.opt_str("kind")?, path, "kind", |s| {
            Some(match s {
                "shell" => StepKind::Shell,
                "edit" => StepKind::Edit,
                "read" => StepKind::Read,
                "search" => StepKind::Search,
                "other" => StepKind::Other,
                "thinking" => StepKind::Thinking,
                "setup" => StepKind::Setup,
                "image" => StepKind::Image,
                "artifact" => StepKind::Artifact,
                _ => return None,
            })
        })?,
        title: o.str("title")?,
        status: enum_of(o.opt_str("status")?, path, "status", |s| {
            Some(match s {
                "running" => StepStatus::Running,
                "done" => StepStatus::Done,
                "failed" => StepStatus::Failed,
                _ => return None,
            })
        })?
        .unwrap_or_default(),
        started_at: o.opt_i64("startedAt")?,
        ended_at: o.opt_i64("endedAt")?,
        source_name: source.as_ref().map(|s| s.opt_str("name")).transpose()?.flatten(),
        source_server: source.as_ref().map(|s| s.opt_str("server")).transpose()?.flatten(),
        input: o.opt_str("input")?,
        summary: o.opt_str("summary")?,
        error: o.opt_str("error")?,
        detail: o.opt_str("detail")?,
        has_detail: o.flag("hasDetail")?,
        file: o.opt_str("file")?,
        note: o.opt_str("note")?,
        duration_ms: o.opt_u64("durationMs")?,
        offset: o.opt_u64("offset")?.map(|n| n as usize),
        artifact: o
            .child("artifact")?
            .map(|a| -> Result<_> {
                Ok(ArtifactRef {
                    id: a.str("id")?,
                    version: a.u64("version")?,
                    title: a.str("title")?,
                    format: a.opt_str("format")?,
                    inline: a.flag("inline")?,
                    height: a.opt_f64("height")?.map(|h| h as f32),
                    group: a.opt_str("group")?,
                })
            })
            .transpose()?,
        tool: o.opt_str("tool")?,
        agent: o.opt_str("agent")?,
    })
}

// ---- Messages ----

/// `chat:messages` → `{ messages, hasMore, total }`. All three are required; the client invents no cursor fields
/// and neither does this.
pub fn message_page(body: &Value) -> Result<MessagePage> {
    let o = obj(body, "page")?;
    let has_more = o.get("hasMore").and_then(Value::as_bool).ok_or_else(|| o.err("hasMore", "a boolean"))?;
    let total = o.u64("total")? as usize;
    let messages = o.get("messages").and_then(Value::as_array).ok_or_else(|| o.err("messages", "an array"))?;
    let messages = messages.iter().enumerate().map(|(ix, value)| message(value, &format!("page.messages[{ix}]"))).collect::<Result<_>>()?;
    Ok(MessagePage { messages, has_more, total })
}

fn message(value: &Value, path: &str) -> Result<ChatMessage> {
    let o = obj(value, path)?;
    Ok(ChatMessage {
        id: o.u64("id")?,
        client_message_id: o.opt_str("clientMessageId")?,
        chat: o.u64("session_id")?,
        body: o.str("body")?,
        context: o.get("context").map(|c| context(c, path)).transpose()?,
        role: match o.opt_str("role")?.as_deref() {
            None | Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            Some(other) => bail!("{path}.role: unknown value {other:?}"),
        },
        model: o.opt_str("model")?,
        images: o.each("images", |value, path| {
            let i = obj(value, path)?;
            Ok(ImageAttachment {
                id: i.str("id")?,
                name: i.str("name")?,
                path: i.opt_str("path")?,
                data_url: i.opt_str("dataUrl")?,
                source_path: i.opt_str("sourcePath")?,
            })
        })?,
        files: o.strings("files")?,
        outcome: enum_of(o.opt_str("outcome")?, path, "outcome", outcome)?,
        steps: o.each("steps", step)?,
        credits: o.opt_f64("credits")?,
        answered: o.each("answered", |value, path| {
            let a = obj(value, path)?;
            Ok(AnsweredQuestion {
                header: a.opt_str("header")?.unwrap_or_default(),
                question: a.str("question")?,
                answers: a.strings("answers")?,
            })
        })?,
    })
}

/// `ChatContext`. This stage types the field-less kinds; every other kind is kept whole in `ChatContext::Other`
/// (the GPUI type's own lossless fallback), so nothing is dropped. Typing handoff, compaction, limit, delegation
/// and the rest is listed as a gap in README.md.
fn context(value: &Value, path: &str) -> Result<ChatContext> {
    if value.as_str() == Some("handover") {
        return Ok(ChatContext::Handover);
    }
    let o = obj(value, path)?;
    let kind = o.str("kind")?;
    Ok(match kind.as_ref() {
        "reload" => ChatContext::Reload,
        "git-action" => ChatContext::GitAction,
        "limit-reset" => ChatContext::LimitReset,
        _ => ChatContext::Other { kind, raw: value.clone() },
    })
}
