import assert from "node:assert/strict";
import test from "node:test";
import { folderImportText, folderScanName, offersFolderImport, type FolderScan } from "./project-list.ts";

const repo = { path: "/code/food/api", name: "api", relative: "api", git: true, chosen: true };
const scan = (patch: Partial<FolderScan>): FolderScan => ({ folder: "/code/food", git: false, children: [repo], detect: true, ...patch });

test("a folder of repositories, or a repository with a .code-workspace, offers its repositories as one Link", () => {
  assert.equal(offersFolderImport(scan({})), true);
  assert.equal(offersFolderImport(scan({ git: true })), false);
  assert.equal(offersFolderImport(scan({ git: true, workspace: true })), true);
  assert.equal(offersFolderImport(scan({ detect: false })), false);
  assert.equal(offersFolderImport(scan({ children: [{ ...repo, git: false }] })), false);
  assert.equal(offersFolderImport(null), false);
});

test("the Link takes the workspace's name, or the folder's from a host that sends none", () => {
  assert.equal(folderScanName(scan({})), "food");
  assert.equal(folderImportText(scan({})), "food holds 1 repositories. Add the ones you check as Projects, grouped by a Link named food.");
  assert.equal(
    folderImportText(scan({ name: "Platform", workspace: true })),
    "The Platform workspace lists 1 repositories. Add the ones you check as Projects, grouped by a Link named Platform.",
  );
});
