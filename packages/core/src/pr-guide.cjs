const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PROVIDERS } = require("@milagre/shared/providers");
const { extractJson } = require("./agents/antigravity-text.cjs");
const { createGit } = require("./git/client.cjs");
const { withTimeout } = require("./git-text.cjs");

// The review guide: a short tour of a PR in reading order (contract, implementation, callers and UI, tests),
// written by the Chat's own provider from the PR's diff. The model names files and line ranges; the code in
// each excerpt is copied from the head commit here, so a guide never shows code the PR doesn't have.
// Guides and which stops the user read are saved per PR, so the Mac and the phone share them.

const GUIDE_TIMEOUT_MS = 180_000;
const DIFF_BUDGET = 120_000;
const FILE_PATCH_LIMIT = 14_000;
const MAX_STOPS = 8;
const MAX_EXCERPT_LINES = 25;
const KINDS = new Set(["contract", "implementation", "ui", "tests", "config"]);
const ATTENTION = new Set(["risk", "tradeoff", "contract", "product", "accessibility"]);
const LETTERS = "ABCDEFGH";
const GUIDE_FAILED = "Couldn't write a guide for this PR. Try again in a moment.";

const SYSTEM = `You write review guides for pull requests. A guide walks a reviewer through a change in reading order:
the contract first (types, APIs, schemas), then the implementation, then callers and UI, then tests.
Write 2 to 6 stops (never more than 8). Each stop groups the files that belong together and says, in 2 to 4
plain sentences, what changed and why it matters. Point at the 1 to 3 places a reviewer must read with
excerpts: a path and a line range in the NEW file (3 to 25 lines) that the diff below adds or changes. Add up to
3 line notes per stop on single lines inside its excerpts. Flag at most one thing per stop that needs a human
judgement as "attention" (risk, tradeoff, contract, product or accessibility), only when there is one. End each
stop with 0 to 3 short questions a reviewer should ask. Use the exact file paths from the file list.
Plain words, no marketing, no emoji. Answer with JSON only.`;

const GUIDE_SCHEMA = {
  type: "object",
  properties: {
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          summary: { type: "string" },
          attention: {
            type: ["object", "null"],
            properties: { kind: { type: "string", enum: [...ATTENTION] }, text: { type: "string" } },
            required: ["kind", "text"],
            additionalProperties: false,
          },
          excerpts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
                notes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { line: { type: "integer" }, text: { type: "string" } },
                    required: ["line", "text"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["path", "startLine", "endLine", "notes"],
              additionalProperties: false,
            },
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, note: { type: "string" } },
              required: ["path", "note"],
              additionalProperties: false,
            },
          },
          questions: { type: "array", items: { type: "string" } },
        },
        required: ["title", "kind", "summary", "attention", "excerpts", "files", "questions"],
        additionalProperties: false,
      },
    },
  },
  required: ["stops"],
  additionalProperties: false,
};

const clip = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

function buildPrompt(pr, patches) {
  const files = pr.files.map((file) => `${file.path} (+${file.additions} -${file.deletions})`).join("\n");
  return [`PR #${pr.number}: ${pr.title}`, pr.body ? `Description:\n${clip(pr.body, 6000)}` : "", `Files (${pr.files.length}):\n${files}`, `Diff:\n${patches}`]
    .filter(Boolean)
    .join("\n\n");
}

/** The new-file line numbers each patch adds, so an excerpt can mark which of its lines the PR wrote. */
function addedLines(patch) {
  const added = new Set();
  let line = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!line) continue;
    if (row.startsWith("+") && !row.startsWith("+++")) added.add(line++);
    else if (row.startsWith(" ")) line++;
  }
  return added;
}

/** Keeps what the model named that the PR really has, and fills each excerpt from the head commit. */
async function shapeGuide(parsed, { pr, patches, show }) {
  const known = new Set(pr.files.map((file) => file.path));
  const contents = new Map();
  const fileLines = async (file) => {
    if (!contents.has(file))
      contents.set(
        file,
        show(file).then(
          (content) => content?.split("\n") ?? null,
          () => null,
        ),
      );
    return contents.get(file);
  };
  const stops = [];
  const covered = new Set();
  for (const raw of Array.isArray(parsed?.stops) ? parsed.stops.slice(0, MAX_STOPS) : []) {
    const title = clip(raw?.title, 120);
    const summary = clip(raw?.summary, 1500);
    if (!title || !summary) continue;
    const excerpts = [];
    let letter = 0;
    for (const excerpt of Array.isArray(raw.excerpts) ? raw.excerpts.slice(0, 3) : []) {
      if (!known.has(excerpt?.path)) continue;
      const lines = await fileLines(excerpt.path);
      if (!lines) continue;
      const start = Math.max(1, Math.trunc(Number(excerpt.startLine) || 0));
      const end = Math.min(lines.length, Math.trunc(Number(excerpt.endLine) || 0), start + MAX_EXCERPT_LINES - 1);
      if (end < start) continue;
      const added = addedLines(patches.get(excerpt.path) ?? "");
      const notes = [];
      for (const note of Array.isArray(excerpt.notes) ? excerpt.notes : []) {
        const line = Math.trunc(Number(note?.line) || 0);
        const text = clip(note?.text, 400);
        if (line >= start && line <= end && text && letter < LETTERS.length && notes.length < 3) notes.push({ letter: LETTERS[letter++], line, text });
      }
      excerpts.push({
        path: excerpt.path,
        startLine: start,
        endLine: end,
        lines: lines.slice(start - 1, end).map((text, index) => ({ number: start + index, text: text.slice(0, 400), added: added.has(start + index) })),
        notes,
      });
      covered.add(excerpt.path);
    }
    const files = (Array.isArray(raw.files) ? raw.files : [])
      .filter((file) => known.has(file?.path))
      .slice(0, 12)
      .map((file) => ({ path: file.path, note: clip(file.note, 200) }));
    for (const file of files) covered.add(file.path);
    const attention =
      ATTENTION.has(raw.attention?.kind) && clip(raw.attention?.text, 600) ? { kind: raw.attention.kind, text: clip(raw.attention.text, 600) } : undefined;
    stops.push({
      title,
      kind: KINDS.has(raw.kind) ? raw.kind : "implementation",
      summary,
      ...(attention && { attention }),
      excerpts,
      files,
      questions: (Array.isArray(raw.questions) ? raw.questions : [])
        .map((question) => clip(question, 300))
        .filter(Boolean)
        .slice(0, 3),
    });
  }
  if (!stops.length) return null;
  return { stops, notCovered: pr.files.map((file) => file.path).filter((file) => !covered.has(file)) };
}

