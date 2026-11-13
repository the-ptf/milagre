//! The dialogs of WP-50 in GPUI's headless test platform: each opened through `ui::Dialog` under `Root` on the
//! [`FixtureHost`], its host calls driven by the test clock.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, Window, div, prelude::*};

use super::allow_prompt::{self, ARM_FOR};
use super::copy::*;
use super::delete_link::{self, RECHECK};
use super::host::{NamedLink, PendingComputer};
use super::project_chooser::{ChooserEvent, ChooserState, ProjectChooser};
use super::release_notes::{self, Notes};
use super::{FixtureHost, Host, STEP, add_computer, add_project, handoff_brief, link_projects, quit_error, remove_project};
use crate::data::{Computer, ComputerState, Provider};
use crate::testing;

struct Blank;
impl gpui::Render for Blank {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        div().size_full()
    }
}

fn mount(cx: &mut TestAppContext) -> (FixtureHost, Host, &mut VisualTestContext) {
    let (_blank, cx) = testing::mount_in_root(cx, |_, _| Blank);
    let fixture = FixtureHost::new();
    let host: Host = Rc::new(fixture.clone());
    (fixture, host, cx)
}

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
    }
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    settle(cx);
    let at = testing::bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    cx.run_until_parked();
}

fn elapse(cx: &mut VisualTestContext, by: Duration) {
    cx.executor().advance_clock(by);
    cx.run_until_parked();
    settle(cx);
}

/// Whether `selector` is gone once the dialog's exit has played.
fn gone(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    elapse(cx, Duration::from_millis(400));
    !drawn(cx, selector)
}

/// Types into the field `selector` the way a person does: a click, then the keys.
fn type_keys(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_input(text);
    cx.run_until_parked();
    settle(cx);
}

fn type_into<V: 'static>(input: &Entity<gpui_component::input::InputState>, text: &str, cx: &mut VisualTestContext) {
    let text = text.to_string();
    cx.update(|window, cx| input.update(cx, |state, cx| state.set_value(text, window, cx)));
    cx.run_until_parked();
    let _ = std::marker::PhantomData::<V>;
}

fn link(name: &str, ids: &[&str]) -> NamedLink {
    NamedLink { id: "link-1".into(), name: name.into(), project_ids: ids.iter().map(|id| id.to_string()).collect() }
}

fn computers() -> Vec<Computer> {
    let computer = |id: &str, name: &str, state| Computer { id: id.into(), name: name.into(), state, message: None };
    vec![computer("studio", "Studio", ComputerState::Online), computer("tianxu", "Tianxu", ComputerState::Offline)]
}

// ---- copy ----

#[test]
fn the_words_match_the_desktops() {
    let text = delete_link_text("Food", 3);
    assert_eq!(text.title, "Delete Food?");
    assert_eq!(text.action, "Delete Link");
    assert!(
        text.message.starts_with("Its 3 Chats are archived, and their transcripts stay on disk. Worktrees without changes are removed. ")
    );
    assert!(delete_link_text("Food", 0).message.starts_with("It has no Chats. "));
    assert!(delete_link_text("Food", 1).message.starts_with("Its Chat is archived, and its transcript stays on disk. "));
    assert_eq!(link_running_text(&["Fix header".into()]), "Fix header is running. Stop it before deleting the Link.");
    assert_eq!(link_running_text(&["A".into(), "B".into(), "C".into()]), "A, B and C are running. Stop them before deleting the Link.");
    assert_eq!(link_delete_failure("Unknown command: link:delete", "Studio"), "Update Milagre on Studio to delete its Links.");
    assert_eq!(link_delete_failure("Link no longer exists", "Studio"), "Link no longer exists");
    assert_eq!(allow_question(Some("Studio"), "this computer"), "Studio wants to drive this computer\u{2019}s chats");
    assert_eq!(allow_question(None, "this computer"), "A computer wants to drive this computer\u{2019}s chats");
    let side = |provider, name: Option<&str>| HandoffSide { provider, model_name: name.map(str::to_string) };
    let label = handoff_label(&side(Provider::Claude, Some("Opus 5.5")), &side(Provider::Codex, None));
    assert_eq!((label.from.as_str(), label.to.as_str(), label.restored), ("Opus 5.5", Provider::Codex.name(), false));
    assert!(handoff_label(&side(Provider::Claude, None), &side(Provider::Claude, None)).restored);
}

