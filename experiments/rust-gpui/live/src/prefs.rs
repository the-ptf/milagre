//! The Preview's own preferences: Settings › Appearance is this window's, not Milagre's daemon's (Electron keeps it in
//! its renderer's storage too), so it is saved in the Preview's base folder (`preferences.json`, beside the owned
//! runtime's `launch.json`) and read back on the next launch. The colour mode, theme and the Appearance options are
//! kept; a custom theme's seeds are not yet. Settings › Notifications is kept here too (`notifications`, Electron's key
//! names): on the first launch without it, it is seeded once from Electron's own `preferences.json`
//! (`milagre-settings`, read only, never written) and saved. A read-only window (`--snapshot`) reads the file and
//! never writes it.

use std::path::{Path, PathBuf};

use gpui::{App, BorrowAppContext as _};
use milagre_gpui_spike::settings::SettingsStore;
use milagre_gpui_spike::settings::appearance::{AppearanceOptions, AppearanceState, ThemePreference};
use serde_json::{Value, json};

pub const FILE: &str = "preferences.json";

/// The file in the Preview's base folder.
pub fn default_path() -> PathBuf {
    crate::setup::preview_base().join(FILE)
}

fn to_json(store: &SettingsStore) -> Value {
    let state = &store.appearance;
    let o = &state.options;
    json!({
        "notifications": crate::notify::to_json(&crate::notify::from_store(store)),
        "appearance": {
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
    if read_only {
        return;
    }
    let mut saved = to_json(cx.global::<SettingsStore>());
    if seeded {
        // Seeded once: kept in this window's file from now on.
        match write(&path, &saved) {
            Ok(()) => {}
            Err(error) => eprintln!("live: couldn't save {}: {error}", path.display()),
        }
    }
    cx.observe_global::<SettingsStore>(move |cx| {
        let now = to_json(cx.global::<SettingsStore>());
        if now != saved {
            match write(&path, &now) {
                Ok(()) => saved = now,
                Err(error) => eprintln!("live: couldn't save {}: {error}", path.display()),
            }
        }
    })
    .detach();
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
