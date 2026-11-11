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
}
impl HostContext {
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
}
impl RegisteredTool {
    /// Register an implemented trusted handler. The handler must validate its
    /// arguments and return an MCP tool result. Before each commit it must call
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
        Ok(Self {
            schema,
            effect,
            handler,
        })
    }
    pub(crate) fn manifest(&self) -> HostTool {
        HostTool {
            name: self.schema["name"].as_str().unwrap().into(),
            read_only: self.effect == ToolEffect::Read,
        }
    }
}
