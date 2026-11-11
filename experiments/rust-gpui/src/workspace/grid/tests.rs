//! The grid, the split and the window's hooks, in the headless test platform.

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, point, px};

use super::{ChatGrid, ChatLayout, Side};
use crate::testing;
use crate::workspace::Workspace;
use crate::workspace::chat::ChatEvent;

fn grid(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<ChatGrid> {
    workspace.read_with(cx, |w, _| w.grid.clone())
}

fn focused(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> String {
    workspace.read_with(cx, |w, cx| w.chat.read(cx).key().expect("a Chat is open").to_string())
}

/// Turns the grid on and draws a frame.
fn grid_on(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<ChatGrid> {
    let grid = grid(workspace, cx);
    grid.update(cx, |grid, cx| grid.toggle_grid(cx));
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    grid
}

#[gpui::test]
fn opens_alone_and_the_toggle_shows_active_chats(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid(&workspace, cx);
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Single);
    assert!(cx.debug_bounds("chat-grid").is_none(), "one Chat alone, no grid");
    assert!(cx.debug_bounds("layout-toggle").is_some(), "the corner's grid button");
    let grid = grid_on(&workspace, cx);
    let open = focused(&workspace, cx);
    let tiles = grid.read_with(cx, |g, _| g.tiles());
    assert!(tiles.len() > 1, "the fixture has active Chats besides the open one: {tiles:?}");
    assert!(tiles.contains(&open), "the focused Chat is a tile");
    assert!(cx.debug_bounds("chat-grid").is_some());
    assert!(workspace.read_with(cx, |w, cx| w.chat.read(cx).tiled()), "the Chat column is the focused tile");
    assert!(cx.debug_bounds("chat-header").is_none(), "the tile's header replaces the column's");
    for key in &tiles {
        assert!(cx.debug_bounds(testing::leak(format!("chat-tile-{key}"))).is_some(), "tile {key} drawn");
    }
    // The toggle again: the open Chat alone.
    grid.update(cx, |grid, cx| grid.toggle_grid(cx));
    cx.run_until_parked();
    assert!(!grid.read_with(cx, |g, _| g.has_tiles()));
    assert!(!workspace.read_with(cx, |w, cx| w.chat.read(cx).tiled()));
}

#[gpui::test]
fn clicking_a_tile_focuses_its_chat_and_slots_stay(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid_on(&workspace, cx);
    let before = grid.read_with(cx, |g, _| g.tiles());
    let open = focused(&workspace, cx);
    let other = before.iter().find(|key| **key != open).expect("another tile").clone();
    let bounds = cx.debug_bounds(testing::leak(format!("chat-tile-{other}"))).expect("tile drawn");
    cx.simulate_click(point(bounds.center().x, bounds.origin.y + px(80.0)), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(focused(&workspace, cx), other, "the sidebar opened the clicked tile's Chat");
    let after = grid.read_with(cx, |g, _| g.tiles());
    // The old focus keeps its slot only while active; every tile that stayed keeps its order.
    let kept: Vec<&String> = before.iter().filter(|key| after.contains(key)).collect();
    let order: Vec<&String> = after.iter().filter(|key| before.contains(key)).collect();
    assert_eq!(kept, order, "no tile moved");
}

#[gpui::test]
fn pinning_keeps_an_idle_chat_in_the_grid(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid_on(&workspace, cx);
    let idle = workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        (0..sidebar.row_count())
            .filter_map(|ix| sidebar.row(ix))
            .find(|row| row.mark == crate::logic::marks::chat_mark::ChatMark::Idle)
            .map(|row| row.key.to_string())
            .expect("an idle Chat")
    });
    assert!(!grid.read_with(cx, |g, _| g.tiles()).contains(&idle));
    grid.update(cx, |grid, cx| grid.toggle_pin(&idle, cx));
    cx.run_until_parked();
    assert!(grid.read_with(cx, |g, _| g.tiles()).contains(&idle), "a pinned Chat joins at the end");
    assert_eq!(grid.read_with(cx, |g, _| g.tiles()).last(), Some(&idle));
    grid.update(cx, |grid, cx| grid.toggle_pin(&idle, cx));
    cx.run_until_parked();
    assert!(!grid.read_with(cx, |g, _| g.tiles()).contains(&idle));
}

/// Opens a Subchat of the fixture's family (one with a parent), and returns its key and its parent's.
fn open_subchat(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> (String, String) {
    let (ix, key, parent) = workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        let chats = sidebar.family_chats();
        (0..sidebar.row_count())
            .find_map(|ix| {
                let row = sidebar.row(ix)?;
                let chat = chats.iter().find(|chat| chat.key == row.key.as_ref())?;
                chat.parent.clone().map(|parent| (ix, row.key.to_string(), parent))
            })
            .expect("the fixture has a Subchat")
    });
    let row = cx.debug_bounds(testing::leak(format!("chat-row-{ix}"))).expect("row drawn");
    cx.simulate_click(row.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(focused(workspace, cx), key);
    (key, parent)
}

#[gpui::test]
fn beside_parent_and_show_all_open_the_split(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (open, parent) = open_subchat(&workspace, cx);
    let grid = grid(&workspace, cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    chat.update(cx, |_, cx| cx.emit(ChatEvent::Beside(parent.clone())));
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.tiles()), vec![parent.clone(), open.clone()], "the parent first, then the open Chat");
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Split);
    assert!(cx.debug_bounds(testing::leak(format!("tile-close-{parent}"))).is_some(), "split tiles close instead of pinning");

    chat.update(cx, |_, cx| cx.emit(ChatEvent::ShowAll));
    cx.run_until_parked();
    let (root, children) = grid.read_with(cx, |g, _| g.focused_family()).expect("a family");
    let tiles = grid.read_with(cx, |g, _| g.tiles());
    assert_eq!(tiles[0], root);
    assert_eq!(tiles.len(), children.len() + 1);
    assert!(grid.read_with(cx, |g, _| g.family_shown()), "the Subchats button reads pressed");

    // The Subchats button turned off returns to the open Chat alone.
    let button = cx.debug_bounds("subchats-toggle").expect("the Subchats button shows on a family");
    cx.simulate_click(button.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Single);
    assert_eq!(focused(&workspace, cx), open);
}

