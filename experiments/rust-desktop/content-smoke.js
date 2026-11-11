// oxlint-disable eslint/no-underscore-dangle -- Local smoke diagnostics contract.
// Read-only integration probe. Uses the actual production bridge and custom protocol, no seeded state.
window.__rustContentSmoke = (async () => {
  const marker = "rust-content-" + crypto.randomUUID();
  let frame;
  let url;
  let listener;
  let timer;
  let nativeDenied = false;
  let nativeAccepted = false;
  const originalError = console.error;
  // An intentionally unauthenticated native IPC request is rejected during parsing.
  // Account for that expected diagnostic without hiding unrelated application errors.
  const rejection = "missing field `__TAURI_INVOKE_KEY__`";
  console.error = (...args) => {
    if (args.length === 1 && typeof args[0] === "string" && args[0].includes(rejection)) {
      nativeDenied = true;
      return;
    }
    originalError(...args);
  };
  const callbacks = window.__TAURI_INTERNALS__;
  const callback = callbacks.transformCallback(() => {
    nativeAccepted = true;
  }, true);
  const errorCallback = callbacks.transformCallback(() => {
    nativeAccepted = true;
  }, true);
  try {
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Artifact sandbox probe timed out")), 10000);
      listener = (event) => {
        if (event.source !== frame?.contentWindow || event.data?.marker !== marker) return;
        resolve({ ...event.data, opaqueOrigin: event.origin === "null" });
      };
      addEventListener("message", listener);
    });
    // The public native handler may exist in child frames even though Tauri globals do not.
    // Omit the unavailable invoke key; do not guess one (Tauri logs actual keys on mismatch).
    const source = `<h1>Rust artifact sandbox probe</h1><script>
let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}
let rawHandlerAvailable=!!window.webkit?.messageHandlers?.ipc,rawInvocationAttempted=false,rawInvocationError=null;
if(rawHandlerAvailable){try{window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({cmd:'preferences_read',callback:${callback},error:${errorCallback},payload:{},options:{}}));rawInvocationAttempted=true}catch(error){rawInvocationError=String(error)}}
parent.postMessage({marker:${JSON.stringify(marker)},parentBlocked,hasTauri:!!window.__TAURI__,hasInternals:!!window.__TAURI_INTERNALS__,helperLoaded:!!window.__milagrePage,rawHandlerAvailable,rawInvocationAttempted,rawInvocationError},'*');
</script>`;
    url = await window.milagre.createArtifactPreview(source);
    frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts";
    frame.style.cssText = "position:fixed;left:-2000px;width:320px;height:200px;pointer-events:none";
    frame.src = url;
    document.body.append(frame);
    const observed = await result;
    if (!observed.rawHandlerAvailable || observed.rawInvocationError) nativeDenied = true;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (nativeDenied || nativeAccepted) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    observed.nativeIpcDenied = nativeDenied && !nativeAccepted;
    if (
      !observed.parentBlocked ||
      !observed.opaqueOrigin ||
      observed.hasTauri ||
      observed.hasInternals ||
      !observed.helperLoaded ||
      !observed.nativeIpcDenied
    ) {
      throw new Error("Artifact sandbox isolation failed: " + JSON.stringify(observed));
    }
    return observed;
  } finally {
    console.error = originalError;
    callbacks.unregisterCallback(callback);
    callbacks.unregisterCallback(errorCallback);
    clearTimeout(timer);
    if (listener) removeEventListener("message", listener);
    frame?.remove();
    if (url) await window.milagre.releaseArtifactPreview(url);
  }
})();
