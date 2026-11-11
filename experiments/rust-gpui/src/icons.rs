//! Panel header icons: Lucide-style strokes on a 24 x 24 grid, painted with `PathBuilder` inside a
//! `canvas` (same approach as the sidebar, at its own size and stroke width).

use std::f32::consts::{PI, TAU};

use gpui::{PathBuilder, Pixels, Rgba, canvas, point, prelude::*, px};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelIcon {
    FileDiff,
    Terminal,
    Globe,
    Palette,
    FileText,
    PullRequest,
    Expand,
    Close,
}

enum Stroke {
    Line(Vec<(f32, f32)>),
    Closed(Vec<(f32, f32)>),
}

use Stroke::{Closed, Line};

fn arc(cx: f32, cy: f32, rx: f32, ry: f32, from: f32, to: f32, steps: usize) -> Vec<(f32, f32)> {
    (0..=steps)
        .map(|i| {
            let a = from + (to - from) * i as f32 / steps as f32;
            (cx + rx * a.cos(), cy + ry * a.sin())
        })
        .collect()
}

fn ellipse(cx: f32, cy: f32, rx: f32, ry: f32) -> Stroke {
    let mut points = arc(cx, cy, rx, ry, 0.0, TAU, 32);
    points.pop();
    Closed(points)
}

fn circle(cx: f32, cy: f32, r: f32) -> Stroke {
    ellipse(cx, cy, r, r)
}

fn rrect(x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> Stroke {
    let q = PI / 2.0;
    let mut p = arc(x1 - r, y0 + r, r, r, -q, 0.0, 4);
    p.extend(arc(x1 - r, y1 - r, r, r, 0.0, q, 4));
    p.extend(arc(x0 + r, y1 - r, r, r, q, 2.0 * q, 4));
    p.extend(arc(x0 + r, y0 + r, r, r, 2.0 * q, 3.0 * q, 4));
    Closed(p)
}

/// The page outline with a folded corner, shared by the two document icons.
fn page() -> Vec<Stroke> {
    vec![
        Closed(vec![(14.0, 2.0), (6.5, 2.0), (4.0, 4.5), (4.0, 19.5), (6.5, 22.0), (17.5, 22.0), (20.0, 19.5), (20.0, 8.0)]),
        Line(vec![(14.0, 2.0), (14.0, 8.0), (20.0, 8.0)]),
    ]
}

fn strokes(kind: PanelIcon) -> Vec<Stroke> {
    match kind {
        PanelIcon::FileDiff => {
            let mut s = page();
            s.push(Line(vec![(12.0, 10.0), (12.0, 15.0)]));
            s.push(Line(vec![(9.5, 12.5), (14.5, 12.5)]));
            s.push(Line(vec![(9.5, 18.0), (14.5, 18.0)]));
            s
        }
        PanelIcon::Terminal => vec![
            rrect(3.0, 3.0, 21.0, 21.0, 2.5),
            Line(vec![(7.0, 9.0), (10.0, 12.0), (7.0, 15.0)]),
            Line(vec![(13.0, 15.0), (17.0, 15.0)]),
        ],
        PanelIcon::Globe => vec![circle(12.0, 12.0, 10.0), Line(vec![(2.0, 12.0), (22.0, 12.0)]), ellipse(12.0, 12.0, 4.5, 10.0)],
        PanelIcon::Palette => {
            let mut body = arc(12.0, 12.0, 10.0, 10.0, PI / 2.0, 2.0 * PI, 28);
            body.extend([(21.5, 14.0), (17.0, 17.0), (14.75, 17.0), (13.3, 19.8), (13.6, 20.6)]);
            vec![Closed(body), circle(13.5, 6.5, 0.6), circle(17.5, 10.5, 0.6), circle(8.5, 7.5, 0.6), circle(6.5, 12.5, 0.6)]
        }
        PanelIcon::FileText => {
            let mut s = page();
            s.push(Line(vec![(8.0, 9.0), (10.0, 9.0)]));
            s.push(Line(vec![(8.0, 13.0), (16.0, 13.0)]));
            s.push(Line(vec![(8.0, 17.0), (16.0, 17.0)]));
            s
        }
        PanelIcon::PullRequest => vec![
            circle(6.0, 6.0, 3.0),
            circle(18.0, 18.0, 3.0),
            Line(vec![(6.0, 9.0), (6.0, 21.0)]),
            Line(vec![(13.0, 6.0), (16.0, 6.0), (18.0, 8.0), (18.0, 15.0)]),
            Line(vec![(15.5, 3.5), (13.0, 6.0), (15.5, 8.5)]),
        ],
        PanelIcon::Expand => vec![
            Line(vec![(15.0, 3.0), (21.0, 3.0), (21.0, 9.0)]),
            Line(vec![(9.0, 21.0), (3.0, 21.0), (3.0, 15.0)]),
            Line(vec![(21.0, 3.0), (14.0, 10.0)]),
            Line(vec![(3.0, 21.0), (10.0, 14.0)]),
        ],
        PanelIcon::Close => vec![Line(vec![(5.0, 5.0), (19.0, 19.0)]), Line(vec![(19.0, 5.0), (5.0, 19.0)])],
    }
}

/// A square stroked icon, `size` px wide, with a `stroke` px line.
pub fn icon(kind: PanelIcon, size: f32, stroke: f32, color: Rgba) -> impl IntoElement + use<> {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let unit: Pixels = bounds.size.width / 24.0;
            let mut builder = PathBuilder::stroke(px(stroke));
            for s in strokes(kind) {
                let (points, closed) = match &s {
                    Line(p) => (p, false),
                    Closed(p) => (p, true),
                };
                let mapped: Vec<_> = points.iter().map(|&(x, y)| point(bounds.origin.x + unit * x, bounds.origin.y + unit * y)).collect();
                builder.add_polygon(&mapped, closed);
            }
            if let Ok(path) = builder.build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(size))
}

