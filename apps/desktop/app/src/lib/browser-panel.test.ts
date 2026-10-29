import assert from "node:assert/strict";
import test from "node:test";
import {
  addBlankTab,
  addressToUrl,
  chatBrowser,
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  openInBrowserPanel,
  registerBrowserHost,
  setBrowserOpen,
  takeNavigation,
} from "./browser-panel.ts";

test("addressToUrl: addresses load, local ones over http, anything else is a search", () => {
  assert.equal(addressToUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(addressToUrl("localhost:5173"), "http://localhost:5173");
  assert.equal(addressToUrl("localhost"), "http://localhost");
  assert.equal(addressToUrl("127.0.0.1:3000/x"), "http://127.0.0.1:3000/x");
  assert.equal(addressToUrl("192.168.2.210:8081"), "http://192.168.2.210:8081");
  assert.equal(addressToUrl("santo.local:3000"), "http://santo.local:3000");
  assert.equal(addressToUrl("example.com"), "https://example.com");
  assert.equal(addressToUrl("milagre.cloud/docs?x=1"), "https://milagre.cloud/docs?x=1");
  assert.equal(addressToUrl("how to center a div"), "https://www.google.com/search?q=how%20to%20center%20a%20div");
  assert.equal(addressToUrl("react"), "https://www.google.com/search?q=react");
  assert.equal(addressToUrl("   "), "about:blank");
});

test("opening the panel with no page starts on a blank tab; a link then takes that tab", () => {
  const chat = "/p#open";
  setBrowserOpen(chat, true);
  const blank = chatBrowser(chat);
  assert.equal(blank.open, true);
  assert.equal(blank.tabs.length, 1);
  assert.equal(blank.tabs[0]!.url, "about:blank");
  const id = openBrowserTab(chat, "http://localhost:5173/");
  assert.equal(id, blank.tabs[0]!.id);
  assert.equal(chatBrowser(chat).tabs.length, 1);
  assert.equal(chatBrowser(chat).tabs[0]!.url, "http://localhost:5173/");
  // The blank tab's page doesn't exist yet: it opens on that address.
  assert.equal(takeNavigation(id), "http://localhost:5173/");
});

test("the same address shows its tab again; another one gets a tab, or waits behind when background", () => {
  const chat = "/p#tabs";
  const first = openBrowserTab(chat, "http://localhost:3000/");
  assert.equal(openBrowserTab(chat, "http://localhost:3000/"), first);
  const second = openBrowserTab(chat, "http://localhost:4000/");
  assert.notEqual(second, first);
  assert.equal(chatBrowser(chat).active, second);
  const third = openBrowserTab(chat, "http://localhost:5000/", { background: true });
  assert.equal(chatBrowser(chat).active, second);
  assert.deepEqual(
    chatBrowser(chat).tabs.map((tab) => tab.id),
    [first, second, third],
  );
});

test("closing a tab shows its right neighbour, then its left; the last one closes the panel", () => {
  const chat = "/p#close";
  const a = openBrowserTab(chat, "http://a.test/");
  const b = openBrowserTab(chat, "http://b.test/");
  const c = openBrowserTab(chat, "http://c.test/");
  closeBrowserTab(chat, b);
  assert.equal(chatBrowser(chat).active, c);
  closeBrowserTab(chat, c);
  assert.equal(chatBrowser(chat).active, a);
  closeBrowserTab(chat, a);
  assert.deepEqual(chatBrowser(chat), { open: false, tabs: [], active: null });
});

test("typing an address shows it at once and leaves it for the page to load", () => {
  const chat = "/p#nav";
  addBlankTab(chat);
  const tab = chatBrowser(chat).tabs[0]!;
  navigateBrowserTab(chat, tab.id, "https://example.com/");
  assert.equal(chatBrowser(chat).tabs[0]!.url, "https://example.com/");
  assert.equal(chatBrowser(chat).tabs[0]!.loading, true);
  assert.equal(takeNavigation(tab.id), "https://example.com/");
  assert.equal(takeNavigation(tab.id), undefined);
});

test("a reply's localhost link opens in the panel of the Chat that mounted last, and nowhere once none is", () => {
  assert.equal(openInBrowserPanel("http://localhost:1/"), false);
  const offA = registerBrowserHost("/p#a");
  const offB = registerBrowserHost("/p#b");
  assert.equal(openInBrowserPanel("http://localhost:2/"), true);
  assert.equal(chatBrowser("/p#b").tabs.at(-1)!.url, "http://localhost:2/");
  offB();
  assert.equal(openInBrowserPanel("http://localhost:3/"), true);
  assert.equal(chatBrowser("/p#a").tabs.at(-1)!.url, "http://localhost:3/");
  offA();
  assert.equal(openInBrowserPanel("http://localhost:4/"), false);
});
