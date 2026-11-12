//! The Chat card (design `gpui-chat-card-a`, run down to the window's bottom edge as Victor asked): its bounds and gaps with the panel open and closed and the sidebar open
//! and a rail, and the one surface around it (one grain under the whole window, no lines between its parts).

use gpui::{Modifiers, TestAppContext, px};

use super::card::{self, CARD_GAP, CARD_RADIUS};
use crate::testing;
use crate::workspace::chrome::{TOP_ROW, TOP_ROW_CENTRE};
use crate::workspace::shell::top_bar;
use crate::workspace::sidebar::SIDEBAR_WIDTH;
use crate::workspace::sidebar::rail::RAIL_WIDTH;

#[gpui::test]
fn the_chat_card_starts_under_the_top_row_sits_8px_from_the_panel_and_runs_to_the_bottom_edge(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    let window = cx.update(|window, _| window.viewport_size());
    assert_eq!(CARD_RADIUS, 12.0, "12px top corners");
    for collapsed in [false, true] {
        for open in [true, false] {
            panel.update(cx, |p, cx| {
                if p.is_open() != open {
                    let tab = p.active();
                    p.toggle_tab(tab, cx);
                }
            });
            cx.run_until_parked();
            let state = format!("sidebar collapsed {collapsed}, panel open {open}");
            let card = cx.debug_bounds("chat-card").expect("the card is drawn");
            assert_eq!(card.top(), px(TOP_ROW), "right under the top row: {state}");
            assert_eq!(card.top(), px(46.0), "the title (centred at y 23) sits halfway between the window top and the card");
            assert_eq!(card.bottom(), window.height, "down to the window's bottom edge, no gap: {state}");
            let sidebar = if collapsed { RAIL_WIDTH } else { SIDEBAR_WIDTH };
            assert_eq!(card.left(), px(sidebar), "from the sidebar's edge, its rows 8px short of it: {state}");
            if open {
                let tabs = cx.debug_bounds("panel-header").expect("the panel's tabs");
                assert_eq!(tabs.left() - card.right(), px(CARD_GAP), "8px before the panel: {state}");
                let width = px(panel.read_with(cx, |p, _| p.width()));
                assert_eq!(card.right(), window.width - width - card::panel_lead(), "the handle straddles the gap's middle");
            } else {
                assert_eq!(window.width - card.right(), px(CARD_GAP), "8px from the window's right edge: {state}");
            }
            // The Chat's body is on the card, inside its border; its header is above it, in the top row.
            let content = cx.debug_bounds("chat-card-content").expect("the card's content");
            assert_eq!((content.left(), content.right()), (card.left() + px(1.0), card.right() - px(1.0)), "{state}");
            assert_eq!(content.bottom(), window.height, "no bottom border: {state}");
            let header = cx.debug_bounds("chat-header").expect("the Chat header");
            assert!(header.bottom() <= card.top(), "the title is outside the card: {state}");
            let corner = cx.debug_bounds("toggle-panel").expect("the panel toggle");
            assert_eq!(corner.right(), card.right(), "the toggle's click area ends on the card's border line: {state}");
            assert_eq!(top_bar::CORNER_INSET, 0.0);
            assert_eq!(corner.center().y, px(TOP_ROW_CENTRE), "centred on the traffic lights: {state}");
            let first_row = cx.debug_bounds(if collapsed { "rail-item-0" } else { "chat-row-0" }).expect("the sidebar's first row");
            assert!(first_row.top() >= card.top(), "the sidebar's rows start under the top row: {state}");
            if open {
                let body = cx.debug_bounds("panel-body").expect("the panel's body");
                assert_eq!(body.top(), card.top(), "the panel's content starts where the card does: {state}");
            }
        }
        cx.simulate_keystrokes("cmd-b");
        cx.run_until_parked();
    }
}

#[gpui::test]
fn one_grain_under_the_whole_window_renders_once(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let window = cx.update(|window, _| window.viewport_size());
    let grain = cx.debug_bounds("grain").expect("the grain is drawn");
    assert_eq!((grain.left(), grain.top(), grain.size), (px(0.0), px(0.0), window), "the whole window");
    assert!(cx.debug_bounds("panel-grain").is_none(), "no grain of the panel's own");
    assert!(cx.debug_bounds("top-row-fade").is_none(), "the top row is one surface: nothing to fade");
    let renders = |cx: &mut gpui::VisualTestContext| workspace.read_with(cx, |w, cx| w.grain.read(cx).renders());
    let before = renders(cx);
    assert!(before >= 1);
    for selector in ["chat-row-3", "chat-row-4", "chat-row-5"] {
        let row = cx.debug_bounds(selector).expect("a row");
        cx.simulate_mouse_move(row.center(), None, Modifiers::none());
        cx.run_until_parked();
    }
    let row = cx.debug_bounds("chat-row-5").expect("a row").center();
    cx.simulate_event(gpui::ScrollEvent {
        position: row,
        delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.0), px(-400.0))),
        ..Default::default()
    });
    cx.run_until_parked();
    assert_eq!(renders(cx), before, "no render for hover or scroll");
}