#[gpui::test]
fn closing_split_tiles_ends_at_one(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (open, parent) = open_subchat(&workspace, cx);
    let grid = grid(&workspace, cx);
    grid.update(cx, |grid, cx| grid.open_beside(&parent, cx));
    cx.run_until_parked();
    // Closing the focused tile focuses its neighbour; one left shows alone.
    let close = cx.debug_bounds(testing::leak(format!("tile-close-{open}"))).expect("close drawn");
    cx.simulate_click(close.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(focused(&workspace, cx), parent);
    assert!(!grid.read_with(cx, |g, _| g.has_tiles()));
}

#[gpui::test]
fn the_tile_menu_opens_alone_or_swaps(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let (open, _) = open_subchat(&workspace, cx);
    let grid = grid(&workspace, cx);
    grid.update(cx, |grid, cx| grid.show_family(cx));
    cx.run_until_parked();
    let tiles = grid.read_with(cx, |g, _| g.tiles());
    let title = cx.debug_bounds(testing::leak(format!("tile-menu-{open}"))).expect("a split tile's title opens its menu");
    cx.simulate_click(title.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.menu_open_on().map(str::to_string)), Some(open.clone()));
    assert!(cx.debug_bounds("tile-family-menu").is_some());
    let alone = cx.debug_bounds("tile-open-alone").expect("Open alone row");
    cx.simulate_click(alone.center(), Modifiers::none());
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Single);
    assert!(tiles.len() > 1);
    // A swap replaces one tile only.
    grid.update(cx, |grid, cx| grid.open_beside(&tiles[0], cx));
    let split = grid.read_with(cx, |g, _| g.split_keys().to_vec());
    let other = tiles.iter().find(|key| !split.contains(key)).expect("a family Chat off screen").clone();
    grid.update(cx, |grid, cx| grid.swap(&tiles[0], &other, cx));
    assert_eq!(grid.read_with(cx, |g, _| g.split_keys().to_vec()), vec![other, open]);
}

