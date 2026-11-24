/** Handheld mode on the phone: the screen fills the view with no bezel or controls, and the native overlay presses the hidden controls. */
export const SIMULATOR_HANDHELD_STYLE =
  "html[data-handheld=true] body{background:#000}html[data-handheld=true] #rail,html[data-handheld=true] #extras,html[data-handheld=true] #device::before,html[data-handheld=true] #device::after{display:none}html[data-handheld=true] #viewport{padding:0}html[data-handheld=true] #device{background:none;box-shadow:none}";

/** Serialized into the simulator receiver with it, so it must not close over module state. */
export function simulatorHandheldControls(layout, buttons, initial) {
  window.simulatorHandheld = (on) => {
    document.documentElement.dataset.handheld = String(!!on);
    layout();
  };
  window.simulatorAction = (name) => {
    const button = Object.hasOwn(buttons, name) ? buttons[name] : null;
    if (button && !button.disabled && !button.hidden) button.click();
  };
  window.simulatorHandheld(initial);
}
