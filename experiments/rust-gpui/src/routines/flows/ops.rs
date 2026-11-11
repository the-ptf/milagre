//! `packages/shared/src/routine-flows.mjs` in Rust: the step types and limits, the tree edits (insert, remove, replace,
//! move), what each step can read, the checks a flow must pass to publish, the words steps and Runs are described in,
//! what a draft changes, and a Run's rows. The running side (fill a template, test an If, check an agent's output) is
//! the daemon's, ported here so the vectors in `routine-flows.test.mjs` run against the same rules.

use std::collections::HashSet;

use super::types::*;
use crate::data::Millis;

pub const MAX_STEPS: usize = 40;
pub const MAX_DEPTH: usize = 3;
pub const MAX_NAME: usize = 60;
pub const MAX_PROMPT: usize = 4000;
pub const MAX_TEXT: usize = 2000;
pub const MAX_FIELDS: usize = 12;
pub const MAX_CHOICES: usize = 12;
pub const MAX_ASK_HOURS: u32 = 168;
pub const MAX_WAIT_MINUTES: u32 = 10080;
pub const MAX_TIMEOUT_HOURS: u32 = 168;
pub const MAX_RETRIES: u32 = 5;

/// The words for a step type: the Add step menu's name, a tile's name and what it does.
#[derive(Clone, Copy, Debug)]
pub struct StepType {
    pub kind: StepKind,
    pub name: &'static str,
    pub short: &'static str,
    pub description: &'static str,
}

/// `FLOW_STEP_TYPES`, in the order the Add step menu lists them.
pub const STEP_TYPES: [StepType; 6] = [
    StepType {
        kind: StepKind::Agent,
        name: "Ask an agent",
        short: "Ask an agent",
        description: "A turn in a Chat that returns fields you define",
    },
    StepType { kind: StepKind::If, name: "If", short: "If", description: "Pick a path from a field of an earlier step" },
    StepType { kind: StepKind::Ask, name: "Ask me", short: "Ask me", description: "Waits for your approval on any device" },
    StepType { kind: StepKind::Wait, name: "Wait for", short: "Wait for", description: "A Linear state, a PR review or a time" },
    StepType {
        kind: StepKind::PullRequest,
        name: "Open pull request",
        short: "Open PR",
        description: "Asks first, keeps a receipt, never opens twice",
    },
    StepType { kind: StepKind::LinearComment, name: "Comment on Linear", short: "Comment", description: "Posts to the issue once per Run" },
];

pub fn step_type(kind: StepKind) -> StepType {
    STEP_TYPES.into_iter().find(|ty| ty.kind == kind).expect("every kind has a type")
}

/// A field a step can read, as `{{ref}}` in its texts or an If's field.
#[derive(Clone, Debug, PartialEq)]
pub struct Readable {
    pub ref_: String,
    pub label: String,
    pub ty: FieldType,
    pub choices: Vec<String>,
    /// The step that gives it, "Trigger" for the trigger's.
    pub step_name: String,
}

/// What the trigger gives every step: `(path, type, label)`.
fn trigger_table(kind: TriggerKind) -> &'static [(&'static str, FieldType, &'static str)] {
    use FieldType::{Link, Text};
    match kind {
        TriggerKind::Linear => &[
            ("issue.key", Text, "issue.key"),
            ("issue.title", Text, "issue.title"),
            ("issue.description", Text, "issue.body"),
            ("issue.url", Link, "issue.url"),
            ("issue.labels", Text, "issue.labels"),
            ("issue.state", Text, "issue.state"),
            ("issue.team", Text, "issue.team"),
            ("comment.body", Text, "comment.body"),
            ("comment.author", Text, "comment.author"),
        ],
        TriggerKind::Webhook => &[("delivery.id", Text, "delivery.id")],
        TriggerKind::Schedule => &[("time", Text, "time")],
        TriggerKind::PullRequest => &[],
    }
}

/// The trigger's fields as refs a step can read (`triggerFields`).
pub fn trigger_fields(kind: TriggerKind) -> Vec<Readable> {
    trigger_table(kind)
        .iter()
        .map(|(path, ty, label)| Readable {
            ref_: format!("trigger.{path}"),
            label: (*label).to_string(),
            ty: *ty,
            choices: Vec::new(),
            step_name: "Trigger".into(),
        })
        .collect()
}

fn is_step_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn is_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && name.len() <= 40 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A step id made from `name` that no step in `steps` has: "classify", then "classify-2" (`newStepId`).
pub fn new_step_id(steps: &[FlowStep], name: &str) -> String {
    let taken: HashSet<String> = flatten(steps).into_iter().map(|entry| entry.step.id.clone()).collect();
    let mut base = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base = base.trim_matches('-').trim_start_matches(|c: char| !c.is_ascii_lowercase()).to_string();
    let base: String = base.chars().take(32).collect();
    let base = if base.is_empty() { "step".to_string() } else { base };
    if !taken.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|id| !taken.contains(id)).expect("an unused id")
}

