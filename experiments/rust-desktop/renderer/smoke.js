// Optional evaluation in the real Tauri window, against the real daemon.
// Reads existing data and changes only this client's viewed UI. Never sends a Chat,
// changes a setting, edits an Artifact, executes a terminal command or starts an agent.
// oxlint-disable eslint/no-underscore-dangle -- Smoke diagnostics contract.
void (async () => {
  const checks = [];
  const contentProbe = window.__rustContentSmoke
    ? Promise.resolve(window.__rustContentSmoke).then(
        (result) => ({ passed: true, ...result }),
        (error) => ({ passed: false, error: error.message || String(error) }),
      )
    : Promise.resolve({ passed: false, error: "Content sandbox probe was not started" });
  // Hidden WKWebView freezes CSS entry animations at zero. Advance finite
  // presentation animations to their real endpoint before inspecting/capturing.
  // This changes no application data, layout rules or screenshot pixels.
  window.__rustSettleForCapture = () => {
    for (const animation of document.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) {
        try {
          animation.finish();
        } catch {
          /* Detached animation. */
        }
      }
    }
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (read, label, timeout = 12000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      window.__rustSettleForCapture();
      const value = read();
      if (value) return value;
      await pause(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
  const snapshot = (label) => {
    window.__rustSettleForCapture();
    checks.push({
      label,
      title: document.title,
      chats: document.querySelectorAll("[data-chat-id]").length,
      panels: [...document.querySelectorAll("[data-panel-toggle]")].map((b) => ({ name: b.dataset.panelToggle, open: b.getAttribute("aria-pressed") })),
      text: document.body.innerText.slice(0, 12000),
      frames: [...document.querySelectorAll("iframe")].map((frame) => ({
        title: frame.title,
        src: frame.src,
        srcdoc: !!frame.srcdoc,
        sandbox: frame.sandbox.value,
        width: frame.getBoundingClientRect().width,
        height: frame.getBoundingClientRect().height,
      })),
    });
  };
  try {
    await wait(() => window.__rustDiagnostics?.ready && button("Settings"), "production workspace", 30000);
    button("Expand sidebar")?.click();
    const row = await wait(() => document.querySelector("[data-chat-id] button[data-row]"), "saved sidebar Chat");
    const dock = document.querySelector("[data-dock-layer]");
    if (!dock || getComputedStyle(dock).display !== "flex") throw new Error("Production workspace flex layout is missing");
    const rowRect = row.getBoundingClientRect();
    if (rowRect.height < 24 || rowRect.height > 80 || rowRect.width < 120 || rowRect.width > 600) {
      throw new Error(`Sidebar Chat geometry differs from production: ${rowRect.width} × ${rowRect.height}`);
    }
    checks.push({ label: "production-layout", dockDisplay: getComputedStyle(dock).display, row: { width: rowRect.width, height: rowRect.height } });
    row.click();
    await pause(1500);
    snapshot("chat");
    const filters = button("Filters");
    if (filters) {
      filters.click();
      await pause(250);
      snapshot("filters");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    button("Settings").click();
    const navigation = await wait(() => document.querySelector('[aria-label="Settings navigation"]'), "Settings navigation");
    const appearance = [...navigation.querySelectorAll("button")].find((b) => b.textContent.trim() === "Appearance");
    if (!appearance) throw new Error("Appearance navigation missing");
    appearance.click();
    await pause(500);
    snapshot("appearance");
    const close = button("Close Settings");
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await pause(350);
    document.querySelector("[data-chat-id] button[data-row]")?.click();
    await pause(700);
    const current = await window.milagre.getCurrentProject();
    const candidates = [];
    for (const chat of Object.values(current?.state?.sessions || {}).slice(0, 80)) {
      const key = `${current.path}#${chat.id}`;
      const refs = await window.milagre.artifacts.list({ chatId: key });
      if (Array.isArray(refs) && refs.length) candidates.push({ key, refs });
      if (refs.some((ref) => ref.format === "design") && refs.some((ref) => ref.format === "html")) break;
    }
    for (const [panel, format] of [
      ["designs", "design"],
      ["artifacts", "html"],
    ]) {
      const candidate = candidates.find((item) => item.refs.some((ref) => ref.format === format));
      if (!candidate) throw new Error(`No saved ${panel} found in the current Project; panel verification remains incomplete`);
      await window.__TAURI__.event.emit("native-event", { channel: "notification:open-chat", payload: candidate.key });
      const toggle = await wait(() => document.querySelector(`[data-panel-toggle="${panel}"]`), `saved ${panel} Chat`, 20000);
      if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
      if (panel === "designs") {
        await wait(() => document.querySelector('[data-slot="artifact-frame"] [data-painted="true"]'), "painted saved Design", 25000);
      } else {
        await wait(() => document.querySelector('[data-slot="artifact-page"] iframe[src^="milagre-artifact:"]'), "saved Artifact iframe", 20000);
      }
      await pause(1500);
      snapshot(panel);
      checks.at(-1).chatKey = candidate.key;
      if (toggle.isConnected && toggle.getAttribute("aria-pressed") === "true") toggle.click();
    }
  } catch (error) {
    checks.push({ error: error.message || String(error) });
  }
  window.__rustSettleForCapture();
  const result = {
    content: await contentProbe,
    checks,
    diagnostics: window.__rustDiagnostics,
    html: document.getElementById("root")?.innerHTML.slice(0, 10000),
    visibility: document.visibilityState,
    width: innerWidth,
    height: innerHeight,
  };
  window.__rustSmokeResult = result;
  await window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(result) });
})();
