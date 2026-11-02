import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DICTATION_LANGUAGES,
  WHISPER_MODELS,
  appleLocale,
  chatTerms,
  codeNames,
  dictationLanguage,
  dictationTerms,
  whisperLanguage,
  whisperModelFor,
  whisperPrompt,
  snapTerms,
} from "./dictation.mjs";

test("terms lead with the app and project, keep code names and folders, and drop noise and repeats", () => {
  const terms = dictationTerms({
    projectName: "milagre-ade",
    branch: "milagre/voice-on-desktop",
    chatTitle: "Desktop dictation",
    files: [
      "apps/desktop/app/src/components/PromptComposer.tsx",
      "src/useVoiceDictation.ts",
      "src/index.ts",
      "README.md",
      "apps/mobile/src/voice.ts",
      ".milagre/runtime.lock/owner.json",
    ],
  });
  assert.equal(terms[0], "Milagre");
  assert.ok(terms.includes("milagre-ade"));
  assert.ok(terms.includes("voice on desktop"));
  assert.ok(terms.includes("PromptComposer"));
  assert.ok(terms.includes("useVoiceDictation"));
  assert.ok(terms.includes("desktop") && terms.includes("mobile") && terms.includes("components"));
  assert.ok(!terms.includes("src") && !terms.includes("index") && !terms.includes("README") && !terms.includes("runtime.lock"));
  assert.equal(new Set(terms.map((term) => term.toLowerCase())).size, terms.length);
  assert.ok(!dictationTerms({ branch: "main" }).includes("main"));
});

test("the Whisper prompt stops at a whole term under its length", () => {
  const prompt = whisperPrompt(Array.from({ length: 200 }, (_, index) => `Term${index}`));
  assert.ok(prompt.length <= 601);
  assert.match(prompt, /Term\d+\.$/);
  assert.equal(whisperPrompt([]), "");
});

test("Apple's locale is the picked language's, else empty for the phone's own", () => {
  assert.equal(appleLocale("pt"), "pt-BR");
  assert.equal(appleLocale("auto"), "");
  assert.equal(dictationLanguage("xx"), "auto");
  assert.equal(dictationLanguage("ja"), "ja");
});

test("Whisper's non-speech markers are dropped", async () => {
  const { whisperText } = await import("./dictation.mjs");
  assert.equal(whisperText(" [BLANK_AUDIO] "), "");
  assert.equal(whisperText("open Milagre (music) now"), "open Milagre now");
});

test("a clip is silent until some 100 ms of it is louder than a quiet room", async () => {
  const { silentPcm } = await import("./dictation.mjs");
  const clip = new Int16Array(16000);
  assert.equal(silentPcm(clip), true);
  clip.fill(30, 0, 1600); // hiss, -61 dB
  assert.equal(silentPcm(clip), true);
  for (let i = 8000; i < 9600; i++) clip[i] = i % 2 ? 3000 : -3000; // a voice, -21 dB
  assert.equal(silentPcm(clip), false);
});

test("the initial bilingual experiment migrates to automatic detection without a duplicate choice", () => {
  assert.equal(dictationLanguage("pt-en"), "auto");
  assert.equal(DICTATION_LANGUAGES[0].name, "Detect automatically (experimental)");
  assert.equal(
    DICTATION_LANGUAGES.some((language) => language.code === "pt-en"),
    false,
  );
  assert.equal(whisperLanguage("pt-en"), "auto");
  assert.equal(whisperLanguage("pt"), "pt");
});

test("automatic detection keeps its multilingual example before long project vocabulary", () => {
  const prompt = whisperPrompt(
    Array.from({ length: 200 }, (_, index) => `Term${index}`),
    "auto",
  );
  assert.ok(prompt.startsWith("Olá, vamos conversar and switch languages when needed."));
  assert.ok(prompt.length <= 601);
  assert.match(prompt, /Term\d+\.$/);
  assert.equal(whisperPrompt(["Milagre"], "pt"), "Milagre.");
});

test("each platform offers four models, best first, and an unknown saved id falls back to the first", () => {
  for (const platform of ["desktop", "phone"]) {
    const models = WHISPER_MODELS[platform];
    assert.equal(models.length, 4);
    assert.equal(new Set(models.map((model) => model.id)).size, 4);
    assert.equal(models.filter((model) => model.english).length, 1);
    assert.equal(whisperModelFor(platform, "nope"), models[0]);
    assert.equal(whisperModelFor(platform, models[2].id), models[2]);
    for (const model of models) assert.match(model.url, new RegExp(`/${model.file.replace(".", "\\.")}$`));
  }
  assert.equal(whisperModelFor("desktop", undefined).id, "large-v3-turbo");
  assert.equal(whisperModelFor("phone", undefined).id, "small");
});

test("an English-only model always listens for English", () => {
  const english = WHISPER_MODELS.desktop.find((model) => model.english);
  assert.equal(whisperLanguage("pt", english), "en");
  assert.equal(whisperLanguage("auto", english), "en");
  assert.equal(whisperLanguage("pt", WHISPER_MODELS.desktop[0]), "pt");
});

