//! Images in the transcript: attachment tiles on the user's message (`Attachments.tsx`), the strip of images a
//! reply viewed (`ViewedImages.tsx`), an image the agent generated (`GeneratedImage.tsx`), and the viewer they open.
//!
//! Sizing, as the app has it: an attachment is a tile (`rounded-control`, `line` border, `inset` fill, 4px padding)
//! around an 80px image contained in it with its name under it (11px, at most 112px wide) and a `#n` badge on its
//! corner; a viewed image is an 80px square, cover-fit, `rounded-control` on `field`, in a row 8px apart; a
//! generated image is at most 320px wide, `rounded-card`, at its own aspect (square until it has loaded), with
//! Copy and Download over its corner while hovered. A failed generation is a failed tool row.
//!
//! Images are decoded on the first frame that needs them and kept (`Transcript::images`). That is synchronous: a
//! real adapter decodes on a background thread. The viewer is an overlay over the transcript's own box: a scrim,
//! the image contained in it, a Close button and the name. The app's lightbox (zoom 1 to 4, pan, swipe between
//! items, the morph out of the thumbnail) is not built; [`Viewer`] is its seam.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, ImageFormat, ImageSource, ObjectFit, RenderImage, SharedString, div, img,
    prelude::*, px, relative,
};

use super::super::Transcript;
use super::super::step_row::{self, StepRow};
use crate::data::{ChatStep, StepStatus};
use crate::theme::{RADIUS_CARD, RADIUS_CONTROL, RADIUS_INLINE, RADIUS_WINDOW, TEXT_10, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, IconButton, IconButtonSize, IconName};

/// A thumbnail's image box: `size-20`.
pub const THUMB: f32 = 80.0;
/// A generated image's largest width: `max-w-80`.
pub const GENERATED_MAX_WIDTH: f32 = 320.0;

#[derive(Clone, Debug, PartialEq)]
pub struct ImageRef {
    pub name: SharedString,
    /// The file on this computer; `None` for one that could not be found.
    pub path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StripKind {
    /// Under the user's words: tiles with a name and a number.
    Attachments,
    /// Under a reply that read image files: bare squares.
    Viewed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageStrip {
    pub kind: StripKind,
    pub images: Vec<ImageRef>,
}

/// An image step (`StepKind::Image`): its file once saved, and the prompt that made it.
#[derive(Clone, Debug, PartialEq)]
pub struct GeneratedImage {
    pub step: ChatStep,
    pub path: Option<PathBuf>,
}

impl GeneratedImage {
    pub fn new(step: ChatStep) -> Self {
        let path = step.file.as_ref().map(|file| PathBuf::from(file.as_ref()));
        Self { step, path }
    }
}

/// A decoded image and its size in pixels.
#[derive(Clone)]
pub struct Decoded {
    pub image: Arc<RenderImage>,
    pub width: u32,
    pub height: u32,
}

/// What the overlay shows.
#[derive(Clone)]
pub enum Viewer {
    Image {
        name: SharedString,
        image: Decoded,
    },
    /// A brief (a handoff's, a Link's summary): the app opens it in a dialog.
    Text {
        title: SharedString,
        body: SharedString,
    },
}

fn format_of(path: &Path) -> Option<ImageFormat> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::Webp),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

/// Whether a path names an image file (`mediaKind` in `lib/media.ts`, the image extensions).
pub fn is_image_path(path: &str) -> bool {
    format_of(Path::new(path)).is_some()
}

impl Transcript {
    /// The decoded image at `path`, decoded on first use and kept; `None` when it cannot be read or decoded.
    pub(in crate::workspace::chat::transcript) fn decoded(&mut self, path: &Path, cx: &mut Context<Self>) -> Option<Decoded> {
        if let Some(known) = self.images.get(path) {
            return known.clone();
        }
        let decoded = format_of(path).and_then(|format| {
            let bytes = std::fs::read(path).ok()?;
            let image = gpui::Image::from_bytes(format, bytes).to_image_data(cx.svg_renderer()).ok()?;
            let size = image.size(0);
            Some(Decoded { width: i32::from(size.width).max(1) as u32, height: i32::from(size.height).max(1) as u32, image })
        });
        self.images.insert(path.to_path_buf(), decoded.clone());
        decoded
    }

