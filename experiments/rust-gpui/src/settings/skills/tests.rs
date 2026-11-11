//! Headless tests for WP-43 Skills: the catalog rules (`skill-catalog.ts`) and the page (groups, search, the
//! detail with SKILL.md, shadowed skills, copy, reload, a failed read).

use gpui::{Entity, TestAppContext, VisualTestContext};

use super::SkillsView;
use super::model::*;
use crate::settings::mcp::tests::{advance, bounds, click, drawn, open, settle};
use crate::settings::search::SettingsSectionId;
use crate::workspace::Workspace;

fn view(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<SkillsView> {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| s.tools.skills.clone())
}

#[test]
fn search_scope_and_source_narrow_the_list_and_groups_keep_their_order() {
    let (skills, shadowed, _) = fixture();
    assert_eq!(filter_skills(&skills, "", None, None).len(), skills.len());
    let hits = filter_skills(&skills, "  TLDR ", None, None);
    assert_eq!(hits.len(), 2);
    assert_eq!(filter_skills(&skills, "tldr", Some(Scope::User), None).len(), 1);
    assert_eq!(filter_skills(&skills, "", None, Some("codex")).len(), 2);
    assert!(filter_skills(&skills, "", Some(Scope::Bundled), Some("claude")).is_empty());
    // Descriptions count too.
    assert!(filter_skills(&skills, "five-judge", None, None).iter().any(|s| s.name == "design-council"));
    let all: Vec<&Skill> = skills.iter().collect();
    let groups = group_skills(&all);
    assert_eq!(groups.iter().map(|(scope, _)| scope.label()).collect::<Vec<_>>(), ["Project", "User", "Built-in"]);
    let winner = skills.iter().find(|s| s.name == "tldr" && s.scope == Scope::Workspace).unwrap();
    assert_eq!(shadowed_by(&shadowed, winner).len(), 1);
    assert_eq!(overrides_text(1), "Overrides 1 other");
    assert_eq!(overrides_text(2), "Overrides 2 others");
    assert_eq!(provider_label("agents"), "Agents");
    assert_eq!(provider_label("milagre"), "Milagre");
}

#[test]
fn frontmatter_is_dropped_and_home_folders_shorten() {
    assert_eq!(skill_body("---\nname: x\ndescription: y\n---\n\n# Title\nbody\n"), "# Title\nbody");
    assert_eq!(skill_body("\u{feff}---\r\nname: x\r\n---\r\nbody"), "body");
    assert_eq!(skill_body("no frontmatter\n"), "no frontmatter");
    assert_eq!(skill_body("---\nunterminated"), "---\nunterminated");
    assert_eq!(shorten_home("/Users/victor/.claude/skills/x/SKILL.md"), "~/.claude/skills/x/SKILL.md");
    assert_eq!(shorten_home("warn: /home/ana/a and /Users/bo"), "warn: ~/a and ~");
    assert_eq!(shorten_home("/opt/other/Users/victor"), "/opt/other/Users/victor");
}

#[gpui::test]
fn the_page_lists_skills_by_scope_with_warnings_and_what_each_overrides(cx: &mut TestAppContext) {
    let (_workspace, cx) = open(cx, SettingsSectionId::Skills);
    assert!(
        drawn(cx, "settings-section-skills")
            && drawn(cx, "skill-group-workspace")
            && drawn(cx, "skill-group-user")
            && drawn(cx, "skill-group-bundled")
    );
    assert!(drawn(cx, "skill-row-workspace-release-train") && drawn(cx, "skill-row-user-tldr"));
    assert!(drawn(cx, "skill-warnings"));
    let project = bounds(cx, "skill-group-workspace").top();
    let user = bounds(cx, "skill-group-user").top();
    assert!(project < user);
}

#[gpui::test]
fn typing_in_search_filters_the_rows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Skills);
    let view = view(&workspace, cx);
    let query = view.read_with(cx, |v, _| v.query_input()).expect("drawn");
    query.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input("handwr");
    settle(cx);
    assert!(drawn(cx, "skill-row-user-handwritten") && !drawn(cx, "skill-row-workspace-release-train"));
    assert!(!drawn(cx, "skill-group-workspace"), "a group with no matches is not shown");
}

#[gpui::test]
fn a_skill_opens_to_its_file_and_copies_its_command(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Skills);
    let view = view(&workspace, cx);
    click(cx, &workspace, "skill-row-workspace-tldr");
    assert!(drawn(cx, "skill-detail") && drawn(cx, "skill-shadowed"), "the winner lists the skill it hides");
    assert!(view.read_with(cx, |v, _| v.reading()));
    advance(cx, super::READ_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.reading()) && view.read_with(cx, |v, _| v.read_error().is_none()));
    assert!(drawn(cx, "skill-open") && drawn(cx, "skill-reveal"));
    click(cx, &workspace, "skill-copy");
    assert!(view.read_with(cx, |v, _| v.copied()));
    assert_eq!(cx.update(|_, app| app.read_from_clipboard().and_then(|item| item.text())).as_deref(), Some("/tldr"));
    advance(cx, super::COPIED_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.copied()), "Copied goes back after a moment");
    click(cx, &workspace, "skill-open");
    assert!(view.read_with(cx, |v, _| v.last_action.clone()).unwrap().starts_with("open:"));
    click(cx, &workspace, "skills-back");
    assert!(drawn(cx, "skill-group-workspace") && !drawn(cx, "skill-detail"));
}

#[gpui::test]
fn a_built_in_skill_has_no_file_to_open_and_a_failed_read_says_so(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Skills);
    let view = view(&workspace, cx);
    click(cx, &workspace, "skill-row-bundled-milagre-routines");
    assert!(drawn(cx, "skill-copy") && !drawn(cx, "skill-open") && !drawn(cx, "skill-reveal"));
    click(cx, &workspace, "skills-back");
    click(cx, &workspace, "skill-row-user-review-pr");
    advance(cx, super::READ_MS + 10);
    assert!(view.read_with(cx, |v, _| v.read_error().is_some()));
}

#[gpui::test]
fn reload_reads_again_and_keeps_the_open_skill(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Skills);
    let view = view(&workspace, cx);
    click(cx, &workspace, "skills-reload");
    assert!(view.read_with(cx, |v, _| v.loading()));
    advance(cx, super::READ_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.loading()));
    click(cx, &workspace, "skill-row-user-grill-me");
    advance(cx, super::READ_MS + 10);
    let open = view.read_with(cx, |v, _| v.selected().map(|s| s.name.clone()));
    assert_eq!(open.as_deref(), Some("grill-me"));
}
