//! Rust-window lifecycle only. Exiting never stops the shared owner or its agents.
use std::{
    fs,
    os::fd::AsRawFd,
    os::unix::fs::OpenOptionsExt,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

pub struct ShellState {
    _instance_lock: fs::File,
    terminal_focused: AtomicBool,
    confirming: AtomicBool,
}

pub fn acquire() -> Result<ShellState, std::io::Error> {
    let root = std::path::PathBuf::from(
        std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("HOME is unavailable"))?,
    )
    .join("Library/Application Support/com.milagre.rust-poc");
    fs::create_dir_all(&root)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("desktop.lock"))?;
    // This is solely the Rust shell's own lock, not a Project or production host lock.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::other(
            "Milagre Rust is already running; keeping the existing window and preference writer",
        ));
    }
    Ok(ShellState {
        _instance_lock: file,
        terminal_focused: AtomicBool::new(false),
        confirming: AtomicBool::new(false),
    })
}

fn background() -> bool {
    std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1")
}

pub fn terminal_focused(app: &AppHandle, focused: bool) {
    app.state::<ShellState>()
        .terminal_focused
        .store(focused, Ordering::Relaxed);
}

pub fn confirm_quit(app: &AppHandle) {
    if background()
        || app
            .state::<ShellState>()
            .confirming
            .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut dialog = rfd::AsyncMessageDialog::new()
            .set_title("Milagre Rust")
            .set_description("Quit Milagre?\nAgents keep running in the background.")
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ));
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let answer = dialog.show().await;
        app.state::<ShellState>()
            .confirming
            .store(false, Ordering::Release);
        if matches!(answer, rfd::MessageDialogResult::Custom(ref label) if label == "Quit")
            || answer == rfd::MessageDialogResult::Ok
        {
            app.exit(0);
        }
    });
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // Custom Quit and Close preserve the production shortcut behavior. Other edit
    // shortcuts remain native and continue working in sandboxed preview frames.
    let quit = MenuItem::with_id(
        app,
        "rust-quit",
        "Quit Milagre Rust",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let close = MenuItem::with_id(
        app,
        "rust-close-terminal",
        "Close Focused Terminal",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Milagre Rust",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Milagre Rust"), None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "rust-quit" => confirm_quit(app),
        "rust-close-terminal"
            if app
                .state::<ShellState>()
                .terminal_focused
                .load(Ordering::Relaxed) =>
        {
            let _ = app.emit(
                "native-event",
                serde_json::json!({"channel":"app:close-focused-terminal","payload":null}),
            );
        }
        _ => {}
    });
    Ok(())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.set_fullscreen(false);
        let _ = window.hide();
    }
}

pub fn reopen(app: &AppHandle) {
    if !background() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
