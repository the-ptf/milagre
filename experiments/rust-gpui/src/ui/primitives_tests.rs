//! Headless tests for the gpui-component wrappers and the small own primitives of WP-07 to WP-09: fields,
//! popovers and menus, dialogs, tooltips, tabs, radios, selects and the display primitives.
//!
//! The wrapped widgets need `gpui_component::Root` as the window root (dialogs, tooltips, popovers), so each test
//! mounts a [`Host`] view inside `Root` with the theme bridge on, through the fit check's harness.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, Modifiers, Render, TestAppContext, VisualTestContext, Window, div,
    prelude::*, px,
};

use gpui_component::WindowExt as _;

use super::*;
use crate::fitcheck::harness::{draw, init};
use crate::theme::{CONTROL_LG, CONTROL_MD, CONTROL_SM, Theme};

type Build = Box<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// A view that draws whatever its closure builds, on the page colour.
pub struct Host {
    build: Build,
}

impl Render for Host {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = cx.global::<Theme>().page;
        div().size_full().bg(page).p_4().flex().flex_col().items_start().gap_2().child((self.build)(window, cx))
    }
}

/// Mounts `build` in a `Root` window with `theme` and draws it twice (overlays place themselves a frame late).
pub fn mount_host<E: IntoElement>(
    cx: &mut TestAppContext,
    theme: Theme,
    build: impl Fn(&mut Window, &mut App) -> E + 'static,
) -> (Entity<Host>, &mut VisualTestContext) {
    init(cx, theme);
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let view = cx.new(|_| Host { build: Box::new(move |window, cx| build(window, cx).into_any_element()) });
        gpui_component::Root::new(gpui::AnyView::from(view), window, cx)
    });
    let host = root.read_with(cx, |root, _| root.view().clone().downcast::<Host>().expect("host view"));
    settle(cx);
    (host, cx)
}

/// Presses and releases a key: a focused element is activated by Enter or Space on the release.
pub fn press(cx: &mut VisualTestContext, key: &'static str) {
    cx.simulate_keystrokes(key);
    let keystroke = gpui::Keystroke::parse(key).expect("a key");
    cx.simulate_event(gpui::KeyUpEvent { keystroke });
    settle(cx);
}

/// Runs pending work and draws twice.
pub fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    draw(cx);
    draw(cx);
}

fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> gpui::Bounds<gpui::Pixels> {
    cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

/// A view that owns text states, for the field tests.
struct Fields {
    input: Entity<gpui_component::input::InputState>,
    area: Entity<gpui_component::input::TextareaState>,
}

impl Render for Fields {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .p_4()
            .flex()
            .flex_col()
            .gap_2()
            .w(px(320.0))
            .child(Input::new("name-field", &self.input))
            .child(Input::new("compact-field", &self.input).size(FieldSize::S28))
            .child(TextArea::new("note-field", &self.area).invalid(true))
    }
}

fn mount_fields(cx: &mut TestAppContext, theme: Theme) -> (Entity<Fields>, &mut VisualTestContext) {
    init(cx, theme);
    let (root, cx) = cx.add_window_view(|window, cx| {
        let view = cx
            .new(|cx| Fields { input: Input::state("Chat name", window, cx), area: TextArea::state("Add a note…", (2, 6), window, cx) });
        gpui_component::Root::new(gpui::AnyView::from(view), window, cx)
    });
    let fields = root.read_with(cx, |root, _| root.view().clone().downcast::<Fields>().expect("fields view"));
    settle(cx);
    (fields, cx)
}

#[gpui::test]
fn a_field_is_36_high_takes_typing_and_shows_no_focus_mark(cx: &mut TestAppContext) {
    let (fields, cx) = mount_fields(cx, Theme::dark());
    assert_eq!(bounds(cx, "name-field").size.height, CONTROL_LG, "inputs are 36");
    assert_eq!(bounds(cx, "compact-field").size.height, CONTROL_SM, "28 when asked");
    let area = bounds(cx, "note-field");
    assert!(area.size.height > px(28.0), "a text area is two rows at rest");
    let input = fields.read_with(cx, |f, _| f.input.clone());
    input.update_in(cx, |state, window, cx| state.focus(window, cx));
    draw(cx);
    cx.simulate_input("Fix the build");
    assert_eq!(input.read_with(cx, |state, _| state.value().to_string()), "Fix the build");
    // The focus mark would be a border or ring in the widget's `ring` colour (the accent): none is painted.
    let theme = Theme::dark();
    let accent: gpui::Hsla = theme.accent.into();
    let marked = cx.update(|window, _| {
        window.painted_quads().iter().any(|quad| {
            let c = quad.border_color;
            quad.border_widths.top.0 > 0.0 && c.h == accent.h && c.s == accent.s
        })
    });
    assert!(!marked, "a focused field shows only its caret");
    assert_eq!(bounds(cx, "name-field").size.height, CONTROL_LG, "focus does not change the height");
}

