# Third-party notices

Code copied into this crate from other projects, with its licence. Dependencies pulled from crates.io keep their own
licences in their packages and are not listed here.

## MonoCode: backdrop blur

- Source: https://github.com/hardbeat920/monocode at commit `7e5a9e3690d5b96a7d93ebf884397835e57b9b7e`, files
  `vendor/gpui-pre-apple/src/metal_renderer.rs` (`blur_backdrop`, `gaussian_kernel`, `build_backdrop_pipeline_state`),
  `vendor/gpui-pre-apple/src/shaders.metal` (`backdrop_composite_vertex`, `backdrop_composite_fragment`) and
  `vendor/gpui-pre/src/scene.rs` (`backdrop_blur_marker`, `backdrop_blur_sigma`).
- Here: `vendor/gpui-pre-apple/src/backdrop.rs` and the end of `vendor/gpui-pre-apple/src/shaders.metal`, adapted
  and extended (a half-float blur target; the tint, film grain and a dither in the composite; see `vendor/PATCHES.md`).
- Licence: MIT.

```
MIT License

Copyright (c) 2026 Nick

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## GPUI (gpui-pre-apple 0.3.12)

- Source: crates.io `gpui-pre-apple` 0.3.12, a snapshot of zed-industries/zed's `crates/gpui_apple` at `d2a4fb6`.
- Here: `vendor/gpui-pre-apple/`, patched as `vendor/PATCHES.md` describes; MonoCode's code above runs inside it.
- Licence: Apache-2.0, Copyright 2022 - 2025 Zed Industries, Inc. Full text: `vendor/gpui-pre-apple/LICENSE-APACHE`.
  Modified files carry a "Modified for milagre-gpui-spike" note.
