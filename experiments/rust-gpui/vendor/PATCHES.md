# Vendored crates and their patches

`Cargo.toml`'s `[patch.crates-io]` swaps these in for the published crates of the same version, so every crate that
depends on them (gpui-pre-platform, gpui-component) builds against the patched copy. `vendor/` is excluded from the
workspace: `cargo fmt`, `clippy` and `test` in this crate do not touch it.

## gpui-pre-apple 0.3.12: backdrop blur

The published crate (crates.io `gpui-pre-apple` 0.3.12, zed@d2a4fb6, Apache-2.0, `LICENSE-APACHE` kept) as unpacked by
cargo, minus its `Cargo.lock` (ignored for a path dependency) and cargo's `.cargo-ok`, plus one patch: per-element
backdrop blur, ported from MonoCode (https://github.com/hardbeat920/monocode, MIT, commit
`7e5a9e3690d5b96a7d93ebf884397835e57b9b7e`; their patched copy is on 0.3.9 and metal-rs, ours is rewritten onto 0.3.12's
objc2-metal API). Only the backdrop blur was taken; MonoCode's other renderer changes (edge fades, text reveal,
background compositing, alpha blending, rounded clipping) were not.

How it works: a quad whose border colour is `backdrop_blur_marker(sigma)` (a fixed hue and saturation, alpha 0, the
sigma in the lightness) makes the renderer, when it reaches that quad, end its render pass, copy the drawn pixels under
the quad (plus 3 sigma around it) into a scratch texture, blur them with `MPSImageGaussianBlur` (clamped edges) into a
half-float (`RGBA16Float`) texture, and resume after a small composite pass that writes, inside the quad's rounded
bounds, the blur with the quad's solid background laid over it as the tint, optional film grain over that, and a
triangular +-1 level dither into the 8-bit drawable. The renderer then skips the quad (its tint is already drawn); a
quad whose background is not a solid colour is drawn on top as before. Our `src/ui/glass.rs` paints that quad.

Why the half floats, the tint in the composite and the dither (MonoCode's version had none of them): an 8-bit blur of a
dark, low-contrast backdrop comes out in whole levels, and the tint quad at 62% then compresses those into fewer, so the
glass showed bands (flat runs 15 to 25 device pixels wide along a falloff, contour rings at 4x). Blurring into half
floats keeps the fractions; applying the tint in the same shader keeps them through the tint; the dither turns them into
noise at the single 8-bit write. The copy of the backdrop stays in the drawable's format: a blit cannot convert, and an
8-bit source is exact anyway, so only the blur's output needs the precision. The grain is the marker's second value
(`backdrop_blur_marker_grained`: the saturation's offset from its base, signed for white or black specks), per
device-pixel white noise like `assets/grain/`. Measured with `glass_band_snapshot` and the GPU time of
`glass_frame_time` (see the README): no measurable cost (whole frame about 3.0 ms GPU before and after).

| File                    | Change                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backdrop.rs`       | New (390 lines, MonoCode MIT header): the marker, with optional grain, and its decoders (from their `gpui-pre/src/scene.rs`, kept out of gpui-pre so it needs no patch), the composite pipeline, cached MPS kernels (up to 4 sigmas), scratch texture pairs per region size (up to 4, freed after 120 frames unused; the copy in the drawable's format, the blur in `RGBA16Float`), and `Backdrop::blur` (blit, MPS encode, composite with tint, grain and dither; returns whether it drew the tint). Links MetalPerformanceShaders. |
| `src/metal_renderer.rs` | +56 -3: `Backdrop` field and its construction; `begin_frame` per frame; the quads batch is split at each marked quad (draw the quads before it, end the pass, blur, new pass, and skip the quad when the blur drew its tint); `new_command_encoder_for_texture` is `pub(crate)`; the layer is no longer framebuffer-only in every build (upstream only in `test-support` debug builds), so the drawable can be copied from.      |
| `src/shaders.metal`     | +84: `backdrop_composite_vertex` (MonoCode's) and `backdrop_composite_fragment` (theirs plus the tint, grain and dither), and `backdrop_hash` (a PCG hash for the noise).                                                                                                                                                                                                                                                                                       |
| `src/gpui_apple.rs`     | +5: `mod backdrop;` and `pub use backdrop::{backdrop_blur_grain, backdrop_blur_marker, backdrop_blur_marker_grained, backdrop_blur_sigma}`.                                                                                                                                                                                                                                                                                          |

Cost: a frame with no marked quad pays one pass over the quads (a float compare each) and nothing else; the layer not
being framebuffer-only may cost a little presentation bandwidth. Each marked quad costs a blit, the MPS blur and a
pass, all on the GPU. The headless renderer (`MetalHeadlessRenderer`, snapshots) runs the same code, so headless
snapshots show the blur too; GPUI's test platform draws nothing.

To regenerate the diff: `diff -ruN ~/.cargo/registry/src/*/gpui-pre-apple-0.3.12 vendor/gpui-pre-apple` (ignore the
missing `Cargo.lock` and `.cargo-ok`). To upgrade GPUI: copy the new gpui-pre-apple, reapply the four changes above,
bump the version in `[patch.crates-io]`'s target together with gpui-pre.
