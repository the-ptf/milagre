// Backdrop blur for the Metal renderer: a marked quad blurs what is already drawn behind it, then draws on top as
// a tint (CSS `backdrop-filter: blur()`).
//
// Ported from MonoCode (https://github.com/hardbeat920/monocode) at commit
// 7e5a9e3690d5b96a7d93ebf884397835e57b9b7e: `vendor/gpui-pre/src/scene.rs` (the marker) and
// `vendor/gpui-pre-apple/src/metal_renderer.rs` (`blur_backdrop`, `gaussian_kernel`,
// `build_backdrop_pipeline_state`), rewritten from metal-rs onto gpui-pre-apple 0.3.12's objc2-metal API, with a
// per-size scratch cache, a half-float blur target, the tint and grain applied in the composite and a dither on its
// 8-bit output. Modified for milagre-gpui-spike; see vendor/PATCHES.md.
//
// MIT License
//
// Copyright (c) 2026 Nick
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// The surrounding renderer is GPUI's (Copyright 2022 - 2025 Zed Industries, Inc., Apache-2.0, LICENSE-APACHE).

use anyhow::{Context as _, Result};
use gpui::{DevicePixels, Hsla, Quad, Rgba, Size};
use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, ProtocolObject},
};
use objc2_foundation::NSString;
use objc2_metal::{
    MTLBlitCommandEncoder, MTLCommandBuffer, MTLCommandEncoder, MTLDevice, MTLLibrary, MTLOrigin,
    MTLPixelFormat, MTLPrimitiveType, MTLRenderCommandEncoder, MTLRenderPipelineDescriptor,
    MTLRenderPipelineState, MTLSize, MTLStorageMode, MTLTexture, MTLTextureDescriptor,
    MTLTextureUsage,
};
use std::{mem, ptr};

// `MPSImageGaussianBlur` lives in MetalPerformanceShaders, which nothing else in GPUI links.
#[link(name = "MetalPerformanceShaders", kind = "framework")]
unsafe extern "C" {}

// A quad whose border colour is this hue and saturation, fully transparent, asks for the blur; its lightness carries
// the sigma; the saturation's offset from its base carries the grain. No real border colour is transparent with
// exactly this hue and a saturation that close.
const MARKER_HUE: f32 = 0.707_106_77;
const MARKER_SATURATION: f32 = 0.577_215_7;
/// The saturation moves off [`MARKER_SATURATION`] by the grain strength times this (see [`backdrop_blur_marker_grained`]).
const GRAIN_SCALE: f32 = 0.25;
const MAX_SIGMA: f32 = 4096.;
/// The blur's output: half floats, so a dark, low-contrast falloff keeps its sub-8-bit steps until the composite
/// dithers them into the 8-bit drawable (an 8-bit blur target quantises them into visible bands).
const BLURRED_FORMAT: MTLPixelFormat = MTLPixelFormat::RGBA16Float;
/// `MPSImageEdgeModeClamp`: the default zero edge bleeds transparent black into blurs near the window border.
const EDGE_MODE_CLAMP: usize = 1;
/// Blur kernels kept, by sigma.
const MAX_KERNELS: usize = 4;
/// Scratch texture pairs kept, by region size (one per glass surface on screen).
const MAX_SCRATCH: usize = 4;
/// Frames a scratch pair survives unused before it is freed.
const SCRATCH_IDLE_FRAMES: u64 = 120;

/// The border colour that marks a quad as frosted glass: before drawing it, the renderer blurs what is already
/// drawn behind it by `sigma` device pixels, like CSS `backdrop-filter: blur()`. The quad's background then tints
/// the glass. Give the quad no border width and a background that is not fully transparent.
pub fn backdrop_blur_marker(sigma: f32) -> Hsla {
    backdrop_blur_marker_grained(sigma, 0.)
}

/// [`backdrop_blur_marker`] with film grain over the tint: per-device-pixel noise whose specks reach `grain` alpha
/// (0 to 1), white for a positive `grain` and black for a negative one, fixed to the window like a tiled grain
/// texture. Carried in the marker's saturation.
pub fn backdrop_blur_marker_grained(sigma: f32, grain: f32) -> Hsla {
    Hsla {
        h: MARKER_HUE,
        s: MARKER_SATURATION + grain.clamp(-1., 1.) * GRAIN_SCALE,
        l: (sigma / MAX_SIGMA).clamp(0., 1.),
        a: 0.,
    }
}

