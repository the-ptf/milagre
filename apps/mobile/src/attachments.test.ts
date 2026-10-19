import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAttachments, attachmentPrompt, prepareAttachments, type Attachment } from "./attachments.ts";
import type { Client } from "./client.ts";
test("attachment drafts are bounded without dropping an existing selection", () => {
  const file = { id: "a", name: "a.txt", uri: "file:///a" };
  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- the test deliberately passes the same item repeatedly to hit the count limit
  assert.throws(() => appendAttachments([file], Array(4).fill(file)), /up to 4/);
  assert.equal(appendAttachments([file], []).length, 1);
});
test("phone files upload before send and agent receives host paths, not phone URIs", async () => {
  const client = {
    upload: async (project: string, name: string, bytes: string) => {
      assert.equal(project, "/project");
      assert.equal(bytes, "aGk=");
      return { path: `/host/${name}`, name };
    },
  } as Client;
  const attachments: Attachment[] = [
    { id: "a", name: "a.txt", uri: "file:///phone/a.txt", base64: "aGk=" },
    { id: "b", name: "b.jpg", uri: "file:///phone/b.jpg", image: { id: "b", name: "b.jpg", dataUrl: "data:image/jpeg;base64,/9j/" } },
  ];
  const result = await prepareAttachments(client, "/project", attachments);
  assert.deepEqual(result.files, ["/host/a.txt"]);
  assert.equal(result.images.length, 1);
  assert.match(attachmentPrompt("", result.files), /Please review the attached files.\n\nAttached files:\n\/host\/a.txt/);
});
test("failed file upload leaves attachments intact and prevents sending partial files", async () => {
  const attachments = [{ id: "a", name: "a.txt", uri: "file:///a", base64: "aGk=" }];
  await assert.rejects(
    prepareAttachments(
      {
        upload: async () => {
          throw new Error("offline");
        },
      } as unknown as Client,
      "/p",
      attachments,
    ),
    /offline/,
  );
  assert.equal(attachments.length, 1);
});
test("a busy Mac retries the one upload it turned away, not the files already sent", async () => {
  const uploads: string[] = [];
  let refusals = 1;
  const client = {
    upload: async (_project: string, name: string) => {
      uploads.push(name);
      if (name === "b.txt" && refusals-- > 0) throw Object.assign(new Error("busy"), { status: 429 });
      return { path: `/host/${name}`, name };
    },
  } as unknown as Client;
  const retry = async <T>(upload: () => Promise<T>) => {
    try {
      return await upload();
    } catch {
      return upload();
    }
  };
  const attachments = [
    { id: "a", name: "a.txt", uri: "file:///a", base64: "aGk=" },
    { id: "b", name: "b.txt", uri: "file:///b", base64: "aGk=" },
  ];
  const result = await prepareAttachments(client, "/p", attachments, retry);
  assert.deepEqual(result.files, ["/host/a.txt", "/host/b.txt"]);
  assert.deepEqual(uploads, ["a.txt", "b.txt", "b.txt"]);
});
