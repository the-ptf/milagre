import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendAttachments,
  ATTACHMENT_LIMIT_MESSAGE,
  attachmentPrompt,
  addMention,
  mentionAttachment,
  mentionAttachments,
  prepareAttachments,
  settleLimitError,
  type Attachment,
} from "./attachments.ts";
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
test("a mentioned file attaches by its absolute path and never leaves the project", () => {
  const item = mentionAttachment("/w", "src/a.ts");
  assert.equal(item.name, "a.ts");
  assert.equal(item.path, "/w/src/a.ts");
  assert.equal(mentionAttachment("/w/", "a.ts").path, "/w/a.ts");
  assert.throws(() => mentionAttachment("/w", "../x"), /inside the project/);
  assert.throws(() => mentionAttachment("/w", "/etc/passwd"), /inside the project/);
});
test("a mention with a ./ segment is refused too", () => {
  assert.throws(() => mentionAttachment("/w", "./a.ts"), /inside the project/);
  assert.throws(() => mentionAttachment("/w", "a/./b.ts"), /inside the project/);
});
test("mentioning a file at the limit reports it instead of throwing, and a repeat changes nothing", () => {
  const full = ["a", "b", "c", "d"].map((name) => mentionAttachment("/w", `${name}.ts`));
  const over = addMention(full, "/w", "e.ts");
  assert.equal(over.next, full);
  assert.match(over.error ?? "", /up to 4/);
  assert.equal(addMention(full, "/w", "a.ts").error, undefined);
  assert.equal(addMention([], "/w", "../x").error, "Mention a file inside the project.");
  assert.equal(addMention(full.slice(0, 3), "/w", "e.ts").next.length, 4);
});
test("send attaches each confirmed mention once, within the limit, and says when the limit dropped one", () => {
  const have = [mentionAttachment("/w", "a.ts")];
  const result = mentionAttachments('see @a.ts @b.ts @b.ts @"c d.ts" @../x @team', "/w", have, (path) => path !== "team");
  assert.deepEqual(
    result.added.map((item) => item.path),
    ["/w/b.ts", "/w/c d.ts"],
  );
  assert.equal(result.dropped, false);
  const capped = mentionAttachments("@b.ts @c.ts @d.ts @e.ts", "/w", have, () => true);
  assert.deepEqual(
    capped.added.map((item) => item.name),
    ["b.ts", "c.ts", "d.ts"],
  );
  assert.equal(capped.dropped, true);
  assert.deepEqual(
    mentionAttachments("no mentions", "/w", [], () => true),
    { added: [], dropped: false },
  );
});
test("the limit error goes once there is room again or the draft is cleared, and other errors stay", () => {
  const limit = ATTACHMENT_LIMIT_MESSAGE;
  assert.equal(settleLimitError(limit, 4, "fix @src/e.ts"), limit, "still full with a mention in the draft: the error stays");
  assert.equal(settleLimitError(limit, 3, "fix @src/e.ts"), "", "a tile was removed");
  assert.equal(settleLimitError(limit, 0, ""), "", "every tile removed and the composer cleared");
  assert.equal(settleLimitError(limit, 4, "  \n"), "", "a blank draft counts as cleared");
  assert.equal(settleLimitError("Offline", 0, ""), "Offline", "an unrelated error is not this helper's to clear");
  assert.equal(settleLimitError("", 0, ""), "");
});
