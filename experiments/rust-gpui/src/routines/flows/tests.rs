//! Tests of the flow domain (the vectors of `packages/shared/src/routine-flows.test.mjs`) and of the Flow page: what it
//! draws, what a click does, and what an edit, a publish, an approval and a retry change.

use std::time::Duration;

use gpui::{Modifiers, TestAppContext, VisualTestContext};

use super::act;
use super::fixture;
use super::look;
use super::ops::*;
use super::run::Act;
use super::types::*;
use super::{Mode, Tab};
use crate::routines::RoutinesView;
use crate::testing;

// ----- the vectors -----

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

fn step(id: &str, name: &str, body: StepBody) -> FlowStep {
    FlowStep { id: id.into(), name: name.into(), body }
}

/// The pilot: Linear label -> Classify -> If large (Ask) -> Implement -> Open pull request -> Review.
fn pilot() -> Vec<FlowStep> {
    vec![
        step(
            "classify",
            "Classify",
            StepBody::Agent(AgentStep {
                retries: 2,
                output: vec![FlowField::choice("complexity", &["small", "medium", "large"]), FlowField::new("area", FieldType::Text)],
                ..agent("Read {{trigger.issue.title}} and {{trigger.issue.description}}.")
            }),
        ),
        step(
            "if-large",
            "If",
            StepBody::If(IfStep {
                field: "classify.complexity".into(),
                test: Test::Is,
                value: Some("large".into()),
                yes: vec![step(
                    "ask",
                    "Ask before implementing",
                    StepBody::Ask(AskStep { message: "{{classify.area}}".into(), expires_in_hours: 24 }),
                )],
                otherwise: Vec::new(),
            }),
        ),
        step("implement", "Implement", StepBody::Agent(agent("Fix {{trigger.issue.key}} in {{classify.area}}"))),
        step(
            "pr",
            "Open pull request",
            StepBody::PullRequest(PullRequestStep {
                title: "{{trigger.issue.title}}".into(),
                body: String::new(),
                base: None,
                draft: true,
                ask_first: true,
            }),
        ),
        step(
            "review",
            "Review",
            StepBody::Agent(AgentStep {
                chat: ChatUse::Own,
                output: vec![FlowField::choice("verdict", &["approve", "changes"])],
                ..agent("Review {{pr.url}}")
            }),
        ),
    ]
}

fn messages(steps: &[FlowStep], trigger: TriggerKind) -> Vec<String> {
    flow_problems(steps, trigger).into_iter().map(|problem| problem.message).collect()
}

#[test]
fn the_pilot_flow_checks_clean_under_a_linear_trigger() {
    assert!(flow_problems(&pilot(), TriggerKind::Linear).is_empty());
    assert_eq!(check_flow_steps(&pilot(), TriggerKind::Linear).unwrap().len(), 5);
}

#[test]
fn a_step_cant_read_a_field_no_earlier_step_gives_nor_a_paths_field_after_the_if() {
    let mut steps = pilot();
    steps[2] = step("implement", "Implement", StepBody::Agent(agent("{{ask.decision}} {{review.verdict}}")));
    let found = messages(&steps, TriggerKind::Linear);
    assert!(found.iter().any(|message| message.contains("ask.decision")), "{found:?}");
    assert!(found.iter().any(|message| message.contains("review.verdict")), "{found:?}");
}

#[test]
fn linear_steps_need_a_linear_trigger_and_a_review_wait_needs_a_pull_request_first() {
    let steps = vec![
        step("c", "Comment", StepBody::LinearComment(CommentStep { body: "hi".into() })),
        step("w", "Wait", StepBody::Wait(WaitStep { until: Until::PrReview, timeout_hours: 4 })),
    ];
    let found = messages(&steps, TriggerKind::Schedule);
    assert!(found.iter().any(|message| message.contains("needs a Linear trigger")), "{found:?}");
    assert!(found.iter().any(|message| message.contains("pull request must come first")), "{found:?}");
}

#[test]
fn check_flow_steps_rejects_bad_shapes_with_the_steps_name() {
    let err = |steps: Vec<FlowStep>| check_flow_steps(&steps, TriggerKind::Linear).unwrap_err();
    assert!(
        err(vec![step("Bad Id", "x", StepBody::Ask(AskStep { message: String::new(), expires_in_hours: 24 }))]).contains("isn't a step id")
    );
    assert!(err(vec![step("a", "A", StepBody::Agent(agent("")))]).contains("Step \"A\": add a prompt"));
    let one_choice = AgentStep { output: vec![FlowField::choice("c", &["one"])], ..agent("x") };
    assert!(err(vec![step("a", "A", StepBody::Agent(one_choice))]).contains("two choices"));
    assert!(err(Vec::new()).contains("at least one step"));
}

