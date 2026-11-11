//! Fixture data for the sidebar: 500 deterministic Chats and the usage rows.

use gpui::{Rgba, SharedString};

use crate::theme::hex;

pub const CHAT_COUNT: usize = 500;

/// Trailing mark on a Chat row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatStatus {
    None,
    Running,
    NeedsApproval,
    Question,
    Failed,
    Unread,
}

/// One two-line row in the Chat list.
#[derive(Clone, Debug)]
pub struct ChatRow {
    /// Initial shown on the project tile.
    pub initial: char,
    /// Identity colour of the project tile; `None` draws the neutral `field` tile.
    pub tile: Option<Rgba>,
    pub title: SharedString,
    pub detail: SharedString,
    pub status: ChatStatus,
}

/// Stand-in logo drawn for a provider (see `icons::ProviderLogo`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogoKind {
    Claude,
    Codex,
    Antigravity,
}

/// One usage window of a provider: its label and the percent used.
#[derive(Clone, Copy, Debug)]
pub struct UsageWindow {
    pub label: &'static str,
    pub percent: u32,
}

/// One provider line in the usage block.
#[derive(Clone, Copy, Debug)]
pub struct UsageRow {
    pub name: &'static str,
    pub color: Rgba,
    pub logo: LogoKind,
    pub warning: bool,
    pub windows: &'static [UsageWindow],
}

pub const USAGE: [UsageRow; 3] = [
    UsageRow {
        name: "Claude",
        color: hex("#d97757"),
        logo: LogoKind::Claude,
        warning: true,
        windows: &[UsageWindow { label: "2% wk", percent: 2 }, UsageWindow { label: "3% wk", percent: 3 }],
    },
    UsageRow {
        name: "Codex",
        color: hex("#7c8cff"),
        logo: LogoKind::Codex,
        warning: false,
        windows: &[UsageWindow { label: "46% wk", percent: 46 }],
    },
    UsageRow {
        name: "Antigravity",
        color: hex("#4f9cf9"),
        logo: LogoKind::Antigravity,
        warning: false,
        windows: &[UsageWindow { label: "0% 5h", percent: 0 }, UsageWindow { label: "0% wk", percent: 0 }],
    },
];

fn row(initial: char, tile: Option<Rgba>, title: &str, detail: &str, status: ChatStatus) -> ChatRow {
    ChatRow { initial, tile, title: title.to_string().into(), detail: detail.to_string().into(), status }
}

/// The first eight rows are fixed; the rest are generated from small tables with a fixed LCG.
pub fn chat_fixtures() -> Vec<ChatRow> {
    use ChatStatus::{Failed, NeedsApproval, Question, Running, Unread};
    let mut rows = vec![
        row('M', None, "Migrate desktop to Rust PoC", "milagre-ade · Victor XPro", Running),
        row('M', None, "Fix Linux onboarding intro hang", "milagre-ade · #1020 · Victor XPro", NeedsApproval),
        row('A', Some(hex("#2b4fd6")), "Fix Windows port listener cleanup", "milagre · tianxu", Unread),
        row('M', None, "Codebase analysis and fixes", "milagre-ade · #1015 +3 · Victor XPro", Running),
        row('R', Some(hex("#5b46d6")), "RDCar ops", "rd-car · deer", Question),
        row('G', None, "Gestor RDCar", "Chats · deer", Unread),
        row('M', None, "Identify issues to close", "milagre-ade · Victor XPro", ChatStatus::None),
        row('M', None, "Rust terminal owner migration", "milagre-ade · Victor XPro", Failed),
    ];
    const PROJECTS: [(char, Option<&str>, &str); 5] = [
        ('M', None, "milagre-ade"),
        ('H', Some("#1f9d6b"), "happiergym"),
        ('A', Some("#2b4fd6"), "milagre"),
        ('R', Some("#5b46d6"), "rd-car"),
        ('S', None, "site"),
    ];
    const TOPICS: [&str; 12] = [
        "Relay Durable Object backoff",
        "Sidebar undo toast on iPad",
        "Workout export to HealthKit",
        "Landing page Lighthouse budget",
        "Live Activity for rest timer",
        "Forced-close receipts",
        "Settings search index",
        "Chat switch panel flash",
        "Storage cleanup worktrees",
        "Browser upload tool",
        "Routines visual pass",
        "Perf harness soak",
    ];
    const WHO: [&str; 4] = ["Victor XPro", "tianxu", "deer", "Santo"];
    let mut seed: u32 = 0x9e37_79b9;
    let mut next = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as usize
    };
    while rows.len() < CHAT_COUNT {
        let n = rows.len();
        let (initial, tile, project) = PROJECTS[next() % PROJECTS.len()];
        let topic = TOPICS[next() % TOPICS.len()];
        let who = WHO[next() % WHO.len()];
        let status = match next() % 12 {
            0 => Running,
            1 => NeedsApproval,
            2 => Question,
            3 => Failed,
            4 | 5 => Unread,
            _ => ChatStatus::None,
        };
        let detail = if next() % 3 == 0 { format!("{project} · #{} · {who}", 900 + next() % 200) } else { format!("{project} · {who}") };
        rows.push(row(initial, tile.map(hex_str), &format!("{topic} {n}"), &detail, status));
    }
    rows
}

fn hex_str(s: &str) -> Rgba {
    // Runtime twin of `hex` for the generated table (same format, validated by the match below).
    let v = u32::from_str_radix(s.trim_start_matches('#'), 16).expect("fixture colour is #rrggbb");
    Rgba { r: ((v >> 16) & 255) as f32 / 255.0, g: ((v >> 8) & 255) as f32 / 255.0, b: (v & 255) as f32 / 255.0, a: 1.0 }
}
