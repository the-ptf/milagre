import assert from "node:assert/strict";
import test from "node:test";
import { presenceTone } from "./chat-scopes.mjs";
import { chatMarkPresentation } from "./chats.mjs";
import { IMAGE_COLOR, fileKind } from "./file-kinds.mjs";
import { permissionPresentation } from "./model-copy.ts";
import { PR_TONE, pullRequestStatePill } from "./pr-blockers.ts";
import { projectAvatarRadius, projectInitial } from "./project-list.ts";

// The looks desktop and phone both draw from: one mapping each, so the two apps can't drift.
test("presence dots: green online, orange while connecting or checking, red refused, ink4 otherwise", () => {
  assert.deepEqual(["online", "connecting", "reconnecting", "checking", "refused", "offline", undefined].map(presenceTone), [
    "green",
    "orange",
    "orange",
    "orange",
    "red",
    "ink4",
    "ink4",
  ]);
});

test("chat marks carry one label set and a solid ink4 idle dot", () => {
  assert.deepEqual(chatMarkPresentation("question"), { icon: "bubble", tone: "accent", label: "Needs reply" });
  assert.deepEqual(chatMarkPresentation("interrupted"), { icon: "alert", tone: "orange", label: "Interrupted" });
  assert.deepEqual(chatMarkPresentation("idle"), { icon: "dot", tone: "ink4", label: "" });
});

test("permission modes: Full is the only orange one", () => {
  assert.deepEqual(permissionPresentation("full"), { icon: "shield-alert", tone: "orange", ink: "orangeInk" });
  assert.equal(permissionPresentation("auto").icon, "security-check");
  assert.equal(permissionPresentation("ask").tone, "ink2");
});

test("PR icons take the fill, labels the -ink shade; the header pill names Draft, Merged and Closed", () => {
  assert.deepEqual(PR_TONE.green, { icon: "green", label: "greenInk" });
  assert.equal(pullRequestStatePill({ state: "MERGED" })?.label, "Merged");
  assert.equal(pullRequestStatePill({ state: "OPEN", isDraft: true })?.fill, "hover");
  assert.equal(pullRequestStatePill({ state: "OPEN" }), null);
});

test("project tiles: radius by size, an initial, and images in their identity colour", () => {
  assert.deepEqual([16, 20, 24, 32, 40, 72].map(projectAvatarRadius), [4, 6, 6, 10, 10, 20]);
  assert.equal(projectInitial("  milagre"), "M");
  assert.equal(fileKind("shot.png").color, IMAGE_COLOR);
});
