import { refractor } from "refractor";
import tsx from "refractor/tsx";
import docker from "refractor/docker";

refractor.register(tsx);
refractor.register(docker);

const KINDS = {
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  keyword: "keyword",
  important: "keyword",
  atrule: "keyword",
  string: "string",
  char: "string",
  "attr-value": "string",
  regex: "string",
  url: "string",
  number: "number",
  boolean: "number",
  constant: "number",
  function: "function",
  "function-variable": "function",
  "class-name": "type",
  builtin: "type",
  tag: "tag",
  selector: "tag",
  property: "property",
  "attr-name": "property",
  symbol: "property",
  operator: "operator",
  punctuation: "punctuation",
};
const ALIASES = {
  ts: "typescript",
  js: "javascript",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  zsh: "bash",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  rb: "ruby",
  py: "python",
  yml: "yaml",
  md: "markdown",
  svg: "markup",
  html: "markup",
  htm: "markup",
  xml: "markup",
};

export function fileLanguage(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() : name;
  const language = /^dockerfile(?:\.|$)/.test(name)
    ? "docker"
    : name === "makefile"
      ? "makefile"
      : Object.hasOwn(ALIASES, extension)
        ? ALIASES[extension]
        : extension;
  if (["txt", "text", "plain", "plaintext"].includes(language)) return undefined;
  return refractor.registered(language) ? language : undefined;
}

export const MAX_SYNTAX_CHARACTERS = 40_000;
export function highlightFile(text, name) {
  const language = fileLanguage(name);
  if (!language || text.length > MAX_SYNTAX_CHARACTERS) return [{ text, kind: "plain" }];
  try {
    const tokens = [];
    const visit = (node, inherited = "plain") => {
      if (node.type === "text") {
        const previous = tokens.at(-1);
        if (previous?.kind === inherited) previous.text += node.value;
        else tokens.push({ text: node.value, kind: inherited });
        return;
      }
      const classes = node.properties?.className || [];
      const kind = classes.map((value) => KINDS[value]).find(Boolean) || inherited;
      for (const child of node.children || []) visit(child, kind);
    };
    visit(refractor.highlight(text, language));
    return tokens;
  } catch {
    return [{ text, kind: "plain" }];
  }
}
