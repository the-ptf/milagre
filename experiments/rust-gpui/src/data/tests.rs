//! The domain types, their edge into `src/logic`, and the fixture source through the `DataSource` trait as a view
//! would call it.

use super::fixture::{DEER, DONE_CHATS, FixtureData, TIANXU, alternating, chat_page};
use super::*;
use crate::logic::identity::providers::PROVIDERS;
use crate::logic::lists::pins::{DevicePins, sessions_with_pins};
use crate::logic::marks::activity::Activity;
use crate::logic::usage::report::{UsageTone, usage_tone, visible_providers};

fn local(path: &str) -> ScopeKey {
    ScopeKey::project(LOCAL, path)
}

fn chat_titled<'a>(data: &'a FixtureData, title: &str) -> (&'a fixture::FixtureScope, &'a Chat) {
    data.scopes
        .iter()
        .find_map(|scope| scope.state.sessions.values().find(|chat| chat.display_title(&[]) == title).map(|chat| (scope, chat)))
        .unwrap_or_else(|| panic!("no fixture Chat titled {title}"))
}

#[test]
fn providers_follow_the_picker_order_and_read_unknown_as_claude() {
    assert_eq!(Provider::ALL.map(Provider::id), PROVIDERS);
    assert_eq!(Provider::ALL.map(Provider::name), ["Codex", "Claude", "Antigravity", "Kiro"]);
    assert_eq!(Provider::of_session(None), Provider::Claude);
    assert_eq!(Provider::of_session(Some("gemini")), Provider::Claude);
    assert_eq!(Provider::of_session(Some("kiro")), Provider::Kiro);
}

#[test]
fn scope_keys_qualify_another_computers_projects() {
    assert_eq!(local("/p").as_str(), "/p");
    let remote = ScopeKey::project(DEER, "/p");
    assert_eq!(remote.as_str(), "deer-studio|/p");
    assert_eq!(remote.computer(), DEER);
    assert_eq!(remote.chat_key(7), "deer-studio|/p#7");
    assert_eq!(ProjectKind::from_wire(Some("chats")), ProjectKind::ChatsHome);
    assert_eq!(ProjectKind::from_wire(None), ProjectKind::Project);
}

#[test]
fn pull_request_numbers_come_from_their_urls() {
    assert_eq!(pull_request_number("https://github.com/the-ptf/milagre-ade/pull/1015"), Some(1015));
    assert_eq!(pull_request_number("https://github.com/o/r/pull/7/files"), Some(7));
    assert_eq!(pull_request_number("https://github.com/o/r/issues/7"), None);
}

#[test]
fn the_fixture_spans_three_computers_with_a_hidden_project_and_two_chats_homes() {
    let data = FixtureData::new();
    assert_eq!(data.computers.ids(), [LOCAL, TIANXU, DEER]);
    assert!(data.computers.is_offline(TIANXU) && !data.computers.is_offline(DEER) && !data.computers.is_offline(LOCAL));
    assert_eq!(data.computers.name_of(LOCAL).as_ref(), "Victor XPro");
    let on = |computer: &str| data.scopes.iter().filter(|scope| scope.project.computer.as_ref() == computer).count();
    assert_eq!((on(LOCAL), on(TIANXU), on(DEER)), (5, 2, 3));
    let homes: Vec<&str> = data.scopes.iter().filter(|scope| scope.project.is_chats_home()).map(|s| s.project.computer.as_ref()).collect();
    assert_eq!(homes, [LOCAL, DEER]);
    assert_eq!(data.scopes.iter().filter(|scope| scope.project.hidden).count(), 1);
    assert!(data.scopes.iter().any(|scope| !scope.project.git), "a plain folder");
    // One repository on two computers shares its origin.
    let ade: Vec<_> = data.scopes.iter().filter(|s| s.project.origin.as_deref() == Some("github.com/the-ptf/milagre-ade")).collect();
    assert_eq!(ade.len(), 2);
    // Ids grow with time in each scope, as the host's do.
    for scope in &data.scopes {
        let mut by_time: Vec<&Chat> = scope.state.sessions.values().filter(|chat| chat.summary.is_some()).collect();
        by_time.sort_by_key(|chat| chat.summary.as_ref().and_then(|summary| summary.first_at));
        assert!(by_time.windows(2).all(|pair| pair[0].id < pair[1].id), "{}", scope.project.name);
    }
}