#[test]
fn ifs_nest_three_deep_at_most() {
    fn nest(depth: u32) -> FlowStep {
        step(
            &format!("if-{depth}"),
            "If",
            StepBody::If(IfStep {
                field: "trigger.issue.key".into(),
                test: Test::IsSet,
                value: None,
                yes: if depth < 4 { vec![nest(depth + 1)] } else { Vec::new() },
                otherwise: Vec::new(),
            }),
        )
    }
    assert!(check_flow_steps(&[nest(1)], TriggerKind::Linear).unwrap_err().contains("nest 3 deep"));
}

#[test]
fn a_step_cannot_overwrite_the_trigger_namespace_or_read_inherited_properties() {
    let mut steps = pilot();
    steps[0].id = "trigger".into();
    assert!(check_flow_steps(&steps, TriggerKind::Linear).unwrap_err().contains("reserved"));
    assert_eq!(fill_template("{{trigger.constructor}}", &Value::object([("trigger", Value::Object(Vec::new()))])), "");
}

#[test]
fn fields_before_sees_the_trigger_earlier_outputs_and_an_earlier_pull_requests_url() {
    let refs: Vec<String> = fields_before(&pilot(), Some("review"), TriggerKind::Linear).into_iter().map(|field| field.ref_).collect();
    assert!(refs.contains(&"trigger.issue.title".to_string()));
    assert!(refs.contains(&"classify.complexity".to_string()));
    assert!(refs.contains(&"pr.url".to_string()));
    assert!(!refs.contains(&"review.verdict".to_string()));
    let first: Vec<String> = fields_before(&pilot(), Some("classify"), TriggerKind::Linear)
        .into_iter()
        .map(|field| field.ref_)
        .filter(|ref_| !ref_.starts_with("trigger."))
        .collect();
    assert!(first.is_empty());
}

#[test]
fn tree_edits_insert_into_a_path_move_remove_an_if_with_its_paths() {
    let mut steps = pilot();
    let comment = new_step(StepKind::LinearComment, &steps);
    steps = insert_step(&steps, &Where::path("if-large", Branch::Otherwise, 0), comment.clone()).unwrap();
    assert_eq!(steps[1].as_if().unwrap().otherwise[0].id, comment.id);
    steps = move_step(&steps, "implement", -1);
    assert_eq!(steps[1].id, "implement");
    steps = remove_step(&steps, "if-large");
    assert_eq!(flatten(&steps).len(), 4);
    assert_eq!(insert_step(&steps, &Where::path("nope", Branch::Yes, 0), comment).unwrap_err(), "No such place in the flow");
}

#[test]
fn new_step_id_never_repeats_an_id() {
    assert_eq!(new_step_id(&pilot(), "Classify"), "classify-2");
    assert_eq!(new_step_id(&pilot(), "Wait for CI"), "wait-for-ci");
}

#[test]
fn fill_template_reads_the_trigger_and_outputs_empty_for_nothing() {
    let event = RunEvent::Linear {
        change: crate::routines::model::LinearEvent::LabelAdded,
        issue: IssueSnapshot {
            key: "MIL-1".into(),
            title: "T".into(),
            description: String::new(),
            url: None,
            labels: vec!["a".into(), "b".into()],
            state: String::new(),
            team: String::new(),
        },
        comment_author: None,
        comment_body: None,
    };
    let values =
        Value::object([("trigger", trigger_values(Some(&event), None)), ("classify", Value::object([("area", Value::text("relay"))]))]);
    assert_eq!(fill_template("{{trigger.issue.key}} {{classify.area}} {{x.y}}|{{trigger.issue.labels}}", &values), "MIL-1 relay |a, b");
}

#[test]
fn test_condition_is_is_not_a_list_of_choices_contains_is_set() {
    let values = Value::object([("classify", Value::object([("complexity", Value::text("Large")), ("ok", Value::Bool(false))]))]);
    assert!(test_condition("classify.complexity", Test::Is, "large", &values));
    assert!(!test_condition("classify.complexity", Test::Is, "small or medium", &values));
    assert!(test_condition("classify.complexity", Test::IsNot, "small, medium", &values));
    assert!(test_condition("classify.complexity", Test::Contains, "arg", &values));
    assert!(!test_condition("classify.ok", Test::IsSet, "", &values));
}

#[test]
fn check_output_types_each_field_and_says_whats_wrong() {
    let fields = vec![
        FlowField::choice("complexity", &["small", "large"]),
        FlowField::new("tests", FieldType::YesNo),
        FlowField::new("count", FieldType::Number),
        FlowField::new("link", FieldType::Link),
    ];
    let good = Value::object([
        ("complexity", Value::text("LARGE")),
        ("tests", Value::text("yes")),
        ("count", Value::text("3")),
        ("link", Value::text("https://x.y/1")),
    ]);
    assert_eq!(
        check_output(&fields, &good).unwrap(),
        vec![
            ("complexity".to_string(), Value::text("large")),
            ("tests".to_string(), Value::Bool(true)),
            ("count".to_string(), Value::Num(3.0)),
            ("link".to_string(), Value::text("https://x.y/1")),
        ]
    );
    let bad = check_output(&fields, &Value::object([("complexity", Value::text("huge")), ("tests", Value::text("maybe"))])).unwrap_err();
    assert!(bad.contains("complexity must be one of small, large; tests must be yes or no; count is missing"), "{bad}");
}

