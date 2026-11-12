//! The model catalog the picker shows until a host reports its own (`MODEL_CATALOG` in
//! `packages/shared/src/model-options.ts`, whose Antigravity families come from `antigravity-models.mjs` and whose
//! Kiro entries from `kiro-models.mjs`), the capabilities of each model (`capabilityFor`'s guesses) and its context
//! window (`contextWindowFor`). Fixture data: a connected host replaces the list ([`set_reported`], its
//! `agent:models` answer, as `mergeModels` does: a provider the host lists replaces the fixture's models of it,
//! recommended first; one it lists none for keeps the fixture's).

use std::collections::HashSet;
use std::sync::{Mutex, RwLock};

use crate::data::Provider;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelOption {
    pub provider: Provider,
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Kiro's rate multiplier ("2×").
    pub credits: Option<f64>,
    pub efforts: &'static [&'static str],
    /// The host's own report of the model (`agent:models`): what it accepts, and whether it is recommended.
    pub reported: Option<Reported>,
}

/// What a host reports of one model (`agent:models`: `recommended`, `fastMode`, `ultracode`; its `efforts` are the
/// option's own).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reported {
    pub recommended: bool,
    pub fast_mode: bool,
    pub ultracode: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Capability {
    pub efforts: Vec<&'static str>,
    pub fast_mode: bool,
    pub ultracode: bool,
}

const CODEX_EFFORTS: &[&str] = &["low", "medium", "high"];
const MODERN: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const LEGACY: &[&str] = &["low", "medium", "high", "max"];
const LEVELS: &[&str] = &["low", "medium", "high"];
const KIRO_MODERN: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const KIRO_GPT: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];

const fn m(provider: Provider, id: &'static str, name: &'static str, description: &'static str) -> ModelOption {
    ModelOption { provider, id, name, description, credits: None, efforts: &[], reported: None }
}

/// The models the picker offers: the fixture's, with each provider a host reported replaced by its report.
pub fn catalog() -> Vec<ModelOption> {
    let fixture = fixture_catalog();
    let reported = REPORTED.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(reported) = reported.as_ref() else { return fixture };
    crate::logic::identity::providers::PROVIDERS
        .iter()
        .flat_map(|provider| {
            let own: Vec<ModelOption> = reported.iter().filter(|m| m.provider.id() == *provider).copied().collect();
            if own.is_empty() { fixture.iter().filter(|m| m.provider.id() == *provider).copied().collect() } else { own }
        })
        .collect()
}

static REPORTED: RwLock<Option<Vec<ModelOption>>> = RwLock::new(None);
/// Every string a report named, kept for the process's life (a report repeats the same few dozen names).
static INTERNED: Mutex<Option<HashSet<&'static str>>> = Mutex::new(None);

fn intern(text: &str) -> &'static str {
    let mut interned = INTERNED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let set = interned.get_or_insert_with(HashSet::new);
    if let Some(found) = set.get(text) {
        return found;
    }
    let leaked: &'static str = Box::leak(text.to_owned().into_boxed_str());
    set.insert(leaked);
    leaked
}

/// One reported model, its strings interned.
pub fn reported_option(
    provider: Provider,
    id: &str,
    name: &str,
    description: &str,
    credits: Option<f64>,
    efforts: &[String],
    reported: Reported,
) -> ModelOption {
    let efforts: Vec<&'static str> = efforts.iter().map(|effort| intern(effort)).collect();
    let efforts: &'static [&'static str] = if efforts.is_empty() { &[] } else { Box::leak(efforts.into_boxed_slice()) };
    ModelOption {
        provider,
        id: intern(id),
        name: intern(if name.is_empty() { id } else { name }),
        description: intern(description),
        credits,
        efforts,
        reported: Some(reported),
    }
}

/// A host's model lists (recommended first within each provider); `None` goes back to the fixture's.
pub fn set_reported(models: Option<Vec<ModelOption>>) {
    let models = models.map(|mut models| {
        let order = |m: &ModelOption| crate::logic::identity::providers::PROVIDERS.iter().position(|p| *p == m.provider.id());
        models.sort_by_key(|m| (order(m), !m.reported.is_some_and(|r| r.recommended)));
        models
    });
    *REPORTED.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = models;
}

/// The model a Chat with none recorded runs on: its provider's first recommended model (a host's report), else its
/// provider's first model (`resolveModel`).
pub fn recommended(provider: Provider) -> Option<ModelOption> {
    let models = models_of(provider);
    models.iter().find(|m| m.reported.is_some_and(|r| r.recommended)).or_else(|| models.first()).copied()
}