#[test]
fn the_named_chats_carry_the_states_the_lists_read() {
    let data = FixtureData::new();
    let done = data.scopes.iter().flat_map(|scope| scope.state.sessions.values()).filter(|chat| chat.is_done()).count();
    assert_eq!(done, DONE_CHATS);

    let (scope, relay) = chat_titled(&data, "Relay Durable Object backoff");
    assert!(relay.pinned && relay.pin_order == Some(1.0));
    let activity = relay.activity(None);
    assert_eq!((activity.activity, activity.background), (Activity::Background, 2), "two background subagents");
    assert_eq!(scope.project.name.as_ref(), "milagre-ade");

    let (scope, sub) = chat_titled(&data, "Sidebar snapshot check");
    let parent = scope.state.chat(sub.parent.expect("a Subchat")).unwrap();
    assert_eq!(parent.display_title(&[]), "Port the sidebar to GPUI");
    assert_eq!(scope.state.chat(parent.parent.unwrap()).unwrap().display_title(&[]), "Migrate desktop to Rust PoC");
    assert_eq!(sub.family().parent, sub.parent);

    let runs: Vec<&Chat> = data
        .scopes
        .iter()
        .flat_map(|scope| scope.state.sessions.values())
        .filter(|chat| chat.display_title(&[]) == "Nightly dependency check")
        .collect();
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|chat| chat.routine.as_ref().is_some_and(|routine| routine.hidden == Some(true))));
    assert!(runs.iter().all(|chat| !chat.is_listed(false)), "a hidden Run Chat is left out");
    assert!(runs.iter().all(|chat| chat.is_listed(true)), "until it waits on someone");

    let (_, failed) = chat_titled(&data, "Rust terminal owner migration");
    assert_eq!(failed.last_outcome(), Some(Outcome::Failed));
    let (_, kiro) = chat_titled(&data, "Chat switch panel flash");
    assert_eq!(kiro.provider(), Provider::Kiro);
    let starter = data.scopes[0].state.sessions.values().find(|chat| chat.summary.is_none()).expect("a starter Chat");
    assert!(!starter.is_listed(false) && starter.display_title(&[]) == "main", "an empty starter Chat is named after its agent");
}

#[test]
fn chats_are_the_pin_rules_input() {
    let data = FixtureData::new();
    let state = &data.scopes[0].state;
    let shared = sessions_with_pins(&state.sessions, "/fixture/milagre-ade", &DevicePins::new());
    assert!(shared.is_none(), "with no device pins, the shared pins stand");
    let pinned_here = DevicePins::from([("/fixture/milagre-ade".to_owned(), [("3".to_owned(), 0.0)].into())]);
    let mine = sessions_with_pins(&state.sessions, "/fixture/milagre-ade", &pinned_here).expect("pins differ");
    assert_eq!(mine.values().filter(|chat| chat.pinned).map(|chat| chat.id).collect::<Vec<_>>(), [3]);
    let key = state.chat(3).unwrap().sort_key();
    assert_eq!(key.first_id, Some(3000));
}

