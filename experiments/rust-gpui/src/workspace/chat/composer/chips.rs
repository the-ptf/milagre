//! The atomic chips inside the prompt (`PromptChip.tsx`): skills, files, Chats, computers and images. A chip is an
//! inline token of gpui-component's text area whose text is the prompt's own source text (`/tldr`,
//! `@src/app.rs`, `@chat:12`, `@computer:Santo`, `[Image #1]`), so selecting and copying it gives that text; the
//! token's id says which kind it is and its label what it shows.

use gpui::{
    AnyElement, App, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Rgba, Styled as _, Window, div, px, rgb,
};
use gpui_component::input::{InlineToken, InlineTokenContext};

use super::mentions::MentionSource;
use super::{PROMPT_LINE_HEIGHT, prompt_text_size};
use crate::logic::files::file_kinds::{IMAGE_COLOR, file_kind};
use crate::logic::prompts::parts::{PromptPart, image_label, skill_label};
use crate::theme::{ActiveTheme, RADIUS_CHIP, RADIUS_INLINE, Theme};
use crate::ui::{Icon, IconName, IconSize};

/// A chip's text against the prompt's (DESIGN.md "Type": prompt chip labels are 0.875em on both platforms).
pub const CHIP_EM: f32 = 0.875;
/// The file-type badge letters against the chip's text (`text-[0.62em]` in `FileKindIcon`).
const BADGE_EM: f32 = 0.62;
/// `CHIP`'s `px-1.5` and `gap-1`; the badge's `px-0.5`.
const CHIP_PAD_X: Pixels = px(6.0);
const CHIP_GAP: Pixels = px(4.0);
const BADGE_PAD_X: Pixels = px(2.0);
/// The skill chip's border is the accent at 40% (`border-accent/40`); the file badge's fill its colour at 16%.
const SKILL_BORDER_ALPHA: f32 = 0.4;
const BADGE_FILL_ALPHA: f32 = 0.16;

/// What a chip stands for. It travels in the token's id, so the renderer needs nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChipKind {
    Skill(String),
    File(String),
    Chat(u64),
    Computer { name: String, online: bool },
    Image(u64),
}

impl ChipKind {
    pub fn token_id(&self) -> String {
        match self {
            ChipKind::Skill(name) => format!("skill:{name}"),
            ChipKind::File(path) => format!("file:{path}"),
            ChipKind::Chat(id) => format!("chat:{id}"),
            ChipKind::Computer { name, online: true } => format!("computer:{name}"),
            ChipKind::Computer { name, online: false } => format!("computer-offline:{name}"),
            ChipKind::Image(index) => format!("image:{index}"),
        }
    }

    pub fn from_token_id(id: &str) -> Option<Self> {
        let (kind, rest) = id.split_once(':')?;
        Some(match kind {
            "skill" => ChipKind::Skill(rest.into()),
            "file" => ChipKind::File(rest.into()),
            "chat" => ChipKind::Chat(rest.parse().ok()?),
            "computer" => ChipKind::Computer { name: rest.into(), online: true },
            "computer-offline" => ChipKind::Computer { name: rest.into(), online: false },
            "image" => ChipKind::Image(rest.parse().ok()?),
            _ => return None,
        })
    }

    /// A short name for selectors and tests.
    pub fn name(&self) -> &'static str {
        match self {
            ChipKind::Skill(_) => "skill",
            ChipKind::File(_) => "file",
            ChipKind::Chat(_) => "chat",
            ChipKind::Computer { .. } => "computer",
            ChipKind::Image(_) => "image",
        }
    }
}

/// The token a prompt part shows as, `None` for text. Labels as `PromptEditor.tsx` renders each chip: a skill's
/// title-cased name, a file's last path segment, the Chat's title ("Chat" when it is not listed), the computer's
/// name (dimmed when it is offline), "Image #N".
pub fn token_for(part: &PromptPart, source: &dyn MentionSource) -> Option<InlineToken> {
    let (kind, label) = match part {
        PromptPart::Text { .. } => return None,
        PromptPart::Skill { name, .. } => (ChipKind::Skill(name.clone()), skill_label(name)),
        PromptPart::File { path, .. } => {
            let name = path.rsplit('/').find(|segment| !segment.is_empty()).unwrap_or(path);
            (ChipKind::File(path.clone()), name.to_string())
        }
        PromptPart::Chat { id, .. } => {
            let title = source.chats().iter().find(|chat| chat.id == *id).map(|chat| chat.title.clone());
            (ChipKind::Chat(*id), title.filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "Chat".into()))
        }
        PromptPart::Computer { name, .. } => {
            let known = source.computers().iter().find(|computer| computer.name.to_lowercase() == name.to_lowercase());
            (ChipKind::Computer { name: name.clone(), online: known.is_none_or(|computer| computer.online) }, name.clone())
        }
        PromptPart::Image { index, .. } => (ChipKind::Image(*index), image_label(*index)),
    };
    // A token's text and label may hold no control characters; a label that does falls back to the source text.
    let label: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    Some(InlineToken::new(kind.token_id(), part.text().to_string()).with_label(label))
}

fn hex(color: &str) -> Rgba {
    rgb(u32::from_str_radix(color.trim_start_matches('#'), 16).unwrap_or(0x8a8f98))
}

fn with_alpha(color: Rgba, alpha: f32) -> Rgba {
    Rgba { a: color.a * alpha, ..color }
}