// ---- Remove Project ----

#[gpui::test]
fn remove_project_asks_then_forgets_and_reports(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let removed = Rc::new(RefCell::new(Vec::new()));
    let seen = removed.clone();
    let view = cx.update(|window, cx| {
        remove_project::open(("/code/web", "web"), host, move |path, _| seen.borrow_mut().push(path.to_string()), window, cx)
    });
    cx.run_until_parked();
    assert!(drawn(cx, "project-remove-confirm") && drawn(cx, "project-remove-cancel"));
    click(cx, "project-remove-confirm");
    assert!(view.read_with(cx, |d, _| d.is_busy()), "Removing… while the host works");
    click_ignored(cx);
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*removed.borrow(), ["/code/web"]);
    assert_eq!(fixture.state.lock().unwrap().forgotten, ["/code/web"], "forgotten once");
    assert!(gone(cx, "project-remove-confirm"), "the dialog closed");
}

fn click_ignored(_: &mut VisualTestContext) {}

#[gpui::test]
fn a_failed_remove_shows_the_error_and_stays_open(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.fail_next = Some("The host is busy.".into()));
    let view = cx.update(|window, cx| remove_project::open(("/code/web", "web"), host, |_, _| {}, window, cx));
    cx.run_until_parked();
    click(cx, "project-remove-confirm");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(view.read_with(cx, |d, _| d.error().to_string()), "The host is busy.");
    assert!(!view.read_with(cx, |d, _| d.is_busy()) && drawn(cx, "project-remove-confirm"));
}

#[gpui::test]
fn cancel_closes_without_asking_the_host(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    cx.update(|window, cx| remove_project::open(("/code/web", "web"), host, |_, _| {}, window, cx));
    cx.run_until_parked();
    click(cx, "project-remove-cancel");
    assert!(gone(cx, "project-remove-confirm"));
    assert!(fixture.state.lock().unwrap().forgotten.is_empty());
}

// ---- Delete Link ----

#[gpui::test]
fn delete_link_says_how_many_chats_and_deletes(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let deleted = Rc::new(RefCell::new(0));
    let seen = deleted.clone();
    let view = cx.update(|window, cx| {
        delete_link::open(link("Food", &[]), "this computer", host, move |_, _, _| *seen.borrow_mut() += 1, window, cx)
    });
    cx.run_until_parked();
    settle(cx);
    assert_eq!(view.read_with(cx, |d, _| d.check().map(|c| c.chats)), Some(3));
    click(cx, "link-delete-confirm");
    assert!(view.read_with(cx, |d, _| d.is_busy()));
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*deleted.borrow(), 1);
    assert_eq!(fixture.state.lock().unwrap().deleted_links, ["link-1"]);
    assert!(gone(cx, "link-delete-confirm"));
}

#[gpui::test]
fn a_running_chat_holds_the_delete_and_it_rechecks_every_two_seconds(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.running_checks = 2);
    let view = cx.update(|window, cx| delete_link::open(link("Food", &[]), "this computer", host, |_, _, _| {}, window, cx));
    cx.run_until_parked();
    settle(cx);
    assert_eq!(view.read_with(cx, |d, _| d.running_text()), "Fix header is running. Stop it before deleting the Link.");
    // The button is off: a click does nothing.
    click(cx, "link-delete-confirm");
    assert!(!view.read_with(cx, |d, _| d.is_busy()));
    elapse(cx, RECHECK + Duration::from_millis(10));
    assert!(!view.read_with(cx, |d, _| d.running_text().is_empty()), "still running at the second check");
    elapse(cx, RECHECK + Duration::from_millis(10));
    assert!(view.read_with(cx, |d, _| d.running_text().is_empty()), "the Chat stopped");
    click(cx, "link-delete-confirm");
    assert!(view.read_with(cx, |d, _| d.is_busy()));
}

#[gpui::test]
fn a_link_deleted_elsewhere_closes_the_dialog(cx: &mut TestAppContext) {
    let (_fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| delete_link::open(link("Food", &[]), "this computer", host, |_, _, _| {}, window, cx));
    cx.run_until_parked();
    settle(cx);
    cx.update(|window, cx| view.update(cx, |d, cx| d.link_state(true, window, cx)));
    cx.run_until_parked();
    assert!(gone(cx, "link-delete-confirm"));
}