fn fixture_catalog() -> Vec<ModelOption> {
    use Provider::{Antigravity, Claude, Codex, Kiro};
    let kiro = |id, name, description, credits, efforts| ModelOption {
        provider: Kiro,
        id,
        name,
        description,
        credits: Some(credits),
        efforts,
        reported: None,
    };
    let family = |id, name, description| ModelOption {
        provider: Antigravity,
        id,
        name,
        description,
        credits: None,
        efforts: LEVELS,
        reported: None,
    };
    vec![
        m(Codex, "gpt-6.1-sol", "GPT-6.1-Sol", "Latest generation workhorse model"),
        m(Codex, "gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work"),
        m(Codex, "gpt-6-sol", "GPT-6-Sol", "Previous generation workhorse model"),
        m(Codex, "gpt-6-luna", "GPT-6-Luna", "Fast and affordable model for easier tasks"),
        m(Codex, "gpt-5.6-sol", "GPT-5.6-Sol", "Older generation workhorse model"),
        m(Codex, "gpt-5.6-terra", "GPT-5.6-Terra", "Older balanced model for straightforward work"),
        m(Codex, "gpt-5.6-luna", "GPT-5.6-Luna", "Older fast and efficient model"),
        m(Codex, "gpt-5.5", "GPT-5.5", "Legacy coding model"),
        m(Claude, "claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks"),
        m(Claude, "claude-fable-5-1", "Fable 5.1", "For your toughest challenges"),
        m(Claude, "claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"),
        m(Claude, "claude-haiku-4-5", "Haiku 4.5", "Fastest for quick answers"),
        m(Claude, "claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks"),
        m(Claude, "claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
        m(Claude, "claude-fable-5", "Fable 5", "Most capable for your hardest and longest-running tasks"),
        m(Claude, "claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks"),
        m(Claude, "claude-opus-4-7", "Opus 4.7", "Best for everyday, complex tasks"),
        m(Claude, "claude-opus-4-6", "Opus 4.6", "Best for everyday, complex tasks"),
        m(Claude, "claude-sonnet-4-6", "Sonnet 4.6", "Efficient for routine tasks"),
        family("gemini-4-argon", "Gemini 4 Argon", "For complex work"),
        family("gemini-3.8-flash", "Gemini 3.8 Flash", "Fast"),
        kiro("kiro:auto", "Auto", "Models chosen by task for optimal usage and consistent quality", 1.0, &[]),
        kiro("kiro:claude-opus-5.5", "Claude Opus 5.5", "Claude Opus 5.5 model with 1M context window", 2.0, KIRO_MODERN),
        kiro("kiro:claude-sonnet-5.5", "Claude Sonnet 5.5", "Claude Sonnet 5.5 model with 1M context window", 1.3, KIRO_MODERN),
        kiro("kiro:claude-haiku-4.5", "Claude Haiku 4.5", "The latest Claude Haiku model", 0.4, &[]),
        kiro("kiro:gpt-5.6-sol", "GPT 5.6 Sol", "OpenAI GPT 5.6 Sol with 1M context window", 4.4, KIRO_GPT),
        kiro("kiro:gpt-5.6-luna", "GPT 5.6 Luna", "OpenAI GPT 5.6 Luna with 1M context window", 0.6, KIRO_GPT),
    ]
}

pub fn models_of(provider: Provider) -> Vec<ModelOption> {
    catalog().into_iter().filter(|model| model.provider == provider).collect()
}

pub fn find(provider: Provider, id: &str) -> Option<ModelOption> {
    catalog().into_iter().find(|model| model.provider == provider && model.id == id)
}

/// `capabilityFor` without a host report.
pub fn capability(model: &ModelOption) -> Capability {
    if let Some(reported) = model.reported {
        return Capability { efforts: model.efforts.to_vec(), fast_mode: reported.fast_mode, ultracode: reported.ultracode };
    }
    match model.provider {
        Provider::Codex => Capability { efforts: CODEX_EFFORTS.to_vec(), fast_mode: true, ultracode: false },
        Provider::Antigravity | Provider::Kiro => Capability { efforts: model.efforts.to_vec(), fast_mode: false, ultracode: false },
        Provider::Claude => {
            let fast_mode = matches!(model.id, "claude-opus-5-5" | "claude-opus-5" | "claude-opus-4-8");
            if model.id.contains("haiku") {
                return Capability { efforts: Vec::new(), fast_mode, ultracode: false };
            }
            let modern = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"].iter().any(|prefix| model.id.starts_with(prefix));
            Capability { efforts: if modern { MODERN } else { LEGACY }.to_vec(), fast_mode, ultracode: modern }
        }
    }
}

/// `contextWindowFor`, in tokens.
pub fn context_window(model: &ModelOption) -> Option<f64> {
    match model.provider {
        Provider::Claude => {
            let id = model.id;
            let old = id.starts_with("claude-3-")
                || id.starts_with("claude-haiku-4")
                || id.starts_with("claude-sonnet-4")
                || matches!(
                    id,
                    "claude-opus-4"
                        | "claude-opus-4-0"
                        | "claude-opus-4-1"
                        | "claude-opus-4-2"
                        | "claude-opus-4-3"
                        | "claude-opus-4-4"
                        | "claude-opus-4-5"
                        | "claude-opus-4-6"
                );
            Some(if old { 200_000.0 } else { 1_000_000.0 })
        }
        Provider::Codex => Some(272_000.0),
        Provider::Antigravity => Some(1_048_576.0),
        Provider::Kiro => None,
    }
}

/// `effortFor`: keeps the chosen effort when the model takes it, else its default (high), else the middle level.
pub fn effort_for(capability: &Capability, effort: Option<&str>) -> Option<&'static str> {
    let efforts = &capability.efforts;
    if efforts.is_empty() {
        return None;
    }
    if let Some(found) = effort.and_then(|effort| efforts.iter().find(|level| **level == effort)) {
        return Some(found);
    }
    efforts.iter().find(|level| **level == "high").copied().or_else(|| efforts.get(efforts.len() / 2).copied())
}

/// A Kiro multiplier as the picker prints it ("2×", "1.3×").
pub fn credits_label(credits: f64) -> String {
    if credits.fract() == 0.0 { format!("{credits:.0}\u{d7}") } else { format!("{credits}\u{d7}") }
}
