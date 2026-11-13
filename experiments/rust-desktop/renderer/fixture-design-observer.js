// oxlint-disable eslint/no-underscore-dangle -- Feature-only frame observation.
// Reads the actual srcdoc and controller DOM. It never edits the document or
// supplies a controller, selection, content, bridge or ready acknowledgement.
void (() => {
  if (window === window.top) return;
  const start = () => {
    const root = document.getElementById("design-root");
    if (!root) return;
    let previous;
    let reports = 0;
    const report = () => {
      const heading = root.querySelector('[data-design-node="heading"]');
      if (!heading) return;
      const rectangle = heading.getBoundingClientRect();
      const selection = document.getElementById("design-selection");
      let topReadable = false;
      try {
        void top.document.body;
        topReadable = true;
      } catch {}
      const value = {
        milagre: "fixture-design-observer",
        rawText: heading.innerText,
        text: heading.innerText.replace(/\s+/g, " ").trim(),
        width: rectangle.width,
        height: rectangle.height,
        controllerReady: !!document.getElementById("design-guides"),
        selectionVisible: !!selection && getComputedStyle(selection).display !== "none",
        tauri: typeof window.__TAURI__,
        bridge: typeof window.milagre,
        topReadable,
        source: "feature-only observer of real srcdoc and production controller DOM",
      };
      const serialized = JSON.stringify(value);
      if (serialized === previous || reports >= 8) return;
      previous = serialized;
      reports += 1;
      parent.postMessage(value, "*");
    };
    new MutationObserver(report).observe(root, { childList: true, attributes: true, subtree: true, characterData: true });
    report();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
