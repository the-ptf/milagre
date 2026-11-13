//! Settings › Chat: how Chats and tool calls are displayed, each device keeping its own choices
//! (`packages/shared/src/chat-display.ts`).

/// The context size, in percent, from which the compact button warns (`CONTEXT_WARN_PERCENT` in `usage.ts`,
/// which WP-12 ports; this copy is what `chat-display.ts` imports from it).
pub const CONTEXT_WARN_PERCENT: f64 = 75.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactButtonDisplay {
    Always,
    Threshold,
}

pub const SHOW_CONTEXT_SIZE_TITLE: &str = "Show context size";
pub const SHOW_CONTEXT_SIZE_HINT: &str = "Show the current context size beside Send.";
pub const COMPACT_BUTTON_TITLE: &str = "Compact button";
pub const COMPACT_BUTTON_HINT: &str = "Compact manually in supported Chats. The button turns orange at the threshold.";

/// `COMPACT_BUTTON_OPTIONS`: each value with its label. "At 75% context" for the threshold.
pub fn compact_button_options() -> [(CompactButtonDisplay, String); 2] {
    [(CompactButtonDisplay::Always, "Always".to_owned()), (CompactButtonDisplay::Threshold, format!("At {CONTEXT_WARN_PERCENT}% context"))]
}

/// A saved choice; anything but "always" is the threshold.
pub fn parse_compact_button_display(value: Option<&str>) -> CompactButtonDisplay {
    if value == Some("always") { CompactButtonDisplay::Always } else { CompactButtonDisplay::Threshold }
}

/// A Chat's context window (`ContextUsage`): the tokens used and its size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextUsage {
    pub used: f64,
    pub size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactButtonState {
    pub visible: bool,
    pub warning: bool,
}

/// Both platforms show the same action, independently of the context size preference. `quiet` hides it.
pub fn compact_button_state(
    display: CompactButtonDisplay,
    usage: Option<ContextUsage>,
    supported: bool,
    threshold: f64,
    quiet: bool,
) -> CompactButtonState {
    let warning = usage.is_some_and(|usage| usage.size > 0.0 && (usage.used / usage.size) * 100.0 >= threshold);
    CompactButtonState { visible: supported && !quiet && (display == CompactButtonDisplay::Always || warning), warning }
}

/// Compact folds a reply's tool calls into one line; Full detail shows each one, with the notes between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallDisplay {
    Compact,
    Full,
}

impl ToolCallDisplay {
    pub fn id(self) -> &'static str {
        match self {
            ToolCallDisplay::Compact => "compact",
            ToolCallDisplay::Full => "full",
        }
    }
}

/// `TOOL_CALL_DISPLAYS`: id, label, description.
pub const TOOL_CALL_DISPLAYS: [(ToolCallDisplay, &str, &str); 2] =
    [(ToolCallDisplay::Compact, "Compact", "One line per reply."), (ToolCallDisplay::Full, "Full detail", "Each call on its own row.")];

pub const DETAIL_LEVEL_TITLE: &str = "Detail level";
pub const EXPAND_REASONING_TITLE: &str = "Always expand reasoning";
pub const EXPAND_REASONING_HINT: &str = "Show the agent's thinking open, instead of folded into its row.";
pub const TOOL_CALL_DISPLAY_TITLE: &str = "Tool call display";
pub const TOOL_CALL_DISPLAY_HINT: &str = "How tool calls appear in the Chat.";

/// A saved choice; `murilo` is the Experimental switch it replaces, which meant Full detail when on.
pub fn parse_tool_call_display(value: Option<&str>, murilo: Option<bool>) -> ToolCallDisplay {
    match value {
        Some("compact") => ToolCallDisplay::Compact,
        Some("full") => ToolCallDisplay::Full,
        _ if murilo == Some(true) => ToolCallDisplay::Full,
        _ => ToolCallDisplay::Compact,
    }
}

/// How the sidebar lists Chats: one list shows every Chat of every Project in a single list; Grouped by Project
/// keeps a fold per Project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatList {
    List,
    Grouped,
}

impl ChatList {
    pub fn id(self) -> &'static str {
        match self {
            ChatList::List => "list",
            ChatList::Grouped => "grouped",
        }
    }
}