#[gpui::test]
fn dropping_a_chat_beside_the_open_one_makes_a_split(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid(&workspace, cx);
    let open = focused(&workspace, cx);
    let dragged = workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        (0..sidebar.row_count()).filter_map(|ix| sidebar.row(ix)).map(|row| row.key.to_string()).find(|key| *key != open).unwrap()
    });
    let pane = grid.read_with(cx, |g, _| g.painted.borrow().pane);
    assert!(pane.size.width > px(0.0), "the pane was measured");
    let right = point(pane.origin.x + pane.size.width - px(40.0), pane.center().y);
    assert!(grid.read_with(cx, |g, _| g.hit(right, &open)).is_none(), "the open Chat can't go beside itself");
    let target = grid.read_with(cx, |g, _| g.hit(right, &dragged)).expect("a target over the pane");
    assert_eq!((target.tile.as_deref(), target.side, target.label()), (None, Side::After, "Open beside"));
    grid.update(cx, |grid, cx| grid.show_drop(Some(target.clone()), cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("grid-drop").is_some(), "the overlay shows the half the drop takes");
    grid.update(cx, |grid, cx| grid.drop_chat(&dragged, &target, cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("grid-drop").is_none());
    assert_eq!(grid.read_with(cx, |g, _| g.tiles()), vec![open.clone(), dragged.clone()]);
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Split);

    // Over a tile now: the left half goes before it.
    let tile = cx.debug_bounds(testing::leak(format!("chat-tile-{open}"))).expect("tile drawn");
    let third = workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        (0..sidebar.row_count())
            .filter_map(|ix| sidebar.row(ix))
            .map(|row| row.key.to_string())
            .find(|key| *key != open && *key != dragged)
            .unwrap()
    });
    let target = grid.read_with(cx, |g, _| g.hit(point(tile.origin.x + px(20.0), tile.center().y), &third)).expect("over a tile");
    assert_eq!((target.tile.as_deref(), target.side), (Some(open.as_str()), Side::Before));
    grid.update(cx, |grid, cx| grid.drop_chat(&third, &target, cx));
    assert_eq!(grid.read_with(cx, |g, _| g.tiles()), vec![third, open, dragged]);
}

#[gpui::test]
fn dropping_into_the_grid_pins_the_chat(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid_on(&workspace, cx);
    let tiles = grid.read_with(cx, |g, _| g.tiles());
    let idle = workspace.read_with(cx, |w, cx| {
        let sidebar = w.sidebar.read(cx);
        (0..sidebar.row_count()).filter_map(|ix| sidebar.row(ix)).map(|row| row.key.to_string()).find(|key| !tiles.contains(key)).unwrap()
    });
    let first = cx.debug_bounds(testing::leak(format!("chat-tile-{}", tiles[0]))).expect("tile drawn");
    let target = grid.read_with(cx, |g, _| g.hit(point(first.origin.x + px(10.0), first.center().y), &idle)).expect("over a tile");
    grid.update(cx, |grid, cx| grid.drop_chat(&idle, &target, cx));
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.tiles())[0], idle, "placed before the first tile");
    assert!(grid.read_with(cx, |g, _| g.pins().contains(&idle)), "and kept while idle");
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Grid);
}

#[gpui::test]
fn find_works_from_anywhere_in_the_window(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    // Focus on the window itself, outside the Chat column (as after Settings closes).
    let focus = workspace.read_with(cx, |w, _| w.focus.clone());
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.run_until_parked();
    cx.simulate_keystrokes("cmd-f");
    cx.run_until_parked();
    assert!(workspace.read_with(cx, |w, cx| w.chat.read(cx).find_open()), "⌘F opened the open Chat's find bar");
}

#[gpui::test]
fn find_reaches_the_focused_tile(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    grid_on(&workspace, cx);
    let focus = workspace.read_with(cx, |w, _| w.focus.clone());
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.simulate_keystrokes("cmd-f");
    cx.run_until_parked();
    assert!(workspace.read_with(cx, |w, cx| w.chat.read(cx).find_open()));
    assert!(cx.debug_bounds("chat-grid").is_some(), "the bar opened in the grid's focused tile");
}

#[gpui::test]
fn cmd_shift_m_toggles_the_grid(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let grid = grid(&workspace, cx);
    cx.simulate_keystrokes("cmd-shift-m");
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Grid);
    cx.simulate_keystrokes("cmd-shift-m");
    cx.run_until_parked();
    assert_eq!(grid.read_with(cx, |g, _| g.layout()), ChatLayout::Single);
}
