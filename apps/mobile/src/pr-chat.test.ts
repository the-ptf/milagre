import { test } from "node:test";
import assert from "node:assert/strict";
import { onPullRequestRequest, prefillChat, registerPrChat, requestPullRequest, sendToChat } from "./pr-chat.ts";

test("Fix in Chat sends to the open Chat, or leaves the text in its composer when it can't send", async () => {
  const sent: string[] = [];
  let drafted = "";
  let answer: boolean | "busy" = true;
  const unregister = registerPrChat("/p#1", {
    send: async (body) => (sent.push(body), answer),
    prefill: (text) => {
      drafted = text;
    },
  });
  assert.equal(await sendToChat("/p#1", "Fix it"), "sent");
  answer = "busy";
  assert.equal(await sendToChat("/p#1", "Later"), "drafted");
  assert.equal(drafted, "Later");
  assert.equal(prefillChat("/p#1", "About PR #1: "), true);
  assert.deepEqual(sent, ["Fix it", "Later"]);
  unregister();
  assert.equal(await sendToChat("/p#1", "Nobody"), "unavailable");
  assert.equal(prefillChat("/p#1", "x"), false);
});

test("a row's PR link waits for its Chat, then opens the PR there", async () => {
  requestPullRequest("/p#2", 673);
  const opened: number[] = [];
  const stop = onPullRequestRequest("/p#2", (number) => opened.push(number));
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(opened, [673]);
  requestPullRequest("/p#2", 674);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(opened, [673, 674]);
  stop();
});
