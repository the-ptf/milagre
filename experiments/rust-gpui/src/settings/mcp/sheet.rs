//! The Add or Edit sheet (`McpServerSheet.tsx`): a catalog of hosted services, a token field for the ones that
//! sign in with one, a custom URL or command form with headers or variables (masked secrets come back as the
//! mask and are kept unless retyped), where the server loads, and the validation copy.
//!
//! It opens as a modal over the window through gpui-component's dialog (the surface of the app's `Dialog`
//! primitive, which has a fixed title and footer; this sheet's title and buttons change with its state, so it
//! draws its own inside). Not built: the services' Simple Icons glyphs (the tile shows the initial).

use std::rc::Rc;

use gpui::Focusable as _;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::WindowExt as _;
use gpui_component::input::{InputEvent, InputState, TextareaState};

use super::logic::{
    CATALOG, CatalogEntry, Definition, SECRET_MASK, Target, UrlKind, catalog_auth_hint, catalog_definition, search_catalog, validate,
};
use crate::theme::{
    ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TEXT_17, TextStepExt, Theme,
};
use crate::ui::{
    Button, ButtonVariant, FieldSize, Icon, IconButton, IconButtonSize, IconName, IconSize, Input, Segmented, SegmentedOption, TextArea,
};

/// The page's save: the definition, where it goes and what it replaces; the reason it failed otherwise.
pub type SaveFn = Rc<dyn Fn(Definition, Target, Option<(String, Target)>, &mut App) -> Result<(), String>>;

const DIALOG_WIDTH: f32 = 520.0;
const CATALOG_HEIGHT: f32 = 320.0;
const FORM_MAX_HEIGHT: f32 = 560.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Url,
    Command,
}

/// One header or variable. `stored` is the value the server came with (the mask, for secrets); `edited` is set
/// once the user types a new value.
struct Pair {
    key: Entity<InputState>,
    value: Entity<InputState>,
    stored: Option<String>,
    edited: bool,
    /// Whether the value field had the focus at the last frame.
    focused: bool,
    _subs: Vec<Subscription>,
}

pub struct McpSheet {
    initial: bool,
    previous: Option<(String, Target)>,
    remote: bool,
    on_save: SaveFn,
    choosing: bool,
    service: Option<CatalogEntry>,
    kind: Kind,
    url_kind: UrlKind,
    target: Target,
    error: String,
    busy: bool,
    search: Entity<InputState>,
    token: Entity<InputState>,
    name: Entity<InputState>,
    url: Entity<InputState>,
    command: Entity<InputState>,
    args: Entity<TextareaState>,
    pairs: Vec<Pair>,
    _subs: Vec<Subscription>,
}

impl McpSheet {
    /// Opens the sheet over the window: Add when `initial` is `None`, Edit otherwise.
    pub fn open(
        initial: Option<(Definition, Target)>,
        previous: Option<(String, Target)>,
        remote: bool,
        on_save: SaveFn,
        window: &mut Window,
        cx: &mut App,
    ) -> Entity<McpSheet> {
        let sheet = cx.new(|cx| McpSheet::new(initial, previous, remote, on_save, window, cx));
        let opened = sheet.clone();
        window.open_dialog(cx, move |dialog, _, cx| {
            let theme = *cx.theme();
            dialog
                .width(px(DIALOG_WIDTH))
                .close_button(false)
                .overlay_closable(true)
                .keyboard(true)
                .bg(theme.surface)
                .border_color(theme.line)
                .rounded(RADIUS_WINDOW)
                .text_color(theme.ink)
                .p(px(0.0))
                .gap(px(0.0))
                .content({
                    let sheet = sheet.clone();
                    move |content, _, _| content.child(sheet.clone())
                })
        });
        opened.update(cx, |sheet, cx| sheet.focus_first(window, cx));
        opened
    }

