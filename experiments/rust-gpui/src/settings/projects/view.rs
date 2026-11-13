//! A Project's Settings page (`ProjectSettings` in `Settings.tsx`, `ProjectGitSettings.tsx`): icon, Show in sidebar,
//! accounts, how new Worktrees follow the source branch, the Branches group, Files to copy, the setup command and
//! Remove Project.
//!
//! Text fields save as you type: 600 ms after the last keystroke (a generation counter makes a newer keystroke cancel
//! the older timer), straight away for the two checkboxes, and not at all while the branch template or base branch is
//! invalid. A field the repository sets (`.milagre/worktree.json`, `.worktreeinclude`) is read-only and says so.
//!
//! Not built: the monospace face in the fields (the input widget has one font), a read-only look that is not the
//! disabled one, the icon picker's decoding and resizing (the chosen file stands in as a fixture tile; `icon_size` holds
//! the 256px rule), and the Files to copy preview delay (it follows the text at once).

use std::time::Duration;

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, PathPromptOptions, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, WeakEntity, Window, div, hsla, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState, TextareaState};

use super::logic::{
    BASE_COPY, BRANCH_EXAMPLE, BRANCH_FOOTER, BRANCH_REPOSITORY, BRANCH_RESET, BRANCH_TITLE, BRANCH_TOKENS, BranchPolicy, DASHES_COPY,
    DEFAULT_FILES_TO_COPY, Field, INSTRUCTIONS_COPY, SAVE_DELAY_MS, TEMPLATE_COPY, TRACK_COPY, USERNAME_COPY, branch_policy_check,
    preview_sentence, token_text,
};
use super::model::{IconChoice, ProjectsStore};
use crate::data::Provider;
use crate::settings::accounts::AccountsStore;
use crate::settings::accounts::model::{ProjectProvider, status_label};
use crate::settings::devices::logic::{MAIN_SYNC_TITLE, MainSyncChoice, main_sync_choices, main_sync_status_line};
use crate::settings::devices::model::{DevicesStore, now_ms};
use crate::settings::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use crate::settings::{SelectedSection, SettingsModal, SettingsSectionId};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme, mono};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Dialog, DialogAction, InlineError, Input, ProjectAvatar, ProviderLogo, SectionLabel, Select,
    SelectOption, TextArea,
};
use crate::workspace::preview::settings_row_shows;

/// How long typing in Files to copy must pause before a host previews what it matches.
const PREVIEW_DELAY_MS: u64 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Save {
    Branch,
    Files,
    Setup,
}

struct Inputs {
    template: Entity<InputState>,
    username: Entity<InputState>,
    base: Entity<InputState>,
    instructions: Entity<TextareaState>,
    files: Entity<TextareaState>,
    setup: Entity<InputState>,
}

pub struct ProjectView {
    modal: WeakEntity<SettingsModal>,
    path: Option<String>,
    name: String,
    found: Option<String>,
    inputs: Option<Inputs>,
    subs: Vec<Subscription>,
    generation: [u64; 3],
    pending: [bool; 3],
    icon_error: String,
    /// A data layer's host: the visit and Project last read, and the entry's `loaded` the fields were made from.
    seen: Option<(u64, String)>,
    made_from: u64,
}

fn slot(save: Save) -> usize {
    match save {
        Save::Branch => 0,
        Save::Files => 1,
        Save::Setup => 2,
    }
}

impl ProjectView {
    pub fn new(modal: WeakEntity<SettingsModal>, cx: &mut Context<Self>) -> Self {
        cx.observe_global::<ProjectsStore>(|_, cx| cx.notify()).detach();
        cx.observe_global::<AccountsStore>(|_, cx| cx.notify()).detach();
        Self {
            modal,
            path: None,
            name: String::new(),
            found: None,
            inputs: None,
            subs: Vec::new(),
            generation: [0; 3],
            pending: [false; 3],
            icon_error: String::new(),
            seen: None,
            made_from: 0,
        }
    }

