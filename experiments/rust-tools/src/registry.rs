//! Trusted owner registrations. No provider-supplied handler or effect is accepted.
use crate::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolEffect {
    Read,
    Write,
    WakeResponse,
}
#[derive(Clone)]
pub struct HostContext {
    pub chat_id: String,
    pub project_id: String,
    pub(crate) check: ActiveCheck,
    pub(crate) confirmed: Arc<AtomicBool>,
}
impl HostContext {
    /// Call only after the handler's mutation durably commits. This records
    /// evidence for a late receipt; it neither authorizes a write nor retries it.
    /// An expired/revoked scope cannot newly confirm a commit.
    pub fn confirm_committed(&self) -> Result<()> {
        self.assert_active()?;
        self.confirmed.store(true, Ordering::Release);
        Ok(())
    }
    pub fn assert_active(&self) -> Result<()> {
        (self.check)()
    }
}
type Handler = Arc<dyn Fn(&HostContext, &Value) -> Result<Value> + Send + Sync>;
#[derive(Clone)]
pub struct RegisteredTool {
    pub(crate) schema: Value,
    pub(crate) effect: ToolEffect,
    pub(crate) handler: Handler,
    pub(crate) timeout: std::time::Duration,
}
impl RegisteredTool {
    /// Register an implemented trusted handler. The dispatcher validates its strict
    /// schema; the handler validates semantic state and returns an MCP tool result. Before each commit it must call
    /// context.assert_active(), as the native stores do at their write checkpoints. Schema/effect are owner code,
    /// never deserialized from transport input. No I/O happens at registration.
    pub fn new(schema: Value, effect: ToolEffect, handler: Handler) -> Result<Self> {
        let name = schema["name"].as_str().unwrap_or("");
        if name.is_empty()
            || name.len() > 128
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || !schema["inputSchema"].is_object()
            || policy::read_only(name).is_some()
        {
            return Err(Error::coded(
                "UNSUPPORTED_POLICY",
                "Invalid or shadowing host tool registration.",
            ));
        }
        if (effect == ToolEffect::WakeResponse) != (name == "chat_respond")
            || schema["annotations"]["readOnlyHint"].as_bool() != Some(effect == ToolEffect::Read)
        {
            return Err(Error::coded(
                "UNSUPPORTED_POLICY",
                "Host tool annotation differs from its registered handler effect.",
            ));
        }
        crate::registry_schema::check(&schema["inputSchema"], 0)?;
        if schema["inputSchema"]["type"] != "object" {
            return Err(Error::coded(
                "HOST_SCHEMA",
                "Registered tool root schema must be an object.",
            ));
        }
        if effect == ToolEffect::WakeResponse {
            for field in ["chatId", "requestId"] {
                if schema["inputSchema"]["properties"][field]["type"] != "string"
                    || !schema["inputSchema"]["required"]
                        .as_array()
                        .is_some_and(|fields| fields.contains(&json!(field)))
                {
                    return Err(Error::coded(
                        "HOST_SCHEMA",
                        "Wake responses require explicit string Chat and request fields.",
                    ));
                }
            }
        }
        Ok(Self {
            schema,
            effect,
            handler,
            timeout: std::time::Duration::from_secs(10),
        })
    }
    pub fn with_timeout(mut self, timeout: std::time::Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > std::time::Duration::from_secs(10) {
            return Err(Error::coded(
                "HOST_DEADLINE",
                "External handler timeout must be between zero and ten seconds.",
            ));
        }
        self.timeout = timeout;
        Ok(self)
    }
    pub(crate) fn manifest(&self) -> HostTool {
        HostTool {
            name: self.schema["name"].as_str().unwrap().into(),
            read_only: self.effect == ToolEffect::Read,
        }
    }
}
