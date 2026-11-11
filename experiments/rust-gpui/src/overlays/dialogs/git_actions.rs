//! "Commit and open PR" (P-10, `GitActionsDialog.tsx`): commits the Chat's folder, pushes its branch and opens a PR,
//! with a generated, editable commit message and PR text. Milagre runs git and gh itself; the agent is not asked.
//!
//! - The sections and buttons come from `git_dialog::dialog_mode` (the mode table of `lib/git-dialog.ts`).
//! - The folder is read through [`GitBridge`] (`git_fixture.rs`); the text is written once the folder is read, with
//!   the fields showing "Writing…" meanwhile and text the user typed meanwhile staying.
//! - Each step shows Committing…, Pushing…, Opening PR… and then its result; a failure shows below the form, with
//!   a hook's own output and "Send to agent" when a git hook stopped the commit.
//! - After the steps the dialog says what happened (the note [`GitDialogConfig::on_ran`] is given for the Chat),
//!   and the folder is read again so the list and the buttons follow it.
//!
//! Opens through [`crate::ui::Dialog`] (`open`). The composer's pill row owns the button that opens it (WP-27); until
//! that is wired, `MILAGRE_GPUI_GIT_DIALOG=<scenario>[,run][,writing]` opens it in snapshot runs ([`open_from_env`]).
//!
//! Not built: Escape and the scrim stay live while steps run (`ui::Dialog` cannot change that after opening), the
//! 28px close button, the footer bar's own hairline, and the generator taking the Chat's messages (the fixture writes).

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, IntoElement, Render, ScrollHandle, SharedString, Subscription, Task,
    Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState, TextareaState};

use super::git_dialog::{
    DialogButton, DialogMode, DialogModeInput, GitChanges, GitFileStatus, GitRunResult, GitStep, RepoChanges, RunPr, dialog_mode,
    git_run_note, hook_failure_message, pr_target_line,
};
use super::git_fixture::{CommitKind, FixtureGit, GitBridge, Scenario};
use crate::logic::diff::codes::git_message;
use crate::logic::lists::order::format_line_count;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme, mono};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Dialog, FieldSize, Icon, IconName, IconSize, InlineError, Input, SectionLabel, SpinnerRing,
    TextArea, Tooltip, motion,
};

/// How long the fixture takes to write the text, and to run each step (so Committing… is seen).
pub const GENERATE_FOR: Duration = Duration::from_millis(600);
pub const STEP_FOR: Duration = Duration::from_millis(350);

/// The dialog's chrome around the sections in a short window: its margins, padding, title, gaps and the footer.
const SPARE_HEIGHT: f32 = 230.0;
const MIN_SECTIONS: f32 = 160.0;

const GENERATION_FAILED: &str = "Couldn't write a message. Type one to continue.";

type NoteHandler = Rc<dyn Fn(String, &mut App)>;

/// What opens the dialog: the folder, the bridge and the two things it tells the Chat.
#[derive(Clone)]
pub struct GitDialogConfig {
    pub project_name: Option<String>,
    pub bridge: Rc<dyn GitBridge>,
    /// The Chat's agent is mid-turn: committing waits for it.
    pub turn_running: bool,
    /// Steps ran: the note to save in the Chat (`gitRunNote`).
    pub on_ran: NoteHandler,
    /// "Send to agent" after a hook stopped the commit: a message to send to the Chat.
    pub on_send: NoteHandler,
}

