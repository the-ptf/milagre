//! The Preview's own preferences: Settings › Appearance is this window's, not Milagre's daemon's (Electron keeps it in
//! its renderer's storage too), so it is saved in the Preview's base folder (`preferences.json`, beside the owned
//! runtime's `launch.json`) and read back on the next launch. The colour mode, theme and the Appearance options are
//! kept; a custom theme's seeds are not yet. Settings › Notifications is kept here too (`notifications`, Electron's key
//! names): on the first launch without it, it is seeded once from Electron's own `preferences.json`
//! (`milagre-settings`, read only, never written) and saved. So are the other renderer preferences this window honours
//! (`window`: Settings › General's editor and Keep awake, Settings › Chat's reasoning and tool calls), seeded the same
//! way. Appearance (light or dark, the colour theme and the Appearance options) follows Electron's (`theme`,
//! `colorTheme`, `appearance` in `milagre-settings`) on every launch until it is changed in this window
//! (`appearance.own`), so the Preview opens in the same theme as Milagre.app. A read-only window (`--snapshot`) reads
//! the file and never writes it.

use std::path::{Path, PathBuf};

use gpui::{App, BorrowAppContext as _};
use milagre_gpui_spike::settings::SettingsStore;
use milagre_gpui_spike::settings::appearance::{AppearanceOptions, AppearanceState, ThemePreference};
use milagre_gpui_spike::settings::store::{EditorChoice, ToolCallDisplay};
use serde_json::{Value, json};

pub const FILE: &str = "preferences.json";

/// The file in the Preview's base folder.
pub fn default_path() -> PathBuf {
    crate::setup::preview_base().join(FILE)
}

fn to_json(store: &SettingsStore, own: bool) -> Value {
    let state = &store.appearance;
    let o = &state.options;
    json!({
        "notifications": crate::notify::to_json(&crate::notify::from_store(store)),
        "window": window_json(store),
        "appearance": {
            "own": own,
            "theme": state.theme.as_str(),
            "colorTheme": state.color_theme,
            "uiFont": o.ui_font,
            "monoFont": o.mono_font,
            "sidebarSize": o.sidebar_size,
            "chatSize": o.chat_size,
            "codeSize": o.code_size,
            "chatWidth": o.chat_width,
            "chatWidthPx": o.chat_width_px,
            "sidebarUsage": o.sidebar_usage,
            "providerIcons": o.provider_icons,
            "diffColors": o.diff_colors,
            "motion": o.motion,
        }
    })
}

/// The renderer preferences this window honours, with Electron's key names (`AppSettings` in `lib/settings.ts`).
fn window_json(store: &SettingsStore) -> Value {
    json!({
        "editorId": store.default_editor.as_str(),
        "keepAwake": store.keep_awake,
        "toolCallDisplay": store.tool_call_display.as_str(),
        "expandReasoning": store.expand_reasoning,
    })
}

/// `store` with `window` (this file's `window`, or Electron's `milagre-settings`) over it; Electron's empty `editorId`
/// (the first editor found) and an editor this window does not list are the system default.
pub fn apply_window(store: &mut SettingsStore, window: &Value) {
    if let Some(editor) = window["editorId"].as_str() {
        store.default_editor = EditorChoice::parse(if editor == "code" { "vscode" } else { editor });
    }
    if let Some(on) = window["keepAwake"].as_bool() {
        store.keep_awake = on;
    }
    if let Some(display) = window["toolCallDisplay"].as_str() {
        store.tool_call_display = ToolCallDisplay::parse(display);
    }
    if let Some(on) = window["expandReasoning"].as_bool() {
        store.expand_reasoning = on;
    }
}

/// `state` with what the file holds over it; anything missing or of the wrong type keeps its value.
pub fn apply_json(state: &mut AppearanceState, value: &Value) {
    let a = &value["appearance"];
    if let Some(theme) = a["theme"].as_str() {
        state.theme = ThemePreference::parse(theme);
    }
    if let Some(color) = a["colorTheme"].as_str()
        && color != "custom"
    {
        state.choose_theme(color);
    }
    let o: &mut AppearanceOptions = &mut state.options;
    for (key, field) in [
        ("uiFont", &mut o.ui_font),
        ("monoFont", &mut o.mono_font),
        ("sidebarSize", &mut o.sidebar_size),
        ("chatSize", &mut o.chat_size),
        ("codeSize", &mut o.code_size),
        ("chatWidth", &mut o.chat_width),
        ("sidebarUsage", &mut o.sidebar_usage),
        ("providerIcons", &mut o.provider_icons),
        ("diffColors", &mut o.diff_colors),
        ("motion", &mut o.motion),
    ] {
        if let Some(text) = a[key].as_str() {
            *field = text.to_owned();
        }
    }
    if let Some(px) = a["chatWidthPx"].as_u64().and_then(|px| u32::try_from(px).ok()) {
        o.chat_width_px = milagre_gpui_spike::settings::appearance::model::clamp_chat_width(px);
    }
}

