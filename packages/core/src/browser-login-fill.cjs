const WORLD = "milagre-login";
const MARK = "data-milagre-login";

/**
 * Runs in Milagre's isolated world of the field's own frame, where the page's scripts can't replace a prototype or a
 * getter. It reads where the field is, refuses or sets the value, all in one turn of that frame, so the field that was
 * checked is the field that gets the value.
 */
const FILL = `function (expected, field, value) {
  if (this.ownerDocument !== document) return { elsewhere: true };
  const origins = [];
  let view = window;
  for (;;) {
    let origin = null;
    try { origin = view.origin; } catch {}
    origins.push(origin);
    if (view === view.top) break;
    view = view.parent;
  }
  const native = (element, name) =>
    Object.getOwnPropertyDescriptor(element instanceof HTMLButtonElement ? HTMLButtonElement.prototype : element instanceof HTMLFormElement ? HTMLFormElement.prototype : HTMLInputElement.prototype, name).get.call(element);
  const attribute = (element, name) => Element.prototype.getAttribute.call(element, name);
  const withinRoot = (root) => (root instanceof Document ? Document.prototype : DocumentFragment.prototype).querySelectorAll.call(root, "button, input");
  const base = Object.getOwnPropertyDescriptor(Node.prototype, "baseURI").get.call(document);
  const form = this instanceof HTMLInputElement ? native(this, "form") : null;
  const submitters = form
    ? [...withinRoot(Node.prototype.getRootNode.call(form))].filter(
        (element) => (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && native(element, "form") === form && ["submit", "image"].includes(native(element, "type")),
      )
    : [];
  const originOf = (address) => { try { return new URL(address, base).origin; } catch { return null; } };
  const sendsTo = [
    ...(form && attribute(form, "action") !== null ? [originOf(attribute(form, "action"))] : []),
    ...submitters.filter((button) => attribute(button, "formaction") !== null).map((button) => originOf(attribute(button, "formaction"))),
  ];
  const formMethod = form ? native(form, "method") : null;
  const place = {
    origins,
    tag: this.tagName,
    type: this instanceof HTMLInputElement ? this.type.toLowerCase() : "",
    getForm:
      Boolean(form) &&
      (String(attribute(form, "method") ?? "").trim().toLowerCase() === "get" ||
        submitters.some(
          (button) => attribute(button, "formmethod") !== null && native(button, "formMethod") === "get",
        )),
    sendsTo,
  };
  const problem = (${refusal.toString()})(field, place, expected);
  if (problem) return { problem };
  if (formMethod === "get") Element.prototype.setAttribute.call(form, "method", "post");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, value);
  try {
    const top = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement").get.call(window.top.document);
    Element.prototype.setAttribute.call(top, "${MARK}", "");
  } catch {}
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true };
}`;

/**
 * Why the field can't take this login's value, or null. Every frame up to the top must be on the login's own origin
 * (its effective origin, so a sandboxed frame reads as "null"), the form can't send the fields in the address or to
 * another site, and each value goes only into its kind of field.
 */
function refusal(field, place, origin) {
  if (!place || !Array.isArray(place.origins) || !place.origins.length) return "The field couldn't be checked.";
  if (place.origins.some((frame) => frame !== origin)) return `The field isn't on ${origin} in every frame, so the login wasn't filled.`;
  if (place.getForm) return "The form sends its fields in the address, so the login wasn't filled.";
  if ((place.sendsTo ?? []).some((target) => target !== origin)) return `The form sends its fields away from ${origin}, so the login wasn't filled.`;
  if (place.tag !== "INPUT") return "The login goes only into an input field.";
  if (field === "password" && place.type !== "password") return "The password goes only into a password field.";
  if (field === "username" && !["text", "email", "tel", ""].includes(place.type)) return "The username goes only into a text or email field.";
  return null;
}

function frameIds(tree) {
  return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)];
}