/// A new step of `kind` with the defaults the editor starts from (`newStep`).
pub fn new_step(kind: StepKind, steps: &[FlowStep]) -> FlowStep {
    let (name, id_from, body) = match kind {
        StepKind::Agent => (
            "Ask an agent",
            "agent",
            StepBody::Agent(AgentStep {
                prompt: String::new(),
                provider: None,
                model: None,
                effort: None,
                permission_mode: None,
                chat: ChatUse::Run,
                output: Vec::new(),
                retries: 1,
                on_invalid: OnInvalid::AskOnce,
            }),
        ),
        StepKind::If => (
            "If",
            "if",
            StepBody::If(IfStep {
                field: String::new(),
                test: Test::Is,
                value: Some(String::new()),
                yes: Vec::new(),
                otherwise: Vec::new(),
            }),
        ),
        StepKind::Ask => {
            ("Ask before going on", "Ask before going on", StepBody::Ask(AskStep { message: String::new(), expires_in_hours: 24 }))
        }
        StepKind::Wait => ("Wait", "Wait", StepBody::Wait(WaitStep { until: Until::Time { minutes: 60 }, timeout_hours: 24 })),
        StepKind::PullRequest => (
            "Open pull request",
            "Open pull request",
            StepBody::PullRequest(PullRequestStep {
                title: "{{trigger.issue.key}} {{trigger.issue.title}}".into(),
                body: String::new(),
                base: None,
                draft: true,
                ask_first: true,
            }),
        ),
        StepKind::LinearComment => ("Comment on Linear", "Comment on Linear", StepBody::LinearComment(CommentStep { body: String::new() })),
    };
    FlowStep { id: new_step_id(steps, id_from), name: name.to_string(), body }
}

// ----- the tree -----

/// A step with where it sits (`flattenSteps`): `depth` (0 at the top), the If it is under and which path, and its
/// `index` in that list.
#[derive(Clone, Copy, Debug)]
pub struct Flat<'a> {
    pub step: &'a FlowStep,
    pub depth: usize,
    pub parent_id: Option<&'a str>,
    pub branch: Option<Branch>,
    pub index: usize,
}

/// Every step in run order.
pub fn flatten(steps: &[FlowStep]) -> Vec<Flat<'_>> {
    fn walk<'a>(steps: &'a [FlowStep], depth: usize, parent: Option<&'a str>, branch: Option<Branch>, out: &mut Vec<Flat<'a>>) {
        for (index, step) in steps.iter().enumerate() {
            out.push(Flat { step, depth, parent_id: parent, branch, index });
            if let StepBody::If(branching) = &step.body {
                walk(&branching.yes, depth + 1, Some(&step.id), Some(Branch::Yes), out);
                walk(&branching.otherwise, depth + 1, Some(&step.id), Some(Branch::Otherwise), out);
            }
        }
    }
    let mut out = Vec::new();
    walk(steps, 0, None, None, &mut out);
    out
}

/// The step with `id`, if any.
pub fn find_step<'a>(steps: &'a [FlowStep], id: &str) -> Option<&'a FlowStep> {
    flatten(steps).into_iter().find(|entry| entry.step.id == id).map(|entry| entry.step)
}

type Edit<'a> = &'a mut dyn FnMut(Vec<FlowStep>, Option<&str>, Option<Branch>) -> Vec<FlowStep>;

// Rebuilds the tree with `edit(list, parentId, branch)` applied to every list (the top one too), deepest first.
fn map_lists(steps: &[FlowStep], edit: Edit<'_>, parent: Option<&str>, branch: Option<Branch>) -> Vec<FlowStep> {
    let mut list = Vec::with_capacity(steps.len());
    for step in steps {
        let mut next = step.clone();
        if let (StepBody::If(from), StepBody::If(to)) = (&step.body, &mut next.body) {
            to.yes = map_lists(&from.yes, &mut *edit, Some(&step.id), Some(Branch::Yes));
            to.otherwise = map_lists(&from.otherwise, &mut *edit, Some(&step.id), Some(Branch::Otherwise));
        }
        list.push(next);
    }
    edit(list, parent, branch)
}

/// Where a step goes: the list under If `parent_id`'s `branch` (the top list when `parent_id` is `None`) and the index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Where {
    pub parent_id: Option<String>,
    pub branch: Option<Branch>,
    pub index: Option<usize>,
}

impl Where {
    pub fn top(index: usize) -> Self {
        Where { parent_id: None, branch: None, index: Some(index) }
    }

    pub fn path(parent: &str, branch: Branch, index: usize) -> Self {
        Where { parent_id: Some(parent.to_string()), branch: Some(branch), index: Some(index) }
    }
}

/// `steps` with `step` put at `where_` (`insertStep`); an error for a place that is not in the flow.
pub fn insert_step(steps: &[FlowStep], where_: &Where, step: FlowStep) -> Result<Vec<FlowStep>, String> {
    let mut placed = false;
    let mut once = Some(step);
    let next = map_lists(
        steps,
        &mut |list, parent, branch| {
            if parent != where_.parent_id.as_deref() || (where_.parent_id.is_some() && branch != where_.branch) {
                return list;
            }
            let Some(step) = once.take() else { return list };
            placed = true;
            let at = where_.index.unwrap_or(list.len()).min(list.len());
            let mut list = list;
            list.insert(at, step);
            list
        },
        None,
        None,
    );
    if placed { Ok(next) } else { Err("No such place in the flow".into()) }
}

/// `steps` without the step `id`, and for an If the steps on its paths (`removeStep`).
pub fn remove_step(steps: &[FlowStep], id: &str) -> Vec<FlowStep> {
    map_lists(steps, &mut |list, _, _| list.into_iter().filter(|step| step.id != id).collect(), None, None)
}

/// `steps` with the step `id` replaced by `next` (`replaceStep`). An If keeps its paths: they change by inserting,
/// moving and removing steps, never by replacing the If.
pub fn replace_step(steps: &[FlowStep], id: &str, next: &FlowStep) -> Vec<FlowStep> {
    map_lists(
        steps,
        &mut |list, _, _| {
            list.into_iter()
                .map(|step| {
                    if step.id != id {
                        return step;
                    }
                    match (&step.body, &next.body) {
                        (StepBody::If(old), StepBody::If(new)) => FlowStep {
                            id: next.id.clone(),
                            name: next.name.clone(),
                            body: StepBody::If(IfStep { yes: old.yes.clone(), otherwise: old.otherwise.clone(), ..new.clone() }),
                        },
                        _ => next.clone(),
                    }
                })
                .collect()
        },
        None,
        None,
    )
}

