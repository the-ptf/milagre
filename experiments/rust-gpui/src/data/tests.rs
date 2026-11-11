//! The domain rules and the fixture source, through the `DataSource` trait as a view would call it.

use std::path::PathBuf;
use std::task::{Context, Poll, Waker};

use super::fixture::{CHAT_COUNT, FixtureData, chat_page};
use super::*;

/// Runs a fixture future: they are ready at once, so one poll answers.
fn answer<T>(mut future: DataFuture<T>) -> anyhow::Result<T> {
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("a fixture future is ready at once"),
    }
}

fn scope(name: &str) -> ScopeKey {
    ScopeKey(format!("/fixture/{name}").into())
}

#[test]
fn chat_status_puts_what_needs_you_first() {
    let data = FixtureData::new();
    let mut chat = data.chats[0].chat.clone();
    chat.unread = true;
    chat.last_outcome = Some(Outcome::Failed);
    assert_eq!(ChatStatus::of(&chat, Some(RunState::WaitingApproval)), ChatStatus::NeedsApproval);
    assert_eq!(ChatStatus::of(&chat, Some(RunState::WaitingAnswer)), ChatStatus::Question);
    assert_eq!(ChatStatus::of(&chat, Some(RunState::Running)), ChatStatus::Running);
    assert_eq!(ChatStatus::of(&chat, None), ChatStatus::Failed, "a failed last turn beats unread");
    chat.last_outcome = Some(Outcome::Completed);
    assert_eq!(ChatStatus::of(&chat, None), ChatStatus::Unread);
    chat.unread = false;
    assert_eq!(ChatStatus::of(&chat, None), ChatStatus::None);
}

#[test]
fn the_fixture_lists_500_chats_across_six_projects() {
    let data = FixtureData::new();
    assert_eq!(data.chats.len(), CHAT_COUNT);
    assert_eq!(data.projects.len(), 6);
    assert_eq!(data.projects[5].kind, ProjectKind::ChatsHome);
    let statuses: Vec<_> = data.chats[..8].iter().map(|c| c.status()).collect();
    use ChatStatus::*;
    assert_eq!(statuses, [Running, NeedsApproval, Unread, Running, Question, Unread, None, Failed], "the first screen");
    let ids: std::collections::HashSet<_> = data.chats.iter().map(|c| c.chat.id).collect();
    assert_eq!(ids.len(), CHAT_COUNT, "Chat ids are unique");
}

#[test]
fn the_source_answers_the_six_calls() {
    let source = FixtureSource::new();
    let current = answer(source.current_project()).unwrap().expect("the window opens on a Project");
    assert_eq!(current.project.name.as_ref(), "milagre-ade");
    let state = current.state.expect("with its state");
    assert!(state.chats.len() > 5 && state.worktrees.len() == 1);

    let opened = answer(source.open_project(PathBuf::from("/fixture/rd-car"))).unwrap();
    assert_eq!(opened.project.name.as_ref(), "rd-car");
    assert!(answer(source.open_project(PathBuf::from("/elsewhere"))).is_err());

    let bare = answer(source.read_project(PathBuf::from("/fixture/site"), false)).unwrap();
    assert!(bare.state.is_none(), "project:read with {{ state: false }}");

    let read = answer(source.read_state(scope("milagre-ade"))).unwrap();
    assert_eq!(read, state, "state:read gives the same state project:current did");
    let error = answer(source.read_state(scope("nope"))).unwrap_err();
    assert_eq!(error.to_string(), "Open the Project before reading its messages.");

    let runs = answer(source.chat_runs()).unwrap();
    let data = source.data();
    let live = data.chats.iter().filter(|c| c.run.is_some()).count();
    assert_eq!(runs.runs.len(), live);
    assert_eq!(runs.runs.get(&(scope("milagre-ade"), 2)), Some(&RunState::WaitingApproval), "Chat 2 waits for an approval");

    let first = data.chats[0].chat.id;
    let page = answer(source.chat_messages(scope("milagre-ade"), first, PageRequest::default())).unwrap();
    assert!(!page.messages.is_empty() && page.messages.len() <= page.total);
    assert!(answer(source.chat_messages(scope("milagre-ade"), 9_999, PageRequest::default())).is_err());
}

/// `chatPage` from `packages/core/src/chat-pages.cjs`: turns back from the end (or from `before`), a limit, `hasMore`.
#[test]
fn chat_pages_count_turns_back_from_the_end() {
    let data = FixtureData::new();
    let all = data.messages(21); // 4 + (21 * 7) % 37 = 40 messages, 20 user turns
    assert_eq!(all.len(), 40);
    let newest = chat_page(all.clone(), PageRequest { before: None, turns: 3, limit: 75 });
    assert_eq!((newest.messages.len(), newest.has_more, newest.total), (6, true, 40), "three turns: user and reply each");
    assert_eq!(newest.messages.first().map(|m| m.role), Some(Role::User));
    let older = chat_page(all.clone(), PageRequest { before: Some(newest.messages[0].id), turns: 3, limit: 75 });
    assert_eq!(older.messages.last().map(|m| m.id + 1), Some(newest.messages[0].id), "the page before ends where the newer began");
    let capped = chat_page(all.clone(), PageRequest { before: None, turns: 100, limit: 5 });
    assert_eq!(capped.messages.len(), 5);
    let everything = chat_page(all, PageRequest { before: None, turns: 100, limit: 100 });
    assert!(!everything.has_more && everything.messages.len() == 40);
}
