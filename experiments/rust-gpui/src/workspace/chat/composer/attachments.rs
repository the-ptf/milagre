//! The attachments tray above the prompt (`Attachments.tsx`, `usePastedImages.ts`): a tile per image and per file, in
//! the order they were added, with a remove button on each corner and a `#n` badge on images.
//!
//! - An image is numbered by its place among the images (1-based): that number is the `[Image #N]` chip in the
//!   prompt. Removing image N removes its chip and renumbers the ones after it; deleting the chip removes the
//!   image (`Composer::text_changed`), the same both ways.
//! - Tiles are the transcript's (WP-23): an 80px image contained in a `rounded-control` tile on `inset` with a
//!   `line` border and 4px padding, its name under it (11px, at most 112 wide); a file is an 80px square with a
//!   file icon, its extension and its name, whose tooltip is the path.
//! - Limits and errors are React's: PNG, JPEG, WebP and GIF for images, 50 MiB for any attachment. Nothing is
//!   uploaded: an attachment is its path (or, for a pasted image, its bytes) and stays in memory.
//! - Not built: upload progress and cancel (nothing uploads), the offline placeholder, the text and markdown
//!   preview dialog. A tile click emits [`ComposerAttachment::OpenImage`] or [`ComposerAttachment::OpenFile`].

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, Image, ImageFormat, ImageSource, ObjectFit, PathPromptOptions, RenderImage,
    SharedString, Window, div, img, prelude::*, px,
};

use super::send::{OutgoingAttachment, OutgoingImage};
use super::{Composer, ComposerAttachment};
use crate::logic::prompts::mentions::shift_image_mentions;
use crate::theme::{RADIUS_CONTROL, RADIUS_INLINE, TEXT_10, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, Tooltip};
use crate::workspace::chat::transcript::cards::images::THUMB;

/// `MAX_ATTACHMENT_BYTES`: 50 MiB.
pub const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
/// `IMAGE_ERRORS.type` and `.size`.
pub const ERROR_TYPE: &str = "Use PNG, JPEG, WebP, or GIF images.";
pub const ERROR_SIZE: &str = "Each image must be 50 MiB or smaller.";
pub const ERROR_PASTE: &str = "Could not read the pasted image. Try again.";

#[derive(Clone)]
pub enum AttachmentKind {
    /// Numbered by its place among the images; `decoded` is `None` when the picture could not be decoded.
    Image {
        decoded: Option<Arc<RenderImage>>,
    },
    File,
}

#[derive(Clone)]
pub struct Attachment {
    pub id: u64,
    pub name: SharedString,
    pub path: Option<PathBuf>,
    pub bytes: u64,
    pub kind: AttachmentKind,
    /// A pasted image's own bytes.
    pub source: Option<Image>,
}

impl Attachment {
    pub fn is_image(&self) -> bool {
        matches!(self.kind, AttachmentKind::Image { .. })
    }
}

/// The attachments of the draft, oldest first, and the last error.
#[derive(Clone, Default)]
pub struct Tray {
    items: Vec<Attachment>,
    next_id: u64,
    error: Option<SharedString>,
}

impl Tray {
    pub fn items(&self) -> &[Attachment] {
        &self.items
    }

    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn image_count(&self) -> usize {
        self.items.iter().filter(|item| item.is_image()).count()
    }

    pub fn file_count(&self) -> usize {
        self.items.len() - self.image_count()
    }

    /// The 1-based number of the image `id`.
    pub fn image_number(&self, id: u64) -> Option<u64> {
        let mut n = 0;
        for item in &self.items {
            if item.is_image() {
                n += 1;
            }
            if item.id == id {
                return item.is_image().then_some(n);
            }
        }
        None
    }

    /// The id of image `number` (1-based).
    fn image_id(&self, number: u64) -> Option<u64> {
        self.items.iter().filter(|item| item.is_image()).nth(number.checked_sub(1)? as usize).map(|item| item.id)
    }

