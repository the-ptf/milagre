// oxlint-disable eslint/no-underscore-dangle -- Fixed, feature-only sandbox observation.
// Instrumentation injected only by fixture-content-smoke, after actual saved HTML.
void (() => {
  const blockedImage = (src) =>
    new Promise((resolve) => {
      let failed = false;
      let violation;
      const image = new Image();
      const finish = () => {
        if (!failed || !violation) return;
        clearTimeout(deadline);
        document.removeEventListener("securitypolicyviolation", observed);
        resolve(violation);
      };
      const observed = (event) => {
        if (event.effectiveDirective !== "img-src" || !src.startsWith(event.blockedURI)) return;
        violation = { directive: event.effectiveDirective, blockedURI: event.blockedURI };
        finish();
      };
      const deadline = setTimeout(() => {
        document.removeEventListener("securitypolicyviolation", observed);
        resolve({ error: "Preview CSP refusal was not observed" });
      }, 3000);
      document.addEventListener("securitypolicyviolation", observed);
      image.addEventListener(
        "error",
        () => {
          failed = true;
          finish();
        },
        { once: true },
      );
      image.src = src;
    });
  const report = async () => {
    let topReadable = false;
    try {
      void top.document.body;
      topReadable = true;
    } catch {}
    const [externalImage, absoluteMediaScheme] = await Promise.all([
      blockedImage("https://fixture.invalid/preview-offline-probe.png"),
      blockedImage("milagre-media://file/?path=/fixture-preview-csp-canary.png"),
    ]);
    parent.postMessage(
      {
        milagre: "fixture-content-observer",
        text: document.body.innerText.slice(0, 1000),
        tauri: typeof window.__TAURI__,
        bridge: typeof window.milagre,
        topReadable,
        csp: { externalImage, absoluteMediaScheme },
      },
      "*",
    );
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", report, { once: true });
  else void report();
})();