    /// Reads the Project's settings from a data layer's host when Settings opened, came to this page or went to another
    /// Project since the last read ([`super::hosted`]).
    pub fn visit(&mut self, cx: &mut Context<Self>) {
        let (Some(visit), Some(path)) = (crate::settings::host::visit(cx), self.path.clone()) else { return };
        let seen = Some((visit, path.clone()));
        if self.seen != seen {
            self.seen = seen;
            super::hosted::read(&path, cx);
        }
    }

    /// The Project to draw and the row a Settings search result lit up. Leaving a Project saves what was typed last.
    pub fn set_target(&mut self, path: &str, name: &str, found: Option<&str>, cx: &mut Context<Self>) {
        let mut changed = false;
        if self.path.as_deref() != Some(path) {
            for save in [Save::Branch, Save::Files, Save::Setup] {
                self.flush(save, cx);
            }
            self.inputs = None;
            self.subs.clear();
            self.icon_error.clear();
            self.made_from = cx.global::<ProjectsStore>().get(path).loaded;
            self.path = Some(path.to_string());
            self.name = name.to_string();
            changed = true;
        }
        if self.found.as_deref() != found {
            self.found = found.map(str::to_string);
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// The branch template field (tests type into it).
    pub fn template_input(&self) -> Option<Entity<InputState>> {
        self.inputs.as_ref().map(|inputs| inputs.template.clone())
    }

    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    pub fn pending(&self, save: Save) -> bool {
        self.pending[slot(save)]
    }

    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inputs.is_some() {
            return;
        }
        let Some(path) = self.path.clone() else { return };
        let entry = cx.global::<ProjectsStore>().get(&path);
        let effective = entry.branch.effective();
        let locked_files = entry.worktree_include.clone();
        let setup_value = match &entry.setup_settings.repo {
            Some(command) => command.clone().unwrap_or_default(),
            None => entry.setup.clone(),
        };
        let template = Input::state(TEMPLATE_COPY.placeholder, window, cx);
        let username = Input::state(USERNAME_COPY.placeholder, window, cx);
        let base = Input::state(BASE_COPY.placeholder, window, cx);
        let instructions = TextArea::state(INSTRUCTIONS_COPY.placeholder, (3, 8), window, cx);
        let files = TextArea::state(DEFAULT_FILES_TO_COPY, (5, 12), window, cx);
        let setup = Input::state(if entry.setup_settings.repo.is_some() { "Nothing runs" } else { "npm ci" }, window, cx);
        template.update(cx, |s, cx| s.set_value(effective.template.clone(), window, cx));
        username.update(cx, |s, cx| s.set_value(effective.username.clone(), window, cx));
        base.update(cx, |s, cx| s.set_value(effective.base_branch.clone(), window, cx));
        instructions.update(cx, |s, cx| s.set_value(effective.instructions.clone(), window, cx));
        files.update(cx, |s, cx| s.set_value(locked_files.unwrap_or(entry.files.clone()), window, cx));
        setup.update(cx, |s, cx| s.set_value(setup_value, window, cx));
        for (state, save) in [(&template, Save::Branch), (&username, Save::Branch), (&base, Save::Branch), (&setup, Save::Setup)] {
            self.subs.push(cx.subscribe(state, move |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.edited(save, cx);
                }
            }));
        }
        for (state, save) in [(&instructions, Save::Branch), (&files, Save::Files)] {
            self.subs.push(cx.subscribe(state, move |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.edited(save, cx);
                }
            }));
        }
        self.inputs = Some(Inputs { template, username, base, instructions, files, setup });
    }

    /// The branch draft: the typed text over the saved checkboxes.
    pub fn draft(&self, cx: &App) -> Option<BranchPolicy> {
        let inputs = self.inputs.as_ref()?;
        let entry = cx.global::<ProjectsStore>().get(self.path.as_deref()?);
        let effective = entry.branch.effective();
        Some(BranchPolicy {
            template: inputs.template.read(cx).value().trim().to_string(),
            username: inputs.username.read(cx).value().trim().to_string(),
            dashes_only: effective.dashes_only,
            base_branch: inputs.base.read(cx).value().trim().to_string(),
            track_base: effective.track_base,
            instructions: inputs.instructions.read(cx).value().trim().to_string(),
        })
    }

    /// A keystroke: arms the 600 ms save, unless the branch draft is invalid (that waits until it is fixed).
    pub fn edited(&mut self, save: Save, cx: &mut Context<Self>) {
        let ix = slot(save);
        self.generation[ix] += 1;
        if save == Save::Branch
            && let Some(draft) = self.draft(cx)
        {
            let check = branch_policy_check(&draft);
            if !check.template.is_empty() || !check.base_branch.is_empty() {
                self.pending[ix] = false;
                cx.notify();
                return;
            }
        }
        self.pending[ix] = true;
        let generation = self.generation[ix];
        // A host previews what the patterns match shortly after typing stops (`FilesToCopy`'s 300 ms).
        if save == Save::Files && super::hosted::hosted(cx) {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(PREVIEW_DELAY_MS)).await;
                this.update(cx, |this, cx| {
                    let (Some(path), Some(inputs)) = (this.path.clone(), this.inputs.as_ref()) else { return };
                    if this.generation[ix] == generation {
                        let text = inputs.files.read(cx).value().to_string();
                        super::hosted::preview_files(&path, &text, cx);
                    }
                })
                .ok();
            })
            .detach();
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SAVE_DELAY_MS as u64)).await;
            this.update(cx, |this, cx| {
                if this.generation[ix] == generation {
                    this.flush(save, cx);
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Saves what is waiting for `save`, now.
    pub fn flush(&mut self, save: Save, cx: &mut Context<Self>) {
        let ix = slot(save);
        if !self.pending[ix] {
            return;
        }
        self.pending[ix] = false;
        let (Some(path), Some(inputs)) = (self.path.clone(), self.inputs.as_ref()) else { return };
        match save {
            Save::Branch => {
                if let Some(draft) = self.draft(cx) {
                    cx.update_global::<ProjectsStore, _>(|store, _| store.save_branch(&path, &draft));
                    self.save_branch_on_host(&path, cx);
                }
            }
            Save::Files => {
                let text = inputs.files.read(cx).value().to_string();
                cx.update_global::<ProjectsStore, _>(|store, _| store.save_files(&path, &text));
                if super::hosted::hosted(cx) {
                    super::hosted::save_files(&path, &text, cx);
                }
            }
            Save::Setup => {
                let text = inputs.setup.read(cx).value().to_string();
                cx.update_global::<ProjectsStore, _>(|store, _| store.save_setup(&path, &text));
                if super::hosted::hosted(cx) {
                    super::hosted::save_setup(&path, &text, cx);
                }
            }
        }
    }

    /// The personal overrides the store just worked out, to a data layer's host (`project-git:save`).
    fn save_branch_on_host(&mut self, path: &str, cx: &mut Context<Self>) {
        if super::hosted::hosted(cx) {
            let local = cx.global::<ProjectsStore>().get(path).branch.local;
            super::hosted::save_branch(path, &local, cx);
        }
    }

    /// A checkbox changed: the draft saves at once.
    fn save_now(&mut self, patch: impl FnOnce(&mut BranchPolicy), cx: &mut Context<Self>) {
        let (Some(path), Some(mut draft)) = (self.path.clone(), self.draft(cx)) else { return };
        patch(&mut draft);
        let check = branch_policy_check(&draft);
        if !check.template.is_empty() || !check.base_branch.is_empty() {
            return;
        }
        self.pending[0] = false;
        cx.update_global::<ProjectsStore, _>(|store, _| store.save_branch(&path, &draft));
        self.save_branch_on_host(&path, cx);
    }

    /// "Reset to defaults": drops the personal overrides and shows what applies again.
    fn reset_branch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.path.clone() else { return };
        self.pending[0] = false;
        self.generation[0] += 1;
        cx.update_global::<ProjectsStore, _>(|store, _| store.reset_branch(&path));
        self.save_branch_on_host(&path, cx);
        let effective = cx.global::<ProjectsStore>().get(&path).branch.effective();
        if let Some(inputs) = &self.inputs {
            inputs.template.update(cx, |s, cx| s.set_value(effective.template.clone(), window, cx));
            inputs.username.update(cx, |s, cx| s.set_value(effective.username.clone(), window, cx));
            inputs.base.update(cx, |s, cx| s.set_value(effective.base_branch.clone(), window, cx));
            inputs.instructions.update(cx, |s, cx| s.set_value(effective.instructions.clone(), window, cx));
        }
        cx.notify();
    }

    fn add_token(&mut self, token: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(inputs) = &self.inputs else { return };
        let template = inputs.template.clone();
        let before = {
            let state = template.read(cx);
            let value = state.value().to_string();
            let at = state.cursor().min(value.len());
            value[..at].to_string()
        };
        let text = token_text(&before, token);
        template.update(cx, |state, cx| {
            state.insert(text, window, cx);
            state.focus(window, cx);
        });
        self.edited(Save::Branch, cx);
    }

    fn choose_icon(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.path.clone() else { return };
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(files))) = picked.await else { return };
            let Some(file) = files.first() else { return };
            let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("icon").to_string();
            this.update(cx, |this, cx| {
                if ["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) {
                    let hue = name.bytes().fold(7u32, |acc, b| acc.wrapping_mul(31).wrapping_add(u32::from(b))) % 360;
                    this.icon_error.clear();
                    cx.update_global::<ProjectsStore, _>(|store, _| store.set_icon(&path, Some(IconChoice { file: name, hue })));
                } else {
                    this.icon_error = "This file isn't an image Milagre can read.".into();
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn manage_accounts(&mut self, cx: &mut Context<Self>) {
        if let Some(modal) = self.modal.upgrade() {
            cx.defer(move |cx| {
                modal.update(cx, |modal, cx| modal.select_section(SelectedSection::Section(SettingsSectionId::Accounts), cx));
            });
        }
    }

    /// Remove Project: the host forgets it and the Settings page leaves for General.
    fn forget(&mut self, cx: &mut App) {
        let Some(path) = self.path.clone() else { return };
        cx.update_global::<ProjectsStore, _>(|store, _| store.forget(&path));
        if let Some(modal) = self.modal.upgrade() {
            cx.defer(move |cx| {
                modal.update(cx, |modal, cx| modal.select_section(SelectedSection::Section(SettingsSectionId::General), cx));
            });
        }
    }
}

fn card(rows: Vec<AnyElement>, theme: &Theme) -> gpui::Div {
    let mut card = div().rounded(RADIUS_CARD).border_1().border_color(theme.line).bg(theme.inset).overflow_hidden().flex().flex_col();
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
        }
        card = card.child(row);
    }
    card
}

fn field_block(label: &'static str, description: String, field: impl IntoElement, extra: Vec<AnyElement>, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .px(px(16.0))
        .py(px(12.0))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(label))
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(description)),
        )
        .child(field)
        .children(extra)
        .into_any_element()
}