/// The click and press counts a menu test reads.
#[derive(Default)]
struct Counts {
    rename: Cell<usize>,
    archive: Cell<usize>,
}

fn menu_popover(counts: Rc<Counts>) -> impl Fn(&mut Window, &mut App) -> AnyElement {
    move |_, _| {
        let counts = counts.clone();
        div()
            .child(
                Popover::new("actions")
                    .trigger(|open| {
                        Button::new("open-menu", "Actions").variant(ButtonVariant::Secondary).disabled(open && false).into_any_element()
                    })
                    .content(move |dismiss, _, _| {
                        let (rename, archive) = (counts.clone(), counts.clone());
                        MenuList::new("menu")
                            .dismiss(dismiss)
                            .row(
                                MenuRow::new("rename", "Rename Chat")
                                    .icon(IconName::Search01)
                                    .trailing_shortcut("⌘R")
                                    .on_click(move |_, _, _| rename.rename.set(rename.rename.get() + 1)),
                            )
                            .row(MenuRow::new("pinned", "Pinned").checked(true).compact())
                            .row(MenuRow::new("described", "Run on").subtitle("This computer"))
                            .separator()
                            .row(
                                MenuRow::new("archive", "Archive")
                                    .danger()
                                    .on_click(move |_, _, _| archive.archive.set(archive.archive.get() + 1)),
                            )
                            .into_any_element()
                    })
                    .into_any_element(),
            )
            .child(div().debug_selector(|| "outside".into()).mt(px(300.0)).size(px(40.0)))
            .into_any_element()
    }
}

#[gpui::test]
fn a_popover_menu_opens_sizes_its_rows_and_dismisses(cx: &mut TestAppContext) {
    let counts = Rc::new(Counts::default());
    let (_, cx) = mount_host(cx, Theme::dark(), menu_popover(counts.clone()));
    assert!(cx.debug_bounds("rename").is_none(), "closed until pressed");
    let trigger = bounds(cx, "open-menu").center();
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    assert_eq!(bounds(cx, "rename").size.height, CONTROL_MD, "rows are 32");
    assert_eq!(bounds(cx, "pinned").size.height, CONTROL_SM, "28 when compact");
    assert_eq!(bounds(cx, "described").size.height, px(48.0), "48 with a subtitle");
    assert_eq!(bounds(cx, "menu-tick").size.width, px(14.0), "a checked row shows a 14px tick");
    assert!(cx.debug_bounds("shortcut-keys").is_some(), "the shortcut slot draws keycaps");
    // An outside press closes it, and so does Escape.
    let outside = bounds(cx, "outside").center();
    cx.simulate_click(outside, Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("rename").is_none(), "an outside press closes it");
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("rename").is_some());
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(cx.debug_bounds("rename").is_none(), "Escape closes it");
    // Pressing a row runs it and closes the menu.
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    let rename = bounds(cx, "rename").center();
    cx.simulate_click(rename, Modifiers::none());
    settle(cx);
    assert_eq!((counts.rename.get(), counts.archive.get()), (1, 0));
    assert!(cx.debug_bounds("rename").is_none(), "a pressed row closes the menu");
}

#[gpui::test]
fn the_arrow_keys_move_the_one_highlight_and_enter_presses_a_row(cx: &mut TestAppContext) {
    let counts = Rc::new(Counts::default());
    let (_, cx) = mount_host(cx, Theme::dark(), menu_popover(counts.clone()));
    let trigger = bounds(cx, "open-menu").center();
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    // The first row has focus when the menu opens: Enter presses it.
    press(cx, "enter");
    assert_eq!(counts.rename.get(), 1, "the first row took focus on open");
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    // Down x3 reaches Archive, Down wraps to Rename again, Up from there wraps back to Archive.
    cx.simulate_keystrokes("down down down");
    press(cx, "enter");
    assert_eq!(counts.archive.get(), 1, "three downs reach the last row");
}

fn open_dialog(cx: &mut VisualTestContext, dialog: Dialog) {
    cx.update(|window, cx| dialog.open(window, cx));
    settle(cx);
}

