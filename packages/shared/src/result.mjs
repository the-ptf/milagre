/** Electron serializes thrown errors as strings, losing custom fields. */
export function ipcErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
export function ipcErrorCode(error) {
  if (typeof error?.code === "string") return error.code;
  const message = ipcErrorMessage(error);
  return /^([A-Z][A-Z0-9_]+)(?:: |$)/.exec(message)?.[1];
}
