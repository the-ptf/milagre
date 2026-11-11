//! A Project's tile and the Projects lists: `packages/shared/src/project-list.ts` (`projectInitial`,
//! `projectAvatarRadius`) and `apps/desktop/app/src/lib/project-list.ts` (`projectRows`, `newChatProject`;
//! `stableOrder` is in `logic::lists::stable_order`).

use std::collections::HashSet;

use super::scopes::{LOCAL_COMPUTER, computer_of_key};
use crate::logic::lists::jsstr::js_trim;

/// The letter on a Project's tile when it has no image: its name's first letter, "M" for none.
///
/// JavaScript takes one UTF-16 code unit, which for a character outside the BMP is half a surrogate pair; this
/// takes the whole character.
pub fn project_initial(name: &str) -> String {
    match js_trim(name).chars().next() {
        Some(first) => first.to_uppercase().collect(),
        None => "M".to_owned(),
    }
}

/// A Project tile's corner radius by its size, on both apps: 16 → 4, 20–24 → 6, 32–40 → 10, larger → 20. Person
/// avatars are round instead.
pub fn project_avatar_radius(size: f64) -> f64 {
    if size <= 16.0 {
        4.0
    } else if size <= 24.0 {
        6.0
    } else if size <= 40.0 {
        10.0
    } else {
        20.0
    }
}

/// A Project tile without an image, as palette keys: an ink square with an on-ink initial at weight 600. The
/// Chats home mark is the same tile with a bubble glyph.
pub struct ProjectAvatarTone {
    pub fill: &'static str,
    pub ink: &'static str,
}

pub const PROJECT_AVATAR: ProjectAvatarTone = ProjectAvatarTone { fill: "ink", ink: "onInk" };

/// A project in the recent list, as the main process keeps it (most recent first).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    /// Kept out of the all-Projects sidebar and the phone's Projects list.
    pub hidden: bool,
    /// The Git remote as "host/owner/repo", which ties the copies of one repository on several computers together.
    pub origin: Option<String>,
}

/// One project row in the project menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub path: String,
    pub name: String,
    pub initial: String,
    pub current: bool,
}

/// `projectPath.split("/").findLast(Boolean) ?? projectPath`
fn folder_name(project_path: &str) -> &str {
    project_path.rsplit('/').find(|part| !part.is_empty()).unwrap_or(project_path)
}

/// The project menu's rows: the recent list in its order, with the open project checked. The open project is
/// always a row, first when the list doesn't have it (a plain folder isn't listed, or the list hasn't loaded). A
/// project listed twice shows once.
pub fn project_rows(recent: &[RecentProject], current_path: &str, current_name: Option<&str>) -> Vec<ProjectRow> {
    let listed = recent.iter().any(|project| project.path == current_path);
    let own;
    let mut projects: Vec<&RecentProject> = Vec::with_capacity(recent.len() + 1);
    if !listed {
        own = RecentProject {
            path: current_path.to_owned(),
            name: current_name.map_or_else(|| folder_name(current_path).to_owned(), str::to_owned),
            ..RecentProject::default()
        };
        projects.push(&own);
    }
    projects.extend(recent);
    let mut seen = HashSet::new();
    projects
        .into_iter()
        .filter(|project| seen.insert(project.path.as_str()))
        .map(|project| ProjectRow {
            path: project.path.clone(),
            name: project.name.clone(),
            initial: project_initial(&project.name),
            current: project.path == current_path,
        })
        .collect()
}

