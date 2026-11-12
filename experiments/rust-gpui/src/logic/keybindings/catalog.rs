//! The command catalogue of `KEYBINDING_COMMANDS` in `packages/shared/src/keybindings.mjs`, in the order Settings lists
//! it. Hand-copied (`tools/gen-keybindings.mjs` does not exist yet); `tests.rs` pins the count and the defaults.

/// Where Settings files a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandGroup {
    General,
    Navigation,
    Chat,
    Panels,
}

impl CommandGroup {
    pub fn title(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Navigation => "Navigation",
            Self::Chat => "Chat",
            Self::Panels => "Panels",
        }
    }
}

/// A command a key can run. Text editing (Cmd-Z, Enter to send, Escape), Cmd-W and Cmd-Q stay fixed and are not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeybindingCommand {
    pub id: &'static str,
    pub title: &'static str,
    pub group: CommandGroup,
    /// Key strings (`mod+shift+d`), in the order of the default rules.
    pub defaults: &'static [&'static str],
    /// The iPad's hardware keyboard offers it too.
    pub mobile: bool,
    /// The Electron app catches it before any frame, so it works with focus in a design, an HTML reply or the simulator.
    /// (Nothing for GPUI: the window owns the keyboard.)
    pub forward: bool,
}

const fn command(
    id: &'static str,
    title: &'static str,
    group: CommandGroup,
    default: &'static [&'static str],
    mobile: bool,
    forward: bool,
) -> KeybindingCommand {
    KeybindingCommand { id, title, group, defaults: default, mobile, forward }
}

use CommandGroup::{Chat, General, Navigation, Panels};

pub const KEYBINDING_COMMANDS: &[KeybindingCommand] = &[
    command("commandPalette.toggle", "Search commands, Chats and Projects", General, &["mod+k"], true, false),
    command("chat.new", "New Chat", General, &["mod+n"], true, false),
    command("project.add", "Add Project", General, &["mod+o"], false, false),
    command("settings.open", "Open Settings", General, &["mod+,"], true, true),
    command("theme.toggle", "Switch light and dark", General, &["mod+shift+t"], false, true),
    command("sidebar.toggle", "Show or hide the sidebar", Navigation, &["mod+b"], true, false),
    command("usage.open", "Open token usage", Navigation, &["mod+shift+u"], false, true),
    command("chat.parent", "Open the parent Chat", Navigation, &["mod+["], true, false),
    command("chat.jump.1", "Open Chat 1", Navigation, &["mod+1"], true, false),
    command("chat.jump.2", "Open Chat 2", Navigation, &["mod+2"], true, false),
    command("chat.jump.3", "Open Chat 3", Navigation, &["mod+3"], true, false),
    command("chat.jump.4", "Open Chat 4", Navigation, &["mod+4"], true, false),
    command("chat.jump.5", "Open Chat 5", Navigation, &["mod+5"], true, false),
    command("chat.jump.6", "Open Chat 6", Navigation, &["mod+6"], true, false),
    command("chat.jump.7", "Open Chat 7", Navigation, &["mod+7"], true, false),
    command("chat.jump.8", "Open Chat 8", Navigation, &["mod+8"], true, false),
    command("chat.jump.9", "Open Chat 9", Navigation, &["mod+9"], true, false),
    command("chat.find", "Find in Chat", Chat, &["mod+f"], false, false),
    command("chat.quote", "Quote the selected text in the next message", Chat, &["mod+shift+'"], false, false),
    command("changes.toggle", "Show or hide Changes", Panels, &["mod+shift+d"], true, true),
    command("terminal.toggle", "Show or hide Terminals", Panels, &["mod+j"], false, false),
    command("terminal.new", "New Terminal", Panels, &["mod+t"], false, false),
    command("artifacts.toggle", "Show or hide artifacts", Panels, &["mod+shift+a"], false, true),
    command("designs.toggle", "Show or hide designs", Panels, &["mod+shift+e"], false, true),
    command("browser.toggle", "Show or hide the browser", Panels, &["mod+shift+b"], false, true),
    command("simulator.toggle", "Show or hide the simulator", Panels, &["mod+shift+s"], false, true),
];
