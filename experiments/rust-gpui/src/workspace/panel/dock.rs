//! The dock: where the side panel sits beside the Chat. Its widths (the desktop's `panel-width.ts`), the
//! resizable split (gpui-component's `h_resizable`), the double-click on the edge that resets the width, and the
//! keyboard shortcuts that show and hide the panels (`logic::keybindings`).
//!
//! Layout and look values live here and in `mod.rs`'s header: switching looks touches those and the theme.

use gpui::{
    AnyElement, AnyView, App, Entity, InteractiveElement, KeyBinding, MouseButton, MouseDownEvent, Pixels, StyleRefinement, Window,
    actions, canvas, div, prelude::*, px,
};
use gpui_component::resizable::ResizableState;
use gpui_component::{h_resizable, resizable_panel};

use super::{Panel, PanelTab};
use crate::logic::keybindings::{GpuiOptions, default_keybindings, gpui_bindings};
use crate::workspace::shell::card;

/// The narrowest the Chat gets while a panel beside it is dragged wider (`MIN_CHAT_WIDTH`).
pub const MIN_CHAT_WIDTH: f32 = 420.0;
/// How far either side of the panel's left edge a double-click counts as on the edge.
const EDGE_GRAB: f32 = 4.0;

/// How wide a panel may be dragged and where it opens (`PANEL_WIDTHS`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidthRule {
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

impl WidthRule {
    pub fn clamp(self, width: f32) -> f32 {
        width.clamp(self.min, self.max).round()
    }
}

/// The one width every tab shares: switching tabs never changes it, and a drag changes it for all of them. The
/// default is the Changes panel's (`PANEL_WIDTHS.changes.default`); the bounds are the loosest any tab had (Designs
/// and Artifact went to 1400), and `MIN_CHAT_WIDTH` still keeps the Chat readable.
pub const WIDTH_RULE: WidthRule = WidthRule { min: 280.0, default: 320.0, max: 1400.0 };

actions!(milagre_gpui_panel, [ToggleChanges, ToggleTerminal, ToggleDesigns, ToggleArtifacts, ToggleSimulator]);

/// The commands bound here. `terminal.toggle` shows the Terminals drawer (`panel/terminal/`), not a panel tab.
const COMMANDS: [&str; 5] = ["changes.toggle", "terminal.toggle", "designs.toggle", "artifacts.toggle", "simulator.toggle"];

/// Binds the panel's commands from the effective key table (`default_keybindings`), once per app.
pub fn install_keys(cx: &mut App) {
    struct Installed;
    impl gpui::Global for Installed {}
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    let bindings = gpui_bindings(&default_keybindings(), cfg!(target_os = "macos"), GpuiOptions::default());
    let keys: Vec<KeyBinding> = bindings
        .iter()
        .filter_map(|binding| {
            // GPUI keeps the binding's strings for the life of the app; these few are installed once.
            let context: Option<&'static str> = binding.context.clone().map(|c| &*c.leak());
            let stroke: &'static str = binding.keystroke.clone().leak();
            Some(match binding.command.as_str() {
                "changes.toggle" => KeyBinding::new(stroke, ToggleChanges, context),
                "terminal.toggle" => KeyBinding::new(stroke, ToggleTerminal, context),
                "designs.toggle" => KeyBinding::new(stroke, ToggleDesigns, context),
                "artifacts.toggle" => KeyBinding::new(stroke, ToggleArtifacts, context),
                "simulator.toggle" => KeyBinding::new(stroke, ToggleSimulator, context),
                _ => return None,
            })
        })
        .collect();
    debug_assert!(COMMANDS.iter().all(|id| bindings.iter().any(|b| b.command == *id)), "every panel command has a default key");
    cx.bind_keys(keys);
}