#[test]
fn flow_changes_lists_what_a_draft_adds_removes_and_changes() {
    let mut draft = pilot();
    draft[0] = step("classify", "Classify", StepBody::Agent(AgentStep { prompt: "new".into(), ..pilot()[0].as_agent().unwrap().clone() }));
    draft.remove(4);
    draft.push(new_step(StepKind::LinearComment, &draft));
    assert_eq!(flow_changes(&pilot(), &draft), ["Classify: prompt changed", "Added Comment on Linear", "Removed Review"]);
}

#[test]
fn used_by_counts_the_steps_reading_a_ref() {
    assert_eq!(used_by(&pilot(), "classify.area"), 2);
    assert_eq!(used_by(&pilot(), "classify.complexity"), 1);
}

fn waiting_flow() -> FlowRun {
    let mut state = std::collections::HashMap::new();
    state.insert("classify".to_string(), StepRun::new(StepStatus::Done));
    state.insert("if-large".to_string(), StepRun { taken: Some(Branch::Yes), ..StepRun::new(StepStatus::Done) });
    state.insert("ask".to_string(), StepRun::new(StepStatus::Done));
    state.insert("implement".to_string(), StepRun::new(StepStatus::Done));
    state.insert(
        "pr".to_string(),
        StepRun {
            approval: Some(Approval {
                asked_at: 1,
                expires_at: 2,
                message: String::new(),
                preview: None,
                decision: None,
                decided_at: None,
                reason: None,
            }),
            ..StepRun::new(StepStatus::Waiting)
        },
    );
    FlowRun { revision: 4, steps: pilot(), state, status: FlowStatus::Waiting, dry_run: false }
}

#[test]
fn run_rows_marks_the_path_not_taken_and_flow_run_text_reads_the_run() {
    let flow = waiting_flow();
    let rows = run_rows(&flow);
    let otherwise = rows.iter().find_map(|row| match row {
        RunRow::Path { path: Branch::Otherwise, taken, empty, .. } => Some((*taken, *empty)),
        _ => None,
    });
    assert_eq!(otherwise, Some((false, true)));
    let ask = rows.iter().find_map(|row| match row {
        RunRow::Step { step, status, .. } if step.id == "ask" => Some(*status),
        _ => None,
    });
    assert_eq!(ask, Some(StepStatus::Done));
    assert_eq!(flow_run_text(&flow, None), "Waiting for you at Open pull request");
    assert!(needs_answer(&flow));
    let mut stopped = flow.clone();
    stopped.status = FlowStatus::Failed;
    stopped.state.insert("pr".into(), StepRun::new(StepStatus::Failed));
    assert_eq!(flow_run_text(&stopped, None), "Stopped at Open pull request");
}

#[test]
fn the_words_steps_are_described_in() {
    let if_step = pilot()[1].clone();
    assert_eq!(step_title(&if_step), "If complexity is large");
    let name = |_: Option<crate::data::Provider>, model: &str| model.to_string();
    assert_eq!(step_subtitle(&pilot()[0], &name), "Agent, Run Chat");
    assert_eq!(step_subtitle(&pilot()[4], &name), "Agent, its own Chat");
    assert_eq!(step_subtitle(&pilot()[3], &name), "Action, asks first, draft PR, keeps a receipt");
    assert_eq!(duration_text(45), "45 min");
    assert_eq!(duration_text(90), "1 h 30 min");
    assert_eq!(duration_text(120), "2 h");
    assert_eq!(duration_text(4320), "3 d");
    assert_eq!(placeholders("{{ a.b }} {{a.b}} {{c-d}}"), ["a.b", "c-d"]);
    assert_eq!(
        output_summary(&[("complexity".into(), Value::text("large")), ("tests".into(), Value::Bool(true))]),
        "complexity large, tests yes"
    );
}

#[test]
fn the_instructions_an_agent_gets_for_its_output() {
    assert_eq!(output_instructions(&[]), "When you are done, call the flow_step_output tool once with an empty object.");
    let text = output_instructions(&[FlowField::choice("c", &["a", "b"]), FlowField::new("n", FieldType::Number)]);
    assert!(text.ends_with("- c: one of a, b\n- n: a number"), "{text}");
}

#[test]
fn drafts_check_only_the_shape() {
    let mut steps = pilot();
    steps[0] = step("classify", "Classify", StepBody::Agent(agent("")));
    assert!(check_draft_steps(&steps).is_ok());
    steps.push(step("Bad", "x", StepBody::Agent(agent(""))));
    assert!(check_draft_steps(&steps).is_err());
}

