//! The fixture flows: what `routines:list` answers for the two flow Routines. The Review queue is the pilot (a Linear
//! label starts Classify, an If sends large issues through an approval, Implement, Open pull request, Review) at
//! revision 3 with an edited draft and seven Runs in every state the Run view draws; the Release train has never been
//! published and has no steps.

use std::collections::HashMap;

use super::ops::needs_answer;
use super::types::*;
use crate::data::{Millis, Provider};
use crate::logic::usage::time::epoch_ms;
use crate::routines::model::{Issue, LinearEvent, Run, RunStatus};

const GYM: &str = "/Users/victor/Code/personal/happiergym";

fn at(day: u32, hour: i64, minute: i64) -> Millis {
    epoch_ms(2026, 11, i64::from(day), hour, minute, 0)
}

fn agent(prompt: &str) -> AgentStep {
    AgentStep {
        prompt: prompt.into(),
        provider: None,
        model: None,
        effort: None,
        permission_mode: None,
        chat: ChatUse::Run,
        output: Vec::new(),
        retries: 1,
        on_invalid: OnInvalid::AskOnce,
    }
}

/// The pilot: Linear label, Classify, If large (Ask), Implement, Open pull request, Review.
pub fn pilot() -> Vec<FlowStep> {
    vec![
        FlowStep {
            id: "classify".into(),
            name: "Classify".into(),
            body: StepBody::Agent(AgentStep {
                provider: Some(Provider::Claude),
                model: Some("claude-sonnet-5-5".into()),
                retries: 2,
                output: vec![FlowField::choice("complexity", &["small", "medium", "large"]), FlowField::new("area", FieldType::Text)],
                ..agent(
                    "Read {{trigger.issue.key}} {{trigger.issue.title}} and say how big it is and where in the app it lives.\n\n{{trigger.issue.description}}",
                )
            }),
        },
        FlowStep {
            id: "if-large".into(),
            name: "If".into(),
            body: StepBody::If(IfStep {
                field: "classify.complexity".into(),
                test: Test::Is,
                value: Some("large".into()),
                yes: vec![FlowStep {
                    id: "ask".into(),
                    name: "Ask before implementing".into(),
                    body: StepBody::Ask(AskStep {
                        message: "{{trigger.issue.key}} looks large ({{classify.area}}). Go ahead and implement it?".into(),
                        expires_in_hours: 24,
                    }),
                }],
                otherwise: Vec::new(),
            }),
        },
        FlowStep {
            id: "implement".into(),
            name: "Implement".into(),
            body: StepBody::Agent(AgentStep {
                provider: Some(Provider::Claude),
                model: Some("claude-opus-5-5".into()),
                permission_mode: Some("auto".into()),
                ..agent("Fix {{trigger.issue.key}} in {{classify.area}}. Commit as you go.")
            }),
        },
        FlowStep {
            id: "pr".into(),
            name: "Open pull request".into(),
            body: StepBody::PullRequest(PullRequestStep {
                title: "{{trigger.issue.key}} {{trigger.issue.title}}".into(),
                body: "Closes {{trigger.issue.key}}".into(),
                base: None,
                draft: true,
                ask_first: true,
            }),
        },
        FlowStep {
            id: "review".into(),
            name: "Review".into(),
            body: StepBody::Agent(AgentStep {
                chat: ChatUse::Own,
                output: vec![FlowField::choice("verdict", &["approve", "changes"])],
                ..agent("Review {{pr.url}} as a second pair of eyes.")
            }),
        },
    ]
}

/// The pilot with the edits a draft shows: Classify's prompt changed and a comment added at the end.
fn pilot_draft() -> Vec<FlowStep> {
    let mut steps = pilot();
    if let StepBody::Agent(classify) = &mut steps[0].body {
        classify.prompt = "Read {{trigger.issue.key}} {{trigger.issue.title}} and say how big it is.".into();
    }
    steps.push(FlowStep {
        id: "comment-on-linear".into(),
        name: "Comment on Linear".into(),
        body: StepBody::LinearComment(CommentStep { body: "Opened {{pr.url}} for {{trigger.issue.key}}.".into() }),
    });
    steps
}

