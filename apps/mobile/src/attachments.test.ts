import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAttachments, attachmentPrompt, addMention, mentionAttachment, mentionAttachments, prepareAttachments, type Attachment } from "./attachments.ts";
import type { Client } from "./client.ts";
test("attachment drafts have no count cap", () => {
  const files = Array.from({ length: 120 }, (_, i) => ({ id: String(i), name: `${i}.txt`, uri: `file:///${i}` }));
  assert.equal(appendAttachments(files.slice(0, 60), files.slice(60)).length, 120);
});
test("phone files upload before send and agent receives host paths, not phone URIs", async () => {
  const client = {
    upload: async (project: string, name: string, bytes: string) => {
      assert.equal(project, "/project");
      assert.equal(bytes, name === "a.txt" ? "aGk=" : "/9j/");
      return { path: `/host/${name}`, name };
    },
  } as Client;
  const attachments: Attachment[] = [
    { id: "a", name: "a.txt", uri: "file:///phone/a.txt", base64: "aGk=" },
    { id: "b", name: "b.jpg", uri: "file:///phone/b.jpg", image: { id: "b", name: "b.jpg", dataUrl: "data:image/jpeg;base64,/9j/" } },
  ];
  const result = await prepareAttachments(client, "/project", attachments);
  assert.deepEqual(result.files, ["/host/a.txt"]);
  assert.deepEqual(result.images, [{ id: "b", name: "b.jpg", path: "/host/b.jpg" }]);
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

test("a partial multi-file retry revalidates completed uploads without transferring their bytes again", async () => {
  const sent: string[] = [];
  const checked: string[] = [];
  let fail = true;
  let present = true;
  const client = {
    upload: async (_project: string, name: string) => {
      sent.push(name);
      if (name === "b.txt" && fail) throw new Error("offline");
      return { id: name, path: `/host/${name}`, name };
    },
    reuseUpload: async (_project: string, id: string) => {
      checked.push(id);
      return present ? { id, path: `/host/${id}`, name: id } : null;
    },
  } as unknown as Client;
  const files: Attachment[] = [
    { id: "a", name: "a.txt", uri: "file:///a", base64: "aGk=" },
    { id: "b", name: "b.txt", uri: "file:///b", base64: "aGk=" },
  ];
  await assert.rejects(prepareAttachments(client, "/p", files), /offline/);
  fail = false;
  assert.deepEqual((await prepareAttachments(client, "/p", files)).files, ["/host/a.txt", "/host/b.txt"]);
  assert.deepEqual(sent, ["a.txt", "b.txt", "b.txt"]);
  assert.deepEqual(checked, ["a.txt"]);
  await prepareAttachments(client, "/p", files);
  assert.equal(sent.length, 3, "delivery failure after all uploads needs no bytes on retry");
  present = false;
  await prepareAttachments(client, "/p", files.slice(0, 1));
  assert.equal(sent.length, 4, "a deleted remote file uploads again");
  files[0]!.base64 = "bmV3";
  await prepareAttachments(client, "/p", files.slice(0, 1));
  await prepareAttachments(client, "/other", files.slice(0, 1));
  await prepareAttachments({ ...client } as Client, "/other", files.slice(0, 1));
  assert.equal(sent.length, 7, "new content, Project and client each invalidate the receipt");
});
test("a mention with a ./ segment is refused too", () => {
  assert.throws(() => mentionAttachment("/w", "./a.ts"), /inside the project/);
  assert.throws(() => mentionAttachment("/w", "a/./b.ts"), /inside the project/);
});
test("mentions have no count cap and duplicates stay attached once", () => {
  const have = Array.from({ length: 100 }, (_, i) => mentionAttachment("/w", `${i}.ts`));
  assert.equal(addMention(have, "/w", "next.ts").next.length, 101);
  assert.equal(addMention(have, "/w", "0.ts").next, have);
  assert.equal(addMention(have, "/w", "../x").error, "Mention a file inside the project.");
  const result = mentionAttachments("@a.ts @a.ts @b.ts @c.ts @d.ts @e.ts", "/w", have, () => true);
  assert.deepEqual(
    result.added.map((item) => item.name),
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  );
});
test("appendImageMentions appends 1-based [Image #N] tokens for newly added image attachments", async () => {
  const { appendImageMentions } = await import("./attachments.ts");
  assert.equal(appendImageMentions("", 0, 1), "[Image #1] ");
  assert.equal(appendImageMentions("Compare this", 0, 2), "Compare this [Image #1] [Image #2] ");
  assert.equal(appendImageMentions("Compare [Image #1] ", 1, 1), "Compare [Image #1] [Image #2] ");
  assert.equal(appendImageMentions("Compare ", 1, 0), "Compare ");
});
