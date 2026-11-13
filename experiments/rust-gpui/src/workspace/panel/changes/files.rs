//! The Files view's rows (`DiffTree.tsx`, `DiffIndicators.tsx`): the folder tree from
//! `logic::diff::build_diff_tree`, the flat two-line list a small change set gets, the `A/M/D/R` badge and the
//! `+n −m` count columns.

use std::collections::HashSet;

use gpui::{AnyElement, ClickEvent, Context, FontWeight, SharedString, div, prelude::*, px};

use super::{ChangesView, Source};
use crate::logic::diff::build_diff_tree;
use crate::logic::diff::git::{DiffFileEntry, DiffStatus};
use crate::logic::diff::tree::{DiffTreeFolder, DiffTreeNode};
use crate::theme::{CONTROL_SM, RADIUS_INLINE, TEXT_10, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme, mono};
use crate::ui::{Icon, IconName, IconSize};

/// Up to this many files a section lists them flat (name, then folder); more get the folder tree
/// (`FLAT_LIST_MAX`).
pub const FLAT_LIST_MAX: usize = 10;
/// A flat row: two lines at the panel's usual width.
const FLAT_ROW_HEIGHT: f32 = 40.0;
/// Left padding of a tree row, and what each depth adds (`8 + depth * 12`).
const TREE_INDENT_BASE: f32 = 8.0;
const TREE_INDENT_STEP: f32 = 12.0;
/// One count column: `4ch` of 11px mono.
const COUNT_COLUMN: f32 = 28.0;
const BADGE: f32 = 16.0;

/// What a row needs to draw and to report a click.
pub struct RowEnv<'a> {
    pub theme: Theme,
    pub source: &'a Source,
    pub selected: Option<&'a str>,
    pub collapsed: &'a HashSet<String>,
}

/// Which badge colours a status takes: added and deleted carry colour, modified and renamed stay neutral so
/// the list isn't a wall of colour (`DiffIndicators.tsx`).
pub fn badge_colors(theme: &Theme, status: DiffStatus) -> (gpui::Rgba, gpui::Rgba) {
    match status {
        DiffStatus::Added => (theme.green_tint, theme.green_ink),
        DiffStatus::Deleted => (theme.red_tint, theme.red_ink),
        DiffStatus::Modified | DiffStatus::Renamed => (theme.field, theme.ink2),
    }
}

pub fn badge_letter(status: DiffStatus) -> &'static str {
    match status {
        DiffStatus::Added => "A",
        DiffStatus::Deleted => "D",
        DiffStatus::Modified => "M",
        DiffStatus::Renamed => "R",
    }
}

pub fn status_badge(theme: &Theme, status: DiffStatus) -> impl IntoElement {
    let (fill, ink) = badge_colors(theme, status);
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(BADGE))
        .rounded(RADIUS_INLINE)
        .bg(fill)
        .text_color(ink)
        .font_family(mono())
        .text_step(TEXT_10)
        .font_weight(FontWeight::SEMIBOLD)
        .child(badge_letter(status))
}

/// `+n` and `−m` in the diff's -ink colours, each in its own fixed right-aligned column, blank when zero, so a
/// list's numbers line up (`Counts columns`).
pub fn count_columns(theme: &Theme, added: u32, removed: u32) -> impl IntoElement {
    let cell = |text: String, color: gpui::Rgba| div().flex_none().w(px(COUNT_COLUMN)).flex().justify_end().text_color(color).child(text);
    div()
        .flex()
        .flex_none()
        .font_family(mono())
        .text_step(TEXT_11)
        .child(cell(if added > 0 { format!("+{added}") } else { String::new() }, theme.green_ink))
        .child(cell(if removed > 0 { format!("\u{2212}{removed}") } else { String::new() }, theme.red_ink))
}

/// The compact `+n −m` of a header or a commit: a zero side is left out, nothing either way shows both.
pub fn counts_inline(theme: &Theme, added: u32, removed: u32) -> impl IntoElement {
    let none = added == 0 && removed == 0;
    div()
        .flex()
        .flex_none()
        .gap(px(6.0))
        .font_family(mono())
        .text_step(TEXT_11)
        .when(added > 0 || none, |el| el.child(div().text_color(theme.green_ink).child(format!("+{added}"))))
        .when(removed > 0 || none, |el| el.child(div().text_color(theme.red_ink).child(format!("\u{2212}{removed}"))))
}

/// A tree flattened to the rows that show (folders collapsed in `collapsed` hide their children).
enum Row<'a> {
    Folder { folder: &'a DiffTreeFolder<DiffFileEntry>, depth: usize },
    File { file: &'a DiffFileEntry, name: &'a str, depth: usize },
}

fn flatten<'a>(nodes: &'a [DiffTreeNode<DiffFileEntry>], depth: usize, collapsed: &HashSet<String>, out: &mut Vec<Row<'a>>) {
    for node in nodes {
        match node {
            DiffTreeNode::File { name, file, .. } => out.push(Row::File { file, name, depth }),
            DiffTreeNode::Folder(folder) => {
                out.push(Row::Folder { folder, depth });
                if !collapsed.contains(&folder.path) {
                    flatten(&folder.children, depth + 1, collapsed, out);
                }
            }
        }
    }
}

