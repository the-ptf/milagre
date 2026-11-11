//! What each Chat has to show in its panel while there is no daemon: its Worktree's Changes and whether it
//! has designs, artifacts or a PR. Panel-local (`src/data` carries none of this yet); the panel reads it
//! through [`content_for`], the one seam a daemon-backed source replaces.

use super::PanelTab;
use super::changes::data::ChangesData;
use super::changes::fixture::{self, Variant};

/// One Chat's panel content.
#[derive(Clone, Debug)]
pub struct ChatContent {
    pub changes: ChangesData,
    pub designs: bool,
    pub artifacts: bool,
    pub pr: Option<u32>,
}

impl ChatContent {
    /// Whether the Chat has something for `tab`. Changes and Browser are always there (the
    /// desktop's toggles are); Designs, Artifacts and the PR tab exist only once the Chat has one.
    pub fn has(&self, tab: PanelTab) -> bool {
        match tab {
            PanelTab::Changes | PanelTab::Browser => true,
            PanelTab::Designs => self.designs,
            PanelTab::Artifact => self.artifacts,
            PanelTab::Pr => self.pr.is_some(),
        }
    }
}

/// FNV-1a: a stable spread of Chat keys over the variants.
fn spread(key: &str) -> u64 {
    key.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3))
}

/// The seeded Chat (the one open at startup) has everything; the others vary by key.
pub fn content_for(key: &str, seeded: Option<&str>) -> ChatContent {
    if Some(key) == seeded {
        return ChatContent { changes: fixture::data(Variant::Full), designs: true, artifacts: true, pr: Some(412) };
    }
    let bits = spread(key);
    let variant = match bits % 5 {
        0 | 1 => Variant::Full,
        2 => Variant::Small,
        3 => Variant::Clean,
        _ => Variant::NotRepo,
    };
    ChatContent {
        changes: fixture::data(variant),
        designs: bits & 0x100 != 0,
        artifacts: bits & 0x200 != 0,
        pr: (bits & 0x400 != 0).then_some(100 + (bits % 400) as u32),
    }
}
