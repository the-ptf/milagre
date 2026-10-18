// A large Project made up at test time, shaped like the big one #300 and #321 measured (a copy of milagre-ade's own
// state): 79 Chats, 881 messages (5.3 MB), 94 subagents of which 81 are archived, transcripts of up to 100 entries
// (12 MB), and the communications (saved before the subagent canvas went), latest activity and prompts beside them.
// The same seed gives the same Project, byte for byte, so sizes measured on it can be held to exact budgets
// (perf-budget.test.cjs).

const BASE_TIME = 1_790_000_000_000;

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the a to of and in is it for on with as that this be by from at or an are was not run test file chat agent reply " +
  "state patch daemon desktop phone project worktree message subagent transcript render build check commit branch " +
  "review update read write open close save load index cache event stream turn tool shell output error result"
).split(" ");

/**
 * Builds the Project. `seed` picks every size and word. Returns the state as coordination.json held it before chats.db
 * (messages inline): the daemon moves it on its first save.
 */
function largeProject({ seed = 321, projectPath = "/fixture/project" } = {}) {
  const next = random(seed);
  const between = (low, high) => low + Math.floor(next() * (high - low + 1));
  // One block of words, sliced at random places: text of any length without building it word by word.
  let block = "";
  while (block.length < 256 * 1024) block += `${WORDS[Math.floor(next() * WORDS.length)]}${next() < 0.08 ? "\n" : " "}`;
  const text = (length) => {
    let out = "";
    while (out.length < length) {
      const start = Math.floor(next() * (block.length - 1024));
      out += block.slice(start, start + Math.min(length - out.length, block.length - start));
    }
    return out;
  };

  const sessions = {};
  const messages = [];
  let id = 100;
  let time = BASE_TIME;
  const CHATS = 79;
  // Chats 2..80, one Worktree. The first 27 have messages; one of them is long.
  const messageCounts = [404, ...Array.from({ length: 26 }, (_, index) => [3, 6, 10, 14, 18, 22, 26, 30][index % 8] + between(0, 6))];
  // Subagents per Chat, as in the measured Project.
  const agentCounts = [10, 52, 18, 7, 1, 1, 1, 1, 1, 1, 1];
  let agentIndex = 0;
  for (let index = 0; index < CHATS; index++) {
    const sessionId = index + 2;
    const provider = index % 3 === 0 ? "claude" : "codex";
    const session = {
      id: sessionId,
      worktree_id: 1,
      agent_name: "main",
      status: "Created",
      provider,
      native_session_id: `native-${sessionId}-${Math.floor(next() * 1e9).toString(16)}`,
      title: text(between(20, 60)).trim(),
      ...(index % 5 !== 0 ? { archived: true } : {}),
    };
    const count = messageCounts[index] ?? 0;
    for (let n = 0; n < count; n++) {
      time += between(1000, 60_000);
      const role = n === 0 || next() < 0.43 ? "user" : "assistant";
      if (role === "user") {
        messages.push({ id: id++, session_id: sessionId, body: text(between(80, 1400)), context: null, role, clientMessageId: `client-${id}` });
        continue;
      }
      const stepCount = Math.floor(next() ** 3 * 97);
      const steps = [];
      for (let s = 0; s < stepCount; s++)
        steps.push({
          id: `toolu_${sessionId}_${n}_${s}`,
          kind: "shell",
          title: `Ran \`${text(between(30, 130)).replaceAll("\n", " ")}\``,
          status: "done",
          offset: between(0, 2000),
          ...(next() < 0.3 ? { detail: text(between(80, 1000)) } : {}),
        });
      messages.push({
        id: id++,
        session_id: sessionId,
        body: text(between(200, 4000)),
        context: null,
        role,
        model: provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
        outcome: "completed",
        steps,
      });
    }
    const agents = agentCounts[index] ?? 0;
    if (agents) {
      session.subagents = [];
      for (let a = 0; a < agents; a++, agentIndex++) {
        const startedAt = time - between(60_000, 3_600_000);
        const updatedAt = startedAt + between(10_000, 1_800_000);
        const agentId = `agent-${sessionId}-${a}`;
        const length = next() < 0.3 ? 100 : between(0, 99);
        const transcript = [];
        for (let e = 0; e < length; e++) {
          // The last entries run longer: a child's final reads and its answer.
          const size = next() + (e >= length - 4 ? 0.2 : 0);
          const entryLength = size < 0.6 ? between(80, 300) : size < 0.88 ? between(1000, 3000) : between(3000, 13000);
          transcript.push({ id: `item-${agentId}-${e}`, kind: next() < 0.7 ? "tool" : "message", text: text(entryLength) });
        }
        const communicationCount = [0, 0, 0, 0, 2, 2, 2, 2, 2, 3, 4, 12][between(0, 11)];
        const communications = Array.from({ length: communicationCount }, (_, c) => ({
          id: `activity:${agentId}:${c}`,
          fromId: c % 2 ? agentId : null,
          toId: c % 2 ? null : agentId,
          text: text(next() < 0.8 ? between(150, 4000) : between(4000, 9000)),
          at: startedAt + c * 1000,
        }));
        session.subagents.push({
          id: agentId,
          title: `/root/${text(between(10, 30)).replace(/\W+/g, "_")}`,
          status: next() < 0.9 ? "completed" : "failed",
          startedAt,
          updatedAt,
          endedAt: updatedAt,
          // About one in seven stays on the track, as in the measured Project (81 of 94 archived).
          ...(agentIndex % 7 !== 3 ? { archived: true } : {}),
          ...(a > 0 && next() < 0.3 ? { parentId: `agent-${sessionId}-0` } : {}),
          prompt: text(between(800, 3200)),
          latestActivity: text(next() < 0.9 ? between(0, 9000) : between(9000, 20000)),
          communications,
          transcript,
        });
      }
    }
    sessions[sessionId] = session;
  }
  return {
    next_id: id + 1,
    projects: { 1: { id: 1, name: "project" } },
    worktrees: { 1: { id: 1, project_id: 1, path: projectPath, name: "main" } },
    sessions,
    messages,
    tasks: {},
  };
}

module.exports = { largeProject };