fn issue(key: &str, title: &str, state: &str) -> IssueSnapshot {
    IssueSnapshot {
        key: key.into(),
        title: title.into(),
        description: format!("{title}. Reported from the app."),
        url: Some(format!("https://linear.app/milagre/issue/{key}")),
        labels: vec!["agent".into(), "bug".into()],
        state: state.into(),
        team: "MIL".into(),
    }
}

fn labelled(snapshot: IssueSnapshot) -> RunEvent {
    RunEvent::Linear { change: LinearEvent::LabelAdded, issue: snapshot, comment_author: None, comment_body: None }
}

fn text_output(entries: &[(&str, &str)]) -> Vec<(String, Value)> {
    entries.iter().map(|(key, value)| ((*key).to_string(), Value::text(*value))).collect()
}

/// A Run of the pilot flow at revision 3.
fn run(id: &str, started: Millis, status: RunStatus, event: Option<RunEvent>, flow: FlowRun, issue: Option<(&str, &str)>) -> Run {
    let mut run = Run::new(id, started, status);
    run.issue = issue.map(|(key, title)| Issue { key: key.into(), title: Some(title.into()) });
    run.event = event;
    run.flow = Some(flow);
    run
}

fn flow_run(status: FlowStatus, dry_run: bool, state: Vec<(&str, StepRun)>) -> FlowRun {
    FlowRun {
        revision: 3,
        steps: pilot(),
        state: state.into_iter().map(|(id, run)| (id.to_string(), run)).collect::<HashMap<_, _>>(),
        status,
        dry_run,
    }
}

fn with_chat(mut run: StepRun, chat: &str) -> StepRun {
    run.chat_id = Some(format!("{GYM}#{chat}"));
    run
}

fn classified(day: u32, hour: i64, minute: i64, complexity: &str, area: &str, chat: &str) -> StepRun {
    let start = at(day, hour, minute);
    StepRun { output: text_output(&[("complexity", complexity), ("area", area)]), ..with_chat(StepRun::done(start, start + 41_000), chat) }
}

fn path_taken(day: u32, hour: i64, minute: i64, branch: Branch) -> StepRun {
    StepRun { taken: Some(branch), ..StepRun::done(at(day, hour, minute), at(day, hour, minute)) }
}

fn approved(day: u32, hour: i64, minute: i64, message: &str) -> StepRun {
    let asked = at(day, hour, minute);
    StepRun {
        approval: Some(Approval {
            asked_at: asked,
            expires_at: asked + 24 * 3_600_000,
            message: message.into(),
            preview: None,
            decision: Some(Decision::Approved),
            decided_at: Some(asked + 5 * 60_000),
            reason: None,
        }),
        ..StepRun::done(asked, asked + 5 * 60_000)
    }
}

