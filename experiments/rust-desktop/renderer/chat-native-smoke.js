// oxlint-disable eslint/no-underscore-dangle -- Explicit bounded native smoke diagnostics.
// Production React controls only. The native JSON plan supplies text and any exact approval.
void (async () => {
  if (window.__chatNativeSmoke) return;
  window.__chatNativeSmoke = true;
  let context;
  let off;
  let removeFrameListener;
  const stage = { phase: 0, passed: false, sendClicks: 0, permissionClicks: 0, events: [] };
  let lastProgress;
  const progress = (label) => {
    if (lastProgress === label) return;
    lastProgress = label;
    if (!window.__TAURI__?.core?.invoke) return;
    void window.__TAURI__.core.invoke("native_call", { method: "chat-desktop:smoke-progress", args: [{ phase: stage.phase, label }] }).catch(() => {});
  };
  let expires = Date.now() + 145000;
  const bounded = async (promise, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), Math.max(1, Math.min(10000, expires - Date.now())));
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const wait = async (check, label) => {
    progress(label);
    while (Date.now() < expires) {
      const found = await bounded(Promise.resolve().then(check), label);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`Timed out: ${label}`);
  };
  const button = (label) => document.querySelector(`button[aria-label="${label}"]`);
  try {
    context = await wait(async () => {
      try {
        return await window.__TAURI__.core.invoke("native_call", { method: "chat-desktop:smoke-context", args: [] });
      } catch (error) {
        if (error?.code === "SMOKE_STORE_NOT_READY") return null;
        throw error;
      }
    }, "confirmed nonpersistent store");
    stage.phase = context.phase;
    stage.mode = context.plan.mode;
    const { project, model, plan } = context;
    stage.rendering = { syntheticReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, visibility: document.visibilityState };
    if (plan.resumeContent) expires = Date.now() + 45000;
    const sending = plan.mode === "send" || (plan.mode === "content" && !plan.resumeContent);
    const chatId = `${project}#${plan.sessionId}`;
    await wait(() => window.__rustDiagnostics?.ready && window.milagre, "production renderer bootstrap");
    const bridge = window.milagre;
    await wait(() => document.querySelector("[data-dock-layer]"), "mounted production workspace");
    button("Expand sidebar")?.click();
    const row = await wait(() => document.querySelector(`[data-chat-id="${plan.sessionId}"] button[data-row]`), "saved Chat sidebar row");
    row.click();
    stage.navigation = "production sidebar row";
    await wait(
      () => row.getAttribute("aria-current") === "page" && document.querySelector('[data-prompt-editor][contenteditable="true"]'),
      "selected Chat and mounted composer",
    );
    await wait(async () => (await bridge.getCurrentProject())?.path === project, "dedicated Project selected");
    const read = () => bounded(bridge.readChatMessages(project, plan.sessionId, { turns: 100, limit: 500 }), "saved Chat page");
    const before = await read();
    stage.before = { total: before.total, ids: before.messages.map((message) => message.id) };
    const callsBefore = window.__rustDiagnostics.calls.length;
    const getContent = (id) => bounded(bridge.artifacts.get({ chatId, id }), `saved content ${id}`);
    if (plan.mode === "content") {
      stage.content = {
        permissions: [],
        saveClicks: 0,
        opaqueFrameLimit: "HTML source marker, production helper ready, visible iframe and native capture; no sandbox DOM text inspection",
      };
      const catalog = await bounded(bridge.artifacts.list({ chatId }), "content catalog before send");
      if (context.phase === 0 && !plan.resumeContent) {
        if (catalog.some(({ id, format }) => format === "html" || id === plan.content.design.id))
          throw Error("Content creation requires no existing HTML page or planned Design ID");
        stage.content.absentBeforeSend = true;
      }
      if (plan.resumeContent) stage.content.resumedExisting = true;
    }
    let terminal;
    let permission;
    let unexpectedPermission;
    let eventOverflow = false;
    const contentRequests = [];
    const contentTools = new Set();
    const contentInput = (event) => {
      if (typeof event.detail !== "string" || event.detail.length > 20000) throw Error("Content approval detail is absent or exceeds 20,000 characters");
      const input = JSON.parse(event.detail);
      if (event.tool === "mcp__milagre__artifact_show" || (event.tool === "Artifact Show" && event.title === "Use artifact_show from milagre?")) {
        if (
          input.id !== plan.content.html.id ||
          typeof input.html !== "string" ||
          !input.html.includes(plan.content.html.marker) ||
          input.tabs ||
          input.assets?.length
        )
          throw Error("HTML approval does not match the planned ID and inline marker");
      } else if (event.tool === "mcp__milagre__design_show" || (event.tool === "Design Show" && event.title === "Use design_show from milagre?")) {
        const nodes = input.document?.nodes?.filter((node) => node.id === plan.content.design.nodeId);
        if (
          input.id !== plan.content.design.id ||
          input.from ||
          input.operations ||
          nodes?.length !== 1 ||
          nodes[0].type !== "text" ||
          nodes[0].text !== plan.content.design.beforeText
        )
          throw Error("Design approval does not match the planned ID and new text layer");
      } else throw Error("Unexpected content permission tool");
      return input;
    };
    off = bridge.onAgentEvent(({ chatId: target, event, seq }) => {
      if (target !== chatId || !event) return;
      if (stage.events.length >= 128 && event.type !== "text-delta") {
        const removable = stage.events.findIndex((item) => item.type === "text-delta");
        if (removable >= 0) stage.events.splice(removable, 1);
        else eventOverflow = true;
      }
      if (stage.events.length < 128) stage.events.push({ type: event.type, seq, requestId: event.requestId });
      if (["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type)) terminal = event;
      if (event.type === "permission-request") {
        if (plan.mode === "content") {
          try {
            if (context.phase !== 0 || contentTools.has(event.tool) || typeof event.requestId !== "string" || !event.requestId)
              throw Error("Repeated or unscoped content permission request");
            const input = contentInput(event);
            contentTools.add(event.tool);
            contentRequests.push({ event, input });
          } catch (error) {
            unexpectedPermission = event;
            stage.content.refusedPermission = { requestId: event.requestId, tool: event.tool, reason: error.message };
          }
        } else if (
          !plan.permission ||
          event.tool !== plan.permission.tool ||
          event.files?.length !== 1 ||
          event.files[0] !== plan.permission.path ||
          permission
        )
          unexpectedPermission = event;
        else permission = event;
      }
    });
    if (sending && context.phase === 0) {
      stage.step = "configured-model";
      const catalog = await bounded(bridge.getModels(project), "configured model catalog");
      const advertised = catalog.claude?.find((item) => item.id === model);
      if (!advertised) throw Error("Configured Claude model missing from owner catalog");
      const trigger = await wait(() => document.querySelector("[data-model-name]")?.closest("button"), "model picker trigger");
      trigger.click();
      (await wait(() => document.querySelector('[data-model-picker] button[aria-label="Claude"]'), "Claude picker tab")).click();
      const choice = await wait(
        () => [...document.querySelectorAll("[data-model-picker] button")].find((node) => node.textContent.includes(advertised.name)),
        "configured model row",
      );
      choice.click();
      await wait(() => document.querySelector("[data-model-name]")?.textContent === advertised.name, "configured model selected");
      document.querySelector("[data-model-name]").closest("button").click();
      await wait(() => !document.querySelector("[data-model-picker]"), "model picker closed");
      if (document.querySelector("[data-model-name]").closest("button").dataset.permissionMode !== "ask")
        throw Error("Native smoke requires the existing Chat in Ask mode");
      stage.step = "composer";
      const editor = await wait(() => document.querySelector('[data-prompt-editor][contenteditable="true"]'), "production composer");
      if (editor.textContent.trim()) throw Error("Composer already contains a draft; refusing to replace it");
      editor.focus();
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: plan.body }));
      await wait(() => editor.textContent === plan.body && button("Send") && !button("Send").disabled, "entered draft and enabled Send");
      stage.sendClicks++;
      button("Send").click();
      const sent = await wait(
        () => window.__rustDiagnostics.calls.slice(callsBefore).find((call) => call.method === "chat:send" && !call.pending),
        "production send acknowledgement",
      );
      if (sent.error) throw Error(sent.error);
      if (plan.permission) {
        stage.step = "permission";
        await wait(() => {
          if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
          return permission;
        }, "exact Write permission request");
        const card = await wait(() => {
          const cards = [...document.querySelectorAll('[data-slot="step-approval"], [aria-label="Tool approval"]')].filter((node) =>
            [...node.querySelectorAll("button")].some((item) => item.textContent.trim() === "Allow once"),
          );
          if (cards.length > 1) throw Error("Multiple visible permission cards; no answer sent");
          return cards[0];
        }, "single pending permission card");
        if (!card.textContent.includes(plan.permission.path)) {
          const details = [...card.querySelectorAll('button[aria-expanded="false"]')].find((node) => node.textContent.includes("Details"));
          if (details) details.click();
        }
        await wait(() => card.textContent.includes(plan.permission.path), "exact file visible in permission details");
        const label = plan.permission.decision === "allow" ? "Allow once" : "Deny";
        const answer = await wait(
          () => [...card.querySelectorAll("button")].find((node) => node.textContent.trim() === label && !node.disabled),
          "permission answer button",
        );
        stage.permission = {
          requestId: permission.requestId,
          tool: permission.tool,
          files: permission.files,
          decision: plan.permission.decision,
          button: label,
        };
        stage.permissionClicks++;
        answer.click();
      }
      stage.step = "terminal";
      for (;;) {
        if (terminal && !contentRequests.length) break;
        await wait(() => terminal || unexpectedPermission || contentRequests.length, "native event or terminal");
        if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
        const request = contentRequests.shift();
        if (request) {
          stage.step = "content-permission";
          const card = await wait(() => {
            if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
            const cards = [...document.querySelectorAll('[data-slot="step-approval"], [aria-label="Tool approval"]')].filter((node) =>
              [...node.querySelectorAll("button")].some((item) => item.textContent.trim() === "Allow once" && !item.disabled),
            );
            for (const node of cards) {
              const details = [...node.querySelectorAll('button[aria-expanded="false"]')].find((item) => item.textContent.includes("Details"));
              details?.click();
            }
            const matching = cards.filter((node) => [...node.querySelectorAll("pre code")].some((code) => code.textContent === request.event.detail));
            if (matching.length > 1) throw Error("Ambiguous content approval cards; no answer sent");
            return matching[0];
          }, "exact content permission JSON in production card");
          contentInput(request.event);
          if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
          const allow = [...card.querySelectorAll("button")].find((node) => node.textContent.trim() === "Allow once" && !node.disabled);
          if (!card.isConnected || !allow?.isConnected) throw Error("Exact content approval card changed before the click; no answer sent");
          stage.content.permissions.push({
            requestId: request.event.requestId,
            tool: request.event.tool,
            input: request.input,
            decision: "allow",
            button: "Allow once",
            detailVisible: true,
          });
          stage.permissionClicks++;
          allow.click();
          await wait(
            () => stage.events.some((event) => event.type === "permission-resolved" && event.requestId === request.event.requestId),
            "content permission resolved",
          );
          stage.step = "terminal";
        }
      }
      if (terminal.type !== "turn-completed") throw Error(`Native turn ended as ${terminal.type}`);
      if (!stage.events.some((event) => event.type === "text-delta")) throw Error("No streamed text event observed");
      if (plan.permission && !stage.events.some((event) => event.type === "permission-resolved" && event.requestId === permission.requestId))
        throw Error("Permission answer has no resolved event");
    }
    stage.step = "saved-and-visible";
    const after = await read();
    stage.after = {
      total: after.total,
      ids: after.messages.map((message) => message.id),
      users: after.messages.filter((message) => message.role === "user").length,
      assistants: after.messages.filter((message) => message.role === "assistant").length,
    };
    if (sending) {
      if (context.phase === 0 && after.total !== before.total + 2) throw Error("Send did not create exactly one user and one assistant message");
      if (!after.messages.some((message) => message.role === "user" && message.body === plan.body)) throw Error("Saved user text missing");
    }
    const lastReply = after.messages.findLast((message) => message.role === "assistant" && message.body?.trim());
    if (!lastReply) throw Error("Saved Chat has no assistant reply to inspect");
    const visible = plan.expectedText || lastReply.body.slice(0, 80);
    if (!lastReply.body.includes(visible)) throw Error("Saved reply does not contain expectedText");
    await wait(() => document.body.innerText.includes(visible), "saved assistant reply in production Chat");
    stage.visibleText = visible;
    if (plan.mode === "content") {
      const { html: htmlPlan, design: designPlan } = plan.content;
      const hash = async (value) => {
        const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
        if (bytes.length > 8 * 1024 * 1024) throw Error("Content observation exceeds 8 MiB");
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      };
      const reply = after.messages.findLast((message) => message.role === "assistant");
      if (context.phase === 0 && !plan.resumeContent && before.messages.some(({ id }) => id === reply?.id))
        throw Error("Content was not created in this new assistant turn");
      stage.content.toolSteps = (reply?.steps || [])
        .filter((step) => step.artifact?.id === htmlPlan.id || step.artifact?.id === designPlan.id)
        .map((step) => ({ id: step.id, tool: step.tool, status: step.status, artifact: step.artifact, source: step.source, input: step.input }));
      for (const [id, tool] of [
        [htmlPlan.id, "artifact_show"],
        [designPlan.id, "design_show"],
      ])
        if (!stage.content.toolSteps.some((step) => step.tool === tool && step.status === "done" && step.artifact.id === id))
          throw Error(`Saved assistant turn lacks completed ${tool} reference ${id}`);
      const html = await getContent(htmlPlan.id);
      const design = await getContent(designPlan.id);
      if (
        html.id !== htmlPlan.id ||
        html.format !== "html" ||
        !Number.isSafeInteger(html.version) ||
        html.version < 1 ||
        !html.html?.includes(htmlPlan.marker) ||
        html.tabs?.length
      )
        throw Error("Saved HTML page does not match the explicit inline content plan");
      const designState = async (value) => {
        const nodes = value.document?.nodes?.filter((node) => node.id === designPlan.nodeId);
        if (
          value.id !== designPlan.id ||
          value.format !== "design" ||
          !Number.isSafeInteger(value.version) ||
          value.version < 1 ||
          nodes?.length !== 1 ||
          nodes[0].type !== "text"
        )
          throw Error("Saved Design does not contain the planned text layer");
        return { id: value.id, version: value.version, nodeId: nodes[0].id, text: nodes[0].text, sha256: await hash(value.document) };
      };
      stage.content.html = { id: html.id, version: html.version, sha256: await hash(html.html), sourceMarker: htmlPlan.marker };
      stage.content.designBefore = await designState(design);
      if (stage.content.designBefore.text !== (context.phase === 0 ? designPlan.beforeText : designPlan.afterText))
        throw Error("Saved Design text differs from the planned phase");
      stage.step = "content-html";
      // A provider-created Design can automatically open its panel while streaming.
      button("Close designs")?.click();
      button("Close artifacts")?.click();
      await wait(() => !document.querySelector('[data-slot="artifact-dock"]'), "content panels closed before HTML observation");
      const readyFrames = new WeakSet();
      const onFrameMessage = (event) => {
        if (event.data?.milagre !== "milagre:artifact-page" || event.data.t !== "ready") return;
        const frame = [...document.querySelectorAll('[data-slot="artifact-dock"][aria-label="Artifacts"] iframe')].find(
          (item) => item.contentWindow === event.source,
        );
        if (frame) readyFrames.add(frame);
      };
      window.addEventListener("message", onFrameMessage);
      removeFrameListener = () => window.removeEventListener("message", onFrameMessage);
      (await wait(() => button("Toggle artifacts panel"), "Artifacts toggle")).click();
      const htmlFrame = await wait(() => {
        const frame = document.querySelector('[data-slot="artifact-dock"][aria-label="Artifacts"] iframe[src^="milagre-artifact:"]');
        if (!frame || !readyFrames.has(frame)) {
          const errors = (window.__rustDiagnostics?.errors || [])
            .slice(-3)
            .map(({ method, code }) => `${method}:${code}`)
            .join(",");
          progress(`HTML preview: frame=${Boolean(frame)}, ready=${Boolean(frame && readyFrames.has(frame))}, errors=${errors}`.slice(0, 256));
          const failure = (window.__rustDiagnostics?.errors || []).findLast(({ method }) => method === "artifact-preview:register");
          if (failure) throw Error(`Native Artifact preview registration failed: ${failure.code}: ${failure.message}`);
        }
        return frame && readyFrames.has(frame) && frame.getBoundingClientRect().width > 0 && frame.getBoundingClientRect().height > 0 ? frame : null;
      }, "HTML iframe and production helper ready");
      let parentReadDenied = false;
      try {
        void htmlFrame.contentWindow.document.body;
      } catch {
        parentReadDenied = true;
      }
      if (!parentReadDenied || htmlFrame.getAttribute("sandbox")?.includes("allow-same-origin")) throw Error("HTML preview lost its opaque sandbox");
      if (document.querySelector('[data-slot="artifact-dock-title"]')?.textContent !== html.title) throw Error("HTML panel displays the wrong page title");
      stage.content.htmlPreview = {
        ready: true,
        parentReadDenied,
        width: htmlFrame.getBoundingClientRect().width,
        height: htmlFrame.getBoundingClientRect().height,
        title: html.title,
      };
      if (!htmlFrame.isConnected) throw Error("HTML frame changed before native capture");
      const captured = await bounded(
        window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify({ phase: context.phase, checkpoint: "html" }) }),
        "native HTML capture",
      );
      if (!captured.captured) throw Error("Native HTML capture not confirmed");
      button("Close artifacts").click();
      await wait(() => !document.querySelector('[data-slot="artifact-dock"][aria-label="Artifacts"]'), "HTML panel closed");
      stage.step = "content-design";
      (await wait(() => button("Toggle designs panel"), "Designs toggle")).click();
      const frameSelector = `[data-slot="artifact-frame"][data-artifact="${CSS.escape(designPlan.id)}"]`;
      await wait(() => document.querySelector(`${frameSelector} [data-design-body][data-painted="true"]`), "production Design canvas painted");
      (await wait(() => document.querySelector(`${frameSelector} [data-slot="artifact-edit"]`), "Edit Design control")).click();
      await wait(() => document.querySelector('[data-slot="design-editor"]'), "Design editor");
      const layers = await wait(() => document.querySelector('[data-slot="design-layers-toggle"]'), "Design Layers toggle");
      if (layers.getAttribute("aria-expanded") !== "true") layers.click();
      (await wait(() => document.querySelector(`button[data-node-id="${CSS.escape(designPlan.nodeId)}"]`), "planned text layer")).click();
      let field = await wait(() => document.querySelector('textarea[aria-label="Text"]'), "Design Text inspector");
      if (field.value !== stage.content.designBefore.text) throw Error("Design inspector differs from saved source");
      if (context.phase === 0) {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, designPlan.afterText);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.blur();
        const save = await wait(() => {
          const node = document.querySelector('[data-slot="design-save"]');
          return node && !node.disabled ? node : null;
        }, "enabled Design Save");
        stage.content.saveClicks++;
        save.click();
      }
      const saved = await wait(async () => {
        const value = await getContent(designPlan.id);
        return value.version === design.version + (context.phase === 0 ? 1 : 0) &&
          value.document?.nodes?.some((node) => node.id === designPlan.nodeId && node.text === designPlan.afterText)
          ? value
          : null;
      }, "saved Design version and edited text reread");
      stage.content.designSaved = await designState(saved);
      await wait(
        () =>
          document.querySelector('[data-slot="design-save"]')?.disabled &&
          button("Close design editor") &&
          !button("Close design editor").disabled &&
          !document.querySelector('[data-slot="design-save-status"]')?.textContent.includes("Saving") &&
          !document.querySelector('[data-slot="design-preview-error"]'),
        "saved Design editor state",
      );
      field = document.querySelector('textarea[aria-label="Text"]');
      if (field?.value !== designPlan.afterText) throw Error("Saved Design inspector lost the edit");
      const preview = document.querySelector(
        `[data-slot="design-page-frame"][data-design-id="${CSS.escape(designPlan.id)}"] [data-slot="design-editor-preview"] iframe`,
      );
      if (!preview || preview.getBoundingClientRect().width <= 0 || preview.getBoundingClientRect().height <= 0)
        throw Error("Edited Design preview is not visible");
      stage.content.designPreview = {
        canvasPainted: true,
        editorVisible: true,
        inspectorText: field.value,
        width: preview.getBoundingClientRect().width,
        height: preview.getBoundingClientRect().height,
        status: document.querySelector('[data-slot="design-save-status"]')?.textContent,
      };
      stage.content.applyCalls = window.__rustDiagnostics.calls.slice(callsBefore).filter((call) => call.method === "artifact:apply").length;
      if (stage.content.applyCalls !== (context.phase === 0 ? 1 : 0)) throw Error("Unexpected Design save/replay count");
    }
    const state = await bounded(bridge.readState(project), "owner state");
    stage.epoch = state.epoch;
    stage.nativeId = state.state.sessions[String(plan.sessionId)].native_session_id;
    if (eventOverflow) throw Error("Native event evidence exceeded its bounded capacity");
    if (unexpectedPermission) throw Error("Unexpected native permission request; no answer sent");
    stage.sendCalls = window.__rustDiagnostics.calls.slice(callsBefore).filter((call) => call.method === "chat:send").length;
    if (stage.sendCalls !== (sending && context.phase === 0 ? 1 : 0)) throw Error("Unexpected send/replay count");
    for (const animation of document.getAnimations())
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try {
          animation.finish();
        } catch {}
      }
    stage.rendererErrors = window.__rustDiagnostics.errors.map(({ method, code, message }) => ({ method, code, message }));
    stage.step = "complete";
    stage.passed = true;
  } catch (error) {
    stage.error = error.message || String(error);
    stage.rendererErrors = (window.__rustDiagnostics?.errors || []).slice(-60).map(({ method, code, message }) => ({ method, code, message }));
    progress(`failed: ${stage.error}`.slice(0, 256));
  } finally {
    off?.();
    removeFrameListener?.();
  }
  progress("submitting final stage");
  await window.__TAURI__.core.invoke("smoke_result", { value: JSON.stringify(stage) });
})();
