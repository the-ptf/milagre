//! Transcript dividers: a hairline each side of a centred 12px `ink-3` label, 12px from each rule
//! (`primitives/TranscriptDivider.tsx`). One data shape, built per context kind:
//!
//! | Kind | Source | Draws |
//! | --- | --- | --- |
//! | handoff | `Handover.tsx` | ⇄ "Context handoff" logo from → logo to, or "Context restored" on the same provider |
//! | compaction | `CompactionDivider.tsx`, `compaction.mjs` | ⇲ "Context compacted" `897k → 42k` |
//! | reload | `ChatReloadDivider.tsx` | ↻ "Chat reloaded" |
//! | account switch | `AccountSwitchDivider.tsx` | "Switched to" **me@work.com** |
//! | limit reset | `ChatComposer.tsx:423` | the line alone, no icon |
//! | Routine Run | `RoutineRunDivider.tsx`, `routines.mjs` | ∿ "Heartbeat · 10:15" |
//! | babysit stopped | `BabysitStoppedDivider.tsx`, `babysit.mjs` | ∿ "Stopped babysitting PR #1: merged." |
//! | checkpoint restore | `CheckpointRestoreDivider.tsx` | ↶ "Undid 2 files · Redo" |
//! | Worktree link | `WorktreeLinkDivider.tsx`, `worktree-link.mjs` | ⛓ "Linked to" avatar **web** `main` |
//!
//! The three the data layer does not type (babysit stopped, checkpoint restore, Worktree link) come from the
//! kept JSON of `ChatContext::Other`. A handoff or a Link that has a brief opens it in the viewer, as the app's
//! dialog does; the checkpoint's Redo is inert here (it previews a recovery checkpoint through the host).

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, SharedString, div, prelude::*, px};

use super::super::Transcript;
use super::images::Viewer;
use crate::data::{ChatContext, DividerStatus, Provider};
use crate::logic::usage::limit::account_switch_text;
use crate::logic::usage::limit::limit_reset_text;
use crate::logic::usage::time::{FixedZone, local_time};
use crate::logic::usage::tokens::format_tokens;
use crate::theme::{RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, Theme, mono};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, ProviderLogo, SpinnerRing};

/// What a divider says, piece by piece.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    /// Plain `ink-3` text.
    Text(SharedString),
    /// `font-medium text-ink-2`: the name the line is about.
    Strong(SharedString),
    /// Mono 11: token counts, branches.
    Mono(SharedString),
    /// `orange-ink`: a failure.
    Warn(SharedString),
    /// A 12px provider mark.
    Logo(Provider),
    /// A 16px Project tile.
    Avatar(SharedString),
    /// A semibold `accent-ink` action (the checkpoint's Redo). Inert here.
    Action(SharedString),
}

/// The brief a divider opens in the viewer.
#[derive(Clone, Debug, PartialEq)]
pub struct Brief {
    pub title: SharedString,
    pub body: SharedString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Divider {
    /// The line as text: the group's accessible name and the test handle.
    pub label: SharedString,
    pub icon: Option<IconName>,
    /// A ring in place of the icon while the work is under way.
    pub preparing: bool,
    pub parts: Vec<Part>,
    pub brief: Option<Brief>,
}

fn text(s: impl Into<SharedString>) -> Part {
    Part::Text(s.into())
}

fn strong(s: impl Into<SharedString>) -> Part {
    Part::Strong(s.into())
}

impl Divider {
    fn new(label: impl Into<SharedString>, icon: Option<IconName>, parts: Vec<Part>) -> Self {
        Self { label: label.into(), icon, preparing: false, parts, brief: None }
    }

    /// `handoffLabel`: each side's model name, else its provider's name.
    pub fn handoff(
        from: Provider,
        to: Provider,
        from_model: Option<&SharedString>,
        to_model: Option<&SharedString>,
        status: DividerStatus,
        brief: Option<&str>,
    ) -> Self {
        let side =
            |model: Option<&SharedString>, provider: Provider| -> SharedString { model.cloned().unwrap_or_else(|| provider.name().into()) };
        let (from_name, to_name) = (side(from_model, from), side(to_model, to));
        let restored = from == to;
        let mut parts = vec![text(if restored { "Context restored" } else { "Context handoff" })];
        if !restored {
            parts.extend([Part::Logo(from), text(from_name.clone()), text("\u{2192}")]);
        }
        parts.extend([Part::Logo(to), strong(to_name.clone())]);
        if status == DividerStatus::Failed {
            parts.push(Part::Warn("\u{b7} Handoff failed".into()));
        }
        let label =
            if restored { format!("Context restored to {to_name}") } else { format!("Context handoff from {from_name} to {to_name}") };
        let mut divider = Self::new(label, Some(IconName::ArrowDataTransferHorizontal), parts);
        divider.preparing = status == DividerStatus::Preparing;
        if status == DividerStatus::Done {
            divider.brief = brief.map(|body| Brief { title: "Handoff brief".into(), body: body.to_string().into() });
        }
        divider
    }

