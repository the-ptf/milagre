import { createCssVariablesTheme, type HighlighterCore, type LanguageRegistration, type RegexEngine, type ThemedToken } from "shiki/core";
import type { CodeLanguage } from "../../lib/code-languages";

const LOADERS: Record<CodeLanguage, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  shellsession: () => import("shiki/langs/shellsession.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
};

// One theme for both schemes: token colors are CSS variables the theme stylesheet sets, so a theme change repaints without re-highlighting.
const milagreTheme = createCssVariablesTheme({ name: "milagre", variablePrefix: "--shiki-", fontStyle: true });

const MAX_HIGHLIGHT_CHARS = 40_000;

const WARM_SLICE_MS = 8;

let highlighter: Promise<{ core: HighlighterCore; engine: RegexEngine }> | undefined;
let ready: HighlighterCore | undefined;
const loaded = new Set<CodeLanguage>();
const loading = new Map<CodeLanguage, Promise<void>>();

function loadHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) => {
      const engine = createJavaScriptRegexEngine();
      return { core: await createHighlighterCore({ engine, themes: [milagreTheme], langs: [] }), engine };
    },
  );
  return highlighter;
}

function grammarPatterns(grammar: unknown, found = new Set<string>(), seen = new Set<object>()) {
  if (!grammar || typeof grammar !== "object" || seen.has(grammar)) return found;
  seen.add(grammar);
  const rule = grammar as Record<string, unknown>;
  for (const key of ["match", "begin", "end", "while"]) if (typeof rule[key] === "string") found.add(rule[key]);
  for (const value of Object.values(rule)) grammarPatterns(value, found, seen);
  return found;
}

function warmPatterns(engine: RegexEngine, grammar: LanguageRegistration | undefined) {
  const patterns = [...grammarPatterns(grammar)];
  return new Promise<void>((resolve) => {
    const slice = () => {
      const until = performance.now() + WARM_SLICE_MS;
      do {
        const pattern = patterns.pop();
        if (pattern === undefined) return resolve();
        try {
          engine.createScanner([pattern]).findNextMatchSync("a", 0, 0);
        } catch {}
      } while (performance.now() < until);
      setTimeout(slice, 0);
    };
    setTimeout(slice, 0);
  });
}

export function isLanguageReady(language: CodeLanguage) {
  return ready !== undefined && loaded.has(language);
}

export function loadLanguage(language: CodeLanguage): Promise<void> {
  if (isLanguageReady(language)) return Promise.resolve();
  let pending = loading.get(language);
  if (!pending) {
    pending = loadHighlighter()
      .then(async ({ core, engine }) => {
        const grammars = ((await LOADERS[language]()) as { default: LanguageRegistration[] }).default;
        await core.loadLanguage(grammars);
        await warmPatterns(engine, grammars.at(-1));
        ready = core;
        loaded.add(language);
      })
      .finally(() => loading.delete(language));
    loading.set(language, pending);
  }
  return pending;
}

/** A highlighted run of code; `className` names a shared rule with its colors. */
export type CodeToken = { content: string; className: string };

const tokenClasses = new Map<string, string>();
let tokenSheet: CSSStyleSheet | null | undefined;

function tokenClass(style: ThemedToken["htmlStyle"]) {
  if (!style) return "code-token";
  let declarations = "";
  for (const property in style) declarations += `${property}:${style[property]};`;
  let name = tokenClasses.get(declarations);
  if (name) return name;
  tokenSheet ??= typeof document === "undefined" ? null : document.head.appendChild(document.createElement("style")).sheet;
  if (!tokenSheet) return "code-token";
  const rule = `code-token-${tokenClasses.size}`;
  tokenSheet.insertRule(`.${rule} { ${declarations} }`, tokenSheet.cssRules.length);
  name = `code-token ${rule}`;
  tokenClasses.set(declarations, name);
  return name;
}

const HIGHLIGHT_CACHE_ENTRIES = 64;
const HIGHLIGHT_CACHE_CHARS = 200_000;
const highlighted = new Map<string, CodeToken[][]>();
let highlightedChars = 0;

function tokenize(code: string, language: CodeLanguage, core: HighlighterCore): CodeToken[][] | undefined {
  try {
    const { tokens } = core.codeToTokens(code, { lang: language, themes: { light: "milagre", dark: "milagre" }, defaultColor: false });
    return tokens.map((line) => line.map((token) => ({ content: token.content, className: tokenClass(token.htmlStyle) })));
  } catch {
    return undefined;
  }
}

export function highlight(code: string, language: CodeLanguage): CodeToken[][] | undefined {
  if (!ready || !loaded.has(language) || code.length > MAX_HIGHLIGHT_CHARS) return undefined;
  const key = `${language}\0${code}`;
  const hit = highlighted.get(key);
  if (hit) {
    highlighted.delete(key);
    highlighted.set(key, hit);
    return hit;
  }
  const lines = tokenize(code, language, ready);
  if (!lines) return undefined;
  highlighted.set(key, lines);
  highlightedChars += key.length;
  for (const oldest of highlighted.keys()) {
    if (highlighted.size <= HIGHLIGHT_CACHE_ENTRIES && highlightedChars <= HIGHLIGHT_CACHE_CHARS) break;
    highlighted.delete(oldest);
    highlightedChars -= oldest.length;
  }
  return lines;
}
