import assert from "node:assert/strict";
import test from "node:test";
import { cloudflarePhonesNote, pairingWindow, phoneLanLine, phoneQrSrc, phoneStatusLine } from "./phone.ts";
import { ThisComputer } from "./shortcut-hints.ts";

test("the status line says what is happening and where the phone can reach this Mac", () => {
  assert.equal(phoneStatusLine(null), "Checking…");
  assert.equal(phoneStatusLine({ enabled: false, state: "off", remote: "none" }), "Off");
  assert.equal(phoneStatusLine({ enabled: true, state: "starting", remote: "cloudflare" }), "Starting…");
  assert.equal(phoneStatusLine({ enabled: true, state: "error", remote: "none", error: "Address already in use" }), "Address already in use");
  assert.equal(
    phoneStatusLine({ enabled: true, state: "on", remote: "cloudflare", localUrl: "http://127.0.0.1:8797", publicUrl: "https://mac.example.com" }),
    "Reachable at mac.example.com",
  );
  assert.equal(phoneStatusLine({ enabled: true, state: "on", remote: "none", localUrl: "http://127.0.0.1:8797" }), `${ThisComputer} only — 127.0.0.1`);
  assert.equal(
    phoneStatusLine({ enabled: true, state: "on", remote: "relay", relay: "online", localUrl: "http://127.0.0.1:8797" }),
    "On, reachable from any network",
  );
  assert.equal(
    phoneStatusLine({ enabled: true, state: "on", remote: "relay", relay: "connecting", localUrl: "http://127.0.0.1:8797" }),
    "On, connecting to the relay…",
  );
  assert.equal(
    phoneStatusLine({ enabled: true, state: "on", remote: "relay", relay: "offline", localUrl: "http://127.0.0.1:8797" }),
    "On, can't reach the relay. Retrying…",
  );
});

test("the pairing window counts whole minutes up and closes at the deadline", () => {
  const status = (pairingUntil?: number) => ({ enabled: true, state: "on" as const, remote: "relay" as const, relay: "online" as const, pairingUntil });
  assert.equal(pairingWindow(null, 0), null);
  assert.equal(pairingWindow({ enabled: true, state: "on", remote: "cloudflare" }, 0), null);
  // Behind a tunnel the relay runs too, so computers get a window.
  assert.deepEqual(pairingWindow({ enabled: true, state: "on", remote: "cloudflare", pairingUntil: 600_000 }, 0), { open: true, minutes: 10 });
  assert.equal(pairingWindow(status(), 0), null);
  assert.deepEqual(pairingWindow(status(600_000), 0), { open: true, minutes: 10 });
  assert.deepEqual(pairingWindow(status(600_000), 1), { open: true, minutes: 10 });
  assert.deepEqual(pairingWindow(status(600_000), 60_000), { open: true, minutes: 9 });
  assert.deepEqual(pairingWindow(status(600_000), 599_999), { open: true, minutes: 1 });
  assert.deepEqual(pairingWindow(status(600_000), 600_000), { open: false, minutes: 0 });
});

test("the QR image source is an inert data URL", () => {
  const src = phoneQrSrc('<svg viewBox="0 0 1 1"><path d="M0 0h1"/></svg>');
  assert.match(src, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.equal(decodeURIComponent(src.split(",")[1]), '<svg viewBox="0 0 1 1"><path d="M0 0h1"/></svg>');
});

test("phoneLanLine says where a phone on the same network reaches this Mac", () => {
  const on = { enabled: true, state: "on", remote: "relay" } as const;
  assert.equal(phoneLanLine(null), null);
  assert.equal(phoneLanLine({ ...on, lan: { enabled: false, addresses: [] } }), "Off");
  assert.equal(phoneLanLine({ ...on, lan: { enabled: true, addresses: ["192.168.1.20", "10.0.0.7"] } }), "Reachable at 192.168.1.20, 10.0.0.7");
  assert.equal(phoneLanLine({ ...on, lan: { enabled: true, addresses: [] } }), "Not connected to a local network");
  assert.equal(
    phoneLanLine({ ...on, lan: { enabled: true, addresses: [], error: "listen EADDRINUSE" } }),
    "Couldn't listen on the local network: listen EADDRINUSE",
  );
});

test("only phones on a Cloudflare tunnel get the note that Remove doesn't cut them off", () => {
  assert.equal(cloudflarePhonesNote(null), null);
  assert.equal(cloudflarePhonesNote({ enabled: true, state: "on", remote: "relay" }), null);
  assert.equal(cloudflarePhonesNote({ enabled: true, state: "on", remote: "none" }), null);
  assert.equal(cloudflarePhonesNote({ enabled: true, state: "on", remote: "cloudflare" }), "Phones on your Cloudflare tunnel keep access until Reset access.");
});