    fn new(
        initial: Option<(Definition, Target)>,
        previous: Option<(String, Target)>,
        remote: bool,
        on_save: SaveFn,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = Input::state("Search services", window, cx);
        let token = Input::password_state("", window, cx);
        let name = Input::state("", window, cx);
        let url = Input::state("https://", window, cx);
        let command = Input::state("npx", window, cx);
        let args = crate::ui::TextArea::state("-y\n@scope/server", (3, 8), window, cx);
        let mut subs = Vec::new();
        for input in [&search, &token, &name, &url, &command] {
            subs.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.typed(cx);
                }
            }));
        }
        subs.push(cx.subscribe(&args, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.typed(cx);
            }
        }));
        let mut sheet = Self {
            initial: initial.is_some(),
            previous,
            remote,
            on_save,
            choosing: initial.is_none(),
            service: None,
            kind: Kind::Url,
            url_kind: UrlKind::Http,
            target: Target::Everywhere,
            error: String::new(),
            busy: false,
            search,
            token,
            name,
            url,
            command,
            args,
            pairs: Vec::new(),
            _subs: subs,
        };
        if let Some((def, target)) = initial {
            sheet.target = target;
            let (pairs, name) = match &def {
                Definition::Url { name, kind, url, headers } => {
                    sheet.kind = Kind::Url;
                    sheet.url_kind = *kind;
                    sheet.url.update(cx, |state, cx| state.set_value(url.clone(), window, cx));
                    (headers.clone(), name.clone())
                }
                Definition::Stdio { name, command, args, env } => {
                    sheet.kind = Kind::Command;
                    sheet.command.update(cx, |state, cx| state.set_value(command.clone(), window, cx));
                    sheet.args.update(cx, |state, cx| state.set_value(args.join("\n"), window, cx));
                    (env.clone(), name.clone())
                }
            };
            sheet.name.update(cx, |state, cx| state.set_value(name, window, cx));
            for (key, value) in pairs {
                sheet.add_pair(Some((key, value)), window, cx);
            }
        }
        if sheet.pairs.is_empty() {
            sheet.add_pair(None, window, cx);
        }
        sheet
    }

    fn focus_first(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = if self.choosing { self.search.clone() } else { self.name.clone() };
        input.update(cx, |state, cx| state.focus(window, cx));
    }

    /// Typing again clears the last problem.
    fn typed(&mut self, cx: &mut Context<Self>) {
        self.error.clear();
        cx.notify();
    }

    fn add_pair(&mut self, stored: Option<(String, String)>, window: &mut Window, cx: &mut Context<Self>) {
        let (placeholder_key, _) = self.pair_placeholders();
        let key = Input::state(placeholder_key, window, cx);
        let value = Input::state("Value", window, cx);
        let stored_value = stored.as_ref().map(|(_, value)| value.clone());
        if let Some((k, v)) = stored {
            key.update(cx, |state, cx| state.set_value(k, window, cx));
            value.update(cx, |state, cx| state.set_value(v, window, cx));
        }
        let index = self.pairs.len();
        let subs = vec![
            cx.subscribe_in(&key, window, move |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.typed(cx);
                }
            }),
            cx.subscribe_in(&value, window, move |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    if let Some(pair) = this.pairs.get_mut(index) {
                        pair.edited = true;
                    }
                    this.typed(cx);
                }
            }),
        ];
        self.pairs.push(Pair { key, value, stored: stored_value, edited: false, focused: false, _subs: subs });
    }

    fn pair_placeholders(&self) -> (&'static str, &'static str) {
        if self.kind == Kind::Url { ("Header", "Add a header") } else { ("Variable", "Add a variable") }
    }

    /// A focused masked value clears so a new one can be typed; left untouched, the mask comes back.
    fn follow_secret_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for index in 0..self.pairs.len() {
            let pair = &mut self.pairs[index];
            let focused = pair.value.read(cx).focus_handle(cx).is_focused(window);
            if focused == pair.focused {
                continue;
            }
            pair.focused = focused;
            let (input, edited, stored) = (pair.value.clone(), pair.edited, pair.stored.clone());
            if focused && !edited && input.read(cx).value().as_ref() == SECRET_MASK {
                input.update(cx, |state, cx| state.set_value("", window, cx));
            } else if !focused && !edited && stored.as_deref() == Some(SECRET_MASK) {
                input.update(cx, |state, cx| state.set_value(SECRET_MASK, window, cx));
            }
        }
    }

    // ---- reading the form -----------------------------------------------------------------------------------------

    pub fn choosing(&self) -> bool {
        self.choosing
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    pub fn busy(&self) -> bool {
        self.busy
    }

    pub fn target(&self) -> Target {
        self.target
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn service(&self) -> Option<&CatalogEntry> {
        self.service.as_ref()
    }

    pub fn search_input(&self) -> Entity<InputState> {
        self.search.clone()
    }

    pub fn token_input(&self) -> Entity<InputState> {
        self.token.clone()
    }

    pub fn name_input(&self) -> Entity<InputState> {
        self.name.clone()
    }

    pub fn url_input(&self) -> Entity<InputState> {
        self.url.clone()
    }

    pub fn command_input(&self) -> Entity<InputState> {
        self.command.clone()
    }

    pub fn args_input(&self) -> Entity<TextareaState> {
        self.args.clone()
    }

    pub fn pair_inputs(&self) -> Vec<(Entity<InputState>, Entity<InputState>)> {
        self.pairs.iter().map(|pair| (pair.key.clone(), pair.value.clone())).collect()
    }

    /// An untouched value goes back as it came, so a masked secret is kept by the host rather than saved as "".
    fn sent(pair: &Pair, cx: &App) -> String {
        let typed = pair.value.read(cx).value().to_string();
        if pair.edited || pair.stored.is_none() { typed } else { pair.stored.clone().unwrap_or_default() }
    }

    fn record(&self, cx: &App) -> Vec<(String, String)> {
        self.pairs
            .iter()
            .filter_map(|pair| {
                let key = pair.key.read(cx).value().to_string();
                let value = Self::sent(pair, cx);
                (!key.is_empty() || !value.is_empty()).then_some((key, value))
            })
            .collect()
    }

    /// The definition the form describes.
    pub fn definition(&self, cx: &App) -> Definition {
        let name = self.name.read(cx).value().trim().to_string();
        match self.kind {
            Kind::Url => {
                Definition::Url { name, kind: self.url_kind, url: self.url.read(cx).value().trim().to_string(), headers: self.record(cx) }
            }
            Kind::Command => Definition::Stdio {
                name,
                command: self.command.read(cx).value().trim().to_string(),
                args: self.args.read(cx).value().split('\n').filter(|arg| !arg.trim().is_empty()).map(str::to_string).collect(),
                env: self.record(cx),
            },
        }
    }

    pub fn primary_label(&self) -> &'static str {
        if self.busy {
            "Saving…"
        } else if self.initial {
            "Save"
        } else if self.kind == Kind::Url && !self.remote && !self.service.is_some_and(|service| service.token) {
            "Add and sign in"
        } else {
            "Add server"
        }
    }

    pub fn title(&self) -> String {
        if self.initial {
            "Edit MCP server".to_string()
        } else if let Some(service) = &self.service {
            format!("Add {}", service.name)
        } else if self.choosing {
            "Add MCP".to_string()
        } else {
            "Custom MCP".to_string()
        }
    }

    // ---- acting ---------------------------------------------------------------------------------------------------

    pub fn choose(&mut self, entry: Option<CatalogEntry>, window: &mut Window, cx: &mut Context<Self>) {
        self.service = entry;
        self.choosing = false;
        self.kind = Kind::Url;
        self.error.clear();
        let (name, url) = entry.map_or(("", ""), |entry| (entry.id, entry.url));
        self.name.update(cx, |state, cx| state.set_value(name, window, cx));
        self.url.update(cx, |state, cx| state.set_value(url, window, cx));
        self.command.update(cx, |state, cx| state.set_value("", window, cx));
        self.args.update(cx, |state, cx| state.set_value("", window, cx));
        self.token.update(cx, |state, cx| state.set_value("", window, cx));
        self.pairs.clear();
        self.add_pair(None, window, cx);
        let focus = if entry.is_some_and(|entry| entry.token) { self.token.clone() } else { self.name.clone() };
        focus.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub fn back_to_catalog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.choosing = true;
        self.service = None;
        self.error.clear();
        self.token.update(cx, |state, cx| state.set_value("", window, cx));
        self.search.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub fn set_kind(&mut self, kind: Kind, window: &mut Window, cx: &mut Context<Self>) {
        if kind != self.kind {
            // Headers and environment variables do not carry over between a URL and a command.
            self.pairs.clear();
            self.add_pair(None, window, cx);
        }
        self.kind = kind;
        cx.notify();
    }

    pub fn grow_pairs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.add_pair(None, window, cx);
        cx.notify();
    }

    pub fn set_target(&mut self, target: Target, cx: &mut Context<Self>) {
        self.target = target;
        cx.notify();
    }

    /// Add or Save: validate, hand the definition to the page, and close on success.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.choosing || self.busy {
            return;
        }
        let mut payload = self.definition(cx);
        if let Some(service) = &self.service {
            let token = self.token.read(cx).value().to_string();
            match catalog_definition(service, &token) {
                Ok(def) => payload = def,
                Err(message) => {
                    self.error = message;
                    cx.notify();
                    return;
                }
            }
        }
        if let Some(problem) = validate(&payload) {
            self.error = problem;
            cx.notify();
            return;
        }
        self.busy = true;
        self.error.clear();
        let on_save = self.on_save.clone();
        let result = on_save(payload, self.target, self.previous.clone(), cx);
        self.busy = false;
        match result {
            Ok(()) => window.close_dialog(cx),
            Err(message) => self.error = message,
        }
        cx.notify();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.busy {
            window.close_dialog(cx);
        }
    }
}

