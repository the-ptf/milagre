//! After `packages/shared/src/model-copy.ts`: permission modes, the words both apps share (`UI_COPY`), effort
//! levels and the persistence failure text. Strings match the TypeScript character for character.
//!
//! The tables are small, so they are ported by hand; the tests read `model-copy.ts` from the repository and fail
//! when a string here differs from it.

/// `PermissionMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PermissionMode {
    Ask,
    Auto,
    Full,
}

impl PermissionMode {
    pub const ALL: [PermissionMode; 3] = [PermissionMode::Ask, PermissionMode::Auto, PermissionMode::Full];

    /// The wire id.
    pub fn id(self) -> &'static str {
        match self {
            PermissionMode::Ask => "ask",
            PermissionMode::Auto => "auto",
            PermissionMode::Full => "full",
        }
    }

    pub fn from_id(id: &str) -> Option<PermissionMode> {
        PermissionMode::ALL.into_iter().find(|mode| mode.id() == id)
    }

    /// `PERMISSION_MODES[i].name`.
    pub fn name(self) -> &'static str {
        match self {
            PermissionMode::Ask => "Ask for approval",
            PermissionMode::Auto => "Auto mode",
            PermissionMode::Full => "Full permissions",
        }
    }

    /// `PERMISSION_MODES[i].description`.
    pub fn description(self) -> &'static str {
        match self {
            PermissionMode::Ask => "Approve edits and commands as the agent asks",
            PermissionMode::Auto => "Allow changes inside this Worktree",
            PermissionMode::Full => "Remove filesystem and network limits",
        }
    }

    /// `PERMISSION_MODE_LABEL`: the composer chip's word.
    pub fn label(self) -> &'static str {
        match self {
            PermissionMode::Ask => "Ask",
            PermissionMode::Auto => "Auto",
            PermissionMode::Full => "Full",
        }
    }

    pub fn presentation(self) -> PermissionPresentation {
        permission_presentation(self)
    }
}

/// The glyph of a permission mode: Shield01Icon, SecurityCheckIcon or ShieldAlertIcon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionIcon {
    Shield,
    SecurityCheck,
    ShieldAlert,
}

impl PermissionIcon {
    /// The name `permissionPresentation().icon` carries.
    pub fn key(self) -> &'static str {
        match self {
            PermissionIcon::Shield => "shield",
            PermissionIcon::SecurityCheck => "security-check",
            PermissionIcon::ShieldAlert => "shield-alert",
        }
    }
}

/// How a permission mode looks (`permissionPresentation`): `tone` colours the icon, `ink` the label, as palette
/// keys. Full is the only orange mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionPresentation {
    pub icon: PermissionIcon,
    pub tone: &'static str,
    pub ink: &'static str,
}

pub fn permission_presentation(mode: PermissionMode) -> PermissionPresentation {
    match mode {
        PermissionMode::Full => PermissionPresentation { icon: PermissionIcon::ShieldAlert, tone: "orange", ink: "orangeInk" },
        PermissionMode::Auto => PermissionPresentation { icon: PermissionIcon::SecurityCheck, tone: "ink2", ink: "ink2" },
        PermissionMode::Ask => PermissionPresentation { icon: PermissionIcon::Shield, tone: "ink2", ink: "ink2" },
    }
}

/// Words both apps share (`UI_COPY`). Product nouns (Project, Chat, Routine, Run, Link, Heartbeat, Worktree, and
/// the Done state) are capitalised.
pub struct UiCopy {
    /// The composer's send and stop buttons; `queue` while a turn runs.
    pub send: &'static str,
    pub send_follow_up: &'static str,
    pub queue: &'static str,
    pub stop: &'static str,
    pub rename_chat: &'static str,
    pub new_chat: &'static str,
    pub current_chat: &'static str,
    pub find_in_chat: &'static str,
    pub reload_chat: &'static str,
    pub report_milagre_bug: &'static str,
    pub back_to_chat: &'static str,
    pub add_project: &'static str,
    pub copy_worktree_path: &'static str,
    pub new_worktree: &'static str,
    pub no_changes: &'static str,
    pub no_projects: &'static str,
    pub saving: &'static str,
}