#[gpui::test]
fn a_failed_check_is_said_by_computer(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.fail_next = Some("No handler registered for 'link:delete-check'".into()));
    let view = cx.update(|window, cx| delete_link::open(link("Food", &[]), "Studio", host, |_, _, _| {}, window, cx));
    cx.run_until_parked();
    assert_eq!(view.read_with(cx, |d, _| d.error().to_string()), "Update Milagre on Studio to delete its Links.");
    assert!(view.read_with(cx, |d, _| d.check().is_none()));
}

// ---- allow prompt ----

fn pending(keys: &[(&str, Option<&str>)]) -> Vec<PendingComputer> {
    keys.iter().map(|(key, name)| PendingComputer { key: key.to_string(), name: name.map(str::to_string) }).collect()
}

#[gpui::test]
fn the_allow_prompt_arms_its_buttons_after_half_a_second(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.pending = pending(&[("a", Some("Studio"))]));
    let prompt = cx.update(|_, cx| allow_prompt::new(host, "this computer", cx));
    cx.update(|window, cx| prompt.update(cx, |p, cx| p.set_requests(pending(&[("a", Some("Studio"))]), window, cx)));
    cx.run_until_parked();
    settle(cx);
    assert!(drawn(cx, "allow-allow") && !prompt.read_with(cx, |p, _| p.is_armed()));
    click(cx, "allow-allow");
    assert!(fixture.state.lock().unwrap().answered.is_empty(), "a click before it is armed does nothing");
    elapse(cx, ARM_FOR + Duration::from_millis(10));
    assert!(prompt.read_with(cx, |p, _| p.is_armed()));
    click(cx, "allow-allow");
    assert_eq!(fixture.state.lock().unwrap().answered, [("a".to_string(), true)]);
    assert!(!prompt.read_with(cx, |p, _| p.is_shown()), "closed once nothing waits");
    assert!(gone(cx, "allow-allow"));
}

#[gpui::test]
fn escape_denies_and_the_next_request_is_asked_in_turn(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let both = pending(&[("a", Some("Studio")), ("b", None)]);
    fixture.with(|s| s.pending = both.clone());
    let prompt = cx.update(|_, cx| allow_prompt::new(host, "this computer", cx));
    cx.update(|window, cx| prompt.update(cx, |p, cx| p.set_requests(both, window, cx)));
    cx.run_until_parked();
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert_eq!(fixture.state.lock().unwrap().answered, [("a".to_string(), false)], "Escape answers Deny");
    assert_eq!(prompt.read_with(cx, |p, _| p.request().map(|r| r.key.clone())), Some("b".into()));
    assert!(!prompt.read_with(cx, |p, _| p.is_armed()), "the next request is not armed yet");
    assert!(prompt.read_with(cx, |p, _| p.is_shown()));
}

#[gpui::test]
fn a_failed_answer_shows_on_its_request_only(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let one = pending(&[("a", Some("Studio"))]);
    fixture.with(|s| s.fail_next = Some("It gave up.".into()));
    let prompt = cx.update(|_, cx| allow_prompt::new(host, "this computer", cx));
    cx.update(|window, cx| prompt.update(cx, |p, cx| p.set_requests(one, window, cx)));
    elapse(cx, ARM_FOR + Duration::from_millis(10));
    click(cx, "allow-deny");
    assert_eq!(prompt.read_with(cx, |p, _| p.error().map(str::to_string)), Some("It gave up.".into()));
    cx.update(|window, cx| prompt.update(cx, |p, cx| p.set_requests(pending(&[("c", None)]), window, cx)));
    assert_eq!(prompt.read_with(cx, |p, _| p.error().map(str::to_string)), None);
}

// ---- release notes, brief, quit error ----

#[gpui::test]
fn release_notes_load_then_show_and_a_failure_can_be_retried(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.fail_next = Some("offline".into()));
    let view = cx.update(|window, cx| release_notes::open("0.232.0", host, window, cx));
    cx.run_until_parked();
    assert_eq!(view.read_with(cx, |d, _| d.notes().clone()), Notes::Loading);
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(view.read_with(cx, |d, _| d.notes().clone()), Notes::Failed);
    click(cx, "notes-retry");
    assert_eq!(view.read_with(cx, |d, _| d.notes().clone()), Notes::Loading);
    elapse(cx, STEP + Duration::from_millis(10));
    assert!(matches!(view.read_with(cx, |d, _| d.notes().clone()), Notes::Text(text) if text.contains("Command palette")));
    assert!(drawn(cx, "notes-body"));
    click(cx, "notes-close");
    assert!(gone(cx, "notes-body"));
}