/// The blur `quad` asks for in device pixels, if it carries [`backdrop_blur_marker`].
pub fn backdrop_blur_sigma(quad: &Quad) -> Option<f32> {
    let color = quad.border_color;
    (color.h == MARKER_HUE
        && (color.s - MARKER_SATURATION).abs() <= GRAIN_SCALE + 1e-6
        && color.a == 0.
        && color.l > 0.)
        .then_some(color.l * MAX_SIGMA)
}

/// The grain a marked `quad` asks for (see [`backdrop_blur_marker_grained`]); 0 for none.
pub fn backdrop_blur_grain(quad: &Quad) -> f32 {
    ((quad.border_color.s - MARKER_SATURATION) / GRAIN_SCALE).clamp(-1., 1.)
}

struct Scratch {
    width: usize,
    height: usize,
    format: MTLPixelFormat,
    /// The backdrop as drawn, in the drawable's format (a blit cannot convert; the copy is exact either way).
    original: Retained<ProtocolObject<dyn MTLTexture>>,
    /// Its blur, in [`BLURRED_FORMAT`].
    blurred: Retained<ProtocolObject<dyn MTLTexture>>,
    used: u64,
}

/// The renderer's backdrop state: the composite pipeline, cached blur kernels and scratch textures.
pub(crate) struct Backdrop {
    pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    kernels: Vec<(f32, Retained<AnyObject>)>,
    scratch: Vec<Scratch>,
    frame: u64,
}

#[repr(C)]
struct CompositeParams {
    origin: [f32; 2],
    size: [f32; 2],
    region_origin: [f32; 2],
    region_size: [f32; 2],
    viewport_size: [f32; 2],
    corner_radius: f32,
    padding: f32,
    /// The quad's solid background, which the composite lays over the blur itself (transparent: the quad draws it).
    tint: [f32; 4],
    /// Signed grain strength, see [`backdrop_blur_marker_grained`].
    grain: f32,
    /// Pads the struct to Metal's 16-byte size for `float4`.
    pad: [f32; 3],
}

impl Backdrop {
    pub(crate) fn new(
        device: &ProtocolObject<dyn MTLDevice>,
        library: &ProtocolObject<dyn MTLLibrary>,
        pixel_format: MTLPixelFormat,
    ) -> Result<Self> {
        Ok(Self {
            pipeline: build_composite_pipeline_state(device, library, pixel_format)?,
            kernels: Vec::new(),
            scratch: Vec::new(),
            frame: 0,
        })
    }

    /// Called once per frame: frees scratch textures no glass has used for a while.
    pub(crate) fn begin_frame(&mut self) {
        self.frame += 1;
        let frame = self.frame;
        self.scratch
            .retain(|scratch| frame - scratch.used <= SCRATCH_IDLE_FRAMES);
    }

