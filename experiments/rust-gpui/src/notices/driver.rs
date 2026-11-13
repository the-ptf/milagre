//! Drives the update card from Settings › About with [`UpdateMachine`], on the fixture feed (`platform::updates`).
//!
//! `Check for updates` is `window.milagre.checkForUpdates()` and `Install & restart` / a downloaded update's button is
//! `showUpdateNotice()` (`Settings.tsx`): the machine moves through the events the main process raises (check, found,
//! download progress, downloaded) and every state is handed to [`UpdateNotice::set_state`], which opens the card once
//! the update is ready, as `Presentation::observe` does. A real feed drives the same machine.

use std::time::Duration;

use gpui::{App, Entity, Global, WeakEntity, Window};

use super::UpdateNotice;
use super::model::{AppUpdate, UpdateStatus};
use crate::platform::updates::UpdateMachine;

/// The fixture version the feed finds.
pub const FIXTURE_VERSION: &str = "0.2.0";
/// The pause between the feed's events, so each state is seen.
const STEP: Duration = Duration::from_millis(450);

/// The app's updater: the machine and the notice it feeds.
pub struct UpdateDriver {
    notice: WeakEntity<UpdateNotice>,
    machine: UpdateMachine,
}

impl Global for UpdateDriver {}

/// Registers `notice` as the card the About section drives.
pub fn install(notice: &Entity<UpdateNotice>, cx: &mut App) {
    cx.set_global(UpdateDriver { notice: notice.downgrade(), machine: UpdateMachine::default() });
}

/// The updater's state, if a driver is installed and has run.
pub fn state(cx: &App) -> Option<AppUpdate> {
    cx.try_global::<UpdateDriver>().map(|driver| driver.machine.state().clone()).filter(|state| state.status != UpdateStatus::Idle)
}

/// The About button: a downloaded update shows its card, anything else starts a check. Does nothing while a check or
/// download runs (the button is disabled then).
pub fn press(window: &mut Window, cx: &mut App) {
    let Some(status) = state(cx).map(|state| state.status) else {
        return check(window, cx);
    };
    match status {
        UpdateStatus::Downloaded => {
            let notice = cx.global::<UpdateDriver>().notice.clone();
            notice.update(cx, |notice, cx| notice.show(window, cx)).ok();
        }
        UpdateStatus::Checking | UpdateStatus::Downloading | UpdateStatus::Installing | UpdateStatus::Unavailable => {}
        _ => check(window, cx),
    }
}

/// `update:check`, then the fixture feed: found, three progress marks, downloaded.
pub fn check(window: &mut Window, cx: &mut App) {
    if !cx.has_global::<UpdateDriver>() {
        return;
    }
    cx.global_mut::<UpdateDriver>().machine.check();
    publish(cx);
    window
        .spawn(cx, async move |cx| {
            let events: [fn(&mut UpdateMachine); 5] =
                [|m| m.found(FIXTURE_VERSION), |m| m.progress(25.0), |m| m.progress(60.0), |m| m.progress(90.0), UpdateMachine::downloaded];
            for event in events {
                cx.background_executor().timer(STEP).await;
                let moved = cx.update(|_, cx| {
                    if !cx.has_global::<UpdateDriver>() {
                        return false;
                    }
                    event(&mut cx.global_mut::<UpdateDriver>().machine);
                    publish(cx);
                    true
                });
                if !moved.unwrap_or(false) {
                    break;
                }
            }
        })
        .detach();
}

/// Hands the machine's state to the notice and wakes the views that read it (the About row).
fn publish(cx: &mut App) {
    let driver = cx.global::<UpdateDriver>();
    let (notice, state) = (driver.notice.clone(), driver.machine.state().clone());
    notice.update(cx, |notice, cx| notice.set_state(Some(state), cx)).ok();
    cx.refresh_windows();
}