fn tile_color(hue: u32) -> gpui::Rgba {
    hsla(hue as f32 / 360.0, 0.55, 0.42, 1.0).into()
}

impl Render for ProjectView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // A host's read landed: the fields are made again from it, unless something typed is still waiting to save.
        if let Some(path) = self.path.clone() {
            let loaded = cx.global::<ProjectsStore>().get(&path).loaded;
            if loaded != self.made_from && !self.pending.iter().any(|p| *p) {
                self.made_from = loaded;
                self.inputs = None;
                self.subs.clear();
            }
        }
        self.ensure_inputs(window, cx);
        let Some(path) = self.path.clone() else { return div().into_any_element() };
        let theme = *cx.theme();
        let entry = cx.global::<ProjectsStore>().get(&path);
        let found = self.found.clone();
        let found = found.as_deref();
        let remote = path.contains('|');
        let slug = crate::settings::group::slug(&self.name);

        // Appearance.
        let tile = match &entry.icon {
            Some(icon) => ProjectAvatar::new(&self.name).size(40.0).colors(tile_color(icon.hue), theme.on_ink),
            None => ProjectAvatar::new(&self.name).size(40.0),
        };
        let icon_row = div()
            .debug_selector(|| "project-icon-row".into())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.0))
                    .child(div().debug_selector(|| "project-icon-preview".into()).child(tile))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Icon"))
                            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(match &entry.icon {
                                Some(icon) => format!("{}. Reset goes back to the repository's own icon.", icon.file),
                                None => "Shown in the sidebar, the project switcher and on your phone. Reset goes back to the repository's own icon.".to_string(),
                            })),
                    )
                    .child(
                        Button::new("project-icon-choose", "Choose image")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .on_click(cx.listener(|this, _, _, cx| this.choose_icon(cx))),
                    )
                    .child({
                        let path = path.clone();
                        Button::new("project-icon-reset", "Reset").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.icon_error.clear();
                                let path = path.clone();
                                cx.update_global::<ProjectsStore, _>(|store, _| store.set_icon(&path, None));
                            }),
                        )
                    }),
            )
            .when(!self.icon_error.is_empty(), |d| d.child(InlineError::new(self.icon_error.clone()).small()));

        // Sidebar.
        let sidebar_row = CheckboxRow::new("project-show-in-sidebar", "Show in sidebar", !entry.hidden)
            .description("In the sidebar on This Mac. Filters \u{203a} Projects chooses them all at once.")
            .highlighted(found)
            .on_change({
                let path = path.clone();
                move |show, _, cx| {
                    let path = path.clone();
                    cx.update_global::<ProjectsStore, _>(|store, _| store.set_hidden(&path, !show));
                    if super::hosted::hosted(cx) {
                        super::hosted::set_hidden(&path, !show, cx);
                    }
                }
            });

        // Worktrees: how the source branch is synced.
        let default_on = cx.try_global::<DevicesStore>().is_some_and(|s| s.main_sync_default);
        let sync_options: Vec<SelectOption> = main_sync_choices(default_on).into_iter().map(|(v, l)| SelectOption::new(v, l)).collect();
        let sync_row = SettingRow::new(MAIN_SYNC_TITLE)
            .description(main_sync_status_line(entry.main_sync_last.as_ref(), now_ms()))
            .highlighted(found)
            .control(Select::new("project-main-sync", entry.main_sync.value(), sync_options).on_change({
                let path = path.clone();
                move |value, _, cx| {
                    let choice = MainSyncChoice::parse(value);
                    let path = path.clone();
                    cx.update_global::<ProjectsStore, _>(|store, _| store.set_main_sync(&path, choice));
                    if super::hosted::hosted(cx) {
                        super::hosted::save_main_sync(&path, choice, cx);
                    }
                }
            }));

        let branches = self.branches_group(&entry, window, cx);
        let files = self.files_block(&entry, &theme, cx);
        let setup = self.setup_block(&entry, &theme, cx);

        let remove_name = self.name.clone();
        let remove = SettingsGroup::new().title("Remove Project").highlighted_row(found.map(|f| SharedString::from(f.to_string()))).row(
            SettingRow::new("Remove from Projects list")
                .description("Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back.")
                .highlighted(found)
                .control(
                    Button::new("project-remove", "Remove Project")
                        .variant(ButtonVariant::DangerGhost)
                        .size(ButtonSize::S28)
                        .on_click(cx.listener(move |this, _, window, cx| this.open_remove_dialog(&remove_name, window, cx))),
                ),
        );

        let hl = found.map(|f| SharedString::from(f.to_string()));
        // A data layer lists only the groups it backs (`preview::settings_row_shows`); a host's refusal shows under its group.
        let shows = |title: &str| settings_row_shows(cx, SettingsSectionId::Project, title);
        let error = |group: &str| {
            entry.errors.get(group).map(|message| {
                div()
                    .debug_selector({
                        let group = group.to_string();
                        move || format!("project-error-{group}")
                    })
                    .mt(px(-12.0))
                    .mb(px(20.0))
                    .px(px(4.0))
                    .text_step(TEXT_12)
                    .text_color(theme.red_ink)
                    .child(message.clone())
            })
        };
        let (show_appearance, show_accounts, show_remove) = (shows("Appearance"), shows("Accounts"), shows("Remove Project"));
        div()
            .debug_selector(move || format!("settings-section-project-{slug}"))
            .flex()
            .flex_col()
            .child(page_header(self.name.clone(), None, cx))
            .when(show_appearance, |d| d.child(SettingsGroup::new().title("Appearance").highlighted_row(hl.clone()).row(icon_row)))
            .child(SettingsGroup::new().title("Sidebar").highlighted_row(hl.clone()).row(sidebar_row))
            .children(error("sidebar"))
            .when(!remote && show_accounts, |d| d.child(self.accounts_group(&path, &theme, cx)))
            .child(SettingsGroup::new().title("Worktrees").highlighted_row(hl.clone()).row(sync_row))
            .children(error("sync"))
            .child(branches)
            .children(error("branch"))
            .child(SettingsGroup::new().title("New worktrees").highlighted_row(hl).row(files).row(setup))
            .children(error("files"))
            .children(error("setup"))
            .when(show_remove, |d| d.child(remove))
            .into_any_element()
    }
}

