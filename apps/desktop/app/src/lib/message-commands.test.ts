import test from "node:test";
import assert from "node:assert/strict";
import { hitCommands, messageCommands } from "./message-commands.ts";

const messages = [1, 2, 3, 4]
  .map((id) => ({ id, session_id: 1, body: `deploy the relay, try ${id}` }))
  .concat([
    { id: 5, session_id: 2, body: "deploy notes for an archived chat" },
    { id: 6, session_id: 3, body: "relay deploy from the other chat" },
  ]);

test("lists at most three messages per listed chat, titled by their chat", () => {
  const opened: Array<[number, string]> = [];
  const commands = messageCommands(
    messages,
    "deploy",
    new Map([
      [1, "Relay"],
      [3, "Other"],
    ]),
    (id, term) => opened.push([id, term]),
  );
  assert.deepEqual(
    commands.map((command) => [command.detail, command.group]),
    [
      ["Other", "Messages"],
      ["Relay", "Messages"],
      ["Relay", "Messages"],
      ["Relay", "Messages"],
    ],
  );
  const other = commands.find((command) => command.detail === "Other")!;
  assert.equal(other.label.slice(...other.highlight!), "deploy");
  void other.run();
  assert.deepEqual(opened, [[3, "deploy"]]);
});

test("message-mode rows name the Project across several, mark archived Chats and open the hit", () => {
  const opened: string[] = [];
  const hit = {
    projectPath: "/relay",
    projectName: "relay",
    chat: { id: 4, title: "Deploy", archived: true, lastAt: 1 },
    message: { id: 9, session_id: 4 },
    score: 4,
    snippet: "wrangler deploy",
    highlight: [0, 8] as [number, number],
    term: "wrangler",
  };
  const { commands, failed } = hitCommands(
    {
      matches: [hit, { ...hit, chat: { ...hit.chat, archived: false }, message: { id: 10, session_id: 4 } }],
      failed: [{ projectPath: "/q", projectName: "q", error: "Gone." }],
      searched: 1,
    },
    { withProject: true, now: 2 * 86_400_000 + 1, open: (found) => opened.push(`${found.projectPath}#${found.message.id}`) },
  );
  assert.deepEqual(
    commands.map((command) => [command.detail, command.badge]),
    [
      ["Deploy · relay · 2d", "Archived"],
      ["Deploy · relay · 2d", undefined],
    ],
  );
  assert.deepEqual(failed, ["Couldn't search q: Gone."]);
  void commands[0].run();
  assert.deepEqual(opened, ["/relay#9"]);
});
