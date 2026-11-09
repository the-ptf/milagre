// The window's own background, behind the page: the theme's page color, so a resize or a slow first paint never
// shows a different color at the edges. Until the renderer reports its theme, the default theme's light page.
const OPAQUE_BACKGROUND = "#f4f9fe";

function applyWindowBackground(window, background, platform = process.platform) {
  const color = /^#[0-9a-f]{6}$/i.test(background) ? background : OPAQUE_BACKGROUND;
  window.setBackgroundColor(color);
  if (platform === "win32") {
    const [red, green, blue] = color
      .slice(1)
      .match(/../g)
      .map((channel) => {
        const value = parseInt(channel, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    window.setTitleBarOverlay({ color: "#00000000", symbolColor: luminance > 0.179 ? "#000000" : "#ffffff" });
  }
}

module.exports = { applyWindowBackground, OPAQUE_BACKGROUND };