pub const UI_COPY: UiCopy = UiCopy {
    send: "Send",
    send_follow_up: "Send follow-up",
    queue: "Queue message",
    stop: "Stop agent",
    rename_chat: "Rename Chat",
    new_chat: "New Chat",
    current_chat: "Current Chat",
    find_in_chat: "Find in Chat",
    reload_chat: "Reload Chat",
    report_milagre_bug: "Report a Milagre bug",
    back_to_chat: "Back to Chat",
    add_project: "Add Project\u{2026}",
    copy_worktree_path: "Copy Worktree path",
    new_worktree: "New Worktree",
    no_changes: "No changes yet",
    no_projects: "No Projects found",
    saving: "Saving\u{2026}",
};

/// `SETUP_APPROVAL_COPY`.
pub struct SetupApprovalCopy {
    pub allow: &'static str,
    pub always: &'static str,
    pub deny: &'static str,
}

pub const SETUP_APPROVAL_COPY: SetupApprovalCopy = SetupApprovalCopy { allow: "Run once", always: "Trust this version", deny: "Skip setup" };

/// `EFFORT_COPY`, in the table's order.
pub const EFFORT_COPY: [(&str, &str, &str); 7] = [
    ("minimal", "Minimal", "Fastest replies with little reasoning"),
    ("low", "Low", "Quick answers for small, clear tasks"),
    ("medium", "Medium", "Balanced thinking for everyday work"),
    ("high", "High", "Careful reasoning for harder changes"),
    ("xhigh", "Extra high", "Deep reasoning for complex problems"),
    ("max", "Max", "Thinks as long as it needs. Slowest"),
    ("ultra", "Ultra", "Splits big work across parallel agents"),
];

/// A level's name and description (`effortCopy`); an unknown level names itself and has no description.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffortCopy {
    pub name: String,
    pub description: String,
}

pub fn effort_copy(level: &str) -> EffortCopy {
    match EFFORT_COPY.iter().find(|(id, _, _)| *id == level) {
        Some((_, name, description)) => EffortCopy { name: (*name).to_string(), description: (*description).to_string() },
        None => EffortCopy { name: level.to_string(), description: String::new() },
    }
}

/// A failed save (`PersistenceFailure`, without `saving`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceFailure {
    pub error: String,
    pub code: Option<String>,
}

/// `persistenceFailureDetail`: the recovery action, the same on desktop and phone; other errors stay raw.
pub fn persistence_failure_detail(failure: &PersistenceFailure) -> String {
    let code = failure.code.as_deref();
    if code == Some("ENOSPC") {
        return "Disk is full. Free space on your computer, then retry.".to_string();
    }
    let lower = failure.error.to_lowercase();
    if code == Some("EACCES") || code == Some("EPERM") || lower.contains("readonly") || lower.contains("read-only") {
        return "Permission denied. Check that your computer can write to this Project.".to_string();
    }
    failure.error.clone()
}

#[cfg(test)]
mod tests {
    use super::super::source;
    use super::*;

    #[test]
    fn permission_modes_carry_their_words() {
        let rows: Vec<_> = PermissionMode::ALL.iter().map(|m| (m.id(), m.name(), m.description(), m.label())).collect();
        assert_eq!(
            rows,
            vec![
                ("ask", "Ask for approval", "Approve edits and commands as the agent asks", "Ask"),
                ("auto", "Auto mode", "Allow changes inside this Worktree", "Auto"),
                ("full", "Full permissions", "Remove filesystem and network limits", "Full"),
            ]
        );
        assert_eq!(PermissionMode::from_id("full"), Some(PermissionMode::Full));
        assert_eq!(PermissionMode::from_id("yolo"), None);
    }

