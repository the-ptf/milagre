//! The fixture Routines: what `routines:list` would answer. A heartbeat checking back on a Chat, schedules in every shape
//! the form makes, a Linear and a signed webhook trigger, a paused and a failing one, a flow, a babysit Heartbeat and a
//! Routine on a paired computer. Runs by day so the Runs list shows its folds, attempts and unread dot.

use super::flows;
use super::model::*;
use crate::data::{Millis, Provider};
use crate::logic::usage::time::epoch_ms;

const ADE: &str = "/Users/victor/Code/personal/milagre-ade";
const GYM: &str = "/Users/victor/Code/personal/happiergym";

/// The Chat key the unread Run's Chat has (an hidden Run Chat of the fixture data).
pub const NIGHTLY_RUN_CHAT: &str = "/Users/victor/Code/personal/happiergym#run-1485";
/// The Run Chat opened beside the Routine page in the snapshots.
pub const NIGHTLY_RUN_TITLE: &str = "Nightly dependency check";

fn at(day: u32, hour: i64, minute: i64) -> Millis {
    epoch_ms(2026, 11, i64::from(day), hour, minute, 0)
}

fn ended(mut run: Run, seconds: i64) -> Run {
    run.ended_at = Some(run.started_at + seconds * 1000);
    run
}

fn quiet(id: &str, when: Millis, summary: &str) -> Run {
    Run { summary: Some(summary.into()), ..Run::new(id, when, RunStatus::Quiet) }
}

fn acted(id: &str, when: Millis, title: &str, chat: Option<&str>, seconds: i64) -> Run {
    ended(Run { title: Some(title.into()), chat_id: chat.map(Into::into), ..Run::new(id, when, RunStatus::Acted) }, seconds)
}

fn schedule(cron: &str) -> Trigger {
    Trigger::Schedule { cron: cron.into(), timezone: "UTC".into() }
}

fn new_chat(path: &str, workspace: Workspace) -> Target {
    Target::NewChat { project_path: path.into(), workspace }
}

