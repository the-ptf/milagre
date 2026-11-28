import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasLive } from "@milagre/shared/canvas";
import type { PermissionRequest, QuestionRequest } from "../model.ts";
import {
  LIVE,
  WINDOW,
  bentLine,
  closeChat,
  forgetGone,
  keepOnCanvas,
  lineSides,
  liveHeight,
  openChat,
  placeWindows,
  quickApproval,
  quickQuestion,
} from "./canvas-open.ts";

test("any number of Chats stay open as windows: opening one adds it last, or brings an open one last, never closing another", () => {
  let open: string[] = [];
  for (const key of ["a", "b", "c", "d", "e", "f", "g"]) open = openChat(open, key);
  assert.deepEqual(open, ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(openChat(open, "c"), ["a", "b", "d", "e", "f", "g", "c"]);
});

test("closing a Chat leaves the others in order, and the same list when it was not open", () => {
  const open = ["a", "b"];
  assert.deepEqual(closeChat(open, "a"), ["b"]);
  assert.equal(closeChat(open, "z"), open);
});

const approval = (extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: "p1",
  kind: "command",
  tool: "Bash",
  title: "npm test",
  command: "npm test",
  allowForChat: true,
  ...extra,
});
const question = (extra: Partial<QuestionRequest["questions"][number]> = {}, request: Partial<QuestionRequest> = {}): QuestionRequest => ({
  requestId: "q1",
  questions: [
    {
      id: "a",
      header: "",
      question: "Which one?",
      options: [{ label: "One" }, { label: "Two" }],
      multiSelect: false,
      allowOther: false,
      secret: false,
      ...extra,
    },
  ],
  ...request,
});

test("a closed card grows by the line or the block its Chat shows, nothing when idle", () => {
  const live = (extra: Partial<CanvasLive>): CanvasLive => ({ ...extra });
  assert.equal(liveHeight(undefined), 0);
  assert.equal(liveHeight(live({})), 0);
  assert.equal(liveHeight(live({ step: "Running the tests" })), LIVE.step);
  assert.equal(liveHeight(live({ step: "Asking", pending: { kind: "approval", request: approval(), more: 0 } })), LIVE.approval);
  assert.equal(liveHeight(live({ pending: { kind: "question", request: question(), more: 0 } })), LIVE.questionBase + 2 * LIVE.questionOption);
  assert.equal(
    liveHeight(live({ pending: { kind: "question", request: question({ allowOther: true }), more: 0 } })),
    LIVE.questionBase + 3 * LIVE.questionOption,
  );
  assert.equal(liveHeight(live({ pending: { kind: "question", request: question({ multiSelect: true }), more: 0 } })), LIVE.questionForm);
});

test("only a command whose text the closed card shows is approved there; anything else is reviewed in its window first", () => {
  assert.equal(quickApproval(approval()), true);
  const edit = approval({ kind: "edit", tool: "Edit files", title: "Edit 2 files?", command: undefined, files: ["/r/a.ts", "/r/b.ts"], diff: "+x" });
  assert.equal(quickApproval(edit), false, "an edit's paths and diff are seen before it is allowed");
  assert.equal(quickApproval(approval({ kind: "other", command: undefined, detail: "{}" })), false);
  assert.equal(quickApproval(approval({ command: undefined, description: "Run ping" })), false, "a command the card can't show");
  assert.equal(quickApproval(approval({ kind: "delegation", delegation: { target: "x", message: "y", negotiation: false } })), false);
  assert.equal(quickApproval(approval({ kind: "setup" })), false);
});

test("only one single-choice question with a few options is answered on the closed card", () => {
  assert.equal(quickQuestion(question())?.id, "a");
  assert.equal(quickQuestion(question({ multiSelect: true })), undefined);
  assert.equal(quickQuestion(question({ secret: true, allowOther: true })), undefined);
  assert.equal(quickQuestion(question({ options: [1, 2, 3, 4, 5].map((n) => ({ label: String(n) })) })), undefined);
  assert.equal(quickQuestion(question({ options: [], allowOther: true })), undefined);
  assert.equal(quickQuestion(question({}, { secretRequest: { description: "token" } })), undefined);
  assert.equal(quickQuestion(question({}, { bugReport: { repo: "r", title: "t", body: "b" } })), undefined);
  const two = question();
  two.questions.push({ ...two.questions[0]!, id: "b" });
  assert.equal(quickQuestion(two), undefined);
});

