//! Headless tests for WP-43 MCP: the rules of `mcp.ts` and `local-mcp.ts` (beside their code in these tests), the
//! page (groups, switches, sign-in, Edit, Remove, Refresh), the Add and Edit sheet (catalog, token, custom form,
//! masked secrets, validation) and Milagre MCP (clients, scope, one-time credential, custom connections).

use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::local::LocalMcpView;
use super::local_logic::{Cap, Draft, DraftKind, Paths};
use super::logic::*;
use super::page::{CHECK_MS, McpView, REFRESH_DEBOUNCE_MS, SIGN_IN_MS};
use super::sections::McpPage;
use crate::data::Provider;
use crate::settings::search::SettingsSectionId;
use crate::testing;
use crate::workspace::Workspace;

pub(crate) fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

pub(crate) fn bounds(cx: &mut VisualTestContext, selector: &str) -> gpui::Bounds<gpui::Pixels> {
    cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

pub(crate) fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(testing::leak(selector.to_string())).is_some()
}

pub(crate) fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

/// Scrolls the Settings body so the element is on screen (when it is not in a dialog), then clicks it.
pub(crate) fn click(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    let at = bounds(cx, selector);
    let body = bounds(cx, "settings-main");
    let overshoot = f32::from(at.bottom() - body.bottom()) + 80.0;
    if overshoot > 0.0 && at.top() > body.top() {
        let settings = workspace.read_with(cx, |w, _| w.settings.clone());
        let handle = settings.read_with(cx, |s, _| s.body_scroll().clone());
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(overshoot)));
        settle(cx);
    }
    let at = bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

pub(crate) fn open(cx: &mut TestAppContext, section: SettingsSectionId) -> (Entity<Workspace>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(section, window, cx));
    settle(cx);
    (workspace, cx)
}

fn page(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<McpPage> {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| s.tools.mcp.clone())
}