impl GitDialogConfig {
    pub fn fixture(scenario: Scenario) -> Self {
        Self {
            project_name: Some("milagre-ade".to_string()),
            bridge: Rc::new(FixtureGit::new(scenario)),
            turn_running: false,
            on_ran: Rc::new(|_, _| {}),
            on_send: Rc::new(|_, _| {}),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepStatus {
    Running,
    Done,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StepState {
    pub step: GitStep,
    pub status: StepStatus,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub message: String,
    pub output: Option<String>,
    pub hint: Option<String>,
    /// A git hook stopped the commit: the agent can fix what it reports.
    pub hook: bool,
}

/// The three fields, read at click time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fields {
    pub commit_message: String,
    pub pr_title: String,
    pub pr_body: String,
}

pub struct GitActionsDialog {
    config: GitDialogConfig,
    changes: Option<GitChanges>,
    read_error: Option<String>,
    commit_message: Entity<TextareaState>,
    pr_title: Entity<InputState>,
    pr_body: Entity<TextareaState>,
    /// The text last written into each field, to tell the user's edits from it.
    generated: [String; 3],
    edited: [bool; 3],
    generating: bool,
    /// Which parts came back without text.
    generation_failed: (bool, bool),
    steps: Vec<StepState>,
    failure: Option<Failure>,
    outcome: GitRunResult,
    running: bool,
    finished: bool,
    /// The sections scroll when the window is short; the footer stays put.
    scroll: ScrollHandle,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl GitActionsDialog {
    /// Reads the folder and starts writing the text. `generate_for` is how long the fixture takes (zero writes at once).
    pub fn new(config: GitDialogConfig, generate_for: Option<Duration>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let commit_message = TextArea::state("Describe the change", (3, 6), window, cx);
        let pr_title = Input::state("Title", window, cx);
        let pr_body = TextArea::state("What changed and why", (5, 8), window, cx);
        let mut subscriptions = Vec::new();
        for (ix, state) in [(0, commit_message.clone()), (2, pr_body.clone())] {
            subscriptions.push(cx.subscribe_in(&state, window, move |this, state, event: &InputEvent, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.edited[ix] = state.read(cx).value().as_ref() != this.generated[ix];
                }
            }));
        }
        subscriptions.push(cx.subscribe_in(&pr_title, window, |this, state, event: &InputEvent, _window, cx| {
            if matches!(event, InputEvent::Change) {
                this.edited[1] = state.read(cx).value().as_ref() != this.generated[1];
            }
        }));
        let mut dialog = Self {
            config,
            changes: None,
            read_error: None,
            commit_message,
            pr_title,
            pr_body,
            generated: Default::default(),
            edited: [false; 3],
            generating: false,
            generation_failed: (false, false),
            steps: Vec::new(),
            failure: None,
            outcome: GitRunResult::default(),
            running: false,
            finished: false,
            scroll: ScrollHandle::new(),
            _tasks: Vec::new(),
            _subscriptions: subscriptions,
        };
        dialog.load();
        dialog.start_generation(generate_for, window, cx);
        dialog
    }

    fn load(&mut self) {
        match self.config.bridge.changes() {
            Ok(changes) => self.changes = Some(changes),
            Err(message) => self.read_error = Some(message),
        }
    }

    pub fn repo(&self) -> Option<&RepoChanges> {
        match &self.changes {
            Some(GitChanges::Repo(repo)) => Some(repo),
            _ => None,
        }
    }

    fn mode_for(repo: &RepoChanges, turn_running: bool) -> DialogMode {
        dialog_mode(&DialogModeInput {
            has_changes: repo.has_changes,
            unpushed: repo.unpushed,
            pr_open: repo.pr.is_some(),
            on_base: repo.on_base,
            has_origin: repo.has_origin,
            gh_ready: repo.gh_ready,
            ahead: repo.ahead,
            base: repo.base.clone(),
            gh_message: repo.gh_message.clone(),
            detached: repo.branch.is_none(),
            commit_blocked: repo.commit_blocked.clone(),
            turn_running,
        })
    }

    pub fn mode(&self) -> Option<DialogMode> {
        self.repo().map(|repo| Self::mode_for(repo, self.config.turn_running))
    }

    fn start_generation(&mut self, delay: Option<Duration>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(repo) = self.repo() else { return };
        // A running turn does not change which sections show, only which buttons work.
        let initial = Self::mode_for(repo, false);
        // Mid-merge nothing can be committed yet, and the diff holds conflict markers.
        if repo.commit_blocked.is_some() || (!initial.show_commit && !initial.show_pr_fields) {
            return;
        }
        self.generating = true;
        let Some(delay) = delay else { return };
        if delay.is_zero() {
            self.finish_generation(window, cx);
            return;
        }
        self._tasks.push(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update_in(cx, |this, window, cx| this.finish_generation(window, cx)).ok();
        }));
    }

