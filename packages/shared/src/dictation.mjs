// Dictation on every platform: the language the speaker picked, and the words of the Chat's project the recognizer should
// expect. Whisper (desktop, Android) takes the words as its prompt; Apple's DictationTranscriber (iOS) as contextual strings,
// and the AI fix-up as its vocabulary.

/** "auto" lets Whisper detect languages. Explicit languages can use Apple dictation; `locale` is its default region. */
export const DICTATION_LANGUAGES = [
  { code: "auto", name: "Detect automatically (experimental)", locale: null },
  { code: "en", name: "English", locale: "en-US" },
  { code: "pt", name: "Portuguese", locale: "pt-BR" },
  { code: "es", name: "Spanish", locale: "es-ES" },
  { code: "fr", name: "French", locale: "fr-FR" },
  { code: "de", name: "German", locale: "de-DE" },
  { code: "it", name: "Italian", locale: "it-IT" },
  { code: "nl", name: "Dutch", locale: "nl-NL" },
  { code: "sv", name: "Swedish", locale: "sv-SE" },
  { code: "da", name: "Danish", locale: "da-DK" },
  { code: "no", name: "Norwegian", locale: "nb-NO" },
  { code: "fi", name: "Finnish", locale: "fi-FI" },
  { code: "pl", name: "Polish", locale: "pl-PL" },
  { code: "cs", name: "Czech", locale: "cs-CZ" },
  { code: "ro", name: "Romanian", locale: "ro-RO" },
  { code: "hu", name: "Hungarian", locale: "hu-HU" },
  { code: "el", name: "Greek", locale: "el-GR" },
  { code: "tr", name: "Turkish", locale: "tr-TR" },
  { code: "ru", name: "Russian", locale: "ru-RU" },
  { code: "uk", name: "Ukrainian", locale: "uk-UA" },
  { code: "ar", name: "Arabic", locale: "ar-SA" },
  { code: "he", name: "Hebrew", locale: "he-IL" },
  { code: "hi", name: "Hindi", locale: "hi-IN" },
  { code: "id", name: "Indonesian", locale: "id-ID" },
  { code: "ms", name: "Malay", locale: "ms-MY" },
  { code: "th", name: "Thai", locale: "th-TH" },
  { code: "vi", name: "Vietnamese", locale: "vi-VN" },
  { code: "ja", name: "Japanese", locale: "ja-JP" },
  { code: "ko", name: "Korean", locale: "ko-KR" },
  { code: "zh", name: "Chinese", locale: "zh-CN" },
];

const CODES = new Set(DICTATION_LANGUAGES.map((language) => language.code));

/** A saved setting as a known code, "auto" for anything else. */
export function dictationLanguage(value) {
  // The first automatic-detection experiment was named after the two languages used to test it.
  if (value === "pt-en") return "auto";
  return typeof value === "string" && CODES.has(value) ? value : "auto";
}

/**
 * The locale Apple transcribes in: the picked language's, or "" for the phone's first preferred language, which the
 * native side reads (its UI language, not the region format: "en-BR" is English with Brazilian dates, which no recognizer has).
 */
export function appleLocale(language) {
  return DICTATION_LANGUAGES.find((item) => item.code === language)?.locale ?? "";
}

// Words every Chat may name: the app, its agents and its own nouns.
const APP_TERMS = ["Milagre", "Claude", "Codex", "Antigravity", "Kiro", "Worktree", "Chat", "Routine", "Heartbeat", "MCP", "pull request"];
// Folder names that say nothing about the project.
const NOISE = new Set(["src", "lib", "dist", "build", "test", "tests", "app", "apps", "packages", "index", "main", "utils", "scripts", "docs", "assets"]);
const MAX_TERMS = 120;

/** A file's name without its extensions, kept when it reads as a word someone would say. */
function stem(file) {
  const name = String(file).split("/").at(-1) ?? "";
  const base = name.replace(/\..*$/, "");
  return base.length >= 3 && /[A-Za-z]/.test(base) && !NOISE.has(base.toLowerCase()) ? base : "";
}

/**
 * The words a dictated message about this project likely contains, most telling first: the app's names, the project, branch
 * and Chat title, then its code names (PascalCase and camelCase file names, which recognizers split or swap for common
 * words) and its folders. Unique, at most 120.
 */
export function dictationTerms({ projectName, branch, chatTitle, files = [] } = {}) {
  const terms = [...APP_TERMS];
  if (projectName) terms.push(projectName);
  if (branch && !/^(main|master|HEAD)$/.test(branch)) terms.push(branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " "));
  if (chatTitle) terms.push(chatTitle);
  const code = [];
  const folders = [];
  for (const file of files) {
    const parts = String(file).split("/");
    // Hidden folders hold tooling (.github, .milagre), not what the project is about.
    if (parts.some((part) => part.startsWith("."))) continue;
    const name = stem(file);
    if (name && /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]/.test(name)) code.push(name);
    for (const folder of parts.slice(0, -1)) if (!NOISE.has(folder.toLowerCase()) && !folder.includes(".")) folders.push(folder);
  }
  terms.push(...code, ...folders);
  const seen = new Set();
  return terms
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TERMS);
}

// Whisper reads at most 224 tokens of prompt and drops the start of a longer one; about 600 characters stays under that.
const PROMPT_CHARACTERS = 600;

/** Whisper's prompt: the terms as a comma list, cut at a term boundary so the most telling ones stay. */
export function whisperPrompt(terms, language) {
  // An example of switching languages helps preserve the original speech instead of translating minority-language words.
  // It is example text, not a forced language list. Keep it before vocabulary so long project names cannot crowd it out.
  const hint = language && dictationLanguage(language) === "auto" ? "Olá, vamos conversar and switch languages when needed. " : "";
  let prompt = "";
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (hint.length + next.length > PROMPT_CHARACTERS) break;
    prompt = next;
  }
  return `${hint}${prompt ? `${prompt}.` : ""}`.trimEnd();
}

/** Normalize saved language preferences, including the first automatic-detection experiment. */
export function whisperLanguage(language) {
  return dictationLanguage(language);
}

// whisper.cpp's multilingual models, pinned to one revision and checked by hash. The desktop runs large-v3-turbo, the most
// accurate with accents and mixed languages that a laptop transcribes in seconds; a phone's CPU gets small.
const WHISPER_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const whisperModel = (file, size, sha256) => ({
  file,
  size,
  sha256,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}/${file}`,
});
export const WHISPER_MODELS = {
  desktop: whisperModel("ggml-large-v3-turbo-q5_0.bin", 574041195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
  phone: whisperModel("ggml-small-q5_1.bin", 190085487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"),
};

// Whisper's stand-ins for silence and noise, and the lines it invents on a silent clip.
const NON_SPEECH = /\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)[^\]]*\]|\((?:music|silence|noise|inaudible)[^)]*\)/gi;

/** Whisper's text without its non-speech markers, "" when nothing else was said. */
export function whisperText(text) {
  return String(text ?? "")
    .replace(NON_SPEECH, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// On a silent clip Whisper writes a line it learned from video captions ("Thank you."), so silence never reaches it.
const SPEECH_DB = -45;
const WINDOW = 1600; // 100 ms at 16 kHz

/** Whether 16-bit samples never get louder than a quiet room, measured over 100 ms windows. */
export function silentPcm(samples) {
  for (let start = 0; start < samples.length; start += WINDOW) {
    const end = Math.min(samples.length, start + WINDOW);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i] / 32768) ** 2;
    if (10 * Math.log10(sum / (end - start) || 1e-16) > SPEECH_DB) return false;
  }
  return true;
}