fn servers(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<McpView> {
    let page = page(workspace, cx);
    page.read_with(cx, |p, _| p.servers.clone())
}

fn local(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<LocalMcpView> {
    let page = page(workspace, cx);
    page.read_with(cx, |p, _| p.local.clone())
}

/// Focuses a text field and types into it, as a person would.
fn type_into(cx: &mut VisualTestContext, input: &Entity<gpui_component::input::InputState>, text: &str) {
    input.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input(text);
    settle(cx);
}

// ---- rules ----------------------------------------------------------------------------------------------------------

fn account(provider: Provider, id: &str, label: &str) -> Account {
    Account { provider, account_id: id.to_string(), label: label.to_string() }
}

fn server(name: &str, transport: Transport, scope: Scope, state: ChipState) -> ServerReport {
    ServerReport {
        name: name.to_string(),
        transport,
        scope,
        state,
        tools: 3,
        error: None,
        detail: Some("https://mcp.example.com/mcp".to_string()),
        shadowed_by: None,
        disabled_by_provider: false,
    }
}

fn check(account: &Account, servers: Vec<ServerReport>) -> AccountCheck {
    AccountCheck { account: account.clone(), problem: None, servers }
}

#[test]
fn rows_group_by_name_and_outside_rows_by_source_in_order() {
    let a = account(Provider::Claude, "default", "personal");
    let b = account(Provider::Codex, "default", "Codex");
    let grouped = group_rows(&[
        check(
            &a,
            vec![
                server("zeta", Transport::Url, Scope::User, ChipState::Connected),
                server("linear", Transport::Url, Scope::User, ChipState::NeedsSignIn),
                server("claude.ai Gmail", Transport::Connector, Scope::ClaudeAi, ChipState::Connected),
                server("plugin:eng:notion", Transport::Url, Scope::Plugin, ChipState::Connected),
                server("proj", Transport::Command, Scope::Project, ChipState::Connected),
                server("argent", Transport::Command, Scope::BuiltIn, ChipState::Connected),
            ],
        ),
        check(&b, vec![server("zeta", Transport::Url, Scope::Everywhere, ChipState::Connected)]),
    ]);
    assert_eq!(grouped.user.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["linear", "zeta"]);
    let zeta = grouped.user.iter().find(|r| r.name == "zeta").unwrap();
    assert_eq!(zeta.chips.len(), 2);
    assert!(zeta.everywhere && zeta.editable);
    assert_eq!(grouped.attention.len(), 1);
    assert_eq!(grouped.attention[0].name, "linear");
    let order: Vec<&str> = grouped.other.iter().map(|(source, _)| source.as_str()).collect();
    assert_eq!(order, ["Project", "Plugin · eng", "claude.ai connectors", "Built in"]);
    let notion = &grouped.other[1].1[0];
    assert_eq!(notion.short_name(), "notion");
    assert_eq!(grouped.other[2].1[0].short_name(), "Gmail");
}

#[test]
fn summaries_and_lines_read_as_the_desktop_words_them() {
    let a = account(Provider::Claude, "default", "personal");
    let b = account(Provider::Claude, "work", "work");
    let c = account(Provider::Codex, "default", "Codex");
    let grouped = group_rows(&[
        check(&a, vec![server("s", Transport::Url, Scope::User, ChipState::Connected)]),
        check(&b, vec![server("s", Transport::Url, Scope::User, ChipState::Failed)]),
        check(&c, vec![server("s", Transport::Url, Scope::User, ChipState::Disabled)]),
    ]);
    let row = &grouped.user[0];
    assert_eq!(summary(row), "2 of 3 on");
    assert_eq!(row.chips[0].account_name(), "Claude · personal");
    assert_eq!(row.chips[2].account_name(), "Codex");
    assert_eq!(chip_line(&row.chips[0]), "Connected · 3 tools");
    assert_eq!(chip_line(&row.chips[1]), "Failed");
    assert_eq!(chip_line(&row.chips[2]), "Off in Milagre Chats");
    assert_eq!(transport_line(Transport::Url, Some("https://mcp.linear.app/mcp")), "URL · mcp.linear.app");
    assert_eq!(transport_line(Transport::Command, Some("npx -y x")), "Command · npx -y x");
    assert_eq!(transport_line(Transport::Connector, None), "claude.ai connector");
}

#[test]
fn remove_and_edit_targets_follow_where_the_server_lives() {
    let a = account(Provider::Claude, "default", "personal");
    let c = account(Provider::Codex, "default", "Codex");
    let grouped = group_rows(&[
        check(
            &a,
            vec![
                server("s", Transport::Url, Scope::Everywhere, ChipState::Connected),
                server("only", Transport::Url, Scope::User, ChipState::Connected),
            ],
        ),
        check(&c, vec![server("s", Transport::Url, Scope::Everywhere, ChipState::Connected)]),
    ]);
    let s = grouped.user.iter().find(|r| r.name == "s").unwrap();
    assert_eq!(remove_targets(s), [Target::Everywhere]);
    assert_eq!(edit_target(s), Target::Everywhere);
    let only = grouped.user.iter().find(|r| r.name == "only").unwrap();
    assert_eq!(remove_targets(only), [Target::Claude]);
    assert_eq!(target_places(&[Target::Everywhere, Target::Claude, Target::Codex]), "Everywhere, Claude’s config and Codex’s config");
    assert_eq!(target_places(&[Target::Codex]), "Codex’s config");
}

#[test]
fn the_sheet_validates_names_urls_and_commands() {
    let url = |name: &str, url: &str| Definition::Url { name: name.into(), kind: UrlKind::Http, url: url.into(), headers: vec![] };
    assert_eq!(validate(&url("bad name", "https://x.dev")).as_deref(), Some("Use letters, numbers, - and _ only."));
    assert_eq!(validate(&url("milagre", "https://x.dev")).as_deref(), Some("milagre is Milagre’s own server. Pick another name."));
    assert_eq!(validate(&url("ok", "ftp://x")).as_deref(), Some("Enter an http or https URL."));
    assert_eq!(validate(&url("ok", "https://x.dev")), None);
    let headers =
        Definition::Url { name: "ok".into(), kind: UrlKind::Http, url: "https://x.dev".into(), headers: vec![(" ".into(), "v".into())] };
    assert_eq!(validate(&headers).as_deref(), Some("Every header needs a name."));
    let stdio = |command: &str| Definition::Stdio { name: "ok".into(), command: command.into(), args: vec![], env: vec![] };
    assert_eq!(validate(&stdio(" ")).as_deref(), Some("Enter the command to run."));
    assert_eq!(validate(&stdio("npx")), None);
}

#[test]
fn the_catalog_searches_by_every_word_and_builds_a_fresh_definition() {
    assert_eq!(search_catalog("").len(), 15);
    assert_eq!(search_catalog("pull requests").iter().map(|e| e.id).collect::<Vec<_>>(), ["github"]);
    assert!(search_catalog("zzz").is_empty());
    let github = CATALOG[0];
    assert_eq!(catalog_definition(&github, "").unwrap_err(), "Enter a valid personal access token.");
    assert!(catalog_definition(&github, "two words").is_err());
    assert!(catalog_definition(&github, SECRET_MASK).is_err());
    let Definition::Url { headers, .. } = catalog_definition(&github, "Bearer abc123").unwrap() else { panic!("url") };
    assert_eq!(headers, [("Authorization".to_string(), "Bearer abc123".to_string())]);
    let Definition::Url { headers, name, .. } = catalog_definition(&CATALOG[1], "leftover").unwrap() else { panic!("url") };
    assert!(headers.is_empty(), "a browser sign-in service carries no token");
    assert_eq!(name, "linear");
}

#[test]
fn a_draft_round_trips_through_its_configuration() {
    let mut draft = Draft { label: "Notes".into(), write: true, ..Draft::default() };
    assert!(!draft.valid(), "a Project is needed");
    draft.toggle_project("/a");
    draft.toggle_project("/b");
    draft.toggle_project("/a");
    assert!(draft.valid());
    let config = draft.configuration();
    let chats = config.grants.chats.clone().unwrap();
    assert_eq!(chats.caps, [Cap::Read, Cap::Create, Cap::Start]);
    assert_eq!(chats.paths, Paths::Some(vec!["/b".into()]));
    let back = Draft::for_configuration(&config);
    assert_eq!((back.kind, back.write, back.project_paths.clone()), (DraftKind::Projects, true, vec!["/b".to_string()]));
    let mut all = Draft { label: "All".into(), kind: DraftKind::AllProjects, ..Draft::default() };
    assert!(all.valid());
    assert_eq!(Draft::for_configuration(&all.configuration()).kind, DraftKind::AllProjects);
    all.set_kind(DraftKind::Designs);
    assert!(!all.valid(), "designs need a Chat reference");
    all.chat_id = "/p#1".into();
    all.design_ids = "a, b".into();
    let designs = all.configuration().grants.designs.unwrap();
    assert_eq!(designs.caps, [Cap::Read]);
    assert!(matches!(designs.design_ids, super::local_logic::DesignIds::Some(ref ids) if ids == &["a".to_string(), "b".to_string()]));
}

// ---- the page -------------------------------------------------------------------------------------------------------

#[gpui::test]
fn the_page_groups_servers_and_opens_a_row_with_its_accounts(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    assert!(
        drawn(cx, "settings-section-mcp") && drawn(cx, "mcp-needs-sign-in") && drawn(cx, "mcp-your-servers") && drawn(cx, "mcp-outside")
    );
    assert!(drawn(cx, "mcp-attention-linear"));
    assert!(drawn(cx, "mcp-row-filesystem") && !drawn(cx, "mcp-switch-claude-default-filesystem"));
    click(cx, &workspace, "mcp-row-head-filesystem");
    for key in ["claude-default", "claude-work", "codex-default"] {
        assert!(drawn(cx, &format!("mcp-switch-{key}-filesystem")), "{key} switch");
    }
    assert!(drawn(cx, "mcp-edit") && drawn(cx, "mcp-remove"));
    let view = servers(&workspace, cx);
    assert_eq!(view.read_with(cx, |v, _| v.open_row().map(str::to_string)), Some("filesystem".into()));
    // Another row takes the opening over.
    click(cx, &workspace, "mcp-row-head-sentry");
    assert!(!drawn(cx, "mcp-switch-claude-default-filesystem") && drawn(cx, "mcp-switch-codex-default-sentry"));
}

#[gpui::test]
fn a_switch_turns_one_accounts_server_off_and_the_summary_follows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-row-head-filesystem");
    click(cx, &workspace, "mcp-switch-claude-work-filesystem");
    advance(cx, CHECK_MS + 10);
    let view = servers(&workspace, cx);
    let grouped = view.read_with(cx, |v, _| v.rows());
    let row = grouped.user.iter().find(|r| r.name == "filesystem").unwrap();
    assert_eq!(summary(row), "2 of 3 on");
    assert_eq!(row.chips.iter().filter(|c| c.state == ChipState::Disabled).count(), 1);
    click(cx, &workspace, "mcp-switch-claude-work-filesystem");
    advance(cx, CHECK_MS + 10);
    let grouped = view.read_with(cx, |v, _| v.rows());
    assert_eq!(summary(grouped.user.iter().find(|r| r.name == "filesystem").unwrap()), "3 of 3 connected");
}

#[gpui::test]
fn sign_in_waits_for_the_browser_and_cancel_stops_it(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    click(cx, &workspace, "mcp-sign-in-linear");
    assert!(view.read_with(cx, |v, _| v.is_signing_in("linear")));
    assert!(drawn(cx, "mcp-cancel-linear") && !drawn(cx, "mcp-sign-in-linear"));
    click(cx, &workspace, "mcp-cancel-linear");
    assert!(!view.read_with(cx, |v, _| v.is_signing_in("linear")));
    advance(cx, SIGN_IN_MS + 200);
    assert!(drawn(cx, "mcp-attention-linear"), "a cancelled sign-in finishes nothing");
    click(cx, &workspace, "mcp-sign-in-linear");
    advance(cx, SIGN_IN_MS + REFRESH_DEBOUNCE_MS + 4 * CHECK_MS);
    assert!(!drawn(cx, "mcp-needs-sign-in"), "the finished sign-in clears the group");
}

#[gpui::test]
fn remove_asks_in_place_and_names_where(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-row-head-notion");
    click(cx, &workspace, "mcp-remove");
    assert!(drawn(cx, "mcp-remove-question") && !drawn(cx, "mcp-edit"));
    click(cx, &workspace, "mcp-remove-cancel");
    assert!(drawn(cx, "mcp-edit"));
    click(cx, &workspace, "mcp-remove");
    click(cx, &workspace, "mcp-remove-confirm");
    advance(cx, REFRESH_DEBOUNCE_MS + 4 * CHECK_MS);
    assert!(!drawn(cx, "mcp-row-notion"));
}

#[gpui::test]
fn a_failed_remove_names_the_config_it_could_not_change(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    view.update(cx, |v, _| v.host.fail_remove = Some(Target::Codex));
    click(cx, &workspace, "mcp-row-head-sentry");
    click(cx, &workspace, "mcp-remove");
    click(cx, &workspace, "mcp-remove-confirm");
    let error = view.read_with(cx, |v, _| v.error().to_string());
    assert_eq!(error, "Couldn’t remove sentry from Codex’s config. Permission denied.");
    assert!(drawn(cx, "inline-error"));
}

#[gpui::test]
fn refresh_checks_every_account_again_and_reports_when(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    click(cx, &workspace, "mcp-refresh");
    assert!(view.read_with(cx, |v, _| v.checking()));
    advance(cx, 3 * CHECK_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.checking()));
    assert!(drawn(cx, "mcp-refresh"));
}