    fn finish_generation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.generating = false;
        match self.config.bridge.generate() {
            Err(_) => self.generation_failed = (true, true),
            Ok(text) => {
                // Text the user typed meanwhile stays.
                let fields = [(0, &text.commit_message), (1, &text.pr_title), (2, &text.pr_body)];
                for (ix, value) in fields {
                    if !self.edited[ix] {
                        self.generated[ix] = value.clone();
                        match ix {
                            0 => self.commit_message.update(cx, |state, cx| state.set_value(value.clone(), window, cx)),
                            1 => self.pr_title.update(cx, |state, cx| state.set_value(value.clone(), window, cx)),
                            _ => self.pr_body.update(cx, |state, cx| state.set_value(value.clone(), window, cx)),
                        }
                        self.edited[ix] = false;
                    }
                }
                // A subject that kept repeating an earlier commit comes back empty.
                self.generation_failed = (text.commit_message.is_empty(), text.pr_title.is_empty());
            }
        }
        cx.notify();
    }

    pub fn fields(&self, cx: &App) -> Fields {
        Fields {
            commit_message: self.commit_message.read(cx).value().to_string(),
            pr_title: self.pr_title.read(cx).value().to_string(),
            pr_body: self.pr_body.read(cx).value().to_string(),
        }
    }

    pub fn is_generating(&self) -> bool {
        self.generating
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn steps(&self) -> &[StepState] {
        &self.steps
    }

    pub fn failure(&self) -> Option<&Failure> {
        self.failure.as_ref()
    }

    pub fn outcome(&self) -> &GitRunResult {
        &self.outcome
    }

    /// A button needs the fields its steps use; generation may still be filling them.
    fn missing_field(&self, button: Option<&DialogButton>, fields: &Fields) -> Option<&'static str> {
        let button = button?;
        if button.steps.contains(&GitStep::Commit) && fields.commit_message.trim().is_empty() {
            Some("Write a commit message.")
        } else if button.steps.contains(&GitStep::Pr) && fields.pr_title.trim().is_empty() {
            Some("Add a PR title.")
        } else {
            None
        }
    }

    fn disabled(&self, button: Option<&DialogButton>, fields: &Fields) -> bool {
        self.running || button.is_none_or(|b| b.disabled_reason.is_some()) || self.missing_field(button, fields).is_some()
    }

    /// Runs the primary button's steps (tests and the snapshot seed; the buttons call [`Self::run`]).
    pub fn run_primary(&mut self, cx: &mut Context<Self>) {
        if let Some(steps) = self.mode().and_then(|mode| mode.primary).map(|button| button.steps) {
            self.run(steps, cx);
        }
    }

    /// Runs `steps` one after another, each shown as it goes; the first failure stops them.
    pub fn run(&mut self, steps: Vec<GitStep>, cx: &mut Context<Self>) {
        // A second click before the first run ends must not start another.
        if self.repo().is_none() || self.running {
            return;
        }
        self.running = true;
        self.failure = None;
        self.steps.clear();
        self.outcome = GitRunResult::default();
        let fields = self.fields(cx);
        cx.notify();
        let task = cx.spawn(async move |this, cx| {
            for step in steps {
                if this.update(cx, |this, cx| this.set_step(step, StepStatus::Running, None, cx)).is_err() {
                    return;
                }
                cx.background_executor().timer(STEP_FOR).await;
                match this.update(cx, |this, cx| this.perform(step, &fields, cx)) {
                    Ok(true) => {}
                    _ => break,
                }
            }
            this.update(cx, |this, cx| this.finish_run(cx)).ok();
        });
        self._tasks.push(task);
    }

    fn set_step(&mut self, step: GitStep, status: StepStatus, detail: Option<String>, cx: &mut Context<Self>) {
        self.steps.retain(|item| item.step != step);
        self.steps.push(StepState { step, status, detail });
        cx.notify();
    }

    /// Runs one step against the bridge; `false` when it failed.
    fn perform(&mut self, step: GitStep, fields: &Fields, cx: &mut Context<Self>) -> bool {
        let bridge = self.config.bridge.clone();
        let result: Result<String, Failure> = match step {
            GitStep::Commit => match bridge.commit(&fields.commit_message) {
                Ok(short) => {
                    self.outcome.short_sha = Some(short.clone());
                    Ok(format!("Committed {short}"))
                }
                Err(failure) => Err(Failure {
                    message: failure.code.map_or(failure.message, |code| git_message(code, None)),
                    output: failure.output,
                    hint: None,
                    // Only a hook's complaint is something the agent can fix; a signing key is not.
                    hook: failure.kind == CommitKind::Hook,
                }),
            },
            GitStep::Push => match bridge.push() {
                Ok((branch, remote)) => {
                    self.outcome.pushed_branch = Some(branch.clone());
                    Ok(format!("Pushed to {remote}/{branch}"))
                }
                Err(failure) => Err(Failure {
                    message: failure.code.map_or(failure.message, |code| git_message(code, None)),
                    output: None,
                    hint: failure.hint,
                    hook: false,
                }),
            },
            GitStep::Pr => match bridge.open_pr(&fields.pr_title, &fields.pr_body) {
                Ok((url, number)) => {
                    let detail = number.map_or_else(|| "Opened the PR".to_string(), |n| format!("Opened PR #{n}"));
                    self.outcome.pr = Some(RunPr { url, number, created: true });
                    Ok(detail)
                }
                Err(failure) => Err(Failure {
                    message: if failure.message.is_empty() {
                        failure.code.map(|c| git_message(c, None)).unwrap_or_default()
                    } else {
                        failure.message
                    },
                    output: None,
                    hint: None,
                    hook: false,
                }),
            },
        };
        match result {
            Ok(detail) => {
                self.set_step(step, StepStatus::Done, Some(detail), cx);
                true
            }
            Err(failure) => {
                self.failure = Some(failure);
                self.set_step(step, StepStatus::Failed, None, cx);
                // A failure shows below the form, so bring it into view.
                self.scroll.scroll_to_bottom();
                false
            }
        }
    }

    fn finish_run(&mut self, cx: &mut Context<Self>) {
        let failed = self.failure.is_some();
        // A push to a branch with an open PR updates it.
        let open_pr = self.repo().and_then(|repo| repo.pr.clone());
        if let Some(pr) = open_pr.filter(|_| self.outcome.pushed_branch.is_some() && self.outcome.pr.is_none()) {
            self.outcome.pr = Some(RunPr { url: pr.url, number: pr.number, created: false });
        }
        if let Some(note) = git_run_note(&self.outcome) {
            (self.config.on_ran)(note, cx);
        }
        // The folder has moved on (after a failure a commit may be in), so the list and the buttons follow it.
        if !failed {
            self.finished = true;
        }
        self.load();
        self.running = false;
        cx.notify();
    }

    fn close(window: &mut Window, cx: &mut App) {
        Dialog::close(window, cx);
    }
}