#[gpui::test]
fn a_dialog_has_its_surface_actions_bottom_right_and_closes_on_escape(cx: &mut TestAppContext) {
    let (_, cx) = mount_host(cx, Theme::dark(), |_, _| div().size(px(10.0)));
    let removed = Rc::new(Cell::new(0));
    let closed = Rc::new(Cell::new(0));
    open_dialog(
        cx,
        Dialog::new("Remove Project?")
            .description("Its Chats stay in Done.")
            .body(|_, _| div().debug_selector(|| "dialog-body".into()).h(px(40.0)).into_any_element())
            .action(DialogAction::new("dialog-cancel", "Cancel").variant(ButtonVariant::Ghost))
            .action({
                let removed = removed.clone();
                DialogAction::new("dialog-remove", "Remove")
                    .variant(ButtonVariant::Danger)
                    .on_click(move |_, _| removed.set(removed.get() + 1))
            })
            .on_close({
                let closed = closed.clone();
                move |_, _| closed.set(closed.get() + 1)
            }),
    );
    assert!(cx.update(|window, cx| window.has_active_dialog(cx)));
    let surface = bounds(cx, "dialog-0");
    assert_eq!(surface.size.width, px(440.0), "440 wide");
    let (cancel, remove, body) = (bounds(cx, "dialog-cancel"), bounds(cx, "dialog-remove"), bounds(cx, "dialog-body"));
    assert!(cancel.right() < remove.left(), "Cancel first, the primary last");
    assert!(remove.right() <= surface.right() - px(19.0), "actions end at the 20px inset, bottom right");
    assert!(remove.top() > body.bottom(), "actions sit under the body");
    assert_eq!(remove.size.height, CONTROL_MD);
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)), "Escape closes it");
    // An action runs its handler and closes the dialog.
    open_dialog(
        cx,
        Dialog::new("Again").action(DialogAction::new("dialog-go", "Go").on_click({
            let removed = removed.clone();
            move |_, _| removed.set(removed.get() + 10)
        })),
    );
    let go = bounds(cx, "dialog-go").center();
    cx.simulate_click(go, Modifiers::none());
    settle(cx);
    assert_eq!(removed.get(), 10);
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)), "an action closes it");
}

#[gpui::test]
fn a_must_answer_dialog_ignores_escape(cx: &mut TestAppContext) {
    let (_, cx) = mount_host(cx, Theme::light(), |_, _| div().size(px(10.0)));
    open_dialog(cx, Dialog::new("Discard changes?").must_answer().action(DialogAction::new("dialog-keep", "Keep editing")));
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(cx.update(|window, cx| window.has_active_dialog(cx)), "Escape does not close a must-answer dialog");
    let keep = bounds(cx, "dialog-keep").center();
    cx.simulate_click(keep, Modifiers::none());
    settle(cx);
    assert!(!cx.update(|window, cx| window.has_active_dialog(cx)));
}

#[gpui::test]
fn radio_and_segmented_pick_with_clicks_and_arrow_keys(cx: &mut TestAppContext) {
    let picked = Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
    let (_, cx) = mount_host(cx, Theme::dark(), {
        let picked = picked.clone();
        move |_, _| {
            let (a, b, c) = (picked.clone(), picked.clone(), picked.clone());
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    RadioGroup::new(
                        "scope",
                        Some("all"),
                        [RadioOption::new("all", "All"), RadioOption::new("off", "Off").disabled(true), RadioOption::new("one", "One")],
                    )
                    .on_change(move |v, _, _| a.borrow_mut().push(format!("radio:{v}"))),
                )
                .child(
                    Segmented::new(
                        "seg",
                        Some("files"),
                        [SegmentedOption::new("files", "Files"), SegmentedOption::new("commits", "Commits")],
                    )
                    .on_change(move |v, _, _| b.borrow_mut().push(format!("seg:{v}"))),
                )
                .child(
                    Tabs::new("tabs", "a", [TabOption::new("a", "A"), TabOption::new("b", "B"), TabOption::new("c", "C").disabled(true)])
                        .on_change(move |v, _, _| c.borrow_mut().push(format!("tab:{v}"))),
                )
        }
    });
    assert_eq!(bounds(cx, "scope-all").size.width, px(16.0), "radios are 16");
    assert_eq!(bounds(cx, "seg").size.height, CONTROL_SM, "a segmented control is 28");
    assert_eq!(bounds(cx, "tabs-a").size.height, CONTROL_SM, "tabs are 28");
    // A click picks; a disabled radio does not.
    let off = bounds(cx, "scope-off").center();
    cx.simulate_click(off, Modifiers::none());
    let one = bounds(cx, "scope-one").center();
    cx.simulate_click(one, Modifiers::none());
    let commits = bounds(cx, "seg-commits").center();
    cx.simulate_click(commits, Modifiers::none());
    assert_eq!(*picked.borrow(), vec!["radio:one", "seg:commits"]);
    // Arrow keys move the focus and pick, skipping the disabled radio.
    picked.borrow_mut().clear();
    let all = bounds(cx, "scope-all").center();
    cx.simulate_click(all, Modifiers::none());
    picked.borrow_mut().clear();
    cx.simulate_keystrokes("down");
    assert_eq!(*picked.borrow(), vec!["radio:one"], "down skips the disabled radio");
    let tab_b = bounds(cx, "tabs-b").center();
    cx.simulate_click(tab_b, Modifiers::none());
    picked.borrow_mut().clear();
    cx.simulate_keystrokes("right");
    assert_eq!(*picked.borrow(), vec!["tab:a"], "right wraps past the disabled tab");
}

