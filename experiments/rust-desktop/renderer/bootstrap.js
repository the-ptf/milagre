// oxlint-disable eslint/no-underscore-dangle -- Tauri globals and the explicit smoke diagnostic contract.
import { initializeBridge, installBrowserCompatibility, installWindowChrome } from "./electron-shim.js";

try {
  await initializeBridge();
  window.__rustLaunchArguments = await window.__TAURI__.core.invoke("native_call", { method: "app:launch-arguments", args: [] });
  installBrowserCompatibility();
  installWindowChrome();
  await import("virtual:milagre-electron-preload");
  await import("../../../apps/desktop/app/src/main.tsx");
  window.__rustDiagnostics.ready = true;
  window.__rustDiagnostics.readyAt = performance.now();
  // WKWebView suspends CSS animations for a background window. The production
  // splash otherwise holds the whole workspace until its animationend arrives.
  // Complete that presentation-only gate while hidden; visible launches keep the
  // original animation and timing.
  setTimeout(async () => {
    if (!document.hidden) return;
    const splash = await import("../../../apps/desktop/app/src/lib/startup-splash.ts");
    splash.splashIntroEnded();
    splash.splashLeft();
    window.__rustDiagnostics.backgroundSplashCompleted = true;
  }, 1200);
} catch (error) {
  window.__rustDiagnostics.errors.push({ method: "bootstrap", message: error?.message || String(error) });
  const message = document.createElement("p");
  message.textContent = `Milagre Rust could not start: ${error?.message || error}. Keep the current Milagre host running, then reopen this window.`;
  message.style.cssText = "padding:32px;font:14px system-ui;color:CanvasText;background:Canvas;white-space:pre-wrap";
  document.getElementById("root").replaceChildren(message);
}
