import assert from "node:assert/strict";
import test from "node:test";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const made: string[] = [];
const local = {
  name: "local",
  onAgentEvent: (callback: any) => ((localAgent = callback), () => (localAgent = null)),
  onComputerEvent: (callback: any) => ((computerEvent = callback), () => (computerEvent = null)),
};
let localAgent: ((payload: any) => void) | null = null;
let computerEvent: ((event: any) => void) | null = null;
(globalThis as any).window = { milagre: { ...local, on: (id: string) => (made.push(id), { name: id }) } };
const { bridgeFor, bridgeForKey, isRemoteKey, forgetBridge, onAnyAgentEvent } = await import("./computer-bridge.ts");

test("local and remote keys use stable device-protected bridges, made once", () => {
  assert.equal(bridgeForKey("/code/app#2"), bridgeFor(null));
  assert.equal((bridgeFor(null) as any).name, "local");
  assert.equal(bridgeFor("local"), bridgeFor(null));
  assert.notEqual(bridgeFor(null), (globalThis as any).window.milagre);
  assert.deepEqual(bridgeForKey(`${ID}|/code/app#2`), { name: ID });
  assert.equal(bridgeForKey(`milagre-link:${ID}|f1713d69-569d-405b-a0b2-19bfdf565a76`), bridgeFor(ID));
  assert.deepEqual(made, [ID]);
  forgetBridge(ID);
  bridgeFor(ID);
  assert.deepEqual(made, [ID, ID]);
  assert.equal(isRemoteKey(`${ID}|/p`), true);
  assert.equal(isRemoteKey("/p"), false);
  assert.equal(isRemoteKey(null), false);
});

test("agent events from this Mac and from every computer reach one listener", () => {
  const heard: any[] = [];
  const off = onAnyAgentEvent((payload) => heard.push(payload.chatId));
  localAgent!({ chatId: "/p#1", event: { type: "turn-started" } });
  computerEvent!({ computerId: ID, channel: "agent:event", payload: { chatId: `${ID}|/p#1`, event: { type: "turn-started" } } });
  computerEvent!({ computerId: ID, channel: "project:state", payload: { path: `${ID}|/p` } });
  assert.deepEqual(heard, ["/p#1", `${ID}|/p#1`]);
  off();
  assert.equal(localAgent, null);
  assert.equal(computerEvent, null);
});