/// Stand-in provider logos (not the real marks) and the usage warning triangle, on the same 24 grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderLogo {
    /// Eight-ray starburst.
    Claude,
    /// Cloud outline.
    Codex,
    /// Rounded arch with a crossbar.
    Antigravity,
    /// Triangle with an exclamation mark.
    Warning,
}

fn logo_strokes(kind: ProviderLogo) -> Vec<Stroke> {
    match kind {
        ProviderLogo::Claude => (0..8)
            .map(|i| {
                let a = i as f32 * PI / 4.0;
                Line(vec![(12.0 + 3.0 * a.cos(), 12.0 + 3.0 * a.sin()), (12.0 + 10.0 * a.cos(), 12.0 + 10.0 * a.sin())])
            })
            .collect(),
        ProviderLogo::Codex => {
            let mut p = arc(8.0, 14.0, 4.5, 4.5, PI / 2.0, 3.0 * PI / 2.0, 8);
            p.extend(arc(12.0, 9.5, 5.0, 5.0, PI, 1.75 * PI, 10));
            p.extend(arc(17.0, 14.0, 4.5, 4.5, -PI / 2.0, PI / 2.0, 8));
            vec![Closed(p)]
        }
        ProviderLogo::Antigravity => {
            let mut p = vec![(3.5, 20.0)];
            p.extend(arc(12.0, 11.0, 8.5, 8.5, PI, TAU, 16));
            p.push((20.5, 20.0));
            vec![Line(p), Line(vec![(7.5, 15.0), (16.5, 15.0)])]
        }
        ProviderLogo::Warning => vec![
            Closed(vec![(12.0, 3.0), (22.0, 20.5), (2.0, 20.5)]),
            Line(vec![(12.0, 9.5), (12.0, 14.5)]),
            Line(vec![(12.0, 17.5), (12.0, 17.6)]),
        ],
    }
}

/// A square provider logo, `size` px wide, stroked `stroke` px in `color`.
pub fn provider_logo(kind: ProviderLogo, size: f32, stroke: f32, color: Rgba) -> impl IntoElement + use<> {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let unit: Pixels = bounds.size.width / 24.0;
            let mut builder = PathBuilder::stroke(px(stroke));
            for s in logo_strokes(kind) {
                let (points, closed) = match &s {
                    Line(p) => (p, false),
                    Closed(p) => (p, true),
                };
                let mapped: Vec<_> = points.iter().map(|&(x, y)| point(bounds.origin.x + unit * x, bounds.origin.y + unit * y)).collect();
                builder.add_polygon(&mapped, closed);
            }
            if let Ok(path) = builder.build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(size))
}
