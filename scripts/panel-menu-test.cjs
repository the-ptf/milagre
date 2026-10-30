// Panels other than Browser live in Chat actions. Navigate the real menu before checking or using one.
const { setTimeout: delay } = require("node:timers/promises");
function panelMenuHelpers(evaluate) {
  async function evaluatePanel(source) {
    const opened = await evaluate(`(() => {
      const trigger = document.querySelector('button[aria-label="Chat actions"][aria-haspopup="menu"]');
      if (trigger && trigger.getAttribute('aria-expanded') !== 'true') { window.panelMenuPreviousFocus = document.activeElement; trigger.click(); return true; }
      return false;
    })()`);
    if (opened) {
      for (let i = 0; i < 100; i++) {
        if (await evaluate('!!document.querySelector(\'[role="menu"][aria-label="Chat actions"]\')')) break;
        await delay(10);
      }
    }
    try {
      return await evaluate(source);
    } finally {
      if (opened && !source.includes(".click("))
        await evaluate(`(() => {
        const trigger = document.querySelector('button[aria-label="Chat actions"][aria-expanded="true"]');
        trigger?.click();
        window.panelMenuPreviousFocus?.focus();
        delete window.panelMenuPreviousFocus;
      })()`);
    }
  }
  async function waitForPanel(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluatePanel(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out in Chat actions: ${source}`);
  }
  return { evaluatePanel, waitForPanel };
}
module.exports = { panelMenuHelpers };