#[test]
fn the_fixture_flow_checks_clean_and_its_runs_read_right() {
    assert!(flow_problems(&fixture::pilot(), TriggerKind::Linear).is_empty());
    let (def, runs) = fixture::review_flow();
    assert_eq!(def.steps.len(), 5);
    assert!(def.draft.is_some());
    let texts: Vec<String> = runs.iter().map(|run| flow_run_text(run.flow.as_ref().unwrap(), run.error.as_deref())).collect();
    assert_eq!(
        texts,
        [
            "Running Classify",
            "Waiting for you at Ask before implementing",
            "Waiting for you at Open pull request",
            "Stopped at Implement",
            "Test run done",
            "Done",
            "Ended, approval expired",
        ]
    );
    assert_eq!(fixture::waiting_count(&runs), 2);
}

#[test]
fn a_test_run_takes_the_path_its_samples_pick_and_skips_actions() {
    let flow = act::simulate(&fixture::pilot(), 3, 0);
    assert!(flow.dry_run);
    assert_eq!(flow.status, FlowStatus::Done);
    // The sample for a choice is its first, "small", so the If takes Otherwise and Ask never runs.
    assert_eq!(flow.state["if-large"].taken, Some(Branch::Otherwise));
    assert!(!flow.state.contains_key("ask"));
    assert_eq!(flow.state["pr"].status, StepStatus::Skipped);
}

#[test]
fn acts_move_a_run_on() {
    let (_, mut runs) = fixture::review_flow();
    let mut pr_run = runs.remove(2);
    assert!(act::apply(&mut pr_run, Act::Pause, 10).is_ok());
    assert_eq!(pr_run.flow.as_ref().unwrap().status, FlowStatus::Paused);
    act::apply(&mut pr_run, Act::Resume, 11).unwrap();
    assert_eq!(pr_run.flow.as_ref().unwrap().status, FlowStatus::Waiting);
    act::apply(&mut pr_run, Act::Approve, 12).unwrap();
    let flow = pr_run.flow.as_ref().unwrap();
    assert!(matches!(flow.state["pr"].receipt, Some(Receipt::PullRequest { number: 862, .. })));
    // Review starts next.
    assert_eq!(flow.state["review"].status, StepStatus::Running);
    assert_eq!(flow.status, FlowStatus::Running);

    let mut stopped = runs.remove(2);
    assert_eq!(stopped.flow.as_ref().unwrap().status, FlowStatus::Failed);
    act::apply(&mut stopped, Act::Retry { note: Some("use the cache".into()) }, 20).unwrap();
    let flow = stopped.flow.as_ref().unwrap();
    assert_eq!(flow.status, FlowStatus::Running);
    assert_eq!(flow.state["implement"].note.as_deref(), Some("use the cache"));
    assert_eq!(flow.state["implement"].tries.len(), 2);

    let mut waiting = runs.remove(1);
    act::apply(&mut waiting, Act::Reject { reason: Some("too big".into()) }, 30).unwrap();
    assert_eq!(waiting.flow.as_ref().unwrap().status, FlowStatus::Ended);
    assert_eq!(waiting.error.as_deref(), Some("approval rejected: too big"));
    assert_eq!(look::flow_status_look(waiting.flow.as_ref().unwrap(), false).0, "Ended");
}

#[test]
fn run_names_count_from_the_routines_total_and_a_test_run_has_none() {
    let routines = crate::routines::fixture::routines();
    let review = routines.iter().find(|routine| routine.id == "rt-review").unwrap();
    let names: Vec<String> = review.runs.iter().map(|run| look::run_name(review, run)).collect();
    assert_eq!(names, ["Run 16", "Run 15", "Run 14", "Run 13", "Test run", "Run 12", "Run 11"]);
    assert_eq!(look::run_headline(&review.runs[2]), "MIL-482 Retry webhook deliveries");
    assert_eq!(look::trigger_run_text(review, &review.runs[2]), "agent added to MIL-482 at 11:20");
    assert_eq!(look::took_text(41_000), "41 s");
    assert_eq!(look::took_text(5 * 60_000), "5 min");
}

// ----- the page -----

fn mount(cx: &mut TestAppContext) -> (gpui::Entity<RoutinesView>, &mut VisualTestContext) {
    testing::init(cx);
    testing::mount_in_root(cx, RoutinesView::new)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx.debug_bounds(selector).unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(bounds.center(), Modifiers::none());
    cx.run_until_parked();
}

fn has(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(Box::leak(selector.to_string().into_boxed_str())).is_some()
}

fn open(view: &gpui::Entity<RoutinesView>, cx: &mut VisualTestContext, id: &str) {
    let id = id.to_string();
    view.update(cx, |view, cx| view.open_page(&id, cx));
    cx.run_until_parked();
}

fn steps_of(view: &gpui::Entity<RoutinesView>, cx: &mut VisualTestContext) -> Vec<String> {
    view.read_with(cx, |view, _| {
        view.flow_state().map(|flow| flatten(&flow.steps).into_iter().map(|e| e.step.id.clone()).collect()).unwrap_or_default()
    })
}

