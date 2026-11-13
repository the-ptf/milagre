//! A Project's page on a data layer's host ([`crate::settings::host::SettingsHost`]), with the commands Electron's
//! `ProjectSettings` sends for a Project path:
//!
//! | Group | Read | Write |
//! | --- | --- | --- |
//! | Sidebar › Show in sidebar | `project:recent []` | `project:set-hidden [path, hidden]` |
//! | Worktrees › Sync source branch | `main-sync:read [path]` | `main-sync:save [path, true \| false \| null]` |
//! | Branches | `project-git:read [path]` | `project-git:save [path, overrides]` (Reset: `{}`) |
//! | New worktrees › Files to copy | `files-to-copy:read [path]`, `files-to-copy:preview [path, patterns]` | `files-to-copy:save [path, patterns]` |
//! | New worktrees › Setup command | `worktree-setup:read [path]` | `worktree-setup:save [path, command]` |
//!
//! Each answer replaces the entry's part in [`ProjectsStore`]; a read that lands bumps the entry's `loaded`, so the page
//! makes its fields again from it. A refused save keeps what was typed and says why in its group.

use gpui::{App, AsyncApp, BorrowAppContext as _};
use serde_json::{Map, Value, json};

use super::logic::{BranchSettings, PartialPolicy, parse_patterns};
use super::model::{ProjectsStore, SetupSettings};
use crate::settings::devices::logic::{MainSyncChoice, MainSyncResult, SyncOutcome};
use crate::settings::host;

/// A `Partial<BranchPolicy>` (`local`, `repository` of `project-git:read`).
pub fn partial_policy(value: &Value) -> PartialPolicy {
    let text = |key: &str| value[key].as_str().map(str::to_string);
    let flag = |key: &str| value[key].as_bool();
    PartialPolicy {
        template: text("template"),
        username: text("username"),
        dashes_only: flag("dashesOnly"),
        base_branch: text("baseBranch"),
        track_base: flag("trackBase"),
        instructions: text("instructions"),
    }
}

/// The personal overrides as `project-git:save` takes them: only the fields set.
pub fn policy_json(policy: &PartialPolicy) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_string(), value);
        }
    };
    put("template", policy.template.clone().map(Value::from));
    put("username", policy.username.clone().map(Value::from));
    put("dashesOnly", policy.dashes_only.map(Value::from));
    put("baseBranch", policy.base_branch.clone().map(Value::from));
    put("trackBase", policy.track_base.map(Value::from));
    put("instructions", policy.instructions.clone().map(Value::from));
    Value::Object(out)
}

/// `project-git:read`'s and `project-git:save`'s answer (`BranchPolicySettings`).
pub fn branch_settings(value: &Value) -> BranchSettings {
    BranchSettings { local: partial_policy(&value["local"]), repository: partial_policy(&value["repository"]) }
}

/// `MainSyncResult`.
pub fn sync_result(value: &Value) -> Option<MainSyncResult> {
    Some(MainSyncResult {
        at: value["at"].as_f64()? as i64,
        outcome: match value["outcome"].as_str()? {
            "updated" => SyncOutcome::Updated,
            "up-to-date" => SyncOutcome::UpToDate,
            "skipped" => SyncOutcome::Skipped,
            _ => SyncOutcome::Failed,
        },
        branch: value["branch"].as_str().unwrap_or_default().to_string(),
        commit: value["commit"].as_str().map(str::to_string),
        message: value["message"].as_str().map(str::to_string),
    })
}

/// `MainSyncSettings`: the Project's choice (`override`: null follows the default) and its last sync.
pub fn main_sync(value: &Value) -> (MainSyncChoice, Option<MainSyncResult>) {
    let choice = match value["override"].as_bool() {
        None => MainSyncChoice::Default,
        Some(true) => MainSyncChoice::On,
        Some(false) => MainSyncChoice::Off,
    };
    (choice, sync_result(&value["last"]))
}

/// `WorktreeSetupSettings`: the saved command, and the repository's when `.milagre/worktree.json` sets one.
pub fn setup_settings(value: &Value) -> (String, SetupSettings) {
    let repo = (value["source"] == "repo").then(|| value["command"].as_str().map(str::to_string));
    (
        value["setupCommand"].as_str().unwrap_or_default().to_string(),
        SetupSettings { repo, note: value["note"].as_str().map(str::to_string) },
    )
}