/// `CHAT_LIST_MODES`: id, label, description.
pub const CHAT_LIST_MODES: [(ChatList, &str, &str); 2] = [
    (ChatList::List, "One list", "Every Chat of every Project in one list, with its Project on the second line."),
    (ChatList::Grouped, "Grouped by Project", "A group per Project that folds."),
];

pub const CHAT_LIST_TITLE: &str = "Chat list";
pub const CHAT_LIST_HINT: &str = "How the sidebar lists your Chats.";

/// The label of a Chat list value.
pub fn chat_list_label(value: ChatList) -> &'static str {
    CHAT_LIST_MODES.iter().find(|(mode, ..)| *mode == value).map_or("One list", |(_, label, _)| label)
}

/// A saved choice; anything else is One list.
pub fn parse_chat_list(value: Option<&str>) -> ChatList {
    if value == Some("grouped") { ChatList::Grouped } else { ChatList::List }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(used: f64, size: f64) -> Option<ContextUsage> {
        Some(ContextUsage { used, size })
    }

    fn state(display: CompactButtonDisplay, usage: Option<ContextUsage>, supported: bool) -> CompactButtonState {
        compact_button_state(display, usage, supported, CONTEXT_WARN_PERCENT, false)
    }

    #[test]
    fn compact_button_preferences_share_the_context_warning_threshold_and_respect_support() {
        use CompactButtonDisplay::{Always, Threshold};
        assert_eq!(parse_compact_button_display(None), Threshold);
        assert_eq!(parse_compact_button_display(Some("invalid")), Threshold);
        assert_eq!(parse_compact_button_display(Some("always")), Always);
        let is = |visible, warning| CompactButtonState { visible, warning };
        assert_eq!(state(Threshold, usage(74.0, 100.0), true), is(false, false));
        assert_eq!(state(Threshold, usage(75.0, 100.0), true), is(true, true));
        assert_eq!(state(Threshold, usage(100.0, 100.0), false), is(false, true));
        assert_eq!(state(Always, usage(20.0, 100.0), true), is(true, false));
        assert_eq!(state(Always, None, true), is(true, false));
        assert!(!state(Always, None, false).visible);
        assert!(!state(Threshold, None, true).visible);
        assert!(!state(Threshold, usage(20.0, 0.0), true).visible);
        // Quiet hides it whatever the context size.
        assert!(!compact_button_state(Always, None, true, CONTEXT_WARN_PERCENT, true).visible);
        // A lower threshold warns sooner.
        assert!(compact_button_state(Threshold, usage(50.0, 100.0), true, 50.0, false).visible);
    }

    #[test]
    fn the_compact_options_name_the_threshold() {
        let options = compact_button_options();
        assert_eq!(options[0].1, "Always");
        assert_eq!(options[1].1, "At 75% context");
    }

    #[test]
    fn tool_call_display_keeps_a_saved_choice_and_reads_murilo_mode_as_full_detail() {
        assert_eq!(parse_tool_call_display(Some("full"), None), ToolCallDisplay::Full);
        assert_eq!(parse_tool_call_display(Some("compact"), Some(true)), ToolCallDisplay::Compact, "a saved choice wins");
        assert_eq!(parse_tool_call_display(None, Some(true)), ToolCallDisplay::Full);
        assert_eq!(parse_tool_call_display(None, Some(false)), ToolCallDisplay::Compact);
        assert_eq!(parse_tool_call_display(Some("loud"), None), ToolCallDisplay::Compact);
        assert_eq!(parse_tool_call_display(Some("loud"), Some(true)), ToolCallDisplay::Full);
        assert_eq!(TOOL_CALL_DISPLAYS.map(|(mode, ..)| mode.id()), ["compact", "full"]);
    }

    #[test]
    fn chat_list_reads_a_saved_choice_and_falls_back_to_one_list() {
        assert_eq!(parse_chat_list(Some("grouped")), ChatList::Grouped);
        assert_eq!(parse_chat_list(Some("list")), ChatList::List);
        assert_eq!(parse_chat_list(None), ChatList::List);
        assert_eq!(parse_chat_list(Some("tabs")), ChatList::List);
        assert_eq!(CHAT_LIST_MODES.map(|(mode, ..)| mode.id()), ["list", "grouped"]);
        assert_eq!(chat_list_label(ChatList::List), "One list");
        assert_eq!(chat_list_label(ChatList::Grouped), "Grouped by Project");
    }
}
