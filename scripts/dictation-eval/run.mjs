#!/usr/bin/env node
// Dictation eval: how well each recognizer gets the technical words of a message to a coding agent right, and what the
// project vocabulary, term snapping and the AI fix-up each add. See README.md.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

// ---- options ----
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const flag = (name) => argv.includes(`--${name}`);
if (flag("help")) {
  console.log(`node scripts/dictation-eval/run.mjs [options]
  --engines apple,whisper          recognizers to score (default: both)
  --models large-v3-turbo,small    Whisper models (default: large-v3-turbo,small); downloaded once into the cache
  --voices Samantha,Daniel,Rishi   macOS voices for English cases (Portuguese cases use Luciana)
  --variants raw,main,new,snap     raw: no vocabulary. main: the vocabulary as main builds it. new: as this checkout
                                   builds it. snap: new + term snapping. polish: snap + the AI fix-up (Claude Haiku)
  --polish                         add the polish variant (calls Claude once per clip)
  --chat                           add the chat variant: snap with the words of a Chat that already discussed the code
                                   (chat.json); with --polish also chat-polish
  --local                          add the local variant: snap + the fix-up on Apple's on-device model
  --base <ref>                     git ref "main" is read from (default: main)
  --clips <dir>                    your own recordings, <case id>.wav (any format afconvert reads), scored as voice "you"
  --cases a,b                      only these case ids
  --cache <dir>                    audio, models and the Apple CLI (default: ~/.cache/milagre-dictation-eval)
  --out <dir>                      report folder (default: <cache>/runs/<time>)`);
  process.exit(0);
}
const list = (value) =>
  String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const cache = path.resolve(option("cache", path.join(os.homedir(), ".cache/milagre-dictation-eval")));
const engines = list(option("engines", "apple,whisper"));
const whisperModels = list(option("models", "large-v3-turbo,small"));
const voices = list(option("voices", "Samantha,Daniel,Rishi"));
const variants = list(option("variants", "raw,main,new,snap"));
if (flag("polish") && !variants.includes("polish")) variants.push("polish");
if (flag("local") && !variants.includes("local")) variants.push("local");
if (flag("chat") && !variants.includes("chat")) variants.push("chat");
if (flag("chat") && flag("polish") && !variants.includes("chat-polish")) variants.push("chat-polish");
const baseRef = option("base", "main");
const clips = option("clips", null);
const only = option("cases", null) ? new Set(list(option("cases"))) : null;
const out = path.resolve(option("out", path.join(cache, "runs", new Date().toISOString().replace(/[:.]/g, "-"))));
fs.mkdirSync(out, { recursive: true });

const corpus = JSON.parse(fs.readFileSync(path.join(here, "corpus.json"), "utf8")).cases.filter((item) => !only || only.has(item.id));
const PORTUGUESE_VOICE = "Luciana";
const CHAT_TITLE = "Dictation accuracy";