/// `steps` with step `id` moved one place up (-1) or down (+1) within its list; unchanged at an end (`moveStep`).
pub fn move_step(steps: &[FlowStep], id: &str, by: i32) -> Vec<FlowStep> {
    map_lists(
        steps,
        &mut |mut list, _, _| {
            let Some(at) = list.iter().position(|step| step.id == id) else { return list };
            let to = at as i64 + i64::from(by);
            if to < 0 || to >= list.len() as i64 {
                return list;
            }
            list.swap(at, to as usize);
            list
        },
        None,
        None,
    )
}

// The steps that have run by the time step `id` starts, on any path that reaches it: the earlier steps of its list, and of
// every list above it (an If's paths come after the If itself, so the If's own earlier steps count, its other path not).
fn steps_before<'a>(steps: &'a [FlowStep], id: &str) -> Vec<&'a FlowStep> {
    fn search<'a>(list: &'a [FlowStep], id: &str, before: &mut Vec<&'a FlowStep>) -> bool {
        for step in list {
            if step.id == id {
                return true;
            }
            if let StepBody::If(branching) = &step.body {
                let mark = before.len();
                before.push(step);
                if search(&branching.yes, id, before) {
                    return true;
                }
                before.truncate(mark + 1);
                if search(&branching.otherwise, id, before) {
                    return true;
                }
                before.truncate(mark);
                // A path's steps may not have run, so only the If is known to have: a step after it can't read them.
            }
            before.push(step);
        }
        false
    }
    let mut before = Vec::new();
    search(steps, id, &mut before);
    before
}

/// The fields step `id` can read: the trigger's, then each earlier agent step's outputs, then an earlier pull request's
/// url. With no `id`, every agent step's fields (`fieldsBefore`).
pub fn fields_before(steps: &[FlowStep], id: Option<&str>, trigger: TriggerKind) -> Vec<Readable> {
    let earlier: Vec<&FlowStep> = match id {
        Some(id) => steps_before(steps, id),
        None => flatten(steps).into_iter().map(|entry| entry.step).collect(),
    };
    let mut fields = trigger_fields(trigger);
    for step in &earlier {
        if let StepBody::Agent(agent) = &step.body {
            for field in &agent.output {
                fields.push(Readable {
                    ref_: format!("{}.{}", step.id, field.name),
                    label: field.name.clone(),
                    ty: field.ty,
                    choices: field.choices.clone(),
                    step_name: step.name.clone(),
                });
            }
        }
    }
    for step in &earlier {
        if step.kind() == StepKind::PullRequest {
            fields.push(Readable {
                ref_: format!("{}.url", step.id),
                label: "url".into(),
                ty: FieldType::Link,
                choices: Vec::new(),
                step_name: step.name.clone(),
            });
        }
    }
    fields
}

/// The refs a text reads as `{{ref}}`, each once, in order (`placeholders`).
pub fn placeholders(text: &str) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    for found in scan_placeholders(text) {
        if !refs.contains(&found.name) {
            refs.push(found.name);
        }
    }
    refs
}

struct Found {
    start: usize,
    end: usize,
    name: String,
}

// `{{\s*([a-zA-Z][\w.-]*)\s*}}`, scanned by hand.
fn scan_placeholders(text: &str) -> Vec<Found> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at + 1 < bytes.len() {
        if bytes[at] != b'{' || bytes[at + 1] != b'{' {
            at += 1;
            continue;
        }
        let mut i = at + 2;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let name_start = i;
        if i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'.' | b'-')) {
                i += 1;
            }
            let name_end = i;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i + 1 < bytes.len() && bytes[i] == b'}' && bytes[i + 1] == b'}' {
                found.push(Found { start: at, end: i + 2, name: text[name_start..name_end].to_string() });
                at = i + 2;
                continue;
            }
        }
        at += 1;
    }
    found
}

/// What a step reads: the refs in its texts and, for an If, its field (`stepReads`).
pub fn step_reads(step: &FlowStep) -> Vec<String> {
    match &step.body {
        StepBody::Agent(agent) => placeholders(&agent.prompt),
        StepBody::If(branching) => {
            if branching.field.is_empty() {
                Vec::new()
            } else {
                vec![branching.field.clone()]
            }
        }
        StepBody::Ask(ask) => placeholders(&ask.message),
        StepBody::PullRequest(pr) => {
            let mut refs = placeholders(&pr.title);
            for found in placeholders(&pr.body) {
                if !refs.contains(&found) {
                    refs.push(found);
                }
            }
            refs
        }
        StepBody::LinearComment(comment) => placeholders(&comment.body),
        StepBody::Wait(_) => Vec::new(),
    }
}

/// How many steps read `ref_` (`usedBy`).
pub fn used_by(steps: &[FlowStep], ref_: &str) -> usize {
    flatten(steps).into_iter().filter(|entry| step_reads(entry.step).iter().any(|read| read == ref_)).count()
}

// ----- checking -----