#[gpui::test]
fn a_version_without_notes_says_so(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    fixture.with(|s| s.notes = Some(String::new()));
    let view = cx.update(|window, cx| release_notes::open("0.1.0", host, window, cx));
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(view.read_with(cx, |d, _| d.notes().clone()), Notes::Empty);
}

#[gpui::test]
fn the_handoff_brief_opens_and_closes(cx: &mut TestAppContext) {
    let (_fixture, _host, cx) = mount(cx);
    cx.update(|window, cx| handoff_brief::open("Handoff brief", "## Where we are\n\n- one\n- two", window, cx));
    cx.run_until_parked();
    settle(cx);
    assert!(drawn(cx, "brief-preview"));
    click(cx, "brief-close");
    assert!(gone(cx, "brief-preview"));
}

#[gpui::test]
fn the_quit_error_must_be_answered_and_a_failed_retry_shows_the_new_message(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| quit_error::open("ENOSPC", host, window, cx));
    cx.run_until_parked();
    settle(cx);
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(drawn(cx, "quit-retry"), "Escape does not dismiss it");
    fixture.with(|s| s.fail_next = Some("EACCES".into()));
    click(cx, "quit-retry");
    assert_eq!(view.read_with(cx, |d, _| d.message().to_string()), "EACCES");
    click(cx, "quit-retry");
    assert_eq!(fixture.state.lock().unwrap().quit_retries, 1);
    assert!(gone(cx, "quit-retry"));
}

// ---- Link Projects ----

#[gpui::test]
fn a_link_needs_a_name_and_two_projects(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let saved = Rc::new(RefCell::new(Vec::new()));
    let seen = saved.clone();
    let view =
        cx.update(|window, cx| link_projects::open(None, host, move |link, _| seen.borrow_mut().push(link.name.clone()), None, window, cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |d, _| d.is_loading()), "skeleton rows while the Projects load");
    elapse(cx, STEP + Duration::from_millis(10));
    assert!(drawn(cx, "link-project-0") && drawn(cx, "link-project-4"));
    assert!(!view.read_with(cx, |d, cx| d.can_save(cx)));
    click(cx, "link-project-0");
    click(cx, "link-project-1");
    assert_eq!(view.read_with(cx, |d, _| d.selected().len()), 2);
    assert!(!view.read_with(cx, |d, cx| d.can_save(cx)), "still no name");
    let name = view.read_with(cx, |d, _| d.name_input().clone());
    type_into::<()>(&name, "RDFood", cx);
    assert!(view.read_with(cx, |d, cx| d.can_save(cx)));
    click(cx, "link-save");
    assert!(view.read_with(cx, |d, _| d.is_saving()));
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*saved.borrow(), ["RDFood"]);
    assert_eq!(fixture.state.lock().unwrap().saved[0].project_ids.len(), 2);
    assert!(gone(cx, "link-save"));
    // Toggling again deselects.
}

#[gpui::test]
fn search_narrows_the_projects_and_a_member_with_no_folder_is_still_listed(cx: &mut TestAppContext) {
    let (_fixture, host, cx) = mount(cx);
    let gone = link("RDFood", &["/Users/dev/Code/rd-mobile", "/Users/dev/Code/removed-app"]);
    let view = cx.update(|window, cx| link_projects::open(Some(gone), host, |_, _| {}, Some(Rc::new(|_, _, _| {})), window, cx));
    elapse(cx, STEP + Duration::from_millis(10));
    let names = |cx: &mut VisualTestContext| cx.update(|_, cx| view.read(cx).visible(cx).into_iter().map(|p| p.name).collect::<Vec<_>>());
    assert!(names(cx).len() == 6, "five Projects and the member whose folder is gone");
    assert!(drawn(cx, "link-delete"), "editing offers Delete Link…");
    assert_eq!(view.read_with(cx, |d, _| d.selected().len()), 2);
    let search = view.read_with(cx, |d, _| d.search_input().clone());
    type_into::<()>(&search, "rd-", cx);
    assert_eq!(names(cx), ["rd-mobile", "rd-food"]);
    assert!(view.read_with(cx, |d, cx| d.can_save(cx)), "the edit starts with its name and members");
}

