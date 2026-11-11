//! What `routines:flow-act` and `routines:flow-test` do, on the fixture's own copy of a Run: approve or reject the
//! approval a Run waits on, pause, resume, end, retry the step it stopped at, and the dry run a Test run starts. The real
//! daemon runs the agents; here a step goes from running to done at once, so every state the page draws can be reached.

use super::ops::{current_step, failed_step, flatten, test_condition, trigger_values};
use super::run::Act;
use super::types::*;
use crate::data::Millis;
use crate::routines::model::{Run, RunStatus};

/// The sample a Test run's agents answer with, by field type.
fn sample(field: &FlowField) -> Value {
    match field.ty {
        FieldType::Choice => Value::text(field.choices.first().cloned().unwrap_or_default()),
        FieldType::YesNo => Value::Bool(true),
        FieldType::Number => Value::Num(1.0),
        FieldType::Link => Value::text("https://example.com/sample"),
        FieldType::Text => Value::text("sample"),
    }
}

/// A Test run of `steps` (a dry run): agents answer with samples, actions and waits are skipped, approvals pass, and each
/// If takes the path its test picks over those samples.
pub fn simulate(steps: &[FlowStep], revision: u32, now: Millis) -> FlowRun {
    let sample_event = RunEvent::Linear {
        change: crate::routines::model::LinearEvent::LabelAdded,
        issue: IssueSnapshot {
            key: "MIL-000".into(),
            title: "Sample issue".into(),
            description: "A sample issue for a test.".into(),
            url: None,
            labels: vec!["agent".into()],
            state: "Todo".into(),
            team: "MIL".into(),
        },
        comment_author: None,
        comment_body: None,
    };
    let mut values: Vec<(String, Value)> = vec![("trigger".into(), trigger_values(Some(&sample_event), None))];
    let mut state = std::collections::HashMap::new();

    fn walk(steps: &[FlowStep], values: &mut Vec<(String, Value)>, state: &mut std::collections::HashMap<String, StepRun>, now: Millis) {
        for step in steps {
            let mut run = StepRun::done(now, now);
            match &step.body {
                StepBody::Agent(agent) => {
                    run.output = agent.output.iter().map(|field| (field.name.clone(), sample(field))).collect();
                    values.push((step.id.clone(), Value::Object(run.output.clone())));
                }
                StepBody::If(branching) => {
                    let root = Value::Object(values.clone());
                    let holds = test_condition(&branching.field, branching.test, branching.value.as_deref().unwrap_or(""), &root);
                    let branch = if holds { Branch::Yes } else { Branch::Otherwise };
                    run.taken = Some(branch);
                    state.insert(step.id.clone(), run);
                    walk(branching.path(branch), values, state, now);
                    continue;
                }
                StepBody::Ask(ask) => {
                    run.approval = Some(Approval {
                        asked_at: now,
                        expires_at: now + i64::from(ask.expires_in_hours) * 3_600_000,
                        message: ask.message.clone(),
                        preview: None,
                        decision: Some(Decision::Approved),
                        decided_at: Some(now),
                        reason: None,
                    });
                }
                StepBody::Wait(_) | StepBody::LinearComment(_) => {
                    run.status = StepStatus::Skipped;
                    run.summary = Some("Skipped in a test run".into());
                }
                StepBody::PullRequest(_) => {
                    run.status = StepStatus::Skipped;
                    run.summary = Some("Skipped in a test run".into());
                    values.push((step.id.clone(), Value::object([("url", Value::text("https://github.com/example/repo/pull/0"))])));
                }
            }
            state.insert(step.id.clone(), run);
        }
    }
    walk(steps, &mut values, &mut state, now);
    FlowRun { revision, steps: steps.to_vec(), state, status: FlowStatus::Done, dry_run: true }
}

/// A Run that has just started on the published steps: the first step is under way.
pub fn start(steps: &[FlowStep], revision: u32, now: Millis) -> FlowRun {
    let mut state = std::collections::HashMap::new();
    if let Some(first) = steps.first() {
        let mut run = StepRun::new(StepStatus::Running);
        run.started_at = Some(now);
        state.insert(first.id.clone(), run);
    }
    FlowRun { revision, steps: steps.to_vec(), state, status: FlowStatus::Running, dry_run: false }
}

/// The next step in run order that has not started, if any, skipping the paths no If has taken.
fn next_pending(flow: &FlowRun) -> Option<String> {
    flatten(&flow.steps)
        .into_iter()
        .map(|entry| entry.step)
        .find(|step| flow.state.get(&step.id).is_none_or(|run| run.status == StepStatus::Pending))
        .map(|step| step.id.clone())
}

fn finish(run: &mut Run, status: FlowStatus, run_status: RunStatus, now: Millis) {
    if let Some(flow) = &mut run.flow {
        flow.status = status;
    }
    run.status = run_status;
    run.ended_at = Some(now);
}

