Hand-drawn shapes that are not Hugeicons: the `SpinnerRing` track and arc (`src/ui/spinner_ring.rs`), the same
geometry as the desktop's `SpinnerRing` (radius `(size - stroke) / 2`, the arc 28% of the circle). Edit these by
hand, then run `node tools/gen-icons.mjs` so `src/assets/embedded.rs` lists them.

The running mark (`src/workspace/chat/running.rs`): `running-leg-left`, `running-leg-right` and `running-star`, the three
paths of the desktop's `ThinkingIndicator.tsx` `RunningLogo`. The star's viewBox is re-centred on the star (the desktop
turns it about `50% 32.3%`; GPUI turns an SVG about its centre), so it sits 2.8 px above the legs' box.
