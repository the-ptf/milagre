//! Settings › Keybindings (`KeybindingsSettings.tsx`, as T3 Code has it): the rules of a computer's keybindings.json,
//! edited on one computer or on every online one at once.
//!
//! Each command is a row with the keys it has as chips. A chip records a new key when pressed: every key goes to
//! this view first (GPUI runs a key's bound action before any key-down handler, so the view takes the press in a
//! keystroke interceptor, while it has the keyboard, and stops it there: the app's own shortcuts and the dialog's
//! Escape do not run), Escape stops, Backspace or Delete takes the key off, and a key with no Cmd, Ctrl or Alt, or
//! one another command already has, waits for the user (OK, or Replace). Advanced adds a When button per row and a
//! field for each rule's condition, saved on Enter or on leaving the field once it reads.
//!
//! Not built: the pulsing "Press keys…" chip (GPUI has no keyframes on divs; it is drawn steady), scrolling the
//! row of a newly added keybinding into view (the Settings body's scroll handle is the dialog's), the monospace
//! face in the condition field (the input widget has one font), and a plus glyph in the Add keybinding trigger.

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, App, Context, ElementId, Entity, FocusHandle, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, Keystroke,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::logic::{
    self, ALL, CONDITIONS_DESCRIPTION, Captured, Edit, IS_MAC, Pending, RESET_ALL_PROMPT, Recording, WHEN_INVALID, WHEN_PLACEHOLDER, label,
    pending_message,
};
use super::model::KeybindingsStore;
use crate::data::LOCAL;
use crate::logic::keybindings::catalog::{CommandGroup, KEYBINDING_COMMANDS};
use crate::logic::keybindings::rules::is_default;
use crate::logic::keybindings::{KeybindingCommand, KeybindingRule};
use crate::settings::group::{CheckboxRow, SettingsGroup, page_header};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt, mono};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, EmptySize, EmptyState, FieldSize, Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError,
    Input, Select, SelectOption, SelectVariant, ShortcutKeys, Tooltip,
};

const GROUPS: [CommandGroup; 4] = [CommandGroup::General, CommandGroup::Navigation, CommandGroup::Chat, CommandGroup::Panels];

/// A condition field: its text state, and the subscriptions that save it.
struct WhenField {
    input: Entity<InputState>,
    _subs: Vec<Subscription>,
}

pub struct KeybindingsView {
    scope: String,
    this_mac: String,
    computers: Vec<(String, String, bool)>,
    found: Option<String>,
    search: Option<Entity<InputState>>,
    _search_sub: Option<Subscription>,
    recording: Option<Recording>,
    pending: Option<Pending>,
    failures: Vec<String>,
    confirm_reset: bool,
    /// Commands whose condition fields are open.
    editing: HashSet<String>,
    /// Keyed by command, rule index and the saved condition, so a change from elsewhere starts the field over.
    whens: HashMap<(String, usize, String), WhenField>,
    focus: FocusHandle,
    _intercept: Subscription,
}