#[gpui::test]
fn an_account_that_cannot_be_checked_says_why_and_keeps_the_rest(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    let work = account(Provider::Claude, "work", "work");
    view.update(cx, |v, _| v.host.set_problem(&work, Some("Not signed in.")));
    click(cx, &workspace, "mcp-refresh");
    advance(cx, 3 * CHECK_MS + 10);
    assert!(drawn(cx, "mcp-problem-claude-work"));
    assert!(drawn(cx, "mcp-row-filesystem"));
}

#[gpui::test]
fn the_outside_group_expands_to_its_sources_in_order(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-other");
    for row in ["happiergym-db", "plugin-engineering-datadog", "claude-ai-gmail", "argent"] {
        assert!(drawn(cx, &format!("mcp-row-{row}")), "{row}");
    }
    // Needs sign-in rows of outside groups list first in their group, compact, with the Sign in button.
    assert!(drawn(cx, "mcp-attention-plugin-engineering-atlassian") && drawn(cx, "mcp-attention-claude-ai-slack"));
    let project = bounds(cx, "mcp-row-happiergym-db").top();
    let gmail = bounds(cx, "mcp-row-claude-ai-gmail").top();
    assert!(project < gmail, "Project comes before claude.ai connectors");
    // A provider's own switch-off cannot be turned on from here.
    click(cx, &workspace, "mcp-row-head-happiergym-db");
    click(cx, &workspace, "mcp-switch-codex-default-happiergym-db");
    advance(cx, CHECK_MS + 10);
    let view = servers(&workspace, cx);
    let grouped = view.read_with(cx, |v, _| v.rows());
    let (_, rows) = grouped.other.iter().find(|(s, _)| s == "Project").unwrap();
    assert!(rows[0].chips.iter().any(|c| c.account.provider == Provider::Codex && c.disabled_by_provider));
}

