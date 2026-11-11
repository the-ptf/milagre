//! The shell's commands, their keys and the macOS menu bar.
//!
//! Keys come from the effective key table (`logic::keybindings`, WP-13), as the panel's do (`panel/dock.rs`): ⌘B shows
//! or hides the sidebar, ⌘N starts a new Chat, ⇧⌘T switches light and dark. The other commands of the catalogue are
//! bound by the views that own them (⌘, by Settings, the panel toggles by the dock, ⌘T by the Terminals).
//!
//! The menu bar follows the Electron app's (it sets no menu of its own, so it is Electron's default macOS menu): the
//! app menu, Edit, View and Window, plus a File menu with New Chat. Items name the same actions the keys do, so
//! GPUI draws each item's shortcut from the keymap and the menu works wherever focus is.

use gpui::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, Window, actions};

use crate::logic::keybindings::{GpuiOptions, KEYBINDING_COMMANDS, default_keybindings, gpui_bindings, key_label_for};
use crate::settings::ToggleSettings;
use crate::theme::Theme;
use crate::workspace::panel::dock::{ToggleArtifacts, ToggleChanges, ToggleDesigns, ToggleTerminal};

actions!(
    milagre_shell,
    [
        /// Collapse the sidebar to its rail, or expand it (`sidebar.toggle`).
        ToggleSidebar,
        /// Start a new Chat (`chat.new`).
        NewChat,
        /// Switch light and dark (`theme.toggle`).
        ToggleTheme,
        Minimize,
        Zoom,
        ToggleFullScreen,
        HideApp,
        HideOthers,
        ShowAll,
        Quit,
    ]
);

/// The commands bound here, by their catalogue ids.
pub const COMMANDS: [&str; 3] = ["sidebar.toggle", "chat.new", "theme.toggle"];

/// Binds the shell's commands from the effective key table, once per app. The macOS-only window keys (⌘M, ⌃⌘F, ⌘H,
/// ⌥⌘H, ⌘Q) are not in the catalogue: they are the system's.
pub fn install_keys(cx: &mut App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    let bindings = gpui_bindings(&default_keybindings(), cfg!(target_os = "macos"), GpuiOptions::default());
    let mut keys: Vec<KeyBinding> = bindings
        .iter()
        .filter_map(|binding| {
            // GPUI keeps the binding's strings for the life of the app; these few are installed once.
            let context: Option<&'static str> = binding.context.clone().map(|c| &*c.leak());
            let stroke: &'static str = binding.keystroke.clone().leak();
            Some(match binding.command.as_str() {
                "sidebar.toggle" => KeyBinding::new(stroke, ToggleSidebar, context),
                "chat.new" => KeyBinding::new(stroke, NewChat, context),
                "theme.toggle" => KeyBinding::new(stroke, ToggleTheme, context),
                _ => return None,
            })
        })
        .collect();
    debug_assert!(COMMANDS.iter().all(|id| bindings.iter().any(|b| b.command == *id)), "every shell command has a default key");
    keys.extend([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        KeyBinding::new("cmd-h", HideApp, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
    ]);
    cx.bind_keys(keys);
}

/// How a catalogue command's default key reads in a tooltip (`⌘B`), on this platform.
pub fn shortcut_hint(command: &str) -> Option<String> {
    let command = KEYBINDING_COMMANDS.iter().find(|c| c.id == command)?;
    key_label_for(command.defaults.first()?, cfg!(target_os = "macos"))
}

/// The app-wide actions that need no window, and the menu bar. The window's own (⌘B, ⌘N, Minimize, Zoom, Full Screen)
/// are handled by the Workspace (`workspace/mod.rs`), where the window is.
pub fn init(cx: &mut App) {
    install_keys(cx);
    cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
    cx.on_action(|_: &HideApp, cx: &mut App| cx.hide());
    cx.on_action(|_: &HideOthers, cx: &mut App| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx: &mut App| cx.unhide_other_apps());
    cx.on_action(|_: &ToggleTheme, cx: &mut App| toggle_theme(cx));
    cx.set_menus(menus());
}

/// Light to dark and back. The theme bridge follows the global (`theme/component_bridge.rs`).
pub fn toggle_theme(cx: &mut App) {
    let dark = Theme::dark();
    let next = if cx.global::<Theme>().page == dark.page { Theme::light() } else { dark };
    cx.set_global(next);
    cx.refresh_windows();
}

/// The menu bar: Electron's default macOS menu, with Milagre's own commands where the desktop has them.
pub fn menus() -> Vec<Menu> {
    use gpui_component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
    vec![
        Menu::new("Milagre").items([
            MenuItem::action("Settings…", ToggleSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Milagre", HideApp),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit Milagre", Quit),
        ]),
        Menu::new("File").items([MenuItem::action("New Chat", NewChat)]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::separator(),
            MenuItem::action("Changes", ToggleChanges),
            MenuItem::action("Terminals", ToggleTerminal),
            MenuItem::action("Artifacts", ToggleArtifacts),
            MenuItem::action("Designs", ToggleDesigns),
            MenuItem::separator(),
            MenuItem::action("Switch Light and Dark", ToggleTheme),
            MenuItem::action("Toggle Full Screen", ToggleFullScreen),
        ]),
        Menu::new("Window").items([MenuItem::action("Minimize", Minimize), MenuItem::action("Zoom", Zoom)]),
    ]
}

/// The window actions, for the Workspace's root element.
pub fn on_window_actions<E: gpui::InteractiveElement>(element: E) -> E {
    element
        .on_action(|_: &Minimize, window: &mut Window, _: &mut App| window.minimize_window())
        .on_action(|_: &Zoom, window: &mut Window, _: &mut App| window.zoom_window())
        .on_action(|_: &ToggleFullScreen, window: &mut Window, _: &mut App| window.toggle_fullscreen())
}
