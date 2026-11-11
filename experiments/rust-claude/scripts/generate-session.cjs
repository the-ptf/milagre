#!/usr/bin/env node
// Pure Node ClaudeSession traces. No real SDK, process, credentials, profile or network.
//   NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-session.cjs [--check]
// --check writes nothing and fails if any committed JSON differs from fresh output. The legacy
// claude-session.json is compared structurally, so its formatter layout is left as committed.
const fs = require("node:fs");
const path = require("node:path");
const { ClaudeSession } = require("../../../packages/core/src/agents/claude-provider.cjs");
// --check: build fresh actual Node output and compare it with the committed file without writing.
// The comparison is compact JSON (structure, values and key order; whitespace/formatting ignored).
// `node` is informational: it is excluded from the comparison and both values are printed.
function record(file, output, pretty) {
  if (!process.argv.includes("--check")) {
    fs.writeFileSync(file, JSON.stringify(output, null, pretty) + "\n");
    return "wrote";
  }
  const committed = JSON.parse(fs.readFileSync(file, "utf8"));
  const fresh = JSON.parse(JSON.stringify(output));
  if ("node" in committed || "node" in fresh)
    console.log(`${path.basename(file)}: node version excluded (committed ${committed.node ?? "absent"}, fresh ${fresh.node ?? "absent"})`);
  delete committed.node;
  delete fresh.node;
  if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
    const a = JSON.stringify(committed);
    const b = JSON.stringify(fresh);
    let at = 0;
    while (at < a.length && a[at] === b[at]) at++;
    throw Error(
      `${path.basename(file)} drifted from fresh Node output at offset ${at}: committed ${JSON.stringify(a.slice(at, at + 80))}, fresh ${JSON.stringify(b.slice(at, at + 80))}`,
    );
  }
  return "matched";
}
const init = { type: "system", subtype: "init", session_id: "session-1" };
const text = (piece) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
const result = { type: "result", subtype: "success", num_turns: 1, result: "done" };
const failure = (error) => ({ type: "result", subtype: "error_during_execution", errors: [error] });
const login = { type: "assistant", error: "authentication_failed", message: { content: [] } };
const suggestion = { type: "prompt_suggestion", session_id: "session-1", suggestion: "Run tests" };
const cases = [
  { name: "reply-and-suggestion", messages: [init, text("hello"), result, suggestion, suggestion] },
  { name: "implicit-turn", rustCorrections: ["implicit-text-owner"], messages: [init, text("first"), result, init, text("next"), result] },
  { name: "notification-only", messages: [init, result, init, { ...result, num_turns: 0, result: "" }] },
  { name: "new-session-login", messages: [init, login, failure("not logged in")] },
  { name: "resumed-session-login", resumeId: "session-1", messages: [init, login, failure("not logged in")] },
  { name: "missing-resume", resumeId: "session-1", messages: [failure("No conversation found")] },
  { name: "ordinary-error-keeps-resume", resumeId: "session-1", messages: [init, failure("Request was aborted.")] },
  { name: "disabled-suggestions", promptSuggestions: false, messages: [init, result, suggestion] },
];

(async () => {
  const output = [];
  for (const spec of cases) {
    const events = [];
    let position = 0;
    let finished;
    const delivered = new Promise((resolve) => {
      finished = resolve;
    });
    const session = new ClaudeSession({
      cwd: "/unused",
      command: "/fake/claude",
      resumeId: spec.resumeId,
      defaultConfigDir: "/nonexistent-milagre-conformance",
      env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: String(spec.promptSuggestions !== false) },
      emit: (event) => events.push(JSON.parse(JSON.stringify(event))),
      loadSdk: async () => ({
        query: ({ prompt }) => {
          const first = prompt[Symbol.asyncIterator]().next();
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              await first;
              // Allow beginTurn's event and promise continuation to settle first.
              await new Promise(setImmediate);
              if (position < spec.messages.length) return { value: spec.messages[position++], done: false };
              finished();
              return new Promise(() => {});
            },
            async return() {
              finished();
              return { done: true };
            },
            async setMaxThinkingTokens() {},
          };
        },
      }),
    });
    await session.startTurn({ prompt: "hello", model: "sonnet", permissionMode: "ask" });
    await delivered;
    const ids = new Map();
    for (const event of events) if (event.type === "turn-started") ids.set(event.turnId, `turn-${ids.size + 1}`);
    const normalized = JSON.parse(JSON.stringify(events, (_key, value) => ids.get(value) ?? value));
    output.push({ ...spec, events: normalized });
    await session.close();
  }
  const file = path.join(__dirname, "../tests/fixtures/conformance/claude-session.json");
  const verb = record(file, { generatedBy: "scripts/generate-session.cjs", cases: output }, 2);
  console.log(`${verb} ${output.length} session traces`);
  await ordinary();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Ordinary Chat launch options and control order through the actual SessionManager and ClaudeSession.