// ---- the sheet ------------------------------------------------------------------------------------------------------

#[gpui::test]
fn add_server_lists_the_catalog_and_a_token_service_needs_its_token(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-add");
    assert!(drawn(cx, "mcp-sheet") && drawn(cx, "mcp-catalog") && drawn(cx, "mcp-service-github") && drawn(cx, "mcp-custom"));
    click(cx, &workspace, "mcp-service-github");
    assert!(drawn(cx, "mcp-service-form") && drawn(cx, "mcp-token"));
    click(cx, &workspace, "mcp-sheet-submit");
    assert!(drawn(cx, "mcp-sheet-error"), "an empty token is refused");
    assert!(drawn(cx, "mcp-sheet"), "the sheet stays open");
    let view = servers(&workspace, cx);
    assert!(!view.read_with(cx, |v, _| v.host.stored_names().contains(&"github".to_string())));
    click(cx, &workspace, "mcp-back");
    assert!(drawn(cx, "mcp-catalog"));
}

#[gpui::test]
fn a_token_service_saves_with_its_token_and_closes_the_sheet(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-add");
    click(cx, &workspace, "mcp-service-github");
    let sheet = open_sheet(&workspace, cx);
    type_into(cx, &sheet.read_with(cx, |s, _| s.token_input()), "ghp_abc123");
    click(cx, &workspace, "mcp-sheet-submit");
    assert!(!drawn(cx, "mcp-sheet"), "a saved sheet closes");
    let view = servers(&workspace, cx);
    assert!(view.read_with(cx, |v, _| v.host.stored_names().contains(&"github".to_string())));
    assert_eq!(
        view.read_with(cx, |v, _| v.host.stored_secret("github", Target::Everywhere, "Authorization")),
        Some("Bearer ghp_abc123".to_string())
    );
    advance(cx, REFRESH_DEBOUNCE_MS + 4 * CHECK_MS);
    assert!(drawn(cx, "mcp-row-github"));
}

