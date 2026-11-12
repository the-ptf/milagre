//! This device's sidebar choices, for a data layer that keeps them between launches: the pins (`milagre.chatPins`),
//! the computers Filters leaves out (`milagre.hiddenComputers`) and what a row's second line shows (`chatRowShow`).
//! The desktop keeps all three in its own preferences, never on the host; the sidebar holds them while it runs and
//! reports each change through [`SidebarActions`](super::SidebarActions) (`Pin`, `SetComputerHidden`, `SetRowField`).
//! A data layer reads them back with [`Sidebar::device_pins`], `hidden_computers` and `show_fields`.

use std::collections::HashSet;

use gpui::Context;

use super::Sidebar;
use crate::logic::lists::chat_row::ChatRowShow;
use crate::logic::lists::pins::DevicePins;

impl Sidebar {
    /// This device's pins, by scope key.
    pub fn device_pins(&self) -> &DevicePins {
        &self.list_filters.pins
    }

    /// Puts back the choices a data layer kept (at launch): the rows are built again from them.
    pub fn set_device_prefs(&mut self, pins: DevicePins, hidden_computers: HashSet<String>, show: ChatRowShow, cx: &mut Context<Self>) {
        self.list_filters.pins = pins;
        self.list_filters.hidden_computers = hidden_computers;
        self.show = show;
        self.rebuild(None, cx);
        cx.notify();
    }
}