test("a window's line leaves the side of its card that faces the window, and reaches the window's facing side", () => {
  const card = { x: 0, y: 0, width: 276, height: 200 };
  const at = (x: number, y: number) => ({ x, y, width: 420, height: 536 });
  assert.deepEqual(lineSides(card, at(400, 0)), { card: "right", window: "left" });
  assert.deepEqual(lineSides(card, at(-600, -100)), { card: "left", window: "right" }, "a window moved left of its card");
  assert.deepEqual(lineSides(card, at(-50, 400)), { card: "bottom", window: "top" }, "a window under its card");
  assert.deepEqual(lineSides(card, at(-50, -700)), { card: "top", window: "bottom" }, "a window above its card");
});

test("a bent line passes through its point, kept as an offset from the straight line's middle so it follows both ends", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 0 };
  const straight = bentLine(from, to, null);
  assert.deepEqual(straight.point, { x: 100, y: 0 });
  assert.equal(straight.path, "M 0,0 L 200,0");
  const bent = bentLine(from, to, { x: 0, y: 80 });
  assert.deepEqual(bent.point, { x: 100, y: 80 });
  assert.equal(bent.path, "M 0,0 Q 100,160 200,0");
  assert.deepEqual(bentLine({ x: 0, y: 100 }, { x: 200, y: 100 }, { x: 0, y: 80 }).point, { x: 100, y: 180 });
});

test("windows open right of their section, side by side, level with their cards, past other sections and windows", () => {
  const section = { x: 0, y: 0, width: 600, height: 400 };
  const size = { width: WINDOW.width, height: WINDOW.height };
  const first = section.width + WINDOW.gap;
  assert.deepEqual(
    placeWindows(
      section,
      [],
      [
        { top: 40, ...size },
        { top: 200, ...size },
      ],
    ),
    [
      { x: first, y: 40 },
      { x: first + WINDOW.width + WINDOW.gap, y: 200 },
    ],
  );
  const neighbour = { x: 700, y: 0, width: 500, height: 600 };
  assert.deepEqual(placeWindows(section, [neighbour], [{ top: 40, ...size }]), [{ x: 700 + 500 + WINDOW.gap, y: 40 }]);
  const left = { x: first, y: 0, width: WINDOW.width, height: WINDOW.height };
  assert.deepEqual(placeWindows(section, [left], [{ top: 40, ...size }]), [{ x: first + WINDOW.width + WINDOW.gap, y: 40 }]);
  assert.deepEqual(placeWindows(section, [{ x: 700, y: 2000, width: 500, height: 300 }], [{ top: 40, ...size }]), [{ x: first, y: 40 }]);
});

test("Chats gone from the canvas leave the open list, Chats of Projects it didn't go through stay; the same list when none left", () => {
  const projectOf = (key: string) => key.split("#")[0]!;
  const open = ["/p#1", "/p#2", "/q#1"];
  assert.equal(keepOnCanvas(open, new Set(["/p#1", "/p#2"]), new Set(["/p"]), projectOf), open);
  assert.deepEqual(keepOnCanvas(open, new Set(["/p#2"]), new Set(["/p", "/q"]), projectOf), ["/p#2"]);
  assert.deepEqual(keepOnCanvas(open, new Set(["/p#2"]), new Set(["/p"]), projectOf), ["/p#2", "/q#1"]);
});

test("a Chat's saved window is forgotten once it is gone from a Project on the canvas, kept while its Project is off it", () => {
  const projectOf = (key: string) => key.split("#")[0]!;
  const records = { "/p#1": { x: 1, y: 2 }, "/p#2": { bend: { x: 0, y: 40 } }, "/q#1": { width: 500 } };
  assert.deepEqual(forgetGone(records, new Set(["/p#1"]), new Set(["/p"]), projectOf), { "/p#1": { x: 1, y: 2 }, "/q#1": { width: 500 } });
  assert.equal(forgetGone(records, new Set(["/p#1", "/p#2"]), new Set(["/p"]), projectOf), records);
});
