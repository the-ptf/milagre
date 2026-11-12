const { ipcErrorMessage } = require("@milagre/shared/result");
/** Convert the editor adapter's historical null/string return into the wire Result. */
/**
 * @param {{ editors: () => Promise<import("@milagre/core/editors").DetectedEditor[]>; open: typeof import("@milagre/core/editors").openInEditor; checkRoot?: (root: string) => Promise<void | string[]> }} options
 * @returns {(request: import("@milagre/core/editors").EditorRequest | null) => Promise<import("@milagre/shared/result").Result<null>>}
 */
function createEditorOpener({ editors, open, checkRoot }) {
  return async (request) => {
    try {
      if (!request || typeof request.root !== "string") return failure("File not found");
      const fallbacks = Array.isArray(request.fallbacks) ? request.fallbacks.filter((file) => typeof file === "string") : undefined;
      const message = await open(
        { root: request.root, path: request.path, line: request.line, editor: request.editor, ...(fallbacks?.length ? { fallbacks } : {}) },
        { editors: await editors(), ...(checkRoot ? { checkRoot } : {}) },
      );
      return message ? failure(message) : { ok: true, value: null };
    } catch (error) {
      return failure(ipcErrorMessage(error));
    }
  };
}
/** @param {string} message @returns {{ok: false; error: { code: string; message: string }}} */
const failure = (message) => ({ ok: false, error: { code: "EDITOR_OPEN", message } });
module.exports = { createEditorOpener };