    /// Replaces the pixels inside `quad`'s rounded bounds with a Gaussian blur (`sigma` device pixels) of what is
    /// already drawn there and around it, then the quad's tint (when its background is a solid colour) and grain
    /// over it, dithered into the 8-bit target. Returns whether the tint was applied, in which case the caller must
    /// not draw the quad (a marked quad has no border); otherwise it draws the quad afterwards as the tint. Encodes a
    /// blit, the MPS blur and one render pass on `command_buffer`; the caller ends its own render pass first.
    pub(crate) fn blur(
        &mut self,
        device: &ProtocolObject<dyn MTLDevice>,
        quad: &Quad,
        sigma: f32,
        target: &ProtocolObject<dyn MTLTexture>,
        viewport_size: Size<DevicePixels>,
        command_buffer: &ProtocolObject<dyn MTLCommandBuffer>,
    ) -> Result<bool> {
        let viewport = [
            i32::from(viewport_size.width) as f32,
            i32::from(viewport_size.height) as f32,
        ];
        // The blur stops where the quad is clipped, like the quad itself.
        let bounds = quad.bounds.intersect(&quad.content_mask.bounds);
        if bounds.size.width.0 <= 0. || bounds.size.height.0 <= 0. || sigma <= 0. {
            return Ok(false);
        }
        // The gaussian reaches about 3 sigma, so copy that much around the glass: its edges then average the
        // backdrop beyond them instead of fading.
        let bleed = (sigma * 3.).ceil() + 2.;
        let left = (bounds.origin.x.0 - bleed).floor().max(0.);
        let top = (bounds.origin.y.0 - bleed).floor().max(0.);
        let right = (bounds.origin.x.0 + bounds.size.width.0 + bleed)
            .ceil()
            .min(viewport[0]);
        let bottom = (bounds.origin.y.0 + bounds.size.height.0 + bleed)
            .ceil()
            .min(viewport[1]);
        if right - left < 1. || bottom - top < 1. {
            return Ok(false);
        }
        let (width, height) = ((right - left) as usize, (bottom - top) as usize);
        let scratch = self.scratch(device, width, height, target.pixelFormat())?;
        let (original, blurred) = (scratch.original.clone(), scratch.blurred.clone());
        let solid = quad.background.as_solid();
        let tint = solid.map_or(
            Rgba {
                r: 0.,
                g: 0.,
                b: 0.,
                a: 0.,
            },
            Rgba::from,
        );
        let kernel = self.kernel(device, sigma)?;

        let blit = command_buffer
            .blitCommandEncoder()
            .context("creating backdrop blit encoder")?;
        // SAFETY: The region lies inside `target` (clamped to the viewport above) and matches `original`'s size.
        unsafe {
            blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toTexture_destinationSlice_destinationLevel_destinationOrigin(
                target,
                0,
                0,
                MTLOrigin { x: left as usize, y: top as usize, z: 0 },
                MTLSize { width, height, depth: 1 },
                &original,
                0,
                0,
                MTLOrigin { x: 0, y: 0, z: 0 },
            );
        }
        blit.endEncoding();
        // SAFETY: The kernel is a live MPSImageGaussianBlur on this device; both textures are live and the same size,
        // readable and writable as MPS needs (it converts between their formats). The selector is MPSUnaryImageKernel's encoding method.
        unsafe {
            let _: () = msg_send![
                &*kernel,
                encodeToCommandBuffer: command_buffer,
                sourceTexture: &*original,
                destinationTexture: &*blurred
            ];
        }

        let params = CompositeParams {
            origin: [bounds.origin.x.0, bounds.origin.y.0],
            size: [bounds.size.width.0, bounds.size.height.0],
            region_origin: [left, top],
            region_size: [width as f32, height as f32],
            viewport_size: viewport,
            corner_radius: quad.corner_radii.top_left.0,
            padding: 0.,
            tint: [tint.r, tint.g, tint.b, tint.a],
            grain: backdrop_blur_grain(quad),
            pad: [0.; 3],
        };
        let encoder = crate::metal_renderer::new_command_encoder_for_texture(
            command_buffer,
            target,
            viewport_size,
            None,
        )?;
        encoder.setRenderPipelineState(&self.pipeline);
        // SAFETY: The params bytes are copied by Metal and match `BackdropCompositeParams` in shaders.metal; the
        // pipeline draws six vertices from no buffers and reads textures 0 and 1.
        unsafe {
            let bytes = ptr::NonNull::from(&params).cast();
            encoder.setVertexBytes_length_atIndex(bytes, mem::size_of_val(&params), 0);
            encoder.setFragmentBytes_length_atIndex(bytes, mem::size_of_val(&params), 0);
            encoder.setFragmentTexture_atIndex(Some(&blurred), 0);
            encoder.setFragmentTexture_atIndex(Some(&original), 1);
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 6);
        }
        encoder.endEncoding();
        Ok(solid.is_some())
    }

    /// The scratch pair for a `width` x `height` region, made on first use and kept while it is used.
    fn scratch(
        &mut self,
        device: &ProtocolObject<dyn MTLDevice>,
        width: usize,
        height: usize,
        format: MTLPixelFormat,
    ) -> Result<&Scratch> {
        // `format` is the drawable's, for the copy; the blur target is always `BLURRED_FORMAT`.
        let frame = self.frame;
        if let Some(ix) = self
            .scratch
            .iter()
            .position(|s| s.width == width && s.height == height && s.format == format)
        {
            self.scratch[ix].used = frame;
            return Ok(&self.scratch[ix]);
        }
        if self.scratch.len() >= MAX_SCRATCH {
            let oldest = (0..self.scratch.len())
                .min_by_key(|&ix| self.scratch[ix].used)
                .unwrap_or(0);
            self.scratch.remove(oldest);
        }
        let descriptor = MTLTextureDescriptor::new();
        // SAFETY: Both dimensions are at least one pixel and this is a 2D texture descriptor.
        unsafe {
            descriptor.setWidth(width);
            descriptor.setHeight(height);
        }
        descriptor.setPixelFormat(format);
        descriptor.setUsage(MTLTextureUsage::ShaderRead | MTLTextureUsage::ShaderWrite);
        descriptor.setStorageMode(MTLStorageMode::Private);
        let make = || {
            device
                .newTextureWithDescriptor(&descriptor)
                .context("allocating backdrop scratch texture")
        };
        let original = make()?;
        descriptor.setPixelFormat(BLURRED_FORMAT);
        let blurred = make()?;
        self.scratch.push(Scratch {
            width,
            height,
            format,
            original,
            blurred,
            used: frame,
        });
        Ok(self.scratch.last().expect("just pushed"))
    }

    /// The cached `MPSImageGaussianBlur` for `sigma` device pixels.
    fn kernel(
        &mut self,
        device: &ProtocolObject<dyn MTLDevice>,
        sigma: f32,
    ) -> Result<Retained<AnyObject>> {
        if let Some(ix) = self
            .kernels
            .iter()
            .position(|(cached, _)| (cached - sigma).abs() < 0.01)
        {
            let entry = self.kernels.remove(ix);
            let kernel = entry.1.clone();
            self.kernels.push(entry);
            return Ok(kernel);
        }
        if self.kernels.len() >= MAX_KERNELS {
            self.kernels.remove(0);
        }
        let class = AnyClass::get(c"MPSImageGaussianBlur")
            .context("MetalPerformanceShaders has no MPSImageGaussianBlur")?;
        // SAFETY: alloc/init on MPSImageGaussianBlur with this renderer's live device and a float sigma, as its
        // `initWithDevice:sigma:` declares; setEdgeMode: takes an NSUInteger.
        let kernel = unsafe {
            let allocated: Allocated<AnyObject> = msg_send![class, alloc];
            let kernel: Option<Retained<AnyObject>> =
                msg_send![allocated, initWithDevice: device, sigma: sigma];
            let kernel = kernel.context("initialising MPSImageGaussianBlur")?;
            let _: () = msg_send![&*kernel, setEdgeMode: EDGE_MODE_CLAMP];
            kernel
        };
        self.kernels.push((sigma, kernel.clone()));
        Ok(kernel)
    }
}

