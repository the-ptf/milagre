//! Expected values come from running `chat-grid.ts`, `grid-drop.ts` and `subchat-split.ts` through node
//! (`node --experimental-strip-types`, 2026-11-11) on the same inputs.

use std::collections::HashMap;

use super::logic::*;

/// previous, active, focused, expected (`None`: the same array back).
type GridCase<'a> = (Vec<String>, Vec<String>, Option<&'a str>, Option<Vec<String>>);
/// tiles, key, target tile, side, focused, expected.
type PlaceCase<'a> = (Vec<String>, &'a str, Option<&'a str>, Side, Option<&'a str>, Vec<String>);

fn keys(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn draft_key_is_id_zero() {
    assert_eq!(draft_tile_key("/a"), "/a#0");
    assert!(is_draft_tile_key("/a#0"));
    assert!(!is_draft_tile_key("/a#10"));
}

#[test]
fn grid_chats_matches_typescript() {
    let d = draft_tile_key("/a");
    // (previous, active, focused, expected; None = the same array back)
    let cases: Vec<GridCase> = vec![
        (vec![], keys(&["/a#1", "/a#2"]), None, Some(keys(&["/a#1", "/a#2"]))),
        (keys(&["/a#1", "/a#2"]), keys(&["/a#2", "/a#3"]), Some("/a#1"), Some(keys(&["/a#1", "/a#2", "/a#3"]))),
        (keys(&["/a#1", "/a#2", "/a#3"]), keys(&["/a#3", "/a#2"]), Some("/a#2"), Some(keys(&["/a#2", "/a#3"]))),
        (keys(&["/a#2"]), keys(&["/a#2"]), Some("/b#9"), Some(keys(&["/a#2", "/b#9"]))),
        (keys(&["/a#1", "/a#2"]), keys(&["/a#2", "/a#1"]), Some("/a#1"), None),
        (keys(&["/a#1", "/a#2"]), keys(&["/a#2"]), Some(&d), Some(keys(&["/a#2", "/a#0"]))),
        (keys(&["/a#2", "/a#0", "/a#3"]), keys(&["/a#2", "/a#3"]), Some("/a#4"), Some(keys(&["/a#2", "/a#4", "/a#3"]))),
        (keys(&["/a#2", "/a#0", "/a#3"]), keys(&["/a#2", "/a#3"]), Some("/a#3"), Some(keys(&["/a#2", "/a#3"]))),
        (keys(&["/a#5", "/a#1"]), vec![], None, Some(vec![])),
        (keys(&["/a#0", "/a#1"]), keys(&["/a#1", "/a#1"]), Some("/a#7"), Some(keys(&["/a#7", "/a#1"]))),
        (keys(&["/a#1"]), keys(&["/b#1", "/a#1"]), Some("/b#1"), Some(keys(&["/a#1", "/b#1"]))),
    ];
    for (previous, active, focused, expected) in cases {
        assert_eq!(grid_chats(&previous, &active, focused), expected, "{previous:?} {active:?} {focused:?}");
    }
}

#[test]
fn active_chat_keys_matches_typescript() {
    let run = |key: &str, waiting| RunInfo { key: key.into(), waiting };
    let runs = vec![run("/a#1", false), run("milagre-link:abc#2", false), run("/a#3", true), run("/a#5", false), run("/a#6", true)];
    let delegations = vec![Some("/b#3".to_string()), None, Some("/a#5".to_string())];
    let s = |key: &str, unread, archived, hidden_run| SessionInfo { key: key.into(), unread, archived, hidden_run };
    let sessions = vec![
        s("/a#1", false, false, false),
        s("/a#3", false, false, true),
        s("/a#4", true, false, false),
        s("/a#5", false, false, true),
        s("/a#6", false, false, true),
        s("/a#7", true, true, false),
        s("/a#8", true, false, true),
        s("milagre-link:abc#9", true, false, false),
    ];
    assert_eq!(active_chat_keys(&runs, &delegations, &sessions), keys(&["/a#1", "/a#3", "/a#6", "/b#3", "/a#4"]));
}

#[test]
fn drop_side_matches_typescript() {
    let area = Area { left: 100.0, top: 40.0, width: 400.0, height: 300.0 };
    let left = Area { left: 100.0, top: 40.0, width: 200.0, height: 300.0 };
    let right = Area { left: 300.0, top: 40.0, width: 200.0, height: 300.0 };
    let bar = |left| Bar { left, top: 56.0, height: 268.0 };
    assert_eq!(drop_side(area, 150.0, 12.0), (Side::Before, left, bar(92.0)));
    assert_eq!(drop_side(area, 450.0, 12.0), (Side::After, right, bar(504.0)));
    assert_eq!(drop_side(area, 300.0, 12.0), (Side::After, right, bar(504.0)));
    assert_eq!(drop_side(area, 299.5, 0.0), (Side::Before, left, bar(98.0)));
    assert_eq!(drop_side(area, 100.0, 0.0), (Side::Before, left, bar(98.0)));
    assert_eq!(drop_side(area, 60.0, 12.0), (Side::Before, left, bar(92.0)));
    let small = Area { left: 0.0, top: 0.0, width: 80.0, height: 20.0 };
    assert_eq!(
        drop_side(small, 10.0, 12.0),
        (Side::Before, Area { left: 0.0, top: 0.0, width: 40.0, height: 20.0 }, Bar { left: -8.0, top: 16.0, height: 0.0 })
    );
}

#[test]
fn place_dropped_matches_typescript() {
    use Side::*;
    let cases: Vec<PlaceCase> = vec![
        (keys(&["/a#1", "/a#2"]), "/b#3", Some("/a#2"), Before, Some("/a#1"), keys(&["/a#1", "/b#3", "/a#2"])),
        (keys(&["/a#1", "/a#2"]), "/b#3", Some("/a#1"), After, Some("/a#1"), keys(&["/a#1", "/b#3", "/a#2"])),
        (keys(&["/a#1", "/a#2", "/b#3"]), "/b#3", Some("/a#1"), Before, Some("/a#1"), keys(&["/b#3", "/a#1", "/a#2"])),
        (vec![], "/b#3", None, Before, Some("/a#1"), keys(&["/b#3", "/a#1"])),
        (vec![], "/b#3", None, After, Some("/a#1"), keys(&["/a#1", "/b#3"])),
        (keys(&["/a#1"]), "/b#3", Some("/a#9"), Before, Some("/a#1"), keys(&["/a#1", "/b#3"])),
        (vec![], "/b#3", None, After, None, keys(&["/b#3"])),
        (keys(&["/a#1", "/a#2", "/b#3"]), "/b#3", Some("/a#2"), After, Some("/a#1"), keys(&["/a#1", "/a#2", "/b#3"])),
        (keys(&["/a#1", "/a#2"]), "/a#1", Some("/a#2"), After, Some("/a#1"), keys(&["/a#2", "/a#1"])),
    ];
    for (tiles, key, tile, side, focused, expected) in cases {
        assert_eq!(place_dropped(&tiles, key, tile, side, focused), expected, "{tiles:?} {key} {tile:?} {side:?}");
    }
}

#[test]
fn stored_keys_match_typescript() {
    let cases: [(Option<&str>, Vec<String>); 7] = [
        (None, vec![]),
        (Some("[]"), vec![]),
        (Some(r#"["/a#1","/b#2"]"#), keys(&["/a#1", "/b#2"])),
        (Some("{"), vec![]),
        (Some(r#"["/a#1",3]"#), keys(&["/a#1"])),
        (Some(r#"{"a":1}"#), vec![]),
        (Some(r#""x""#), vec![]),
    ];
    for (value, expected) in cases {
        let mut store = HashMap::new();
        if let Some(value) = value {
            store.insert("milagre.chatGridPins".to_string(), value.to_string());
            store.insert("milagre.chatSplit2".to_string(), value.to_string());
        }
        assert_eq!(read_grid_pins(&store), expected, "{value:?}");
        assert_eq!(read_split_chats(&store), expected, "{value:?}");
    }
    let mut store = HashMap::new();
    save_split_chats(&mut store, &keys(&["/b#2", "/a#0", "/a#1", "/c#10"]));
    assert_eq!(store.get("milagre.chatSplit2").map(String::as_str), Some(r#"["/b#2","/a#1","/c#10"]"#));
    // A split saved under the old key is not restored.
    let old = HashMap::from([("milagre.chatSplit".to_string(), r#"["/a#1","/b#2"]"#.to_string())]);
    assert!(read_split_chats(&old).is_empty());
    save_grid_pins(&mut store, &keys(&["/a#1", "/b#2"]));
    assert_eq!(read_grid_pins(&store), keys(&["/a#1", "/b#2"]));
}

#[test]
fn chat_layout_matches_typescript() {
    for (value, expected) in [
        (Some("grid"), ChatLayout::Grid),
        (Some("split"), ChatLayout::Split),
        (None, ChatLayout::Single),
        (Some("tiles"), ChatLayout::Single),
        (Some("single"), ChatLayout::Single),
    ] {
        let mut store = HashMap::new();
        if let Some(value) = value {
            store.insert("milagre.chatLayout".to_string(), value.to_string());
        }
        assert_eq!(read_chat_layout(&store), expected);
    }
    let mut store = HashMap::new();
    save_chat_layout(&mut store, ChatLayout::Split);
    assert_eq!(read_chat_layout(&store), ChatLayout::Split);
}

#[test]
fn subchat_split_matches_typescript() {
    assert_eq!(beside_parent("/a#1", "/a#3"), keys(&["/a#1", "/a#3"]));
    let children = keys(&["/a#2", "/a#3"]);
    assert_eq!(family_split("/a#1", &children, Some("/a#2")), keys(&["/a#1", "/a#2", "/a#3"]));
    assert_eq!(family_split("/a#1", &children, None), keys(&["/a#1", "/a#2", "/a#3"]));
    assert_eq!(family_split("/a#1", &children, Some("/a#9")), keys(&["/a#1", "/a#2", "/a#3", "/a#9"]));
    assert_eq!(family_split("/a#1", &children, Some("/a#1")), keys(&["/a#1", "/a#2", "/a#3"]));
    let split = keys(&["/a#1", "/a#2"]);
    assert_eq!(swap_tile(&split, "/a#2", "/a#3"), Some(keys(&["/a#1", "/a#3"])));
    assert_eq!(swap_tile(&split, "/a#2", "/a#1"), None);
    assert_eq!(swap_tile(&split, "/a#9", "/a#3"), None);
    assert_eq!(swap_tile(&split, "/a#1", "/a#4"), Some(keys(&["/a#4", "/a#2"])));
}

#[test]
fn drop_labels() {
    let target = |tile: Option<&str>, side| GridDropTarget {
        tile: tile.map(str::to_string),
        side,
        area: Area { left: 0.0, top: 0.0, width: 1.0, height: 1.0 },
        bar: Bar { left: 0.0, top: 0.0, height: 0.0 },
    };
    assert_eq!(target(None, Side::After).label(), "Open beside");
    assert_eq!(target(Some("/a#1"), Side::Before).label(), "Add before");
    assert_eq!(target(Some("/a#1"), Side::After).label(), "Add after");
}

#[test]
fn grid_tracks_follow_auto_fit() {
    // 440px minimum, 12px gap.
    assert_eq!(grid_columns(900.0, 4, 440.0, 12.0), 2);
    assert_eq!(grid_columns(891.0, 4, 440.0, 12.0), 1);
    assert_eq!(grid_columns(1400.0, 4, 440.0, 12.0), 3);
    assert_eq!(grid_columns(1400.0, 2, 440.0, 12.0), 2, "no empty tracks");
    assert_eq!(grid_columns(300.0, 3, 440.0, 12.0), 1);
    assert_eq!(grid_columns(900.0, 0, 440.0, 12.0), 0);
    assert_eq!(grid_row_height(812.0, 2, 320.0, 12.0), 400.0);
    assert_eq!(grid_row_height(500.0, 2, 320.0, 12.0), 320.0, "rows never shrink below 320 (the grid scrolls)");
}