// bundled-skills.cjs is compiled unchanged over an explicit synthetic directory (fixed path, so the
// recorded skill paths are stable), then events.cjs and claude-provider.cjs are loaded against it.
// The fake SDK query records options and every control call; it starts no process.
async function ordinary() {
  const Module = require("node:module");
  const repo = path.resolve(__dirname, "../../..");
  const core = path.join(repo, "packages/core/src");
  const root = "/tmp/milagre-ordinary-oracle";
  fs.mkdirSync(root, { mode: 0o700 });
  try {
    const bundle = {
      tldrDefault: "﻿ Synthetic TLDR rules for the ordinary fixture.\r\n\r\nKeep it short. \n",
      agentMd: "Shared synthetic QA rules.\r\n",
      personas: [
        ["qa-first.md", "---\nname: qa-first\ndescription: First synthetic persona.\n---\n\nFirst persona body.\n"],
        ["qa-second.md", "---\r\nname: qa-second\r\ndescription: Second synthetic persona.\r\n---\r\nSecond persona body.\r\n"],
      ],
    };
    const files = { "tldr/default.md": bundle.tldrDefault, "qa-fleet/agent.md": bundle.agentMd };
    for (const [file, text] of bundle.personas) files[`qa-fleet/personas/${file}`] = text;
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, "bundled-skills", file)), { recursive: true });
      fs.writeFileSync(path.join(root, "bundled-skills", file), text);
    }
    const bundledPath = path.join(core, "bundled-skills.cjs");
    const fake = new Module(path.join(root, "bundled-skills.cjs"), module);
    fake.filename = path.join(root, "bundled-skills.cjs");
    // Node resolves this unchanged module against the explicit synthetic bundle root.
    // eslint-disable-next-line no-underscore-dangle
    fake.paths = Module._nodeModulePaths(root);
    // Node must compile the real source at the synthetic bundle filename for path parity.
    // eslint-disable-next-line no-underscore-dangle
    fake._compile(fs.readFileSync(bundledPath, "utf8"), fake.filename);
    fake.loaded = true;
    for (const name of ["agents/events.cjs", "agents/claude-provider.cjs"]) delete require.cache[path.join(core, name)];
    require.cache[bundledPath] = fake;
    const events = require(path.join(core, "agents/events.cjs"));
    const { ClaudeSession: OrdinarySession } = require(path.join(core, "agents/claude-provider.cjs"));
    const { SessionManager } = require(path.join(core, "agents/session-manager.cjs"));
    const host = { name: "fixture-host", addresses: ["192.0.2.10"] };
    const config = path.join(root, "config");
    fs.mkdirSync(config);
    const queries = [];
    const sdk = () => ({
      query: ({ prompt, options }) => {
        const record = { options, controls: [] };
        queries.push(record);
        const input = prompt[Symbol.asyncIterator]();
        const pending = [];
        let wake = null;
        let ended = false;
        void (async () => {
          for (;;) {
            const next = await input.next();
            if (next.done) break;
            record.controls.push({ user: next.value.message.content });
            const id = "fixture-session";
            pending.push({ type: "system", subtype: "init", session_id: id }, text("ordinary reply"), result);
            wake?.();
          }
          ended = true;
          wake?.();
        })();
        const call =
          (name) =>
          async (...args) => {
            record.controls.push({ [name]: args });
          };
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            // The producer and iterator.return update this state while next awaits their wakeup.
            // eslint-disable-next-line no-unmodified-loop-condition
            while (!pending.length && !ended) await new Promise((resolve) => (wake = resolve));
            await new Promise(setImmediate);
            return pending.length ? { value: pending.shift(), done: false } : { done: true };
          },
          async return() {
            ended = true;
            wake?.();
            return { done: true };
          },
          setModel: call("setModel"),
          setPermissionMode: call("setPermissionMode"),
          applyFlagSettings: call("applyFlagSettings"),
          setMaxThinkingTokens: call("setMaxThinkingTokens"),
          toggleMcpServer: call("toggleMcpServer"),
          interrupt: call("interrupt"),
        };
      },
    });
    const sent = [];
    let ended;
    const manager = new SessionManager({
      createSession: (_provider, options) =>
        new OrdinarySession({ ...options, command: "/fake/claude", defaultConfigDir: config, env: {}, loadSdk: async () => sdk() }),
      send: (_chat, event) => {
        sent.push(event);
        if (events.isTerminal(event)) ended?.();
      },
      hostInstructions: () => events.hostNetworkInstructions(host),
      batchMs: 0,
    });
    const base = {
      chatId: "/fixture#1",
      provider: "claude",
      cwd: "/fixture",
      model: "sonnet",
      permissionMode: "ask",
      effort: "high",
      ultracode: false,
      fastMode: false,
    };
    const turns = [
      { prompt: "first ordinary", replies: "concise", tldrEnabled: true },
      { prompt: "second ordinary", replies: "normal", tldrEnabled: true },
      { prompt: "third ordinary", replies: "normal", tldrEnabled: false },
    ];
    for (const turn of turns) {
      const done = new Promise((resolve) => (ended = resolve));
      await manager.startTurn({ ...base, ...turn });
      await done;
    }
    await manager.closeAll?.();
    const recorded = queries.map(({ options, controls }) => {
      const subagentStart = options.hooks?.SubagentStart?.map((matcher) => matcher.hooks.length);
      return {
        options: JSON.parse(JSON.stringify(options)),
        settingsText: JSON.stringify(options.settings),
        functions: Object.keys(options).filter((key) => typeof options[key] === "function"),
        hooks: Object.fromEntries(Object.entries(options.hooks ?? {}).map(([name, matchers]) => [name, matchers.map((m) => m.hooks.length)])),
        subagentStart: subagentStart ? null : undefined,
        controls,
      };
    });
    for (const [index, { options }] of queries.entries()) {
      recorded[index].subagentStart = options.hooks?.SubagentStart ? await options.hooks.SubagentStart[0].hooks[0]({}) : null;
      recorded[index].preToolUse = options.hooks?.PreToolUse
        ? await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "ls" } })
        : null;
    }
    // promptSuggestionsEnabled over explicit config-dir settings text and environment values.
    const suggestions = [];
    const settingsCases = [
      null,
      "{}",
      '{"promptSuggestionEnabled":false}',
      '{"promptSuggestionEnabled":true}',
      "not json",
      "null",
      "5",
      '{"promptSuggestionEnabled":"false"}',
      '{"promptSuggestionEnabled":false,"x":"\\ud800"}',
      '{"promptSuggestionEnabled":false,"promptSuggestionEnabled":true}',
    ];
    for (const settings of settingsCases)
      for (const envValue of [undefined, "false", "0", "true"]) {
        const dir = path.join(root, `suggest-${suggestions.length}`);
        fs.mkdirSync(dir);
        if (settings !== null) fs.writeFileSync(path.join(dir, "settings.json"), settings);
        const env = envValue === undefined ? {} : { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: envValue };
        let options;
        const session = new OrdinarySession({
          cwd: "/fixture",
          command: "/fake/claude",
          defaultConfigDir: dir,
          env,
          emit: () => {},
          loadSdk: async () => ({
            query: (args) => {
              options = args.options;
              return {
                async next() {
                  return new Promise(() => {});
                },
                [Symbol.asyncIterator]() {
                  return this;
                },
                async return() {
                  return { done: true };
                },
                async setMaxThinkingTokens() {},
              };
            },
          }),
        });
        await session.start("sonnet", "default", undefined);
        suggestions.push({ settings, env: envValue ?? null, promptSuggestions: options.promptSuggestions });
        await session.close();
      }
    const output = {
      generatedBy: "scripts/generate-session.cjs (ordinary)",
      node: process.version,
      bundle: { skillsDir: fake.exports.BUNDLED_SKILLS_DIRECTORY, ...bundle },
      host,
      request: base,
      turns,
      queries: recorded,
      events: sent.filter((event) => ["turn-started", "session-started", "turn-completed"].includes(event.type)).map((event) => event.type),
      promptSuggestions: suggestions,
    };
    const verb = record(path.join(__dirname, "../tests/fixtures/conformance/claude-ordinary.json"), output, 1);
    console.log(`${verb} ordinary trace: ${queries.length} queries, ${suggestions.length} suggestion cases`);
    await modes({ OrdinarySession, SessionManager, events, host, config, bundle: output.bundle, core });
    await liveModes({ OrdinarySession, SessionManager, events, host, config, bundle: output.bundle });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (fs.existsSync(root)) throw Error(`temporary oracle root ${root} was not removed`);
  console.log("ordinary temporary root removed");
}

