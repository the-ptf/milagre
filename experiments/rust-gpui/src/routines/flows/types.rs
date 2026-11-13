//! The flow domain (WP-46): `FlowStep`, `RoutineFlow`, `FlowRun` and what a Run keeps per step, as `packages/shared/src/
//! model.ts` defines them and `routines:list` sends them. Plain data. A step is an id and a name around one of six
//! bodies; an If holds its two paths as step lists.

use std::collections::HashMap;

use crate::data::{Millis, Provider};

/// The six step types, in the order the Add step menu lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StepKind {
    Agent,
    If,
    Ask,
    Wait,
    PullRequest,
    LinearComment,
}

impl StepKind {
    pub const ALL: [StepKind; 6] =
        [StepKind::Agent, StepKind::If, StepKind::Ask, StepKind::Wait, StepKind::PullRequest, StepKind::LinearComment];

    /// The wire id (`"pull-request"`).
    pub fn id(self) -> &'static str {
        match self {
            StepKind::Agent => "agent",
            StepKind::If => "if",
            StepKind::Ask => "ask",
            StepKind::Wait => "wait",
            StepKind::PullRequest => "pull-request",
            StepKind::LinearComment => "linear-comment",
        }
    }
}

/// An If's two paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Branch {
    Yes,
    Otherwise,
}

impl Branch {
    pub fn id(self) -> &'static str {
        match self {
            Branch::Yes => "yes",
            Branch::Otherwise => "otherwise",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Branch::Yes => "Yes",
            Branch::Otherwise => "Otherwise",
        }
    }
}

/// The type of a field a step gives (`FlowField.type`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldType {
    Text,
    Choice,
    YesNo,
    Number,
    Link,
}

impl FieldType {
    pub const ALL: [FieldType; 5] = [FieldType::Text, FieldType::Choice, FieldType::YesNo, FieldType::Number, FieldType::Link];

    pub fn id(self) -> &'static str {
        match self {
            FieldType::Text => "text",
            FieldType::Choice => "choice",
            FieldType::YesNo => "yes-no",
            FieldType::Number => "number",
            FieldType::Link => "link",
        }
    }

    pub fn from_id(id: &str) -> FieldType {
        FieldType::ALL.into_iter().find(|ty| ty.id() == id).unwrap_or(FieldType::Text)
    }

    /// `FIELD_TYPE_WORDS`.
    pub fn words(self) -> &'static str {
        match self {
            FieldType::YesNo => "yes or no",
            other => other.id(),
        }
    }
}

/// A field an agent step gives the steps after it; later steps read it as `{{<stepId>.<name>}}`.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowField {
    pub name: String,
    pub ty: FieldType,
    pub choices: Vec<String>,
    pub description: Option<String>,
}

impl FlowField {
    pub fn new(name: impl Into<String>, ty: FieldType) -> Self {
        FlowField { name: name.into(), ty, choices: Vec::new(), description: None }
    }