    fn push(&mut self, name: SharedString, path: Option<PathBuf>, bytes: u64, kind: AttachmentKind, source: Option<Image>) -> u64 {
        self.next_id += 1;
        self.items.push(Attachment { id: self.next_id, name, path, bytes, kind, source });
        self.next_id
    }

    /// Takes image `number` out without touching the prompt (its chip is already gone).
    pub fn remove_image_number(&mut self, number: u64) -> bool {
        match self.image_id(number) {
            Some(id) => {
                self.items.retain(|item| item.id != id);
                true
            }
            None => false,
        }
    }

    /// Puts attachments back (Edit on a queued message) under new ids, in their order.
    pub fn restore(&mut self, items: Vec<Attachment>) {
        for item in items {
            self.push(item.name, item.path, item.bytes, item.kind, item.source);
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.error = None;
    }

    pub fn set_error(&mut self, error: Option<SharedString>) {
        self.error = error;
    }

    /// The images and files as a message carries them.
    pub fn outgoing(&self) -> (Vec<OutgoingImage>, Vec<OutgoingAttachment>) {
        let mut images = Vec::new();
        let mut files = Vec::new();
        for item in &self.items {
            if item.is_image() {
                images.push(OutgoingImage { index: images.len() as u64 + 1, name: item.name.clone(), path: item.path.clone() });
            } else {
                files.push(OutgoingAttachment { name: item.name.clone(), path: item.path.clone() });
            }
        }
        (images, files)
    }
}

fn allowed_image(format: ImageFormat) -> bool {
    matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Webp | ImageFormat::Gif)
}

fn extension_format(path: &Path) -> Option<ImageFormat> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "webp" => Some(ImageFormat::Webp),
        "gif" => Some(ImageFormat::Gif),
        _ => None,
    }
}

fn format_extension(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Webp => "webp",
        ImageFormat::Gif => "gif",
        _ => "png",
    }
}

fn file_name(path: &Path) -> SharedString {
    path.file_name().map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned()).into()
}

fn decode(image: &Image, cx: &mut gpui::App) -> Option<Arc<RenderImage>> {
    image.to_image_data(cx.svg_renderer()).ok()
}

impl Composer {
    /// The tray's items, oldest first.
    pub fn attachments(&self) -> &[Attachment] {
        self.tray.items()
    }

    pub fn attachment_error(&self) -> Option<&SharedString> {
        self.tray.error()
    }