// --- drawing ----------------------------------------------------------------------------------------------

fn section(theme: &Theme, label: &'static str, id: &'static str, child: impl IntoElement) -> AnyElement {
    let _ = theme;
    div()
        .debug_selector(move || id.to_string())
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(SectionLabel::new(label))
        .child(child)
        .into_any_element()
}

fn card_note(theme: &Theme, id: &'static str, text: impl IntoElement) -> AnyElement {
    div()
        .debug_selector(move || id.to_string())
        .px(px(12.0))
        .py(px(8.0))
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .text_step(TEXT_12)
        .text_color(theme.ink2)
        .child(text)
        .into_any_element()
}

fn status_letter(theme: &Theme, status: GitFileStatus) -> (&'static str, gpui::Rgba) {
    match status {
        GitFileStatus::Added => ("A", theme.diff_add),
        GitFileStatus::Deleted => ("D", theme.diff_remove),
        GitFileStatus::Modified => ("M", theme.orange_ink),
    }
}

fn counts(theme: &Theme, added: u32, removed: u32) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .gap(px(4.0))
        .text_color(theme.ink3)
        .when(added > 0, |el| el.child(div().text_color(theme.diff_add).child(format!("+{}", format_line_count(added as f64)))))
        .when(removed > 0, |el| {
            el.child(div().text_color(theme.diff_remove).child(format!("\u{2212}{}", format_line_count(removed as f64))))
        })
}

