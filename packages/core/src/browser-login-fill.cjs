const CHECK = `function () {
  const origins = [this.ownerDocument.location.origin];
  let view = this.ownerDocument.defaultView;
  while (view && view !== view.top) {
    try {
      origins.push(view.parent.location.origin);
    } catch {
      origins.push(null);
    }
    view = view.parent;
  }
  const form = this.form;
  const getForm = Boolean(form && form.hasAttribute("action") && String(form.method).toLowerCase() === "get");
  return { origins, tag: this.tagName, type: String(this.type || "").toLowerCase(), getForm };
}`;

const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);

/** Why the field can't take this login's value, or null. Every frame up to the top must be on the login's own origin. */
function refusal(field, place, origin) {
  if (!place || !Array.isArray(place.origins) || !place.origins.length) return "The field couldn't be checked.";
  if (place.origins.some((frame) => frame !== origin)) return `The field isn't on ${origin} in every frame, so the login wasn't filled.`;
  if (place.getForm) return "The form sends its fields in the address, so the login wasn't filled.";
  if (place.tag !== "INPUT") return "The login goes only into an input field.";
  if (field === "password" && place.type !== "password") return "The password goes only into a password field.";
  if (field === "username" && !USERNAME_TYPES.has(place.type)) return "The username goes only into a text or email field.";
  return null;
}

/**
 * Types a saved login's username or password into a page field after checking where the field is. The value is typed
 * through the browser's input, never returned: the agent learns only that it was filled.
 */
async function fillLogin({ session, node, login, field, onElement }) {
  const place = await onElement(session, node, CHECK);
  const problem = refusal(field, place, login.origin);
  if (problem) throw new Error(problem);
  await session.send("DOM.focus", { backendNodeId: node }).catch(() => {});
  await onElement(
    session,
    node,
    `function () {
      this.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set;
      if (setter) setter.call(this, ""); else this.value = "";
      this.dispatchEvent(new Event("input", { bubbles: true }));
    }`,
  );
  await session.send("Input.insertText", { text: field === "password" ? login.password : login.username });
}

module.exports = { fillLogin, refusal };