    #[test]
    fn only_full_is_orange() {
        let full = permission_presentation(PermissionMode::Full);
        assert_eq!((full.icon.key(), full.tone, full.ink), ("shield-alert", "orange", "orangeInk"));
        let auto = permission_presentation(PermissionMode::Auto);
        assert_eq!((auto.icon.key(), auto.tone, auto.ink), ("security-check", "ink2", "ink2"));
        let ask = PermissionMode::Ask.presentation();
        assert_eq!((ask.icon.key(), ask.tone, ask.ink), ("shield", "ink2", "ink2"));
    }

    #[test]
    fn effort_copy_falls_back_to_the_level_itself() {
        assert_eq!(effort_copy("xhigh"), EffortCopy { name: "Extra high".into(), description: "Deep reasoning for complex problems".into() });
        assert_eq!(effort_copy("turbo"), EffortCopy { name: "turbo".into(), description: String::new() });
    }

    #[test]
    fn persistence_failures_say_what_to_do() {
        let failure = |error: &str, code: Option<&str>| PersistenceFailure { error: error.into(), code: code.map(Into::into) };
        assert_eq!(persistence_failure_detail(&failure("x", Some("ENOSPC"))), "Disk is full. Free space on your computer, then retry.");
        let denied = "Permission denied. Check that your computer can write to this Project.";
        assert_eq!(persistence_failure_detail(&failure("x", Some("EACCES"))), denied);
        assert_eq!(persistence_failure_detail(&failure("x", Some("EPERM"))), denied);
        assert_eq!(persistence_failure_detail(&failure("attempt to write a READONLY database", None)), denied);
        assert_eq!(persistence_failure_detail(&failure("Read-Only file system", None)), denied);
        assert_eq!(persistence_failure_detail(&failure("boom", Some("EIO"))), "boom");
    }

    #[test]
    fn ui_copy_matches_the_typescript_source() {
        let c = &UI_COPY;
        let ours = [
            ("send", c.send),
            ("sendFollowUp", c.send_follow_up),
            ("queue", c.queue),
            ("stop", c.stop),
            ("renameChat", c.rename_chat),
            ("newChat", c.new_chat),
            ("currentChat", c.current_chat),
            ("findInChat", c.find_in_chat),
            ("reloadChat", c.reload_chat),
            ("reportMilagreBug", c.report_milagre_bug),
            ("backToChat", c.back_to_chat),
            ("addProject", c.add_project),
            ("copyWorktreePath", c.copy_worktree_path),
            ("newWorktree", c.new_worktree),
            ("noChanges", c.no_changes),
            ("noProjects", c.no_projects),
            ("saving", c.saving),
        ];
        assert_eq!(c.add_project, "Add Project…");
        assert_eq!(c.saving, "Saving…");
        let Some(ts) = source::shared("model-copy.ts") else { return };
        let theirs = source::string_pairs(&ts, "export const UI_COPY = {");
        assert_eq!(theirs.len(), ours.len(), "UI_COPY has a different number of entries in model-copy.ts");
        for ((key, value), (their_key, their_value)) in ours.iter().zip(&theirs) {
            assert_eq!((key, value), (&their_key.as_str(), &their_value.as_str()));
        }
    }

    #[test]
    fn the_other_tables_match_the_typescript_source() {
        let Some(ts) = source::shared("model-copy.ts") else { return };
        // The object is on one line in the source, so check each string by presence.
        for text in [SETUP_APPROVAL_COPY.allow, SETUP_APPROVAL_COPY.always, SETUP_APPROVAL_COPY.deny] {
            assert!(ts.contains(&format!("\"{text}\"")), "{text}");
        }
        for mode in PermissionMode::ALL {
            for text in [mode.id(), mode.name(), mode.description(), mode.label()] {
                assert!(ts.contains(&format!("\"{text}\"")), "{text}");
            }
        }
        for (id, name, description) in EFFORT_COPY {
            let line = format!("{id}: {{ name: \"{name}\", description: \"{description}\" }},");
            assert!(ts.contains(&line), "{line}");
        }
        for text in [
            "Disk is full. Free space on your computer, then retry.",
            "Permission denied. Check that your computer can write to this Project.",
        ] {
            assert!(ts.contains(&format!("\"{text}\"")), "{text}");
        }
    }
}