#[gpui::test]
fn a_flow_routine_opens_the_flow_page_and_a_plain_one_the_plain_page(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    for selector in [
        "flow-page",
        "flow-chip",
        "flow-toolbar",
        "flow-tabs",
        "flow-step-list",
        "flow-step-trigger",
        "flow-step-classify",
        "flow-step-if-large",
        "flow-step-review",
    ] {
        assert!(has(cx, selector), "{selector}");
    }
    assert!(!has(cx, "routine-chips"));
    // The Draft chip says the draft differs; Publish is the next revision.
    assert!(has(cx, "flow-draft-chip"));
    assert!(has(cx, "flow-revision-on"));
    // Both paths of the If, the Ask under Yes, and an empty Otherwise path.
    assert!(has(cx, "flow-path-label-Yes") && has(cx, "flow-path-label-Otherwise"));
    assert!(has(cx, "flow-step-ask"));
    assert!(has(cx, "flow-empty-path-if-large:otherwise"));
    click(cx, "routine-back");
    assert!(view.read_with(cx, |view, _| view.flow_state().is_none()));
    open(&view, cx, "rt-nightly");
    assert!(has(cx, "routine-chips") && !has(cx, "flow-page"));
}

#[gpui::test]
fn the_waiting_banner_and_runs_tab_count_name_the_runs_waiting_for_you(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    assert!(has(cx, "flow-waiting-banner"));
    assert!(has(cx, "flow-waiting-badge"));
    click(cx, "flow-show-waiting");
    let (tab, mode, run) = view.read_with(cx, |view, _| {
        let flow = view.flow_state().unwrap();
        (flow.tab, flow.mode, flow.run_id.clone())
    });
    assert_eq!((tab, mode), (Tab::Steps, Mode::Run));
    assert_eq!(run.as_deref(), Some("flow-15"));
    // The banner now names the other Run waiting for you, and goes to it.
    assert!(has(cx, "flow-waiting-banner"));
    click(cx, "flow-show-waiting");
    assert_eq!(view.read_with(cx, |view, _| view.flow_state().unwrap().run_id.clone()).as_deref(), Some("flow-14"));
}

#[gpui::test]
fn selecting_a_step_shows_its_inspector_and_the_trigger_its_fields(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    assert!(has(cx, "flow-inspector-classify"), "the first step is selected");
    assert!(has(cx, "flow-reads") && has(cx, "flow-test-note") && has(cx, "flow-output"));
    click(cx, "flow-step-implement");
    assert!(has(cx, "flow-inspector-implement"));
    click(cx, "flow-step-ask");
    assert!(has(cx, "flow-inspector-ask"));
    click(cx, "flow-step-pr");
    assert!(has(cx, "flow-inspector-pr"));
    click(cx, "flow-step-trigger");
    assert!(has(cx, "flow-inspector-trigger") && has(cx, "flow-trigger-settings"));
    click(cx, "flow-trigger-settings");
    assert_eq!(view.read_with(cx, |view, _| view.flow_state().unwrap().tab), Tab::Settings);
    assert!(has(cx, "routine-form"), "the Routine form in place");
}

#[gpui::test]
fn a_name_typed_in_the_inspector_edits_the_draft_and_saves_after_a_pause(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-step-implement");
    let inspector = view.read_with(cx, |view, _| view.flow_state().unwrap().inspector.clone().unwrap());
    inspector.update_in(cx, |inspector, window, cx| inspector.type_name("Do the work", window, cx));
    cx.run_until_parked();
    let name = |view: &RoutinesView, _: &gpui::App| view.flow_state().unwrap().steps[2].name.clone();
    assert_eq!(view.read_with(cx, name), "Do the work");
    assert!(view.read_with(cx, |view, _| view.flow_state().unwrap().pending));
    let saved = |view: &RoutinesView, _: &gpui::App| {
        view.routine("rt-review").unwrap().flow.as_ref().unwrap().def.draft.as_ref().unwrap().steps[2].name.clone()
    };
    assert_eq!(view.read_with(cx, saved), "Implement", "not saved yet");
    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    assert_eq!(view.read_with(cx, saved), "Do the work");
    assert!(!view.read_with(cx, |view, _| view.flow_state().unwrap().pending));
    // The card shows the new name.
    assert!(has(cx, "flow-step-implement"));
    // The Changes list names it.
    assert!(view.read_with(cx, |view, _| view.flow_changes_now()).contains(&"Do the work: renamed".to_string()));
}

#[gpui::test]
fn leaving_the_page_saves_an_edit_still_waiting(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_delete("review", cx));
    cx.run_until_parked();
    click(cx, "routine-back");
    let draft = view.read_with(cx, |view, _| view.routine("rt-review").unwrap().flow.as_ref().unwrap().def.draft.clone().unwrap());
    assert!(!draft.steps.iter().any(|step| step.id == "review"));
    // Coming back finds the draft, and the page where it was left.
    open(&view, cx, "rt-review");
    let steps = steps_of(&view, cx);
    assert_eq!(steps.len(), 6, "the draft's steps without Review");
    assert!(!steps.contains(&"review".to_string()));
}

