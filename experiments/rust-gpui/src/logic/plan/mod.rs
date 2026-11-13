//! A Chat's plan and its phase graph: `packages/shared/src/chat-plan.mjs` (`PHASES`, `taskCounts`,
//! `currentPhase`) and `phase-graph.mjs` (`phaseGraph`, `rowY`, `phaseGraphPath`, `phaseGraphLayout`).
//!
//! Pure geometry: the view draws what these return. The tests are the ones in `phase-graph.test.ts`.

use std::fmt::Write as _;

const HOUR: i64 = 3_600_000;

/// The phases, bottom row first (`PHASES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Start,
    Plan,
    Build,
    Test,
    Review,
    Merge,
    Release,
    Done,
}

pub const PHASES: [Phase; 8] =
    [Phase::Start, Phase::Plan, Phase::Build, Phase::Test, Phase::Review, Phase::Merge, Phase::Release, Phase::Done];

impl Phase {
    /// `PHASE_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Phase::Start => "Start",
            Phase::Plan => "Plan",
            Phase::Build => "Build",
            Phase::Test => "Test",
            Phase::Review => "Review",
            Phase::Merge => "Merge",
            Phase::Release => "Release",
            Phase::Done => "Done",
        }
    }

    /// `PHASES.indexOf(phase)`: 0 at the bottom of the graph.
    pub fn row(self) -> usize {
        PHASES.iter().position(|phase| *phase == self).expect("in PHASES")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

impl TaskStatus {
    pub fn label(self) -> &'static str {
        match self {
            TaskStatus::Pending => "Pending",
            TaskStatus::InProgress => "In progress",
            TaskStatus::Completed => "Completed",
        }
    }
}

/// `ChatTask` (`model.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatTask {
    pub id: String,
    pub title: String,
    pub active_form: Option<String>,
    pub status: TaskStatus,
    pub children: Vec<ChatTask>,
}

impl ChatTask {
    pub fn new(id: &str, title: &str, status: TaskStatus) -> Self {
        Self { id: id.into(), title: title.into(), active_form: None, status, children: Vec::new() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhaseEntry {
    pub phase: Phase,
    pub at: i64,
}

/// `ChatPlan`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatPlan {
    pub tasks: Vec<ChatTask>,
    pub phases: Vec<PhaseEntry>,
}

impl ChatPlan {
    /// `!plan.tasks.length && !plan.phases.length`: nothing for the Tasks pill to show.
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty() && self.phases.is_empty()
    }
}

/// `taskCounts`: leaves done and leaves in all (a parent counts through its children).
pub fn task_counts(tasks: &[ChatTask]) -> (usize, usize) {
    tasks.iter().fold((0, 0), |(done, total), task| {
        if task.children.is_empty() {
            (done + usize::from(task.status == TaskStatus::Completed), total + 1)
        } else {
            let (d, t) = task_counts(&task.children);
            (done + d, total + t)
        }
    })
}

/// `currentPhase`.
pub fn current_phase(plan: &ChatPlan) -> Option<Phase> {
    plan.phases.last().map(|entry| entry.phase)
}

/// A point on the 0..1 time axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraphPoint {
    pub x: f64,
    pub row: usize,
    pub phase: Phase,
    pub at: i64,
}

