//! The Chat identity and the Subchat bookmark in the Chat column's top strip (`ChatIdentity.tsx`,
//! `SubchatBookmark.tsx`, `FamilyMenu.tsx`, `family-menu.ts`).
//!
//! A top-level Chat shows its title (13 medium ink) and its Project (13 ink-3). A Subchat shows where it lives:
//! `‹ ● Parent / Subchat ⇅`: the left button goes up one level, the right one opens the family menu (the Chats above,
//! the family with live states and a tick on the open one, and the two ways into a split). A Chat that delegated
//! further up shows only its nearest listed ancestor, the older ones collapsing into a "…" that opens the same menu.
//! It is read from the Chat's own `parent`, so it survives a reload.
//!
//! The model is plain data (`FamilyChat`) and the two helpers that read it are `logic::lists::subchats`
//! (`chat_bookmark`, `chat_family`). Not built: the Routine chip beside it and the bookmark reserve that keeps the
//! chip clear (Routines are another package), the ⌘[ shortcut, "Open beside parent" and "Show all side by side"
//! (the split view is WP-33: the rows emit `ChatEvent::Beside` and `ChatEvent::ShowAll`, which nothing handles yet).

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, IntoElement, MouseDownEvent, ParentElement, SharedString, Styled, div,
    prelude::*, px,
};

use crate::logic::activity::subchat_states::SubchatKind;
use crate::logic::lists::subchats::{FamilySession, FamilySessions, chat_bookmark, chat_family};
use crate::logic::marks::chat_mark::{ChatMark, chat_mark_tone};
use crate::logic::marks::tone::Tone;
use crate::theme::{RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, SectionLabel};
use crate::workspace::chat::ChatView;

use super::subchats::ink;

/// What the bookmark and the family menu read from one Chat.
#[derive(Clone, Debug, PartialEq)]
pub struct FamilyChat {
    pub key: String,
    pub title: String,
    pub parent: Option<String>,
    pub archived: bool,
    pub done: bool,
    pub kind: SubchatKind,
    pub mark: ChatMark,
    pub background: usize,
}