#[gpui::test]
fn the_plus_on_the_rail_adds_a_step_of_the_chosen_type_and_selects_it(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    let before = steps_of(&view, cx);
    click(cx, "flow-add-here-top::2");
    assert!(has(cx, "flow-add-menu"));
    for kind in ["agent", "if", "ask", "wait", "pull-request", "linear-comment"] {
        assert!(has(cx, &format!("flow-add-{kind}")), "{kind}");
    }
    click(cx, "flow-add-wait");
    let after = steps_of(&view, cx);
    assert_eq!(after.len(), before.len() + 1);
    let selected = view.read_with(cx, |view, _| view.flow_state().unwrap().selected.clone());
    assert_eq!(selected.as_deref(), Some("wait"));
    // Between Classify's If and Implement: index 2 at the top.
    assert_eq!(view.read_with(cx, |view, _| view.flow_state().unwrap().steps[2].id.clone()), "wait");
    assert!(has(cx, "flow-inspector-wait") && has(cx, "flow-wait-minutes"));
}

#[gpui::test]
fn an_empty_path_adds_into_that_path(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-empty-path-if-large:otherwise");
    click(cx, "flow-add-linear-comment");
    let otherwise = view.read_with(cx, |view, _| view.flow_state().unwrap().steps[1].as_if().unwrap().otherwise.len());
    assert_eq!(otherwise, 1);
    assert!(!has(cx, "flow-empty-path-if-large:otherwise"));
}

#[gpui::test]
fn move_and_delete_change_the_order_and_the_draft(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_move("review", -1, cx));
    assert_eq!(steps_of(&view, cx), ["classify", "if-large", "ask", "implement", "review", "pr", "comment-on-linear"]);
    view.update(cx, |view, cx| view.flow_move("classify", -1, cx));
    assert_eq!(steps_of(&view, cx)[0], "classify", "no move past the start");
    view.update(cx, |view, cx| view.flow_delete("if-large", cx));
    cx.run_until_parked();
    assert_eq!(steps_of(&view, cx), ["classify", "implement", "review", "pr", "comment-on-linear"]);
    let selected = view.read_with(cx, |view, _| view.flow_state().unwrap().selected.clone());
    assert_eq!(selected.as_deref(), Some("classify"));
    // The steps that read the If's path are flagged.
    let changes = view.read_with(cx, |view, _| view.flow_changes_now());
    assert!(changes.contains(&"Removed If complexity is large".to_string()), "{changes:?}");
}

#[gpui::test]
fn a_step_that_reads_nothing_it_can_shows_a_problem_and_blocks_publish(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    // Review reads {{pr.url}}: moving it above the pull request leaves it reading a field nobody has given yet.
    view.update(cx, |view, cx| view.flow_move("review", -1, cx));
    cx.run_until_parked();
    assert!(has(cx, "flow-step-problem-review"));
    click(cx, "flow-step-review");
    assert!(has(cx, "flow-problems"));
    let published = view.update(cx, |view, cx| view.flow_publish(cx));
    assert!(!published);
    let error = view.read_with(cx, |view, _| view.flow_state().unwrap().error.clone());
    assert!(error.is_some_and(|error| error.contains("pr.url")));
    assert_eq!(view.read_with(cx, |view, _| view.routine("rt-review").unwrap().flow.as_ref().unwrap().revision), 3);
}

#[gpui::test]
fn publish_makes_the_draft_the_next_revision(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    assert!(has(cx, "flow-publish"));
    click(cx, "flow-publish");
    assert!(has(cx, "flow-publish-dialog"), "the dialog lists what changes");
    click(cx, "flow-publish-confirm");
    let (revision, draft, steps) = view.read_with(cx, |view, _| {
        let info = view.routine("rt-review").unwrap().flow.clone().unwrap();
        (info.revision, info.def.draft.clone(), info.def.steps.len())
    });
    assert_eq!(revision, 4);
    assert!(draft.is_none());
    assert_eq!(steps, 6);
    // Nothing is left to publish.
    assert!(view.read_with(cx, |view, _| view.flow_changes_now()).is_empty());
    assert!(!has(cx, "flow-draft-chip"));
}

#[gpui::test]
fn discard_draft_asks_first_then_goes_back_to_the_published_steps(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-draft-chip");
    assert!(has(cx, "flow-draft-menu"));
    click(cx, "flow-discard");
    assert!(has(cx, "flow-discard-confirm"));
    click(cx, "flow-discard-confirm");
    assert_eq!(steps_of(&view, cx).len(), 6);
    assert!(view.read_with(cx, |view, _| view.routine("rt-review").unwrap().flow.as_ref().unwrap().def.draft.is_none()));
    assert!(!has(cx, "flow-draft-chip"));
}

