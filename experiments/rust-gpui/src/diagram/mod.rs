//! Mermaid diagrams in the transcript (WP-38, surface T-27): `apps/desktop/app/src/components/markdown/MermaidBlock.tsx`
//! and `packages/shared/src/diagram.ts`.
//!
//! Decision: the desktop draws with Pele, a JavaScript library. A Rust renderer exists and is good enough:
//! `mermaid-rs-renderer` 0.3.1, MIT, pure Rust, 23 diagram kinds (flowchart, sequence, class, state, ER, pie,
//! gantt, mind map, timeline, git graph, journey, quadrant, sankey, block, packet, architecture, kanban, radar,
//! treemap, XY chart, C4, requirement, ZenUML). It runs in-process, so there is no daemon method to call and no
//! fallback for a host that lacks one. A diagram it cannot parse shows its source with the reason, as the desktop
//! does when Pele throws. See [`render`] for how the picture is made.
//!
//! What the block does, as `MermaidBlock` does: a header (what the diagram is, a Diagram / Source switch, Copy,
//! Expand) over the picture, which is as wide as the reply (scaled down, never up). The block still being written
//! is a code block until its fence closes. Expand opens the picture in a dialog. Not built: the zoom of the
//! lightbox, and Pele's re-layout as the reply narrows (a wide flowchart turning top-down): the picture is laid
//! out once and scaled to fit.

pub mod render;
#[cfg(test)]
mod tests;
mod view;

pub use view::render_block;

/// `isMermaidFence`: the whole info string, trimmed, is `mermaid`.
pub fn is_mermaid_fence(info: Option<&str>) -> bool {
    info.is_some_and(|info| crate::logic::copy::js::trim(info).eq_ignore_ascii_case("mermaid"))
}

/// `LABELS` in `shared/diagram.ts`: what a diagram is, in words, by the type Pele detects.
const LABELS: &[(&str, &str)] = &[
    ("flowchart", "Flowchart"),
    ("graph", "Flowchart"),
    ("sequence", "Sequence diagram"),
    ("class", "Class diagram"),
    ("classDiagram", "Class diagram"),
    ("state", "State diagram"),
    ("stateDiagram", "State diagram"),
    ("er", "Entity relationship diagram"),
    ("erDiagram", "Entity relationship diagram"),
    ("gantt", "Gantt chart"),
    ("pie", "Pie chart"),
    ("mindmap", "Mind map"),
    ("timeline", "Timeline"),
    ("gitGraph", "Git graph"),
    ("journey", "User journey"),
    ("quadrantChart", "Quadrant chart"),
    ("xychart", "Chart"),
    ("sankey", "Sankey diagram"),
    ("block", "Block diagram"),
    ("packet", "Packet diagram"),
    ("architecture", "Architecture diagram"),
    ("kanban", "Kanban board"),
    ("radar", "Radar chart"),
    ("treemap", "Treemap"),
    ("requirement", "Requirement diagram"),
    ("c4", "C4 diagram"),
    ("zenuml", "Sequence diagram"),
];

/// `diagramLabel`: "Diagram" for a type it does not know; `-v2` and `-beta` endings are ignored.
pub fn diagram_label(kind: Option<&str>) -> &'static str {
    let Some(kind) = kind.filter(|kind| !kind.is_empty()) else { return "Diagram" };
    let find = |name: &str| LABELS.iter().find(|(key, _)| *key == name).map(|(_, label)| *label);
    find(kind).or_else(|| find(strip_version(kind))).unwrap_or("Diagram")
}

/// `type.replace(/-?(?:v\d+|beta)$/i, "")`.
fn strip_version(kind: &str) -> &str {
    let lower = kind.to_ascii_lowercase();
    let cut = if let Some(rest) = lower.strip_suffix("beta") {
        rest.len()
    } else if let Some(at) = lower.rfind('v').filter(|at| *at + 1 < lower.len() && lower[*at + 1..].bytes().all(|b| b.is_ascii_digit())) {
        at
    } else {
        return kind;
    };
    kind[..cut].strip_suffix('-').unwrap_or(&kind[..cut])
}

/// What Pele's `detectType` says for a diagram's text: the first word of the first line that is not blank, a
/// comment (`%%`) or front matter / a directive. `graph` and `flowchart` are both flowcharts.
pub fn detect_type(code: &str) -> Option<String> {
    let mut in_front_matter = false;
    for (ix, line) in code.lines().enumerate() {
        let line = line.trim();
        if ix == 0 && line == "---" {
            in_front_matter = true;
            continue;
        }
        if in_front_matter {
            in_front_matter = line != "---";
            continue;
        }
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        let word: String = line.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        let word = match word.as_str() {
            "sequenceDiagram" => "sequence".to_string(),
            "journey" | "mindmap" | "timeline" | "gantt" | "pie" => word,
            _ => word,
        };
        return if word.is_empty() { None } else { Some(word) };
    }
    None
}