impl KeybindingsView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        cx.observe_global::<KeybindingsStore>(|_, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        let weak = cx.weak_entity();
        let recording_focus = focus.clone();
        // While a key is recorded no press reaches an action (Cmd-, or Cmd-N would run instead of being recorded).
        let intercept = cx.intercept_keystrokes(move |event, window, cx| {
            let Some(view) = weak.upgrade() else { return };
            if view.read(cx).recording.is_some() && recording_focus.contains_focused(window, cx) {
                cx.stop_propagation();
                view.update(cx, |this, cx| this.on_press(&event.keystroke, cx));
            }
        });
        let mut view = Self {
            scope: ALL.to_string(),
            this_mac: "This Mac".to_string(),
            computers: Vec::new(),
            found: None,
            search: None,
            _search_sub: None,
            recording: None,
            pending: None,
            failures: Vec::new(),
            confirm_reset: false,
            editing: HashSet::new(),
            whens: HashMap::new(),
            focus,
            _intercept: intercept,
        };
        view.snapshot_state(cx);
        view
    }

    /// Snapshot aid: `MILAGRE_GPUI_KEYBINDINGS=recording|pending|advanced` opens the page in that state.
    fn snapshot_state(&mut self, cx: &mut Context<Self>) {
        let Ok(state) = std::env::var("MILAGRE_GPUI_KEYBINDINGS") else { return };
        match state.as_str() {
            "recording" => self.recording = Some(Recording { command: "terminal.new".into(), index: Some(0) }),
            "pending" => {
                let recording = Recording { command: "terminal.new".into(), index: Some(0) };
                let key_event = logic::key_event(&Keystroke::parse("cmd-n").expect("a keystroke"));
                if let Captured::Ask(pending) = logic::capture(&self.rules(cx), &recording, &key_event, IS_MAC) {
                    self.pending = Some(pending);
                }
            }
            "advanced" => {
                cx.update_global::<KeybindingsStore, _>(|store, _| store.advanced = true);
                self.editing.insert("theme.toggle".to_string());
            }
            _ => {}
        }
    }

    /// The computers to offer and the row a Settings search result lit up.
    pub fn set_context(&mut self, this_mac: &str, computers: &[(String, String, bool)], found: Option<&str>, cx: &mut Context<Self>) {
        let found = found.map(str::to_string);
        if self.this_mac != this_mac || self.computers != computers || self.found != found {
            this_mac.clone_into(&mut self.this_mac);
            self.computers = computers.to_vec();
            self.found = found;
            cx.notify();
        }
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    pub fn recording(&self) -> Option<&Recording> {
        self.recording.as_ref()
    }

    pub fn pending(&self) -> Option<&Pending> {
        self.pending.as_ref()
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    /// The search field's text state, once the page has drawn.
    pub fn search_state(&self) -> Option<Entity<InputState>> {
        self.search.clone()
    }

    /// The condition field of a rule, once it was drawn under that saved condition.
    pub fn when_input(&self, command: &str, index: usize, saved: &str) -> Option<Entity<InputState>> {
        self.whens.get(&(command.to_string(), index, saved.to_string())).map(|field| field.input.clone())
    }

    pub fn query(&self, cx: &App) -> String {
        self.search.as_ref().map(|input| input.read(cx).value().to_string()).unwrap_or_default()
    }

    /// Which computer's rules are on screen.
    fn shown_id(&self) -> String {
        if self.scope == ALL { LOCAL.to_string() } else { self.scope.clone() }
    }

    fn online(&self) -> Vec<&(String, String, bool)> {
        self.computers.iter().filter(|(_, _, online)| *online).collect()
    }

    /// The computers an edit goes to.
    fn targets(&self) -> Vec<String> {
        if self.scope == ALL {
            std::iter::once(LOCAL.to_string()).chain(self.online().into_iter().map(|(id, _, _)| id.clone())).collect()
        } else {
            vec![self.scope.clone()]
        }
    }

    fn name_of(&self, id: &str) -> String {
        if id == LOCAL {
            return self.this_mac.clone();
        }
        self.computers.iter().find(|(computer, _, _)| computer == id).map_or_else(|| "Computer".to_string(), |(_, name, _)| name.clone())
    }

    fn rules(&self, cx: &App) -> Vec<KeybindingRule> {
        cx.global::<KeybindingsStore>().get(&self.shown_id()).state.rules
    }

    fn ensure_search(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = &self.search {
            return input.clone();
        }
        let input = Input::state("Search keybindings", window, cx);
        self._search_sub = Some(cx.observe(&input, |_, _, cx| cx.notify()));
        self.search = Some(input.clone());
        input
    }

    /// Works an edit out from each computer's own rules and applies it on every computer in scope.
    fn apply(&mut self, edit: impl Fn(&[KeybindingRule]) -> Edit, cx: &mut Context<Self>) {
        let mut failures = Vec::new();
        for id in self.targets() {
            let result = cx.update_global::<KeybindingsStore, _>(|store, _| {
                let keys = store.get(&id);
                if let Some(error) = keys.read_error {
                    return Err(error);
                }
                store.apply(&id, &edit(&keys.state.rules))
            });
            if let Err(error) = result {
                failures.push(format!("{}: {error}", self.name_of(&id)));
            }
        }
        self.failures = failures;
        cx.notify();
    }

    pub fn set_scope(&mut self, scope: &str, cx: &mut Context<Self>) {
        self.scope = scope.to_string();
        self.recording = None;
        self.pending = None;
        self.failures.clear();
        cx.notify();
    }

    /// Starts recording a key on a rule of `command` (a new one when `index` is none) and takes the keyboard.
    pub fn record(&mut self, command: &str, index: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        self.pending = None;
        self.recording = Some(Recording { command: command.to_string(), index });
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn save(&mut self, recording: Recording, key: String, take: Vec<String>, cx: &mut Context<Self>) {
        self.pending = None;
        self.recording = None;
        self.apply(move |rules| logic::save_edit(rules, &recording, &key, &take, IS_MAC), cx);
    }

    pub fn remove_rule(&mut self, command: &str, index: usize, cx: &mut Context<Self>) {
        self.recording = None;
        self.pending = None;
        let command = command.to_string();
        self.apply(move |rules| logic::remove_edit(rules, &command, index), cx);
    }

    fn set_when(&mut self, command: &str, index: usize, when: &str, cx: &mut Context<Self>) {
        let (command, when) = (command.to_string(), when.to_string());
        self.apply(move |rules| logic::when_edit(rules, &command, index, &when), cx);
    }

    fn reset_command(&mut self, command: &str, cx: &mut Context<Self>) {
        let command = command.to_string();
        self.apply(move |_| logic::reset_edit(&command), cx);
    }

    fn reset_all(&mut self, cx: &mut Context<Self>) {
        self.confirm_reset = false;
        let mut failures = Vec::new();
        for id in self.targets() {
            if let Err(error) = cx.update_global::<KeybindingsStore, _>(|store, _| store.reset_all(&id)) {
                failures.push(format!("{}: {error}", self.name_of(&id)));
            }
        }
        self.failures = failures;
        cx.notify();
    }

    /// Replace: the pending key goes on its rule, taken from the commands that had it.
    pub fn replace_pending(&mut self, cx: &mut Context<Self>) {
        if let Some(pending) = self.pending.take() {
            self.save(pending.recording, pending.key, pending.conflicts, cx);
        }
    }

    pub fn cancel_pending(&mut self, cx: &mut Context<Self>) {
        self.pending = None;
        cx.notify();
    }

    /// While a key is recorded every press comes here first.
    pub fn on_press(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) {
        let Some(recording) = self.recording.clone() else { return };
        let rules = self.rules(cx);
        match logic::capture(&rules, &recording, &logic::key_event(keystroke), IS_MAC) {
            Captured::Cancel => self.recording = None,
            Captured::Remove => {
                if let Some(index) = recording.index {
                    self.remove_rule(&recording.command, index, cx);
                }
            }
            Captured::Ignore => {}
            Captured::Save(key) => self.save(recording, key, Vec::new(), cx),
            Captured::Ask(pending) => {
                self.pending = Some(pending);
                self.recording = None;
            }
        }
        cx.notify();
    }

    /// The condition field of one rule, made on first use.
    fn when_field(&mut self, command: &str, index: usize, saved: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        let key = (command.to_string(), index, saved.to_string());
        if let Some(field) = self.whens.get(&key) {
            return field.input.clone();
        }
        let input = Input::state(WHEN_PLACEHOLDER, window, cx);
        input.update(cx, |state, cx| state.set_value(saved.to_string(), window, cx));
        let commit = {
            let (command, saved) = (command.to_string(), saved.to_string());
            let input = input.clone();
            move |this: &mut Self, cx: &mut Context<Self>| {
                let draft = input.read(cx).value().to_string();
                if logic::when_check(&draft).invalid || draft.trim() == saved {
                    return;
                }
                this.set_when(&command, index, &draft, cx);
            }
        };
        let subs = vec![
            cx.observe(&input, |_, _, cx| cx.notify()),
            cx.subscribe(&input, move |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                    commit(this, cx);
                }
            }),
        ];
        self.whens.insert(key, WhenField { input: input.clone(), _subs: subs });
        input
    }
}