fn clean_field(field: &FlowField, where_: &str) -> Result<FlowField, String> {
    let name = field.name.trim().to_string();
    if !is_field_name(&name) {
        return Err(format!("{where_}: \"{name}\" isn't a field name (letters, digits and _; a letter first)"));
    }
    let mut clean = FlowField::new(name.clone(), field.ty);
    if field.ty == FieldType::Choice {
        let mut choices: Vec<String> = Vec::new();
        for choice in field.choices.iter().map(|choice| choice.trim()).filter(|choice| !choice.is_empty()) {
            if !choices.iter().any(|seen| seen == choice) {
                choices.push(choice.to_string());
            }
        }
        if choices.len() < 2 {
            return Err(format!("{where_}: field {name} needs at least two choices"));
        }
        if choices.len() > MAX_CHOICES {
            return Err(format!("{where_}: field {name} has too many choices"));
        }
        clean.choices = choices;
    }
    clean.description =
        field.description.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(|d| d.chars().take(200).collect::<String>());
    Ok(clean)
}

fn bounded(value: u32, min: u32, max: u32, where_: &str, label: &str) -> Result<u32, String> {
    if value < min || value > max {
        return Err(format!("{where_}: {label} must be a whole number from {min} to {max}"));
    }
    Ok(value)
}

fn clean_text(value: &str, max: usize, where_: &str, label: &str, required: bool) -> Result<String, String> {
    if required && value.trim().is_empty() {
        return Err(format!("{where_}: add {label}"));
    }
    if value.chars().count() > max {
        return Err(format!("{where_}: {label} is too long"));
    }
    Ok(value.to_string())
}

fn clean_step(step: &FlowStep, depth: usize) -> Result<FlowStep, String> {
    let id = step.id.as_str();
    if id == "trigger" {
        return Err("\"trigger\" is reserved for the flow input".into());
    }
    if !is_step_id(id) {
        return Err(format!("\"{id}\" isn't a step id (lowercase letters, digits and -)"));
    }
    let name = step.name.trim().to_string();
    if name.is_empty() {
        return Err(format!("Step {id}: add a name"));
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("Step {id}: the name is too long"));
    }
    let where_ = format!("Step \"{name}\"");
    let body = match &step.body {
        StepBody::Agent(agent) => {
            let prompt = clean_text(&agent.prompt, MAX_PROMPT, &where_, "a prompt", true)?;
            let output: Result<Vec<FlowField>, String> = agent.output.iter().map(|field| clean_field(field, &where_)).collect();
            let output = output?;
            if output.len() > MAX_FIELDS {
                return Err(format!("{where_}: too many output fields"));
            }
            let names: HashSet<&str> = output.iter().map(|field| field.name.as_str()).collect();
            if names.len() != output.len() {
                return Err(format!("{where_}: two output fields have the same name"));
            }
            let retries = bounded(agent.retries, 0, MAX_RETRIES, &where_, "retries")?;
            StepBody::Agent(AgentStep { prompt, output, retries, ..agent.clone() })
        }
        StepBody::If(branching) => {
            if depth >= MAX_DEPTH {
                return Err(format!("{where_}: Ifs nest {MAX_DEPTH} deep at most"));
            }
            let field = branching.field.trim().to_string();
            if field.is_empty() {
                return Err(format!("{where_}: choose a field to test"));
            }
            let value = if branching.test == Test::IsSet {
                None
            } else {
                Some(clean_text(branching.value.as_deref().unwrap_or(""), 200, &where_, "a value", true)?)
            };
            StepBody::If(IfStep {
                field,
                test: branching.test,
                value,
                yes: clean_steps(&branching.yes, depth + 1)?,
                otherwise: clean_steps(&branching.otherwise, depth + 1)?,
            })
        }
        StepBody::Ask(ask) => StepBody::Ask(AskStep {
            message: clean_text(&ask.message, MAX_TEXT, &where_, "a message", false)?,
            expires_in_hours: bounded(ask.expires_in_hours, 1, MAX_ASK_HOURS, &where_, "the time limit")?,
        }),
        StepBody::Wait(wait) => {
            let until = match &wait.until {
                Until::Time { minutes } => Until::Time { minutes: bounded(*minutes, 1, MAX_WAIT_MINUTES, &where_, "minutes")? },
                Until::LinearState { state } => {
                    Until::LinearState { state: clean_text(state, 80, &where_, "a state", true)?.trim().to_string() }
                }
                Until::PrReview => Until::PrReview,
            };
            StepBody::Wait(WaitStep { until, timeout_hours: bounded(wait.timeout_hours, 1, MAX_TIMEOUT_HOURS, &where_, "the time limit")? })
        }
        StepBody::PullRequest(pr) => StepBody::PullRequest(PullRequestStep {
            title: clean_text(&pr.title, 300, &where_, "a title", true)?,
            body: clean_text(&pr.body, MAX_TEXT, &where_, "a description", false)?,
            base: pr.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string),
            draft: pr.draft,
            ask_first: pr.ask_first,
        }),
        StepBody::LinearComment(comment) => {
            StepBody::LinearComment(CommentStep { body: clean_text(&comment.body, MAX_TEXT, &where_, "the comment", true)? })
        }
    };
    Ok(FlowStep { id: step.id.clone(), name, body })
}

fn clean_steps(steps: &[FlowStep], depth: usize) -> Result<Vec<FlowStep>, String> {
    steps.iter().map(|step| clean_step(step, depth)).collect()
}

/// The flow's steps checked and cleaned, or the first problem: the shape of each step, then what the flow as a whole
/// needs (unique ids, at most 40 steps, every `{{ref}}` and If field readable where it is used, Linear steps only under
/// a Linear trigger, a review wait only after a pull request) (`checkFlowSteps`).
pub fn check_flow_steps(steps: &[FlowStep], trigger: TriggerKind) -> Result<Vec<FlowStep>, String> {
    let clean = clean_steps(steps, 0)?;
    match flow_problems(&clean, trigger).into_iter().next() {
        Some(problem) => Err(problem.message),
        None => Ok(clean),
    }
}

