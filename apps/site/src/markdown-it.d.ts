// The part of markdown-it's API the site uses (markdown-it ships no types of its own).
declare module "markdown-it" {
  interface Token {
    tag: string;
    content: string;
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
  }
  interface Renderer {
    rules: Record<string, ((tokens: Token[], index: number, options: object, env: object, self: Renderer) => string) | undefined>;
    renderToken(tokens: Token[], index: number, options: object): string;
  }
  export default class MarkdownIt {
    constructor(options?: { html?: boolean; linkify?: boolean; typographer?: boolean });
    renderer: Renderer;
    render(markdown: string): string;
  }
}
