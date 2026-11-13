//! The Babysit PRs settings every surface shares (`packages/shared/src/babysit.mjs`): defaults, option lists, the
//! five levels, and normalising whatever the host sends. The daemon reads them; the desktop and the phone edit
//! them.

pub const INTERVAL_OPTIONS: [u32; 6] = [1, 2, 5, 10, 15, 30];
pub const DAYS_OPTIONS: [u32; 5] = [1, 3, 7, 14, 30];
pub const FAILURE_OPTIONS: [u32; 3] = [2, 3, 5];
pub const INSTRUCTIONS_MAX: usize = 4000;
pub const OWN_RULE_MAX: usize = 300;

/// What can wake the agent, in the order the settings list them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wake {
    Comments,
    Checks,
    Conflicts,
    Behind,
}

impl Wake {
    pub const ALL: [Wake; 4] = [Wake::Comments, Wake::Checks, Wake::Conflicts, Wake::Behind];

    pub fn id(self) -> &'static str {
        match self {
            Wake::Comments => "comments",
            Wake::Checks => "checks",
            Wake::Conflicts => "conflicts",
            Wake::Behind => "behind",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Wake::Comments => "Review comments",
            Wake::Checks => "Failed checks",
            Wake::Conflicts => "Merge conflicts",
            Wake::Behind => "Branch behind base",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Report,
    Fix,
    Push,
    Reply,
    Rerequest,
}

impl Step {
    pub fn name(self) -> &'static str {
        match self {
            Step::Report => "Report",
            Step::Fix => "Fix",
            Step::Push => "Push",
            Step::Reply => "Reply",
            Step::Rerequest => "Re-request review",
        }
    }
}

pub struct Level {
    pub level: u8,
    pub title: &'static str,
    pub description: &'static str,
    pub steps: &'static [Step],
}

/// The five levels, each including everything above it.
pub const LEVELS: [Level; 5] = [
    Level { level: 1, title: "Report only", description: "Posts what's wrong in the Chat and changes nothing.", steps: &[Step::Report] },
    Level {
        level: 2,
        title: "Fix, don't push",
        description: "Fixes it in the Worktree and stops for you to look before anything reaches GitHub.",
        steps: &[Step::Fix],
    },
    Level { level: 3, title: "Fix and push", description: "Commits the fix and pushes the branch.", steps: &[Step::Fix, Step::Push] },
    Level {
        level: 4,
        title: "Fix, push and reply",
        description: "Also replies on each review thread it addressed, with the commit that fixed it.",
        steps: &[Step::Fix, Step::Push, Step::Reply],
    },
    Level {
        level: 5,
        title: "Fix, push, reply and re-request review",
        description: "Then asks the reviewers who left changes to look again.",
        steps: &[Step::Fix, Step::Push, Step::Reply, Step::Rerequest],
    },
];

pub const DEFAULT_LEVEL: u8 = 3;

/// A rule with a switch and a number: the number survives the switch being off, so turning it on restores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule {
    pub on: bool,
    pub value: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Babysit {
    pub enabled: bool,
    pub interval_minutes: u32,
    pub wake: Vec<Wake>,
    pub level: u8,
    pub resolve_threads: bool,
    pub stop_when_green: bool,
    pub stop_after_days: Rule,
    pub stop_after_failures: Rule,
    pub own_rule: bool,
    pub own_rule_text: String,
    pub instructions: String,
}

impl Default for Babysit {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 1,
            wake: vec![Wake::Comments, Wake::Checks, Wake::Conflicts],
            level: DEFAULT_LEVEL,
            resolve_threads: true,
            stop_when_green: true,
            stop_after_days: Rule { on: true, value: 7 },
            stop_after_failures: Rule { on: false, value: 3 },
            own_rule: false,
            own_rule_text: String::new(),
            instructions: String::new(),
        }
    }
}