#[gpui::test]
fn a_flow_never_published_starts_from_the_first_step_tiles(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-flow");
    assert!(has(cx, "flow-empty"));
    assert!(has(cx, "flow-revision-off"));
    assert!(has(cx, "flow-inspector-trigger"));
    for kind in ["agent", "if", "ask", "wait", "pull-request", "linear-comment"] {
        assert!(has(cx, &format!("flow-tile-{kind}")), "{kind}");
    }
    click(cx, "flow-tile-agent");
    assert_eq!(steps_of(&view, cx), ["agent"]);
    assert!(!has(cx, "flow-empty"));
    assert!(has(cx, "flow-inspector-agent"));
    // An agent step without a prompt is a problem, so Test run and Publish are blocked.
    assert!(has(cx, "flow-step-problem-agent"));
}

#[gpui::test]
fn show_run_draws_the_bar_the_rows_and_the_approval_waiting_for_you(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| {
        view.flow_show_run("flow-14", cx);
    });
    cx.run_until_parked();
    for selector in [
        "flow-run-bar",
        "flow-run-rows-flow-14",
        "flow-run-step-trigger",
        "flow-run-step-classify",
        "flow-run-step-pr",
        "flow-approval",
        "flow-approve",
        "flow-reject-start",
    ] {
        assert!(has(cx, selector), "{selector}");
    }
    // The pull request it would open, with the receipt note.
    assert!(!has(cx, "flow-approval-message"));
    // The path not taken is labelled.
    assert!(has(cx, "flow-run-path-if-large:otherwise"));
    assert!(has(cx, "flow-run-status-waiting"));
}

#[gpui::test]
fn approve_opens_the_pull_request_keeps_a_receipt_and_starts_the_next_step(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-14", cx));
    cx.run_until_parked();
    click(cx, "flow-approve");
    cx.run_until_parked();
    let (waiting, status, receipt) = view.read_with(cx, |view, _| {
        let routine = view.routine("rt-review").unwrap();
        let run = routine.runs.iter().find(|run| run.id == "flow-14").unwrap();
        (routine.flow.as_ref().unwrap().waiting, run.flow.as_ref().unwrap().status, run.flow.as_ref().unwrap().state["pr"].receipt.clone())
    });
    assert_eq!(waiting, 1);
    assert_eq!(status, FlowStatus::Running);
    assert!(receipt.is_some());
    assert!(!has(cx, "flow-approval"));
    // The step it opens on is still the pull request's: now with its receipt.
    view.update(cx, |view, cx| view.flow_select_run_step("pr", cx));
    cx.run_until_parked();
    assert!(has(cx, "flow-receipt") && has(cx, "flow-decision") && has(cx, "flow-receipt-open"));
}

#[gpui::test]
fn reject_with_a_reason_ends_the_run(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-15", cx));
    cx.run_until_parked();
    assert!(has(cx, "flow-approval-message"), "an Ask shows its message");
    click(cx, "flow-reject-start");
    assert!(has(cx, "flow-reject") && has(cx, "flow-reject-cancel"));
    let inspector = view.read_with(cx, |view, _| view.flow_state().unwrap().run_inspector.clone().unwrap());
    inspector.update_in(cx, |inspector, window, cx| inspector.set_reason("Too big for today", window, cx));
    click(cx, "flow-reject");
    cx.run_until_parked();
    let (status, error) = view.read_with(cx, |view, _| {
        let run = view.routine("rt-review").unwrap().runs.iter().find(|run| run.id == "flow-15").cloned().unwrap();
        (run.flow.unwrap().status, run.error)
    });
    assert_eq!(status, FlowStatus::Ended);
    assert_eq!(error.as_deref(), Some("approval rejected: Too big for today"));
    assert_eq!(view.read_with(cx, |view, _| view.routine("rt-review").unwrap().flow.as_ref().unwrap().waiting), 1);
}

#[gpui::test]
fn a_run_that_stopped_shows_its_tries_and_retry_with_a_note(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-13", cx));
    cx.run_until_parked();
    for selector in ["flow-failed", "flow-try-1", "flow-try-2", "flow-retry", "flow-open-last-chat", "flow-run-status-failed"] {
        assert!(has(cx, selector), "{selector}");
    }
    // The first click opens the note, the second retries.
    click(cx, "flow-retry");
    assert!(has(cx, "flow-retry-note"));
    click(cx, "flow-retry");
    cx.run_until_parked();
    let status = view.read_with(cx, |view, _| {
        view.routine("rt-review").unwrap().runs.iter().find(|run| run.id == "flow-13").unwrap().flow.as_ref().unwrap().status
    });
    assert_eq!(status, FlowStatus::Running);
    assert!(!has(cx, "flow-failed"));
}

#[gpui::test]
fn pause_resume_and_end_work_on_the_run_shown(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-16", cx));
    cx.run_until_parked();
    assert!(has(cx, "flow-pause") && has(cx, "flow-end"));
    assert!(!has(cx, "flow-publish"), "the toolbar is the Run's while showing one");
    click(cx, "flow-pause");
    assert!(has(cx, "flow-resume") && !has(cx, "flow-pause"));
    assert!(has(cx, "flow-run-status-paused"));
    click(cx, "flow-resume");
    click(cx, "flow-end");
    assert!(has(cx, "flow-end-dialog"));
    click(cx, "flow-end-confirm");
    let status = view.read_with(cx, |view, _| {
        view.routine("rt-review").unwrap().runs.iter().find(|run| run.id == "flow-16").unwrap().flow.as_ref().unwrap().status
    });
    assert_eq!(status, FlowStatus::Ended);
    assert!(!has(cx, "flow-end"));
}