fn file_list(theme: &Theme, repo: &RepoChanges) -> AnyElement {
    if repo.files.is_empty() {
        let tail = if repo.unpushed > 0 {
            format!(" {} {} to push.", repo.unpushed, if repo.unpushed == 1 { "commit" } else { "commits" })
        } else {
            String::new()
        };
        return card_note(theme, "git-files-empty", format!("No uncommitted changes.{tail}"));
    }
    let (added, removed) = repo.files.iter().fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
    let n = repo.files.len();
    div()
        .debug_selector(|| "git-files".to_string())
        .overflow_hidden()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .px(px(12.0))
                .py(px(6.0))
                .border_b_1()
                .border_color(theme.line)
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .child(format!("{n} {} changed", if n == 1 { "file" } else { "files" }))
                .child(counts(theme, added, removed)),
        )
        .child(div().id("git-file-rows").flex().flex_col().max_h(px(144.0)).overflow_y_scroll().py(px(4.0)).children(
            repo.files.iter().enumerate().map(|(ix, file)| {
                let (letter, tone) = status_letter(theme, file.status);
                div()
                    .id(("git-file", ix))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .py(px(2.0))
                    .text_step(TEXT_12)
                    .child(
                        div().flex_none().w(px(12.0)).font_family(mono()).font_weight(FontWeight::SEMIBOLD).text_color(tone).child(letter),
                    )
                    .child(div().min_w_0().flex_1().truncate().font_family(mono()).child(file.path.clone()))
                    .when(file.secret, |el| {
                        el.child(
                            div()
                                .id(("git-secret", ix))
                                .debug_selector(|| "git-secret".to_string())
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(4.0))
                                .text_step(TEXT_11)
                                .text_color(theme.orange_ink)
                                .tooltip(Tooltip::text("This looks like a secret. Milagre won't commit it."))
                                .child(Icon::new(IconName::Alert02).size(IconSize::S12).color(theme.orange_ink))
                                .child("Secret?"),
                        )
                    })
                    .child(counts(theme, file.added, file.removed))
            }),
        ))
        .into_any_element()
}

fn step_line(theme: &Theme, state: &StepState, outcome: &GitRunResult) -> AnyElement {
    let text = match state.status {
        StepStatus::Running => state.step.running().to_string(),
        StepStatus::Failed => state.step.failed().to_string(),
        StepStatus::Done => state.detail.clone().unwrap_or_default(),
    };
    let (_tone, glyph): (gpui::Rgba, AnyElement) = match state.status {
        StepStatus::Running => {
            let ring = SpinnerRing::new();
            (
                theme.ink3,
                if motion() { ring.animated(("git-step-ring", state.step as usize)).into_any_element() } else { ring.into_any_element() },
            )
        }
        StepStatus::Done => (theme.green_ink, Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.green_ink).into_any_element()),
        StepStatus::Failed => (theme.red_ink, Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.red_ink).into_any_element()),
    };
    let link = (state.step == GitStep::Pr && state.status == StepStatus::Done).then(|| outcome.pr.clone()).flatten().map(|pr| {
        let url = pr.url.clone();
        div()
            .id("git-pr-link")
            .debug_selector(|| "git-pr-link".to_string())
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(4.0))
            .text_color(theme.ink)
            .underline()
            .cursor_pointer()
            .on_click(move |_, _, cx| cx.open_url(&url))
            .child(div().truncate().child(pr.url.trim_start_matches("https://").trim_start_matches("http://").to_string()))
            .child(Icon::new(IconName::LinkSquare02).size(IconSize::S12).color(theme.ink))
    });
    div()
        .debug_selector({
            let key = format!(
                "git-step-{}-{}",
                state.step.key(),
                match state.status {
                    StepStatus::Running => "running",
                    StepStatus::Done => "done",
                    StepStatus::Failed => "failed",
                }
            );
            move || key.clone()
        })
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_h(px(24.0))
        .text_step(TEXT_13)
        .child(div().flex().flex_none().items_center().justify_center().size(px(16.0)).child(glyph))
        .child(div().text_color(if state.status == StepStatus::Running { theme.ink2 } else { theme.ink }).child(text))
        .children(link)
        .into_any_element()
}

