//! After `packages/shared/src/approval-copy.ts`: what an approval says, the same on desktop and phone.

use super::model_copy::SETUP_APPROVAL_COPY;

/// A command this long reads better in full under the title than as a chip inside it.
const LONG_COMMAND: usize = 80;

/// `PermissionRequest.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    Command,
    Edit,
    Other,
    Delegation,
    Setup,
}

/// The line above an approval's title (`approvalKind`): what kind of action it is, in words. The agent's own
/// tool names never show; other tools keep the name the request gives them.
pub fn approval_kind(kind: ApprovalKind, tool: &str) -> &str {
    match kind {
        ApprovalKind::Command => "Command",
        ApprovalKind::Edit => "File change",
        _ => tool,
    }
}

/// Whether the title already shows the whole command (`commandInTitle`), so the details don't repeat it.
pub fn command_in_title(command: Option<&str>, title: &str) -> bool {
    let Some(command) = command.map(super::js::trim) else { return false };
    !command.is_empty() && !command.contains('\n') && super::js::utf16_len(command) <= LONG_COMMAND && title.contains(command)
}

/// The label of the request's Always allow choice (`alwaysAllowLabel`). `delegation_computer` is
/// `request.delegation?.computer`; an empty one counts as none, as in JavaScript.
pub fn always_allow_label(kind: ApprovalKind, delegation_computer: Option<&str>) -> String {
    if kind == ApprovalKind::Setup {
        return SETUP_APPROVAL_COPY.always.to_string();
    }
    if let Some(computer) = delegation_computer.filter(|computer| !computer.is_empty()) {
        return format!("Always allow for {computer} in this Chat");
    }
    if kind == ApprovalKind::Delegation {
        return "Always allow for this Link in this Chat".to_string();
    }
    "Always allow in this Chat".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_approvals_kind_is_in_words_never_the_agents_tool_name() {
        assert_eq!(approval_kind(ApprovalKind::Command, "Bash"), "Command");
        assert_eq!(approval_kind(ApprovalKind::Edit, "Write"), "File change");
        assert_eq!(approval_kind(ApprovalKind::Other, "MCP: Linear"), "MCP: Linear");
    }

    #[test]
    fn a_short_one_line_command_in_the_title_is_not_repeated_in_the_details() {
        assert!(command_in_title(Some("npm test"), "Run `npm test`"));
        assert!(!command_in_title(Some("npm test"), "Run this command?"));
        assert!(!command_in_title(Some("a\nb"), "Run `a\nb`"));
        let long = format!("echo {}", "x".repeat(90));
        assert!(!command_in_title(Some(&long), &format!("Run `{long}`")));
        assert!(!command_in_title(None, "Run"));
        assert!(!command_in_title(Some("  "), "Run"));
        // Exactly 80 UTF-16 units still counts as short.
        let edge = "x".repeat(80);
        assert!(command_in_title(Some(&edge), &edge));
    }

    #[test]
    fn always_allow_names_what_it_covers() {
        assert_eq!(always_allow_label(ApprovalKind::Command, None), "Always allow in this Chat");
        assert_eq!(always_allow_label(ApprovalKind::Delegation, None), "Always allow for this Link in this Chat");
        assert_eq!(always_allow_label(ApprovalKind::Delegation, Some("Santo")), "Always allow for Santo in this Chat");
        assert_eq!(always_allow_label(ApprovalKind::Setup, None), "Trust this version");
        assert_eq!(always_allow_label(ApprovalKind::Setup, Some("Santo")), "Trust this version");
        assert_eq!(always_allow_label(ApprovalKind::Delegation, Some("")), "Always allow for this Link in this Chat");
    }
}