/// The file's type, as `FileKindIcon` draws it: badge letters for common languages, else an icon, in the type's
/// identity colour.
fn file_kind_mark(path: &str, chip_text: Pixels) -> AnyElement {
    let kind = file_kind(path);
    let color = hex(kind.color);
    if let Some(badge) = kind.badge {
        return div()
            .flex_none()
            .px(BADGE_PAD_X)
            .rounded(RADIUS_INLINE)
            .bg(with_alpha(color, BADGE_FILL_ALPHA))
            .text_size(chip_text * BADGE_EM)
            .line_height(gpui::relative(1.4))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(color)
            .child(badge)
            .into_any_element();
    }
    let icon = match kind.icon {
        Some("react") => IconName::React,
        Some("image") => IconName::Image01,
        Some("folder") => IconName::Folder01,
        _ => IconName::File01,
    };
    Icon::new(icon).size(IconSize::S12).color(color).into_any_element()
}

/// The chip element for one token (`Textarea::token`). Every chip is one box (`CHIP`): 0.875em text on its own
/// line height, a 1px border, `rounded-chip`, 6px in and a 4px gap to its 12px glyph; it fills the prompt's
/// line less a pixel above and below, so it never grows the line.
pub fn render_chip(context: &InlineTokenContext, _window: &mut Window, cx: &mut App) -> AnyElement {
    let theme: Theme = *cx.theme();
    let token = context.token();
    let kind = ChipKind::from_token_id(token.id()).unwrap_or(ChipKind::File(token.text().to_string()));
    let text_size = px(prompt_text_size() * CHIP_EM);
    let (border, fill, ink) = match &kind {
        ChipKind::Skill(_) => (with_alpha(theme.accent, SKILL_BORDER_ALPHA), theme.accent_tint, theme.accent_ink),
        ChipKind::Computer { online: false, .. } => (theme.line_strong, theme.hover, theme.ink3),
        _ => (theme.line_strong, theme.hover, theme.ink),
    };
    // Selected with the text around it: the chip takes the selection's fill, as the text does.
    let fill = if context.is_selected() { theme.accent_tint } else { fill };
    let mark = match &kind {
        ChipKind::Skill(_) => Icon::new(IconName::MagicWand01).size(IconSize::S12).color(ink).into_any_element(),
        ChipKind::File(path) => file_kind_mark(path, text_size),
        ChipKind::Chat(_) => Icon::new(IconName::BubbleChat).size(IconSize::S12).color(ink).into_any_element(),
        ChipKind::Computer { .. } => Icon::new(IconName::Computer).size(IconSize::S12).color(ink).into_any_element(),
        ChipKind::Image(_) => Icon::new(IconName::Image01).size(IconSize::S12).color(hex(IMAGE_COLOR)).into_any_element(),
    };
    let selector = format!("prompt-chip-{}-{}", kind.name(), context.range().start);
    let height = context.line_height().min(px(PROMPT_LINE_HEIGHT)) - px(2.0);
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .gap(CHIP_GAP)
        .h(height)
        .max_w(context.available_width())
        .px(CHIP_PAD_X)
        .rounded(RADIUS_CHIP)
        .border_1()
        .border_color(border)
        .bg(fill)
        .text_size(text_size)
        .line_height(gpui::relative(1.35))
        .text_color(ink)
        .whitespace_nowrap()
        .child(mark)
        .child(div().min_w_0().truncate().child(token.label().clone()))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::chat::composer::mentions::FixtureMentions;

    #[test]
    fn a_chip_kind_survives_its_token_id() {
        for kind in [
            ChipKind::Skill("plugin:review-code".into()),
            ChipKind::File("my app/a:b.ts".into()),
            ChipKind::Chat(12),
            ChipKind::Computer { name: "Victor's MacBook".into(), online: false },
            ChipKind::Computer { name: "Santo".into(), online: true },
            ChipKind::Image(3),
        ] {
            assert_eq!(ChipKind::from_token_id(&kind.token_id()), Some(kind));
        }
        assert_eq!(ChipKind::from_token_id("nothing"), None);
    }

    #[test]
    fn each_part_gets_the_label_promptchip_draws() {
        let source = FixtureMentions::default();
        let label = |part: PromptPart| token_for(&part, &source).map(|token| token.label().to_string());
        assert_eq!(
            label(PromptPart::Skill { text: "/frontend-design".into(), name: "frontend-design".into() }).as_deref(),
            Some("Frontend Design")
        );
        assert_eq!(label(PromptPart::File { text: "@src/app.rs".into(), path: "src/app.rs".into() }).as_deref(), Some("app.rs"));
        assert_eq!(label(PromptPart::Chat { text: "@chat:12".into(), id: 12, start: 0 }).as_deref(), Some("Port the composer to GPUI"));
        assert_eq!(label(PromptPart::Chat { text: "@chat:404".into(), id: 404, start: 0 }).as_deref(), Some("Chat"));
        assert_eq!(label(PromptPart::Image { text: "[Image #2]".into(), index: 2 }).as_deref(), Some("Image #2"));
        assert_eq!(label(PromptPart::Text { text: "plain".into() }), None);
        let offline =
            token_for(&PromptPart::Computer { text: "@computer:\"Victor's MacBook\"".into(), name: "Victor's MacBook".into() }, &source);
        assert_eq!(offline.map(|token| token.id().to_string()).as_deref(), Some("computer-offline:Victor's MacBook"));
    }
}