// ---- vocabulary: the same project context the app builds, from main and from this checkout ----
async function loadBaseModule() {
  const source = execFileSync("git", ["show", `${baseRef}:packages/shared/src/dictation.mjs`], { cwd: repo, encoding: "utf8" });
  const file = path.join(out, `dictation-${baseRef.replace(/\W+/g, "_")}.mjs`);
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}
const working = await import(pathToFileURL(path.join(repo, "packages/shared/src/dictation.mjs")).href);
const base = await loadBaseModule();
const lsFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
const baseTerms = base.dictationTerms({ projectName: path.basename(repo), branch: "main", chatTitle: CHAT_TITLE, files: lsFiles });
// This checkout's context, built the way core's dictationContext builds it but read at the base commit, so the files
// this branch changes don't count as the ones being worked on.
const { polishDictation, polishRequest, plausible } = require(path.join(repo, "packages/core/src/dictation.cjs"));
const gitAt = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 });
const present = new Set(lsFiles);
const recent = [
  ...new Set(
    gitAt("log", "-n60", "--name-only", "--no-renames", "--format=", baseRef)
      .split("\n")
      .map((line) => line.trim()),
  ),
].filter((file) => file && present.has(file));
const names = recent
  .filter(
    (file) =>
      /\.(?:[cm]?[jt]sx?|swift|kt|py|go|rs|rb|java|cs|php|dart|vue|svelte)$/.test(file) && !/(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\./.test(file),
  )
  .slice(0, 12)
  .flatMap((file) => (working.codeNames ? working.codeNames(gitAt("show", `${baseRef}:${file}`)) : []));
const origin = gitAt("remote", "get-url", "origin").trim();
const newTerms = working.dictationTerms({
  projectName: /([^/:]+?)(?:\.git)?\/?$/.exec(origin)?.[1] || path.basename(repo),
  branch: "main",
  chatTitle: CHAT_TITLE,
  files: lsFiles,
  recent,
  names,
});
// The same vocabulary inside a Chat that has already talked about the code.
const chatMessages = JSON.parse(fs.readFileSync(path.join(here, "chat.json"), "utf8")).messages;
const chatVocabulary = working.chatTerms
  ? working.dictationTerms({
      projectName: /([^/:]+?)(?:\.git)?\/?$/.exec(origin)?.[1] || path.basename(repo),
      branch: "main",
      chatTitle: CHAT_TITLE,
      chat: working.chatTerms(chatMessages),
      files: lsFiles,
      recent,
      names,
    })
  : newTerms;
const snap = typeof working.snapTerms === "function" ? working.snapTerms : (text) => text;
fs.writeFileSync(path.join(out, "vocabulary.json"), JSON.stringify({ base: baseTerms, new: newTerms, chat: chatVocabulary }, null, 2));

/** What a variant feeds the recognizer, and what it does to the text after. */
function variantOf(name, language) {
  switch (name) {
    case "raw":
      return { terms: [], prompt: "", post: (text) => text };
    case "main":
      return { terms: baseTerms, prompt: base.whisperPrompt(baseTerms, language), post: (text) => text };
    case "new":
      return { terms: newTerms, prompt: working.whisperPrompt(newTerms, language), post: (text) => text };
    case "chat":
    case "chat-polish":
      return { terms: chatVocabulary, prompt: working.whisperPrompt(chatVocabulary, language), post: (text) => snap(text, chatVocabulary) };
    case "snap":
    case "polish":
    case "local":
      return { terms: newTerms, prompt: working.whisperPrompt(newTerms, language), post: (text) => snap(text, newTerms) };
    default:
      throw new Error(`Unknown variant ${name}`);
  }
}

// ---- audio ----
function wavPcm(file) {
  const buffer = fs.readFileSync(file);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return buffer.buffer.slice(buffer.byteOffset + offset + 8, buffer.byteOffset + offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  throw new Error(`${file} has no data chunk`);
}

const say = (voice, text, file) => execFileSync("say", ["-v", voice, "-o", file, "--data-format=LEI16@16000", text]);
const toPcm16k = (input, file) => execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input, file]);

/** Every clip to score: synthesized speech per voice, and the user's own recordings. */
function buildClips() {
  const items = [];
  for (const item of corpus) {
    const itemVoices = item.language === "pt" ? [PORTUGUESE_VOICE] : voices;
    for (const voice of itemVoices) {
      const key = createHash("sha1").update(`${voice}\0${item.spoken}`).digest("hex").slice(0, 10);
      const file = path.join(cache, "audio", voice, `${item.id}-${key}.wav`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        say(voice, item.spoken, file);
      }
      items.push({ item, voice, file });
    }
    if (clips) {
      const recorded = fs.readdirSync(clips).find((name) => path.parse(name).name === item.id);
      if (recorded) {
        const file = path.join(out, "clips", `${item.id}.wav`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        toPcm16k(path.join(clips, recorded), file);
        items.push({ item, voice: "you", file });
      }
    }
  }
  return items;
}

// ---- recognizers ----
function swiftTool(name) {
  const binary = path.join(cache, "bin", name);
  const source = path.join(here, `${name}.swift`);
  const stamp = `${binary}.sha`;
  const digest = createHash("sha1").update(fs.readFileSync(source)).digest("hex");
  if (!fs.existsSync(binary) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== digest) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    execFileSync("swiftc", ["-O", "-parse-as-library", source, "-o", binary], { stdio: "inherit" });
    fs.writeFileSync(stamp, digest);
  }
  return binary;
}
const appleCli = () => swiftTool("apple-transcribe");