/// The card has its own grain, as strong as the surface's (Victor asked for less noise inside the Chat), over its fill and under its content, rendered once: not
/// for a scroll of the transcript, a hover, or a keystroke in the composer.
#[gpui::test]
fn the_card_has_its_own_grain_that_renders_once(cx: &mut TestAppContext) {
    use crate::ui::grain::{CARD_STRENGTH, STRENGTH};
    let (workspace, cx) = testing::mount_workspace(cx);
    let card = cx.debug_bounds("chat-card").expect("the card is drawn");
    let grain = cx.debug_bounds("card-grain").expect("the card's grain is drawn");
    assert_eq!(grain, card, "the grain fills the card, and ends where it does");
    assert_eq!(CARD_STRENGTH, STRENGTH, "the card's grain is the surface's");
    let renders = |cx: &mut gpui::VisualTestContext| workspace.read_with(cx, |w, cx| w.card_grain.read(cx).renders());
    let page = cx.debug_bounds("chat-card-content").expect("the content").center();
    // Mouse mode first, then settle: the first mouse move after typing (and the first key after the mouse) refreshes
    // every view once, whatever they are.
    cx.simulate_mouse_move(page, None, Modifiers::none());
    cx.run_until_parked();
    let before = renders(cx);
    assert!(before >= 1);
    for dy in [-300.0, 300.0] {
        cx.simulate_event(gpui::ScrollEvent {
            position: page,
            delta: gpui::ScrollDelta::Pixels(gpui::point(px(0.0), px(dy))),
            ..Default::default()
        });
    }
    cx.run_until_parked();
    assert_eq!(renders(cx), before, "no render of the card's grain for a hover or a scroll");
    // Typing: the first key is the mode switch; the keys after it render nothing of the grain.
    cx.simulate_keystrokes("a");
    cx.run_until_parked();
    let before = renders(cx);
    cx.simulate_keystrokes("b c d");
    cx.run_until_parked();
    assert_eq!(renders(cx), before, "no render of the card's grain for typing");
}

#[gpui::test]
fn the_routines_page_and_the_diff_sit_on_the_card(cx: &mut TestAppContext) {
    let (_workspace, cx) = testing::mount_workspace(cx);
    let routines = cx.debug_bounds("bar-routines").unwrap();
    cx.simulate_click(routines.center(), Modifiers::none());
    cx.run_until_parked();
    let card = cx.debug_bounds("chat-card").expect("the card holds the Routines page");
    let page = cx.debug_bounds("routines-view").expect("the Routines page");
    assert_eq!(page.top(), card.top() + px(1.0), "under the card's top border");
    assert!(page.left() >= card.left() && page.right() <= card.right() && page.bottom() == card.bottom());
}

/// The transcript runs behind the floating composer down to the card's bottom edge, the pills ride just above the
/// composer, and the list keeps the composer's height as room under its last item, so the last message still scrolls
/// fully above it.
#[gpui::test]
fn the_transcript_runs_behind_the_floating_composer_to_the_cards_bottom(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    let window = cx.update(|window, _| window.viewport_size());
    let card = cx.debug_bounds("chat-card").expect("the card");
    let transcript = cx.debug_bounds("transcript").expect("the transcript");
    assert_eq!(transcript.bottom(), window.height, "down to the card's bottom edge, behind the composer");
    assert!(transcript.bottom() <= card.bottom());
    let dock = cx.debug_bounds("composer-dock").expect("the composer floats over it");
    let composer = cx.debug_bounds("composer").expect("the composer");
    assert_eq!(dock.bottom(), transcript.bottom(), "fixed to the transcript's bottom");
    assert!(composer.top() > transcript.top() && composer.bottom() < transcript.bottom(), "over the transcript");
    let room = workspace.read_with(cx, |w, cx| w.chat.read(cx).transcript.read(cx).composer_room());
    assert_eq!(room, dock.size.height, "the list keeps the composer's height under its last item");
    let pills = cx.debug_bounds("pill-row").expect("the pills");
    assert_eq!(pills.bottom(), composer.top() - px(8.0), "the pills ride 8px above the composer");
}

/// The transcript starts right under the card's border, with no fade band over the grain (it read as a dark border).
#[gpui::test]
fn the_transcript_starts_clear_of_the_cards_top_border(cx: &mut TestAppContext) {
    let (_workspace, cx) = testing::mount_workspace(cx);
    let card = cx.debug_bounds("chat-card").expect("the card");
    let transcript = cx.debug_bounds("transcript").expect("the transcript");
    assert_eq!(transcript.top(), card.top() + px(1.0), "right under the border");
    assert!(cx.debug_bounds("transcript-top-fade").is_none(), "no fade band under the border");
}