/// One Chat of the family menu: its live dot, title and state in words.
#[derive(Clone, Debug, PartialEq)]
pub struct FamilyEntry {
    pub key: String,
    pub title: String,
    pub word: &'static str,
    pub kind: SubchatKind,
    pub mark: ChatMark,
    pub background: usize,
    /// "Top Chat" for the family's root, "Parent" for the open Chat's parent.
    pub role: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FamilyMenu {
    /// The Chats above the open one, the top Chat first, the direct parent last.
    pub ancestors: Vec<FamilyEntry>,
    /// The family's Chats that are not above the open one, oldest first; the open Chat is one of them.
    pub subchats: Vec<FamilyEntry>,
    /// Every Chat in the family, the top Chat included.
    pub size: usize,
}

/// What the bookmark shows over an open Subchat.
#[derive(Clone, Debug, PartialEq)]
pub struct Bookmark {
    pub parent: FamilyEntry,
    /// How many older ancestors the "…" stands for.
    pub above: usize,
    pub title: String,
    /// The parent waits on an answer or an approval: its button is tinted and says so.
    pub needs_you: bool,
}

fn id_of(key: &str) -> Option<u64> {
    key.rsplit('#').next()?.parse().ok()
}

fn sessions(chats: &[FamilyChat]) -> FamilySessions {
    chats
        .iter()
        .filter_map(|chat| {
            let id = id_of(&chat.key)?;
            let parent = chat.parent.as_deref().and_then(id_of);
            Some((id, FamilySession { id, parent, archived: chat.archived, done_at: chat.done.then_some(1) }))
        })
        .collect()
}

fn entry(chats: &[FamilyChat], key: &str, subchat: bool, role: Option<&'static str>) -> Option<FamilyEntry> {
    let chat = chats.iter().find(|chat| chat.key == key)?;
    // A Chat above the open one has no "Done" of its own to report: a finished turn there is just idle.
    let word = if !subchat && chat.kind == SubchatKind::Done && !chat.done { "Idle" } else { chat.kind.label() };
    Some(FamilyEntry {
        key: key.to_string(),
        title: chat.title.clone(),
        word,
        kind: chat.kind,
        mark: chat.mark,
        background: chat.background,
        role,
    })
}

/// `chatBookmark` for the open Chat `key`, or `None` for a Chat with no listed ancestor.
pub fn bookmark(chats: &[FamilyChat], key: &str) -> Option<Bookmark> {
    let found = chat_bookmark(Some(&sessions(chats)), key)?;
    let parent = entry(chats, &found.parent, false, None)?;
    let title = chats.iter().find(|chat| chat.key == key)?.title.clone();
    let needs_you = matches!(parent.mark, ChatMark::Question | ChatMark::Waiting);
    Some(Bookmark { parent, above: found.above.len(), title, needs_you })
}

/// `familyMenuModel`: the family menu of the open Chat `key`, or `None` for a Chat with no family.
pub fn family_menu(chats: &[FamilyChat], key: &str) -> Option<FamilyMenu> {
    let map = sessions(chats);
    let (root, children) = chat_family(Some(&map), key)?;
    let found = chat_bookmark(Some(&map), key);
    let above: Vec<String> = found.map(|found| found.above.iter().cloned().chain([found.parent.clone()]).collect()).unwrap_or_default();
    let parent = chat_bookmark(Some(&map), key).map(|found| found.parent);
    let ancestors = above
        .iter()
        .filter_map(|at| {
            let role = if Some(at) == parent.as_ref() {
                Some("Parent")
            } else if *at == root {
                Some("Top Chat")
            } else {
                None
            };
            entry(chats, at, false, role)
        })
        .collect();
    let subchats = children.iter().filter(|at| !above.contains(at)).filter_map(|at| entry(chats, at, true, None)).collect();
    Some(FamilyMenu { ancestors, subchats, size: children.len() + 1 })
}

fn tone_color(tone: Tone, theme: &Theme) -> gpui::Rgba {
    match tone {
        Tone::Accent => theme.accent,
        Tone::Green => theme.green,
        Tone::Orange => theme.orange,
        Tone::Red => theme.red,
        Tone::Ink3 => theme.ink3,
        Tone::Ink4 => theme.ink4,
    }
}

fn dot(mark: ChatMark, theme: &Theme) -> AnyElement {
    div().flex_none().size(px(8.0)).rounded_full().bg(tone_color(chat_mark_tone(mark), theme)).into_any_element()
}

/// `ChatIdentity`: the title and, after it, the Project.
pub fn identity(title: SharedString, project: SharedString, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .min_w_0()
        .items_baseline()
        .gap_2()
        .child(
            div()
                .debug_selector(|| "chat-identity-title".into())
                .min_w_0()
                .truncate()
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .child(title),
        )
        .child(div().debug_selector(|| "chat-identity-project".into()).flex_none().text_step(TEXT_13).text_color(theme.ink3).child(project))
        .into_any_element()
}

fn crumb(id: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex()
        .items_center()
        .h(px(28.0))
        .min_w_0()
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
}

fn divider(theme: &Theme) -> AnyElement {
    div().flex_none().px_0p5().text_step(TEXT_13).text_color(theme.ink4).child("/").into_any_element()
}

/// `SubchatBookmark`: `… / ‹ ● Parent / Subchat ⇅`.
pub fn bookmark_view(bookmark: &Bookmark, menu_open: bool, theme: &Theme, cx: &mut Context<ChatView>) -> AnyElement {
    let theme = *theme;
    let parent_key = bookmark.parent.key.clone();
    let needs = bookmark.needs_you;
    let toggle = cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_family_menu(cx));
    let toggle_more = cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_family_menu(cx));
    div()
        .flex()
        .min_w_0()
        .items_center()
        .gap_1()
        .when(bookmark.above > 0, |el| {
            el.child(
                crumb("bookmark-more")
                    .w(px(28.0))
                    .flex_none()
                    .justify_center()
                    .text_color(theme.ink3)
                    .hover(move |style| style.bg(theme.hover).text_color(theme.ink))
                    .child(Icon::new(IconName::MoreHorizontal).size(IconSize::S14).color(theme.ink3))
                    .on_click(toggle_more),
            )
            .child(divider(&theme))
        })
        .child(
            crumb("bookmark-parent")
                .max_w(px(if needs { 260.0 } else { 180.0 }))
                .pl_1p5()
                .pr(px(10.0))
                .bg(if needs { theme.orange_tint } else { theme.field })
                .text_color(if needs { theme.ink } else { theme.ink2 })
                .hover(move |style| style.bg(if needs { theme.orange_tint } else { theme.hover2 }))
                .child(div().mr_1().flex_none().child(Icon::new(IconName::ArrowLeft01).size(IconSize::S14).color(theme.ink2)))
                .child(div().mr_1().child(dot(bookmark.parent.mark, &theme)))
                .child(div().min_w_0().truncate().child(bookmark.parent.title.clone()))
                .when(needs, |el| {
                    el.child(
                        div()
                            .ml_1p5()
                            .flex_none()
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.orange_ink)
                            .child("Needs you"),
                    )
                })
                .on_click(
                    cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(crate::workspace::chat::ChatEvent::OpenChat(parent_key.clone()))),
                ),
        )
        .child(divider(&theme))
        .child(
            crumb("bookmark-current")
                .max_w(px(240.0))
                .gap_1()
                .px_2()
                .text_color(theme.ink)
                .when(menu_open, |el| el.bg(theme.hover))
                .hover(move |style| style.bg(theme.hover))
                .child(div().min_w_0().truncate().child(bookmark.title.clone()))
                .child(div().flex_none().child(Icon::new(IconName::UnfoldMore).size(IconSize::S14).color(theme.ink3)))
                .on_click(toggle),
        )
        .into_any_element()
}