/** The fix-up on Apple's on-device model, for a batch of texts in one process; a reply that isn't a correction is dropped. */
function localPolish(texts, terms) {
  const input = texts.map((text) => JSON.stringify(polishRequest({ text, terms, chatTitle: CHAT_TITLE }))).join("\n");
  const result = spawnSync(swiftTool("apple-polish"), [], { input, encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`apple-polish failed: ${result.stderr}`);
  const replies = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return texts.map((text, index) => {
    const reply = replies[index] ?? {};
    // A small model sometimes echoes the prompt's tags around a name.
    const answer = typeof reply.text === "string" ? reply.text.replace(/<\/?[A-Za-z_]+>/g, "").trim() : "";
    const fixed = answer && text.trim() && plausible(text, answer) ? answer : text;
    return { text: fixed, extra: reply.ms ?? 0 };
  });
}

/** Apple's dictation: one process per (language, variant) so the words are set once, as the phone sets them per take. */
function runApple(batch, terms, language) {
  const binary = appleCli();
  const words = path.join(out, `words-${createHash("sha1").update(terms.join("\n")).digest("hex").slice(0, 8)}.txt`);
  fs.writeFileSync(words, terms.join("\n"));
  const locale = working.appleLocale(language) || "en-US";
  const result = spawnSync(binary, [locale, terms.length ? words : "-", ...batch.map((clip) => clip.file)], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`apple-transcribe failed: ${result.stderr}`);
  const byFile = new Map(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((row) => [row.file, row]),
  );
  return batch.map((clip) => ({ text: byFile.get(clip.file)?.text ?? "", ms: byFile.get(clip.file)?.ms ?? 0, error: byFile.get(clip.file)?.error }));
}

async function whisperModelFile(id) {
  const model = working.WHISPER_MODELS.desktop.find((item) => item.id === id) ?? working.WHISPER_MODELS.phone.find((item) => item.id === id);
  if (!model) throw new Error(`Unknown Whisper model ${id}`);
  const file = path.join(cache, "models", model.file);
  if (fs.existsSync(file) && fs.statSync(file).size === model.size) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.error(`Downloading ${model.file} (${Math.round(model.size / 1e6)} MB)…`);
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${model.url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== model.sha256) throw new Error(`${model.file} failed its hash check`);
  fs.writeFileSync(file, data);
  return file;
}

const whisperContexts = new Map();
async function whisperContext(id) {
  if (!whisperContexts.has(id)) {
    const { initWhisper } = require(path.join(repo, "node_modules/@fugood/whisper.node"));
    whisperContexts.set(id, initWhisper({ filePath: await whisperModelFile(id), useGpu: true }));
  }
  return whisperContexts.get(id);
}

async function runWhisper(model, batch, prompt, language) {
  const whisper = await whisperContext(model);
  const rows = [];
  for (const clip of batch) {
    const started = Date.now();
    const { promise } = whisper.transcribeData(wavPcm(clip.file), {
      language: working.whisperLanguage(
        language,
        working.WHISPER_MODELS.desktop.find((item) => item.id === model),
      ),
      prompt: prompt || undefined,
      temperature: 0,
      maxThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
    });
    const { result } = await promise;
    rows.push({ text: working.whisperText(result), ms: Date.now() - started });
  }
  return rows;
}

// ---- the AI fix-up, as the app calls it ----
const claudeBin = (() => {
  for (const candidate of [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"])
    if (fs.existsSync(candidate)) return candidate;
  return null;
})();
let polishModels = null;
async function polish(text, terms) {
  if (!polishModels) {
    const { createDictationModels } = require(path.join(repo, "packages/core/src/dictation.cjs"));
    polishModels = createDictationModels({
      cli: async (name) => (name === "claude" && claudeBin ? { command: claudeBin } : { problem: "skipped" }),
      clientVersion: "eval",
    });
    polishModels = { claude: polishModels.claude };
  }
  return (await polishDictation({ text, terms, chatTitle: CHAT_TITLE, provider: "claude" }, { models: polishModels })).text;
}

async function mapLimit(items, limit, work) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index], index);
      }
    }),
  );
  return results;
}