#[gpui::test]
fn the_edit_hands_delete_link_to_its_caller_and_a_failed_save_stays_open(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let asked = Rc::new(RefCell::new(Vec::new()));
    let seen = asked.clone();
    let on_delete: link_projects::DeleteLink = Rc::new(move |link, _, _| seen.borrow_mut().push(link.id.clone()));
    let existing = link("RDFood", &["/Users/dev/Code/rd-mobile", "/Users/dev/Code/rd-food"]);
    let view = cx.update(|window, cx| link_projects::open(Some(existing), host, |_, _| {}, Some(on_delete), window, cx));
    elapse(cx, STEP + Duration::from_millis(10));
    click(cx, "link-delete");
    assert_eq!(*asked.borrow(), ["link-1"]);
    fixture.with(|s| s.fail_next = Some("Link no longer exists".into()));
    click(cx, "link-save");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(view.read_with(cx, |d, _| d.error().to_string()), "Link no longer exists");
    assert!(!view.read_with(cx, |d, _| d.is_saving()) && drawn(cx, "link-save"));
}

// ---- Add computer ----

const LINK: &str = "milagre://pair?relay=https%3A%2F%2Frelay.milagre.cloud&host=h1&key=k&token=0&name=Studio+Mac";

#[test]
fn private_only_needs_a_private_route() {
    assert!(add_computer::private_pairing_link(LINK).is_err());
    let with_route =
        format!("{LINK}&direct=%5B%22http%3A%2F%2F192.168.1.5%3A8788%22%5D").replace("%22", "\"").replace("%5B", "[").replace("%5D", "]");
    assert!(add_computer::private_pairing_link(&with_route).is_ok(), "{with_route}");
    assert!(add_computer::private_pairing_link("nope").unwrap_err().contains("not a Milagre pairing link"));
}

#[gpui::test]
fn a_pasted_link_is_read_and_the_computer_is_added_after_it_allows(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let added = Rc::new(RefCell::new(Vec::new()));
    let seen = added.clone();
    let view = cx.update(|window, cx| add_computer::open(host, move |name, _| seen.borrow_mut().push(name.to_string()), window, cx));
    cx.run_until_parked();
    settle(cx);
    assert!(!drawn(cx, "add-computer-found"));
    type_keys(cx, "add-computer-link", "not a link");
    assert!(view.read_with(cx, |d, _| d.error().is_some_and(|e| e.contains("not a Milagre pairing link"))));
    cx.update(|window, cx| view.update(cx, |d, cx| d.paste_text(LINK, window, cx)));
    cx.run_until_parked();
    settle(cx);
    assert_eq!(view.read_with(cx, |d, _| d.preview().map(|p| p.name.clone())), Some("Studio Mac".into()));
    assert!(drawn(cx, "add-computer-found") && view.read_with(cx, |d, _| d.error().is_none()));
    let name = view.read_with(cx, |d, cx| d.name_input().read(cx).value().to_string());
    assert_eq!(name, "Studio Mac", "the name is the computer's own until typed over");
    click(cx, "add-computer-add");
    assert!(view.read_with(cx, |d, _| d.is_adding()));
    elapse(cx, STEP + Duration::from_millis(10));
    assert!(drawn(cx, "add-computer-waiting"), "waiting for the other computer to allow");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*added.borrow(), ["Studio Mac"]);
    assert_eq!(fixture.state.lock().unwrap().added_computers.len(), 1);
    assert!(gone(cx, "add-computer-add"));
}

#[gpui::test]
fn cancelling_while_waiting_stops_the_pairing_and_keeps_the_dialog(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| add_computer::open(host, |_, _| {}, window, cx));
    cx.update(|window, cx| view.update(cx, |d, cx| d.paste_text(LINK, window, cx)));
    cx.run_until_parked();
    settle(cx);
    click(cx, "add-computer-add");
    elapse(cx, STEP + Duration::from_millis(10));
    click(cx, "add-computer-cancel");
    assert_eq!(fixture.state.lock().unwrap().cancelled_adds, 1);
    assert!(!view.read_with(cx, |d, _| d.is_adding() || d.is_waiting()));
    elapse(cx, STEP * 3);
    assert!(fixture.state.lock().unwrap().added_computers.is_empty(), "the pairing never completed");
    assert!(drawn(cx, "add-computer-add"), "the dialog stays for another try");
}

