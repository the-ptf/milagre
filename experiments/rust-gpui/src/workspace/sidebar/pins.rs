//! Pin and Unpin on this device (`ChatRow`'s menu, `chatRowActions.onPin`, `lib/chat-pins.ts`).
//!
//! Pins belong to the device that made them, so pinning writes `milagre.chatPins` (here: [`DevicePins`] on the
//! sidebar) and never the Chat. The list rules read the effective pins through
//! [`sessions_with_pins`](crate::logic::lists::pins::sessions_with_pins); the first pin in a scope copies the shared
//! ones the Chats carried, which [`set_pin`] does.

use super::list::SidebarData;
use crate::data::Chat;
use crate::logic::lists::chats::pin_order_at;
use crate::logic::lists::pins::{DevicePins, scope_pins, sessions_with_pins, set_pin};

/// The Chats of scope `scope` as this device's pins show them.
pub fn effective_chats(data: &SidebarData, pins: &DevicePins, scope: usize) -> Vec<Chat> {
    let Some(scope) = data.scopes.get(scope) else { return Vec::new() };
    let key = scope.project.scope();
    let pinned = sessions_with_pins(&scope.state.sessions, key.as_str(), pins);
    pinned.as_ref().unwrap_or(&scope.state.sessions).values().cloned().collect()
}

/// The pin order Chat `id` has on this device, `None` when it is not pinned.
pub fn pin_of(data: &SidebarData, pins: &DevicePins, scope: usize, id: u64) -> Option<f64> {
    let scope = data.scopes.get(scope)?;
    let key = scope.project.scope();
    let own = scope_pins(pins, key.as_str(), scope.state.sessions.values());
    own.get(&id.to_string()).copied()
}

/// Where a Chat pinned now goes: after the Chats pinned in its scope (`pinOrderAt(orders, orders.length)`).
pub fn next_order(data: &SidebarData, pins: &DevicePins, scope: usize, id: u64) -> f64 {
    let orders: Vec<f64> = effective_chats(data, pins, scope)
        .iter()
        .filter(|chat| chat.pinned && chat.id != id)
        .map(|chat| chat.pin_order.unwrap_or(0.0))
        .collect();
    pin_order_at(&orders, orders.len())
}

/// `pins` with Chat `id` of `scope` pinned at `order`, or unpinned for `None`.
pub fn with_order(data: &SidebarData, pins: &DevicePins, scope: usize, id: u64, order: Option<f64>) -> DevicePins {
    let Some(scope_data) = data.scopes.get(scope) else { return pins.clone() };
    let key = scope_data.project.scope();
    let chats: Vec<Chat> = scope_data.state.sessions.values().cloned().collect();
    set_pin(pins, key.as_str(), &chats, id, order)
}