const keyOf = (url) => crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 32);

/**
 * `review` is createPullRequestReview's object (for the PR and its diff), `models` the text models by provider
 * (each `({system, prompt, signal}) => string`), `directory` where guides are kept.
 */
function createPrGuides({ review, models, directory, env = process.env, now = () => new Date(), timeoutMs = GUIDE_TIMEOUT_MS }) {
  const git = createGit({ env }).read;
  const writing = new Map();
  const failures = new Map();

  const fileOf = (url) => path.join(directory, `${keyOf(url)}.json`);

  async function load(url) {
    try {
      const saved = JSON.parse(await fs.readFile(fileOf(url), "utf8"));
      return { guide: saved.guide ?? null, read: Array.isArray(saved.read) ? saved.read.filter(Number.isInteger) : [] };
    } catch {
      return { guide: null, read: [] };
    }
  }

  async function save(url, value) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = fileOf(url);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  async function generate({ cwd, number, provider, models: chosen }) {
    const detail = await review.detail({ cwd, number });
    if (!detail.ok) throw new Error(detail.message);
    const pr = detail.pr;
    const listed = await review.diffFiles({ cwd, base: pr.baseRefOid, head: pr.headRefOid });
    const patches = new Map();
    let budget = DIFF_BUDGET;
    const parts = [];
    for (const file of listed.files ?? []) {
      if (budget <= 0 || file.binary) continue;
      const one = await review.diffFile({ cwd, base: pr.baseRefOid, head: pr.headRefOid, path: file.path, oldPath: file.oldPath });
      if (!one.patch) continue;
      patches.set(file.path, one.patch);
      const part = one.patch.length > FILE_PATCH_LIMIT ? `${one.patch.slice(0, FILE_PATCH_LIMIT)}\n[... ${file.path} cut]` : one.patch;
      parts.push(part.slice(0, budget));
      budget -= part.length;
    }
    const prompt = buildPrompt(pr, parts.join("\n"));
    const order = [provider, ...PROVIDERS.filter((name) => name !== provider)];
    for (const name of order) {
      const call = chosen[name];
      if (!call) continue;
      let parsed;
      try {
        parsed = JSON.parse(extractJson(await withTimeout((signal) => call({ system: SYSTEM, prompt, signal }), timeoutMs)));
      } catch {
        continue;
      }
      const shaped = await shapeGuide(parsed, { pr, patches, show: (file) => git.text(cwd, ["show", `${pr.headRefOid}:${file}`]) });
      if (shaped) return { url: pr.url, guide: { headRefOid: pr.headRefOid, provider: name, writtenAt: now().toISOString(), ...shaped } };
    }
    throw new Error(GUIDE_FAILED);
  }

  return {
    async read({ url } = {}) {
      if (typeof url !== "string" || !url.startsWith("https://")) return { ok: false, message: "That PR has no address." };
      const saved = await load(url);
      const failed = failures.get(keyOf(url));
      return { ok: true, guide: saved.guide, read: saved.read, writing: writing.has(keyOf(url)), ...(failed && { error: failed }) };
    },

    /** Starts writing (or rewriting) the guide and returns at once; `read` reports `writing` until it is saved. */
    async write({ cwd, number, url, provider } = {}) {
      if (typeof url !== "string" || !url.startsWith("https://")) return { ok: false, message: "That PR has no address." };
      const key = keyOf(url);
      if (!writing.has(key)) {
        failures.delete(key);
        const task = generate({ cwd, number, provider: PROVIDERS.includes(provider) ? provider : "claude", models: models(cwd) })
          // A guide for the same PR keeps nothing from the last one, read marks included: its stops differ.
          .then((result) => save(url, { guide: result.guide, read: [] }))
          .catch((error) => failures.set(key, error?.message || GUIDE_FAILED))
          .finally(() => writing.delete(key));
        writing.set(key, task);
      }
      return { ok: true, writing: true };
    },

    async markRead({ url, stop, read = true } = {}) {
      if (typeof url !== "string" || !Number.isInteger(stop) || stop < 0 || stop >= MAX_STOPS) return { ok: false, message: "That stop isn't in the guide." };
      const saved = await load(url);
      if (!saved.guide) return { ok: false, message: "This PR has no guide yet." };
      const set = new Set(saved.read);
      if (read === false) set.delete(stop);
      else set.add(stop);
      await save(url, { guide: saved.guide, read: [...set].toSorted((a, b) => a - b) });
      return { ok: true };
    },

    /** Waits for every guide being written; tests and shutdown use it. */
    settled: () => Promise.allSettled(writing.values()),
  };
}

module.exports = { createPrGuides, shapeGuide, addedLines, GUIDE_SCHEMA, SYSTEM };