fn family_row(entry: &FamilyEntry, open: bool, theme: &Theme, cx: &mut Context<ChatView>) -> AnyElement {
    let theme = *theme;
    let key = entry.key.clone();
    let selector = format!("family-chat-{}", entry.key);
    div()
        .id(ElementId::from(SharedString::from(selector.clone())))
        .debug_selector(move || selector.clone())
        .flex()
        .items_center()
        .gap_2()
        .h(px(32.0))
        .px_2()
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_13)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.hover))
        .child(div().w(px(16.0)).flex().flex_none().justify_center().child(if open {
            Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink).into_any_element()
        } else {
            dot(entry.mark, &theme)
        }))
        .child(div().flex_1().min_w_0().truncate().text_color(theme.ink).child(entry.title.clone()))
        .child(
            div()
                .flex_none()
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .flex()
                .children(
                    entry.role.map(|role| div().font_weight(FontWeight::NORMAL).text_color(theme.ink3).child(format!("{role} \u{b7} "))),
                )
                .child(div().text_color(if entry.word == "Idle" { theme.ink3 } else { ink(entry.kind, &theme) }).child(entry.word)),
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.close_family_menu(cx);
            if !open {
                cx.emit(crate::workspace::chat::ChatEvent::OpenChat(key.clone()));
            }
        }))
        .into_any_element()
}

/// `FamilyMenu`: 320 wide, hung under the bookmark.
pub fn family_menu_view(menu: &FamilyMenu, open_key: &str, has_parent: bool, theme: &Theme, cx: &mut Context<ChatView>) -> AnyElement {
    let theme = *theme;
    let count = if menu.subchats.len() == 1 { "1 Subchat".to_string() } else { format!("{} Subchats", menu.subchats.len()) };
    let action = |id: &'static str, icon: IconName, title: String, event: crate::workspace::chat::ChatEvent, cx: &mut Context<ChatView>| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex()
            .items_center()
            .gap_2()
            .h(px(32.0))
            .px_2()
            .rounded(RADIUS_CONTROL)
            .text_step(TEXT_13)
            .text_color(theme.ink)
            .cursor_pointer()
            .hover(move |style| style.bg(theme.hover))
            .child(div().w(px(16.0)).flex().flex_none().justify_center().child(Icon::new(icon).size(IconSize::S14).color(theme.ink2)))
            .child(title)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.close_family_menu(cx);
                cx.emit(event.clone());
            }))
    };
    let parent_key = menu.ancestors.last().map(|entry| entry.key.clone()).unwrap_or_default();
    div()
        .id("family-menu")
        .debug_selector(|| "family-menu".into())
        .absolute()
        .left(px(16.0))
        .top(px(40.0))
        .w(px(320.0))
        .p_1()
        .flex()
        .flex_col()
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .occlude()
        .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, _, cx| this.close_family_menu(cx)))
        .children(menu.ancestors.iter().map(|entry| family_row(entry, false, &theme, cx)))
        .child(div().px_2().pt_1p5().pb_1().child(SectionLabel::new(count).menu()))
        .children(menu.subchats.iter().map(|entry| family_row(entry, entry.key == open_key, &theme, cx)))
        .child(div().my_1().h(px(1.0)).bg(theme.line))
        .when(has_parent, |el| {
            el.child(action(
                "family-beside",
                IconName::LayoutTwoColumn,
                "Open beside parent".into(),
                crate::workspace::chat::ChatEvent::Beside(parent_key.clone()),
                cx,
            ))
        })
        .child(action(
            "family-all",
            IconName::GridView,
            format!("Show all {} side by side", menu.size),
            crate::workspace::chat::ChatEvent::ShowAll,
            cx,
        ))
        .into_any_element()
}