    /// `compactionLabel` and `compactionText`.
    pub fn compaction(status: DividerStatus, before: Option<u64>, after: Option<u64>) -> Self {
        let title = match status {
            DividerStatus::Preparing => "Compacting context",
            DividerStatus::Failed => "Compaction failed",
            DividerStatus::Done => "Context compacted",
        };
        let before_text = before.map(|tokens| format_tokens(tokens as f64));
        let after_text = after.filter(|_| status == DividerStatus::Done).map(|tokens| format_tokens(tokens as f64));
        let label = match (&before_text, &after_text) {
            (Some(b), Some(a)) => format!("{title}: {b} \u{2192} {a}"),
            (Some(b), None) => format!("{title}: {b}"),
            _ => title.to_string(),
        };
        let mut parts = vec![if status == DividerStatus::Failed { Part::Warn(title.into()) } else { text(title) }];
        match (before_text, after_text) {
            (Some(b), Some(a)) => parts.push(Part::Mono(format!("{b} \u{2192} {a}").into())),
            (Some(b), None) => parts.push(Part::Mono(b.into())),
            _ => {}
        }
        let mut divider = Self::new(label, Some(IconName::ArrowShrink01), parts);
        divider.preparing = status == DividerStatus::Preparing;
        divider
    }

    pub fn reload() -> Self {
        Self::new("Chat reloaded", Some(IconName::Refresh01), vec![text("Chat reloaded")])
    }

    pub fn account_switch(label: &str) -> Self {
        Self::new(account_switch_text(label), Some(IconName::UserSwitch), vec![text("Switched to"), strong(label.to_string())])
    }

    pub fn limit_reset() -> Self {
        Self::new(limit_reset_text(), None, vec![text(limit_reset_text())])
    }

    /// `routineRunText`: "Heartbeat · 10:15", or the label that led; a quiet run is "10:15 · quiet".
    pub fn routine_run(label: Option<&str>, at: i64, quiet: bool) -> Self {
        let time = local_time(at, &FixedZone(0)).time_24h();
        let line = if quiet { format!("{time} \u{b7} quiet") } else { format!("{} \u{b7} {time}", label.unwrap_or("Heartbeat")) };
        Self::new(line.clone(), Some(IconName::Pulse01), vec![text(line)])
    }

    /// `babysitStoppedText`.
    pub fn babysit_stopped(raw: &serde_json::Value) -> Self {
        let pr = raw.get("pr").and_then(|v| v.as_u64()).unwrap_or(0);
        let count = |key: &str, default: u64| raw.get(key).and_then(|v| v.as_u64()).unwrap_or(default);
        let plural = |n: u64, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
        let why = match raw.get("reason").and_then(|v| v.as_str()) {
            Some("merged") => Some("merged".to_string()),
            Some("closed") => Some("closed".to_string()),
            Some("green") => Some("checks pass and it's approved".to_string()),
            Some("failures") => Some(format!("the same problem failed {}", plural(count("times", 3), "time"))),
            Some("expired") => Some(format!("watched for {}", plural(count("days", 7), "day"))),
            Some("own-rule") => Some("your own stop rule held".to_string()),
            Some("deleted") => Some("its Heartbeat was deleted".to_string()),
            _ => None,
        };
        let line = match why {
            Some(why) => format!("Stopped babysitting PR #{pr}: {why}."),
            None => format!("Stopped babysitting PR #{pr}."),
        };
        Self::new(line.clone(), Some(IconName::Pulse01), vec![text(line)])
    }

    /// `checkpointRestoreText` and `checkpointRestoreAction`.
    pub fn checkpoint_restore(raw: &serde_json::Value) -> Self {
        let restored = raw.get("restored").and_then(|v| v.as_u64()).unwrap_or(0);
        let redo = raw.get("redo").and_then(|v| v.as_bool()).unwrap_or(false);
        let line = format!("{} {restored} {}", if redo { "Redid" } else { "Undid" }, if restored == 1 { "file" } else { "files" });
        let action = if redo { "Undo" } else { "Redo" };
        let icon = if redo { IconName::Redo02 } else { IconName::Undo02 };
        Self::new(line.clone(), Some(icon), vec![text(line), text("\u{b7}"), Part::Action(action.into())])
    }