#[gpui::test]
fn lan_only_rejects_a_link_with_no_private_route(cx: &mut TestAppContext) {
    let (_fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| add_computer::open(host, |_, _| {}, window, cx));
    cx.update(|window, cx| view.update(cx, |d, cx| d.paste_text(LINK, window, cx)));
    cx.update(|window, cx| view.update(cx, |d, cx| d.set_private_only(true, window, cx)));
    cx.run_until_parked();
    assert!(view.read_with(cx, |d, _| d.preview().is_none() && d.error().is_some_and(|e| e.contains("no private network address"))));
}

// ---- Add Project ----

#[gpui::test]
fn add_project_on_this_computer_uses_its_chooser(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let opened = Rc::new(RefCell::new(Vec::new()));
    let seen = opened.clone();
    cx.update(|window, cx| {
        add_project::open(host, "Victor XPro", computers(), move |name, _| seen.borrow_mut().push(name.to_string()), window, cx)
    });
    cx.run_until_parked();
    settle(cx);
    assert!(drawn(cx, "add-project-on-this-mac") && drawn(cx, "add-project-on-studio") && drawn(cx, "add-project-mode-clone"));
    click(cx, "add-project-choose");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*opened.borrow(), ["notes"]);
    assert_eq!(
        fixture.state.lock().unwrap().opened,
        [("this-mac".to_string(), "/Users/dev/Code/notes".to_string())].map(|(_, p)| (crate::data::LOCAL.to_string(), p))
    );
}

#[gpui::test]
fn another_computers_folders_are_browsed_selected_and_added(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let opened = Rc::new(RefCell::new(Vec::new()));
    let seen = opened.clone();
    let view = cx.update(|window, cx| {
        add_project::open(host, "Victor XPro", computers(), move |name, _| seen.borrow_mut().push(name.to_string()), window, cx)
    });
    cx.run_until_parked();
    click(cx, "add-project-on-studio");
    settle(cx);
    assert_eq!(view.read_with(cx, |d, _| d.listing().map(|l| l.path.clone())), Some("/Users/dev".into()), "its home");
    assert!(drawn(cx, "add-project-path") && drawn(cx, "add-project-folder-0") && !drawn(cx, "add-project-up"), "no `..` at home");
    // A double-click goes into Code; its Projects are tagged.
    let at = testing::bounds(cx, "add-project-folder-0").center();
    for up in [false, true] {
        let modifiers = Modifiers::none();
        if up {
            cx.simulate_event(gpui::MouseUpEvent { button: gpui::MouseButton::Left, position: at, modifiers, click_count: 2 });
        } else {
            cx.simulate_event(gpui::MouseDownEvent {
                button: gpui::MouseButton::Left,
                position: at,
                modifiers,
                click_count: 2,
                first_mouse: false,
            });
        }
    }
    cx.run_until_parked();
    settle(cx);
    assert_eq!(view.read_with(cx, |d, _| d.listing().map(|l| l.path.clone())), Some("/Users/dev/Code".into()));
    assert!(drawn(cx, "add-project-up"));
    assert!(!view.read_with(cx, |d, _| d.can_add()), "nothing picked yet");
    click(cx, "add-project-folder-2");
    assert_eq!(view.read_with(cx, |d, _| d.selected().map(|e| e.name.clone())), Some("notes".into()));
    assert!(!view.read_with(cx, |d, _| d.can_add()), "notes is neither a Git folder nor a Project");
    click(cx, "add-project-folder-0");
    assert!(view.read_with(cx, |d, _| d.can_add()));
    click(cx, "add-project-add");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*opened.borrow(), ["happiergym"]);
    assert_eq!(fixture.state.lock().unwrap().opened, [("studio".to_string(), "/Users/dev/Code/happiergym".to_string())]);
}

