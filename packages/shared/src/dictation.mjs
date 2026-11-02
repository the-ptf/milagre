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

// Names every Chat may say, which recognizers swap for common words ("code X", "cloud", "Cairo"): Milagre's own nouns,
// its agents and their models.
const APP_TERMS = [
  "Milagre",
  "Claude",
  "Claude Code",
  "Codex",
  "Antigravity",
  "Kiro",
  "Opus",
  "Sonnet",
  "Haiku",
  "Worktree",
  "Chat",
  "Routine",
  "Heartbeat",
  "MCP",
  "ACP",
  "pull request",
];
// Providers, tools and services a message to a coding agent names in any project.
const DEV_TERMS = [
  "GitHub",
  "OpenAI",
  "Gemini",
  "GPT",
  "Anthropic",
  "TypeScript",
  "JavaScript",
  "React",
  "React Native",
  "Expo",
  "Expo Router",
  "Electron",
  "Node",
  "npm",
  "Vite",
  "Tailwind",
  "Supabase",
  "Vercel",
  "Cloudflare",
  "Docker",
  "Postgres",
  "Linear",
  "Slack",
  "Xcode",
  "TestFlight",
  "iOS",
  "iPad",
  "Android",
  "API",
  "CLI",
  "SDK",
  "JSON",
  "CI",
  "PR",
  "OTA",
  "EAS",
];
// Folder names that say nothing about the project.
const NOISE = new Set(["src", "lib", "dist", "build", "test", "tests", "app", "apps", "packages", "index", "main", "utils", "scripts", "docs", "assets"]);
const MAX_TERMS = 150;
/** How long a take's first inference waits for the project's words before it goes without them. */
export const VOCABULARY_WAIT_MS = 1500;
const RECENT_FILES = 20;
const CODE_NAME = /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|[a-z]_[a-z]/;

/** A file's name without its extensions, kept when it reads as a word someone would say. */
function stem(file) {
  const name = String(file).split("/").at(-1) ?? "";
  const base = name.replace(/\..*$/, "");
  return base.length >= 3 && /[A-Za-z]/.test(base) && !NOISE.has(base.toLowerCase()) ? base : "";
}

/**
 * How someone names a file they're working on: a code name as it is ("PromptComposer"), anything else with its extension
 * ("voice-dictation.ts"), which is how it gets said ("voice dictation dot ts").
 */
function fileTerm(file) {
  const name = String(file).split("/").at(-1) ?? "";
  const base = stem(file);
  if (!base) return "";
  if (CODE_NAME.test(base)) return base;
  return /\.[A-Za-z0-9]{1,5}$/.test(name) ? name : "";
}

/**
 * The names a source file declares that someone would say: functions, classes, types and exported constants with more
 * than one word in them (`createStreamingDictation`, `PromptComposer`, `snap_terms`), in the order they appear, at most `limit`.
 */
export function codeNames(source, limit = 8) {
  const names = [];
  const add = (name) => {
    if (name.length >= 6 && CODE_NAME.test(name) && !names.includes(name)) names.push(name);
  };
  const text = String(source ?? "").slice(0, 200_000);
  // Declarations at the start of a line (top level, or a type's members) and exported constants: a test's locals never.
  const declaration =
    /^[ \t]*(?:(?:export|default|async|public|private|internal|static|pub|open|final)\s+)*(?:function\*?|class|def|func|fn|struct|protocol|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(declaration)) add(match[1]);
  for (const match of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(match[1]);
  for (const match of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g))
    for (const name of match[1].split(/[\s,:]+/)) if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name);
  return names.slice(0, limit);
}

const FILE_NAME =
  /[\w.-]*[A-Za-z][\w-]*\.(?:[cm]?[jt]sx?|d\.ts|json|md|mdx|swift|kt|kts|py|go|rs|rb|java|cs|css|scss|html|ya?ml|toml|sh|sql|vue|svelte|dart|php|gradle|plist|xml)(?!\w|\.\w)/g;

/**
 * The names a Chat has already used, which the next message likely says again: file names as fileTerm names them
 * (`voice-dictation.ts`, `PromptComposer`, from a path or on their own), code names (`useDictation`, `PromptComposer`) and short acronyms in backticks. `messages` are
 * the Chat's message bodies, oldest first; the newest count first. At most `limit`.
 */
