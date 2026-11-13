//! What motion costs: a turning spinner's frames, counted in renders (CONVENTIONS.md "Adding a view that does not
//! repaint its siblings"). Motion is off in tests; these turn it on for their thread.

use gpui::{TestAppContext, VisualTestContext};

use crate::testing;
use crate::ui::{SpinnerView, set_test_motion};
use crate::workspace::sidebar::RowState;

/// Stretches opening and closing motion 20 times, so a slide outlasts the frames a test draws (frames are not tied to
/// the clock, and a debug build under load is slow). Call it after mounting, which applies the stored speed.
fn slow_motion() {
    crate::theme::live::set_live(crate::theme::live::LiveStyle { motion_scale: 20.0, ..Default::default() });
}

/// Delivers one animation frame: runs what asked for the next frame (each animation notifies its view), then draws.
fn frame(cx: &mut VisualTestContext) -> usize {
    let asked = cx.update(|window, cx| window.simulate_next_frame(cx));
    cx.run_until_parked();
    asked
}

/// Each frame of the sidebar's running rings renders the ring views and the rows holding them (their cached parents),
/// never another row, the transcript's items or the panel.
#[gpui::test]
fn a_turning_spinner_rebuilds_only_its_row(cx: &mut TestAppContext) {
    set_test_motion(true);
    let (workspace, cx) = testing::mount_workspace(cx);
    let (sidebar, chat, panel) = workspace.read_with(cx, |w, _| (w.sidebar.clone(), w.chat.clone(), w.panel.clone()));
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    // The rings turn: every frame asks for the next one.
    frame(cx);
    assert!(frame(cx) > 0, "the spinners ask for frames");

    let spinning = sidebar.read_with(cx, |s, _| {
        (0..s.pinned_count()).chain(s.visible_range()).filter(|ix| s.row(*ix).is_some_and(|row| row.state() == RowState::Working)).count()
    });
    let alive = sidebar.read_with(cx, |s, _| s.row_views_alive());
    assert!(spinning >= 2 && spinning < alive, "the fixture spins {spinning} of {alive} rows");
    let counts = |cx: &mut VisualTestContext| {
        (
            transcript.read_with(cx, |t, _| t.item_renders()),
            sidebar.read_with(cx, |s, _| s.rows_built()),
            panel.read_with(cx, |p, _| p.renders()),
            SpinnerView::renders(),
        )
    };
    let before = counts(cx);
    const FRAMES: usize = 10;
    for _ in 0..FRAMES {
        frame(cx);
    }
    let (items, rows, panel_renders, spinners) = counts(cx);
    assert_eq!(items, before.0, "no transcript item rebuilt in {FRAMES} frames");
    assert_eq!(panel_renders, before.2, "the panel did not render");
    assert_eq!(rows - before.1, spinning * FRAMES, "only the {spinning} spinning rows rendered, once a frame each");
    assert!(spinners - before.3 >= spinning * FRAMES, "every ring turned every frame");
    set_test_motion(false);
}

/// The side panel opens and closes at once, even with Motion on: no cover, no frames held.
#[gpui::test]
fn the_panel_opens_and_closes_at_once(cx: &mut TestAppContext) {
    set_test_motion(true);
    let (workspace, cx) = testing::mount_workspace(cx);
    slow_motion();
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    assert!(panel.read_with(cx, |p, _| p.is_open()), "the fixture opens with the panel");
    frame(cx);
    for opening in [false, true] {
        panel.update(cx, |p, cx| if opening { p.activate(crate::workspace::panel::PanelTab::Changes, cx) } else { p.close(cx) });
        cx.run_until_parked();
        assert_eq!(panel.read_with(cx, |p, _| p.is_open()), opening);
        assert!(cx.debug_bounds("slide-cover").is_none(), "no cover runs a slide");
        assert_eq!(cx.debug_bounds("panel-header").is_some(), opening, "the panel is on screen exactly while it is open");
    }
    set_test_motion(false);
}