/// The Review queue's published steps, its edited draft and its Runs, newest first.
pub fn review_flow() -> (FlowDef, Vec<Run>) {
    let def =
        FlowDef { steps: pilot(), published_at: at(10, 16, 40), draft: Some(Draft { steps: pilot_draft(), updated_at: at(11, 11, 58) }) };
    let ask_message = "MIL-490 looks large (sidebar). Go ahead and implement it?";
    let pr_message = "Open a draft pull request for MIL-482?";

    // Run 16: Classify is under way.
    let mut running = StepRun::new(StepStatus::Running);
    running.started_at = Some(at(11, 12, 3));
    running.chat_id = Some(format!("{GYM}#flow-16"));
    let r16 = run(
        "flow-16",
        at(11, 12, 3),
        RunStatus::Running,
        Some(labelled(issue("MIL-495", "Toast hides under the composer", "In Progress"))),
        flow_run(FlowStatus::Running, false, vec![("classify", running)]),
        Some(("MIL-495", "Toast hides under the composer")),
    );

    // Run 15: waiting for you at the approval after an If sent a large issue down Yes.
    let asked = at(11, 11, 50);
    let waiting_ask = StepRun {
        approval: Some(Approval {
            asked_at: asked,
            expires_at: asked + 24 * 3_600_000,
            message: ask_message.into(),
            preview: None,
            decision: None,
            decided_at: None,
            reason: None,
        }),
        started_at: Some(asked),
        ..StepRun::new(StepStatus::Waiting)
    };
    let r15 = run(
        "flow-15",
        at(11, 11, 48),
        RunStatus::Running,
        Some(labelled(issue("MIL-490", "Sidebar rows jump when a Chat finishes", "Todo"))),
        flow_run(
            FlowStatus::Waiting,
            false,
            vec![
                ("classify", classified(11, 11, 48, "large", "sidebar", "flow-15")),
                ("if-large", path_taken(11, 11, 49, Branch::Yes)),
                ("ask", waiting_ask),
            ],
        ),
        Some(("MIL-490", "Sidebar rows jump when a Chat finishes")),
    );

    // Run 14: Implement is done and the pull request waits for you, with the preview.
    let asked = at(11, 11, 31);
    let waiting_pr = StepRun {
        approval: Some(Approval {
            asked_at: asked,
            expires_at: asked + 24 * 3_600_000,
            message: pr_message.into(),
            preview: Some(PrPreview {
                repository: Some("the-ptf/milagre".into()),
                branch: "milagre/mil-482-retry-webhooks".into(),
                base: "main".into(),
                title: "MIL-482 Retry webhook deliveries".into(),
                body: "Closes MIL-482".into(),
                draft: true,
                changes: Some("6 files, 214 added, 38 removed".into()),
            }),
            decision: None,
            decided_at: None,
            reason: None,
        }),
        started_at: Some(asked),
        ..StepRun::new(StepStatus::Waiting)
    };
    let r14 = run(
        "flow-14",
        at(11, 11, 20),
        RunStatus::Running,
        Some(labelled(issue("MIL-482", "Retry webhook deliveries", "Todo"))),
        flow_run(
            FlowStatus::Waiting,
            false,
            vec![
                ("classify", classified(11, 11, 20, "large", "relay", "flow-14")),
                ("if-large", path_taken(11, 11, 21, Branch::Yes)),
                ("ask", approved(11, 11, 21, ask_message)),
                (
                    "implement",
                    StepRun { summary: Some("3 commits".into()), ..with_chat(StepRun::done(at(11, 11, 26), at(11, 11, 31)), "flow-14") },
                ),
                ("pr", waiting_pr),
            ],
        ),
        Some(("MIL-482", "Retry webhook deliveries")),
    );

    // Run 13: Implement failed twice and the Run stopped there.
    let mut failed = with_chat(StepRun::new(StepStatus::Failed), "flow-13b");
    failed.started_at = Some(at(11, 10, 31));
    failed.ended_at = Some(at(11, 10, 41));
    failed.error = Some("The Chat ended without calling flow_step_output.\nThe turn stopped after 10 minutes.".into());
    failed.tries = vec![Try {
        started_at: at(11, 10, 15),
        ended_at: at(11, 10, 29),
        error: "Selected model is at capacity.".into(),
        chat_id: Some(format!("{GYM}#flow-13a")),
    }];
    let r13 = run(
        "flow-13",
        at(11, 10, 14),
        RunStatus::Failed,
        Some(labelled(issue("MIL-477", "Tooltip clips in the sidebar", "Todo"))),
        flow_run(
            FlowStatus::Failed,
            false,
            vec![
                ("classify", classified(11, 10, 14, "medium", "sidebar", "flow-13")),
                ("if-large", path_taken(11, 10, 15, Branch::Otherwise)),
                ("implement", failed),
                ("pr", StepRun::new(StepStatus::NotRun)),
                ("review", StepRun::new(StepStatus::NotRun)),
            ],
        ),
        Some(("MIL-477", "Tooltip clips in the sidebar")),
    );

    // A Test run of the draft: agents use sample fields, the action and the wait are skipped.
    let mut skipped = StepRun::new(StepStatus::Skipped);
    skipped.summary = Some("Skipped in a test run".into());
    let r_test = run(
        "flow-test",
        at(11, 10, 0),
        RunStatus::Acted,
        None,
        flow_run(
            FlowStatus::Done,
            true,
            vec![
                (
                    "classify",
                    StepRun {
                        output: text_output(&[("complexity", "small"), ("area", "sample")]),
                        ..StepRun::done(at(11, 10, 0), at(11, 10, 0))
                    },
                ),
                ("if-large", path_taken(11, 10, 0, Branch::Otherwise)),
                ("implement", StepRun::done(at(11, 10, 0), at(11, 10, 0))),
                ("pr", skipped),
                ("review", StepRun::new(StepStatus::NotRun)),
            ],
        ),
        None,
    );

    // Run 12: done, with the pull request's receipt.
    let pr_done = StepRun {
        summary: Some("Opened draft #861".into()),
        receipt: Some(Receipt::PullRequest {
            url: "https://github.com/the-ptf/milagre/pull/861".into(),
            number: 861,
            branch: "milagre/mil-471-image-chip".into(),
            draft: true,
            matched: false,
            at: at(11, 9, 31),
        }),
        ..StepRun::done(at(11, 9, 30), at(11, 9, 31))
    };
    let mut review_done = with_chat(StepRun::done(at(11, 9, 32), at(11, 9, 36)), "flow-12r");
    review_done.output = text_output(&[("verdict", "approve")]);
    let r12 = run(
        "flow-12",
        at(11, 9, 10),
        RunStatus::Acted,
        Some(labelled(issue("MIL-471", "Image chip blinks while typing", "Todo"))),
        flow_run(
            FlowStatus::Done,
            false,
            vec![
                ("classify", classified(11, 9, 10, "small", "composer", "flow-12")),
                ("if-large", path_taken(11, 9, 11, Branch::Otherwise)),
                ("implement", with_chat(StepRun::done(at(11, 9, 12), at(11, 9, 30)), "flow-12")),
                ("pr", pr_done),
                ("review", review_done),
            ],
        ),
        Some(("MIL-471", "Image chip blinks while typing")),
    );

    // Run 11: nobody answered the approval in time, so the Run ended.
    let asked = at(10, 15, 2);
    let expired = StepRun {
        approval: Some(Approval {
            asked_at: asked,
            expires_at: asked + 24 * 3_600_000,
            message: ask_message.into(),
            preview: None,
            decision: Some(Decision::Expired),
            decided_at: Some(asked + 24 * 3_600_000),
            reason: None,
        }),
        ..StepRun::done(asked, asked + 24 * 3_600_000)
    };
    let mut expired = expired;
    expired.status = StepStatus::Failed;
    expired.error = Some("No answer in time".into());
    let mut r11 = run(
        "flow-11",
        at(10, 15, 0),
        RunStatus::Ended,
        Some(labelled(issue("MIL-468", "Rework the Routines list", "Todo"))),
        flow_run(
            FlowStatus::Ended,
            false,
            vec![
                ("classify", classified(10, 15, 0, "large", "routines", "flow-11")),
                ("if-large", path_taken(10, 15, 1, Branch::Yes)),
                ("ask", expired),
                ("implement", StepRun::new(StepStatus::NotRun)),
                ("pr", StepRun::new(StepStatus::NotRun)),
                ("review", StepRun::new(StepStatus::NotRun)),
            ],
        ),
        Some(("MIL-468", "Rework the Routines list")),
    );
    r11.error = Some("approval expired".into());
    r11.ended_at = Some(at(11, 15, 2));

    let runs = vec![r16, r15, r14, r13, r_test, r12, r11];
    (def, runs)
}

/// Runs waiting on the owner.
pub fn waiting_count(runs: &[Run]) -> u32 {
    runs.iter().filter(|run| run.flow.as_ref().is_some_and(needs_answer)).count() as u32
}
