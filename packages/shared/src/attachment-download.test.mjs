import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadAttachment } from "./attachment-download.mjs";

test("downloads stop on interrupted, changed and failed writes", async () => {
  await assert.rejects(
    downloadAttachment(
      async () => ({ size: 3, version: "v1", base64: "" }),
      () => {},
    ),
    /interrupted/,
  );
  let calls = 0;
  await assert.rejects(
    downloadAttachment(
      async () => ({ size: 2, version: `v${++calls}`, base64: "AA==" }),
      () => {},
    ),
    /changed/,
  );
  calls = 0;
  await assert.rejects(
    downloadAttachment(
      async () => {
        calls++;
        return { size: 2, version: "v1", base64: "AA==" };
      },
      () => {
        throw new Error("Disk full");
      },
    ),
    /Disk full/,
  );
  assert.equal(calls, 1);
});