// Permission modes through the actual SessionManager and ClaudeSession: a first turn in Full, then Auto with a new effort,
// then Ask. Each turn's fake CLI asks canUseTool for one Bash command; cards are answered through the manager (Auto
// allow, Ask deny) and each result is recorded. Then WorkspaceAccess.answer over a real temporary layout.
async function modes({ OrdinarySession, SessionManager, events, host, config, bundle, core }) {
  const queries = [];
  const permissions = [];
  const sent = [];
  let ended;
  let manager;
  const sdk = () => ({
    query: ({ prompt, options }) => {
      const record = { options, controls: [] };
      queries.push(record);
      const input = prompt[Symbol.asyncIterator]();
      const pending = [];
      let wake = null;
      let done = false;
      let turn = 0;
      void (async () => {
        for (;;) {
          const next = await input.next();
          if (next.done) break;
          record.controls.push({ user: next.value.message.content });
          const index = turn++;
          pending.push({ type: "system", subtype: "init", session_id: "fixture-session" });
          wake?.();
          const request = { requestId: `perm-${index}`, toolUseID: `tool-${index}`, suggestions: [], signal: new AbortController().signal };
          const result = await options.canUseTool("Bash", { command: "ls" }, request);
          permissions.push({ turn: index, request: { requestId: request.requestId, toolUseID: request.toolUseID }, result });
          pending.push(text("mode reply"), result);
          pending.push({ type: "result", subtype: "success", num_turns: 1, result: "done" });
          pending.splice(pending.indexOf(result), 1);
          wake?.();
        }
        done = true;
        wake?.();
      })();
      const call =
        (name) =>
        async (...args) => {
          record.controls.push({ [name]: args });
        };
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          // The producer and iterator.return update this state while next awaits their wakeup.
          // eslint-disable-next-line no-unmodified-loop-condition
          while (!pending.length && !done) await new Promise((resolve) => (wake = resolve));
          await new Promise(setImmediate);
          return pending.length ? { value: pending.shift(), done: false } : { done: true };
        },
        async return() {
          done = true;
          wake?.();
          return { done: true };
        },
        setModel: call("setModel"),
        setPermissionMode: call("setPermissionMode"),
        applyFlagSettings: call("applyFlagSettings"),
        setMaxThinkingTokens: call("setMaxThinkingTokens"),
        toggleMcpServer: call("toggleMcpServer"),
        interrupt: call("interrupt"),
      };
    },
  });
  const answers = { auto: "allow", ask: "deny" };
  let currentMode = null;
  manager = new SessionManager({
    createSession: (_provider, options) =>
      new OrdinarySession({ ...options, command: "/fake/claude", defaultConfigDir: config, env: {}, loadSdk: async () => sdk() }),
    send: (chatId, event) => {
      sent.push(event);
      if (event.type === "permission-request") setImmediate(() => manager.respondToPermission(chatId, event.requestId, answers[currentMode]));
      if (events.isTerminal(event)) ended?.();
    },
    hostInstructions: () => events.hostNetworkInstructions(host),
    batchMs: 0,
  });
  const base = {
    chatId: "/fixture#1",
    provider: "claude",
    cwd: "/fixture",
    model: "sonnet",
    ultracode: false,
    fastMode: false,
    replies: "concise",
    tldrEnabled: true,
  };
  const turns = [
    { prompt: "full turn", permissionMode: "full", effort: "high" },
    { prompt: "auto turn", permissionMode: "auto", effort: "low" },
    { prompt: "ask turn", permissionMode: "ask", effort: "low" },
  ];
  for (const turn of turns) {
    currentMode = turn.permissionMode;
    const done = new Promise((resolve) => (ended = resolve));
    await manager.startTurn({ ...base, ...turn });
    await done;
  }
  const recorded = [];
  for (const { options, controls } of queries)
    recorded.push({
      options: JSON.parse(JSON.stringify(options)),
      settingsText: JSON.stringify(options.settings),
      functions: Object.keys(options).filter((key) => typeof options[key] === "function"),
      subagentStart: options.hooks?.SubagentStart ? await options.hooks.SubagentStart[0].hooks[0]({}) : null,
      preToolUse: options.hooks?.PreToolUse ? await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "ls" } }) : null,
      controls,
    });
  // WorkspaceAccess.answer for a Project Chat over a real layout; paths are recorded with a <root> placeholder.
  const { WorkspaceAccess } = require(path.join(core, "agents/permissions.cjs"));
  const root = "/tmp/milagre-access-oracle";
  fs.mkdirSync(root, { mode: 0o700 });
  const layout = {
    dirs: ["project", "skills", "skills/sub", "outside"],
    files: ["project/notes.txt", "skills/doc.md", "skills/sub/inner.md", "outside/secret.md"],
    links: [
      ["project/skills-link", "../skills"],
      ["skills/escape", "../outside"],
      ["skills/dangling", "missing-target"],
    ],
  };
  const cases = [];
  try {
    for (const dir of layout.dirs) fs.mkdirSync(path.join(root, dir));
    for (const file of layout.files) fs.writeFileSync(path.join(root, file), "x");
    for (const [link, target] of layout.links) fs.symlinkSync(target, path.join(root, link));
    const access = new WorkspaceAccess({ cwd: path.join(root, "project"), skillsDirectory: path.join(root, "skills") });
    const R = (file) => file.replaceAll("<root>", root);
    const specs = [
      ["read", ["<root>/skills/doc.md"]],
      ["read", ["<root>/skills/new.md"]],
      ["read", ["<root>/skills/sub/missing/deep.md"]],
      ["read", ["<root>/skills"]],
      ["read", ["<root>/skills/"]],
      ["read", ["<root>/skills/escape/secret.md"]],
      ["read", ["<root>/skills/dangling"]],
      ["read", ["skills-link/doc.md"]],
      ["read", ["../skills/doc.md"]],
      ["read", ["./../skills/./sub//inner.md"]],
      ["read", ["<root>/skills/../outside/secret.md"]],
      ["read", ["<root>/skills/doc.md/child"]],
      ["read", []],
      ["read", ["<root>/skills/doc.md", "<root>/outside/secret.md"]],
      ["read", ["<root>/skills/doc.md", "../skills/sub/inner.md"]],
      ["read", ["notes.txt"]],
      ["read", ["<root>/skills\u0000x"]],
      ["edit", ["<root>/skills/doc.md"]],
      ["command", []],
      ["other", ["<root>/skills/doc.md"]],
    ];
    for (const mode of ["ask", "auto", "full"])
      for (const [kind, files] of specs) cases.push({ mode, kind, files, answer: access.answer({ kind, files: files.map(R) }, mode) });
    const missing = new WorkspaceAccess({ cwd: path.join(root, "project"), skillsDirectory: path.join(root, "no-skills") });
    cases.push({
      mode: "ask",
      kind: "read",
      files: ["<root>/no-skills/doc.md"],
      skills: "<root>/no-skills",
      answer: missing.answer({ kind: "read", files: [R("<root>/no-skills/doc.md")] }, "ask"),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (fs.existsSync(root)) throw Error(`temporary oracle root ${root} was not removed`);
  const output = {
    generatedBy: "scripts/generate-session.cjs (modes)",
    node: process.version,
    bundle,
    host,
    request: base,
    turns,
    queries: recorded,
    permissions,
    cards: sent.filter((event) => event.type === "permission-request" || event.type === "permission-resolved"),
    events: sent.filter((event) => ["turn-started", "session-started", "turn-completed"].includes(event.type)).map((event) => event.type),
    access: { layout, cases },
  };
  const verb = record(path.join(__dirname, "../tests/fixtures/conformance/claude-modes.json"), output, 1);
  console.log(`${verb} modes trace: ${queries.length} queries, ${permissions.length} permission answers, ${cases.length} access cases; access root removed`);
}

// A running Ask turn changes to Full, then back to Ask before its second request. Record the
// real provider's cards and SDK controls. The transport may write the released permission reply
// and native mode control independently, so the fixture asserts that pair without ordering it.
async function liveModes({ OrdinarySession, SessionManager, events, host, config, bundle }) {
  const within = (promise) => {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("live-mode oracle deadline")), 5000);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  const queries = [];
  const permissions = [];
  const sent = [];
  const waiters = new Map();
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  const ask = deferred();
  const ended = deferred();
  const waitCard = (id) => {
    if (sent.some((event) => event.type === "permission-request" && event.requestId === id)) return Promise.resolve();
    const waiter = deferred();
    waiters.set(id, waiter);
    return waiter.promise;
  };
  const manager = new SessionManager({
    createSession: (_provider, sessionOptions) =>
      new OrdinarySession({
        ...sessionOptions,
        command: "/fake/claude",
        defaultConfigDir: config,
        env: {},
        loadSdk: async () => ({
          query: ({ prompt, options }) => {
            const query = { options, controls: [] };
            queries.push(query);
            const input = prompt[Symbol.asyncIterator]();
            const pending = [];
            let wake;
            let done = false;
            const push = (...messages) => {
              pending.push(...messages);
              wake?.();
            };
            void (async () => {
              const next = await input.next();
              query.controls.push({ user: next.value.message.content });
              push({ type: "system", subtype: "init", session_id: "fixture-session" });
              for (let index = 0; index < 2; index++) {
                if (index) await ask.promise;
                const request = { requestId: `live-${index}`, toolUseID: `live-tool-${index}`, suggestions: [], signal: new AbortController().signal };
                const decision = await options.canUseTool("Bash", { command: "ls" }, request);
                permissions.push({ request: { requestId: request.requestId, toolUseID: request.toolUseID }, result: decision });
              }
              push(text("Claude fixture hello"), result);
            })();
            const call =
              (name) =>
              async (...args) => {
                query.controls.push({ [name]: args });
                if (name === "setPermissionMode" && args[0] === "default") ask.resolve();
              };
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                // The producer and iterator.return update this state while next awaits their wakeup.
                // eslint-disable-next-line no-unmodified-loop-condition
                while (!pending.length && !done) await new Promise((resolve) => (wake = resolve));
                await new Promise(setImmediate);
                return pending.length ? { value: pending.shift(), done: false } : { done: true };
              },
              async return() {
                done = true;
                wake?.();
                return { done: true };
              },
              setModel: call("setModel"),
              setPermissionMode: call("setPermissionMode"),
              applyFlagSettings: call("applyFlagSettings"),
              setMaxThinkingTokens: call("setMaxThinkingTokens"),
              toggleMcpServer: call("toggleMcpServer"),
              interrupt: call("interrupt"),
            };
          },
        }),
      }),
    send: (_chatId, event) => {
      sent.push(event);
      if (event.type === "permission-request") waiters.get(event.requestId)?.resolve();
      if (events.isTerminal(event)) ended.resolve();
    },
    hostInstructions: () => events.hostNetworkInstructions(host),
    batchMs: 0,
  });
  const request = {
    chatId: "/fixture#1",
    provider: "claude",
    cwd: "/fixture",
    model: "sonnet",
    ultracode: false,
    fastMode: false,
    replies: "concise",
    tldrEnabled: true,
  };
  const turn = { prompt: "live mode turn", permissionMode: "ask", effort: "high" };
  try {
    await within(manager.startTurn({ ...request, ...turn }));
    await within(waitCard("live-0"));
    await within(manager.setPermissionMode(request.chatId, "full"));
    await within(manager.setPermissionMode(request.chatId, "ask"));
    await within(waitCard("live-1"));
    await within(manager.respondToPermission(request.chatId, "live-1", "deny"));
    await within(ended.promise);
    await within(manager.setPermissionMode(request.chatId, "auto"));
    await within(manager.setPermissionMode(request.chatId, "ask"));
    const recorded = [];
    for (const { options, controls } of queries)
      recorded.push({
        options: JSON.parse(JSON.stringify(options)),
        settingsText: JSON.stringify(options.settings),
        functions: Object.keys(options).filter((key) => typeof options[key] === "function"),
        subagentStart: options.hooks?.SubagentStart ? await options.hooks.SubagentStart[0].hooks[0]({}) : null,
        preToolUse: options.hooks?.PreToolUse ? await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "ls" } }) : null,
        controls,
      });
    const output = {
      generatedBy: "scripts/generate-session.cjs (live modes)",
      node: process.version,
      bundle,
      host,
      request,
      turn,
      queries: recorded,
      permissions,
      cards: sent.filter((event) => event.type === "permission-request" || event.type === "permission-resolved"),
      events: sent.filter((event) => ["turn-started", "session-started", "turn-completed"].includes(event.type)).map((event) => event.type),
    };
    const verb = record(path.join(__dirname, "../tests/fixtures/conformance/claude-live-modes.json"), output, 1);
    console.log(`${verb} live modes trace: ${queries.length} query, ${permissions.length} permission answers`);
  } finally {
    await within(manager.closeAll());
  }
}
