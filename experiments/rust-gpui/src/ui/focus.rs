//! Focus for our own primitives (DESIGN.md "States": "Focus is one accent ring ... Menu and picker rows inside a
//! clipped panel keep their fill and add the ring inset").
//!
//! - [`focus_ring`]: the ring for a control that has room around it: 2px solid `accent` at a 2px offset
//!   (`outline: 2px solid var(--accent); outline-offset: 2px` in `styles.css`), drawn only while the control has
//!   keyboard focus (CSS `:focus-visible`: focused and the last input was the keyboard). Put it as the last
//!   child of the focusable element, which must be `.relative()`; it paints outside the element's bounds, so no
//!   ancestor may clip it.
//! - [`inset_ring`]: the same ring drawn inside, for rows in a clipped panel (`focus-visible:-outline-offset-2`):
//!   `.focus_visible(|s| s.shadow(inset_ring(theme.accent)))`.
//! - [`roving_index`]: the desktop's `roving.ts`, which key goes where among a group's items.
//!
//! What gpui-component's own focus ring is (and why adopted widgets do not use it) is in `COMPONENT-FIT.md`:
//! a 3px ring at 50% alpha, flush against the border, its width a crate-private constant.

use gpui::{
    App, BorderStyle, BoxShadow, FocusHandle, Hsla, IntoElement, KeyDownEvent, Pixels, Styled, Window, canvas, px, quad, transparent_black,
};

use crate::theme::ActiveTheme;

/// The ring's stroke (`outline: 2px`).
pub const RING_WIDTH: Pixels = px(2.0);
/// The gap between the control and the ring (`outline-offset: 2px`).
pub const RING_OFFSET: Pixels = px(2.0);

/// The accent focus ring around the element it is a child of, while that element (`handle`) has keyboard focus.
/// `radius` is the element's own corner radius; the ring's is that plus the offset.
pub fn focus_ring(handle: &FocusHandle, radius: Pixels) -> impl IntoElement {
    let handle = handle.clone();
    canvas(
        |_, _, _| (),
        move |bounds, _, window: &mut Window, cx: &mut App| {
            if handle.is_focused(window) && window.last_input_was_keyboard() {
                let grow = RING_WIDTH + RING_OFFSET;
                window.paint_quad(quad(
                    bounds.dilate(grow),
                    radius + grow,
                    transparent_black(),
                    RING_WIDTH,
                    Hsla::from(cx.theme().accent),
                    BorderStyle::Solid,
                ));
            }
        },
    )
    .absolute()
    .inset_0()
    .size_full()
}

/// The ring inside the element's edge: a 2px inset shadow in `color` (the accent). For a `.focus_visible(..)`
/// style on a row in a clipped panel, where the outer ring would be cut off.
pub fn inset_ring(color: impl Into<Hsla>) -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(0.0), color.into()).spread_radius(RING_WIDTH).inset()]
}

/// Which arrow keys a roving group answers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RovingAxis {
    Horizontal,
    Vertical,
    Both,
}

/// Where a roving-focus key goes among `count` items from `index` (`None`: nothing has focus yet): the arrows on
/// `axis` step by one, Home and End go to the ends; a list wraps round. `None` when the key does not move
/// (`roving.ts`'s `rovingIndex` without the grid mode, which no primitive here uses). `key` is a GPUI key name
/// (`"left"`, `"down"`, `"home"`).
pub fn roving_index(key: &str, index: Option<usize>, count: usize, axis: RovingAxis) -> Option<usize> {
    if count == 0 {
        return None;
    }
    match key {
        "home" => return Some(0),
        "end" => return Some(count - 1),
        _ => {}
    }
    let horizontal = axis != RovingAxis::Vertical;
    let vertical = axis != RovingAxis::Horizontal;
    let step: isize = match key {
        "left" if horizontal => -1,
        "right" if horizontal => 1,
        "up" if vertical => -1,
        "down" if vertical => 1,
        _ => return None,
    };
    Some(match index {
        None if step > 0 => 0,
        None => count - 1,
        Some(index) => (index as isize + step).rem_euclid(count as isize) as usize,
    })
}

/// The keyed focus handle of the item `id`: stable across frames, so a stateless `RenderOnce` primitive can be
/// focusable without owning an entity.
pub fn item_focus(id: &gpui::ElementId, window: &mut Window, cx: &mut App) -> FocusHandle {
    window.use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone()
}

/// Whether the focus is on one of `handles`, and which.
pub fn focused_index(handles: &[FocusHandle], window: &Window) -> Option<usize> {
    handles.iter().position(|handle| handle.is_focused(window))
}

/// The `on_key_down` handler of a roving group (`radioKeys` in `Segmented.tsx`): the arrows (per `axis`), Home and
/// End move focus to the next enabled item and call `pick` with its index, so the choice follows the focus, as a
/// radio group's does. `handles` are the enabled items' focus handles, `indices` their positions among all the
/// group's items.
pub fn roving_keys(
    handles: Vec<FocusHandle>,
    indices: Vec<usize>,
    axis: RovingAxis,
    pick: impl Fn(usize, &mut Window, &mut App) + 'static,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    move |event, window, cx| {
        let current = focused_index(&handles, window);
        if let Some(to) = roving_index(&event.keystroke.key, current, handles.len(), axis) {
            handles[to].focus(window, cx);
            pick(indices[to], window, cx);
            cx.stop_propagation();
        }
    }
}