/// The Project a new Chat starts in: always one of this Mac's. The open Project when it is this Mac's (a Link on
/// screen keeps the Project behind it), else this Mac's most recent one, a hidden one only when there is no other.
/// `None` when this Mac has none. The Chats home is never it: only No project starts a Chat there, and the home is
/// never recent. `current_path` is empty for none (an empty path counts as none, as in the TypeScript).
pub fn new_chat_project(current_path: Option<&str>, current_is_chats_home: bool, recent: &[RecentProject]) -> Option<String> {
    if let Some(path) = current_path
        && !path.is_empty()
        && !current_is_chats_home
        && computer_of_key(path) == LOCAL_COMPUTER
    {
        return Some(path.to_owned());
    }
    let local: Vec<&RecentProject> = recent.iter().filter(|project| computer_of_key(&project.path) == LOCAL_COMPUTER).collect();
    local.iter().find(|project| !project.hidden).or(local.first()).map(|project| project.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &str, name: &str, hidden: bool) -> RecentProject {
        RecentProject { path: path.to_owned(), name: name.to_owned(), hidden, ..RecentProject::default() }
    }

    fn recent() -> Vec<RecentProject> {
        vec![
            project("/code/milagre-ade", "milagre-ade", false),
            project("/code/happiergym", "happiergym", false),
            project("/code/rd-mobile", "rd-mobile", false),
        ]
    }

    fn row(path: &str, name: &str, initial: &str, current: bool) -> ProjectRow {
        ProjectRow { path: path.to_owned(), name: name.to_owned(), initial: initial.to_owned(), current }
    }

    #[test]
    fn the_initial_is_the_names_first_letter_in_capitals_and_m_for_none() {
        assert_eq!(project_initial("milagre"), "M");
        assert_eq!(project_initial("  happiergym"), "H");
        assert_eq!(project_initial(""), "M");
        assert_eq!(project_initial("   "), "M");
        assert_eq!(project_initial("élan"), "É");
        assert_eq!(project_initial("ßeta"), "SS");
    }

    #[test]
    fn the_avatar_radius_steps_by_size() {
        let radii: Vec<f64> = [12.0, 16.0, 20.0, 24.0, 32.0, 40.0, 72.0, 100.0].into_iter().map(project_avatar_radius).collect();
        assert_eq!(radii, [4.0, 4.0, 6.0, 6.0, 10.0, 10.0, 20.0, 20.0]);
        assert_eq!((PROJECT_AVATAR.fill, PROJECT_AVATAR.ink), ("ink", "onInk"));
    }

    #[test]
    fn the_rows_follow_the_recent_list_with_the_open_project_checked() {
        assert_eq!(
            project_rows(&recent(), "/code/milagre-ade", None),
            [
                row("/code/milagre-ade", "milagre-ade", "M", true),
                row("/code/happiergym", "happiergym", "H", false),
                row("/code/rd-mobile", "rd-mobile", "R", false)
            ]
        );
        let checked: Vec<(String, bool)> =
            project_rows(&recent(), "/code/happiergym", None).into_iter().map(|row| (row.name, row.current)).collect();
        assert_eq!(checked, [("milagre-ade".to_owned(), false), ("happiergym".to_owned(), true), ("rd-mobile".to_owned(), false)]);
    }

    #[test]
    fn the_open_project_is_always_a_row_first_when_the_list_doesnt_have_it() {
        let rows: Vec<(String, bool)> =
            project_rows(&recent(), "/tmp/plain folder", Some("plain folder")).into_iter().map(|row| (row.name, row.current)).collect();
        assert_eq!(
            rows,
            [
                ("plain folder".to_owned(), true),
                ("milagre-ade".to_owned(), false),
                ("happiergym".to_owned(), false),
                ("rd-mobile".to_owned(), false)
            ]
        );
        // Before the list loads, the menu shows the open project alone.
        assert_eq!(project_rows(&[], "/code/milagre-ade", Some("milagre-ade")), [row("/code/milagre-ade", "milagre-ade", "M", true)]);
        // Its name comes from the folder when none is given.
        assert_eq!(project_rows(&[], "/code/repo", None)[0].name, "repo");
        assert_eq!(project_rows(&[], "/code/repo/", None)[0].name, "repo");
    }

    #[test]
    fn a_project_listed_twice_shows_once_and_an_empty_name_falls_back_to_m() {
        let mut list = recent();
        list.push(list[1].clone());
        list.push(project("/code/blank", "  ", false));
        let rows = project_rows(&list, "/code/milagre-ade", None);
        let paths: Vec<&str> = rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(paths, ["/code/milagre-ade", "/code/happiergym", "/code/rd-mobile", "/code/blank"]);
        assert_eq!(rows[3].initial, "M");
    }

    #[test]
    fn a_new_chat_starts_in_the_open_project_when_it_is_this_macs() {
        assert_eq!(new_chat_project(Some("/code/happiergym"), false, &recent()).as_deref(), Some("/code/happiergym"));
    }

    #[test]
    fn a_new_chat_from_a_link_or_another_computers_project_starts_in_this_macs_most_recent_project() {
        let mut mixed = vec![project("deer|/code/rd-events", "rd-events", false), project("/code/hidden", "hidden", true)];
        mixed.extend(recent());
        assert_eq!(new_chat_project(Some("deer|/code/rd-events"), false, &mixed).as_deref(), Some("/code/milagre-ade"));
        assert_eq!(new_chat_project(Some("/code/happiergym"), false, &mixed).as_deref(), Some("/code/happiergym"));
        assert_eq!(new_chat_project(None, false, &mixed).as_deref(), Some("/code/milagre-ade"));
        assert_eq!(new_chat_project(Some(""), false, &mixed).as_deref(), Some("/code/milagre-ade"));
    }

    #[test]
    fn a_hidden_project_of_this_mac_is_used_only_when_it_is_the_only_one() {
        let only_hidden = [project("/code/hidden", "hidden", true)];
        assert_eq!(new_chat_project(Some("deer|/code/rd-events"), false, &only_hidden).as_deref(), Some("/code/hidden"));
        assert_eq!(new_chat_project(Some("deer|/code/rd-events"), false, &[]), None);
    }

    #[test]
    fn a_new_chat_skips_the_chats_home() {
        // The home is never in the recent list, so a new Chat from a project-less Chat goes back to the last real Project.
        assert_eq!(new_chat_project(Some("/Users/a/.milagre/chats"), true, &recent()).as_deref(), Some("/code/milagre-ade"));
        assert_eq!(new_chat_project(Some("/Users/a/.milagre/chats"), true, &[]), None);
    }
}
