import { createCssVariablesTheme, type HighlighterCore, type ThemedToken } from "shiki/core";
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

let highlighter: Promise<HighlighterCore> | undefined;
let ready: HighlighterCore | undefined;
const loaded = new Set<CodeLanguage>();
const loading = new Map<CodeLanguage, Promise<void>>();

function loadHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [milagreTheme],
      langs: [],
    }),
  );
  return highlighter;
}

export function isLanguageReady(language: CodeLanguage) {
  return ready !== undefined && loaded.has(language);
}

export function loadLanguage(language: CodeLanguage): Promise<void> {
  if (isLanguageReady(language)) return Promise.resolve();
  let pending = loading.get(language);
  if (!pending) {
    pending = loadHighlighter()
      .then(async (core) => {
        await core.loadLanguage(LOADERS[language]() as Parameters<HighlighterCore["loadLanguage"]>[0]);
        ready = core;
        loaded.add(language);
      })
      .finally(() => loading.delete(language));
    loading.set(language, pending);
  }
  return pending;
}

export function highlight(code: string, language: CodeLanguage): ThemedToken[][] | undefined {
  if (!ready || !loaded.has(language) || code.length > MAX_HIGHLIGHT_CHARS) return undefined;
  try {
    return ready.codeToTokens(code, { lang: language, themes: { light: "milagre", dark: "milagre" }, defaultColor: false }).tokens;
  } catch {
    return undefined;
  }
}
