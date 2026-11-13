//! A snapshot page of Milagre's primitives (feature `fitcheck`): the wrapped widgets and our own primitives side
//! by side, in the active scheme, for checking against DESIGN.md.
//!
//! ```sh
//! MILAGRE_GPUI_FITCHECK=primitives MILAGRE_GPUI_SNAPSHOT=/tmp/gpui-r3/primitives-dark.png cargo run --features fitcheck
//! MILAGRE_GPUI_THEME=light MILAGRE_GPUI_FITCHECK=primitives MILAGRE_GPUI_SNAPSHOT=/tmp/gpui-r3/primitives-light.png cargo run --features fitcheck
//! MILAGRE_GPUI_FITCHECK=primitives-dialog ... (the same page with a dialog open over it)
//! ```
//!
//! Registered in `fitcheck/gallery.rs`'s `open` (one match arm per page name).

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};
use gpui_component::input::{InputState, TextareaState};

use super::{
    Button, ButtonSize, ButtonVariant, Checkbox, Chip, ChipVariant, Dialog, DialogAction, EmptyState, ErrorVariant, IconButton, IconName,
    InlineError, Input, MenuList, MenuRow, Notice, PickerPanel, PickerRow, PillTone, Popover, ProgressBar, ProgressTone, RadioGroup,
    RadioOption, SectionLabel, Segmented, SegmentedOption, Select, SelectOption, SelectVariant, ShortcutKeys, Skeleton, StatusPill, Tab,
    TabOption, Tabs, TextArea, Toast,
};
use crate::theme::{ActiveTheme, SANS, TEXT_12, TEXT_13, TextStepExt};

/// The page. `with_dialog` opens a dialog over it once it is mounted.
pub struct PrimitivesPage {
    input: Entity<InputState>,
    search: Entity<InputState>,
    invalid: Entity<InputState>,
    area: Entity<TextareaState>,
    scope: Option<SharedString>,
    seg: Option<SharedString>,
    tab: SharedString,
    pick: SharedString,
}

impl PrimitivesPage {
    pub fn new(with_dialog: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = Input::state("Chat name", window, cx);
        input.update(cx, |state, cx| state.set_value("Fix the flaky build", window, cx));
        let search = Input::state("Search", window, cx);
        let invalid = Input::state("Chat name", window, cx);
        let area = TextArea::state("Add a note…", (3, 6), window, cx);
        if with_dialog {
            cx.defer_in(window, |_, window, cx| {
                Dialog::new("Remove Project?")
                    .description("Its Chats stay in Done and can be reopened.")
                    .body(|_, cx| {
                        let theme = *cx.theme();
                        div()
                            .text_step(TEXT_13)
                            .text_color(theme.ink2)
                            .child("milagre-ade will leave the sidebar on every computer.")
                            .into_any_element()
                    })
                    .action(DialogAction::new("cancel", "Cancel").variant(ButtonVariant::Ghost))
                    .action(DialogAction::new("remove", "Remove").variant(ButtonVariant::Danger))
                    .open(window, cx);
            });
        }
        Self {
            input,
            search,
            invalid,
            area,
            scope: Some("all".into()),
            seg: Some("files".into()),
            tab: "changes".into(),
            pick: "opus".into(),
        }
    }
}

fn section(title: &'static str, cx: &App, body: impl IntoElement) -> AnyElement {
    let theme = cx.theme();
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(title))
        .child(body)
        .into_any_element()
}

