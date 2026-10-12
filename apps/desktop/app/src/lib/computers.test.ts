import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerView } from "../electron.d.ts";

(globalThis as any).window = {
  addEventListener() {},
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
const { computerTone, routeLine, seenAgo, settingsTooltip, offlineBanner, offlinePlaceholder, isDimmed, isReadOnly, withComputer } =
  await import("./computers.ts");

const NOW = Date.parse("2026-10-09T12:00:00Z");
const view = (patch: Partial<ComputerView> = {}): ComputerView => ({
  id: "c1",
  name: "studio",
  hostId: "h".repeat(22),
  relayHost: "relay.milagre.cloud",
  state: "online",
  route: "relay",
  lastSeen: NOW - 2 * 3600_000,
  addedAt: 1,
  message: null,
  lan: false,
  lanRoutes: [],
  ...patch,
});

test("each state reads as the popover's second line", () => {
  assert.equal(routeLine(view({ route: "lan" }), NOW), "Same network");
  assert.equal(routeLine(view({ route: "relay" }), NOW), "relay.milagre.cloud");
  assert.equal(routeLine(view({ state: "connecting", route: null }), NOW), "Connecting…");
  assert.equal(routeLine(view({ state: "reconnecting", route: null }), NOW), "Reconnecting…");
  assert.equal(
    routeLine(view({ state: "reconnecting", message: "studio has too many devices connected. Remove one in its Settings › Devices." }), NOW),
    "studio has too many devices connected. Remove one in its Settings › Devices.",
  );
  assert.equal(routeLine(view({ state: "offline" }), NOW), "Offline, seen 2h ago");
  assert.equal(routeLine(view({ state: "offline", lastSeen: null }), NOW), "Offline");
  assert.equal(
    routeLine(view({ state: "refused", message: "Removed on studio. Pair again with a new link." }), NOW),
    "Removed on studio. Pair again with a new link.",
  );
});

test("seen times read as minutes, hours, then days", () => {
  assert.equal(seenAgo(NOW - 20_000, NOW), "just now");
  assert.equal(seenAgo(NOW - 5 * 60_000, NOW), "5 min ago");
  assert.equal(seenAgo(NOW - 2 * 3600_000, NOW), "2h ago");
  assert.equal(seenAgo(NOW - 3 * 86_400_000, NOW), "3d ago");
  assert.equal(seenAgo(null, NOW), null);
});

test("the dot, dimming and read-only follow the state", () => {
  assert.deepEqual(
    (["online", "connecting", "reconnecting", "offline", "refused", "off"] as const).map((state) => computerTone({ state })),
    ["online", "connecting", "connecting", "offline", "refused", "offline"],
  );
  assert.equal(isDimmed(view({ state: "offline" })), true);
  assert.equal(isDimmed(view({ state: "reconnecting" })), false);
  assert.equal(isReadOnly(view({ state: "reconnecting" })), true);
  assert.equal(isReadOnly(view()), false);
  assert.equal(isReadOnly(undefined), true);
});

test("the gear's tooltip, the banner and the composer say the spec's words", () => {
  assert.equal(settingsTooltip("arketa"), "arketa settings: rename, connection, remove");
  assert.equal(
    offlineBanner(view({ state: "offline" }), NOW),
    "studio is offline. This is the last copy it sent, 2h ago. You can read it until studio is back.",
  );
  assert.equal(
    offlineBanner(view({ state: "offline", lastSeen: null }), NOW),
    "studio is offline. This is the last copy it sent. You can read it until studio is back.",
  );
  assert.equal(offlinePlaceholder("studio"), " (studio is offline)");
});

test("a remote chat's completion notice names its computer; this Mac's is unchanged", () => {
  assert.equal(withComputer("/p#2", "Fix login"), "Fix login");
  assert.equal(withComputer("c9|/p#2", "Fix login"), "Computer · Fix login", "a computer the list doesn't know yet");
});