    /// The Attach button: the platform's file prompt, whose answer goes to [`Composer::attach_paths`].
    pub fn open_file_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await {
                this.update_in(cx, |this, window, cx| {
                    let at = this.selected_range();
                    this.attach_paths(paths, at, window, cx);
                })
                .ok();
            }
        })
        .detach();
    }

    /// Files chosen, dropped or pasted: an image file becomes an image (and its `[Image #N]` goes into the prompt at
    /// `at`), anything else a file tile. A path already attached is not added twice. Returns the new images' numbers.
    pub fn attach_paths(&mut self, paths: Vec<PathBuf>, at: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<u64> {
        self.tray.error = None;
        let mut numbers = Vec::new();
        let mut error = None;
        for path in paths {
            if self.tray.items.iter().any(|item| item.path.as_deref() == Some(path.as_path())) {
                continue;
            }
            let name = file_name(&path);
            let Ok(meta) = std::fs::metadata(&path) else {
                error = Some(format!("Could not read {name}. Choose it again with Attach files."));
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if meta.len() > MAX_ATTACHMENT_BYTES {
                error =
                    Some(if extension_format(&path).is_some() { ERROR_SIZE.to_string() } else { format!("{name} is larger than 50 MiB.") });
                continue;
            }
            match extension_format(&path) {
                Some(format) => {
                    let Ok(bytes) = std::fs::read(&path) else {
                        error = Some(format!("Could not read {name}. Choose it again with Attach files."));
                        continue;
                    };
                    let decoded = decode(&Image::from_bytes(format, bytes), cx);
                    self.tray.push(name, Some(path), meta.len(), AttachmentKind::Image { decoded }, None);
                    numbers.push(self.tray.image_count() as u64);
                }
                None => {
                    self.tray.push(name, Some(path), meta.len(), AttachmentKind::File, None);
                }
            }
        }
        self.tray.error = error.map(Into::into);
        self.attached(numbers, at, window, cx)
    }

    /// Images on the clipboard: all of one allowed type and size, or none of them (React's all-or-nothing check).
    pub fn attach_pasted(&mut self, images: Vec<Image>, at: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<u64> {
        self.tray.error = None;
        if images.is_empty() {
            return Vec::new();
        }
        if images.iter().any(|image| !allowed_image(image.format)) {
            self.tray.error = Some(ERROR_TYPE.into());
            cx.notify();
            return Vec::new();
        }
        if images.iter().any(|image| image.bytes.len() as u64 > MAX_ATTACHMENT_BYTES) {
            self.tray.error = Some(ERROR_SIZE.into());
            cx.notify();
            return Vec::new();
        }
        let mut decoded_all = Vec::new();
        for image in &images {
            match decode(image, cx) {
                Some(decoded) => decoded_all.push(decoded),
                None => {
                    self.tray.error = Some(ERROR_PASTE.into());
                    cx.notify();
                    return Vec::new();
                }
            }
        }
        let mut numbers = Vec::new();
        for (image, decoded) in images.into_iter().zip(decoded_all) {
            let name: SharedString = format!("image.{}", format_extension(image.format)).into();
            let bytes = image.bytes.len() as u64;
            self.tray.push(name, None, bytes, AttachmentKind::Image { decoded: Some(decoded) }, Some(image));
            numbers.push(self.tray.image_count() as u64);
        }
        self.attached(numbers, at, window, cx)
    }

    /// After images joined the tray: the prompt's image count follows, and their chips go in at `at`.
    fn attached(&mut self, numbers: Vec<u64>, at: Range<usize>, window: &mut Window, cx: &mut Context<Self>) -> Vec<u64> {
        self.image_count = self.tray.image_count();
        if numbers.is_empty() {
            cx.notify();
        } else {
            self.insert_image_mentions(&numbers, at, window, cx);
        }
        numbers
    }

    /// A tile's remove button: the attachment goes, and for an image so does its chip, renumbering the rest.
    pub fn remove_attachment(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let number = self.tray.image_number(id);
        self.tray.items.retain(|item| item.id != id);
        self.tray.error = None;
        if let Some(number) = number {
            self.image_count = self.tray.image_count();
            let value = self.editor.as_ref().map(|editor| editor.value().to_string()).unwrap_or_default();
            let shifted = shift_image_mentions(&value, number);
            if shifted != value {
                let caret = self.selected_range().start.min(shifted.len());
                let caret = (0..=caret).rev().find(|at| shifted.is_char_boundary(*at)).unwrap_or(0);
                self.put(shifted, caret..caret, Some(super::EditKind::Other), window, cx);
            } else {
                self.resync(window, cx);
            }
            cx.emit(ComposerAttachment::ImageRemoved(number));
        }
        cx.notify();
    }

    pub(super) fn render_tray(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.tray.is_empty() && self.tray.error().is_none() {
            return None;
        }
        let mut tiles = div().debug_selector(|| "composer-tray".into()).flex().flex_wrap().items_start().gap_2().px_1();
        let mut image_no = 0;
        for (ix, item) in self.tray.items().iter().enumerate() {
            let number = item.is_image().then(|| {
                image_no += 1;
                image_no
            });
            tiles = tiles.child(tile(ix, item, number, theme, cx));
        }
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .when(!self.tray.is_empty(), |el| el.child(tiles))
                .when_some(self.tray.error().cloned(), |el, error| {
                    el.child(
                        div()
                            .debug_selector(|| "composer-attachment-error".into())
                            .px_2()
                            .text_step(TEXT_12)
                            .text_color(theme.red_ink)
                            .child(error),
                    )
                })
                .into_any_element(),
        )
    }
}

fn tile(ix: usize, item: &Attachment, number: Option<u64>, theme: &Theme, cx: &mut Context<Composer>) -> AnyElement {
    let id = item.id;
    let name = item.name.clone();
    let picture: AnyElement = match &item.kind {
        AttachmentKind::Image { decoded: Some(decoded) } => div()
            .flex()
            .flex_col()
            .child(
                img(ImageSource::Render(decoded.clone())).size(px(THUMB)).flex_none().object_fit(ObjectFit::Contain).rounded(RADIUS_INLINE),
            )
            .child(div().max_w(px(112.0)).px_1().truncate().text_step(TEXT_11).text_color(theme.ink2).child(name.clone()))
            .into_any_element(),
        AttachmentKind::Image { decoded: None } => div()
            .flex()
            .flex_col()
            .child(
                div()
                    .size(px(THUMB))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(RADIUS_INLINE)
                    .bg(theme.field)
                    .text_step(TEXT_11)
                    .text_color(theme.ink2)
                    .child("Image unavailable"),
            )
            .child(div().max_w(px(112.0)).px_1().truncate().text_step(TEXT_11).text_color(theme.ink2).child(name.clone()))
            .into_any_element(),
        AttachmentKind::File => {
            let extension = Path::new(name.as_ref()).extension().map(|ext| ext.to_string_lossy().into_owned());
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .size(px(THUMB))
                        .flex_none()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .rounded(RADIUS_INLINE)
                        .bg(theme.surface)
                        .text_color(theme.ink2)
                        .child(Icon::new(IconName::File01).size(IconSize::S18).color(theme.ink2))
                        .when_some(extension, |el, extension| {
                            el.child(div().max_w(px(64.0)).truncate().text_step(TEXT_11).font_weight(FontWeight::MEDIUM).child(extension))
                        }),
                )
                .child(div().max_w(px(THUMB)).px_1().truncate().text_center().text_step(TEXT_11).text_color(theme.ink2).child(name.clone()))
                .into_any_element()
        }
    };
    let tip = item.path.as_ref().map_or_else(|| name.to_string(), |path| path.display().to_string());
    let open = {
        let image = item.is_image();
        let path = item.path.clone();
        cx.listener(move |_, _: &ClickEvent, _, cx| match (image, number, &path) {
            (true, Some(number), _) => cx.emit(ComposerAttachment::OpenImage(number)),
            (false, _, Some(path)) => cx.emit(ComposerAttachment::OpenFile(path.clone())),
            _ => {}
        })
    };
    let remove = cx.listener(move |this, _: &ClickEvent, window, cx| this.remove_attachment(id, window, cx));
    div()
        .debug_selector(move || format!("attachment-tile-{ix}"))
        .relative()
        .max_w_full()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .p_1()
        .child(
            div()
                .id(ElementId::from((SharedString::from("attachment-open"), ix)))
                .cursor_pointer()
                .tooltip(Tooltip::text(tip))
                .on_click(open)
                .child(picture),
        )
        .when_some(number, |el, number| {
            el.child(
                div()
                    .debug_selector(move || format!("attachment-badge-{ix}"))
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
                    .child(format!("#{number}")),
            )
        })
        .child(
            div()
                .id(ElementId::from((SharedString::from("attachment-remove"), ix)))
                .debug_selector(move || format!("attachment-remove-{ix}"))
                .absolute()
                .top(px(-4.0))
                .right(px(-4.0))
                .flex()
                .items_center()
                .justify_center()
                .size(px(20.0))
                .rounded_full()
                .border_1()
                .border_color(theme.line)
                .bg(theme.surface)
                .cursor_pointer()
                .hover(|style| style.bg(theme.hover))
                .on_click(remove)
                .child(Icon::new(IconName::Cancel01).size(IconSize::S12).color(theme.ink)),
        )
        .into_any_element()
}
