//! [`ScrollArea`]: the app's vertical scroll container (the desktop's `primitives/ScrollArea.tsx`), filling
//! its parent, with an overlay scrollbar (DESIGN.md "States": the thumb shows while its scroller is hovered
//! or scrolling, as on macOS).
//!
//! The scrollbar is gpui-component's (`ScrollableElement::vertical_scrollbar`), so it draws with
//! gpui-component's theme colours until that theme is fed from ours. Pass the `ScrollHandle` you keep on
//! your view to scroll it from code (`scroll_to_item`, `set_offset`). Not built: the edge fades and
//! scroll chaining to an outer scroller.

use gpui::{AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, ScrollHandle, Window, div, prelude::*};
use gpui_component::scroll::ScrollableElement as _;

#[derive(IntoElement)]
pub struct ScrollArea {
    id: ElementId,
    handle: ScrollHandle,
    children: Vec<AnyElement>,
}

impl ScrollArea {
    pub fn new(id: impl Into<ElementId>, handle: &ScrollHandle) -> Self {
        Self { id: id.into(), handle: handle.clone(), children: Vec::new() }
    }
}

impl ParentElement for ScrollArea {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ScrollArea {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let selector = self.id.to_string();
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .track_scroll(&self.handle)
            .children(self.children)
            .vertical_scrollbar(&self.handle)
    }
}