/// `FilesToCopy`: what `.worktreeinclude` says when it wins, and the files the patterns match.
pub fn files_found(value: &Value) -> (Option<String>, Vec<String>) {
    let include = (value["source"] == "worktreeinclude").then(|| value["worktreeInclude"].as_str().unwrap_or_default().to_string());
    let matches = value["matches"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
    (include, matches)
}

fn update(cx: &mut App, path: &str, f: impl FnOnce(&mut super::model::ProjectEntry)) {
    cx.update_global::<ProjectsStore, _>(|store, _| f(store.entry(path)));
}

fn update_async(cx: &mut AsyncApp, path: &str, f: impl FnOnce(&mut super::model::ProjectEntry)) {
    cx.update(|cx| update(cx, path, f));
}

/// Whether a data layer keeps the Projects' settings.
pub fn hosted(cx: &App) -> bool {
    host::host(cx).is_some()
}

/// The page shows `path`: every group read from the host, then the entry's fields made again.
pub fn read(path: &str, cx: &mut App) {
    cx.update_global::<ProjectsStore, _>(|store, _| store.hosted = true);
    let calls: Vec<(&'static str, Value)> = vec![
        ("project:recent", json!([])),
        ("main-sync:read", json!([path])),
        ("project-git:read", json!([path])),
        ("files-to-copy:read", json!([path])),
        ("worktree-setup:read", json!([path])),
    ];
    let tasks: Vec<_> = calls.into_iter().filter_map(|(method, args)| Some((method, host::call(method, args, cx)?))).collect();
    let path = path.to_string();
    cx.spawn(async move |cx| {
        let mut answers = Vec::new();
        for (method, task) in tasks {
            answers.push((method, task.await));
        }
        update_async(cx, &path, |entry| {
            for (method, answer) in answers {
                let group = match method {
                    "project:recent" => "sidebar",
                    "main-sync:read" => "sync",
                    "project-git:read" => "branch",
                    "files-to-copy:read" => "files",
                    _ => "setup",
                };
                let value = match answer {
                    Ok(value) => value,
                    Err(error) => {
                        let what = match group {
                            "branch" => "Couldn't read branch settings",
                            "files" => "Couldn't read this project's files",
                            _ => "Couldn't read this setting",
                        };
                        entry.errors.insert(group, format!("{what}: {error}"));
                        continue;
                    }
                };
                entry.errors.remove(group);
                match method {
                    "project:recent" => {
                        let listed = value.as_array().into_iter().flatten().find(|item| item["path"] == path.as_str());
                        entry.hidden = listed.is_some_and(|item| item["hidden"] == true);
                    }
                    "main-sync:read" => (entry.main_sync, entry.main_sync_last) = main_sync(&value),
                    "project-git:read" => entry.branch = branch_settings(&value),
                    "files-to-copy:read" => {
                        entry.files =
                            value["filesToCopy"].as_array().into_iter().flatten().filter_map(|p| p.as_str()).collect::<Vec<_>>().join("\n");
                        (entry.worktree_include, _) = files_found(&value);
                        entry.matches = Some(files_found(&value).1);
                    }
                    _ => (entry.setup, entry.setup_settings) = setup_settings(&value),
                }
            }
            entry.loaded += 1;
        });
    })
    .detach();
}

/// A write whose answer `apply` lays over the entry; a refusal is said in `group` as "Couldn't save: …".
fn write(
    path: &str,
    group: &'static str,
    method: &'static str,
    args: Value,
    apply: fn(&mut super::model::ProjectEntry, &Value, &str),
    cx: &mut App,
) {
    let Some(task) = host::call(method, args, cx) else { return };
    let path = path.to_string();
    cx.spawn(async move |cx| {
        let answer = task.await;
        update_async(cx, &path, |entry| match answer {
            Ok(value) => {
                entry.errors.remove(group);
                apply(entry, &value, &path);
            }
            Err(error) => {
                entry.errors.insert(group, format!("Couldn't save: {error}"));
            }
        });
    })
    .detach();
}

/// Branches: the personal overrides (`{}` resets them).
pub fn save_branch(path: &str, local: &PartialPolicy, cx: &mut App) {
    write(
        path,
        "branch",
        "project-git:save",
        json!([path, policy_json(local)]),
        |entry, value, _| entry.branch = branch_settings(value),
        cx,
    );
}

/// Files to copy: the patterns, one per line.
pub fn save_files(path: &str, text: &str, cx: &mut App) {
    write(path, "files", "files-to-copy:save", json!([path, parse_patterns(text)]), |_, _, _| {}, cx);
}

/// The files the patterns being typed match; only the latest answer shows.
pub fn preview_files(path: &str, text: &str, cx: &mut App) {
    let Some(task) = host::call("files-to-copy:preview", json!([path, parse_patterns(text)]), cx) else { return };
    let seq = PREVIEWS.with(|latest| {
        let mut latest = latest.borrow_mut();
        let next = latest.get(path).copied().unwrap_or(0) + 1;
        latest.insert(path.to_string(), next);
        next
    });
    let path = path.to_string();
    cx.spawn(async move |cx| {
        let answer = task.await;
        let latest = PREVIEWS.with(|latest| latest.borrow().get(&path).copied());
        if let (Ok(value), Some(latest)) = (answer, latest)
            && latest == seq
        {
            update_async(cx, &path, |entry| {
                let (include, matches) = files_found(&value);
                entry.worktree_include = include;
                entry.matches = Some(matches);
            });
        }
    })
    .detach();
}

thread_local! {
    /// The latest preview asked for, by Project path.
    static PREVIEWS: std::cell::RefCell<std::collections::HashMap<String, u64>> = Default::default();
}

/// The setup command.
pub fn save_setup(path: &str, command: &str, cx: &mut App) {
    write(
        path,
        "setup",
        "worktree-setup:save",
        json!([path, command.trim()]),
        |entry, value, _| {
            (entry.setup, entry.setup_settings) = setup_settings(value);
        },
        cx,
    );
}

/// How new Worktrees follow the source branch: null follows the default.
pub fn save_main_sync(path: &str, choice: MainSyncChoice, cx: &mut App) {
    let value = match choice {
        MainSyncChoice::Default => Value::Null,
        MainSyncChoice::On => json!(true),
        MainSyncChoice::Off => json!(false),
    };
    write(
        path,
        "sync",
        "main-sync:save",
        json!([path, value]),
        |entry, value, _| {
            (entry.main_sync, entry.main_sync_last) = main_sync(value);
        },
        cx,
    );
}

/// Show in sidebar: the answer is the recent Projects with their hidden marks.
pub fn set_hidden(path: &str, hidden: bool, cx: &mut App) {
    write(
        path,
        "sidebar",
        "project:set-hidden",
        json!([path, hidden]),
        |entry, value, path| {
            let listed = value.as_array().into_iter().flatten().find(|item| item["path"] == path);
            entry.hidden = listed.is_some_and(|item| item["hidden"] == true);
        },
        cx,
    );
}