fn row_id(prefix: &str, command: &str, index: usize) -> ElementId {
    ElementId::Name(SharedString::from(format!("{prefix}-{command}-{index}")))
}

impl Render for KeybindingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let search = self.ensure_search(window, cx);
        let query = search.read(cx).value().to_string();
        let store = cx.global::<KeybindingsStore>().clone();
        let shown_id = self.shown_id();
        let keys = store.get(&shown_id);
        let rules = keys.state.rules.clone();
        let advanced = store.advanced;
        let found = self.found.clone();
        let entity = cx.entity();
        let online = self.online().len();
        let this_computer = if IS_MAC { "This Mac" } else { "This computer" };

        // Applying to.
        let mut scope_options = vec![
            SelectOption::new(ALL, "All computers").description(if online > 0 {
                format!("{this_computer} and {online} more")
            } else {
                this_computer.to_string()
            }),
            SelectOption::new(LOCAL, self.this_mac.clone()).description(this_computer),
        ];
        for (id, name, is_online) in &self.computers {
            scope_options.push(
                SelectOption::new(id.clone(), name.clone())
                    .description(if *is_online { "Online" } else { "Offline" })
                    .disabled(!*is_online),
            );
        }
        let scope_select = {
            let entity = entity.clone();
            Select::new("kb-scope", self.scope.clone(), scope_options)
                .variant(SelectVariant::Text)
                .width(260.0)
                .on_change(move |value, _, cx| entity.update(cx, |this, cx| this.set_scope(value, cx)))
        };
        let intro = format!(
            "Each computer keeps its keys in a keybindings.json; the last rule whose key and condition match runs.{}",
            if self.scope == ALL && online > 0 { " Changes here go to every computer that is online." } else { "" }
        );

        // The toolbar.
        let add_options = std::iter::once(SelectOption::new("", "Add keybinding").disabled(true))
            .chain(KEYBINDING_COMMANDS.iter().map(|command| SelectOption::new(command.id, command.title).group(command.group.title())));
        let add_select = {
            let entity = entity.clone();
            Select::new("kb-add", "", add_options).searchable().width(300.0).on_change(move |value, window, cx| {
                if value.is_empty() {
                    return;
                }
                let command = value.to_string();
                entity.update(cx, |this, cx| {
                    if let Some(search) = &this.search {
                        search.update(cx, |state, cx| state.set_value("", window, cx));
                    }
                    this.record(&command, None, window, cx);
                });
            })
        };
        let add_wrap = div()
            .debug_selector(|| "kb-add-wrap".into())
            .rounded(RADIUS_CONTROL)
            .when(found.as_deref() == Some("Add keybinding"), |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
            .child(add_select);
        let open_file = (shown_id == LOCAL).then(|| {
            let entity = entity.clone();
            div().id("kb-open-file-tip").tooltip(Tooltip::text("Open keybindings.json")).child(
                IconButton::new("kb-open-file", IconName::FileEdit).size(IconButtonSize::S32).on_click(move |_, _, cx| {
                    entity.update(cx, |_, cx| cx.update_global::<KeybindingsStore, _>(|store, _| store.opened_file += 1));
                }),
            )
        });
        let toolbar = div()
            .mt(px(20.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(div().min_w_0().flex_1().child(Input::new("kb-search", &search).size(FieldSize::S32).leading(IconName::Search01)))
            .children(open_file)
            .child(add_wrap);

        // Notices.
        let mut notices: Vec<AnyElement> = Vec::new();
        if let Some(error) = &keys.read_error {
            notices.push(notice(format!("Couldn't read keybindings on {}: {error}", self.name_of(&shown_id)), None, "kb-notice-read", cx));
        }
        if !keys.state.issues.is_empty() {
            notices.push(notice("keybindings.json has problems.".to_string(), Some(keys.state.issues.clone()), "kb-notice-issues", cx));
        }
        for (ix, failure) in self.failures.iter().enumerate() {
            notices.push(notice(format!("Couldn't save on {failure}"), None, &format!("kb-notice-failure-{ix}"), cx));
        }

        // The groups.
        let shown: Vec<&KeybindingCommand> =
            KEYBINDING_COMMANDS.iter().filter(|command| logic::matches(command, &rules, &query, IS_MAC)).collect();
        let mut groups: Vec<AnyElement> = Vec::new();
        for group in GROUPS {
            let commands: Vec<&&KeybindingCommand> = shown.iter().filter(|command| command.group == group).collect();
            if commands.is_empty() {
                continue;
            }
            let mut rows: Vec<AnyElement> = Vec::new();
            for command in commands {
                rows.push(self.command_row(command, &rules, advanced, window, cx));
            }
            groups.push(SettingsGroup::new().title(group.title()).rows(rows).into_any_element());
        }

        let empty = shown
            .is_empty()
            .then(|| div().mt(px(24.0)).child(EmptyState::new().size(EmptySize::Compact).title(format!("No keybindings match “{query}”"))));

        // Advanced.
        let advanced_group = {
            let entity = entity.clone();
            SettingsGroup::new().title("Advanced").highlighted_row(found.clone().map(SharedString::from)).row(
                CheckboxRow::new("kb-advanced", "Conditions", advanced)
                    .description(CONDITIONS_DESCRIPTION)
                    .highlighted(found.as_deref())
                    .on_change(move |on, _, cx| {
                        cx.update_global::<KeybindingsStore, _>(|store, _| store.advanced = on);
                        entity.update(cx, |_, cx| cx.notify());
                    }),
            )
        };

        // Reset all.
        let reset_all = if self.confirm_reset {
            let (cancel, confirm) = (entity.clone(), entity.clone());
            let every = if self.targets().len() > 1 { " on every computer" } else { "" };
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().text_color(theme.ink2).child(format!("{RESET_ALL_PROMPT}{every}?")))
                .child(Button::new("kb-reset-all-cancel", "Cancel").variant(ButtonVariant::Ghost).size(ButtonSize::S24).on_click(
                    move |_, _, cx| {
                        cancel.update(cx, |this, cx| {
                            this.confirm_reset = false;
                            cx.notify();
                        })
                    },
                ))
                .child(
                    Button::new("kb-reset-all-confirm", "Reset all")
                        .variant(ButtonVariant::Danger)
                        .size(ButtonSize::S24)
                        .on_click(move |_, _, cx| confirm.update(cx, |this, cx| this.reset_all(cx))),
                )
                .into_any_element()
        } else {
            let ask = entity.clone();
            div()
                .rounded(RADIUS_CONTROL)
                .when(found.as_deref() == Some("Reset all to defaults"), |d| {
                    d.bg(theme.hover2).debug_selector(|| "settings-found-row".into())
                })
                .child(Button::new("kb-reset-all", "Reset all to defaults").variant(ButtonVariant::Link).size(ButtonSize::S24).on_click(
                    move |_, _, cx| {
                        ask.update(cx, |this, cx| {
                            this.confirm_reset = true;
                            cx.notify();
                        })
                    },
                ))
                .into_any_element()
        };

        div()
            .id("kb-root")
            .debug_selector(|| "settings-section-keybindings".into())
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .child(page_header("Keybindings", None, cx))
            .child(
                div().flex().items_center().gap(px(4.0)).text_step(TEXT_13).text_color(theme.ink2).child("Applying to").child(scope_select),
            )
            .child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(intro))
            .child(toolbar)
            .children(notices)
            .child(div().mt(px(20.0)).flex().flex_col().children(groups))
            .children(empty)
            .child(advanced_group)
            .child(div().mt(px(24.0)).px(px(4.0)).flex().items_center().justify_end().gap(px(8.0)).text_step(TEXT_12).child(reset_all))
    }
}

