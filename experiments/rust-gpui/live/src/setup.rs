//! First launch of the Preview: propose this Mac's launch manifest, let the user pick the signed-in Claude account
//! and confirm, write the private manifest, and start again on it.
//!
//! Nothing here reads credentials. Claude Code's executable is looked for in the usual install places and on PATH;
//! the account folders are the default Claude config folder (`~/.claude`) and Milagre's own account folders, named by
//! the labels in Milagre's account metadata (`accounts/accounts.json`: ids, providers and labels only). The runtime
//! itself discovers nothing: it gets exactly the manifest written here.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use gpui::{App, AppContext as _, Bounds, Context, SharedString, Window, WindowBounds, WindowOptions, div, prelude::*, px, size};
use milagre_gpui_spike::theme::ActiveTheme as _;

pub const MANIFEST: &str = "launch.json";
const PREVIEW_FOLDER: &str = "Library/Application Support/Milagre GPUI Preview";

#[derive(Clone, Debug, PartialEq)]
pub struct Detected {
    pub claude: PathBuf,
    pub config_directory: PathBuf,
    pub account_id: String,
    pub account_label: String,
    pub model: String,
    pub skills: PathBuf,
    pub user: String,
    pub path: String,
    pub home: PathBuf,
}

/// A Claude account folder the user can pick.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountChoice {
    pub id: String,
    pub label: String,
    pub folder: PathBuf,
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn preview_base() -> PathBuf {
    home().join(PREVIEW_FOLDER)
}

pub fn user_name() -> String {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| home().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

pub fn default_path() -> String {
    let home = home();
    format!("{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", home.display())
}

/// The skills this build ships: `Contents/Resources/bundled-skills` in the bundle, else the repository's.
pub fn skills_directory() -> PathBuf {
    if let Ok(exe) = std::env::current_exe().and_then(fs::canonicalize)
        && let Some(contents) = exe.parent().and_then(Path::parent)
    {
        let bundled = contents.join("Resources/bundled-skills");
        if bundled.is_dir() {
            return bundled;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/src/bundled-skills").canonicalize().unwrap_or_default()
}

pub fn find_claude() -> Option<PathBuf> {
    let home = home();
    let mut places =
        vec![home.join(".local/bin/claude"), PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")];
    if let Some(path) = std::env::var_os("PATH") {
        places.extend(std::env::split_paths(&path).map(|dir| dir.join("claude")));
    }
    places.into_iter().find(|p| fs::metadata(p).is_ok_and(|m| m.is_file()))
}

/// `~/.claude` (when it exists) and Milagre's Claude account folders, by label.
pub fn accounts() -> Vec<AccountChoice> {
    let home = home();
    let mut out = Vec::new();
    if home.join(".claude").is_dir() {
        out.push(AccountChoice { id: "default".into(), label: "Default Claude account (~/.claude)".into(), folder: home.join(".claude") });
    }
    let folder = home.join("Library/Application Support/Milagre/accounts");
    if let Ok(text) = fs::read_to_string(folder.join("accounts.json"))
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
    {
        for account in value["accounts"].as_array().into_iter().flatten() {
            let (Some(id), Some(label)) = (account["id"].as_str(), account["label"].as_str()) else { continue };
            if account["provider"] != "claude" || !folder.join(id).is_dir() {
                continue;
            }
            out.push(AccountChoice { id: id.into(), label: label.into(), folder: folder.join(id) });
        }
    }
    out
}

pub fn detect() -> (Option<PathBuf>, Vec<AccountChoice>) {
    (find_claude(), accounts())
}

/// Writes `<base>/launch.json` (0600, new) in a 0700 base folder. The root is created by the runtime on next launch.
pub fn write_manifest(base: &Path, detected: &Detected) -> anyhow::Result<PathBuf> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(base)?;
    let manifest = base.join(MANIFEST);
    let value = serde_json::json!({
        "program": detected.claude,
        "home": detected.home,
        "configDirectory": detected.config_directory,
        "skillsDirectory": detected.skills,
        "model": detected.model,
        "path": detected.path,
        "accountId": detected.account_id,
        "accountLabel": detected.account_label,
        "userName": detected.user,
    });
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&manifest)?;
    file.write_all(value.to_string().as_bytes())?;
    file.sync_all()?;
    Ok(manifest)
}

struct SetupView {
    base: PathBuf,
    claude: Option<PathBuf>,
    accounts: Vec<AccountChoice>,
    picked: Option<usize>,
    error: Option<SharedString>,
}

pub fn open_window(base: PathBuf, (claude, accounts): (Option<PathBuf>, Vec<AccountChoice>), cx: &mut App) -> gpui::AnyWindowHandle {
    let picked = (accounts.len() == 1).then_some(0);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(560.0), px(640.0)), cx))),
            ..Default::default()
        },
        |_, cx| cx.new(|_| SetupView { base, claude, accounts, picked, error: None }),
    )
    .expect("open the setup window")
    .into()
}

