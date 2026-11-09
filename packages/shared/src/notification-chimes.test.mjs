import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFICATION_CHIMES,
  notificationChimeChannel,
  notificationChimeFile,
  notificationChimeLabel,
  notificationChimeSound,
  parseNotificationChime,
} from "./notification-chimes.mjs";

test("unknown or missing chimes fall back to the system sound", () => {
  assert.equal(parseNotificationChime("miracle"), "miracle");
  assert.equal(parseNotificationChime("air-horn"), "system");
  assert.equal(parseNotificationChime(undefined), "system");
  assert.equal(notificationChimeLabel("nope"), "System default");
});

test("a chime names its bundled file, push sound and Android channel", () => {
  assert.equal(notificationChimeFile("system"), null);
  assert.equal(notificationChimeSound("system"), "default");
  assert.equal(notificationChimeChannel("system"), "chats");
  assert.equal(notificationChimeFile("bombastic-side-eye"), "chime_bombastic_side_eye");
  assert.equal(notificationChimeSound("bombastic-side-eye"), "chime_bombastic_side_eye.wav");
  assert.equal(notificationChimeChannel("bombastic-side-eye"), "chats-bombastic_side_eye");
});

test("every bundled file name is a valid Android raw resource", () => {
  for (const { id } of NOTIFICATION_CHIMES) {
    const file = notificationChimeFile(id);
    if (file) assert.match(file, /^[a-z][a-z0-9_]*$/);
  }
});