impl KeybindingsView {
    /// One command: its title and id, its keys as chips, and what waits on the user.
    fn command_row(
        &mut self,
        command: &KeybindingCommand,
        rules: &[KeybindingRule],
        advanced: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = *cx.theme();
        let entity = cx.entity();
        let id = command.id;
        let own = logic::own(rules, id);
        let customized = !is_default(rules, id);
        let recording = self.recording.as_ref().filter(|recording| recording.command == id).map(|recording| recording.index);
        let pending = self.pending.clone().filter(|pending| pending.recording.command == id);
        let editing = advanced && self.editing.contains(id) && !own.is_empty();

        let mut keys: Vec<AnyElement> = Vec::new();
        for (index, rule) in own.iter().enumerate() {
            if recording == Some(Some(index)) {
                keys.push(recording_chip(cx));
                continue;
            }
            keys.push(self.key_chip(id, index, &rule.key, rule.when.as_deref(), cx));
        }
        if recording == Some(None) {
            keys.push(recording_chip(cx));
        } else if own.is_empty() {
            let record = entity.clone();
            keys.push(
                Button::new(format!("kb-add-key-{id}"), "Unbound · Add key")
                    .variant(ButtonVariant::Quiet)
                    .size(ButtonSize::S24)
                    .on_click(move |_, window, cx| record.update(cx, |this, cx| this.record(id, None, window, cx)))
                    .into_any_element(),
            );
        } else {
            let record = entity.clone();
            keys.push(
                div()
                    .id(format!("kb-add-key-tip-{id}"))
                    .tooltip(Tooltip::text("Add another key"))
                    .child(
                        IconButton::new(format!("kb-add-key-{id}"), IconName::PlusSign)
                            .size(IconButtonSize::S24)
                            .on_click(move |_, window, cx| record.update(cx, |this, cx| this.record(id, None, window, cx))),
                    )
                    .into_any_element(),
            );
        }
        if advanced && !own.is_empty() {
            let toggle = entity.clone();
            keys.push(
                div()
                    .id(format!("kb-when-toggle-{id}"))
                    .debug_selector(move || format!("kb-when-toggle-{id}"))
                    .h(px(24.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .rounded(RADIUS_CONTROL)
                    .cursor_pointer()
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if editing { theme.ink } else { theme.ink2 })
                    .when(editing, |d| d.bg(theme.hover2))
                    .when(!editing, |d| d.hover(move |s| s.bg(theme.hover).text_color(theme.ink)))
                    .on_click(move |_, _, cx| {
                        toggle.update(cx, |this, cx| {
                            if !this.editing.remove(id) {
                                this.editing.insert(id.to_string());
                            }
                            cx.notify();
                        })
                    })
                    .child("When")
                    .into_any_element(),
            );
        }
        if customized {
            let reset = entity.clone();
            keys.push(
                div()
                    .id(format!("kb-reset-tip-{id}"))
                    .tooltip(Tooltip::text("Back to default"))
                    .child(
                        IconButton::new(format!("kb-reset-{id}"), IconName::Undo02)
                            .size(IconButtonSize::S24)
                            .on_click(move |_, _, cx| reset.update(cx, |this, cx| this.reset_command(id, cx))),
                    )
                    .into_any_element(),
            );
        } else {
            keys.push(div().size(px(24.0)).into_any_element());
        }

        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .min_h(px(32.0))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(command.title))
                    .child(div().truncate().text_step(TEXT_11).font_family(mono()).text_color(theme.ink3).child(id)),
            )
            .child(div().flex_none().flex().flex_wrap().items_center().justify_end().gap(px(6.0)).children(keys));

