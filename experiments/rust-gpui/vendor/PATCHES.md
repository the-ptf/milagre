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
the quad (plus 3 sigma around it) into a scratch texture, blur them with `MPSImageGaussianBlur` (clamped edges), write
the blur back inside the quad's rounded bounds with a small composite pass, and resume. The quad itself then draws on
top as the tint. Our `src/ui/glass.rs` paints that quad.

| File                    | Change                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backdrop.rs`       | New (340 lines, MonoCode MIT header): the marker and its decoder (from their `gpui-pre/src/scene.rs`, kept out of gpui-pre so it needs no patch), the composite pipeline, cached MPS kernels (up to 4 sigmas), scratch texture pairs per region size (up to 4, freed after 120 frames unused), and `Backdrop::blur` (blit, MPS encode, composite). Links MetalPerformanceShaders. |
| `src/metal_renderer.rs` | +50 -3: `Backdrop` field and its construction; `begin_frame` per frame; the quads batch is split at each marked quad (draw the quads before it, end the pass, blur, new pass); `new_command_encoder_for_texture` is `pub(crate)`; the layer is no longer framebuffer-only in every build (upstream only in `test-support` debug builds), so the drawable can be copied from.      |
| `src/shaders.metal`     | +48: `backdrop_composite_vertex` and `backdrop_composite_fragment` (MonoCode's, unchanged).                                                                                                                                                                                                                                                                                       |
| `src/gpui_apple.rs`     | +3: `mod backdrop;` and `pub use backdrop::{backdrop_blur_marker, backdrop_blur_sigma}`.                                                                                                                                                                                                                                                                                          |

Cost: a frame with no marked quad pays one pass over the quads (a float compare each) and nothing else; the layer not
being framebuffer-only may cost a little presentation bandwidth. Each marked quad costs a blit, the MPS blur and a
pass, all on the GPU. The headless renderer (`MetalHeadlessRenderer`, snapshots) runs the same code, so headless
snapshots show the blur too; GPUI's test platform draws nothing.

To regenerate the diff: `diff -ruN ~/.cargo/registry/src/*/gpui-pre-apple-0.3.12 vendor/gpui-pre-apple` (ignore the
missing `Cargo.lock` and `.cargo-ok`). To upgrade GPUI: copy the new gpui-pre-apple, reapply the four changes above,
bump the version in `[patch.crates-io]`'s target together with gpui-pre.