/// A problem with a flow: the step it is about (none for the flow as a whole) and what is wrong.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub step_id: Option<String>,
    pub message: String,
}

/// Every problem with a flow; empty when it can run (`flowProblems`).
pub fn flow_problems(steps: &[FlowStep], trigger: TriggerKind) -> Vec<Problem> {
    let mut problems = Vec::new();
    let mut add = |step_id: Option<&str>, message: String| problems.push(Problem { step_id: step_id.map(str::to_string), message });
    let all = flatten(steps);
    if all.is_empty() {
        add(None, "Add at least one step".into());
    }
    if all.len() > MAX_STEPS {
        add(None, format!("A flow has {MAX_STEPS} steps at most"));
    }
    let mut seen = HashSet::new();
    for entry in &all {
        if !seen.insert(entry.step.id.as_str()) {
            add(Some(&entry.step.id), format!("Two steps have the id {}", entry.step.id));
        }
    }
    for entry in &all {
        let step = entry.step;
        let readable: HashSet<String> = fields_before(steps, Some(&step.id), trigger).into_iter().map(|field| field.ref_).collect();
        for read in step_reads(step) {
            if !readable.contains(&read) {
                add(Some(&step.id), format!("\"{}\" reads {read}, which no earlier step gives", step.name));
            }
        }
        match &step.body {
            StepBody::Agent(agent) if agent.prompt.trim().is_empty() => add(Some(&step.id), format!("\"{}\" needs a prompt", step.name)),
            StepBody::If(branching) if branching.field.is_empty() => {
                add(Some(&step.id), format!("\"{}\" needs a field to test", step.name));
            }
            _ => {}
        }
        let needs_issue = match &step.body {
            StepBody::LinearComment(_) => true,
            StepBody::Wait(wait) => matches!(wait.until, Until::LinearState { .. }),
            _ => false,
        };
        if needs_issue && trigger != TriggerKind::Linear {
            add(Some(&step.id), format!("\"{}\" needs a Linear trigger", step.name));
        }
        if let StepBody::Wait(WaitStep { until: Until::PrReview, .. }) = &step.body
            && !steps_before(steps, &step.id).iter().any(|earlier| earlier.kind() == StepKind::PullRequest)
        {
            add(Some(&step.id), format!("\"{}\" waits for a review, so a pull request must come first", step.name));
        }
    }
    problems
}

/// A draft as saved while it is edited: at most 40 steps, three Ifs deep, and nothing else checked (a step may still lack
/// its prompt). Publishing runs `check_flow_steps` (`checkDraftSteps`).
pub fn check_draft_steps(steps: &[FlowStep]) -> Result<Vec<FlowStep>, String> {
    fn visit(list: &[FlowStep], depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(format!("Ifs nest {MAX_DEPTH} deep at most"));
        }
        for step in list {
            if !is_step_id(&step.id) {
                return Err("A step is missing its id or type".into());
            }
            if let StepBody::If(branching) = &step.body {
                visit(&branching.yes, depth + 1)?;
                visit(&branching.otherwise, depth + 1)?;
            }
        }
        Ok(())
    }
    visit(steps, 0)?;
    if flatten(steps).len() > MAX_STEPS {
        return Err(format!("A flow has {MAX_STEPS} steps at most"));
    }
    Ok(steps.to_vec())
}

// ----- running -----

/// `value` read through a dotted path (`readRef`); `None` for a part that is not there.
pub fn read_ref<'a>(values: &'a Value, ref_: &str) -> Option<&'a Value> {
    let mut current = values;
    for part in ref_.split('.') {
        let Value::Object(entries) = current else { return None };
        current = &entries.iter().find(|(key, _)| key == part)?.1;
    }
    Some(current)
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(on) => on.to_string(),
        Value::Num(n) => n.to_string(),
        Value::Text(text) => text.clone(),
        Value::Object(entries) => {
            let inner: Vec<String> = entries.iter().map(|(key, value)| format!("\"{key}\":{}", json_value(value))).collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

fn json_value(value: &Value) -> String {
    match value {
        Value::Text(text) => format!("\"{text}\""),
        Value::Null => "null".into(),
        other => value_text(other),
    }
}

/// `text` with every `{{ref}}` replaced by what it reads; a ref with nothing to read becomes empty (`fillTemplate`).
pub fn fill_template(text: &str, values: &Value) -> String {
    let mut out = String::new();
    let mut at = 0;
    for found in scan_placeholders(text) {
        out.push_str(&text[at..found.start]);
        if let Some(value) = read_ref(values, &found.name) {
            out.push_str(&value_text(value));
        }
        at = found.end;
    }
    out.push_str(&text[at..]);
    out
}

/// Whether an If's test holds for `values` (`testCondition`).
pub fn test_condition(field: &str, test: Test, value: &str, values: &Value) -> bool {
    let found = read_ref(values, field);
    if test == Test::IsSet {
        return match found {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::Text(text)) => !text.is_empty(),
            Some(_) => true,
        };
    }
    let actual = found.map(value_text).unwrap_or_default().trim().to_lowercase();
    let expected = value.trim().to_lowercase();
    if test == Test::Contains {
        return actual.contains(&expected);
    }
    // A list of choices ("small, medium") in the value means any of them.
    let options: Vec<&str> =
        expected.split(',').flat_map(|part| part.split(" or ")).map(str::trim).filter(|part| !part.is_empty()).collect();
    let matches = if options.len() > 1 { options.contains(&actual.as_str()) } else { actual == expected };
    if test == Test::Is { matches } else { !matches }
}