fn open_sheet(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<super::sheet::McpSheet> {
    servers(workspace, cx).read_with(cx, |v, _| v.sheet()).expect("the sheet is open")
}

#[gpui::test]
fn the_custom_form_validates_and_adds_a_url_server_that_then_signs_in(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-add");
    click(cx, &workspace, "mcp-custom");
    assert!(drawn(cx, "mcp-custom-form") && drawn(cx, "mcp-name") && drawn(cx, "mcp-url"));
    let sheet = open_sheet(&workspace, cx);
    assert_eq!(sheet.read_with(cx, |s, _| s.primary_label()), "Add and sign in");
    type_into(cx, &sheet.read_with(cx, |s, _| s.name_input()), "bad name");
    type_into(cx, &sheet.read_with(cx, |s, _| s.url_input()), "https://mcp.example.com/mcp");
    click(cx, &workspace, "mcp-sheet-submit");
    assert_eq!(sheet.read_with(cx, |s, _| s.error().to_string()), "Use letters, numbers, - and _ only.");
    // Typing again clears the problem.
    let name = sheet.read_with(cx, |s, _| s.name_input());
    name.update_in(cx, |state, window, cx| state.set_value("", window, cx));
    type_into(cx, &name, "example");
    assert_eq!(sheet.read_with(cx, |s, _| s.error().to_string()), "");
    click(cx, &workspace, "mcp-target-codex");
    assert_eq!(sheet.read_with(cx, |s, _| s.target()), Target::Codex);
    click(cx, &workspace, "mcp-sheet-submit");
    assert!(!drawn(cx, "mcp-sheet"));
    let view = servers(&workspace, cx);
    assert!(view.read_with(cx, |v, _| v.host.stored_names().contains(&"example".to_string())));
    // "Add and sign in": the refresh its save causes starts the sign-in at once.
    advance(cx, REFRESH_DEBOUNCE_MS + 4 * CHECK_MS);
    assert!(
        view.read_with(cx, |v, _| v.is_signing_in("example"))
            || !view.read_with(cx, |v, _| v.rows().attention.iter().any(|r| r.name == "example"))
    );
}

#[gpui::test]
fn the_command_form_keeps_one_argument_per_line(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    click(cx, &workspace, "mcp-add");
    click(cx, &workspace, "mcp-custom");
    click(cx, &workspace, "mcp-kind-command");
    let sheet = open_sheet(&workspace, cx);
    assert_eq!(sheet.read_with(cx, |s, _| s.kind()), super::sheet::Kind::Command);
    assert!(drawn(cx, "mcp-command") && drawn(cx, "mcp-args"));
    assert_eq!(sheet.read_with(cx, |s, _| s.primary_label()), "Add server");
    sheet.read_with(cx, |s, _| s.name_input()).update_in(cx, |state, window, cx| state.set_value("files", window, cx));
    sheet.read_with(cx, |s, _| s.command_input()).update_in(cx, |state, window, cx| state.set_value(" npx ", window, cx));
    sheet
        .read_with(cx, |s, _| s.args_input())
        .update_in(cx, |state, window, cx| state.set_value("-y\n\n@scope/server with space\n", window, cx));
    let def = cx.update(|_, app| sheet.read(app).definition(app));
    let Definition::Stdio { command, args, .. } = def else { panic!("stdio") };
    assert_eq!(command, "npx");
    assert_eq!(args, ["-y", "@scope/server with space"]);
}

#[gpui::test]
fn editing_keeps_a_masked_secret_unless_it_is_retyped(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    click(cx, &workspace, "mcp-row-head-notion");
    click(cx, &workspace, "mcp-edit");
    assert!(drawn(cx, "mcp-sheet"));
    let sheet = open_sheet(&workspace, cx);
    assert_eq!(sheet.read_with(cx, |s, _| s.title()), "Edit MCP server");
    let (key, value) = sheet.read_with(cx, |s, _| s.pair_inputs()).remove(0);
    assert_eq!(cx.update(|_, app| key.read(app).value().to_string()), "Authorization");
    assert_eq!(cx.update(|_, app| value.read(app).value().to_string()), SECRET_MASK, "the secret leaves the host masked");
    // Focusing a masked value clears it so a new one can be typed; leaving it alone brings the mask back.
    value.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    assert_eq!(cx.update(|_, app| value.read(app).value().to_string()), "");
    key.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    assert_eq!(cx.update(|_, app| value.read(app).value().to_string()), SECRET_MASK);
    click(cx, &workspace, "mcp-sheet-submit");
    assert!(!drawn(cx, "mcp-sheet"));
    assert_eq!(
        view.read_with(cx, |v, _| v.host.stored_secret("notion", Target::Claude, "Authorization")),
        Some("Bearer ntn_live_9f3a".to_string()),
        "an untouched secret is kept"
    );
    // Retyped, it replaces the stored one.
    advance(cx, REFRESH_DEBOUNCE_MS + 4 * CHECK_MS);
    click(cx, &workspace, "mcp-edit");
    let sheet = open_sheet(&workspace, cx);
    let (_, value) = sheet.read_with(cx, |s, _| s.pair_inputs()).remove(0);
    type_into(cx, &value, "Bearer fresh");
    click(cx, &workspace, "mcp-sheet-submit");
    assert_eq!(
        view.read_with(cx, |v, _| v.host.stored_secret("notion", Target::Claude, "Authorization")),
        Some("Bearer fresh".to_string())
    );
}

#[gpui::test]
fn escape_closes_the_sheet_and_saves_nothing(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = servers(&workspace, cx);
    let before = view.read_with(cx, |v, _| v.host.stored_names());
    click(cx, &workspace, "mcp-add");
    assert!(drawn(cx, "mcp-sheet"));
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(!drawn(cx, "mcp-sheet"));
    assert_eq!(view.read_with(cx, |v, _| v.host.stored_names()), before);
}

// ---- Milagre MCP ----------------------------------------------------------------------------------------------------

#[gpui::test]
fn enabling_a_client_asks_for_its_scope_first(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = local(&workspace, cx);
    assert!(drawn(cx, "local-client-claude-code") && drawn(cx, "local-client-zed"));
    click(cx, &workspace, "local-enable-cursor");
    assert!(drawn(cx, "local-mcp-setup"));
    assert_eq!(view.read_with(cx, |v, _| v.setup().map(str::to_string)), Some("cursor".into()));
    assert_eq!(view.read_with(cx, |v, _| v.draft().label.clone()), "Cursor");
    // No Project chosen yet: Enable does nothing.
    click(cx, &workspace, "local-mcp-submit");
    assert!(!view.read_with(cx, |v, _| v.host.clients.iter().any(|c| c.id == "cursor" && c.enabled)));
    let name = view.read_with(cx, |v, _| v.host.projects[0].1.clone());
    click(cx, &workspace, &format!("local-mcp-project-{}", crate::settings::group::slug(&name)));
    click(cx, &workspace, "local-mcp-write");
    click(cx, &workspace, "local-mcp-submit");
    advance(cx, super::local::BUSY_MS + 10);
    let client = view.read_with(cx, |v, _| v.host.clients.iter().find(|c| c.id == "cursor").cloned().unwrap());
    assert!(client.enabled);
    assert_eq!(super::local_logic::client_detail(&client), "1 Project · Read and write");
    assert!(!drawn(cx, "local-mcp-setup"));
    // Turning it off removes its connection.
    click(cx, &workspace, "local-enable-cursor");
    advance(cx, super::local::BUSY_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.host.clients.iter().any(|c| c.id == "cursor" && c.enabled)));
    // A client the platform cannot configure cannot be enabled.
    click(cx, &workspace, "local-enable-zed");
    assert!(!drawn(cx, "local-mcp-setup"));
}