#[test]
fn the_source_answers_every_call() {
    let source = FixtureSource::new();
    let computers = now(source.computers()).unwrap();
    assert_eq!(computers.computers.len(), 2);

    let recent = now(source.recent_projects(LOCAL.into())).unwrap();
    assert_eq!(
        recent.iter().map(|project| project.name.as_ref()).collect::<Vec<_>>(),
        ["milagre-ade", "happiergym", "site", "scratch", "Chats"]
    );
    assert!(recent[3].hidden && recent[4].is_chats_home());
    assert!(now(source.recent_projects("nowhere".into())).is_err());

    let current = now(source.current_project()).unwrap().expect("the window opens on a Project");
    assert_eq!(current.project.name.as_ref(), "milagre-ade");
    assert_eq!(current.stamp.version, Some(1));
    let state = current.state.expect("with its state");
    assert!(state.messages_in_chats && state.sessions.len() > 20);

    let opened = now(source.open_project(DEER.into(), "/fixture/deer/rd-car".into())).unwrap();
    assert_eq!(opened.project.scope().as_str(), "deer-studio|/fixture/deer/rd-car");
    assert!(now(source.open_project(LOCAL.into(), "/elsewhere".into())).is_err());
    let bare = now(source.read_project(LOCAL.into(), "/fixture/site".into(), false)).unwrap();
    assert!(bare.state.is_none() && bare.stamp.epoch.is_some(), "project:read with {{ state: false }} keeps the stamp");

    let read = now(source.read_state(local("/fixture/milagre-ade"))).unwrap();
    assert_eq!(read.state, state, "state:read gives the state project:current did");
    assert!(now(source.read_state(local("/nope"))).is_err());

    let runs = now(source.chat_runs(LOCAL.into())).unwrap();
    let data = source.data();
    let (scope, hang) = chat_titled(data, "Fix Linux onboarding intro hang");
    let run = runs.get(&scope.scope().chat_key(hang.id)).expect("its turn is live");
    assert!(run.waiting() && run.approvals[0].command.as_deref() == Some("npm test -- --only test-onboarding"));
    assert_eq!(run.waiting_run().approvals[0].command.as_deref(), Some("npm test -- --only test-onboarding"));
    let error = now(source.chat_runs(TIANXU.into())).unwrap_err();
    assert_eq!(error.to_string(), "tianxu is offline.");
    let deer = now(source.chat_runs(DEER.into())).unwrap();
    assert!(deer.runs.keys().all(|key| key.starts_with("deer-studio|")), "another computer's keys are qualified");

    let page = now(source.chat_messages(scope.scope(), hang.id, PageRequest::OPEN)).unwrap();
    assert_eq!(page.total, hang.summary.as_ref().unwrap().count);
    assert!(!page.messages.is_empty() && page.messages.len() <= page.total);
    assert!(now(source.chat_messages(scope.scope(), 9_999, PageRequest::OPEN)).is_err());
    assert!(now(source.chat_messages(local("/nope"), 1, PageRequest::OPEN)).is_err());

    let (scope, codebase) = chat_titled(data, "Codebase analysis and fixes");
    let prs = now(source.pull_requests(scope.scope())).unwrap();
    let folder = scope.state.worktree_of(codebase).unwrap().path.clone();
    let listed = prs.chat_pull_requests(&folder, &codebase.summary.as_ref().unwrap().pull_requests);
    let states: Vec<(Option<u32>, PrState)> = listed.iter().map(|pr| (pr.number, pr.state)).collect();
    assert_eq!(
        states,
        [(Some(1015), PrState::Open), (Some(1014), PrState::Merged), (Some(1016), PrState::Merged), (Some(1020), PrState::Open)]
    );

    let usage = now(source.cached_usage(LOCAL.into())).unwrap();
    let report = usage.report();
    let shown: Vec<Provider> = visible_providers(&report).iter().map(|usage| usage.provider).collect();
    assert_eq!(shown, [Provider::Claude, Provider::Codex, Provider::Antigravity], "Kiro has no numbers");
    assert_eq!(usage.providers[0].status, UsageStatus::Error);
    assert!(usage.providers[0].message.is_some());
    assert_eq!(usage_tone(usage.providers[1].windows[0].used_percent), UsageTone::Warning);
    assert_eq!(usage_tone(usage.providers[2].windows[1].used_percent), UsageTone::Critical);
    assert!(now(source.cached_usage(DEER.into())).unwrap().providers.is_empty());
}

#[test]
fn a_run_chats_first_message_is_its_routines_divider() {
    let data = FixtureData::new();
    let (scope, run) = chat_titled(&data, "Babysit PR #1013");
    let messages = data.messages(&scope.scope(), run.id).unwrap();
    let context = messages[0].context.as_ref().expect("a divider");
    assert_eq!(context.kind(), "routine-run");
    assert!(context.is_divider());
    assert_eq!(messages[1].steps[0].kind, Some(StepKind::Shell));
}

/// `chatPage` from `packages/core/src/chat-pages.cjs`: turns back from the end (or from `before`), a limit, `hasMore`.
#[test]
fn chat_pages_count_turns_back_from_the_end() {
    let all = alternating(21, 40);
    let newest = chat_page(all.clone(), PageRequest { before: None, turns: 3, limit: 75 });
    assert_eq!((newest.messages.len(), newest.has_more, newest.total), (6, true, 40), "three turns: user and reply each");
    assert_eq!(newest.messages.first().map(|m| m.role), Some(Role::User));
    let older = chat_page(all.clone(), PageRequest { before: Some(newest.messages[0].id), turns: 3, limit: 75 });
    assert_eq!(older.messages.last().map(|m| m.id + 1), Some(newest.messages[0].id), "the page before ends where the newer began");
    let capped = chat_page(all.clone(), PageRequest { before: None, turns: 100, limit: 5 });
    assert_eq!(capped.messages.len(), 5);
    let everything = chat_page(all, PageRequest { before: None, turns: 100, limit: 100 });
    assert!(!everything.has_more && everything.messages.len() == 40);
    assert_eq!(PageRequest::before(7), PageRequest { before: Some(7), turns: 20, limit: 75 });
}
