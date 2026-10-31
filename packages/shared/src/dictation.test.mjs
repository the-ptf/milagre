import { test } from "node:test";
import assert from "node:assert/strict";
import { DICTATION_LANGUAGES, appleLocale, dictationLanguage, dictationTerms, whisperLanguage, whisperPrompt } from "./dictation.mjs";

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
  assert.equal(DICTATION_LANGUAGES.some((language) => language.code === "pt-en"), false);
  assert.equal(whisperLanguage("pt-en"), "auto");
  assert.equal(whisperLanguage("pt"), "pt");
});

test("automatic detection keeps its multilingual example before long project vocabulary", () => {
  const prompt = whisperPrompt(Array.from({ length: 200 }, (_, index) => `Term${index}`), "auto");
  assert.ok(prompt.startsWith("Olá, vamos conversar and switch languages when needed."));
  assert.ok(prompt.length <= 601);
  assert.match(prompt, /Term\d+\.$/);
  assert.equal(whisperPrompt(["Milagre"], "pt"), "Milagre.");
});