/// A stretch longer than `gap_ms`, drawn `gap_ms` wide and labelled.
#[derive(Clone, Debug, PartialEq)]
pub struct Gap {
    pub x0: f64,
    pub x1: f64,
    pub row: usize,
    pub to_row: usize,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tick {
    pub x: f64,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PhaseGraph {
    pub points: Vec<GraphPoint>,
    pub gaps: Vec<Gap>,
    pub ticks: Vec<Tick>,
    pub current: Option<Phase>,
}

/// `new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })`, in UTC (the fixture's clock).
pub fn default_format(ms: i64) -> String {
    let minutes = ms.div_euclid(60_000);
    format!("{:02}:{:02}", minutes.div_euclid(60).rem_euclid(24), minutes.rem_euclid(60))
}

fn duration(ms: i64) -> String {
    // `Math.round` rounds halves up.
    let round = |value: f64| (value + 0.5).floor() as i64;
    if ms >= 48 * HOUR { format!("{}d", round(ms as f64 / (24 * HOUR) as f64)) } else { format!("{}h", round(ms as f64 / HOUR as f64)) }
}

/// `phaseGraph` with the default `gapMs` of one hour.
pub fn phase_graph(phases: &[PhaseEntry], now: i64, format_time: &dyn Fn(i64) -> String) -> PhaseGraph {
    phase_graph_with(phases, now, HOUR, format_time)
}

pub fn phase_graph_with(phases: &[PhaseEntry], now: i64, gap_ms: i64, format_time: &dyn Fn(i64) -> String) -> PhaseGraph {
    let Some(last) = phases.last() else { return PhaseGraph { points: vec![], gaps: vec![], ticks: vec![], current: None } };
    let mut times: Vec<i64> = phases.iter().map(|entry| entry.at).collect();
    times.push(now.max(last.at));
    let widths: Vec<i64> = times.windows(2).map(|pair| (pair[1] - pair[0]).max(0).min(gap_ms)).collect();
    let total: i64 = widths.iter().sum();
    let mut xs = vec![0_i64];
    for width in &widths {
        xs.push(xs.last().copied().unwrap_or(0) + width);
    }
    let x = |index: usize| if total > 0 { xs[index] as f64 / total as f64 } else { 0.0 };
    let points: Vec<GraphPoint> = phases
        .iter()
        .enumerate()
        .map(|(index, entry)| GraphPoint { x: x(index), row: entry.phase.row(), phase: entry.phase, at: entry.at })
        .collect();
    let mut gaps = Vec::new();
    for index in 0..times.len() - 1 {
        let length = times[index + 1] - times[index];
        if length <= gap_ms {
            continue;
        }
        let last_gap = index + 1 == times.len() - 1;
        gaps.push(Gap {
            x0: x(index),
            x1: if last_gap { 1.0 } else { x(index + 1) },
            row: points[index].row,
            to_row: if last_gap { points[index].row } else { points[index + 1].row },
            label: duration(length),
        });
    }
    let mut ticks: Vec<Tick> = Vec::new();
    for point in &points {
        if ticks.last().is_some_and(|tick| point.x - tick.x < 0.25) {
            continue;
        }
        if point.x > 0.85 {
            break;
        }
        ticks.push(Tick { x: point.x, label: format_time(point.at) });
    }
    PhaseGraph { points, gaps, ticks, current: Some(last.phase) }
}

fn round2(value: f64) -> f64 {
    // `Number(value.toFixed(2))`.
    (value * 100.0).round() / 100.0
}

/// `rowY`: the y of a phase row's centre, `start` (row 0) at the bottom.
pub fn row_y(row: usize, height: f64) -> f64 {
    let band = height / PHASES.len() as f64;
    round2(height - (row as f64 + 0.5) * band)
}

/// `phaseGraphPath`'s control points as numbers (the view strokes them; the string form is for the tests).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathStep {
    Move(f64, f64),
    Curve { c1: (f64, f64), c2: (f64, f64), to: (f64, f64) },
    HLine(f64),
}

pub fn phase_graph_steps(points: &[GraphPoint], width: f64, height: f64, left: f64) -> Vec<PathStep> {
    let Some(first) = points.first() else { return vec![] };
    let at = |point: &GraphPoint| (round2(left + point.x * width), row_y(point.row, height));
    let (x0, y0) = at(first);
    let mut steps = vec![PathStep::Move(x0, y0)];
    for index in 1..points.len() {
        let (px, py) = at(&points[index - 1]);
        let (nx, ny) = at(&points[index]);
        let mid = round2((px + nx) / 2.0);
        steps.push(PathStep::Curve { c1: (mid, py), c2: (mid, ny), to: (nx, ny) });
    }
    steps.push(PathStep::HLine(round2(left + width)));
    steps
}

/// `phaseGraphPath`: the SVG path data.
pub fn phase_graph_path(points: &[GraphPoint], width: f64, height: f64, left: f64) -> String {
    let mut d = String::new();
    for step in phase_graph_steps(points, width, height, left) {
        match step {
            PathStep::Move(x, y) => write!(d, "M{} {}", js(x), js(y)),
            PathStep::Curve { c1, c2, to } => {
                write!(d, " C{} {}, {} {}, {} {}", js(c1.0), js(c1.1), js(c2.0), js(c2.1), js(to.0), js(to.1))
            }
            PathStep::HLine(x) => write!(d, " H{}", js(x)),
        }
        .expect("writing to a String");
    }
    d
}

/// A number as JavaScript prints it: no trailing `.0`.
fn js(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
    Start,
    Middle,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LaidPoint {
    pub x: f64,
    pub y: f64,
    pub phase: Phase,
    pub at: i64,
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LaidGap {
    pub x: f64,
    pub y: f64,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LaidTick {
    pub x: f64,
    pub anchor: Anchor,
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NowMark {
    pub x: f64,
    pub anchor: Anchor,
    pub line_x: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraphLayout {
    pub steps: Vec<PathStep>,
    pub plot_left: f64,
    pub plot_right: f64,
    pub points: Vec<LaidPoint>,
    pub gaps: Vec<LaidGap>,
    pub ticks: Vec<LaidTick>,
    pub now: NowMark,
}

/// `phaseGraphLayout` with the default insets (6, 6) and label widths (44, 28).
pub fn phase_graph_layout(graph: &PhaseGraph, width: f64, height: f64) -> GraphLayout {
    let (inset_left, inset_right, tick_width, now_width) = (6.0, 6.0, 44.0, 28.0);
    let plot_width = (width - inset_left - inset_right).max(0.0);
    let plot_right = inset_left + plot_width;
    let px = |x: f64| round2(inset_left + x * plot_width);
    let last = graph.points.len().saturating_sub(1);
    let points = graph
        .points
        .iter()
        .enumerate()
        .map(|(index, point)| LaidPoint {
            x: px(point.x),
            y: row_y(point.row, height),
            phase: point.phase,
            at: point.at,
            current: index == last,
        })
        .collect();
    let gaps = graph
        .gaps
        .iter()
        .map(|gap| LaidGap {
            x: px((gap.x0 + gap.x1) / 2.0),
            y: round2((row_y(gap.row, height) + row_y(gap.to_row, height)) / 2.0),
            label: gap.label.clone(),
        })
        .collect();
    let mut ticks = Vec::new();
    let mut free_from = 0.0;
    let now_start = width - now_width - 2.0;
    for tick in &graph.ticks {
        let first = tick.x == 0.0;
        let x = if first { inset_left } else { px(tick.x) };
        let start = if first { x } else { x - tick_width / 2.0 };
        let end = if first { x + tick_width } else { x + tick_width / 2.0 };
        if start < free_from || end > now_start {
            continue;
        }
        ticks.push(LaidTick { x, anchor: if first { Anchor::Start } else { Anchor::Middle }, label: tick.label.clone() });
        free_from = end + 4.0;
    }
    GraphLayout {
        steps: phase_graph_steps(&graph.points, plot_width, height, inset_left),
        plot_left: inset_left,
        plot_right,
        points,
        gaps,
        ticks,
        now: NowMark { x: width - 2.0, anchor: Anchor::End, line_x: plot_right },
    }
}

#[cfg(test)]
mod tests;
