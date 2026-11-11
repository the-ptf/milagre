//! Onboarding (WP-51): the agent and Project steps, the folder without Git, the first Chat's starters and the sky
//! behind them. After `apps/desktop/app/src/components/Onboarding.tsx`.
//!
//! | File | Holds |
//! | --- | --- |
//! | `model.rs` | `agentRows`, the self-installed agents, `homePath`, `lastUsedLabel`, `firstChatStarters` and their types |
//! | `fixture.rs` | this computer's agents and recent folders; `Scenario` (`MILAGRE_GPUI_ONBOARDING=<name>`) |
//! | `view.rs` | `Onboarding`: the two steps, the clone and create form, the no-Git folder |
//! | `starters.rs` | `FirstChatStarters`: "What should we make first?" |
//! | `sky.rs` | the wash behind the steps |
//!
//! [`OnboardingLayer`] sits over the whole window and draws nothing until onboarding starts: from the first launch with
//! no Project (not wired to the data source yet: [`start_from_env`] starts it for snapshots and tests). It covers the
//! window, so every click lands on the steps. Fixture data only: nothing installs, signs in or clones.
//!
//! Not built: the Dawn intro (O-03: clouds, falling star, Begin) and the Welcome sky (O-04), which need SVG-filter
//! art pre-rendered into `assets/onboarding/`; the sky's radial glow; the drag strip of the title bar.

pub mod fixture;
pub mod model;
pub mod sky;
pub mod starters;
mod view;

#[cfg(test)]
mod tests;

use gpui::{Context, Entity, IntoElement, Render, Subscription, Window, div, prelude::*};

pub use fixture::Scenario;
pub use starters::FirstChatStarters;
pub use view::{FormKind, Onboarding, OnboardingEvent};

/// The scenario `MILAGRE_GPUI_ONBOARDING` names, if any.
pub fn start_from_env() -> Option<Scenario> {
    std::env::var("MILAGRE_GPUI_ONBOARDING").ok().and_then(|name| Scenario::from_name(&name))
}

#[derive(Default)]
pub struct OnboardingLayer {
    view: Option<Entity<Onboarding>>,
    _subscription: Option<Subscription>,
}

impl OnboardingLayer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut layer = Self::default();
        if let Some(scenario) = start_from_env() {
            layer.start(Some(scenario), window, cx);
        }
        layer
    }

    /// Opens onboarding, from a scenario's state or from the beginning.
    pub fn start(&mut self, scenario: Option<Scenario>, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.new(|cx| Onboarding::new(window, cx));
        if let Some(scenario) = scenario {
            view.update(cx, |view, cx| view.apply(scenario, window, cx));
        }
        // A Project opened or skipped ends onboarding; the window under it is the app.
        self._subscription = Some(cx.subscribe(&view, |this, _, _: &OnboardingEvent, cx| {
            this.view = None;
            cx.notify();
        }));
        self.view = Some(view);
        cx.notify();
    }

    pub fn view(&self) -> Option<&Entity<Onboarding>> {
        self.view.as_ref()
    }

    pub fn is_active(&self) -> bool {
        self.view.is_some()
    }
}

impl Render for OnboardingLayer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        match &self.view {
            Some(view) => div().absolute().inset_0().occlude().child(view.clone()).into_any_element(),
            None => div().into_any_element(),
        }
    }
}