#[gpui::test]
fn an_offline_computer_cannot_be_chosen_and_one_that_goes_away_stops_being_read(cx: &mut TestAppContext) {
    let (_fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| add_project::open(host, "Victor XPro", computers(), |_, _| {}, window, cx));
    cx.run_until_parked();
    click(cx, "add-project-on-tianxu");
    assert_eq!(view.read_with(cx, |d, _| d.on().to_string()), add_project::THIS_MAC, "offline ones are off");
    click(cx, "add-project-on-studio");
    assert!(view.read_with(cx, |d, _| d.listing().is_some()));
    // It goes offline: the dialog says so, and nothing more is read.
    let mut away = computers();
    away[0].state = ComputerState::Offline;
    cx.update(|window, cx| view.update(cx, |d, cx| d.set_computers(away.clone(), window, cx)));
    cx.run_until_parked();
    settle(cx);
    assert!(drawn(cx, "add-project-away") && !view.read_with(cx, |d, _| d.reachable()));
    // It comes back: the folder on screen is read again.
    cx.update(|window, cx| view.update(cx, |d, cx| d.set_computers(computers(), window, cx)));
    cx.run_until_parked();
    settle(cx);
    assert!(!drawn(cx, "add-project-away") && view.read_with(cx, |d, _| d.listing().is_some()));
}

#[gpui::test]
fn cloning_goes_into_the_chosen_folder_and_a_failure_is_shown(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let opened = Rc::new(RefCell::new(Vec::new()));
    let seen = opened.clone();
    let view = cx.update(|window, cx| {
        add_project::open(host, "Victor XPro", computers(), move |name, _| seen.borrow_mut().push(name.to_string()), window, cx)
    });
    cx.run_until_parked();
    click(cx, "add-project-mode-clone");
    settle(cx);
    assert!(!view.read_with(cx, |d, cx| d.can_clone(cx)), "an address is needed");
    let url = view.read_with(cx, |d, _| d.url_input().clone());
    type_into::<()>(&url, "https://github.com/owner/repository.git", cx);
    assert!(view.read_with(cx, |d, cx| d.can_clone(cx)));
    fixture.with(|s| s.fail_next = Some("Repository not found.".into()));
    click(cx, "add-project-clone");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(view.read_with(cx, |d, _| d.error().map(str::to_string)), Some("Repository not found.".into()));
    click(cx, "add-project-clone");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(*opened.borrow(), ["repository"]);
    assert_eq!(fixture.state.lock().unwrap().cloned, [(None, "https://github.com/owner/repository.git".to_string(), None)]);
}

#[gpui::test]
fn a_remote_clone_needs_a_folder_and_goes_into_the_one_on_screen(cx: &mut TestAppContext) {
    let (fixture, host, cx) = mount(cx);
    let view = cx.update(|window, cx| add_project::open(host, "Victor XPro", computers(), |_, _| {}, window, cx));
    cx.run_until_parked();
    click(cx, "add-project-on-studio");
    click(cx, "add-project-mode-clone");
    settle(cx);
    let url = view.read_with(cx, |d, _| d.url_input().clone());
    type_into::<()>(&url, "https://github.com/owner/repository", cx);
    assert_eq!(view.read_with(cx, |d, _| d.clone_into()), Some("/Users/dev".into()));
    click(cx, "add-project-clone");
    elapse(cx, STEP + Duration::from_millis(10));
    assert_eq!(
        fixture.state.lock().unwrap().cloned,
        [(Some("studio".to_string()), "https://github.com/owner/repository".to_string(), Some("/Users/dev".to_string()))]
    );
}

// ---- Project chooser ----

#[gpui::test]
fn the_chooser_and_the_startup_error_tell_the_window_what_was_pressed(cx: &mut TestAppContext) {
    let (view, cx) = testing::mount_in_root(cx, |_, _| ProjectChooser::new(ChooserState::Choose { notice: None }));
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    let _sub = cx.update(|_, cx| cx.subscribe(&view, move |_, event: &ChooserEvent, _| seen.borrow_mut().push(*event)));
    assert!(drawn(cx, "project-chooser"));
    click(cx, "chooser-add");
    cx.update(|_, cx| view.update(cx, |v, cx| v.set_state(ChooserState::StartupError("EACCES: permission denied".into()), cx)));
    cx.run_until_parked();
    settle(cx);
    assert!(drawn(cx, "project-startup-error") && drawn(cx, "project-startup-message"));
    click(cx, "chooser-retry");
    click(cx, "chooser-another");
    assert_eq!(*events.borrow(), [ChooserEvent::AddProject, ChooserEvent::Retry, ChooserEvent::OpenAnother]);
}