impl GitActionsDialog {
    /// A field that stays editable while its text is generated; "Writing…" sits inside it.
    fn generated_field(&self, field: AnyElement, empty: bool, theme: &Theme) -> AnyElement {
        let spinner = self.generating && empty;
        div()
            .relative()
            .child(field)
            .when(spinner, |el| {
                el.child(
                    div()
                        .debug_selector(|| "git-writing".to_string())
                        .absolute()
                        .left(px(10.0))
                        .top(px(8.0))
                        .flex()
                        .h(px(20.0))
                        .items_center()
                        .gap(px(6.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink3)
                        .child(SpinnerRing::new())
                        .child("Writing\u{2026}"),
                )
            })
            .into_any_element()
    }

    fn footer(&self, mode: &DialogMode, fields: &Fields, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let primary = mode.primary.as_ref();
        let secondary = mode.secondary.as_ref();
        // The reason beside the buttons: git's or the agent's state first, then a missing field.
        let reason = primary
            .and_then(|b| b.disabled_reason.clone())
            .or_else(|| secondary.and_then(|b| b.disabled_reason.clone()))
            .or_else(|| (!self.generating).then(|| self.missing_field(primary, fields).map(str::to_string)).flatten());
        // The PR section already says why a PR cannot open; the footer does not repeat it.
        let reason = reason.filter(|reason| Some(reason) != mode.pr_blocked.as_ref()).filter(|_| !self.finished && !self.running);
        let actions: Vec<AnyElement> = if self.finished || primary.is_none() {
            vec![
                Button::new("git-close", if self.finished { "Done" } else { "Close" })
                    .disabled(self.running)
                    .selector("git-close")
                    .on_click(|_, window, cx| Self::close(window, cx))
                    .into_any_element(),
            ]
        } else {
            let mut out = Vec::new();
            if let Some(button) = secondary {
                let (view, steps) = (view.clone(), button.steps.clone());
                out.push(
                    Button::new("git-secondary", button.label.clone())
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S32)
                        .disabled(self.disabled(Some(button), fields))
                        .selector("git-secondary")
                        .on_click(move |_, _, cx| view.update(cx, |this, cx| this.run(steps.clone(), cx)))
                        .into_any_element(),
                );
            }
            if let Some(button) = primary {
                let (view, steps) = (view.clone(), button.steps.clone());
                out.push(
                    Button::new("git-primary", button.label.clone())
                        .size(ButtonSize::S32)
                        .disabled(self.disabled(Some(button), fields))
                        .selector("git-primary")
                        .on_click(move |_, _, cx| view.update(cx, |this, cx| this.run(steps.clone(), cx)))
                        .into_any_element(),
                );
            }
            out
        };
        div()
            .debug_selector(|| "git-footer".to_string())
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .debug_selector(|| "git-footer-reason".to_string())
                    .min_w_0()
                    .flex_1()
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .children(reason),
            )
            .children(actions)
            .into_any_element()
    }

    fn failure_box(&self, failure: &Failure, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let multiline = failure.output.is_some() || failure.message.contains('\n');
        let send = failure.hook.then(|| {
            let (view, text) = (cx.entity(), hook_failure_message(failure.output.as_deref().unwrap_or(&failure.message)));
            Button::new("git-send-agent", "Send to agent")
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::S28)
                .selector("git-send-agent")
                .on_click(move |_, window, cx| {
                    let handler = view.read(cx).config.on_send.clone();
                    handler(text.clone(), cx);
                    Self::close(window, cx);
                })
        });
        div()
            .debug_selector(|| "git-failure".to_string())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .p(px(12.0))
            .rounded(RADIUS_CARD)
            .bg(theme.red_tint)
            .text_step(TEXT_13)
            .text_color(theme.red_ink)
            .when(multiline, |el| {
                el.children(failure.output.as_ref().map(|_| div().font_weight(FontWeight::MEDIUM).child(failure.message.clone()))).child(
                    div()
                        .id("git-failure-output")
                        .max_h(px(192.0))
                        .overflow_y_scroll()
                        .px(px(10.0))
                        .py(px(8.0))
                        .rounded(RADIUS_CHIP)
                        .bg(theme.surface)
                        .font_family(mono())
                        .text_step(TEXT_11)
                        .text_color(theme.ink2)
                        .child(failure.output.clone().unwrap_or_else(|| failure.message.clone())),
                )
            })
            .when(!multiline, |el| el.child(failure.message.clone()))
            .children(failure.hint.clone().map(|hint| div().child(hint)))
            .children(send)
            .into_any_element()
    }
}