impl Babysit {
    /// Any received value as complete, valid settings: each bad value reset to its default
    /// (`normalizeBabysitSettings`).
    pub fn normalized(mut self) -> Self {
        let defaults = Babysit::default();
        if !INTERVAL_OPTIONS.contains(&self.interval_minutes) {
            self.interval_minutes = defaults.interval_minutes;
        }
        self.wake = Wake::ALL.into_iter().filter(|kind| self.wake.contains(kind)).collect();
        if !(1..=5).contains(&self.level) {
            self.level = defaults.level;
        }
        if !DAYS_OPTIONS.contains(&self.stop_after_days.value) {
            self.stop_after_days.value = defaults.stop_after_days.value;
        }
        if !FAILURE_OPTIONS.contains(&self.stop_after_failures.value) {
            self.stop_after_failures.value = defaults.stop_after_failures.value;
        }
        self.own_rule_text = self.own_rule_text.chars().take(OWN_RULE_MAX).collect();
        self.instructions = self.instructions.chars().take(INSTRUCTIONS_MAX).collect();
        self
    }
}

impl Babysit {
    /// The settings as `babysit.mjs` names them (`BABYSIT_DEFAULTS`).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": self.enabled,
            "intervalMinutes": self.interval_minutes,
            "wake": self.wake.iter().map(|w| w.id()).collect::<Vec<_>>(),
            "level": self.level,
            "resolveThreads": self.resolve_threads,
            "stopWhenGreen": self.stop_when_green,
            "stopAfterDays": {"on": self.stop_after_days.on, "days": self.stop_after_days.value},
            "stopAfterFailures": {"on": self.stop_after_failures.on, "times": self.stop_after_failures.value},
            "ownRule": self.own_rule,
            "ownRuleText": self.own_rule_text,
            "instructions": self.instructions,
        })
    }

    /// What the host sent, as complete valid settings (`normalizeBabysitSettings`).
    pub fn from_json(value: &serde_json::Value) -> Self {
        let defaults = Babysit::default();
        let flag = |key: &str, held: bool| value[key].as_bool().unwrap_or(held);
        let number = |v: &serde_json::Value, held: u32| v.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(held);
        let rule = |key: &str, field: &str, held: Rule| Rule {
            on: value[key]["on"].as_bool().unwrap_or(held.on),
            value: number(&value[key][field], held.value),
        };
        let wake = match value["wake"].as_array() {
            Some(list) => Wake::ALL.into_iter().filter(|kind| list.iter().any(|item| item == kind.id())).collect(),
            None => defaults.wake.clone(),
        };
        Babysit {
            enabled: flag("enabled", defaults.enabled),
            interval_minutes: number(&value["intervalMinutes"], defaults.interval_minutes),
            wake,
            level: value["level"].as_u64().and_then(|n| u8::try_from(n).ok()).unwrap_or(defaults.level),
            resolve_threads: flag("resolveThreads", defaults.resolve_threads),
            stop_when_green: flag("stopWhenGreen", defaults.stop_when_green),
            stop_after_days: rule("stopAfterDays", "days", defaults.stop_after_days),
            stop_after_failures: rule("stopAfterFailures", "times", defaults.stop_after_failures),
            own_rule: flag("ownRule", defaults.own_rule),
            own_rule_text: value["ownRuleText"].as_str().unwrap_or_default().to_string(),
            instructions: value["instructions"].as_str().unwrap_or_default().to_string(),
        }
        .normalized()
    }

    /// The keys of `self` that differ from `before`: what `babysit:settings:save` is sent.
    pub fn patch_from(&self, before: &Babysit) -> serde_json::Map<String, serde_json::Value> {
        let (after, before) = (self.to_json(), before.to_json());
        after
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, value)| before[key.as_str()] != **value)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

/// One change the page makes: a patch of the settings. Values that build on the current ones (chips, number
/// rules) are worked out from the latest settings, changes still on their way included.
pub type Change = Box<dyn FnOnce(&mut Babysit)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveState {
    Idle,
    Saving,
    Saved,
    Error,
}

pub fn plural(count: u32, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}