/// The composite overwrites its target outright, mixing the original back in itself for the antialiased corner.
fn build_composite_pipeline_state(
    device: &ProtocolObject<dyn MTLDevice>,
    library: &ProtocolObject<dyn MTLLibrary>,
    pixel_format: MTLPixelFormat,
) -> Result<Retained<ProtocolObject<dyn MTLRenderPipelineState>>> {
    let vertex_fn = library
        .newFunctionWithName(&NSString::from_str("backdrop_composite_vertex"))
        .context("locating backdrop_composite_vertex")?;
    let fragment_fn = library
        .newFunctionWithName(&NSString::from_str("backdrop_composite_fragment"))
        .context("locating backdrop_composite_fragment")?;
    let descriptor = MTLRenderPipelineDescriptor::new();
    descriptor.setLabel(Some(&NSString::from_str("backdrop_composite")));
    descriptor.setVertexFunction(Some(vertex_fn.as_ref()));
    descriptor.setFragmentFunction(Some(fragment_fn.as_ref()));
    // SAFETY: Index zero is within the pipeline's color attachment array.
    let color_attachment = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
    color_attachment.setPixelFormat(pixel_format);
    color_attachment.setBlendingEnabled(false);
    device
        .newRenderPipelineStateWithDescriptor_error(&descriptor)
        .context("creating backdrop_composite render pipeline")
}