/// Moves a Run on after a step is done: the next step starts, or the Run is done.
fn advance(run: &mut Run, now: Millis) {
    let Some(flow) = &mut run.flow else { return };
    match next_pending(flow) {
        Some(next) => {
            let mut step = StepRun::new(StepStatus::Running);
            step.started_at = Some(now);
            flow.state.insert(next, step);
            flow.status = FlowStatus::Running;
            run.status = RunStatus::Running;
        }
        None => finish(run, FlowStatus::Done, RunStatus::Acted, now),
    }
}

/// `routines:flow-act` on one Run.
pub fn apply(run: &mut Run, act: Act, now: Millis) -> Result<(), String> {
    let Some(flow) = run.flow.as_mut() else { return Err("Not a flow Run".into()) };
    match act {
        Act::Approve | Act::Reject { .. } => {
            let step = current_step(flow).cloned().ok_or("Nothing waits for an answer")?;
            let state = flow.state.get_mut(&step.id).ok_or("Nothing waits for an answer")?;
            let approval = state.approval.as_mut().filter(|a| a.decision.is_none()).ok_or("Nothing waits for an answer")?;
            approval.decided_at = Some(now);
            match act {
                Act::Approve => {
                    approval.decision = Some(Decision::Approved);
                    state.status = StepStatus::Done;
                    state.ended_at = Some(now);
                    if let StepBody::PullRequest(pr) = &step.body {
                        let branch = approval.preview.as_ref().map_or("milagre/run".to_string(), |p| p.branch.clone());
                        state.summary = Some(format!("Opened {}", if pr.draft { "draft #862" } else { "#862" }));
                        state.receipt = Some(Receipt::PullRequest {
                            url: "https://github.com/the-ptf/milagre/pull/862".into(),
                            number: 862,
                            branch,
                            draft: pr.draft,
                            matched: false,
                            at: now,
                        });
                    }
                    advance(run, now);
                }
                Act::Reject { reason } => {
                    approval.decision = Some(Decision::Rejected);
                    approval.reason = reason.clone();
                    state.status = StepStatus::Failed;
                    state.error = Some("Rejected".into());
                    state.ended_at = Some(now);
                    for (id, other) in flow.state.iter_mut() {
                        if id != &step.id && other.status == StepStatus::Pending {
                            other.status = StepStatus::NotRun;
                        }
                    }
                    for entry in flatten(&flow.steps) {
                        flow.state.entry(entry.step.id.clone()).or_insert_with(|| StepRun::new(StepStatus::NotRun));
                    }
                    run.error = Some(match reason {
                        Some(reason) => format!("approval rejected: {reason}"),
                        None => "approval rejected".into(),
                    });
                    finish(run, FlowStatus::Ended, RunStatus::Ended, now);
                }
                _ => unreachable!("matched above"),
            }
        }
        Act::Pause => {
            if matches!(flow.status, FlowStatus::Running | FlowStatus::Waiting) {
                flow.status = FlowStatus::Paused;
            }
        }
        Act::Resume => {
            if flow.status == FlowStatus::Paused {
                let waiting = flow.state.values().any(|step| step.status == StepStatus::Waiting);
                flow.status = if waiting { FlowStatus::Waiting } else { FlowStatus::Running };
            }
        }
        Act::End => {
            if matches!(flow.status, FlowStatus::Running | FlowStatus::Waiting | FlowStatus::Paused | FlowStatus::Failed) {
                for step in flow.state.values_mut() {
                    if matches!(step.status, StepStatus::Running | StepStatus::Waiting) {
                        step.status = StepStatus::NotRun;
                    }
                }
                run.error = Some("ended by hand".into());
                finish(run, FlowStatus::Ended, RunStatus::Ended, now);
            }
        }
        Act::Retry { note } => {
            let step = failed_step(flow).cloned().ok_or("Nothing failed")?;
            if flow.status != FlowStatus::Failed {
                return Err("The Run is not stopped".into());
            }
            let state = flow.state.get_mut(&step.id).ok_or("Nothing failed")?;
            if let Some(started) = state.started_at {
                state.tries.push(Try {
                    started_at: started,
                    ended_at: state.ended_at.unwrap_or(started),
                    error: state.error.clone().unwrap_or_else(|| "Failed".into()),
                    chat_id: state.chat_id.take(),
                });
            }
            state.status = StepStatus::Running;
            state.started_at = Some(now);
            state.ended_at = None;
            state.error = None;
            state.note = note;
            for other in flow.state.values_mut() {
                if other.status == StepStatus::NotRun {
                    other.status = StepStatus::Pending;
                }
            }
            flow.status = FlowStatus::Running;
            run.status = RunStatus::Running;
            run.ended_at = None;
        }
    }
    Ok(())
}