/// The routines the page lists, this Mac's first.
pub fn routines() -> Vec<Routine> {
    let now = fixture_now();
    let mut list = Vec::new();

    // A Heartbeat checking back on a Chat every ten minutes, ending after 20 Runs.
    let mut chimes = Routine::new(
        "hb-chimes",
        "Check the CI on Notification chimes",
        schedule("*/10 * * * *"),
        Target::Chat { chat_id: format!("{ADE}#c1") },
    );
    chimes.prompt = "Look at the PR checks. If they are green say (pass) CI green, otherwise fix what failed.".into();
    chimes.max_runs = Some(20);
    chimes.run_count = 17;
    chimes.next_run_at = Some(at(11, 12, 10));
    chimes.last_run_at = Some(at(11, 12, 0));
    chimes.runs = vec![
        quiet("hb-chimes-9", at(11, 12, 0), "CI green"),
        quiet("hb-chimes-8", at(11, 11, 50), "CI green"),
        quiet("hb-chimes-7", at(11, 11, 40), "CI running"),
        acted("hb-chimes-6", at(11, 11, 30), "Fixed the lint failure", Some(&format!("{ADE}#c1")), 94),
        quiet("hb-chimes-5", at(11, 11, 20), "CI running"),
        Run::new("hb-chimes-4", at(10, 23, 50), RunStatus::SkippedBusy),
    ];
    list.push(chimes);

    // A babysit Heartbeat: no form edits it.
    let mut babysit = Routine::new(
        "hb-pr-1013",
        "Babysit PR #1013",
        Trigger::PullRequest { number: 1013 },
        Target::Chat { chat_id: format!("{ADE}#c2") },
    );
    babysit.prompt = "Follow the PR.".into();
    babysit.expires_at = Some(now + 3 * DAY_MS);
    babysit.last_run_at = Some(at(11, 9, 10));
    babysit.runs = vec![acted("hb-pr-1", at(11, 9, 10), "Replied to a review comment", Some(&format!("{ADE}#c2")), 41)];
    list.push(babysit);

    // Nightly dependency check: weekdays 08:30, a model and mode, the unread Run Chat, retries and a failure.
    let mut nightly = Routine::new("rt-nightly", "Nightly dependency check", schedule("30 8 * * 1-5"), new_chat(GYM, Workspace::Worktree));
    nightly.prompt = "Check for outdated dependencies and open a PR for the safe bumps. End with (pass) when nothing is outdated.".into();
    nightly.provider = Some(Provider::Claude);
    nightly.model = Some("claude-opus-5-5".into());
    nightly.permission_mode = Some("auto".into());
    nightly.fallback = Some(Fallback { provider: Provider::Codex, model: "gpt-6.1-sol".into(), effort: Some("high".into()) });
    nightly.next_run_at = Some(at(12, 8, 30));
    nightly.last_run_at = Some(at(11, 8, 30));
    nightly.run_count = 41;
    let mut retried = acted("rt-nightly-9", at(11, 8, 30), "Bumped 3 dependencies", Some(NIGHTLY_RUN_CHAT), 38);
    retried.fallback = Some(RunFallback { model: Some("gpt-6.1-sol".into()), effort: Some("high".into()) });
    retried.attempts = vec![Attempt {
        model: Some("claude-opus-5-5".into()),
        effort: Some("high".into()),
        error: Some("Selected model is at capacity.\nTry again later.".into()),
        ended_at: at(11, 8, 31),
        chat_id: None,
    }];
    let mut failed = Run::new("rt-nightly-8", at(10, 8, 30), RunStatus::Failed);
    failed.error = Some("npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency".into());
    failed.ended_at = Some(failed.started_at + 21_000);
    nightly.runs = vec![
        retried,
        failed,
        quiet("rt-nightly-7", at(9, 8, 30), "Nothing outdated"),
        quiet("rt-nightly-6", at(8, 8, 30), "Nothing outdated"),
        acted("rt-nightly-5", at(7, 8, 30), "Bumped expo-router", None, 52),
        quiet("rt-nightly-4", at(6, 8, 30), "Nothing outdated"),
        Run { rejected: false, ..Run::new("rt-nightly-3", at(5, 8, 30), RunStatus::Missed) },
        quiet("rt-nightly-2", at(4, 8, 30), "Nothing outdated"),
        acted("rt-nightly-1", at(3, 8, 30), "Bumped 2 dependencies", None, 47),
    ];
    list.push(nightly);

    // A Linear trigger.
    let mut triage = Routine::new(
        "rt-triage",
        "Triage new issues",
        Trigger::Linear { workspace: "milagre".into(), event: LinearEvent::Assigned, team: Some("MIL".into()), label: None, state: None },
        new_chat(ADE, Workspace::Worktree),
    );
    triage.prompt = "Read {{issue.key}} {{issue.title}} and start on it.\n\n{{issue.description}}".into();
    triage.provider = Some(Provider::Claude);
    triage.model = Some("claude-sonnet-5-5".into());
    triage.permission_mode = Some("full".into());
    let issue = |key: &str, title: &str| Some(Issue { key: key.into(), title: Some(title.into()) });
    triage.runs = vec![
        ended(
            Run {
                issue: issue("MIL-482", "Retry webhooks"),
                chat_id: Some(format!("{ADE}#c9")),
                ..Run::new("rt-triage-3", at(11, 10, 14), RunStatus::Acted)
            },
            212,
        ),
        ended(
            Run { issue: issue("MIL-477", "Tooltip clips in the sidebar"), ..Run::new("rt-triage-2", at(10, 15, 2), RunStatus::Acted) },
            160,
        ),
    ];
    list.push(triage);

    // A signed webhook.
    let mut sentry = Routine::new(
        "rt-sentry",
        "Sentry alert responder",
        Trigger::Webhook { hook_id: "hk_4f9a".into(), signed: true },
        new_chat(ADE, Workspace::Project),
    );
    sentry.prompt = "A Sentry alert came in:\n{{body}}\nFind the cause.".into();
    sentry.signing_header = Some("sentry-hook-signature".into());
    sentry.last_error = Some("Last delivery failed its signature check".into());
    sentry.runs =
        vec![Run { rejected: true, error: Some("Invalid signature".into()), ..Run::new("rt-sentry-1", at(11, 7, 2), RunStatus::Failed) }];
    list.push(sentry);

    // A paused one with a reason, a Friday schedule.
    let mut changelog = Routine::new("rt-changelog", "Friday changelog", schedule("0 16 * * 5"), new_chat(ADE, Workspace::Worktree));
    changelog.prompt = "Write the changelog for the week.".into();
    changelog.enabled = false;
    changelog.paused_reason = Some("Paused itself after 3 failed Runs".into());
    changelog.max_runs = Some(10);
    changelog.run_count = 4;
    list.push(changelog);

    // A flow, not published yet, and one with Runs waiting on someone (the Flow page's fixture: `flows/fixture.rs`).
    let mut flow = Routine::new("rt-flow", "Release train", schedule("0 10 * * 1"), new_chat(ADE, Workspace::Worktree));
    flow.prompt = "flow".into();
    flow.enabled = false;
    flow.flow = Some(FlowInfo::new(0, 0));
    list.push(flow);
    let mut review = Routine::new(
        "rt-review",
        "Review queue",
        Trigger::Linear {
            workspace: "milagre".into(),
            event: LinearEvent::LabelAdded,
            team: Some("MIL".into()),
            label: Some("agent".into()),
            state: None,
        },
        new_chat(GYM, Workspace::Worktree),
    );
    review.prompt = "flow".into();
    let (def, runs) = flows::fixture::review_flow();
    review.flow = Some(FlowInfo { revision: 3, waiting: flows::fixture::waiting_count(&runs), def });
    review.run_count = 16;
    review.last_run_at = runs.first().map(|run| run.started_at);
    review.runs = runs;
    list.push(review);

    // A Routine on a paired computer.
    let mut studio = Routine::new(
        "studio:rt-backup",
        "Studio nightly backup",
        schedule("0 3 * * *"),
        new_chat("/Users/victor/Code/payments-api", Workspace::Project),
    );
    studio.computer = "studio".into();
    studio.prompt = "Back up the databases.".into();
    studio.next_run_at = Some(at(12, 3, 0));
    studio.runs = vec![acted("studio-1", at(11, 3, 0), "Backed up 4 databases", None, 120)];
    list.push(studio);

    list
}

/// The Run Chats with a result nobody opened: the Nightly Run's, so its row and the Run show the dot.
pub fn unread_chats() -> Vec<String> {
    vec![NIGHTLY_RUN_CHAT.to_string()]
}

/// The Routines with such a Chat.
pub fn unread_routines() -> Vec<String> {
    vec!["rt-nightly".to_string()]
}

/// A Chat's title, as the targets carry them.
pub fn chat_title(chat_id: &str) -> Option<String> {
    targets().into_iter().flat_map(|project| project.chats).find(|(id, _)| id == chat_id).map(|(_, title)| title)
}
