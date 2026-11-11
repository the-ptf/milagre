// Evaluate in the real renderer after its shell has selected the requested Chat.
// Both engines use this exact script. It settles finite animations, normalizes
// visible panels using actual controls, and observes rendered layout without
// replacing DOM content, CSS or application data.
// oxlint-disable eslint/no-underscore-dangle -- Capture diagnostics contract.
(async () => {
  const request = window.__comparisonCapture;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = () => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try {
          animation.finish();
        } catch {
          /* Detached animation. */
        }
      }
    }
  };
  const wait = async (read, label) => {
    for (let index = 0; index < 250; index++) {
      settle();
      const value = read();
      if (value) return value;
      await pause(100);
    }
    throw new Error(`Capture could not find ${label}`);
  };
  await wait(() => document.querySelector('button[aria-label="Settings"]'), "production workspace");
  document.querySelector('button[aria-label="Expand sidebar"]')?.click();
  document.querySelector('button[aria-label="Close Settings"]')?.click();
  document.querySelector('button[aria-label="Filters"][aria-expanded="true"]')?.click();
  for (const family of document.querySelectorAll('button[data-subchat-toggle][aria-expanded="true"]')) family.click();
  for (const toggle of document.querySelectorAll("[data-panel-toggle]")) {
    const want = toggle.dataset.panelToggle === request.panel;
    if ((toggle.getAttribute("aria-pressed") === "true") !== want) toggle.click();
  }
  if (request.panel === "designs") await wait(() => document.querySelector('[data-slot="artifact-frame"] [data-painted="true"]'), "painted saved Design");
  else if (request.panel === "artifacts")
    await wait(() => document.querySelector('[data-slot="artifact-page"] iframe[src^="milagre-artifact:"]'), "saved Artifact iframe");
  await pause(2000);
  settle();
  await document.fonts.ready;
  const dock = document.querySelector("[data-dock-layer]");
  if (!dock || getComputedStyle(dock).display !== "flex") throw new Error("Production layout CSS missing");
  return {
    at: new Date().toISOString(),
    chatKey: request.chatKey,
    panel: request.panel,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    theme: document.documentElement.getAttribute("data-theme"),
    title: document.querySelector("[data-chat-identity-title]")?.textContent,
    font: getComputedStyle(document.body).fontFamily,
    colors: Object.fromEntries(
      ["--page", "--surface", "--ink", "--orange"].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name)]),
    ),
    visibility: document.visibilityState,
    panels: [...document.querySelectorAll("[data-panel-toggle]")].map((item) => ({ name: item.dataset.panelToggle, open: item.getAttribute("aria-pressed") })),
    text: document.body.innerText.slice(0, 16000),
    frames: [...document.querySelectorAll("iframe")].map((frame) => ({
      title: frame.title,
      src: frame.src,
      srcdoc: !!frame.srcdoc,
      sandbox: frame.sandbox.value,
    })),
  };
})();
