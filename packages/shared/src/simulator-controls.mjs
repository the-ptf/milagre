// The receiver page gets this function serialized, so it must stay self-contained: no imports, no module state.

/** Which rail controls the viewer hides for a device, by its status or else its listing. Older hosts send no capabilities: every control its platform offers. */
export function simulatorHiddenControls(device, status) {
  const capabilities = status?.capabilities ?? device?.capabilities;
  const can = (name) => !Array.isArray(capabilities) || capabilities.includes(name);
  return {
    back: device?.platform !== "android" || !can("back"),
    home: !can("home"),
    rotate: !can("rotate"),
    repair: device?.platform === "android" || !can("repair"),
    keyboard: !can("keyboard"),
    typingStatus: status && !can("keyboard") ? { ...status, keyboard: false, copy: false } : status,
  };
}
