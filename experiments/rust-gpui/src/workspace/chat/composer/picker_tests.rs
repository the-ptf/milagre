//! WP-26 tests: the catalog, capabilities, the slider's geometry and the pickers' state.

use gpui::{AppContext as _, TestAppContext};

use super::Composer;
use super::models::{capability, catalog, context_window, credits_label, effort_for, find, models_of};
use crate::data::Provider;
use crate::ui::{centre_at, step_at};

#[test]
fn catalog_matches_the_apps_ids_per_provider() {
    assert_eq!(models_of(Provider::Codex).len(), 8);
    assert_eq!(models_of(Provider::Claude).len(), 11);
    let antigravity: Vec<_> = models_of(Provider::Antigravity).iter().map(|m| m.id).collect();
    assert_eq!(antigravity, ["gemini-4-argon", "gemini-3.8-flash"]);
    assert_eq!(models_of(Provider::Kiro).len(), 6);
    assert_eq!(catalog().len(), 8 + 11 + 2 + 6);
}

#[test]
fn capabilities_follow_capability_for() {
    let opus = capability(&find(Provider::Claude, "claude-opus-5-5").unwrap());
    assert_eq!(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert!(opus.fast_mode && opus.ultracode);
    let old = capability(&find(Provider::Claude, "claude-opus-4-7").unwrap());
    assert_eq!(old.efforts, ["low", "medium", "high", "max"]);
    assert!(!old.fast_mode && !old.ultracode);
    let haiku = capability(&find(Provider::Claude, "claude-haiku-4-5").unwrap());
    assert!(haiku.efforts.is_empty());
    assert!(capability(&find(Provider::Codex, "gpt-6-sol").unwrap()).fast_mode);
    assert_eq!(context_window(&find(Provider::Claude, "claude-haiku-4-5").unwrap()), Some(200_000.0));
    assert_eq!(context_window(&find(Provider::Claude, "claude-opus-5-5").unwrap()), Some(1_000_000.0));
    assert_eq!(credits_label(2.0), "2\u{d7}");
    assert_eq!(credits_label(1.3), "1.3\u{d7}");
}

#[test]
fn effort_survives_when_taken_else_defaults_to_high() {
    let claude = capability(&find(Provider::Claude, "claude-opus-5-5").unwrap());
    assert_eq!(effort_for(&claude, Some("xhigh")), Some("xhigh"));
    let codex = capability(&find(Provider::Codex, "gpt-6-sol").unwrap());
    assert_eq!(effort_for(&codex, Some("max")), Some("high"));
    let haiku = capability(&find(Provider::Claude, "claude-haiku-4-5").unwrap());
    assert_eq!(effort_for(&haiku, Some("high")), None);
}

#[test]
fn slider_geometry_lands_on_the_ticks() {
    for steps in [2, 3, 5, 6] {
        for value in 0..steps {
            assert_eq!(step_at(centre_at(value, 220.0, steps), 220.0, steps), value);
        }
    }
    assert_eq!(step_at(-50.0, 220.0, 5), 0);
    assert_eq!(step_at(900.0, 220.0, 5), 4);
}

#[gpui::test]
fn picking_a_model_updates_the_chip_and_drops_unsupported_modes(cx: &mut TestAppContext) {
    let composer = cx.new(Composer::new);
    composer.update(cx, |c, cx| {
        c.set_fast_mode(true, cx);
        c.set_ultracode(true, cx);
        c.set_effort("max", cx);
        c.pick_model(&find(Provider::Codex, "gpt-6-sol").unwrap(), cx);
    });
    composer.read_with(cx, |c, _| {
        assert_eq!(c.bar.provider, Provider::Codex);
        assert_eq!(c.bar.model_name.as_ref(), "GPT-6-Sol");
        assert_eq!(c.bar.effort.as_deref(), Some("High"));
        assert!(c.bar.fast && !c.bar.ultracode, "Codex has Fast but not Ultracode");
    });
    composer.update(cx, |c, cx| c.pick_model(&find(Provider::Claude, "claude-haiku-4-5").unwrap(), cx));
    composer.read_with(cx, |c, _| assert!(c.bar.effort.is_none() && !c.bar.fast));
}

#[gpui::test]
fn the_new_chat_tray_starts_and_ends(cx: &mut TestAppContext) {
    let composer = cx.new(Composer::new);
    composer.update(cx, |c, cx| c.start_new_chat(cx));
    composer.read_with(cx, |c, _| assert_eq!(c.new_chat().map(|n| n.project.as_ref()), Some("milagre-ade")));
    composer.update(cx, |c, cx| c.end_new_chat(cx));
    composer.read_with(cx, |c, _| assert!(c.new_chat().is_none()));
}