        let pending_panel = pending.map(|pending| {
            let (cancel, replace) = (entity.clone(), entity.clone());
            let error = pending.error.is_some();
            div()
                .debug_selector(move || format!("kb-pending-{id}"))
                .mt(px(8.0))
                .px(px(10.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .rounded(RADIUS_CONTROL)
                .bg(theme.field)
                .text_step(TEXT_12)
                .text_color(theme.ink2)
                .child(div().min_w_0().child(pending_message(&pending)))
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .gap(px(4.0))
                        .child(
                            Button::new("kb-pending-cancel", if error { "OK" } else { "Cancel" })
                                .variant(ButtonVariant::Ghost)
                                .size(ButtonSize::S24)
                                .on_click(move |_, _, cx| cancel.update(cx, |this, cx| this.cancel_pending(cx))),
                        )
                        .when(!error, |d| {
                            d.child(
                                Button::new("kb-replace", "Replace")
                                    .size(ButtonSize::S24)
                                    .on_click(move |_, _, cx| replace.update(cx, |this, cx| this.replace_pending(cx))),
                            )
                        }),
                )
        });

        let mut fields: Vec<AnyElement> = Vec::new();
        if editing {
            for (index, rule) in own.iter().enumerate() {
                let saved = rule.when.clone().unwrap_or_default();
                let input = self.when_field(id, index, &saved, window, cx);
                let draft = input.read(cx).value().to_string();
                let check = logic::when_check(&draft);
                let below = if check.invalid {
                    Some(
                        div()
                            .debug_selector(move || format!("kb-when-invalid-{id}-{index}"))
                            .child(InlineError::new(WHEN_INVALID).small())
                            .into_any_element(),
                    )
                } else if !check.unknown.is_empty() {
                    Some(
                        div()
                            .debug_selector(move || format!("kb-when-unknown-{id}-{index}"))
                            .mt(px(4.0))
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .child(logic::unknown_message(&check.unknown))
                            .into_any_element(),
                    )
                } else {
                    None
                };
                let revert = input.clone();
                fields.push(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(8.0))
                        .child(
                            div()
                                .w(px(88.0))
                                .flex_none()
                                .h(px(28.0))
                                .flex()
                                .items_center()
                                .justify_end()
                                .child(ShortcutKeys::new(label(&rule.key)).compact()),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .on_key_down(move |event: &KeyDownEvent, window, cx| {
                                    if event.keystroke.key == "escape" {
                                        cx.stop_propagation();
                                        revert.update(cx, |state, cx| state.set_value(saved.clone(), window, cx));
                                    }
                                })
                                .child(Input::new(format!("kb-when-{id}-{index}"), &input).size(FieldSize::S28).invalid(check.invalid))
                                .children(below),
                        )
                        .into_any_element(),
                );
            }
        }