    pub fn choice(name: impl Into<String>, choices: &[&str]) -> Self {
        FlowField { choices: choices.iter().map(|c| (*c).to_string()).collect(), ..FlowField::new(name, FieldType::Choice) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatUse {
    /// The Run's Chat (made by the first agent step).
    Run,
    /// A Chat of its own in the same Worktree.
    Own,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnInvalid {
    AskOnce,
    Stop,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentStep {
    pub prompt: String,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub chat: ChatUse,
    pub output: Vec<FlowField>,
    pub retries: u32,
    pub on_invalid: OnInvalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Test {
    Is,
    IsNot,
    Contains,
    IsSet,
}

impl Test {
    pub const ALL: [Test; 4] = [Test::Is, Test::IsNot, Test::Contains, Test::IsSet];

    pub fn id(self) -> &'static str {
        match self {
            Test::Is => "is",
            Test::IsNot => "is-not",
            Test::Contains => "contains",
            Test::IsSet => "is-set",
        }
    }

    pub fn from_id(id: &str) -> Test {
        Test::ALL.into_iter().find(|test| test.id() == id).unwrap_or(Test::Is)
    }

    /// `TEST_WORDS`.
    pub fn words(self) -> &'static str {
        match self {
            Test::Is => "is",
            Test::IsNot => "is not",
            Test::Contains => "contains",
            Test::IsSet => "is set",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IfStep {
    /// `<stepId>.<field>` or `trigger.<path>`.
    pub field: String,
    pub test: Test,
    pub value: Option<String>,
    pub yes: Vec<FlowStep>,
    pub otherwise: Vec<FlowStep>,
}

impl IfStep {
    pub fn path(&self, branch: Branch) -> &Vec<FlowStep> {
        match branch {
            Branch::Yes => &self.yes,
            Branch::Otherwise => &self.otherwise,
        }
    }

    pub fn path_mut(&mut self, branch: Branch) -> &mut Vec<FlowStep> {
        match branch {
            Branch::Yes => &mut self.yes,
            Branch::Otherwise => &mut self.otherwise,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AskStep {
    pub message: String,
    pub expires_in_hours: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Until {
    Time { minutes: u32 },
    LinearState { state: String },
    PrReview,
}

impl Until {
    pub fn id(&self) -> &'static str {
        match self {
            Until::Time { .. } => "time",
            Until::LinearState { .. } => "linear-state",
            Until::PrReview => "pr-review",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WaitStep {
    pub until: Until,
    /// For a Linear state or a review: how long to wait before the step fails.
    pub timeout_hours: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PullRequestStep {
    pub title: String,
    pub body: String,
    pub base: Option<String>,
    pub draft: bool,
    pub ask_first: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommentStep {
    pub body: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StepBody {
    Agent(AgentStep),
    If(IfStep),
    Ask(AskStep),
    Wait(WaitStep),
    PullRequest(PullRequestStep),
    LinearComment(CommentStep),
}

/// A step in a flow: an id unique in its flow, a name people read, and its body.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowStep {
    pub id: String,
    pub name: String,
    pub body: StepBody,
}

impl FlowStep {
    pub fn kind(&self) -> StepKind {
        match &self.body {
            StepBody::Agent(_) => StepKind::Agent,
            StepBody::If(_) => StepKind::If,
            StepBody::Ask(_) => StepKind::Ask,
            StepBody::Wait(_) => StepKind::Wait,
            StepBody::PullRequest(_) => StepKind::PullRequest,
            StepBody::LinearComment(_) => StepKind::LinearComment,
        }
    }

    pub fn as_if(&self) -> Option<&IfStep> {
        match &self.body {
            StepBody::If(step) => Some(step),
            _ => None,
        }
    }

    pub fn as_agent(&self) -> Option<&AgentStep> {
        match &self.body {
            StepBody::Agent(step) => Some(step),
            _ => None,
        }
    }
}

/// What starts a flow, as the flow checks read it (`TriggerKind`): a babysit Heartbeat is not a flow trigger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerKind {
    Linear,
    Webhook,
    Schedule,
    PullRequest,
}

/// A draft being edited: the steps and when they were last saved.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub steps: Vec<FlowStep>,
    pub updated_at: Millis,
}

/// A Routine's flow (`RoutineFlow`): the published steps every new Run uses and the draft being edited.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct FlowDef {
    pub steps: Vec<FlowStep>,
    pub published_at: Millis,
    pub draft: Option<Draft>,
}

// ----- a Run's progress -----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepStatus {
    Pending,
    Running,
    Waiting,
    Done,
    Failed,
    Skipped,
    NotRun,
    /// Only in `RunRow`: a step on the path an If did not take.
    NotTaken,
}

impl StepStatus {
    pub fn id(self) -> &'static str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::Waiting => "waiting",
            StepStatus::Done => "done",
            StepStatus::Failed => "failed",
            StepStatus::Skipped => "skipped",
            StepStatus::NotRun => "not-run",
            StepStatus::NotTaken => "not-taken",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Rejected,
    Expired,
}

/// What an approval shows before a pull request opens.
#[derive(Clone, Debug, PartialEq)]
pub struct PrPreview {
    pub repository: Option<String>,
    pub branch: String,
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
    /// "6 files, 214 added, 38 removed".
    pub changes: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub asked_at: Millis,
    pub expires_at: Millis,
    pub message: String,
    pub preview: Option<PrPreview>,
    pub decision: Option<Decision>,
    pub decided_at: Option<Millis>,
    pub reason: Option<String>,
}

/// What a flow step did, kept so a Run never repeats it.
#[derive(Clone, Debug, PartialEq)]
pub enum Receipt {
    PullRequest { url: String, number: u32, branch: String, draft: bool, matched: bool, at: Millis },
    LinearComment { issue: String, url: Option<String>, at: Millis },
}

impl Receipt {
    pub fn url(&self) -> Option<&str> {
        match self {
            Receipt::PullRequest { url, .. } => Some(url),
            Receipt::LinearComment { url, .. } => url.as_deref(),
        }
    }

    pub fn at(&self) -> Millis {
        match self {
            Receipt::PullRequest { at, .. } | Receipt::LinearComment { at, .. } => *at,
        }
    }
}

/// A turn of a step that failed before the one now shown.
#[derive(Clone, Debug, PartialEq)]
pub struct Try {
    pub started_at: Millis,
    pub ended_at: Millis,
    pub error: String,
    pub chat_id: Option<String>,
}

/// A value an agent hands back, or the trigger gives (`Record<string, string | number | boolean>` and its objects).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Text(String),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn object(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
        Value::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    pub fn text(text: impl Into<String>) -> Value {
        Value::Text(text.into())
    }
}

/// A step's part of a Run (`FlowStepRun`).
#[derive(Clone, Debug, PartialEq)]
pub struct StepRun {
    pub status: StepStatus,
    pub started_at: Option<Millis>,
    pub ended_at: Option<Millis>,
    pub chat_id: Option<String>,
    pub output: Vec<(String, Value)>,
    pub error: Option<String>,
    /// What the step says it did, in a few words.
    pub summary: Option<String>,
    pub tries: Vec<Try>,
    pub taken: Option<Branch>,
    /// A note the owner added on retry.
    pub note: Option<String>,
    pub approval: Option<Approval>,
    pub receipt: Option<Receipt>,
    /// A wait's deadline, or when a time wait ends.
    pub wait_until: Option<Millis>,
}

impl StepRun {
    pub fn new(status: StepStatus) -> Self {
        StepRun {
            status,
            started_at: None,
            ended_at: None,
            chat_id: None,
            output: Vec::new(),
            error: None,
            summary: None,
            tries: Vec::new(),
            taken: None,
            note: None,
            approval: None,
            receipt: None,
            wait_until: None,
        }
    }

    pub fn done(started: Millis, ended: Millis) -> Self {
        StepRun { started_at: Some(started), ended_at: Some(ended), ..StepRun::new(StepStatus::Done) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowStatus {
    Running,
    Waiting,
    Paused,
    Done,
    Failed,
    Ended,
}

impl FlowStatus {
    pub fn id(self) -> &'static str {
        match self {
            FlowStatus::Running => "running",
            FlowStatus::Waiting => "waiting",
            FlowStatus::Paused => "paused",
            FlowStatus::Done => "done",
            FlowStatus::Failed => "failed",
            FlowStatus::Ended => "ended",
        }
    }
}

/// A flow Run's progress, on its Run (`FlowRun`). `steps` is the revision it started on.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowRun {
    pub revision: u32,
    pub steps: Vec<FlowStep>,
    pub state: HashMap<String, StepRun>,
    pub status: FlowStatus,
    /// A simulation: agents use sample or saved fields; actions and waits are skipped and approvals pass.
    pub dry_run: bool,
}

/// The Linear issue a Run was started for (`LinearIssueSnapshot`).
#[derive(Clone, Debug, PartialEq)]
pub struct IssueSnapshot {
    pub key: String,
    pub title: String,
    pub description: String,
    pub url: Option<String>,
    pub labels: Vec<String>,
    pub state: String,
    pub team: String,
}

/// What made a Routine run (`RoutineEvent`).
#[derive(Clone, Debug, PartialEq)]
pub enum RunEvent {
    Schedule,
    Linear { change: super::super::model::LinearEvent, issue: IssueSnapshot, comment_author: Option<String>, comment_body: Option<String> },
    Webhook { delivery_id: String },
}
