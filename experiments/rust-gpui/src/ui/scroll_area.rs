//! [`ScrollArea`]: the app's vertical scroll container (the desktop's `primitives/ScrollArea.tsx`), filling
//! its parent, with an overlay scrollbar (DESIGN.md "States": the thumb shows while its scroller is hovered
//! or scrolling, as on macOS).
//!
//! The scrollbar is gpui-component's (`ScrollableElement::vertical_scrollbar`), so it draws with
//! gpui-component's theme colours until that theme is fed from ours. Pass the `ScrollHandle` you keep on
//! your view to scroll it from code (`scroll_to_item`, `set_offset`). `.fade(surface)` adds the edge fades
//! (`scroll_fade.rs`) in the surface's colour. Not built: scroll chaining to an outer scroller.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, Hsla, IntoElement, ParentElement, RenderOnce, ScrollHandle, Window, div, prelude::*};
use gpui_component::scroll::ScrollableElement as _;

use super::scroll_fade::{Anim, ScrollFade};

#[derive(IntoElement)]
pub struct ScrollArea {
    id: ElementId,
    handle: ScrollHandle,
    children: Vec<AnyElement>,
    fade: Option<Hsla>,
}

impl ScrollArea {
    pub fn new(id: impl Into<ElementId>, handle: &ScrollHandle) -> Self {
        Self { id: id.into(), handle: handle.clone(), children: Vec::new(), fade: None }
    }

    /// Fades each edge that has more to scroll to into `surface`, the colour behind the area (React's `.scroll-fade`).
    pub fn fade(mut self, surface: impl Into<Hsla>) -> Self {
        self.fade = Some(surface.into());
        self
    }
}

impl ParentElement for ScrollArea {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ScrollArea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let selector = self.id.to_string();
        let overlay = self.fade.map(|surface| {
            // The fade animation outlives this render: it lives in window state keyed by the area's id.
            let anim = window.use_keyed_state(ElementId::from((self.id.clone(), "fade")), cx, |_, _| Rc::new(Cell::<Anim>::default()));
            ScrollFade::with_anim(&self.handle, anim.read(cx).clone()).overlay(surface)
        });
        let scroller = div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .track_scroll(&self.handle)
            .children(self.children)
            .vertical_scrollbar(&self.handle);
        // The fades sit over the scroller, not in it: they must not scroll with the content.
        match overlay {
            Some(overlay) => div().relative().size_full().child(scroller).child(overlay).into_any_element(),
            None => scroller.into_any_element(),
        }
    }
}
