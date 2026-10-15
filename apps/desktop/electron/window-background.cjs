// The window's own background, behind the page: the theme's page color, so a resize or a slow first paint never
// shows a different color at the edges. Until the renderer reports its theme, the default theme's light page.
const OPAQUE_BACKGROUND = "#f4f9fe";

function applyWindowBackground(window, background) {
  window.setBackgroundColor(/^#[0-9a-f]{6}$/i.test(background) ? background : OPAQUE_BACKGROUND);
}

module.exports = { applyWindowBackground, OPAQUE_BACKGROUND };
