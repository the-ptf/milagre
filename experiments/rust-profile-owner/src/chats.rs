//! Commands enabled only by the explicit synthetic-provider composition.
pub const METHODS: &[&str] = &[
    "chat:send",
    "chat:send-status",
    "chat:all-messages",
    "chat:search",
    "chat:subagent",
    "chat:queue-send",
    "chat:queue-remove",
    "agent:interrupt",
];
