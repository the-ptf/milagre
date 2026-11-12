//! What a data layer cannot do yet, turned off in the composer, and the bar values it reads on a send.
//!
//! The fixture app keeps everything on ([`ComposerLimits::default`]). A data layer whose backend has no attachments
//! turns them off (no Attach button; pasted or dropped files and images are not taken), and one whose model is fixed
//! when it starts locks the model picker to that model (the chip and the effort, fast and permission controls stay).

use gpui::Context;

use super::Composer;
use crate::data::PermissionMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ComposerLimits {
    /// The Attach button, pasted images and files, and dropped files.
    pub attachments: bool,
    /// The model picker keeps the current model: picking another one does nothing.
    pub model_locked: bool,
}

impl Default for ComposerLimits {
    fn default() -> Self {
        Self { attachments: true, model_locked: false }
    }
}

impl Composer {
    pub fn set_limits(&mut self, limits: ComposerLimits, cx: &mut Context<Self>) {
        self.limits = limits;
        cx.notify();
    }

    pub fn limits(&self) -> ComposerLimits {
        self.limits
    }

    /// The permission mode the picker's footer shows (sent with each message).
    pub fn permission_mode(&self) -> PermissionMode {
        self.bar.permission
    }

    /// The thinking effort picked for the next send (`None`: the model's default).
    pub fn effort_id(&self) -> Option<&'static str> {
        self.bar.effort_id
    }
}
