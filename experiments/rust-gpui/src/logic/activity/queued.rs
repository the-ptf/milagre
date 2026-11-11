//! After `packages/shared/src/queued-messages.mjs`: the line above a Chat's queued messages, and the follow-up
//! setting.

/// `queueStatus`: when queued messages go, the same on desktop and phone. `held` is set once Stop or a failure
/// ended the turn they waited on; `running` is whether a turn runs now.
pub fn queue_status(count: usize, held: bool, running: bool) -> &'static str {
    if held {
        "on hold since the last turn stopped"
    } else if running {
        if count == 1 { "sends when this turn ends" } else { "each sends in its own turn, in order, after this one" }
    } else {
        "starting next"
    }
}

/// One entry of `FOLLOW_UP_OPTIONS` (Settings › Chat): what a message sent while a turn runs does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FollowUpOption {
    pub value: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

pub const FOLLOW_UP_OPTIONS: [FollowUpOption; 2] = [
    FollowUpOption {
        value: "now",
        label: "Send now",
        description: "Steers the running turn. Agents that can't steer get it when the turn ends.",
    },
    FollowUpOption {
        value: "queue",
        label: "Queue",
        description: "Waits for the turn to end. Send now on a queued message sends it right away.",
    },
];

/// `followUpDelivery`: the delivery a composer send asks for while a turn runs: only Queue overrides the host's
/// steer default.
pub fn follow_up_delivery(follow_ups: Option<&str>) -> Option<&'static str> {
    (follow_ups == Some("queue")).then_some("queue")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_queue_line_says_when_queued_messages_go() {
        assert_eq!(queue_status(1, false, true), "sends when this turn ends");
        assert_eq!(queue_status(2, false, true), "each sends in its own turn, in order, after this one");
        assert_eq!(queue_status(2, true, false), "on hold since the last turn stopped");
        assert_eq!(queue_status(1, false, false), "starting next");
    }

    #[test]
    fn only_queue_overrides_the_hosts_default() {
        assert_eq!(follow_up_delivery(Some("queue")), Some("queue"));
        assert_eq!(follow_up_delivery(Some("now")), None);
        assert_eq!(follow_up_delivery(None), None);
    }

    #[test]
    fn the_options_match_the_typescript_source() {
        let Some(ts) = crate::logic::copy::source::shared("queued-messages.mjs") else { return };
        for option in FOLLOW_UP_OPTIONS {
            for text in [option.value, option.label, option.description] {
                assert!(ts.contains(&format!("\"{text}\"")), "{text}");
            }
        }
        for text in [
            "on hold since the last turn stopped",
            "sends when this turn ends",
            "each sends in its own turn, in order, after this one",
            "starting next",
        ] {
            assert!(ts.contains(&format!("\"{text}\"")), "{text}");
        }
    }
}