test("the files being worked on come before the rest, kebab-case ones with their extension, and their names beside them", () => {
  const terms = dictationTerms({
    projectName: "milagre-ade",
    files: ["a/AccountSwitchDivider.tsx", "packages/shared/src/voice-dictation.ts", "apps/mobile/src/PromptComposer.tsx", ".github/ci.yml"],
    recent: ["packages/shared/src/voice-dictation.ts", "apps/mobile/src/PromptComposer.tsx", ".github/ci.yml", "src/index.ts"],
    names: ["insertDictation", "writeTake", "PromptComposerProps"],
  });
  const at = (term) => terms.indexOf(term);
  assert.ok(at("voice-dictation.ts") > at("milagre-ade"));
  assert.ok(at("insertDictation") > at("voice-dictation.ts") && at("insertDictation") < at("PromptComposer"));
  assert.ok(at("PromptComposer") < at("GitHub"), "what the user works on comes before the usual tools");
  assert.ok(at("GitHub") < at("AccountSwitchDivider"), "the usual tools come before the rest of the project");
  assert.ok(!terms.includes("ci.yml") && !terms.includes("index.ts"));
  for (const name of ["Claude Code", "OpenAI", "Gemini", "Supabase", "npm"]) assert.ok(terms.includes(name), name);
});

test("code names are a file's multi-word declarations, never its locals", () => {
  const source = [
    "export function insertDictation() {}",
    "export const DICTATION_SAMPLE_RATE = 16000;",
    "export const meterLevel = () => {};",
    "function writeTake() { const firstEnded = 1; }",
    "class PromptComposer {}",
    "export type DictationTake = {};",
    "    func transcribeAudio() {}",
    "def snap_terms(): pass",
    "module.exports = { dictationContext, polishDictation: polish };",
  ].join("\n");
  assert.deepEqual(codeNames(source, 20), [
    "insertDictation",
    "writeTake",
    "PromptComposer",
    "DictationTake",
    "transcribeAudio",
    "snap_terms",
    "meterLevel",
    "dictationContext",
    "polishDictation",
  ]);
  assert.equal(codeNames(source, 2).length, 2);
});

test("snapping spells the project's terms where the recognizer split or lowercased them", () => {
  const terms = [
    "Milagre",
    "Codex",
    "Claude Code",
    "GitHub",
    "OpenAI",
    "npm",
    "MCP",
    "voice-dictation.ts",
    "dictation.test.mjs",
    "useDictation",
    "createStreamingDictation",
    "PromptEditor",
    "Chat",
    "pull request",
  ];
  const cases = [
    ["Ask code X to open voice dictation dot ts.", "Ask Codex to open voice-dictation.ts."],
    ["The bug is in the use. Dictation hook.", "The bug is in the useDictation hook."],
    ["The create streaming dictation function seals it.", "The createStreamingDictation function seals it."],
    ["Run N P M test and list the M C P servers.", "Run npm test and list the MCP servers."],
    ["claude code reads git hub, open AI too.", "Claude Code reads GitHub, OpenAI too."],
    ["Fix dictation dot test dot mjs, then milagre.", "Fix dictation.test.mjs, then Milagre."],
    ["O arquivo voice dictation ponto ts quebrou.", "O arquivo voice-dictation.ts quebrou."],
    // Ordinary speech that happens to spell a term stays as said.
    ["We use dictation a lot.", "We use dictation a lot."],
    ["The prompt editor feels slow.", "The prompt editor feels slow."],
    ["Open a chat and the pull request.", "Open a chat and the pull request."],
    ["Use code, x marks it.", "Use code, x marks it."],
  ];
  for (const [heard, expected] of cases) assert.equal(snapTerms(heard, terms), expected, heard);
  assert.equal(snapTerms("open the PromptEditor component", terms), "open the PromptEditor component");
  assert.equal(snapTerms("open the prompt editor component", terms), "open the PromptEditor component");
  assert.equal(snapTerms("", terms), "");
  assert.equal(snapTerms("code x", []), "code x");
});

test("a Chat's names come from its newest turns first: files, code names and acronyms in backticks", () => {
  const terms = chatTerms([
    "See `packages/shared/src/voice-dictation.ts` and insertDictation(), then https://github.com/a/notes.md",
    "Now `useDictation.ts`, the `OTA` and mobile-bridge.cjs. I think PromptComposer.tsx too.",
  ]);
  assert.deepEqual(terms.slice(0, 4), ["useDictation", "mobile-bridge.cjs", "PromptComposer", "OTA"]);
  assert.ok(terms.includes("voice-dictation.ts") && terms.includes("insertDictation"));
  assert.ok(!terms.includes("notes.md") && !terms.includes("think"));
  assert.equal(
    chatTerms(
      Array.from({ length: 50 }, (_, index) => `fileNumber${index}`),
      5,
    ).length,
    5,
  );
  assert.deepEqual(chatTerms([]), []);
});

test("the Chat's names come right after its title, before the files being worked on", () => {
  const terms = dictationTerms({ projectName: "milagre-ade", chatTitle: "Dictation", chat: ["voice-dictation.ts"], recent: ["src/OtherThing.tsx"] });
  assert.equal(terms.indexOf("voice-dictation.ts"), terms.indexOf("Dictation") + 1);
  assert.ok(terms.indexOf("OtherThing") > terms.indexOf("voice-dictation.ts"));
});