impl ProjectView {
    fn open_remove_dialog(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let this = cx.weak_entity();
        Dialog::new(format!("Remove {name}?"))
            .description("This removes the Project from the list on your computer and paired phones. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back. Running Chats keep running.")
            .action(DialogAction::new("project-remove-cancel", "Cancel").variant(ButtonVariant::Ghost))
            .action(DialogAction::new("project-remove-confirm", "Remove Project").variant(ButtonVariant::Danger).on_click(move |_, cx| {
                this.update(cx, |this, cx| this.forget(cx)).ok();
            }))
            .open(window, cx);
    }

    /// The Accounts section of a local Project: one account choice per installed provider.
    fn accounts_group(&mut self, path: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let rows: Vec<ProjectProvider> = cx.try_global::<AccountsStore>().map(|store| store.project_accounts(path)).unwrap_or_default();
        let provider_rows: Vec<AnyElement> = rows
            .iter()
            .map(|view| {
                let provider: Provider = view.provider;
                let scope = path.to_string();
                let options: Vec<SelectOption> = view
                    .choices()
                    .into_iter()
                    .map(|choice| {
                        let mut option = SelectOption::new(choice.value, choice.label).disabled(choice.disabled);
                        if let Some(description) = choice.description {
                            option = option.description(description);
                        }
                        option
                    })
                    .collect();
                let note = if view.missing() {
                    Some("The assigned account is unavailable. Choose another saved account.".to_string())
                } else if view.needs_sign_in() {
                    view.effective().map(|entry| format!("{} \u{b7} {}", entry.title(), status_label(entry.account.state)))
                } else {
                    None
                };
                div()
                    .debug_selector(move || format!("project-account-{}", provider.id()))
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .child(
                        div()
                            .flex()
                            .min_h(px(32.0))
                            .items_center()
                            .justify_between()
                            .gap(px(16.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child(ProviderLogo::new(provider).size(18.0))
                                    .child(provider.name()),
                            )
                            .child(
                                Select::new(
                                    SharedString::from(format!("project-account-select-{}", provider.id())),
                                    view.account_id.clone().unwrap_or_default(),
                                    options,
                                )
                                .width(300.0)
                                .on_change(move |value, _, cx| {
                                    let scope = scope.clone();
                                    let value = value.to_string();
                                    cx.update_global::<AccountsStore, _>(|store, _| store.assign(&scope, provider, Some(&value)));
                                }),
                            ),
                    )
                    .children(note.map(|text| div().pl(px(26.0)).text_step(TEXT_12).text_color(theme.red_ink).child(text)))
                    .into_any_element()
            })
            .collect();
        div()
            .debug_selector(|| "project-accounts-group".into())
            .mb(px(24.0))
            .flex()
            .flex_col()
            .child(div().mb(px(8.0)).px(px(4.0)).child(SectionLabel::new("Accounts")))
            .child(card(provider_rows, theme))
            .child(
                div()
                    .mt(px(8.0))
                    .px(px(4.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child("Running replies keep their original account. The next turn uses the one chosen here. ")
                    .child(
                        div()
                            .id("project-manage-accounts")
                            .cursor_pointer()
                            .text_color(theme.accent_ink)
                            .on_click(cx.listener(|this, _, _, cx| this.manage_accounts(cx)))
                            .child("Manage saved accounts"),
                    ),
            )
            .into_any_element()
    }

    /// The Branches group, with Reset to defaults beside its title.
    fn branches_group(&mut self, entry: &super::model::ProjectEntry, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let _ = window;
        let (Some(draft), Some(inputs)) = (self.draft(cx), self.inputs.as_ref()) else { return div().into_any_element() };
        let check = branch_policy_check(&draft);
        let repo = &entry.branch.repository;
        let describe =
            |field: Field, fallback: &'static str| if repo.has(field) { BRANCH_REPOSITORY.to_string() } else { fallback.to_string() };
        let template_locked = repo.has(Field::Template);
        let (template, username, base, instructions) =
            (inputs.template.clone(), inputs.username.clone(), inputs.base.clone(), inputs.instructions.clone());
        let found = self.found.clone();

        let chips = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(16.0))
            .gap_y(px(8.0))
            .when(!template_locked, |d| {
                d.child(div().flex().gap(px(4.0)).children(BRANCH_TOKENS.iter().map(|token| {
                    let token: &'static str = token;
                    div()
                        .id(SharedString::from(format!("branch-token-{token}")))
                        .debug_selector(move || format!("branch-token-{token}"))
                        .h(px(24.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .rounded(RADIUS_CHIP)
                        .bg(theme.field)
                        .cursor_pointer()
                        .hover(move |s| s.bg(theme.hover))
                        .font_family(mono())
                        .text_step(TEXT_11)
                        .text_color(theme.ink2)
                        .on_click(cx.listener(move |this, _, window, cx| this.add_token(token, window, cx)))
                        .child(format!("{{{token}}}"))
                })))
            })
            .child(if check.template.is_empty() {
                div()
                    .flex()
                    .min_w_0()
                    .items_baseline()
                    .gap(px(8.0))
                    .text_step(TEXT_12)
                    .child(div().text_color(theme.ink3).child(BRANCH_EXAMPLE))
                    .child(
                        div()
                            .debug_selector(|| "branch-preview".into())
                            .font_family(mono())
                            .text_color(theme.ink)
                            .child(check.preview.clone()),
                    )
                    .into_any_element()
            } else {
                div()
                    .debug_selector(|| "branch-template-error".into())
                    .child(InlineError::new(check.template.clone()).small())
                    .into_any_element()
            });

        let username_locked = repo.has(Field::Username);
        let base_locked = repo.has(Field::BaseBranch);
        let mut rows: Vec<AnyElement> = vec![
            field_block(
                TEMPLATE_COPY.label,
                describe(Field::Template, TEMPLATE_COPY.description),
                Input::new("branch-template", &template).invalid(!check.template.is_empty()).disabled(template_locked),
                vec![chips.into_any_element()],
                &theme,
            ),
            SettingRow::new(USERNAME_COPY.label)
                .description(describe(Field::Username, USERNAME_COPY.description))
                .highlighted(found.as_deref())
                .control(div().w(px(240.0)).child(Input::new("branch-username", &username).disabled(username_locked)))
                .into_any_element(),
            CheckboxRow::new("branch-dashes", DASHES_COPY.label, draft.dashes_only)
                .description(describe(Field::DashesOnly, DASHES_COPY.description))
                .disabled(repo.has(Field::DashesOnly))
                .on_change(checkbox(cx, |this, next, cx| this.save_now(|d| d.dashes_only = next, cx)))
                .into_any_element(),
            div()
                .child(
                    SettingRow::new(BASE_COPY.label)
                        .description(describe(Field::BaseBranch, BASE_COPY.description))
                        .highlighted(found.as_deref())
                        .control(
                            div()
                                .w(px(240.0))
                                .child(Input::new("branch-base", &base).invalid(!check.base_branch.is_empty()).disabled(base_locked)),
                        ),
                )
                .when(!check.base_branch.is_empty(), |d| {
                    d.child(div().px(px(16.0)).pb(px(12.0)).child(InlineError::new(check.base_branch.clone()).small()))
                })
                .into_any_element(),
            CheckboxRow::new("branch-track", TRACK_COPY.label, draft.track_base)
                .description(describe(Field::TrackBase, TRACK_COPY.description))
                .disabled(repo.has(Field::TrackBase))
                .on_change(checkbox(cx, |this, next, cx| this.save_now(|d| d.track_base = next, cx)))
                .into_any_element(),
            field_block(
                INSTRUCTIONS_COPY.label,
                describe(Field::Instructions, INSTRUCTIONS_COPY.description),
                TextArea::new("branch-instructions", &instructions).disabled(repo.has(Field::Instructions)),
                Vec::new(),
                &theme,
            ),
        ];
        let _ = &mut rows;
        let has_overrides = !entry.branch.local.is_empty();
        div()
            .debug_selector(|| "project-branches".into())
            .mb(px(24.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(6.0))
                    .px(px(4.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(BRANCH_TITLE))
                    .when(has_overrides, |d| {
                        d.child(
                            Button::new("branch-reset", BRANCH_RESET)
                                .variant(ButtonVariant::Link)
                                .size(ButtonSize::S24)
                                .on_click(cx.listener(|this, _, window, cx| this.reset_branch(window, cx))),
                        )
                    }),
            )
            .child(card(rows, &theme))
            .child(div().mt(px(8.0)).px(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(BRANCH_FOOTER))
            .into_any_element()
    }

    fn files_block(&mut self, entry: &super::model::ProjectEntry, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(inputs) = &self.inputs else { return div().into_any_element() };
        let locked = entry.worktree_include.is_some();
        let text = inputs.files.read(cx).value().to_string();
        let path = self.path.clone().unwrap_or_default();
        let matches = cx.global::<ProjectsStore>().preview_files(&path, &text);
        let mut extra: Vec<AnyElement> = Vec::new();
        if locked {
            extra.push(
                div()
                    .debug_selector(|| "files-to-copy-locked".into())
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(".worktreeinclude in the repo wins. Edit that file to change what is copied.")
                    .into_any_element(),
            );
        }
        extra.push(
            div()
                .debug_selector(|| "files-to-copy-preview".into())
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(preview_sentence(&matches, 6))
                .into_any_element(),
        );
        div()
            .debug_selector(|| "project-files-to-copy".into())
            .child(field_block(
                "Files to copy",
                format!(
                    "Git-ignored files copied from the main checkout into each new worktree, such as env files. One pattern per line, .gitignore syntax. Leave empty for {DEFAULT_FILES_TO_COPY}."
                ),
                TextArea::new("files-to-copy", &inputs.files).disabled(locked),
                extra,
                theme,
            ))
            .into_any_element()
    }

    fn setup_block(&mut self, entry: &super::model::ProjectEntry, theme: &Theme, _cx: &mut Context<Self>) -> AnyElement {
        let Some(inputs) = &self.inputs else { return div().into_any_element() };
        let locked = entry.setup_settings.repo.is_some();
        let mut extra: Vec<AnyElement> = Vec::new();
        if locked {
            extra.push(
                div()
                    .debug_selector(|| "setup-command-locked".into())
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(".milagre/worktree.json in the repo wins. Edit its \"setup\" to change the command.")
                    .into_any_element(),
            );
        }
        if let Some(note) = &entry.setup_settings.note {
            extra.push(div().text_step(TEXT_12).text_color(theme.red_ink).child(note.clone()).into_any_element());
        }
        div()
            .debug_selector(|| "project-setup-command".into())
            .child(field_block(
                "Setup command",
                "Runs once in each new Worktree before the agent starts, e.g. npm ci.".to_string(),
                Input::new("setup-command", &inputs.setup).disabled(locked),
                extra,
                theme,
            ))
            .into_any_element()
    }
}

/// A checkbox handler that calls back into the view with the new value.
fn checkbox(
    cx: &Context<ProjectView>,
    f: impl Fn(&mut ProjectView, bool, &mut Context<ProjectView>) + 'static,
) -> impl Fn(bool, &mut Window, &mut App) + 'static {
    let this = cx.weak_entity();
    move |next, _, cx| {
        this.update(cx, |this, cx| {
            f(this, next, cx);
            cx.notify();
        })
        .ok();
    }
}