#[gpui::test]
fn a_test_run_joins_the_runs_and_is_shown(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    let before = view.read_with(cx, |view, _| view.routine("rt-review").unwrap().runs.len());
    click(cx, "flow-test");
    let (after, mode, run) = view.read_with(cx, |view, _| {
        (view.routine("rt-review").unwrap().runs.len(), view.flow_state().unwrap().mode, view.flow_state().unwrap().run_id.clone())
    });
    assert_eq!(after, before + 1);
    assert_eq!(mode, Mode::Run);
    assert!(run.is_some_and(|run| run.starts_with("flow-test-")));
    assert!(has(cx, "flow-run-status-done"));
    // A dry run has no Chat to open, and its trigger says it simulates.
    assert!(has(cx, "flow-run-bar"));
}

#[gpui::test]
fn the_runs_tab_lists_the_runs_and_a_flow_run_opens_its_run_view(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-tab-runs");
    assert!(has(cx, "routine-run-list"));
    assert!(has(cx, "routine-run-flow-14"));
    click(cx, "routine-run-flow-14");
    let (tab, mode, run) = view.read_with(cx, |view, _| {
        let flow = view.flow_state().unwrap();
        (flow.tab, flow.mode, flow.run_id.clone())
    });
    assert_eq!((tab, mode, run.as_deref()), (Tab::Steps, Mode::Run, Some("flow-14")));
}

#[gpui::test]
fn the_page_is_where_it_was_left_when_you_come_back(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-13", cx));
    click(cx, "routine-back");
    open(&view, cx, "rt-review");
    let (mode, run) = view.read_with(cx, |view, _| (view.flow_state().unwrap().mode, view.flow_state().unwrap().run_id.clone()));
    assert_eq!((mode, run.as_deref()), (Mode::Run, Some("flow-13")));
}

#[gpui::test]
fn the_toggle_turns_a_published_flow_off_and_a_new_one_cannot_be_turned_on(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-revision-on");
    assert!(!view.read_with(cx, |view, _| view.routine("rt-review").unwrap().enabled));
    assert!(has(cx, "flow-revision-off"));
    open(&view, cx, "rt-flow");
    assert!(!view.read_with(cx, |view, _| view.routine("rt-flow").unwrap().enabled));
    click(cx, "flow-revision-off");
    assert!(!view.read_with(cx, |view, _| view.routine("rt-flow").unwrap().enabled), "not published, so no switch");
}

#[gpui::test]
fn the_list_row_shows_the_published_revision_and_the_waiting_runs(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    let (revision, waiting) = view.read_with(cx, |view, _| {
        let info = view.routine("rt-review").unwrap().flow.clone().unwrap();
        (info.revision, info.waiting)
    });
    assert_eq!((revision, waiting), (3, 2));
    assert!(has(cx, "routine-row-rt-review"));
}

#[gpui::test]
fn a_run_chat_narrows_the_flow_page(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    view.update(cx, |view, cx| view.flow_show_run("flow-14", cx));
    cx.run_until_parked();
    let wide = cx.debug_bounds("flow-page").expect("page").size.width;
    view.update_in(cx, |view, window, cx| view.flow_open_chat("/Users/victor/Code/personal/happiergym#flow-14", window, cx));
    cx.run_until_parked();
    assert!(has(cx, "run-chat-pane"));
    let narrow = cx.debug_bounds("flow-page").expect("page").size.width;
    assert!(narrow < wide, "{narrow:?} < {wide:?}");
}

#[gpui::test]
fn typing_braces_in_a_prompt_lists_the_fields_the_step_can_read(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx);
    open(&view, cx, "rt-review");
    click(cx, "flow-step-implement");
    let inspector = view.read_with(cx, |view, _| view.flow_state().unwrap().inspector.clone().unwrap());
    let prompt = inspector.read_with(cx, |inspector, _| inspector.text_field("prompt")).expect("prompt");
    prompt.update_in(cx, |text, window, cx| text.type_text("Fix {{classify.", window, cx));
    cx.run_until_parked();
    assert_eq!(prompt.read_with(cx, |text, _| text.listed()), ["classify.complexity", "classify.area"]);
    assert!(has(cx, "flow-placeholders"));
    assert!(has(cx, "flow-placeholder-classify.area"));
    // Insert field lists them all, under the step that gives them.
    click(cx, "implement-prompt-insert-trigger");
    assert!(has(cx, "flow-field-trigger.issue.key") && has(cx, "flow-field-classify.complexity"));
    assert!(!has(cx, "flow-field-review.verdict"), "a later step's field is not offered");
}