/// `value` checked against an agent step's fields: each in its type, or what to fix, for the agent to read
/// (`checkOutput`).
pub fn check_output(fields: &[FlowField], value: &Value) -> Result<Vec<(String, Value)>, String> {
    let Value::Object(entries) = value else { return Err("Send the fields as an object".into()) };
    let mut output = Vec::new();
    let mut errors = Vec::new();
    for field in fields {
        let raw = entries.iter().find(|(key, _)| key == &field.name).map(|(_, value)| value);
        let raw = match raw {
            None | Some(Value::Null) => {
                errors.push(format!("{} is missing", field.name));
                continue;
            }
            Some(Value::Text(text)) if text.is_empty() => {
                errors.push(format!("{} is missing", field.name));
                continue;
            }
            Some(raw) => raw,
        };
        let text = value_text(raw);
        let trimmed = text.trim();
        match field.ty {
            FieldType::Choice => match field.choices.iter().find(|choice| choice.to_lowercase() == trimmed.to_lowercase()) {
                Some(choice) => output.push((field.name.clone(), Value::Text(choice.clone()))),
                None => errors.push(format!("{} must be one of {}", field.name, field.choices.join(", "))),
            },
            FieldType::YesNo => {
                if let Value::Bool(on) = raw {
                    output.push((field.name.clone(), Value::Bool(*on)));
                } else if trimmed.eq_ignore_ascii_case("yes") || trimmed.eq_ignore_ascii_case("true") {
                    output.push((field.name.clone(), Value::Bool(true)));
                } else if trimmed.eq_ignore_ascii_case("no") || trimmed.eq_ignore_ascii_case("false") {
                    output.push((field.name.clone(), Value::Bool(false)));
                } else {
                    errors.push(format!("{} must be yes or no", field.name));
                }
            }
            FieldType::Number => match trimmed.parse::<f64>() {
                Ok(number) if number.is_finite() => output.push((field.name.clone(), Value::Num(number))),
                _ => errors.push(format!("{} must be a number", field.name)),
            },
            FieldType::Link => {
                let link = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("http://"));
                if link.is_some_and(|rest| !rest.is_empty() && !rest.contains(char::is_whitespace)) {
                    output.push((field.name.clone(), Value::Text(trimmed.to_string())));
                } else {
                    errors.push(format!("{} must be an http(s) link", field.name));
                }
            }
            FieldType::Text => output.push((field.name.clone(), Value::Text(text.chars().take(4000).collect()))),
        }
    }
    if errors.is_empty() { Ok(output) } else { Err(errors.join("; ")) }
}

/// The lines appended to an agent step's prompt telling it how to hand its output back (`outputInstructions`).
pub fn output_instructions(fields: &[FlowField]) -> String {
    if fields.is_empty() {
        return "When you are done, call the flow_step_output tool once with an empty object.".into();
    }
    let mut lines = vec!["When you are done, call the flow_step_output tool once with these fields:".to_string()];
    for field in fields {
        let kind = match field.ty {
            FieldType::Choice => format!("one of {}", field.choices.join(", ")),
            FieldType::YesNo => "yes or no".into(),
            FieldType::Number => "a number".into(),
            FieldType::Link => "an http(s) link".into(),
            FieldType::Text => "text".into(),
        };
        let description = field.description.as_ref().map_or(String::new(), |d| format!(" ({d})"));
        lines.push(format!("- {}: {kind}{description}", field.name));
    }
    lines.join("\n")
}