#[gpui::test]
fn a_custom_connection_shows_its_credential_once(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = local(&workspace, cx);
    click(cx, &workspace, "local-mcp-custom");
    assert!(view.read_with(cx, |v, _| v.custom_open()) && drawn(cx, "custom-mcp-settings"));
    click(cx, &workspace, "local-mcp-create");
    assert_eq!(view.read_with(cx, |v, _| v.setup().map(str::to_string)), Some("custom".into()));
    type_into(cx, &view.read_with(cx, |v, _| v.label_input()).unwrap(), "Scripts");
    click(cx, &workspace, "local-mcp-kind-all-projects");
    click(cx, &workspace, "local-mcp-submit");
    advance(cx, super::local::BUSY_MS + 10);
    assert!(drawn(cx, "local-mcp-credential"));
    let token = view.read_with(cx, |v, _| v.credential().unwrap().token.clone());
    click(cx, &workspace, "local-mcp-copy");
    assert!(view.read_with(cx, |v, _| v.copied()));
    let copied = cx.update(|_, app| app.read_from_clipboard().and_then(|item| item.text())).unwrap();
    assert!(copied.contains(&format!("Bearer {token}")) && copied.contains("\"mcpServers\""));
    click(cx, &workspace, "local-mcp-done");
    assert!(!drawn(cx, "local-mcp-credential") && view.read_with(cx, |v, _| v.credential().is_none()));
}

