//! The mark at the left of a Chat row: which one a Chat shows (`chatMark` in `apps/desktop/app/src/lib/chat-list.ts`)
//! and how both apps draw it (`chatMarkTone` and `chatMarkPresentation` in `packages/shared/src/chats.mjs`).

use super::tone::Tone;

/// What the mark at the left of a Chat row shows. `chat_mark` never returns `Failed`: the phone's list sets it from
/// the Chat's last outcome, and `chatMarkPresentation` knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChatMark {
    Question,
    Waiting,
    Delegated,
    Interrupted,
    Running,
    Background,
    Failed,
    Unread,
    Idle,
}

impl ChatMark {
    /// The name the TypeScript uses.
    pub fn key(self) -> &'static str {
        match self {
            ChatMark::Question => "question",
            ChatMark::Waiting => "waiting",
            ChatMark::Delegated => "delegated",
            ChatMark::Interrupted => "interrupted",
            ChatMark::Running => "running",
            ChatMark::Background => "background",
            ChatMark::Failed => "failed",
            ChatMark::Unread => "unread",
            ChatMark::Idle => "idle",
        }
    }
}

/// What `chatMark` reads about a Chat.
///
/// `delegated`: a Delegation from another Chat is queued or running here. `interrupted`: its turn stopped when the
/// app quit and can resume (`resumeTurn`), as the phone marks it. `background`: the Chat's activity is background
/// (`chat-activity.mjs`): its turn ended, but background agents still work and will wake it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarkInput {
    pub asking: bool,
    pub waiting: bool,
    pub delegated: bool,
    pub running: bool,
    pub interrupted: bool,
    pub background: bool,
    pub unread: bool,
}

/// What the mark at the left of a Chat row shows; the first that applies wins: asking, waiting, delegated,
/// running, interrupted, background, unread, idle.
pub fn chat_mark(input: MarkInput) -> ChatMark {
    if input.asking {
        ChatMark::Question
    } else if input.waiting {
        ChatMark::Waiting
    } else if input.delegated {
        ChatMark::Delegated
    } else if input.running {
        ChatMark::Running
    } else if input.interrupted {
        ChatMark::Interrupted
    } else if input.background {
        ChatMark::Background
    } else if input.unread {
        ChatMark::Unread
    } else {
        ChatMark::Idle
    }
}

/// The same status palette for desktop and mobile Chat lists.
pub fn chat_mark_tone(mark: ChatMark) -> Tone {
    match mark {
        ChatMark::Waiting | ChatMark::Interrupted => Tone::Orange,
        ChatMark::Failed => Tone::Red,
        ChatMark::Idle => Tone::Ink3,
        _ => Tone::Accent,
    }
}

/// The glyph of a mark (`icon` in `CHAT_MARKS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkIcon {
    Bubble,
    ShieldAlert,
    Link,
    Alert,
    Spinner,
    Ring,
    Dot,
}

impl MarkIcon {
    /// The name the TypeScript uses.
    pub fn key(self) -> &'static str {
        match self {
            MarkIcon::Bubble => "bubble",
            MarkIcon::ShieldAlert => "shield-alert",
            MarkIcon::Link => "link",
            MarkIcon::Alert => "alert",
            MarkIcon::Spinner => "spinner",
            MarkIcon::Ring => "ring",
            MarkIcon::Dot => "dot",
        }
    }
}

/// A Chat mark as both apps draw it: its glyph, its fill tone (a palette key) and its words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkPresentation {
    pub icon: MarkIcon,
    pub label: &'static str,
    pub tone: Tone,
}

