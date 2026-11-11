//! What the Details tab shows that the data source does not carry yet: the title of a Chat's Linear issue and the
//! Projects its Worktree is linked to. The seeded Chat has all of it; the others vary by key, so switching Chats
//! visibly changes the sections.

use super::data::DetailsData;

fn spread(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

const TITLES: [&str; 4] = [
    "Onboarding intro hangs on Linux",
    "Sidebar rows jump when a Chat finishes",
    "Share links lose their preview",
    "Phone loses the relay after sleep",
];

/// A Linear issue's title (`linear:issue`); the fixture knows a handful.
pub fn issue_title(key: &str) -> String {
    TITLES[spread(key) as usize % TITLES.len()].to_owned()
}

/// Fills the sections the data source has no field for.
pub fn add_extras(details: &mut DetailsData, key: &str, seeded: bool) {
    let bits = spread(key);
    if details.linear.is_none() && (seeded || bits & 0x10 != 0) {
        let issue = if seeded { "MIL-412".to_owned() } else { format!("MIL-{}", 100 + bits % 800) };
        details.linear = Some((issue.clone(), issue_title(&issue)));
    }
    if seeded {
        details.links = vec!["milagre-site".into(), "milagre-relay".into()];
    } else if bits & 0x20 != 0 {
        details.links = vec!["milagre-relay".into()];
    }
}