impl Render for GitActionsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        // What the dialog's chrome (title, padding, margins) leaves of a short window for the sections.
        let sections_max = (f32::from(window.viewport_size().height) - SPARE_HEIGHT).max(MIN_SECTIONS);
        let root = div().debug_selector(|| "git-dialog".to_string()).flex().flex_col().gap(px(16.0)).pt(px(4.0)).text_color(theme.ink);
        let fields = self.fields(cx);
        match (&self.changes, &self.read_error) {
            (None, None) => {
                return root.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .py(px(24.0))
                        .text_step(TEXT_13)
                        .text_color(theme.ink3)
                        .child(SpinnerRing::new())
                        .child("Reading changes\u{2026}"),
                );
            }
            (None, Some(message)) => return root.child(InlineError::new(message.clone())),
            (Some(GitChanges::NotRepo { message }), _) => {
                return root
                    .child(
                        div()
                            .debug_selector(|| "git-not-repo".to_string())
                            .py(px(8.0))
                            .text_step(TEXT_13)
                            .text_color(theme.ink2)
                            .child(message.clone().unwrap_or_else(|| "This Chat's folder isn't a Git repository.".to_string())),
                    )
                    .child(
                        div().flex().justify_end().child(
                            Button::new("git-close", "Close").selector("git-close").on_click(|_, window, cx| Self::close(window, cx)),
                        ),
                    );
            }
            (Some(GitChanges::Repo(_)), _) => {}
        }
        let repo = self.repo().cloned().expect("a repository was matched above");
        let mode = Self::mode_for(&repo, self.config.turn_running);
        let show_form = !self.finished;

        let branch = div()
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .text_step(TEXT_12)
            .text_color(theme.ink2)
            .child(Icon::new(IconName::GitBranch).size(IconSize::S14).color(theme.ink3))
            .child(
                div()
                    .debug_selector(|| "git-branch".to_string())
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .child(repo.branch.clone().unwrap_or_else(|| "Detached HEAD".to_string())),
            )
            .child(Icon::new(IconName::ArrowRight01).size(IconSize::S12).color(theme.ink3))
            .child(div().truncate().child(repo.base.clone()));
        let changes = section(
            &theme,
            "Changes",
            "git-section-changes",
            div().flex().flex_col().gap(px(4.0)).child(branch).child(file_list(&theme, &repo)),
        );

        let commit = (show_form && mode.show_commit).then(|| {
            let field = TextArea::new("git-commit-message", &self.commit_message).into_any_element();
            let note = (self.generation_failed.0 && fields.commit_message.is_empty())
                .then(|| div().text_step(TEXT_12).text_color(theme.ink3).child(GENERATION_FAILED));
            section(
                &theme,
                "Commit message",
                "git-section-commit",
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(self.generated_field(field, fields.commit_message.is_empty(), &theme))
                    .children(note),
            )
        });

        let pull_request = (show_form && (mode.pr_open || mode.show_pr_fields || mode.pr_blocked.is_some())).then(|| {
            let body: AnyElement = if let (true, Some(pr)) = (mode.pr_open, repo.pr.as_ref()) {
                let url = pr.url.clone();
                let number = pr.number.map(|n| n.to_string()).unwrap_or_default();
                card_note(
                    &theme,
                    "git-pr-open",
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_x(px(8.0))
                        .gap_y(px(4.0))
                        .child(format!("PR #{number} is open. Pushing updates it."))
                        .child(
                            div()
                                .id("git-open-pr")
                                .flex()
                                .items_center()
                                .gap(px(4.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink)
                                .underline()
                                .cursor_pointer()
                                .on_click(move |_, _, cx| cx.open_url(&url))
                                .child(format!("Open PR #{number}"))
                                .child(Icon::new(IconName::LinkSquare02).size(IconSize::S12).color(theme.ink)),
                        ),
                )
            } else if mode.show_pr_fields {
                let note = (self.generation_failed.1 && fields.pr_title.is_empty() && !(mode.show_commit && self.generation_failed.0))
                    .then(|| div().text_step(TEXT_12).text_color(theme.ink3).child(GENERATION_FAILED));
                let target = pr_target_line(repo.remotes, repo.pr_repo.as_deref())
                    .map(|line| div().debug_selector(|| "git-pr-target".to_string()).text_step(TEXT_12).text_color(theme.ink2).child(line));
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(self.generated_field(
                        Input::new("git-pr-title", &self.pr_title).size(FieldSize::S36).into_any_element(),
                        fields.pr_title.is_empty(),
                        &theme,
                    ))
                    .child(self.generated_field(
                        TextArea::new("git-pr-body", &self.pr_body).into_any_element(),
                        fields.pr_body.is_empty(),
                        &theme,
                    ))
                    .children(note)
                    .children(target)
                    .into_any_element()
            } else {
                card_note(&theme, "git-pr-blocked", mode.pr_blocked.clone().unwrap_or_default())
            };
            section(&theme, "Pull request", "git-section-pr", body)
        });

        let progress = (!self.steps.is_empty()).then(|| {
            let mut lines: Vec<AnyElement> = self.steps.iter().map(|state| step_line(&theme, state, &self.outcome)).collect();
            if let Some(pr) = self.outcome.pr.as_ref().filter(|pr| !pr.created) {
                let detail = pr.number.map_or_else(|| "Updated the PR".to_string(), |n| format!("Updated PR #{n}"));
                lines.push(step_line(
                    &theme,
                    &StepState { step: GitStep::Pr, status: StepStatus::Done, detail: Some(detail) },
                    &self.outcome,
                ));
            }
            section(
                &theme,
                if self.finished { "Result" } else { "Progress" },
                "git-section-progress",
                div().flex().flex_col().gap(px(2.0)).children(lines),
            )
        });

        let failure = self.failure.clone().map(|failure| self.failure_box(&failure, &theme, cx));
        let idle = (!self.finished && self.failure.is_none())
            .then(|| mode.idle.clone())
            .flatten()
            .map(|idle| div().debug_selector(|| "git-idle".to_string()).text_step(TEXT_12).text_color(theme.ink3).child(idle));
        let footer = self.footer(&mode, &fields, cx);
        let sections = div()
            .id("git-sections")
            .debug_selector(|| "git-sections".to_string())
            .flex()
            .flex_col()
            .gap(px(16.0))
            .max_h(px(sections_max))
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(changes)
            .children(commit)
            .children(pull_request)
            .children(progress)
            .children(failure)
            .children(idle);
        root.child(sections).child(footer)
    }
}