// ---- drawing ------------------------------------------------------------------------------------------------------

fn field_label(text: &'static str, theme: &Theme) -> gpui::Div {
    div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(text)
}

fn labelled(text: &'static str, theme: &Theme, field: impl IntoElement, hint: Option<&'static str>) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(field_label(text, theme))
        .child(field)
        .when_some(hint, |d, hint| d.child(div().text_step(TEXT_12).text_color(theme.ink3).child(hint)))
        .into_any_element()
}

impl McpSheet {
    fn catalog(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let query = self.search.read(cx).value().to_string();
        let matches = search_catalog(&query);
        let rows: Vec<AnyElement> = matches
            .iter()
            .map(|entry| {
                let entry = *entry;
                div()
                    .id(SharedString::from(format!("mcp-service-{}", entry.id)))
                    .debug_selector(move || format!("mcp-service-{}", entry.id))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover))
                    .active(|s| s.bg(theme.hover2))
                    .on_click(cx.listener(move |this, _, window, cx| this.choose(Some(entry), window, cx)))
                    .child(
                        div()
                            .size(px(32.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_CONTROL)
                            .bg(theme.field)
                            .text_step(TEXT_15)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .child(entry.name.chars().next().map(String::from).unwrap_or_default()),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(div().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(entry.name))
                            .child(div().text_step(TEXT_12).text_color(theme.ink2).child(entry.description)),
                    )
                    .child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(if entry.token { "Token" } else { "Sign in" }))
                    .into_any_element()
            })
            .collect();
        let mut list = div().flex().flex_col();
        for (ix, row) in rows.into_iter().enumerate() {
            if ix > 0 {
                list = list.child(div().w_full().h(px(1.0)).bg(theme.line));
            }
            list = list.child(row);
        }
        div()
            .debug_selector(|| "mcp-catalog".into())
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(div().text_step(TEXT_13).text_color(theme.ink2).child("Choose a service. Its connection settings are ready to use."))
            .child(Input::new("mcp-search", &self.search).leading(IconName::Search01))
            .child(
                div()
                    .id("mcp-catalog-list")
                    .max_h(px(CATALOG_HEIGHT))
                    .overflow_y_scroll()
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .child(list),
            )
            .when(matches.is_empty(), |d| {
                d.child(
                    div()
                        .text_step(TEXT_13)
                        .text_color(theme.ink2)
                        .child("No matching services. You can add a custom MCP with its URL or command."),
                )
            })
            .child(
                div()
                    .id("mcp-custom")
                    .debug_selector(|| "mcp-custom".into())
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(16.0))
                    .py(px(12.0))
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line_strong)
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover))
                    .on_click(cx.listener(|this, _, window, cx| this.choose(None, window, cx)))
                    .child(Icon::new(IconName::Add01).size(IconSize::S16).color(theme.ink))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Custom MCP"))
                            .child(div().text_step(TEXT_12).text_color(theme.ink2).child(if self.remote {
                                "Connect another service with a URL."
                            } else {
                                "Connect another service with a URL or command."
                            })),
                    ),
            )
            .into_any_element()
    }

    fn pair_rows(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let last = self.pairs.len().saturating_sub(1);
        let rows = self.pairs.iter().enumerate().map(|(ix, pair)| {
            div()
                .flex()
                .gap(px(8.0))
                .child(div().w(px(170.0)).flex_none().child(Input::new(format!("mcp-pair-key-{ix}"), &pair.key).size(FieldSize::S36)))
                .child(div().min_w_0().flex_1().child(Input::new(format!("mcp-pair-value-{ix}"), &pair.value).size(FieldSize::S36)))
                .child(
                    div().size(px(36.0)).flex_none().when(ix != last, |d| d.invisible()).child(
                        IconButton::new(SharedString::from(format!("mcp-pair-add-{ix}")), IconName::Add01)
                            .size(IconButtonSize::S28)
                            .on_click(cx.listener(|this, _, window, cx| this.grow_pairs(window, cx))),
                    ),
                )
        });
        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(field_label(if self.kind == Kind::Url { "Headers (optional)" } else { "Environment (optional)" }, &theme))
            .children(rows)
            .into_any_element()
    }

    fn service_section(&self, service: &CatalogEntry, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let docs = service.docs_url;
        let name = service.name;
        div()
            .debug_selector(|| "mcp-service-form".into())
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(div().text_step(TEXT_13).text_color(theme.ink2).child(service.description))
            .child(div().text_step(TEXT_13).text_color(theme.ink2).child(catalog_auth_hint(service, self.remote)))
            .when(service.token, |d| {
                let token_url = service.token_url;
                d.child(labelled("Personal access token", &theme, Input::new("mcp-token", &self.token).mask_toggle(), None)).when_some(
                    token_url,
                    |d, url| {
                        d.child(
                            Button::new("mcp-token-link", format!("Create a token on {name}"))
                                .variant(ButtonVariant::Link)
                                .size(crate::ui::ButtonSize::S24)
                                .on_click(move |_, _, cx| cx.open_url(url)),
                        )
                    },
                )
            })
            .child(
                Button::new("mcp-docs-link", format!("{name} setup guide"))
                    .variant(ButtonVariant::Link)
                    .size(crate::ui::ButtonSize::S24)
                    .on_click(move |_, _, cx| cx.open_url(docs)),
            )
            .into_any_element()
    }

    fn custom_section(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let kind = if self.kind == Kind::Url { "url" } else { "command" };
        let kinds = Segmented::new(
            "mcp-kind",
            Some(kind),
            [
                SegmentedOption::new("url", "URL").icon(IconName::Globe02),
                SegmentedOption::new("command", "Command").icon(IconName::CommandLine).disabled(self.remote),
            ],
        )
        .on_change(cx.listener(|this, value: &SharedString, window, cx| {
            this.set_kind(if value.as_ref() == "command" { Kind::Command } else { Kind::Url }, window, cx)
        }));
        let hint = if self.remote {
            "After adding, finish sign-in on the connected computer if needed."
        } else {
            "If the server asks you to sign in, your browser opens after you add it."
        };
        let mut col = div().debug_selector(|| "mcp-custom-form".into()).flex().flex_col().gap(px(16.0)).child(kinds).child(labelled(
            "Name",
            &theme,
            Input::new("mcp-name", &self.name),
            None,
        ));
        col = if self.kind == Kind::Url {
            col.child(labelled("URL", &theme, Input::new("mcp-url", &self.url), Some(hint)))
        } else {
            col.child(labelled("Command", &theme, Input::new("mcp-command", &self.command), None)).child(labelled(
                "Arguments (optional)",
                &theme,
                TextArea::new("mcp-args", &self.args),
                Some("One per line."),
            ))
        };
        col.child(self.pair_rows(cx)).into_any_element()
    }

    fn targets(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let mut card = div().flex().flex_col().rounded(RADIUS_CARD).border_1().border_color(theme.line).overflow_hidden();
        for (ix, target) in Target::ALL.into_iter().enumerate() {
            let picked = self.target == target;
            if ix > 0 {
                card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
            }
            card = card.child(
                div()
                    .id(SharedString::from(format!("mcp-target-{}", target.id())))
                    .debug_selector(move || format!("mcp-target-{}", target.id()))
                    .min_h(px(44.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(12.0))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| this.set_target(target, cx)))
                    .child(super::radio_dot(picked, &theme))
                    .child(
                        div()
                            .flex_1()
                            .text_step(TEXT_13)
                            .font_weight(if picked { FontWeight::MEDIUM } else { FontWeight::NORMAL })
                            .text_color(if picked { theme.ink } else { theme.ink2 })
                            .child(target.label()),
                    )
                    .child(div().text_step(TEXT_12).text_color(theme.ink3).child(target.hint())),
            );
        }
        div().flex().flex_col().gap(px(6.0)).child(field_label("Load it in", &theme)).child(card).into_any_element()
    }
}