export function chatTerms(messages, limit = 40) {
  const found = [];
  const add = (term) => {
    if (term && !found.includes(term)) found.push(term);
  };
  for (const body of [...(messages ?? [])].toReversed()) {
    if (found.length >= limit) break;
    const text = String(body ?? "")
      .slice(0, 20_000)
      .replace(/https?:\/\/\S+/g, " ");
    for (const match of text.matchAll(FILE_NAME)) {
      add(fileTerm(match[0]));
    }
    for (const match of text.matchAll(/(?<![\w./-])[A-Za-z_$][\w$]{5,}(?![\w.(/-]*\.[a-z])/g)) if (CODE_NAME.test(match[0])) add(match[0]);
    for (const match of text.matchAll(/`([A-Z][A-Z0-9]{1,5})`/g)) add(match[1]);
  }
  return found.slice(0, limit);
}

/**
 * The words a dictated message about this project likely contains, most telling first: the app's names, the project, branch
 * and Chat title, the names the Chat has already used (`chat`, from chatTerms), then what the user is working on (the files
 * changed most recently, `recent`, and the names declared in them, `names`), the usual tools and services, then the rest of the project's code names (PascalCase and camelCase file
 * names, which recognizers split or swap for common words) and its folders. Unique, at most 150.
 */
export function dictationTerms({ projectName, branch, chatTitle, chat = [], files = [], recent = [], names = [] } = {}) {
  const terms = [...APP_TERMS];
  if (projectName) terms.push(projectName);
  if (branch && !/^(main|master|HEAD)$/.test(branch)) terms.push(branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " "));
  if (chatTitle) terms.push(chatTitle);
  terms.push(...chat);
  // Hidden folders hold tooling (.github, .milagre), not what the project is about.
  const visible = (file) =>
    !String(file)
      .split("/")
      .some((part) => part.startsWith("."));
  // A recently changed file and two of the names in it, by turns, so neither crowds the other out of a short prompt.
  const working = recent.filter(visible).slice(0, RECENT_FILES).map(fileTerm).filter(Boolean);
  for (let i = 0, j = 0; i < working.length || j < names.length; i++, j += 2) {
    if (i < working.length) terms.push(working[i]);
    terms.push(...names.slice(j, j + 2));
  }
  terms.push(...DEV_TERMS);
  const code = [];
  const folders = [];
  for (const file of files) {
    if (!visible(file)) continue;
    const parts = String(file).split("/");
    const name = stem(file);
    if (name && CODE_NAME.test(name)) code.push(name);
    for (const folder of parts.slice(0, -1)) if (!NOISE.has(folder.toLowerCase()) && !folder.includes(".")) folders.push(folder);
  }
  terms.push(...code, ...folders);
  const seen = new Set();
  return terms
    .map((term) => String(term).trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TERMS);
}

const keyOf = (text) =>
  String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

// Names that are no English word, so a lowercase, split or near hearing of one is always that name.
const BRANDS = new Set(
  [
    "Milagre",
    "Claude",
    "Claude Code",
    "Codex",
    "Antigravity",
    "Kiro",
    "GitHub",
    "OpenAI",
    "Gemini",
    "Anthropic",
    "TypeScript",
    "JavaScript",
    "Supabase",
    "Vercel",
    "Cloudflare",
    "TestFlight",
    "Xcode",
    "iPad",
    "iOS",
    "Android",
    "npm",
  ].map(keyOf),
);
// Words that say the next or previous words name code: "the use dictation hook", "a função insert dictation".
const CODE_CUES = new Set(
  "function functions hook hooks component components method methods class type interface module variable prop props screen helper constant struct enum endpoint command tool test file função funções componente componentes arquivo método classe tela".split(
    " ",
  ),
);
// Spoken punctuation in file names: "voice dictation dot ts", "ponto ts".
const DOT_WORDS = new Set(["dot", "ponto", "punto", "point"]);
const MAX_WINDOW = 7;
const NEAR_WINDOW = 3;

/**
 * A word's consonant skeleton, for names a recognizer heard nearly right: "Milliger" and "Milagre" are both "mlgr",
 * "codecs" and "Codex" both "kdks". Vowels, h, w and y go; letters that sound alike become one; doubles collapse.
 */