    /// `worktreeLinkLabel` and `worktreeLinkText`.
    pub fn worktree_link(raw: &serde_json::Value) -> Self {
        let same = raw.get("sameProject").and_then(|v| v.as_bool()).unwrap_or(false);
        let branches: Vec<&str> =
            raw.get("branches").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|b| b.as_str()).collect()).unwrap_or_default();
        let project = raw.pointer("/project/name").and_then(|v| v.as_str()).unwrap_or("");
        let first = branches.first().copied().unwrap_or("");
        let many = branches.len() > 1;
        let (lead, project_name, detail) = if same {
            (
                Some(if many { format!("{} Worktrees", branches.len()) } else { "Worktree".to_string() }),
                None,
                (!many).then(|| first.to_string()),
            )
        } else {
            (None, Some(project.to_string()), Some(if many { format!("\u{b7} {} Worktrees", branches.len()) } else { first.to_string() }))
        };
        let mut parts = vec![text(format!("Linked to{}", lead.as_ref().map(|l| format!(" {l}")).unwrap_or_default()))];
        if let Some(name) = &project_name {
            parts.push(Part::Avatar(name.clone().into()));
            parts.push(strong(name.clone()));
        }
        if let Some(detail) = detail.filter(|d| !d.is_empty()) {
            parts.push(Part::Mono(detail.into()));
        }
        if same {
            parts.push(text("in this Project"));
        }
        let label: String = ["Linked to", lead.as_deref().unwrap_or(""), project_name.as_deref().unwrap_or(""), parts_detail(&parts)]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        let label = if same { format!("{label} in this Project") } else { label };
        let mut divider = Self::new(label, Some(IconName::Link04), parts);
        let summary = raw.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let body = summary.trim().trim_start_matches("<linked_worktrees>").trim_end_matches("</linked_worktrees>").trim();
        if !body.is_empty() {
            divider.brief = Some(Brief { title: "Linked summary".into(), body: body.to_string().into() });
        }
        divider
    }

    /// The divider a typed context kind draws, or `None` for a kind that is not one.
    pub fn from_context(context: &ChatContext, brief: Option<&str>) -> Option<Self> {
        Some(match context {
            ChatContext::Handoff { from, to, from_model, to_model, status } => {
                Self::handoff(*from, *to, from_model.as_ref(), to_model.as_ref(), *status, brief)
            }
            ChatContext::Compaction { status, before, after, .. } => Self::compaction(*status, *before, *after),
            ChatContext::Reload => Self::reload(),
            ChatContext::AccountSwitch { label, .. } => Self::account_switch(label),
            ChatContext::LimitReset => Self::limit_reset(),
            ChatContext::RoutineRun { label, at, quiet, .. } => Self::routine_run(label.as_deref(), *at, *quiet),
            ChatContext::Other { kind, raw } => match kind.as_ref() {
                "babysit-stopped" => Self::babysit_stopped(raw),
                "checkpoint-restore" => Self::checkpoint_restore(raw),
                "worktree-linked" => Self::worktree_link(raw),
                _ => return None,
            },
            _ => return None,
        })
    }
}

/// The detail text of a Worktree link's parts, for its label.
fn parts_detail(parts: &[Part]) -> &str {
    parts.iter().find_map(|part| if let Part::Mono(detail) = part { Some(detail.as_ref()) } else { None }).unwrap_or("")
}

impl Transcript {
    pub(super) fn divider(&mut self, ix: usize, divider: &Divider, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let plain = divider.icon.is_none() && !divider.preparing;
        let rule = || div().h(px(1.0)).flex_1().bg(theme.line);
        let openable = divider.brief.is_some();
        let mut centre = div().flex().min_w_0().items_center().gap(px(6.0));
        if divider.preparing {
            centre = centre.child(SpinnerRing::new().size(12.0).color(theme.ink3));
        } else if let Some(icon) = divider.icon {
            centre = centre.child(Icon::new(icon).size(IconSize::S12).color(theme.ink3));
        }
        for (n, part) in divider.parts.iter().enumerate() {
            centre = centre.child(part_element(part, theme, (ix, n)));
        }
        let button = div()
            .id(ElementId::from((SharedString::from("divider-open"), ix)))
            .flex()
            .min_w_0()
            .items_center()
            .h(px(24.0))
            .px_2()
            .mx(px(-8.0))
            .rounded(RADIUS_CONTROL)
            .when(openable, |el| {
                let brief = divider.brief.clone();
                el.cursor_pointer().hover(|s| s.bg(theme.hover).text_color(theme.ink)).on_click(cx.listener(
                    move |this, _: &ClickEvent, _window, cx| {
                        if let Some(brief) = brief.clone() {
                            this.viewer = Some(Viewer::Text { title: brief.title, body: brief.body });
                            cx.notify();
                        }
                    },
                ))
            })
            .child(centre);
        div()
            .debug_selector(move || format!("divider-{ix}"))
            .flex()
            .w_full()
            .items_center()
            .gap_3()
            .py(px(if plain { 4.0 } else { 6.0 }))
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child(rule())
            .child(button)
            .child(rule())
            .into_any_element()
    }
}

fn part_element(part: &Part, theme: &Theme, key: (usize, usize)) -> AnyElement {
    match part {
        Part::Text(t) => div().flex_none().child(t.clone()).into_any_element(),
        Part::Strong(t) => {
            div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(t.clone()).into_any_element()
        }
        Part::Mono(t) => div().min_w_0().truncate().font_family(mono()).text_step(TEXT_11).child(t.clone()).into_any_element(),
        Part::Warn(t) => div().flex_none().text_color(theme.orange_ink).child(t.clone()).into_any_element(),
        Part::Logo(provider) => ProviderLogo::new(*provider).size(12.0).into_any_element(),
        Part::Avatar(name) => ProjectAvatar::new(name).size(16.0).into_any_element(),
        Part::Action(t) => div()
            .id(ElementId::from((SharedString::from("divider-action"), key.0)))
            .flex_none()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.accent_ink)
            .child(t.clone())
            .into_any_element(),
    }
}
