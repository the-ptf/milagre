//! `phase-graph.test.ts` and the `chat-plan` counters.

use super::*;

const MIN: i64 = 60_000;

fn format(ms: i64) -> String {
    format!("t{}", ms / MIN)
}

fn entry(phase: Phase, at: i64) -> PhaseEntry {
    PhaseEntry { phase, at }
}

#[test]
fn no_entries_draw_nothing() {
    let graph = phase_graph(&[], 10, &format);
    assert!(graph.points.is_empty());
    assert_eq!(graph.current, None);
}

#[test]
fn one_entry_draws_a_flat_line_to_now() {
    let graph = phase_graph(&[entry(Phase::Plan, 0)], 0, &format);
    assert_eq!(graph.points, vec![GraphPoint { x: 0.0, row: 1, phase: Phase::Plan, at: 0 }]);
    let path = phase_graph_path(&graph.points, 100.0, 80.0, 0.0);
    assert!(path.starts_with("M0 ") && path.ends_with(" H100") && !path.contains('C'), "{path}");
}

#[test]
fn x_follows_time_and_the_current_phase_is_the_last() {
    let graph = phase_graph(&[entry(Phase::Start, 0), entry(Phase::Plan, 10 * MIN), entry(Phase::Build, 20 * MIN)], 40 * MIN, &format);
    assert_eq!(graph.points.iter().map(|p| p.x).collect::<Vec<_>>(), vec![0.0, 0.25, 0.5]);
    assert_eq!(graph.current, Some(Phase::Build));
    assert!(graph.gaps.is_empty());
}

#[test]
fn a_stretch_over_an_hour_folds_into_a_gap_with_its_length() {
    let graph = phase_graph(
        &[entry(Phase::Build, 0), entry(Phase::Test, 30 * MIN), entry(Phase::Review, 30 * MIN + 2 * HOUR)],
        30 * MIN + 2 * HOUR + 30 * MIN,
        &format,
    );
    assert_eq!(graph.gaps.len(), 1);
    assert_eq!(graph.gaps[0].label, "2h");
    assert_eq!(graph.points.iter().map(|p| (p.x * 1000.0).round() / 1000.0).collect::<Vec<_>>(), vec![0.0, 0.25, 0.75]);
    assert_eq!((graph.gaps[0].x0, graph.gaps[0].x1), (0.25, 0.75));
}

#[test]
fn long_gaps_are_labelled_in_days_past_forty_eight_hours() {
    let graph = phase_graph(&[entry(Phase::Build, 0), entry(Phase::Test, 72 * HOUR)], 72 * HOUR, &format);
    assert_eq!(graph.gaps[0].label, "3d");
}

#[test]
fn ticks_label_the_first_point_and_points_at_least_a_quarter_apart() {
    let graph = phase_graph(
        &[entry(Phase::Start, 0), entry(Phase::Plan, MIN), entry(Phase::Build, 20 * MIN), entry(Phase::Test, 30 * MIN)],
        40 * MIN,
        &format,
    );
    assert_eq!(graph.ticks.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), vec!["t0", "t20", "t30"]);
}

#[test]
fn rows_run_bottom_to_top_and_the_path_curves_between_points() {
    assert!(row_y(0, 80.0) > row_y(7, 80.0));
    let graph = phase_graph(&[entry(Phase::Start, 0), entry(Phase::Build, MIN)], 2 * MIN, &format);
    let path = phase_graph_path(&graph.points, 100.0, 80.0, 0.0);
    assert!(path.starts_with("M0 ") && path.contains(" C") && path.ends_with(" H100"), "{path}");
}

/// Pinned by running `phase-graph.mjs` on the same input.
#[test]
fn the_path_equals_the_mjs_output() {
    let graph = phase_graph(&[entry(Phase::Start, 0), entry(Phase::Build, 30 * MIN)], 60 * MIN, &format);
    // x: 0 and 0.5; rows 0 and 2; height 80, so y = 75 and 55.
    assert_eq!(phase_graph_path(&graph.points, 100.0, 80.0, 0.0), "M0 75 C25 75, 25 55, 50 55 H100");
}

fn sample() -> PhaseGraph {
    phase_graph(
        &[
            entry(Phase::Start, 0),
            entry(Phase::Plan, 20 * MIN),
            entry(Phase::Build, 40 * MIN),
            entry(Phase::Test, 60 * MIN),
            entry(Phase::Review, 60 * MIN + 3 * HOUR),
        ],
        60 * MIN + 4 * HOUR,
        &format,
    )
}

#[test]
fn layout_keeps_the_first_tick_the_dots_and_now_inside_the_box() {
    for width in [120.0, 200.0, 260.0, 340.0, 600.0] {
        let layout = phase_graph_layout(&sample(), width, 168.0);
        assert_eq!(layout.ticks[0].anchor, Anchor::Start);
        assert_eq!(layout.ticks[0].x, 6.0);
        assert_eq!(layout.now, NowMark { x: width - 2.0, anchor: Anchor::End, line_x: width - 6.0 });
        for point in &layout.points {
            assert!(point.x >= 6.0 && point.x <= width - 6.0, "{} outside at {width}", point.x);
        }
        assert_eq!(layout.points[0].x, 6.0);
        assert_eq!(layout.points.iter().filter(|p| p.current).count(), 1);
    }
}

#[test]
fn layout_drops_ticks_whose_labels_would_cross_an_edge_a_neighbour_or_now() {
    for width in [90.0, 120.0, 200.0, 260.0, 340.0, 600.0] {
        let layout = phase_graph_layout(&sample(), width, 168.0);
        let mut free = 0.0;
        for tick in &layout.ticks {
            let start = if tick.anchor == Anchor::Start { tick.x } else { tick.x - 22.0 };
            let end = start + 44.0;
            assert!(start >= 0.0 && end <= width, "tick {} crosses an edge at {width}", tick.label);
            assert!(start >= free, "tick {} overlaps the previous one at {width}", tick.label);
            assert!(end <= width - 28.0, "tick {} overlaps Now at {width}", tick.label);
            free = end;
        }
    }
}

#[test]
fn the_gap_chip_sits_on_the_curve_midway_between_its_rows() {
    let layout = phase_graph_layout(&sample(), 260.0, 168.0);
    assert_eq!(layout.gaps.len(), 1, "the last hour to Now is exactly the gap length: not a gap");
    let gap = &layout.gaps[0];
    assert_eq!(gap.label, "3h");
    let (a, b) = (row_y(Phase::Test.row(), 168.0), row_y(Phase::Review.row(), 168.0));
    assert_eq!(gap.y, ((a + b) / 2.0 * 100.0).round() / 100.0);
}

#[test]
fn counts_go_through_parents_to_their_leaves() {
    let mut parent = ChatTask::new("1", "Parent", TaskStatus::InProgress);
    parent.children = vec![ChatTask::new("1.1", "a", TaskStatus::Completed), ChatTask::new("1.2", "b", TaskStatus::Pending)];
    let tasks = vec![parent, ChatTask::new("2", "c", TaskStatus::Completed)];
    assert_eq!(task_counts(&tasks), (2, 3));
    assert_eq!(task_counts(&[]), (0, 0));
}

#[test]
fn the_current_phase_is_the_last_entry() {
    let plan = ChatPlan { tasks: vec![], phases: vec![entry(Phase::Start, 0), entry(Phase::Test, 5)] };
    assert_eq!(current_phase(&plan), Some(Phase::Test));
    assert!(ChatPlan::default().is_empty() && !plan.is_empty());
    assert_eq!(default_format(13 * HOUR + 5 * MIN), "13:05");
}