#[gpui::test]
fn a_select_opens_picks_and_shows_the_tick(cx: &mut TestAppContext) {
    let chosen = Rc::new(std::cell::RefCell::new(None::<String>));
    let (_, cx) = mount_host(cx, Theme::light(), {
        let chosen = chosen.clone();
        move |_, _| {
            let chosen = chosen.clone();
            Select::new(
                "run-on",
                "this",
                [SelectOption::new("this", "This computer"), SelectOption::new("santo", "Santo").description("Mac mini")],
            )
            .on_change(move |v, _, _| *chosen.borrow_mut() = Some(v.to_string()))
        }
    });
    assert_eq!(bounds(cx, "run-on").size.height, CONTROL_MD, "a select trigger is 32");
    let trigger = bounds(cx, "run-on").center();
    cx.simulate_click(trigger, Modifiers::none());
    settle(cx);
    assert_eq!(bounds(cx, "picker-tick").size.width, px(14.0), "the chosen row has a tick");
    assert_eq!(bounds(cx, "run-on-santo").size.height, px(48.0), "a row with a description is 48");
    let santo = bounds(cx, "run-on-santo").center();
    cx.simulate_click(santo, Modifiers::none());
    settle(cx);
    assert_eq!(chosen.borrow().as_deref(), Some("santo"));
    assert!(cx.debug_bounds("run-on-santo").is_none(), "choosing closes the panel");
}

#[gpui::test]
fn display_primitives_have_their_sizes(cx: &mut TestAppContext) {
    let (_, cx) = mount_host(cx, Theme::dark(), |_, _| {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .w(px(300.0))
            .child(ProgressBar::new(0.5))
            .child(ProgressBar::new(2.0).thick())
            .child(StatusPill::new("pill").label("Ports").count(2).total(3))
            .child(Toast::new("Chat archived").action("undo", "Undo", Some("⌘Z"), |_, _, _| {}))
            .child(InlineError::new(""))
            .child(EmptyState::new().title("No Chats yet"))
            .child(Skeleton::new().w(px(100.0)).h(px(12.0)))
    });
    assert_eq!(bounds(cx, "pill").size.height, CONTROL_SM);
    assert!(bounds(cx, "toast").size.height >= px(44.0));
    assert!(cx.debug_bounds("inline-error").is_none(), "an empty message draws nothing");
    let fill = bounds(cx, "progress-fill");
    assert_eq!(fill.size.width, px(300.0), "a value over 1 clamps to the full track");
    assert_eq!(super::shortcut_labels("⇧⌘P"), vec!["⇧", "⌘", "P"]);
    assert_eq!(super::shortcut_labels("Cmd+Shift+K"), vec!["⇧", "⌘", "K"], "menu order");
    assert_eq!(super::roving_index("down", Some(2), 3, super::RovingAxis::Vertical), Some(0), "wraps");
    assert_eq!(super::roving_index("left", None, 3, super::RovingAxis::Horizontal), Some(2));
    assert_eq!(super::roving_index("down", Some(0), 3, super::RovingAxis::Horizontal), None);
}

#[gpui::test]
fn a_tooltip_with_a_shortcut_shows_after_hovering(cx: &mut TestAppContext) {
    let (_, cx) = mount_host(cx, Theme::dark(), |_, _| {
        div().id("target").debug_selector(|| "target".into()).size(px(40.0)).tooltip(Tooltip::new("Command palette").shortcut("⌘K").build())
    });
    let at = bounds(cx, "target").center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.executor().advance_clock(std::time::Duration::from_secs(2));
    settle(cx);
    assert!(cx.debug_bounds("tooltip").is_some(), "the capsule draws");
    assert!(cx.debug_bounds("shortcut-keys").is_some(), "with its shortcut");
}