        div()
            .debug_selector(move || format!("kb-row-{id}"))
            .px(px(16.0))
            .py(px(8.0))
            .child(head)
            .children(pending_panel)
            .when(!fields.is_empty(), |d| d.child(div().mt(px(8.0)).flex().flex_col().gap(px(6.0)).children(fields)))
            .into_any_element()
    }

    /// A key as a chip that records over itself when pressed, with a remove button on hover or focus.
    fn key_chip(&self, command: &'static str, index: usize, key: &str, when: Option<&str>, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let entity = cx.entity();
        let (record, remove) = (entity.clone(), entity);
        let group: SharedString = format!("kb-chip-group-{command}-{index}").into();
        let tip = match when {
            Some(when) => format!("{key} when {when}"),
            None => key.to_string(),
        };
        let selector = format!("kb-chip-{command}-{index}");
        div()
            .group(group.clone())
            .relative()
            .flex()
            .items_center()
            .child(
                div()
                    .id(row_id("kb-chip", command, index))
                    .debug_selector(move || selector.clone())
                    .tooltip(Tooltip::text(tip))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .p(px(2.0))
                    .rounded(RADIUS_CONTROL)
                    .cursor_pointer()
                    .hover(move |s| s.bg(theme.hover))
                    .on_click(move |_, window, cx| record.update(cx, |this, cx| this.record(command, Some(index), window, cx)))
                    .child(ShortcutKeys::new(label(key)))
                    .children(when.map(|when| {
                        div()
                            .max_w(px(120.0))
                            .truncate()
                            .text_step(TEXT_11)
                            .font_family(mono())
                            .text_color(theme.ink3)
                            .child(when.to_string())
                    })),
            )
            .child(
                div()
                    .id(row_id("kb-remove", command, index))
                    .debug_selector(move || format!("kb-remove-{command}-{index}"))
                    .absolute()
                    .top(px(-6.0))
                    .right(px(-6.0))
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(theme.ink)
                    .cursor_pointer()
                    .opacity(0.0)
                    .group_hover(group, |s| s.opacity(1.0))
                    .on_click(move |_, _, cx| remove.update(cx, |this, cx| this.remove_rule(command, index, cx)))
                    .child(Icon::new(IconName::Cancel01).size(IconSize::S12).color(theme.on_ink)),
            )
            .into_any_element()
    }
}