#[gpui::test]
fn custom_connections_can_be_replaced_restricted_and_revoked(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    let view = local(&workspace, cx);
    click(cx, &workspace, "local-mcp-custom");
    click(cx, &workspace, "local-mcp-manage");
    assert!(drawn(cx, "local-connection-conn-notes"));
    // Expired and revoked connections have no actions.
    assert!(drawn(cx, "local-connection-conn-ci") && !drawn(cx, "local-rotate-conn-ci") && !drawn(cx, "local-rotate-conn-old"));
    click(cx, &workspace, "local-restrict-conn-notes");
    advance(cx, super::local::BUSY_MS + 10);
    let notes = view.read_with(cx, |v, _| v.host.connections.iter().find(|c| c.id == "conn-notes").cloned().unwrap());
    assert!(!notes.writable() && notes.revision == 3);
    assert!(!drawn(cx, "local-restrict-conn-notes"), "a read-only connection has nothing to restrict");
    click(cx, &workspace, "local-rotate-conn-notes");
    advance(cx, super::local::BUSY_MS + 10);
    assert!(view.read_with(cx, |v, _| v.credential().is_some()));
    click(cx, &workspace, "local-mcp-done");
    click(cx, &workspace, "local-revoke-conn-notes");
    advance(cx, super::local::BUSY_MS + 10);
    assert!(!drawn(cx, "local-rotate-conn-notes"));
}

#[gpui::test]
fn the_milagre_mcp_heading_follows_a_search_result(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Mcp);
    assert!(drawn(cx, "mcp-local-heading") && drawn(cx, "local-mcp"));
    let _ = workspace;
}
