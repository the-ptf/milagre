import assert from "node:assert/strict";
import test from "node:test";
import { deliverOutbox, type OutboxTransport } from "./outbox-delivery.ts";
import type { OutboxItem } from "./outbox.mjs";

const item = (): OutboxItem => ({
  id: "stable-id",
  computerId: "studio",
  computerName: "Studio",
  owner: "/p",
  conversation: "chat:4",
  status: "queued",
  phase: "ready",
  createdAt: 0,
  error: "",
  attachments: [
    { name: "photo.jpg", base64: "aW1n", imageId: "image-1" },
    { name: "notes.txt", base64: "dGV4dA==" },
    { name: "source.ts", path: "/p/source.ts" },
  ],
  request: {
    projectPath: "/p",
    sessionId: 4,
    worktreeId: 2,
    body: "check these",
    images: [],
    files: [],
    prompt: "check these",
    provider: "claude",
    model: "opus",
    permissionMode: "ask",
  },
});
function fixture() {
  const requests: unknown[] = [];
  let current = item();
  const transport: OutboxTransport = {
    open: async () => ({ sessions: { 4: {} } }),
    receipt: async () => null,
    create: async () => assert.fail("no Worktree creation"),
    upload: async (name, base64) => {
      requests.push([name, base64]);
      return { path: `/uploads/${name}` };
    },
    send: async (request) => {
      requests.push(request);
      return { sessionId: 4 };
    },
    sendLink: async (request) => {
      requests.push(request);
      return { sessionId: 4 };
    },
  };
  return { transport, requests, get: () => current, update: async (patch: Partial<OutboxItem>) => (current = { ...current, ...patch }) };
}
test("delivery uploads saved bytes, retains remote file references, and pins send identity/options", async () => {
  const f = fixture();
  await deliverOutbox(f.get(), f.update, f.transport);
  const request = f.requests.at(-1) as OutboxItem["request"];
  assert.deepEqual(request.images, [{ id: "image-1", name: "photo.jpg", path: "/uploads/photo.jpg" }]);
  assert.deepEqual(request.files, ["/uploads/notes.txt", "/p/source.ts"]);
  assert.equal(request.clientMessageId, "stable-id");
  assert.equal(request.sessionId, 4);
  assert.equal(request.permissionMode, "ask");
  assert.match(request.prompt, /\/uploads\/notes.txt/);
  assert.equal(f.get().phase, "dispatching");
});
test("receipt reconciliation does not upload or send again, even after the Chat was archived", async () => {
  const f = fixture();
  f.transport.receipt = async () => ({ sessionId: 4 });
  f.transport.open = async () => ({ sessions: { 4: { archived: true } } });
  assert.deepEqual(await deliverOutbox(f.get(), f.update, f.transport), { sessionId: 4 });
  assert.deepEqual(f.requests, []);
});
test("an archived Chat or a host without receipt support never receives an automatic send", async () => {
  const f = fixture();
  f.transport.open = async () => ({ sessions: { 4: { archived: true } } });
  await assert.rejects(deliverOutbox(f.get(), f.update, f.transport), /archived/);
  assert.deepEqual(f.requests, []);
  f.transport.receipt = async () => {
    throw new Error("Unknown command");
  };
  await assert.rejects(deliverOutbox(f.get(), f.update, f.transport), /Unknown command/);
  assert.deepEqual(f.requests, []);
});
test("a Link retries with the same operation id and computer-owned scope", async () => {
  const f = fixture();
  await f.update({ link: { linkId: "link", operationId: "op" } });
  f.transport.send = async () => assert.fail("ordinary chat path");
  await deliverOutbox(f.get(), f.update, f.transport);
  assert.equal((f.requests.at(-1) as { operationId: string }).operationId, "op");
});

test("Worktree creation is durably bracketed before upload, and its chosen Chat is reused after an upload failure", async () => {
  const f = fixture();
  await f.update({ createWorktree: { projectPath: "/p", baseBranch: "main", prompt: "create" }, request: { ...f.get().request, sessionId: null } });
  let creates = 0;
  f.transport.create = async () => {
    assert.equal(f.get().phase, "creating");
    creates++;
    return { worktreeId: 8, project: { state: { sessions: { 9: { id: 9, worktree_id: 8 } } } } } as Awaited<ReturnType<OutboxTransport["create"]>>;
  };
  f.transport.upload = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(deliverOutbox(f.get(), f.update, f.transport), /disk full/);
  assert.equal(f.get().createWorktree, undefined);
  assert.equal(f.get().request.sessionId, 9);
  f.transport.open = async () => ({ sessions: { 9: {} } });
  f.transport.upload = async (name) => ({ path: `/uploads/${name}` });
  await deliverOutbox(f.get(), f.update, f.transport);
  assert.equal(creates, 1);
  assert.equal((f.requests.at(-1) as OutboxItem["request"]).sessionId, 9);
});