/// Hooks the panel's actions onto `element` (the Workspace root), so a shortcut works wherever focus is.
pub fn on_actions<E: InteractiveElement>(element: E, panel: &Entity<Panel>) -> E {
    let toggle = |panel: &Entity<Panel>, tab: PanelTab| {
        let panel = panel.clone();
        move |cx: &mut App| panel.update(cx, |panel, cx| panel.toggle_tab(tab, cx))
    };
    let (changes, designs, artifacts) =
        (toggle(panel, PanelTab::Changes), toggle(panel, PanelTab::Designs), toggle(panel, PanelTab::Artifact));
    element
        .on_action(move |_: &ToggleChanges, _, cx| changes(cx))
        .on_action(move |_: &ToggleDesigns, _, cx| designs(cx))
        .on_action(move |_: &ToggleArtifacts, _, cx| artifacts(cx))
        .on_action({
            // Only a Chat with an attached simulator has the tab (`PanelToggles.tsx` offers it then).
            let panel = panel.clone();
            move |_: &ToggleSimulator, _, cx| {
                panel.update(cx, |panel, cx| {
                    if panel.visible_tabs().contains(&PanelTab::Simulator) {
                        panel.toggle_tab(PanelTab::Simulator, cx)
                    }
                })
            }
        })
}

/// The columns right of the sidebar: the Chat, and the panel beside it when open. Open, they are one
/// `h_resizable` group (the panel's left edge drags); closed, the Chat alone.
pub fn layout(panel: &Entity<Panel>, chat: impl IntoElement + 'static, cx: &mut App) -> AnyElement {
    let (open, width, state) = {
        let p = panel.read(cx);
        (p.is_open(), p.width(), p.resizable().clone())
    };
    let body = |panel: &Entity<Panel>| AnyView::from(panel.clone()).cached(StyleRefinement::default().size_full());
    if !open {
        return div().flex().flex_1().min_w_0().h_full().child(chat).into_any_element();
    }
    let rule = WIDTH_RULE;
    let on_resize = {
        let panel = panel.clone();
        move |state: &Entity<ResizableState>, _: &mut Window, cx: &mut App| {
            let width = state.read(cx).sizes().get(1).copied().map(f32::from);
            if let Some(width) = width {
                panel.update(cx, |panel, _| panel.set_width(width));
            }
        }
    };
    // The resize handle occludes what is behind it, so a hit-tested listener never hears a press on the edge:
    // the double-click is read by a window-level listener (capture phase) that checks the edge itself.
    let reset = {
        let (panel, state) = (panel.clone(), state.clone());
        canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                let (panel, state) = (panel.clone(), state.clone());
                window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                    if !phase.capture() || event.button != MouseButton::Left || event.click_count != 2 {
                        return;
                    }
                    let Some(width) = state.read(cx).sizes().get(1).copied() else { return };
                    let edge = window.viewport_size().width - width;
                    if (event.position.x - edge).abs() <= px(EDGE_GRAB) {
                        panel.update(cx, |panel, cx| panel.reset_width(cx));
                    }
                });
            },
        )
        .absolute()
        .size_0()
    };
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .child(reset)
        .child(
            h_resizable("dock")
                // No line between the Chat card and the panel: the handle is the card's right gap, seen by its cursor.
                .with_handle_appearance(quiet_handle())
                .with_state(&state)
                .on_resize(on_resize)
                .child(resizable_panel().size_range(px(MIN_CHAT_WIDTH)..Pixels::MAX).child(chat))
                .child(
                    resizable_panel()
                        .size(px(width))
                        .size_range(px(rule.min)..px(rule.max))
                        .fixed()
                        .child(div().relative().size_full().pl(card::panel_lead()).child(body(panel))),
                ),
        )
        .into_any_element()
}

/// gpui-base's `ResizeHandleRenderer`, which gpui-component does not re-export: `C` is its handle context.
type HandleRenderer<C> = std::rc::Rc<dyn Fn(&C, &mut Window, &mut App) -> Option<AnyElement>>;

/// A resize handle that paints nothing: the edge it drags is the gap between the Chat card and the panel.
fn quiet_handle<C: 'static>() -> HandleRenderer<C> {
    std::rc::Rc::new(|_, _, _| Some(div().into_any_element()))
}