// ---- scoring ----
const words = (text) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
function wordErrors(reference, hypothesis) {
  const a = words(reference);
  const b = words(hypothesis);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return { errors: previous[b.length], length: a.length };
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The term spelled exactly, not as part of a longer name. */
const hasTerm = (text, term) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(term)}(?![\\p{L}\\p{N}_-])`, "u").test(text);

// ---- run ----
const items = buildClips();
console.error(`${items.length} clips, engines ${engines.join(", ")}, variants ${variants.join(", ")}`);
const rows = [];
const groups = (key) => {
  const map = new Map();
  for (const clip of items) {
    const name = key(clip);
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(clip);
  }
  return map;
};
const recognizers = [
  ...(engines.includes("apple") ? [{ engine: "apple", model: "dictation" }] : []),
  ...(engines.includes("whisper") ? whisperModels.map((model) => ({ engine: "whisper", model })) : []),
];
for (const { engine, model } of recognizers) {
  // polish reuses snap's transcript; recognizing once per vocabulary keeps the run short.
  const recognized = new Map();
  for (const variant of variants) {
    for (const [language, batch] of groups((clip) => clip.item.language)) {
      // Apple's Portuguese dictation on macOS 27.0 returns only the first word of a clip, so it can't stand in for the phone's.
      if (engine === "apple" && language !== "en") continue;
      const setup = variantOf(variant, language);
      const recognizeKey = `${["snap", "polish", "local"].includes(variant) ? "new" : variant === "chat-polish" ? "chat" : variant}:${language}`;
      if (!recognized.has(recognizeKey)) {
        console.error(`${engine}/${model} ${recognizeKey} (${batch.length} clips)`);
        recognized.set(recognizeKey, engine === "apple" ? runApple(batch, setup.terms, language) : await runWhisper(model, batch, setup.prompt, language));
      }
      const heard = recognized.get(recognizeKey);
      const finals =
        variant === "local"
          ? localPolish(
              batch.map((clip, index) => setup.post(heard[index].text)),
              setup.terms,
            )
          : await mapLimit(batch, variant.endsWith("polish") ? 6 : 1, async (clip, index) => {
              const snapped = setup.post(heard[index].text);
              if (!variant.endsWith("polish")) return { text: snapped, extra: 0 };
              const started = Date.now();
              return { text: await polish(snapped, setup.terms), extra: Date.now() - started };
            });
      batch.forEach((clip, index) => {
        const text = finals[index].text;
        const { errors, length } = wordErrors(clip.item.expected, text);
        const found = clip.item.terms.filter((term) => hasTerm(text, term));
        rows.push({
          engine,
          model,
          variant,
          voice: clip.voice,
          language: clip.item.language,
          id: clip.item.id,
          control: clip.item.terms.length === 0,
          expected: clip.item.expected,
          heard: heard[index].text,
          text,
          errors,
          length,
          terms: clip.item.terms.length,
          found: found.length,
          missed: clip.item.terms.filter((term) => !found.includes(term)),
          ms: heard[index].ms + finals[index].extra,
        });
      });
    }
  }
}
for (const context of whisperContexts.values()) await (await context).release?.();

// ---- report ----
const percent = (value) => `${(100 * value).toFixed(1)}%`;
function summarize(filter) {
  const picked = rows.filter(filter);
  const termTotal = picked.reduce((sum, row) => sum + row.terms, 0);
  const termFound = picked.reduce((sum, row) => sum + row.found, 0);
  const speech = picked.filter((row) => !row.control);
  const controls = picked.filter((row) => row.control);
  const wer = (set) =>
    set.reduce((sum, row) => sum + row.errors, 0) /
    Math.max(
      1,
      set.reduce((sum, row) => sum + row.length, 0),
    );
  return {
    clips: picked.length,
    termRecall: termTotal ? termFound / termTotal : 0,
    wer: wer(speech),
    controlWer: wer(controls),
    ms: picked.reduce((sum, row) => sum + row.ms, 0) / Math.max(1, picked.length),
  };
}
const lines = [
  `# Dictation eval`,
  "",
  `${items.length} clips · voices ${[...new Set(items.map((clip) => clip.voice))].join(", ")} · vocabulary ${baseRef}: ${baseTerms.length} terms, this checkout: ${newTerms.length}`,
  "",
];
lines.push("| Recognizer | Variant | Term recall | WER | Control WER | ms/clip |", "|---|---|---|---|---|---|");
const summary = [];
for (const { engine, model } of recognizers)
  for (const variant of variants) {
    const result = summarize((row) => row.engine === engine && row.model === model && row.variant === variant);
    summary.push({ engine, model, variant, ...result });
    lines.push(
      `| ${engine} ${model} | ${variant} | ${percent(result.termRecall)} | ${percent(result.wer)} | ${percent(result.controlWer)} | ${Math.round(result.ms)} |`,
    );
  }
lines.push(
  "",
  "## By voice (term recall)",
  "",
  `| Recognizer | Variant | ${[...new Set(items.map((clip) => clip.voice))].join(" | ")} |`,
  `|---|---|${[...new Set(items.map((clip) => clip.voice))].map(() => "---").join("|")}|`,
);
for (const { engine, model } of recognizers)
  for (const variant of variants)
    lines.push(
      `| ${engine} ${model} | ${variant} | ${[...new Set(items.map((clip) => clip.voice))]
        .map((voice) => {
          const result = summarize((row) => row.engine === engine && row.model === model && row.variant === variant && row.voice === voice);
          return result.clips ? percent(result.termRecall) : "–";
        })
        .join(" | ")} |`,
    );
const missedCount = new Map();
for (const row of rows.filter((item) => item.variant === variants.at(-1)))
  for (const term of row.missed) missedCount.set(term, (missedCount.get(term) ?? 0) + 1);
lines.push(
  "",
  `## Most missed terms (${variants.at(-1)})`,
  "",
  [...missedCount]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([term, count]) => `${term} ×${count}`)
    .join(", ") || "none",
);
fs.writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ summary, rows }, null, 2));
console.log(lines.join("\n"));
console.log(`\nTranscripts: ${path.join(out, "results.json")}`);