/// Opens the dialog over the window.
pub fn open(config: GitDialogConfig, generate_for: Option<Duration>, window: &mut Window, cx: &mut App) -> Entity<GitActionsDialog> {
    let project = config.project_name.clone();
    let view = cx.new(|cx| GitActionsDialog::new(config, generate_for, window, cx));
    let body = view.clone();
    let mut dialog = Dialog::new("Commit and open PR").width(560.0).body(move |_, _| body.clone().into_any_element());
    if let Some(project) = project {
        dialog = dialog.description(SharedString::from(project));
    }
    dialog.open(window, cx);
    view
}

/// Snapshot runs: `MILAGRE_GPUI_GIT_DIALOG=<scenario>[,run][,writing]` opens the dialog on that fixture folder once
/// the window has drawn, runs the primary button's steps with `run`, and keeps "Writing…" on screen with `writing`.
pub fn open_from_env(spec: &str, window: &mut Window, cx: &mut App) {
    let mut parts = spec.split(',');
    let Some(scenario) = parts.next().and_then(Scenario::from_key) else { return };
    let flags: Vec<&str> = parts.collect();
    let (run, writing) = (flags.contains(&"run"), flags.contains(&"writing"));
    window.defer(cx, move |window, cx| {
        let generate_for = if writing { None } else { Some(Duration::ZERO) };
        let view = open(GitDialogConfig::fixture(scenario), generate_for, window, cx);
        if run {
            view.update(cx, |dialog, cx| dialog.run_primary(cx));
        }
    });
}

#[cfg(test)]
mod tests;