/// The chip that stands where a key is being recorded.
fn recording_chip(cx: &App) -> AnyElement {
    let theme = *cx.theme();
    div()
        .debug_selector(|| "kb-recording".into())
        .h(px(24.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.accent)
        .text_step(TEXT_12)
        .text_color(theme.accent_ink)
        .child("Press keys… ")
        .child(div().ml(px(6.0)).text_color(theme.ink3).child("Esc cancels"))
        .into_any_element()
}

/// A warning card: an orange alert glyph, a line, and optionally a list under it.
fn notice(text: String, list: Option<Vec<String>>, selector: &str, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let selector = selector.to_string();
    div()
        .debug_selector(move || selector.clone())
        .mt(px(16.0))
        .px(px(12.0))
        .py(px(8.0))
        .flex()
        .gap(px(8.0))
        .rounded(crate::theme::RADIUS_CARD)
        .bg(theme.field)
        .text_step(TEXT_12)
        .text_color(theme.ink2)
        .child(div().mt(px(1.0)).flex_none().child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.orange)))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().when(list.is_some(), |d| d.font_weight(FontWeight::MEDIUM)).child(text))
                .children(list.map(|items| {
                    div().mt(px(4.0)).flex().flex_col().children(items.into_iter().map(|item| div().child(format!("• {item}"))))
                })),
        )
        .into_any_element()
}
