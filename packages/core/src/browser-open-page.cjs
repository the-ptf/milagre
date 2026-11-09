const { setTimeout: delay } = require("node:timers/promises");

/** Ask the desktop to open a page, then return that Chat's registered target for the phone viewer. */
async function openBrowserPage(browsers, openInPanel, { chatId, url }, timeout = 10000) {
  if (typeof chatId !== "string" || !chatId.trim()) throw new Error("Open a Chat before opening a browser page.");
  if (typeof url !== "string" || url.length > 2000 || !/^https?:\/\//i.test(url)) throw new Error("Only http and https pages open in the Browser panel.");
  const address = new URL(url).href;
  openInPanel(chatId, address);
  const until = Date.now() + timeout;
  do {
    const { targets } = await browsers.list({ chatId });
    const target = targets.find((item) => item.source === "panel" && item.url.replace(/\/$/, "") === address.replace(/\/$/, ""));
    if (target) return target;
    if (Date.now() >= until) break;
    await delay(400);
  } while (Date.now() < until);
  throw new Error("The Browser page did not open. Open Milagre on your computer and retry.");
}

module.exports = { openBrowserPage };