impl Render for McpSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.follow_secret_focus(window, cx);
        let theme = *cx.theme();
        let header = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .px(px(24.0))
            .pt(px(24.0))
            .pb(px(16.0))
            .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(self.title()))
            .child(
                IconButton::new("mcp-sheet-close", IconName::Cancel01)
                    .size(IconButtonSize::S28)
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
            );
        let body: AnyElement = if self.choosing {
            self.catalog(cx)
        } else {
            let mut form = div().flex().flex_col().gap(px(16.0));
            if !self.initial {
                form = form.child(
                    div().child(
                        Button::new("mcp-back", "All services")
                            .variant(ButtonVariant::Quiet)
                            .size(crate::ui::ButtonSize::S24)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.back_to_catalog(window, cx))),
                    ),
                );
            }
            form = match self.service {
                Some(service) => form.child(self.service_section(&service, cx)),
                None => form.child(self.custom_section(cx)),
            };
            form = form.child(self.targets(cx));
            if !self.error.is_empty() {
                form = form.child(
                    div()
                        .debug_selector(|| "mcp-sheet-error".into())
                        .text_step(TEXT_12)
                        .text_color(theme.red_ink)
                        .child(self.error.clone()),
                );
            }
            form.child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .pt(px(4.0))
                    .child(
                        Button::new("mcp-sheet-cancel", "Cancel")
                            .variant(ButtonVariant::Secondary)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
                    )
                    .child(
                        Button::new("mcp-sheet-submit", self.primary_label())
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
            .into_any_element()
        };
        div()
            .debug_selector(|| "mcp-sheet".into())
            .w_full()
            .flex()
            .flex_col()
            .child(header)
            .child(div().id("mcp-sheet-body").max_h(px(FORM_MAX_HEIGHT)).overflow_y_scroll().px(px(24.0)).pb(px(24.0)).child(body))
    }
}

/// How many services the catalog lists (for tests).
pub fn catalog_len() -> usize {
    CATALOG.len()
}