impl Render for PrimitivesPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let fields = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(section(
                "Input 36, 28, invalid; TextArea",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(Input::new("field-36", &self.input))
                    .child(Input::new("field-28", &self.search).size(super::FieldSize::S28).leading(IconName::Search01))
                    .child(Input::new("field-invalid", &self.invalid).invalid(true))
                    .child(InlineError::new("Name is required.").small())
                    .child(TextArea::new("field-area", &self.area)),
            ))
            .child(section(
                "Buttons",
                cx,
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.0))
                    .child(Button::new("b-primary", "Allow once").size(ButtonSize::S28))
                    .child(Button::new("b-secondary", "Always allow").size(ButtonSize::S28).variant(ButtonVariant::Secondary))
                    .child(Button::new("b-ghost", "Cancel").size(ButtonSize::S28).variant(ButtonVariant::Ghost))
                    .child(Button::new("b-dg", "Deny").size(ButtonSize::S28).variant(ButtonVariant::DangerGhost))
                    .child(IconButton::new("ib-1", IconName::Search01))
                    .child(IconButton::new("ib-2", IconName::Search01).pressed(true)),
            ))
            .child(section(
                "Checkbox, RadioGroup",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .gap(px(16.0))
                            .child(Checkbox::new("cb-1", true).label("Show stats"))
                            .child(Checkbox::new("cb-2", false).label("Off")),
                    )
                    .child({
                        let view = view.clone();
                        RadioGroup::new(
                            "scope",
                            self.scope.as_deref(),
                            [
                                RadioOption::new("all", "Every Project"),
                                RadioOption::new("this", "This Project"),
                                RadioOption::new("none", "None").disabled(true),
                            ],
                        )
                        .on_change(move |value, _, cx| {
                            let value = value.clone();
                            view.update(cx, |page, cx| {
                                page.scope = Some(value);
                                cx.notify();
                            })
                        })
                    }),
            ))
            .child(section(
                "Segmented, Tabs, Chips",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child({
                        let view = view.clone();
                        Segmented::new(
                            "seg",
                            self.seg.as_deref(),
                            [SegmentedOption::new("files", "Files").count(4), SegmentedOption::new("commits", "Commits")],
                        )
                        .on_change(move |value, _, cx| {
                            let value = value.clone();
                            view.update(cx, |page, cx| {
                                page.seg = Some(value);
                                cx.notify();
                            })
                        })
                    })
                    .child({
                        let view = view.clone();
                        Tabs::new(
                            "tabs",
                            self.tab.clone(),
                            [
                                TabOption::new("changes", "Changes").icon(IconName::FileDiff).count(4),
                                TabOption::new("terminal", "Terminal").icon(IconName::ComputerTerminal01),
                                TabOption::new("browser", "Browser").disabled(true),
                            ],
                        )
                        .on_change(move |value, _, cx| {
                            let value = value.clone();
                            view.update(cx, |page, cx| {
                                page.tab = value;
                                cx.notify();
                            })
                        })
                    })
                    .child(Tab::new("single", "Panel tab").icon(IconName::FileDiff).active(true))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(Chip::new("chip-trigger").chevron().child("Opus 5.5"))
                            .child(Chip::new("chip-field").variant(ChipVariant::Field).child("Field"))
                            .child(Chip::new("chip-filter").variant(ChipVariant::Filter).on(true).child("All")),
                    ),
            ));
        let menus = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(section(
                "Popover with MenuList (open)",
                cx,
                div().h(px(236.0)).child(
                    Popover::new("gallery-menu")
                        .align_start()
                        .open(true)
                        .trigger(|open| {
                            Button::new("menu-trigger", "Chat actions")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .disabled(open && false)
                                .into_any_element()
                        })
                        .content(|dismiss, _, _| {
                            MenuList::new("gallery-rows")
                                .dismiss(dismiss)
                                .row(MenuRow::new("g-rename", "Rename Chat").icon(IconName::Search01).trailing_shortcut("⌘R"))
                                .row(MenuRow::new("g-pinned", "Pinned").icon(IconName::FileDiff).checked(true))
                                .row(MenuRow::new("g-run", "Run on").subtitle("This computer"))
                                .separator()
                                .label("Danger")
                                .row(MenuRow::new("g-archive", "Archive").icon(IconName::Cancel01).danger())
                                .into_any_element()
                        }),
                ),
            ))
            .child(section(
                "PickerPanel",
                cx,
                PickerPanel::new("gallery-picker")
                    .title("Model")
                    .width(300.0)
                    .search(&self.search)
                    .label("Claude")
                    .row(
                        PickerRow::new("p-opus", "Opus 5.5")
                            .description("Most capable for complex work")
                            .meta("1M")
                            .selected(self.pick == "opus"),
                    )
                    .row(PickerRow::new("p-sonnet", "Sonnet 5.5").trailing("default"))
                    .row(PickerRow::new("p-off", "Haiku").disabled(true)),
            ))
            .child(section(
                "Select",
                cx,
                div()
                    .flex()
                    .gap(px(8.0))
                    .items_center()
                    .child(
                        Select::new("sel-field", "this", [SelectOption::new("this", "This computer"), SelectOption::new("santo", "Santo")])
                            .width(200.0),
                    )
                    .child(Select::new("sel-chip", "this", [SelectOption::new("this", "This computer")]).variant(SelectVariant::Chip))
                    .child(Select::new("sel-text", "this", [SelectOption::new("this", "All Chats")]).variant(SelectVariant::Text)),
            ));
        let display = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(section(
                "Toast",
                cx,
                div().w(px(300.0)).child(Toast::new("Chat archived").icon(IconName::Tick02).action(
                    "toast-undo",
                    "Undo",
                    Some("⌘Z"),
                    |_, _, _| {},
                )),
            ))
            .child(section("Notice", cx, div().w(px(360.0)).child(Notice::new().on_dismiss(|_, _, _| {}).child("Milagre is up to date."))))
            .child(section(
                "InlineError",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .w(px(360.0))
                    .child(InlineError::new("Could not read the Chat."))
                    .child(
                        InlineError::new("The Chat will not load.")
                            .variant(ErrorVariant::Card)
                            .action(Button::new("retry", "Retry").variant(ButtonVariant::Secondary).size(ButtonSize::S28)),
                    )
                    .child(InlineError::new("Could not save.").variant(ErrorVariant::Floating).small()),
            ))
            .child(section(
                "EmptyState",
                cx,
                div()
                    .w(px(360.0))
                    .child(EmptyState::new().icon(IconName::Search01).title("No Chats yet").help("Start one with the composer below.")),
            ))
            .child(section(
                "Skeleton, ProgressBar",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .w(px(360.0))
                    .child(Skeleton::new().w(px(200.0)).h(px(12.0)))
                    .child(Skeleton::new().secondary().w(px(140.0)).h(px(12.0)))
                    .child(ProgressBar::new(0.42))
                    .child(ProgressBar::new(0.7).tone(ProgressTone::Orange).thick())
                    .child(ProgressBar::new(0.95).tone(ProgressTone::Red)),
            ))
            .child(section(
                "StatusPill, ShortcutKeys",
                cx,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(StatusPill::new("sp-ink").icon(IconName::FileDiff).label("Changes").count(4))
                            .child(StatusPill::new("sp-orange").label("Needs you").tone(PillTone::Orange))
                            .child(StatusPill::new("sp-green").label("Ports").count(2).total(3).tone(PillTone::Green)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(ShortcutKeys::new("⌘K"))
                            .child(ShortcutKeys::new("⇧⌘P"))
                            .child(ShortcutKeys::new("Esc"))
                            .child(SectionLabel::new("Section label")),
                    ),
            ));
        div()
            .size_full()
            .flex()
            .gap(px(24.0))
            .p(px(20.0))
            .bg(theme.page)
            .text_color(theme.ink)
            .font_family(SANS)
            .text_step(TEXT_13)
            .child(div().w(px(380.0)).child(fields))
            .child(div().w(px(380.0)).child(menus))
            .child(div().flex_1().child(display))
    }
}
