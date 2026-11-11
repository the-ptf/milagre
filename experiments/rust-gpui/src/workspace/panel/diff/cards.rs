//! The comment slot under a line (`DiffComments.tsx`): its cards (label, Outdated, the body clamped to three lines
//! until clicked, Edit and Delete) and the editor (Cancel, Send to Chat on a PR's diff, Comment or Add to review
//! with ⌘↵). Esc in the editor cancels and goes no further, so the app's own Esc (stop the turn) never sees it.

use gpui::{AnyElement, ClickEvent, Context, KeyDownEvent, SharedString, Window, div, prelude::*, px};

use super::comments::{CommentView, label_for};
use super::view::DiffView;
use crate::theme::{RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, IconButton, IconButtonSize, IconName, ShortcutKeys, TextArea};

impl DiffView {
    /// The cards `ids` and, when `editor` is set, the editor below them.
    pub(super) fn comment_slot(
        &self,
        ids: &[String],
        editor: Option<()>,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let editing = self.draft.as_ref().and_then(|d| d.editing.clone());
        let cards: Vec<AnyElement> = ids
            .iter()
            .filter(|id| editing.as_deref() != Some(id.as_str()))
            .filter_map(|id| self.comment_view(id))
            .map(|view| self.comment_card(&view, theme, window, cx))
            .collect();
        div()
            .debug_selector(|| "diff-comment-slot".to_string())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(12.0))
            .py(px(8.0))
            .bg(theme.surface)
            .text_step(TEXT_12)
            .children(cards)
            .children(editor.and_then(|_| self.comment_editor(theme, cx)))
            .into_any_element()
    }

    pub(super) fn comment_card(&self, view: &CommentView, theme: &Theme, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let comment = &view.comment;
        let id = comment.id.clone();
        let expanded = self.expanded_comments.contains(&id);
        let body_id = id.clone();
        let edit_id = id.clone();
        let delete_id = id.clone();
        div()
            .debug_selector({
                let key = format!("diff-comment-{id}");
                move || key.clone()
            })
            .flex()
            .items_start()
            .gap(px(8.0))
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(theme.line)
            .bg(theme.inset)
            .py(px(6.0))
            .pr(px(6.0))
            .pl(px(10.0))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_step(TEXT_11)
                            .child(div().font_family(mono()).text_color(theme.ink3).child(label_for(comment.start, comment.end)))
                            .when(view.outdated, |el| {
                                el.child(
                                    div().debug_selector(|| "diff-comment-outdated".to_string()).text_color(theme.ink3).child("Outdated"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("diff-comment-body-{id}")))
                            .debug_selector(|| "diff-comment-body".to_string())
                            .mt(px(2.0))
                            .w_full()
                            .cursor_pointer()
                            .text_color(if view.outdated { theme.ink3 } else { theme.ink })
                            .when(!expanded, |el| el.line_clamp(3))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_comment_expanded(&body_id, cx)))
                            .child(comment.body.clone()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.0))
                    .when(!view.outdated, |el| {
                        el.child(
                            IconButton::new(SharedString::from(format!("diff-comment-edit-{id}")), IconName::PencilEdit02)
                                .size(IconButtonSize::S24)
                                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.edit_comment(&edit_id, window, cx))),
                        )
                    })
                    .child(
                        IconButton::new(SharedString::from(format!("diff-comment-delete-{id}")), IconName::Delete02)
                            .size(IconButtonSize::S24)
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.delete_comment(&delete_id, cx))),
                    ),
            )
            .into_any_element()
    }

    fn comment_editor(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let editor = self.editor.clone()?;
        let review = self.source.as_ref().is_some_and(|s| s.review) && self.draft.as_ref().is_some_and(|d| d.editing.is_none());
        let empty = editor.read(cx).value().trim().is_empty();
        let save = Button::new("diff-comment-save", if review { "Add to review" } else { "Comment" })
            .size(ButtonSize::S28)
            .selector("diff-comment-save")
            .disabled(empty)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                if review {
                    this.add_to_review(cx);
                } else {
                    this.save_comment(window, cx);
                }
            }));
        Some(
            div()
                .debug_selector(|| "diff-comment-editor".to_string())
                .flex()
                .flex_col()
                .gap(px(8.0))
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.cancel_comment(cx);
                    }
                }))
                .child(TextArea::new("diff-comment-input", &editor))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            Button::new("diff-comment-cancel", "Cancel")
                                .variant(ButtonVariant::Ghost)
                                .size(ButtonSize::S28)
                                .selector("diff-comment-cancel")
                                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.cancel_comment(cx))),
                        )
                        .when(review, |el| {
                            el.child(
                                Button::new("diff-comment-chat", "Send to Chat")
                                    .variant(ButtonVariant::Secondary)
                                    .size(ButtonSize::S28)
                                    .selector("diff-comment-chat")
                                    .disabled(empty)
                                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.save_comment(window, cx))),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(save)
                                .child(div().text_color(theme.ink3).child(ShortcutKeys::new("\u{2318}\u{21b5}").plain())),
                        ),
                )
                .into_any_element(),
        )
    }
}
