//! Turning a frame's payload into something GPUI paints. PNG and JPEG (the frame relay) decode with the `image`
//! crate and are turned to the on-screen orientation here, because GPUI's `img()` has no rotation; the result
//! is a BGRA [`RenderImage`]. H.264 (`video/avcc`, Simlock leases) is not decoded in this port: see the README
//! of `simulator/mod.rs` for what a VideoToolbox decoder would take.

use std::sync::Arc;

use gpui::RenderImage;
use image::{Frame, ImageFormat, RgbaImage, imageops};

use super::types::FrameData;

/// The largest payload the receiver accepts (`2796204` base64 characters, about 2 MiB of bytes).
pub const MAX_FRAME_BYTES: usize = 2_097_152;

/// A decoded frame, ready to paint, and the turn it was decoded for.
#[derive(Clone)]
pub struct Picture {
    pub image: Arc<RenderImage>,
    pub rotation: i32,
}

/// Decodes `data` and turns it by `rotation` degrees (0, 90, -90 or 180, clockwise like CSS `rotate`).
pub fn decode(data: &FrameData, rotation: i32) -> anyhow::Result<Picture> {
    let format = match data {
        FrameData::Png(_) => ImageFormat::Png,
        FrameData::Jpeg(_) => ImageFormat::Jpeg,
        FrameData::Avcc(_) => anyhow::bail!("This viewer cannot decode simulator video yet. Watch it from the Milagre desktop app."),
    };
    anyhow::ensure!(data.bytes().len() <= MAX_FRAME_BYTES, "Invalid simulator frame data.");
    let rgba = image::load_from_memory_with_format(data.bytes(), format)
        .map_err(|_| anyhow::anyhow!("The simulator frame could not be displayed."))?
        .into_rgba8();
    Ok(Picture { image: Arc::new(RenderImage::new([Frame::new(to_bgra(turn(rgba, rotation)))])), rotation })
}

/// The capture turned for the screen: what CSS `rotate(<rotation>deg)` shows.
pub fn turn(image: RgbaImage, rotation: i32) -> RgbaImage {
    match rotation {
        90 => imageops::rotate90(&image),
        -90 => imageops::rotate270(&image),
        180 => imageops::rotate180(&image),
        _ => image,
    }
}

/// GPUI's sprite atlas takes BGRA.
fn to_bgra(mut image: RgbaImage) -> RgbaImage {
    for pixel in image.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    image
}