/// Short text for a step's output: "complexity large, area relay" (`outputSummary`).
pub fn output_summary(output: &[(String, Value)]) -> String {
    output
        .iter()
        .filter(|(_, value)| !matches!(value, Value::Text(text) if text.chars().count() > 40))
        .take(3)
        .map(|(key, value)| match value {
            Value::Bool(on) => format!("{key} {}", if *on { "yes" } else { "no" }),
            other => format!("{key} {}", value_text(other)),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ----- words -----

/// An If's question: "If complexity is large" (`conditionText`).
pub fn condition_text(step: &IfStep) -> String {
    let field = step.field.rsplit('.').next().filter(|part| !part.is_empty()).unwrap_or("\u{2026}");
    if step.test == Test::IsSet {
        return format!("If {field} is set");
    }
    let value = step.value.as_deref().filter(|v| !v.is_empty()).unwrap_or("\u{2026}");
    format!("If {field} {} {value}", step.test.words())
}

/// "45 min", "2 h", "1 h 30 min", "3 d" (`durationText`).
pub fn duration_text(minutes: u32) -> String {
    if minutes < 60 {
        return format!("{minutes} min");
    }
    if minutes.is_multiple_of(1440) {
        return format!("{} d", minutes / 1440);
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest > 0 { format!("{hours} h {rest} min") } else { format!("{hours} h") }
}

/// A step's title in lists: an If reads as its question (`stepTitle`).
pub fn step_title(step: &FlowStep) -> String {
    match &step.body {
        StepBody::If(branching) if step.name == "If" || step.name.is_empty() => condition_text(branching),
        _ => step.name.clone(),
    }
}

/// The second line under a step's name in the editor (`stepSubtitle`). `model_name` names a model.
pub fn step_subtitle(step: &FlowStep, model_name: &dyn Fn(Option<crate::data::Provider>, &str) -> String) -> String {
    match &step.body {
        StepBody::Agent(agent) => {
            let mut parts = vec!["Agent".to_string()];
            if let Some(model) = agent.model.as_deref().filter(|m| !m.is_empty()) {
                parts.push(model_name(agent.provider, model));
            }
            match agent.permission_mode.as_deref() {
                Some("auto") => parts.push("Auto mode".into()),
                Some("full") => parts.push("Full permission".into()),
                Some("ask") => parts.push("asks approval".into()),
                _ => {}
            }
            parts.push(if agent.chat == ChatUse::Own { "its own Chat".into() } else { "Run Chat".into() });
            parts.join(", ")
        }
        StepBody::If(branching) => format!("Condition, reads {}", if branching.field.is_empty() { "a field" } else { &branching.field }),
        StepBody::Ask(ask) => format!("Approval, {} h to answer, rejected or no answer ends the Run", ask.expires_in_hours),
        StepBody::Wait(wait) => match &wait.until {
            Until::Time { minutes } => format!("Waits {}", duration_text(*minutes)),
            Until::LinearState { state } => format!("Waits until the issue is {state}, up to {} h", wait.timeout_hours),
            Until::PrReview => format!("Waits for a review, up to {} h", wait.timeout_hours),
        },
        StepBody::PullRequest(pr) => [
            "Action",
            if pr.ask_first { "asks first" } else { "opens on its own" },
            if pr.draft { "draft PR" } else { "ready PR" },
            "keeps a receipt",
        ]
        .join(", "),
        StepBody::LinearComment(_) => "Action, posts once per Run".into(),
    }
}

// ----- drafts -----

/// A step's settings as `(key, value)`, in the order the TypeScript's objects list their keys; absent options are left
/// out, as an absent key is.
fn settings(step: &FlowStep) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = vec![("name", step.name.clone())];
    let mut push = |key: &'static str, value: String| out.push((key, value));
    match &step.body {
        StepBody::Agent(agent) => {
            push("prompt", agent.prompt.clone());
            if let Some(provider) = agent.provider {
                push("provider", provider.id().to_string());
            }
            if let Some(model) = &agent.model {
                push("model", model.clone());
            }
            if let Some(effort) = &agent.effort {
                push("effort", effort.clone());
            }
            if let Some(mode) = &agent.permission_mode {
                push("permissionMode", mode.clone());
            }
            push("chat", format!("{:?}", agent.chat));
            push("output", format!("{:?}", agent.output));
            push("retries", agent.retries.to_string());
            push("onInvalid", format!("{:?}", agent.on_invalid));
        }
        StepBody::If(branching) => {
            push("field", branching.field.clone());
            push("test", branching.test.id().to_string());
            if let Some(value) = &branching.value {
                push("value", value.clone());
            }
        }
        StepBody::Ask(ask) => {
            push("message", ask.message.clone());
            push("expiresInHours", ask.expires_in_hours.to_string());
        }
        StepBody::Wait(wait) => {
            push("until", format!("{:?}", wait.until));
            push("timeoutHours", wait.timeout_hours.to_string());
        }
        StepBody::PullRequest(pr) => {
            push("title", pr.title.clone());
            push("body", pr.body.clone());
            if let Some(base) = &pr.base {
                push("base", base.clone());
            }
            push("draft", pr.draft.to_string());
            push("askFirst", pr.ask_first.to_string());
        }
        StepBody::LinearComment(comment) => push("body", comment.body.clone()),
    }
    out
}

fn setting_words(key: &str) -> String {
    match key {
        "prompt" => "prompt changed",
        "output" => "output changed",
        "model" | "provider" => "model changed",
        "effort" => "effort changed",
        "permissionMode" => "permissions changed",
        "chat" => "Chat changed",
        "retries" => "retries changed",
        "onInvalid" => "invalid output rule changed",
        "field" | "test" | "value" => "test changed",
        "message" => "message changed",
        "expiresInHours" | "timeoutHours" => "time limit changed",
        "until" => "wait changed",
        "title" => "title changed",
        "body" => "text changed",
        "base" => "base branch changed",
        "draft" => "draft setting changed",
        "askFirst" => "approval setting changed",
        "name" => "renamed",
        other => return format!("{other} changed"),
    }
    .to_string()
}

/// What a draft changes from the published steps, one line each: "Added Review", "Classify: prompt changed"
/// (`flowChanges`).
pub fn flow_changes(published: &[FlowStep], draft: &[FlowStep]) -> Vec<String> {
    let before = flatten(published);
    let after = flatten(draft);
    let mut lines = Vec::new();
    for entry in &after {
        let Some(old) = before.iter().find(|old| old.step.id == entry.step.id) else {
            lines.push(format!("Added {}", step_title(entry.step)));
            continue;
        };
        let (old_settings, new_settings) = (settings(old.step), settings(entry.step));
        let mut words: Vec<String> = Vec::new();
        let mut keys: Vec<&str> = Vec::new();
        for (key, _) in old_settings.iter().chain(new_settings.iter()) {
            if !keys.contains(key) {
                keys.push(key);
            }
        }
        for key in keys {
            let lookup = |list: &Vec<(&'static str, String)>| list.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone());
            if lookup(&old_settings) != lookup(&new_settings) {
                let word = setting_words(key);
                if !words.contains(&word) {
                    words.push(word);
                }
            }
        }
        if old.parent_id != entry.parent_id || old.branch != entry.branch || old.index != entry.index {
            let moved = "moved".to_string();
            if !words.contains(&moved) {
                words.push(moved);
            }
        }
        for word in words {
            lines.push(format!("{}: {word}", step_title(entry.step)));
        }
    }
    for old in &before {
        if !after.iter().any(|entry| entry.step.id == old.step.id) {
            lines.push(format!("Removed {}", step_title(old.step)));
        }
    }
    lines
}

// ----- a Run's progress -----

/// One row of a Run's steps (`FlowRunRow`): a step with how it went, or the label of an If's path.
#[derive(Clone, Debug)]
pub enum RunRow<'a> {
    Step { step: &'a FlowStep, depth: usize, status: StepStatus, run: Option<&'a StepRun> },
    Path { path: Branch, parent_id: &'a str, depth: usize, taken: bool, decided: bool, empty: bool },
}

/// A flow Run's steps in run order with how each went; a step on the path an If didn't take is `NotTaken`, and a path's
/// label row comes before its steps (`runRows`).
pub fn run_rows(flow: &FlowRun) -> Vec<RunRow<'_>> {
    fn walk<'a>(flow: &'a FlowRun, steps: &'a [FlowStep], depth: usize, off_path: bool, rows: &mut Vec<RunRow<'a>>) {
        for step in steps {
            let run = flow.state.get(&step.id);
            let status = if off_path { StepStatus::NotTaken } else { run.map_or(StepStatus::Pending, |run| run.status) };
            rows.push(RunRow::Step { step, depth, status, run });
            let StepBody::If(branching) = &step.body else { continue };
            let taken = run.and_then(|run| run.taken);
            for path in [Branch::Yes, Branch::Otherwise] {
                let off = off_path || taken.is_some_and(|taken| taken != path);
                rows.push(RunRow::Path {
                    path,
                    parent_id: &step.id,
                    depth: depth + 1,
                    taken: taken == Some(path),
                    decided: taken.is_some(),
                    empty: branching.path(path).is_empty(),
                });
                walk(flow, branching.path(path), depth + 1, off, rows);
            }
        }
    }
    let mut rows = Vec::new();
    walk(flow, &flow.steps, 0, false, &mut rows);
    rows
}

/// The step a Run is on: the first one running or waiting (`currentStep`).
pub fn current_step(flow: &FlowRun) -> Option<&FlowStep> {
    flatten(&flow.steps)
        .into_iter()
        .find(|entry| flow.state.get(&entry.step.id).is_some_and(|run| matches!(run.status, StepStatus::Running | StepStatus::Waiting)))
        .map(|entry| entry.step)
}

/// The step a Run stopped at: the first failed one (`failedStep`).
pub fn failed_step(flow: &FlowRun) -> Option<&FlowStep> {
    flatten(&flow.steps)
        .into_iter()
        .find(|entry| flow.state.get(&entry.step.id).is_some_and(|run| run.status == StepStatus::Failed))
        .map(|entry| entry.step)
}

/// A Run's state in a few words: "Waiting for you at Open pull request", "Stopped at Implement" (`flowRunText`).
/// `error` is the Run's own, which an ended flow gives as its reason.
pub fn flow_run_text(flow: &FlowRun, error: Option<&str>) -> String {
    let current = current_step(flow);
    match flow.status {
        FlowStatus::Paused => current.map_or("Paused".into(), |step| format!("Paused at {}", step_title(step))),
        FlowStatus::Waiting if current.is_some() => {
            let step = current.expect("checked");
            let approval = flow.state.get(&step.id).and_then(|run| run.approval.as_ref());
            if approval.is_some_and(|approval| approval.decision.is_none()) {
                format!("Waiting for you at {}", step_title(step))
            } else {
                format!("Waiting at {}", step_title(step))
            }
        }
        FlowStatus::Running => current.map_or("Running".into(), |step| format!("Running {}", step_title(step))),
        FlowStatus::Failed => failed_step(flow).map_or("Stopped".into(), |step| format!("Stopped at {}", step_title(step))),
        FlowStatus::Ended => error.filter(|e| !e.is_empty()).map_or("Ended".into(), |e| format!("Ended, {e}")),
        _ => (if flow.dry_run { "Test run done" } else { "Done" }).into(),
    }
}

/// Whether the Run waits on the owner: an approval with no answer yet (`needsAnswer`).
pub fn needs_answer(flow: &FlowRun) -> bool {
    if flow.status != FlowStatus::Waiting {
        return false;
    }
    current_step(flow)
        .and_then(|step| flow.state.get(&step.id))
        .and_then(|run| run.approval.as_ref())
        .is_some_and(|approval| approval.decision.is_none())
}

/// The trigger's values for an event, as the object `trigger.<path>` refs read (`triggerValues`).
pub fn trigger_values(event: Option<&RunEvent>, at: Option<Millis>) -> Value {
    let mut values: Vec<(String, Value)> = Vec::new();
    match event {
        Some(RunEvent::Linear { issue, comment_author, comment_body, .. }) => {
            values.push((
                "issue".into(),
                Value::object([
                    ("key", Value::text(&issue.key)),
                    ("title", Value::text(&issue.title)),
                    ("description", Value::text(&issue.description)),
                    ("url", issue.url.as_ref().map_or(Value::Null, Value::text)),
                    ("labels", Value::text(issue.labels.join(", "))),
                    ("state", Value::text(&issue.state)),
                    ("team", Value::text(&issue.team)),
                ]),
            ));
            if comment_author.is_some() || comment_body.is_some() {
                values.push((
                    "comment".into(),
                    Value::object([
                        ("body", comment_body.as_ref().map_or(Value::Null, Value::text)),
                        ("author", comment_author.as_ref().map_or(Value::Null, Value::text)),
                    ]),
                ));
            }
        }
        Some(RunEvent::Webhook { delivery_id }) => values.push(("delivery".into(), Value::object([("id", Value::text(delivery_id))]))),
        _ => {}
    }
    if let Some(at) = at {
        let time = crate::logic::usage::time::local_time(at, &crate::routines::words::ZONE);
        values.push((
            "time".into(),
            Value::text(format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                time.year,
                time.month,
                time.day,
                time.hour,
                time.minute,
                at.div_euclid(1000).rem_euclid(60),
                at.rem_euclid(1000)
            )),
        ));
    }
    Value::Object(values)
}
