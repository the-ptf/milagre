const CODE_LANGUAGES = {
  typescript: ["ts", "mts", "cts"],
  tsx: [],
  javascript: ["js", "mjs", "cjs", "node"],
  jsx: [],
  json: ["json5"],
  jsonc: [],
  shellscript: ["bash", "sh", "shell", "zsh"],
  shellsession: ["console", "terminal"],
  python: ["py"],
  go: ["golang"],
  rust: ["rs"],
  swift: [],
  kotlin: ["kt", "kts"],
  java: [],
  c: ["h"],
  cpp: ["c++", "cc", "cxx", "hpp"],
  csharp: ["cs", "c#"],
  "objective-c": ["objc"],
  ruby: ["rb"],
  php: [],
  css: [],
  scss: [],
  html: ["htm"],
  xml: ["svg", "plist"],
  yaml: ["yml"],
  toml: [],
  ini: ["conf", "properties"],
  sql: [],
  diff: ["patch"],
  markdown: ["md"],
  docker: ["dockerfile"],
  make: ["makefile"],
  graphql: ["gql"],
  lua: [],
  dart: [],
  elixir: ["ex", "exs"],
  zig: [],
  prisma: [],
  powershell: ["ps1", "pwsh"],
  vue: [],
  svelte: [],
} satisfies Record<string, string[]>;

export type CodeLanguage = keyof typeof CODE_LANGUAGES;

const BY_NAME = new Map<string, CodeLanguage>(
  (Object.entries(CODE_LANGUAGES) as [CodeLanguage, string[]][]).flatMap(([id, aliases]) => [id, ...aliases].map((name) => [name, id] as const)),
);

export function resolveCodeLanguage(name: string | undefined): CodeLanguage | undefined {
  return name ? BY_NAME.get(name.toLowerCase()) : undefined;
}

export function codeLanguageFromClassName(className: string | undefined): string | undefined {
  return className?.match(/(?:^|\s)language-(\S+)/)?.[1];
}