/**
 * Sets a saved login's username or password on a page field, after checking from an isolated world that the field
 * and every frame above it are on the login's site. The value travels as a CDP argument, never in page script, and is
 * never returned: the agent learns only that it was filled. Throws the reason when it wasn't.
 */
async function fillLogin({ session, node, login, field }) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const value = field === "password" ? login.password : login.username;
  for (const frameId of frameIds(frameTree)) {
    const world = await session.send("Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(() => null);
    if (!world) continue;
    const resolved = await session.send("DOM.resolveNode", { backendNodeId: node, executionContextId: world.executionContextId }).catch(() => null);
    if (!resolved?.object?.objectId) continue;
    const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: FILL,
      arguments: [{ value: login.origin }, { value: field }, { value }],
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error("The field couldn't be checked, so the login wasn't filled.");
    const outcome = result?.value;
    if (outcome?.elsewhere) continue;
    if (outcome?.problem) throw Object.assign(new Error(outcome.problem), { code: REFUSED });
    if (outcome?.filled) return;
    break;
  }
  throw Object.assign(new Error("The field couldn't be checked, so the login wasn't filled."), { code: REFUSED });
}

const REFUSED = "login-refused";
const SCRIPTED = "The agent's script ran on this page, so a saved login isn't filled until the page loads again. Reload or navigate first.";
const FILLED =
  "A saved login was filled on this page, so its script can't be read until the page loads another document. Use browser_snapshot, or navigate first.";

/**
 * Which documents held a filled login or ran the agent's script, by tab and top-frame loader, so the rule outlives a
 * debugger reconnect and ends only when the tab loads another document. A tab runs a login fill or the agent's script,
 * never both at once, and a script marks the document it ended in too, so a navigation in between can't split them.
 * Nothing is forgotten while Milagre runs: an entry is one per document, not per call.
 */
function createLoginGuard() {
  const filled = new Set();
  const scripted = new Set();
  const unknown = new Set();
  const tabs = new Map();
  const tab = (target) => {
    if (!tabs.has(target.id)) tabs.set(target.id, { fills: 0, scripts: 0 });
    return tabs.get(target.id);
  };
  const documentOf = async (session, target) => {
    const { frameTree } = await session.send("Page.getFrameTree");
    return `${target.id}:${frameTree.frame.loaderId ?? frameTree.frame.id}`;
  };
  return {
    async fill(session, target, run) {
      const busy = tab(target);
      busy.fills++;
      try {
        if (unknown.has(target.id))
          throw new Error("Milagre couldn't tell which page the agent's script ended on, so this tab takes no saved login. Open the page in a new tab.");
        if (busy.scripts) throw new Error(SCRIPTED);
        const key = await documentOf(session, target);
        if (scripted.has(key)) throw new Error(SCRIPTED);
        await run(() => filled.add(key));
        filled.add(key);
      } finally {
        busy.fills--;
      }
    },
    /**
     * The agent's script with a first statement that refuses, in the same turn, in a document where a login was filled,
     * whichever document a navigation brought back between the check and the call. No eval, so a page's CSP doesn't
     * matter; the script's last value is still the result. A declaration that shadows `document` or `Error` stops the
     * script before its own code runs.
     */
    expression: (expression) =>
      `if (document.documentElement && document.documentElement.hasAttribute(${JSON.stringify(MARK)})) throw new Error(${JSON.stringify(FILLED)});\n${expression}`,
    async script(session, target, run) {
      const busy = tab(target);
      busy.scripts++;
      try {
        if (busy.fills) throw new Error(FILLED);
        const key = await documentOf(session, target);
        if (filled.has(key)) throw new Error(FILLED);
        scripted.add(key);
        try {
          return await run();
        } finally {
          const after = await documentOf(session, target).catch(() => null);
          if (after) scripted.add(after);
          else unknown.add(target.id);
        }
      } finally {
        busy.scripts--;
      }
    },
  };
}

module.exports = { fillLogin, refusal, FILL, createLoginGuard, REFUSED, MARK };