impl SetupView {
    fn confirm(&mut self, cx: &mut Context<Self>) {
        let (Some(claude), Some(account)) = (self.claude.clone(), self.picked.and_then(|ix| self.accounts.get(ix)).cloned()) else {
            return;
        };
        let detected = Detected {
            claude,
            config_directory: account.folder,
            account_id: account.id,
            account_label: account.label,
            model: "sonnet".into(),
            skills: skills_directory(),
            user: user_name(),
            path: default_path(),
            home: home(),
        };
        match write_manifest(&self.base, &detected) {
            Ok(_) => {
                // Start again on the manifest: the runtime creates the root and the app opens on it.
                let args: Vec<String> = std::env::args().skip(1).collect();
                match std::env::current_exe().and_then(|exe| std::process::Command::new(exe).args(args).spawn()) {
                    Ok(_) => cx.quit(),
                    Err(error) => self.error = Some(format!("Could not start again: {error}").into()),
                }
            }
            Err(error) => self.error = Some(format!("Could not write {}: {error}", self.base.join(MANIFEST).display()).into()),
        }
        cx.notify();
    }
}

impl Render for SetupView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let ready = self.claude.is_some() && self.picked.is_some();
        let line = |text: String| div().text_color(theme.ink2).child(text);
        let mut accounts = div().id("setup-accounts").flex().flex_col().gap_1().max_h(px(220.0)).overflow_y_scroll();
        for (ix, account) in self.accounts.iter().enumerate() {
            let on = self.picked == Some(ix);
            accounts = accounts.child(
                div()
                    .id(SharedString::from(format!("setup-account-{ix}")))
                    .px_3()
                    .py_2()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(if on { theme.ink } else { theme.line })
                    .cursor_pointer()
                    .child(format!("{}{}", if on { "● " } else { "○ " }, account.label))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.picked = Some(ix);
                        cx.notify();
                    })),
            );
        }
        div()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .p_6()
            .pt(px(44.0))
            .flex()
            .flex_col()
            .gap_3()
            .child(div().text_xl().child("Set up Milagre"))
            .child(line("Chats run on this Mac's Claude Code with the account you pick, in their own data folder:".into()))
            .child(line(self.base.join("root").display().to_string()))
            .child(match &self.claude {
                Some(path) => line(format!("Claude Code: {}", path.display())),
                None => div()
                    .text_color(theme.red)
                    .child("Claude Code is not installed. Install it (claude.ai/code), sign in, then open the Preview again."),
            })
            .child(line("Model: Sonnet (fixed for this Preview)".into()))
            .child(line("Signed-in Claude account:".into()))
            .child(if self.accounts.is_empty() {
                div()
                    .text_color(theme.red)
                    .child("No Claude account folder found. Run `claude` once and sign in, then open the Preview again.")
                    .into_any_element()
            } else {
                accounts.into_any_element()
            })
            .children(self.error.clone().map(|error| div().text_color(theme.red).child(error)))
            .child(
                div()
                    .id("setup-continue")
                    .mt_2()
                    .px_4()
                    .py_2()
                    .rounded(px(6.0))
                    .bg(if ready { theme.ink } else { theme.line })
                    .text_color(theme.page)
                    .cursor_pointer()
                    .child("Continue")
                    .on_click(cx.listener(|this, _, _, cx| this.confirm(cx))),
            )
    }
}