    fn open_image(&mut self, name: SharedString, image: Decoded, cx: &mut Context<Self>) {
        self.viewer = Some(Viewer::Image { name, image });
        cx.notify();
    }

    pub(super) fn image_strip(&mut self, ix: usize, strip: &ImageStrip, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let attachments = strip.kind == StripKind::Attachments;
        let mut row = div()
            .debug_selector(move || format!("image-strip-{ix}"))
            .flex()
            .flex_wrap()
            .items_start()
            .gap_2()
            .when(attachments, |el| el.justify_end())
            .max_w_full();
        for (n, image) in strip.images.iter().enumerate() {
            let decoded = image.path.as_deref().and_then(|path| self.decoded(path, cx));
            let name = image.name.clone();
            let open = decoded.clone().map(|decoded| {
                let name = name.clone();
                cx.listener(move |this, _: &ClickEvent, _window, cx| this.open_image(name.clone(), decoded.clone(), cx))
            });
            let fit = if attachments { ObjectFit::Contain } else { ObjectFit::Cover };
            let picture: AnyElement = match &decoded {
                Some(decoded) => img(ImageSource::Render(decoded.image.clone()))
                    .size(px(THUMB))
                    .flex_none()
                    .object_fit(fit)
                    .rounded(if attachments { RADIUS_INLINE } else { RADIUS_CONTROL })
                    .into_any_element(),
                None => div()
                    .size(px(THUMB))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(RADIUS_INLINE)
                    .bg(theme.field)
                    .text_step(TEXT_11)
                    .text_color(theme.ink2)
                    .child("Image unavailable")
                    .into_any_element(),
            };
            let button = div()
                .id(ElementId::from((SharedString::from("image-open"), ix * 1000 + n)))
                .debug_selector(move || format!("image-open-{ix}-{n}"))
                .when(open.is_some(), |el| el.cursor_pointer())
                .when_some(open, |el, open| el.on_click(open))
                .flex()
                .flex_col()
                .child(picture)
                .when(attachments, |el| {
                    el.child(div().max_w(px(112.0)).px_1().truncate().text_step(TEXT_11).text_color(theme.ink2).child(name.clone()))
                });
            row = row.child(if attachments {
                div()
                    .relative()
                    .max_w_full()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.inset)
                    .p_1()
                    .child(button)
                    .child(
                        div()
                            .absolute()
                            .top(px(6.0))
                            .left(px(6.0))
                            .px_1()
                            .py(px(1.0))
                            .rounded(RADIUS_INLINE)
                            .bg(theme.surface)
                            .shadow(theme.shadow_btn())
                            .text_step(TEXT_10)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.ink)
                            .child(format!("#{}", n + 1)),
                    )
                    .into_any_element()
            } else {
                div().rounded(RADIUS_CONTROL).overflow_hidden().bg(theme.field).child(button).into_any_element()
            });
        }
        row.into_any_element()
    }

    pub(super) fn generated_image(&mut self, ix: usize, image: &GeneratedImage, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let step = &image.step;
        let decoded = image.path.as_deref().and_then(|path| self.decoded(path, cx));
        if step.status == StepStatus::Failed || (step.status == StepStatus::Done && decoded.is_none()) {
            let failed = ChatStep {
                status: StepStatus::Failed,
                title: if step.status == StepStatus::Failed { step.title.clone() } else { "Couldn't show the generated image".into() },
                ..step.clone()
            };
            return step_row::row(
                &StepRow {
                    step: &failed,
                    key: (ix, 0),
                    open: false,
                    all_lines: false,
                    waiting: false,
                    now: 0,
                    on_toggle: None,
                    on_all: None,
                },
                theme,
            );
        }
        // Square until the image is known, then its own shape, at most 320px wide.
        let (width, height) = match &decoded {
            Some(d) => {
                let w = (d.width as f32).min(GENERATED_MAX_WIDTH);
                (w, w * d.height as f32 / d.width as f32)
            }
            None => (GENERATED_MAX_WIDTH, GENERATED_MAX_WIDTH),
        };
        let name: SharedString = image
            .path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Generated image".into())
            .into();
        let group: SharedString = format!("generated-image-{ix}").into();
        let action = |id: &'static str, icon: IconName| {
            IconButton::new(ElementId::from((SharedString::from(id), ix)), icon).size(IconButtonSize::S28)
        };
        let frame = div()
            .group(group.clone())
            .relative()
            .w(px(width))
            .max_w_full()
            .h(px(height))
            .rounded(RADIUS_CARD)
            .overflow_hidden()
            .bg(theme.field)
            .child(match decoded.clone() {
                Some(d) => {
                    let open = cx.listener(move |this, _: &ClickEvent, _window, cx| this.open_image(name.clone(), d.clone(), cx));
                    div()
                        .id(ElementId::from((SharedString::from("generated-open"), ix)))
                        .size_full()
                        .cursor_pointer()
                        .on_click(open)
                        .child(
                            img(ImageSource::Render(decoded.as_ref().expect("decoded").image.clone()))
                                .size_full()
                                .object_fit(ObjectFit::Cover),
                        )
                        .into_any_element()
                }
                None => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child("Generating image\u{2026}")
                    .into_any_element(),
            })
            .when(decoded.is_some(), |el| {
                el.child(
                    div()
                        .absolute()
                        .right(px(8.0))
                        .bottom(px(8.0))
                        .flex()
                        .gap_1()
                        .opacity(0.0)
                        .group_hover(group, |s| s.opacity(1.0))
                        .child(action("generated-copy", IconName::Copy01))
                        .child(action("generated-download", IconName::Download04)),
                )
            });
        div().debug_selector(move || format!("generated-image-{ix}")).flex().flex_col().child(frame).into_any_element()
    }

    /// The viewer, drawn over the transcript while one is open.
    pub(in crate::workspace::chat::transcript) fn viewer_overlay(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let viewer = self.viewer.as_ref()?;
        let close = cx.listener(|this, _: &ClickEvent, _window, cx| {
            this.viewer = None;
            cx.notify();
        });
        let close_button = cx.listener(|this, _: &ClickEvent, _window, cx| {
            this.viewer = None;
            cx.notify();
        });
        let close_scrim = cx.listener(|this, _: &ClickEvent, _window, cx| {
            this.viewer = None;
            cx.notify();
        });
        let body: AnyElement = match viewer {
            Viewer::Image { name, image } => div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_2()
                .child(
                    div()
                        .debug_selector(|| "viewer-image".into())
                        .w(relative(0.9))
                        .h(relative(0.82))
                        .child(img(ImageSource::Render(image.image.clone())).size_full().object_fit(ObjectFit::Contain)),
                )
                .child(div().text_step(TEXT_12).text_color(theme.on_ink).child(name.clone()))
                .into_any_element(),
            Viewer::Text { title, body } => div()
                .id("viewer-card")
                .on_click(|_, _, cx| cx.stop_propagation())
                .w(px(560.0))
                .max_w(relative(0.9))
                .max_h(relative(0.8))
                .flex()
                .flex_col()
                .gap_3()
                .p_4()
                .rounded(RADIUS_WINDOW)
                .bg(theme.surface)
                .border_1()
                .border_color(theme.line_strong)
                .shadow(theme.shadow_raised())
                .child(div().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title.clone()))
                .child(div().id("viewer-text").overflow_y_scroll().text_step(TEXT_13).text_color(theme.ink).child(body.clone()))
                .child(div().flex().justify_end().child(
                    Button::new("viewer-close", "Close").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(close_button),
                ))
                .into_any_element(),
        };
        Some(
            div()
                .id("viewer")
                .debug_selector(|| "viewer".into())
                .absolute()
                .inset_0()
                // The full-size viewer owns the pointer: the transcript under it neither scrolls nor hovers.
                .occlude()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.scrim)
                .on_click(close_scrim)
                .child(body)
                .child(
                    div()
                        .absolute()
                        .top(px(12.0))
                        .right(px(12.0))
                        .child(IconButton::new("viewer-close-x", IconName::Cancel01).size(IconButtonSize::S32).on_click(close)),
                )
                .into_any_element(),
        )
    }
}
