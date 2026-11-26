const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const { MAX_HTML } = require("./design-html.cjs");

const MAX_TABS = 20;
function checkTabs(tabs, current) {
  if (tabs === undefined) return null;
  if (!Array.isArray(tabs) || !tabs.length || tabs.length > MAX_TABS) throw Error(`A page has between 1 and ${MAX_TABS} tabs.`);
  const seen = new Set();
  const checked = tabs.map((tab) => {
    if (typeof tab?.id !== "string" || !ID.test(tab.id)) throw Error("Tab ids are lowercase letters, digits and dashes.");
    if (seen.has(tab.id)) throw Error(`Two tabs have the id ${tab.id}.`);
    seen.add(tab.id);
    if (typeof tab.title !== "string" || !tab.title.trim()) throw Error(`The tab ${tab.id} needs a title.`);
    const html = tab.html ?? current?.find((item) => item.id === tab.id)?.html;
    if (typeof html !== "string" || !html.trim())
      throw Error(`The tab ${tab.id} needs its HTML: only a tab the page already has keeps its HTML when you leave it out.`);
    return { id: tab.id, title: tab.title.trim().slice(0, 60), html };
  });
  if (checked.reduce((sum, tab) => sum + tab.html.length, 0) > MAX_HTML) throw Error(`A page's tabs are limited to ${MAX_HTML} characters together.`);
  return checked;
}

module.exports = { MAX_TABS, checkTabs };
