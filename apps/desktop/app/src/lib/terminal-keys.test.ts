import assert from "node:assert/strict";
import test from "node:test";
import { terminalKey } from "./terminal-keys.ts";

const press = (key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key,
  ctrlKey: Boolean(modifiers.ctrl),
  shiftKey: Boolean(modifiers.shift),
  altKey: Boolean(modifiers.alt),
  metaKey: Boolean(modifiers.meta),
});
const mac = { mac: true, windows: false };
const windows = { mac: false, windows: true };
const linux = { mac: false, windows: false };

test("on Windows Ctrl+C copies a selection and interrupts without one", () => {
  assert.equal(terminalKey(press("c", { ctrl: true }), windows, true), "copy");
  assert.equal(terminalKey(press("c", { ctrl: true }), windows, false), "shell");
});

test("on Windows Ctrl+V pastes, and other Ctrl keys reach the shell", () => {
  assert.equal(terminalKey(press("v", { ctrl: true }), windows, false), "paste");
  assert.equal(terminalKey(press("d", { ctrl: true }), windows, true), "shell");
  assert.equal(terminalKey(press("c"), windows, true), "shell");
});

test("AltGr, which Windows reports as Ctrl+Alt, still types", () => {
  assert.equal(terminalKey(press("c", { ctrl: true, alt: true }), windows, true), "shell");
  assert.equal(terminalKey(press("v", { ctrl: true, alt: true }), windows, false), "shell");
});

test("Ctrl+Shift+C and V copy and paste off macOS, and other Ctrl+Shift keys stay the app's", () => {
  for (const platform of [windows, linux]) {
    assert.equal(terminalKey(press("C", { ctrl: true, shift: true }), platform, true), "copy");
    assert.equal(terminalKey(press("V", { ctrl: true, shift: true }), platform, false), "paste");
    assert.equal(terminalKey(press("K", { ctrl: true, shift: true }), platform, false), "app");
  }
});

test("Linux keeps Ctrl+C and Ctrl+V for the shell", () => {
  assert.equal(terminalKey(press("c", { ctrl: true }), linux, true), "shell");
  assert.equal(terminalKey(press("v", { ctrl: true }), linux, false), "shell");
});

test("macOS leaves ⌘ to the app and every Ctrl key to the shell", () => {
  assert.equal(terminalKey(press("c", { meta: true }), mac, true), "app");
  assert.equal(terminalKey(press("c", { ctrl: true }), mac, true), "shell");
  assert.equal(terminalKey(press("v", { ctrl: true, shift: true }), mac, false), "shell");
});