/// Reads the file into Settings (the theme follows at once), then, unless `read_only`, saves every change to it.
/// Notifications missing from the file are seeded from `electron` (Electron's `preferences.json`) and saved at once.
pub fn install_with(path: PathBuf, electron: &Path, read_only: bool, cx: &mut App) {
    let file = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if let Some(value) = &file {
        cx.update_global::<SettingsStore, _>(|store, _| apply_json(&mut store.appearance, value));
    }
    // Not changed here yet: Electron's Appearance, so both windows show the same theme.
    let mut own = file.as_ref().is_some_and(|f| f["appearance"]["own"] == true);
    if !own && let Some(appearance) = electron_appearance(electron) {
        cx.update_global::<SettingsStore, _>(|store, _| apply_json(&mut store.appearance, &appearance));
    }
    let notifications = file.as_ref().and_then(crate::notify::from_json);
    let seeded = notifications.is_none();
    let notifications = notifications.or_else(|| {
        std::fs::read(electron)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|e| crate::notify::from_electron(&e))
    });
    if let Some(settings) = notifications {
        cx.update_global::<SettingsStore, _>(|store, _| crate::notify::into_store(&settings, store));
    }
    let window = file.as_ref().map(|f| f["window"].clone()).filter(Value::is_object);
    let window_seeded = window.is_none();
    let window = window.or_else(|| {
        std::fs::read(electron)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|e| serde_json::from_str::<Value>(e.get("milagre-settings")?.as_str()?).ok())
    });
    if let Some(window) = window {
        cx.update_global::<SettingsStore, _>(|store, _| apply_window(store, &window));
    }
    if read_only {
        return;
    }
    let mut saved = to_json(cx.global::<SettingsStore>(), own);
    if seeded || window_seeded {
        // Seeded once: kept in this window's file from now on.
        match write(&path, &saved) {
            Ok(()) => {}
            Err(error) => eprintln!("live: couldn't save {}: {error}", path.display()),
        }
    }
    cx.observe_global::<SettingsStore>(move |cx| {
        // A change to Appearance made here: this window's own from now on.
        own = own || to_json(cx.global::<SettingsStore>(), own)["appearance"] != saved["appearance"];
        let now = to_json(cx.global::<SettingsStore>(), own);
        if now != saved {
            match write(&path, &now) {
                Ok(()) => saved = now,
                Err(error) => eprintln!("live: couldn't save {}: {error}", path.display()),
            }
        }
    })
    .detach();
}

/// Electron's Appearance (`milagre-settings`: `theme`, `colorTheme` and `appearance`) as this file's `appearance`.
pub fn electron_appearance(electron: &Path) -> Option<Value> {
    let file: Value = serde_json::from_slice(&std::fs::read(electron).ok()?).ok()?;
    let settings: Value = serde_json::from_str(file.get("milagre-settings")?.as_str()?).ok()?;
    let mut appearance = settings["appearance"].as_object().cloned().unwrap_or_default();
    for key in ["theme", "colorTheme"] {
        if let Some(value) = settings.get(key) {
            appearance.insert(key.to_owned(), value.clone());
        }
    }
    Some(json!({ "appearance": appearance }))
}

/// [`install_with`] seeding from Electron's own `preferences.json`.
pub fn install(path: PathBuf, read_only: bool, cx: &mut App) {
    install_with(path, &crate::notify::electron_preferences(), read_only, cx);
}

fn write(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(value).unwrap_or_default())?;
    std::fs::rename(temp, path)
}

/// Electron's preferences file, for what the composer reads from it ([`composer_effort`]).
pub struct ElectronPrefs(pub PathBuf);

impl gpui::Global for ElectronPrefs {}

/// The thinking effort Electron's composer shows for Chat `key` (`useComposerPreferences`): the Chat's own choice in
/// `milagre.composer-preferences`, else the last one picked anywhere (`milagre.effort`), else `high`. The model chip
/// then keeps it to what the model offers (`effortFor`).
pub fn composer_effort(electron: &Path, key: &str) -> String {
    let file = std::fs::read(electron).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).unwrap_or(Value::Null);
    effort_from(&file, key)
}

/// [`composer_effort`] over the file's JSON.
pub fn effort_from(file: &Value, key: &str) -> String {
    let own = file["milagre.composer-preferences"]
        .as_str()
        .and_then(|prefs| serde_json::from_str::<Value>(prefs).ok())
        .and_then(|prefs| prefs[key]["effort"].as_str().map(str::to_owned));
    own.or_else(|| file["milagre.effort"].as_str().map(str::to_owned)).unwrap_or_else(|| "high".to_owned())
}

#[cfg(test)]
mod effort_tests {
    use super::effort_from;
    use serde_json::json;

    #[test]
    fn a_chats_effort_then_the_last_picked_then_high() {
        let prefs = json!({
            "milagre.composer-preferences": "{\"/p#1\":{\"effort\":\"xhigh\"},\"/p#2\":{\"permissionMode\":\"full\"}}",
            "milagre.effort": "medium",
        });
        assert_eq!(effort_from(&prefs, "/p#1"), "xhigh");
        assert_eq!(effort_from(&prefs, "/p#2"), "medium", "no effort of its own");
        assert_eq!(effort_from(&json!({}), "/p#1"), "high");
    }
}