/// The update card closing to its pill, and opening again: the surface's size runs between the two faces' measured
/// sizes, frame by frame, in the notice's own view; the transcript and the panel are not rebuilt.
#[gpui::test]
fn the_update_card_morphs_to_its_pill_and_back(cx: &mut TestAppContext) {
    use crate::notices::model::{AppUpdate, UpdateStatus};

    set_test_motion(true);
    let (workspace, cx) = testing::mount_workspace(cx);
    // After mounting: the Workspace applies the stored Appearance, Normal speed.
    slow_motion();
    let (chat, panel, notices) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.panel.clone(), w.notices.clone()));
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    let update = notices.read_with(cx, |n, _| n.update.clone());
    update.update(cx, |u, cx| u.set_state(Some(AppUpdate::new(UpdateStatus::Downloaded).with_version("0.233.0")), cx));
    cx.run_until_parked();
    assert!(update.read_with(cx, |u, _| u.is_open()), "a downloaded update opens its card, at once");
    let card = cx.debug_bounds("update-notice").expect("the card is drawn").size;
    assert!(update.read_with(cx, |u, _| u.morph_frames()).is_none());

    update.update(cx, |u, cx| u.close(cx));
    cx.run_until_parked();
    frame(cx);
    let pill = cx.debug_bounds("update-notice").expect("the pill face is drawn").size;
    assert!(pill.width < card.width && pill.height < card.height);
    let before = (transcript.read_with(cx, |t, _| t.item_renders()), panel.read_with(cx, |p, _| p.renders()));
    for _ in 0..3 {
        frame(cx);
        let now = cx.debug_bounds("update-morph").expect("the morph runs").size;
        assert!(now.width <= card.width && now.width >= pill.width, "between the faces: {now:?}");
        assert!(now.height <= card.height && now.height >= pill.height, "between the faces: {now:?}");
    }
    assert!(update.read_with(cx, |u, _| u.morph_frames()).is_some_and(|n| n >= 4), "a frame each");
    let after = (transcript.read_with(cx, |t, _| t.item_renders()), panel.read_with(cx, |p, _| p.renders()));
    assert_eq!(after, before, "the morph rebuilt no transcript item and not the panel");

    // Motion Off: the swap lands at once.
    crate::theme::live::set_live(crate::theme::live::LiveStyle { motion_scale: 0.0, ..Default::default() });
    update.update(cx, |u, cx| u.close(cx));
    cx.run_until_parked();
    let shown = cx.update(|window, cx| {
        update.update(cx, |u, cx| u.show(window, cx));
        update.read(cx).morph_frames()
    });
    assert_eq!(shown, None, "no morph with Motion off");
    crate::theme::live::set_live(Default::default());
    set_test_motion(false);
}

/// The Terminals drawer rises under a cover of its own: its frames rebuild neither the drawer nor the transcript.
#[gpui::test]
fn the_terminal_drawer_slides_in_under_its_cover(cx: &mut TestAppContext) {
    use crate::workspace::panel::slide::cover_renders;

    set_test_motion(true);
    let (workspace, cx) = testing::mount_workspace(cx);
    // After mounting: the Workspace applies the stored Appearance, Normal speed.
    slow_motion();
    let (chat, terminals) = workspace.read_with(cx, |w, _| (w.chat.clone(), w.terminals.clone()));
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    frame(cx);
    cx.update(|window, cx| terminals.update(cx, |t, cx| t.new_terminal(window, cx)));
    cx.run_until_parked();
    assert!(terminals.read_with(cx, |t, _| t.is_open()));
    assert!(cx.update(|_, cx| cover_renders("terminal", cx)).is_some(), "the drawer slides in");
    let before = (transcript.read_with(cx, |t, _| t.item_renders()), terminals.read_with(cx, |t, _| t.renders()));
    for _ in 0..5 {
        frame(cx);
    }
    let after = (transcript.read_with(cx, |t, _| t.item_renders()), terminals.read_with(cx, |t, _| t.renders()));
    assert_eq!(after, before, "no transcript item and no drawer render while it slides");
    set_test_motion(false);
}

/// ⌘F's bar fades up from 8px below its place, a frame at a time in its own view.
#[gpui::test]
fn the_find_bar_fades_up(cx: &mut TestAppContext) {
    use crate::theme::live::{LiveStyle, set_live};

    set_test_motion(true);
    let (workspace, cx) = testing::mount_workspace(cx);
    let chat = workspace.read_with(cx, |w, _| w.chat.clone());
    let transcript = chat.read_with(cx, |c, _| c.transcript.clone());
    frame(cx);
    // Its place: opened with Motion off, it lands there at once.
    set_live(LiveStyle { motion_scale: 0.0, ..Default::default() });
    cx.update(|window, cx| chat.update(cx, |c, cx| c.open_find(None, window, cx)));
    cx.run_until_parked();
    let place = cx.debug_bounds("find-bar").expect("the bar is drawn").origin.y;
    cx.update(|window, cx| chat.update(cx, |c, cx| c.close_find(window, cx)));
    cx.run_until_parked();

    slow_motion();
    cx.update(|window, cx| chat.update(cx, |c, cx| c.open_find(None, window, cx)));
    cx.run_until_parked();
    let items = transcript.read_with(cx, |t, _| t.item_renders());
    frame(cx);
    let start = cx.debug_bounds("find-bar").expect("the bar is drawn").origin.y;
    assert!(start > place && start - place <= gpui::px(8.0), "it starts below its place: {start:?}, place {place:?}");
    frame(cx);
    assert_eq!(transcript.read_with(cx, |t, _| t.item_renders()), items, "the fade rebuilt no transcript item");
    set_live(LiveStyle::default());
    set_test_motion(false);
}