function skeleton(text) {
  return keyOf(text)
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/x/g, "ks")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/[aeiouhwy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** How a term may be heard, and whether a hearing of it can be trusted without more context. */
function termShape(term) {
  const parts = term.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const key = keyOf(term);
  return {
    term,
    key,
    brand: BRANDS.has(key),
    file: /\.[A-Za-z0-9]{1,5}$/.test(term) && !/\s/.test(term),
    // Mixed case inside the word (GitHub, iPad, useDictation), an acronym (MCP) or punctuation (whisper.rn): a lowercase
    // hearing is wrong; a plain capitalized word (Chat, Linear) can be ordinary English and is left alone.
    marked: /.[A-Z]/.test(term) || /^[A-Z0-9]{2,}$/.test(term) || /[._-]/.test(term) || BRANDS.has(key),
    parts: parts.length,
    code: CODE_NAME.test(term) && !/\s/.test(term),
  };
}

/**
 * The transcript with the project's terms spelled as the project spells them, where the recognizer heard their sounds
 * but wrote other words: "code X" > "Codex", "voice dictation dot ts" > "voice-dictation.ts", "N P M" > "npm",
 * "the use dictation hook" > "the useDictation hook", "OpenVoiceDictation.ts" > "Open voice-dictation.ts". A name that is
 * no English word is also matched by its sound ("Milliger" > "Milagre"); anything else needs its exact letters, and a
 * misheard sound is left for the AI fix-up. A two-word code name ("prompt editor") needs a word around it that says it is
 * code (hook, function, file...), because the same two words are ordinary speech.
 */
export function snapTerms(text, terms) {
  const source = String(text ?? "");
  if (!source || !terms?.length) return source;
  const shapes = new Map();
  const sounds = new Map();
  for (const term of terms) {
    const shape = termShape(String(term));
    if (shape.key.length < 2 || shapes.has(shape.key)) continue;
    shapes.set(shape.key, shape);
    const sound = skeleton(shape.term);
    if (shape.brand && sound.length >= 4 && !sounds.has(sound)) sounds.set(sound, shape);
  }
  const tokens = [...source.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}_'’-]|\.(?=[\p{L}\p{N}]))*/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Words join across spaces, hyphens and a stray period ("use. Dictation"), never across a comma.
  const joinable = (left, right) => /^[\s.-]*$/.test(source.slice(left.end, right.start));
  const cueNear = (from, to) =>
    [tokens[from - 1], tokens[from - 2], tokens[to + 1], tokens[to + 2]].some((token) => token && CODE_CUES.has(token.text.toLowerCase()));
  /** Whether `size` words heard as exactly this term's letters can be trusted to mean it. */
  const trusted = (shape, from, size) => {
    if (shape.file || shape.brand) return true;
    if (size === 1) return shape.marked;
    // Spelled out letter by letter: "N P M", "M C P".
    if (tokens.slice(from, from + size).every((token) => token.text.length === 1)) return true;
    if (shape.code) return shape.parts >= 3 || cueNear(from, from + size - 1);
    if (/\s/.test(shape.term)) return /\s[A-Z]/.test(shape.term);
    return shape.marked;
  };
  /** A term glued to the word before it, as Whisper writes it: "OpenVoiceDictation.ts", "CheckUseDictation". */
  const glued = (token) => {
    for (let at = 1; at < token.text.length - 2; at++) {
      if (!/[a-z]/.test(token.text[at - 1]) || !/[A-Z]/.test(token.text[at])) continue;
      const shape = shapes.get(keyOf(token.text.slice(at)));
      if (shape && (shape.file || (shape.code && shape.parts >= 2))) return { prefix: token.text.slice(0, at), shape };
    }
    return null;
  };
  const edits = [];
  for (let i = 0; i < tokens.length;) {
    let matched = null;
    for (let size = Math.min(MAX_WINDOW, tokens.length - i); size >= 1 && !matched; size--) {
      const window = tokens.slice(i, i + size);
      if (window.some((token, index) => index > 0 && !joinable(window[index - 1], token))) continue;
      const spokenDot = window.some((token, index) => index > 0 && index < size - 1 && DOT_WORDS.has(token.text.toLowerCase()));
      const letters = window.map((token) => token.text).join("");
      const candidates = [keyOf(letters)];
      if (spokenDot)
        candidates.push(
          keyOf(
            window
              .filter((token) => !DOT_WORDS.has(token.text.toLowerCase()))
              .map((token) => token.text)
              .join(""),
          ),
        );
      for (const [index, key] of candidates.entries()) {
        const shape = shapes.get(key);
        if (!shape || (index > 0 && !shape.file) || !trusted(shape, i, size)) continue;
        matched = { start: window[0].start, end: window.at(-1).end, term: shape.term, size };
        break;
      }
      if (matched || size > NEAR_WINDOW) continue;
      // Near hearings of a brand: same consonants, same first sound.
      const near = sounds.get(skeleton(letters));
      if (near && skeleton(near.term)[0] === skeleton(window[0].text)[0]) matched = { start: window[0].start, end: window.at(-1).end, term: near.term, size };
    }
    const joined = !matched && glued(tokens[i]);
    if (joined) matched = { start: tokens[i].start, end: tokens[i].end, term: `${joined.prefix} ${joined.shape.term}`, size: 1 };
    if (matched) {
      if (source.slice(matched.start, matched.end) !== matched.term) edits.push(matched);
      i += matched.size;
    } else i++;
  }
  let result = source;
  for (const edit of edits.toReversed()) result = result.slice(0, edit.start) + edit.term + result.slice(edit.end);
  return result;
}

/** How the dictation shortcut works: held while talking, or pressed once to start and again to stop. */
export const DICTATION_SHORTCUT_MODES = Object.freeze([
  { value: "hold", label: "Hold to talk", description: "Talk while you hold the keys. Letting go finishes the take." },
  { value: "toggle", label: "Press to start, press to stop", description: "Press once to talk, again to finish. Escape discards the take." },
]);

/** A saved shortcut mode as a known one: hold unless it says toggle. */
export function dictationShortcutMode(value) {
  return value === "toggle" ? "toggle" : "hold";
}

/**
 * The models the fix-up can run on: Automatic (the smallest model of the Chat's own agent, then the others when it
 * can't answer), or one agent's. Their names follow core's one-shot text models (git-text.cjs).
 */
export const DICTATION_FIX_MODELS = Object.freeze([
  { value: "auto", label: "Automatic", name: "", description: "The smallest model of the Chat's agent" },
  { value: "claude", label: "Claude Haiku 4.5", name: "Claude Haiku", description: "" },
  { value: "codex", label: "Codex · GPT-6 Luna", name: "GPT-6 Luna", description: "" },
  { value: "antigravity", label: "Antigravity · Gemini 3.8 Flash", name: "Gemini Flash", description: "" },
  { value: "kiro", label: "Kiro · Claude Haiku 4.5", name: "Kiro Haiku", description: "" },
]);

/** A saved fix-up model as a known one, Automatic for anything else. */
export function dictationFixModel(value) {
  return DICTATION_FIX_MODELS.some((model) => model.value === value) ? value : "auto";
}

/** The agent a take's fix-up asks first: the picked one, or for Automatic the Chat's own (Claude when it has none). */
export function fixUpProvider(model, chatProvider) {
  const picked = dictationFixModel(model);
  if (picked !== "auto") return picked;
  return DICTATION_FIX_MODELS.some((item) => item.value === chatProvider && item.value !== "auto") ? chatProvider : "claude";
}

/** The fix-up model's short name, for the composer's status while it works: "Claude Haiku". */
export function fixUpModelName(model, chatProvider) {
  const provider = fixUpProvider(model, chatProvider);
  return DICTATION_FIX_MODELS.find((item) => item.value === provider)?.name ?? "";
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

/**
 * The language Whisper is told to listen for: the saved preference, or English for a model that only knows English
 * (which never detects or transcribes anything else).
 */
export function whisperLanguage(language, model) {
  return model?.english ? "en" : dictationLanguage(language);
}

// whisper.cpp's models, pinned to one revision and checked by hash. Each platform offers four, named for what they are
// good at: the most accurate one that still transcribes in seconds on that hardware, its English-only counterpart, and
// two quicker ones. A phone's CPU tops out at small.
const WHISPER_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const whisperModel = (id, purpose, name, file, size, sha256, { english = false, accuracy, speed }) => ({
  id,
  purpose,
  name,
  english,
  accuracy,
  speed,
  file,
  size,
  sha256,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}/${file}`,
});
const TURBO = ["ggml-large-v3-turbo-q5_0.bin", 574041195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"];
const MEDIUM_EN = ["ggml-medium.en-q5_0.bin", 539225533, "76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0"];
const SMALL = ["ggml-small-q5_1.bin", 190085487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"];
const SMALL_EN = ["ggml-small.en-q5_1.bin", 190098681, "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30"];
const BASE = ["ggml-base-q5_1.bin", 59707625, "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"];
const TINY = ["ggml-tiny-q5_1.bin", 32152673, "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"];

/** Each platform's models, best first; the first is the default. `accuracy` and `speed` are 1..3, relative on that platform. */
export const WHISPER_MODELS = {
  desktop: [
    whisperModel("large-v3-turbo", "Best, any language", "Large v3 Turbo", ...TURBO, { accuracy: 3, speed: 2 }),
    whisperModel("medium-en", "Best for English", "Medium English", ...MEDIUM_EN, { english: true, accuracy: 3, speed: 2 }),
    whisperModel("small", "Balanced, any language", "Small", ...SMALL, { accuracy: 2, speed: 3 }),
    whisperModel("base", "Fastest, any language", "Base", ...BASE, { accuracy: 1, speed: 3 }),
  ],
  phone: [
    whisperModel("small", "Best, any language", "Small", ...SMALL, { accuracy: 3, speed: 1 }),
    whisperModel("small-en", "Best for English", "Small English", ...SMALL_EN, { english: true, accuracy: 3, speed: 1 }),
    whisperModel("base", "Fast, any language", "Base", ...BASE, { accuracy: 2, speed: 2 }),
    whisperModel("tiny", "Fastest, any language", "Tiny", ...TINY, { accuracy: 1, speed: 3 }),
  ],
};

/** A saved model id as one of the platform's models: the default for anything unknown. */
export function whisperModelFor(platform, id) {
  const models = WHISPER_MODELS[platform];
  return models.find((model) => model.id === id) ?? models[0];
}

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