/// The rows of one list: flat up to [`FLAT_LIST_MAX`] files, the folder tree beyond.
pub fn rows(files: &[DiffFileEntry], env: &RowEnv, cx: &mut Context<ChangesView>) -> Vec<AnyElement> {
    if files.len() <= FLAT_LIST_MAX {
        return files.iter().map(|file| flat_row(file, env, cx)).collect();
    }
    let tree = build_diff_tree(files);
    let mut flat = Vec::new();
    flatten(&tree, 0, env.collapsed, &mut flat);
    // A lone top folder's totals are the section's own, shown once in its header.
    let lone_top = tree.len() == 1;
    flat.into_iter()
        .map(|row| match row {
            Row::File { file, name, depth } => file_row(file, name, depth, env, cx),
            Row::Folder { folder, depth } => folder_row(folder, depth, depth == 0 && lone_top, env, cx),
        })
        .collect()
}

fn select_handler(
    env: &RowEnv,
    path: &str,
    cx: &mut Context<ChangesView>,
) -> impl Fn(&ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let (source, path) = (env.source.clone(), path.to_string());
    cx.listener(move |this, _: &ClickEvent, _window, cx| this.select_file(source.clone(), path.clone(), cx))
}

fn row_id(source: &Source, path: &str) -> SharedString {
    format!("file-{}-{path}", source.key()).into()
}

fn row_shell(id: SharedString, selected: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let selector = id.to_string();
    let hover = theme.hover;
    div()
        .id(id)
        .debug_selector(move || selector.clone())
        .flex()
        .w_full()
        .items_center()
        .gap(px(6.0))
        .pr(px(12.0))
        .cursor_pointer()
        .text_step(TEXT_13)
        .when(selected, |el| el.bg(theme.hover2))
        .when(!selected, |el| el.hover(move |style| style.bg(hover)))
}

fn file_row(file: &DiffFileEntry, name: &str, depth: usize, env: &RowEnv, cx: &mut Context<ChangesView>) -> AnyElement {
    let theme = &env.theme;
    let selected = env.selected == Some(file.path.as_str());
    let (added, removed) = if file.binary { (0, 0) } else { (file.added, file.removed) };
    row_shell(row_id(env.source, &file.path), selected, theme)
        .h(CONTROL_SM)
        .pl(px(TREE_INDENT_BASE + depth as f32 * TREE_INDENT_STEP))
        .on_click(select_handler(env, &file.path, cx))
        .child(icon_cell(IconName::File01, IconSize::S14, theme))
        .child(div().min_w_0().flex_1().truncate().text_color(theme.ink).child(name.to_string()))
        .child(count_columns(theme, added, removed))
        .child(status_badge(theme, file.status))
        .into_any_element()
}

fn icon_cell(icon: IconName, size: IconSize, theme: &Theme) -> impl IntoElement {
    div().flex().flex_none().items_center().justify_center().size(px(BADGE)).child(Icon::new(icon).size(size).color(theme.ink3))
}

fn folder_row(
    folder: &DiffTreeFolder<DiffFileEntry>,
    depth: usize,
    hide_totals: bool,
    env: &RowEnv,
    cx: &mut Context<ChangesView>,
) -> AnyElement {
    let theme = &env.theme;
    let collapsed = env.collapsed.contains(&folder.path);
    let path = folder.path.clone();
    let source = env.source.clone();
    let id: SharedString = format!("folder-{}-{}", source.key(), folder.path).into();
    row_shell(id, false, theme)
        .h(CONTROL_SM)
        .pl(px(TREE_INDENT_BASE + depth as f32 * TREE_INDENT_STEP))
        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.toggle_folder(&source, &path, cx)))
        .child(icon_cell(if collapsed { IconName::ArrowRight01 } else { IconName::ArrowDown01 }, IconSize::S12, theme))
        .child(div().min_w_0().flex_1().truncate().text_color(theme.ink2).child(folder.name.clone()))
        .when(!hide_totals, |el| el.child(count_columns(theme, folder.added, folder.removed)))
        // The badge cell stays empty so the count columns line up with the files'.
        .child(div().flex_none().size(px(BADGE)))
        .into_any_element()
}

/// A small change set as a flat list: the file name, with its folder under it (the panel's usual width has no
/// room for a folder column). The folder is cut by the row's width with an ellipsis; `fitFolder`'s whole-segment
/// fitting needs text measurement and is not ported.
fn flat_row(file: &DiffFileEntry, env: &RowEnv, cx: &mut Context<ChangesView>) -> AnyElement {
    let theme = &env.theme;
    let selected = env.selected == Some(file.path.as_str());
    let (dir, name) = match file.path.rsplit_once('/') {
        Some((dir, name)) => (Some(dir.to_string()), name.to_string()),
        None => (None, file.path.clone()),
    };
    let (added, removed) = if file.binary { (0, 0) } else { (file.added, file.removed) };
    let top = |el: gpui::Div| el.h(px(18.0)).flex().items_center();
    row_shell(row_id(env.source, &file.path), selected, theme)
        .h(px(FLAT_ROW_HEIGHT))
        .items_start()
        .px(px(12.0))
        .py(px(3.0))
        .on_click(select_handler(env, &file.path, cx))
        .child(top(div()).child(icon_cell(IconName::File01, IconSize::S14, theme)))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .flex_1()
                .child(div().h(px(18.0)).truncate().text_color(theme.ink).child(name))
                .when_some(dir, |el, dir| el.child(div().h(px(16.0)).truncate().text_step(TEXT_12).text_color(theme.ink3).child(dir))),
        )
        .child(top(div()).child(count_columns(theme, added, removed)))
        .child(top(div()).child(status_badge(theme, file.status)))
        .into_any_element()
}
