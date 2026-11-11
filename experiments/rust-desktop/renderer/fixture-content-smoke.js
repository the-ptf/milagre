// oxlint-disable eslint/no-underscore-dangle -- Fixed fixture diagnostic globals.
// UI mutations go through production buttons and editor fields. Bridge reads are independent observations.
window.__fixtureContentPhase = async (context, { bounded, wait }) => {
  const trace = (window.__fixtureContentTrace = {
    phase: context.phase,
    stage: "catalog",
    source: "synthetic DOM events through production content panels and Design editor",
    pngToolFeedback: false,
    syntheticReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  const bridge = window.milagre;
  trace.rendererErrors = [];
  const onError = (event) => {
    if (trace.rendererErrors.length < 8) trace.rendererErrors.push(String(event.error?.stack ?? event.message ?? event.reason).slice(0, 2500));
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  trace.transitions = [];
  let lastTransition;
  const mutations = new MutationObserver(() => {
    const value = {
      editor: !!document.querySelector('[data-slot="design-editor"]'),
      status: document.querySelector('[data-slot="design-save-status"]')?.textContent ?? null,
      panels: [...document.querySelectorAll('[data-slot="artifact-dock"]')].map((node) => node.getAttribute("aria-label")),
      frames: document.querySelectorAll("iframe").length,
      replyVisible: document.body.innerText.includes("Scripted isolated reply"),
      active: document.querySelector('[data-chat-id] button[aria-current="page"]')?.closest("[data-chat-id]")?.dataset.chatId ?? null,
    };
    const serialized = JSON.stringify(value);
    if (lastTransition !== serialized && trace.transitions.length < 32) trace.transitions.push({ ms: Math.round(performance.now()), ...value });
    lastTransition = serialized;
  });
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const previousError = console.error;
  console.error = (...args) => {
    if (trace.rendererErrors.length < 8)
      trace.rendererErrors.push(
        args
          .map((value) => String(value?.stack ?? value))
          .join(" ")
          .slice(0, 2500),
      );
    previousError.apply(console, args);
  };
  const previousApply = bridge.artifacts.apply;
  bridge.artifacts.apply = async (...args) => {
    const value = await previousApply(...args);
    trace.applyResponse = {
      id: value?.id,
      version: value?.version,
      format: value?.format,
      documentPresent: !!value?.document,
      nodeCount: value?.document?.nodes?.length,
    };
    return value;
  };
  let onMessage;
  try {
    const chatId = `${context.project}#1`;
    const editedText = "Rust fixture design edited in WebKit";
    const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
    const native = (method, args) => bounded(window.__TAURI__.core.invoke("native_call", { method, args }), method);
    const get = (id) => bounded(bridge.artifacts.get({ chatId, id }), `artifact ${id}`);
    trace.policies = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map((node) => node.content);
    trace.violations = [];
    const blockedImage = async (src) => {
      trace.stage = `csp ${src}`;
      let observed;
      let finish;
      const violation = new Promise((resolve) => {
        finish = resolve;
      });
      const listener = (event) => {
        if (trace.violations.length < 8)
          trace.violations.push({ directive: event.effectiveDirective, violated: event.violatedDirective, blockedURI: event.blockedURI });
        if (event.effectiveDirective === "img-src" && src.startsWith(event.blockedURI)) {
          observed = { directive: event.effectiveDirective, blockedURI: event.blockedURI };
          finish();
        }
      };
      document.addEventListener("securitypolicyviolation", listener);
      try {
        const image = new Image();
        const outcome = new Promise((resolve, reject) => {
          image.addEventListener("load", () => reject(Error("Forbidden image loaded")), { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
        image.src = src;
        await bounded(Promise.all([outcome, violation]), "observed image CSP refusal");
        return observed;
      } finally {
        document.removeEventListener("securitypolicyviolation", listener);
      }
    };
    const control = new Image();
    await bounded(
      new Promise((resolve, reject) => {
        control.addEventListener("load", resolve, { once: true });
        control.addEventListener("error", reject, { once: true });
        control.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1'/%3E%3C/svg%3E";
      }),
      "allowed inline image positive control",
    );
    if (control.naturalWidth !== 1) throw Error("Inline image positive control did not decode");
    trace.csp = {
      positiveInlineImage: true,
      externalImage: await blockedImage("https://fixture.invalid/offline-probe.png"),
      absoluteMediaScheme: await blockedImage("milagre-media://file/?path=/fixture-csp-canary.png"),
      scope: "actual main-document CSP image refusals; no packet capture or filesystem isolation claim",
    };
    const catalog = await bounded(bridge.artifacts.list({ chatId }), "content catalog");
    if (
      catalog.length !== 2 ||
      !catalog.some((item) => item.id === "fixture-report" && item.format === "html") ||
      !catalog.some((item) => item.id === "fixture-screen" && item.format === "design")
    )
      throw Error("Expected real HTML and Design content");
    trace.catalog = catalog.map(({ id, format, version }) => ({ id, format, version }));
    const stale = localStorage.getItem("__fixturePreviewUrl");
    if (context.phase === 1) {
      if (!stale) throw Error("Missing prior preview capability");
      trace.stalePreview = await native("fixture:preview-check", [stale]);
      if (trace.stalePreview.status !== 404) throw Error("Reload did not revoke prior preview");
    }
    const frames = new Map();
    const designObservations = new WeakMap();
    onMessage = (event) => {
      if (event.data?.milagre === "fixture-design-observer") {
        const frame = [...document.querySelectorAll('[data-slot="design-editor-preview"] iframe')].find((item) => item.contentWindow === event.source);
        if (frame) designObservations.set(frame.contentWindow, event.data);
        return;
      }
      if (event.data?.milagre !== "milagre:artifact-page" && event.data?.milagre !== "fixture-content-observer") return;
      const frame = [...document.querySelectorAll('[data-slot="artifact-dock"] iframe')].find((item) => item.contentWindow === event.source);
      if (!frame) return;
      const value = frames.get(frame.src) ?? {};
      if (event.data.milagre === "milagre:artifact-page" && event.data.t === "ready") value.ready = true;
      if (event.data.milagre === "fixture-content-observer") value.observation = event.data;
      frames.set(frame.src, value);
    };
    window.addEventListener("message", onMessage);
    trace.stage = "html-panel";
    (await wait(() => button("Toggle artifacts panel"), "production Artifacts toggle")).click();
    const frame = await wait(
      () => document.querySelector('[data-slot="artifact-dock"][aria-label="Artifacts"] iframe[src^="milagre-artifact:"]'),
      "actual HTML preview iframe",
    );
    trace.html = await wait(() => {
      const value = frames.get(frame.src);
      return value?.ready && value.observation ? value : null;
    }, "production helper and sandbox observer");
    if (
      !trace.html.observation.text.includes("Rust fixture artifact") ||
      trace.html.observation.tauri !== "undefined" ||
      trace.html.observation.bridge !== "undefined" ||
      trace.html.observation.topReadable ||
      trace.html.observation.csp?.externalImage?.directive !== "img-src" ||
      trace.html.observation.csp?.absoluteMediaScheme?.directive !== "img-src"
    )
      throw Error("HTML sandbox observation failed");
    let parentReadDenied = false;
    try {
      void frame.contentWindow.document.body;
    } catch {
      parentReadDenied = true;
    }
    if (!parentReadDenied || frame.getAttribute("sandbox")?.includes("allow-same-origin")) throw Error("Artifact frame is not opaque");
    trace.html.parentReadDenied = parentReadDenied;
    trace.html.currentPreview = await native("fixture:preview-check", [frame.src]);
    if (trace.html.currentPreview.status !== 200 || !trace.html.currentPreview.policy.includes("connect-src 'none'"))
      throw Error("Current preview handler or offline policy failed");
    localStorage.setItem("__fixturePreviewUrl", frame.src);
    trace.html.title = document.querySelector('[data-slot="artifact-dock-title"]')?.textContent;
    button("Close artifacts").click();
    await wait(() => !document.querySelector('[data-slot="artifact-dock"][aria-label="Artifacts"]'), "HTML panel closed");
    trace.stage = "design-editor";
    (await wait(() => button("Toggle designs panel"), "production Designs toggle")).click();
    const thumb = await wait(
      () => document.querySelector('[data-slot="artifact-frame"][data-artifact="fixture-screen"] [data-slot="artifact-edit"]'),
      "production Edit Design button",
    );
    trace.canvasPainted = !!(await wait(
      () => document.querySelector('[data-slot="artifact-frame"][data-artifact="fixture-screen"] [data-design-body][data-painted="true"]'),
      "production Design preview painted",
    ));
    thumb.click();
    await wait(() => document.querySelector('[data-slot="design-editor"]'), "production Design editor");
    (await wait(() => document.querySelector('[data-slot="design-layers-toggle"]'), "Layers button")).click();
    (await wait(() => document.querySelector('button[data-node-id="heading"]'), "fixture heading layer")).click();
    const field = await wait(() => document.querySelector('textarea[aria-label="Text"]'), "Design Text inspector");
    trace.design = { before: field.value, editorVisible: true };
    const observeDesign = async (expected) =>
      wait(() => {
        const editorFrame = document.querySelector('[data-slot="design-editor-preview"] iframe');
        const value = editorFrame && designObservations.get(editorFrame.contentWindow);
        return value?.text === expected && value.controllerReady && value.selectionVisible && value.width > 0 && value.height > 0 ? value : null;
      }, "real Design srcdoc controller and selected heading");
    trace.design.initialFrame = await observeDesign(field.value);
    if (trace.design.initialFrame.tauri !== "undefined" || trace.design.initialFrame.bridge !== "undefined" || trace.design.initialFrame.topReadable)
      throw Error("Design srcdoc sandbox observation failed");
    if (context.phase === 0) {
      if (field.value !== "Rust fixture design") throw Error("Initial Design text differs");
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, editedText);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.blur();
      const save = await wait(() => {
        const item = document.querySelector('[data-slot="design-save"]');
        return item && !item.disabled ? item : null;
      }, "enabled Design Save");
      trace.stage = "design-save";
      save.click();
      trace.design.saveClicks = 1;
    } else {
      if (field.value !== editedText) throw Error("Reloaded Design inspector lost saved edit");
      trace.design.saveClicks = 0;
    }
    trace.design.saved = await wait(async () => {
      const value = await get("fixture-screen");
      return value.version === 2 && value.document.nodes[0].text === editedText
        ? { id: value.id, version: value.version, text: value.document.nodes[0].text, ownerReadConfirmed: true, directDiskRead: false }
        : null;
    }, "version 2 Design reread");
    trace.stage = "saved-design-ui";
    await wait(
      () =>
        document.querySelector('[data-slot="design-save"]')?.disabled &&
        button("Close design editor") &&
        !button("Close design editor").disabled &&
        !document.querySelector('[data-slot="design-save-status"]')?.textContent.includes("Saving") &&
        !document.querySelector('[data-slot="design-preview-error"]'),
      "saved Design UI",
    );
    trace.stage = "rendered-edited-design";
    trace.design.savedFrame = await observeDesign(editedText);
    trace.design.status = document.querySelector('[data-slot="design-save-status"]')?.textContent;
    if (context.phase === 0) {
      trace.stage = "retained-preview-before-reload";
      button("Close design editor").click();
      await wait(() => !document.querySelector('[data-slot="design-editor"]'), "saved editor closed");
      if (button("Close designs")) button("Close designs").click();
      (await wait(() => button("Toggle artifacts panel"), "Artifacts toggle after save")).click();
      const retained = await wait(() => {
        const item = document.querySelector('[data-slot="artifact-dock"][aria-label="Artifacts"] iframe[src^="milagre-artifact:"]');
        return item && frames.get(item.src)?.ready ? item : null;
      }, "new retained HTML preview");
      trace.retainedPreview = await native("fixture:preview-check", [retained.src]);
      if (trace.retainedPreview.status !== 200) throw Error("Preview was already revoked before reload");
      localStorage.setItem("__fixturePreviewUrl", retained.src);
    }
    trace.stage = "complete";
    return trace;
  } finally {
    if (onMessage) window.removeEventListener("message", onMessage);
    console.error = previousError;
    mutations.disconnect();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onError);
    bridge.artifacts.apply = previousApply;
  }
};