/// Idle is a solid `ink4` dot with no words (`chatMarkTone` says `ink3`, but the presentation overrides it).
pub fn chat_mark_presentation(mark: ChatMark) -> MarkPresentation {
    let (icon, label) = match mark {
        ChatMark::Question => (MarkIcon::Bubble, "Needs reply"),
        ChatMark::Waiting => (MarkIcon::ShieldAlert, "Needs approval"),
        ChatMark::Delegated => (MarkIcon::Link, "On a Delegation"),
        ChatMark::Interrupted => (MarkIcon::Alert, "Interrupted"),
        ChatMark::Running => (MarkIcon::Spinner, "Running"),
        ChatMark::Background => (MarkIcon::Ring, "In the background"),
        ChatMark::Failed => (MarkIcon::Dot, "Failed"),
        ChatMark::Unread => (MarkIcon::Dot, "Unread"),
        ChatMark::Idle => (MarkIcon::Dot, ""),
    };
    MarkPresentation { icon, label, tone: if mark == ChatMark::Idle { Tone::Ink4 } else { chat_mark_tone(mark) } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_question_beats_waiting_beats_running_beats_unread() {
        let input = MarkInput::default();
        assert_eq!(chat_mark(MarkInput { asking: true, waiting: true, running: true, unread: true, ..input }), ChatMark::Question);
        assert_eq!(chat_mark(MarkInput { waiting: true, running: true, unread: true, ..input }), ChatMark::Waiting);
        assert_eq!(chat_mark(MarkInput { running: true, unread: true, ..input }), ChatMark::Running);
        assert_eq!(chat_mark(MarkInput { interrupted: true, background: true, unread: true, ..input }), ChatMark::Interrupted);
        assert_eq!(chat_mark(MarkInput { background: true, unread: true, ..input }), ChatMark::Background);
        assert_eq!(chat_mark(MarkInput { unread: true, ..input }), ChatMark::Unread);
        assert_eq!(chat_mark(input), ChatMark::Idle);
    }

    #[test]
    fn a_delegation_working_in_the_chat_shows_over_running_under_anything_that_waits_on_the_user() {
        let input = MarkInput::default();
        assert_eq!(chat_mark(MarkInput { delegated: true, running: true, unread: true, ..input }), ChatMark::Delegated);
        assert_eq!(chat_mark(MarkInput { waiting: true, delegated: true, running: true, ..input }), ChatMark::Waiting);
    }

    #[test]
    fn tones_split_what_needs_you_from_what_failed_from_the_rest() {
        let tones: Vec<(&str, &str)> = [
            ChatMark::Question,
            ChatMark::Waiting,
            ChatMark::Delegated,
            ChatMark::Interrupted,
            ChatMark::Running,
            ChatMark::Background,
            ChatMark::Failed,
            ChatMark::Unread,
            ChatMark::Idle,
        ]
        .into_iter()
        .map(|mark| (mark.key(), chat_mark_tone(mark).key()))
        .collect();
        assert_eq!(
            tones,
            [
                ("question", "accent"),
                ("waiting", "orange"),
                ("delegated", "accent"),
                ("interrupted", "orange"),
                ("running", "accent"),
                ("background", "accent"),
                ("failed", "red"),
                ("unread", "accent"),
                ("idle", "ink3"),
            ]
        );
    }

    #[test]
    fn each_mark_has_its_glyph_words_and_tone_and_idle_is_a_solid_ink4_dot() {
        let present = |mark| {
            let presentation = chat_mark_presentation(mark);
            (presentation.icon.key(), presentation.label, presentation.tone.key())
        };
        assert_eq!(present(ChatMark::Question), ("bubble", "Needs reply", "accent"));
        assert_eq!(present(ChatMark::Waiting), ("shield-alert", "Needs approval", "orange"));
        assert_eq!(present(ChatMark::Delegated), ("link", "On a Delegation", "accent"));
        assert_eq!(present(ChatMark::Interrupted), ("alert", "Interrupted", "orange"));
        assert_eq!(present(ChatMark::Running), ("spinner", "Running", "accent"));
        assert_eq!(present(ChatMark::Background), ("ring", "In the background", "accent"));
        assert_eq!(present(ChatMark::Failed), ("dot", "Failed", "red"));
        assert_eq!(present(ChatMark::Unread), ("dot", "Unread", "accent"));
        assert_eq!(present(ChatMark::Idle), ("dot", "", "ink4"));
    }
}
